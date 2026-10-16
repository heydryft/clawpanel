"""固定版本 Windows 全表读取：保留 WMIC 优先，以隔离 COM 替代 PowerShell；不改 scanner/身份。"""
HERMES_WINDOWS_WMI_WORKER = r'''
"""只读本地 WMI COM worker；外层原自有 Job 严守 15 秒，全表 EOF 前不输出。"""
import contextlib
import ctypes
import math
import os
import sys
import time
import uuid

WMI_QUERY = 'SELECT ProcessId,CommandLine FROM Win32_Process'
BACKEND = 'wmi-com'
_MAX_OUTPUT = 1048576
_BATCH = 32


class InventoryError(RuntimeError):
    pass


def _require(ok, reason):
    if not ok:
        raise InventoryError(reason)


def _budget(timeout):
    _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 15,
             'inventory deadline contract mismatch')


def _format_inventory(rows):
    """仅原 CIM 的两次换行替换；不解析、重拼 argv，不丢弃任何 provider 返回行。"""
    seen, parts, size = set(), [], 0
    for pid, command in rows:
        _require(type(pid) is int and 0 <= pid <= 0xffffffff and pid not in seen, 'invalid/duplicate process ID')
        _require(command is None or type(command) is str, 'unknown commandline value')
        command = '' if command is None else command
        _require('\0' not in command, 'commandline contains embedded NUL')
        command = command.replace('\r\n', ' ').replace('\n', ' ')
        part = 'CommandLine=' + command + '\nProcessId=' + str(pid) + '\n\n'
        # 与既有 bounded_probe_run 的 len(stdout) 同一文本字符预算，不另缩成 UTF8 字节预算。
        size += len(part)
        _require(size <= _MAX_OUTPUT, 'inventory output budget exceeded')
        seen.add(pid)
        parts.append(part)
    _require(parts, 'empty process inventory')
    return ''.join(parts)


def _collect_inventory(next_batch, timeout, *, now=time.monotonic):
    """内部隔离测试缝；只有明确 EOF 才提交完整清单，timeout/错误不返回部分结果。"""
    _budget(timeout)
    end, rows, size = now() + timeout, [], 0
    while True:
        remaining = end - now()
        _require(remaining > 0, 'inventory deadline exceeded')
        try:
            status, batch = next_batch(max(1, int(remaining * 1000)))
        except Exception as error:
            raise InventoryError('inventory provider failed (' + type(error).__name__ + ')') from None
        _require(type(status) is int and status in (0, 1, 0x40004) and type(batch) is list,
                 'inventory enumeration failed')
        _require(now() <= end, 'inventory deadline exceeded')
        # S_FALSE 可带末批对象；S_TIMEDOUT 不是 EOF。S_OK 必须有请求的对象。
        _require(status != 0 or batch, 'invalid empty nonterminal batch')
        rows.extend(batch)
        _require(len(rows) <= 65536, 'inventory row budget exceeded')
        # 及时限制 provider 产物；任何中途错误都不写 stdout。
        if batch:
            size += len(_format_inventory(batch))
        _require(size <= _MAX_OUTPUT, 'inventory output budget exceeded')
        if status == 1:
            return _format_inventory(rows)


class _Guid(ctypes.Structure):
    _fields_ = [('data1', ctypes.c_uint32), ('data2', ctypes.c_uint16), ('data3', ctypes.c_uint16),
                ('data4', ctypes.c_ubyte * 8)]


class _VariantData(ctypes.Union):
    _fields_ = [('signed', ctypes.c_int32), ('unsigned', ctypes.c_uint32), ('pointer', ctypes.c_void_p),
                ('longlong', ctypes.c_int64), ('record', ctypes.c_void_p * 2)]


class _Variant(ctypes.Structure):
    _anonymous_ = ('data',)
    _fields_ = [('vt', ctypes.c_uint16), ('reserved1', ctypes.c_uint16), ('reserved2', ctypes.c_uint16),
                ('reserved3', ctypes.c_uint16), ('data', _VariantData)]


def _hr(value, operation):
    _require(not int(value) & 0x80000000, operation + ' HRESULT=' + hex(int(value) & 0xffffffff))


def _method(pointer, index, result_type, *argtypes):
    _require(bool(pointer), 'COM interface unavailable')
    table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(result_type, ctypes.c_void_p, *argtypes)(table[index])


def _release(pointer):
    if pointer:
        _method(pointer, 2, ctypes.c_uint32)(pointer)
        pointer.value = None


class _WmiSession:
    def __init__(self):
        _require(os.name == 'nt' and ctypes.sizeof(ctypes.c_void_p) == 8, 'Windows 64-bit worker required')
        _require(sys.flags.isolated and sys.dont_write_bytecode, 'isolated -I -B worker required')
        self.locator, self.service, self.enumerator = (ctypes.c_void_p() for _ in range(3))
        self.initialized = False
        self.ole = ctypes.WinDLL('ole32', winmode=0x800)
        self.auto = ctypes.WinDLL('oleaut32', winmode=0x800)
        ptr, long, ulong, hr = ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.c_int32
        self.ole.CoInitializeEx.argtypes, self.ole.CoInitializeEx.restype = (ptr, ulong), hr
        self.ole.CoInitializeSecurity.argtypes = (ptr, long, ptr, ptr, ulong, ulong, ptr, ulong, ptr)
        self.ole.CoInitializeSecurity.restype = hr
        self.ole.CoCreateInstance.argtypes = (ctypes.POINTER(_Guid), ptr, ulong, ctypes.POINTER(_Guid), ctypes.POINTER(ptr))
        self.ole.CoCreateInstance.restype = hr
        self.ole.CoSetProxyBlanket.argtypes = (ptr, ulong, ulong, ptr, ulong, ulong, ptr, ulong)
        self.ole.CoSetProxyBlanket.restype = hr
        self.ole.CoUninitialize.argtypes, self.ole.CoUninitialize.restype = (), None
        self.auto.SysAllocString.argtypes, self.auto.SysAllocString.restype = (ctypes.c_wchar_p,), ptr
        self.auto.SysStringLen.argtypes, self.auto.SysStringLen.restype = (ptr,), ulong
        self.auto.SysFreeString.argtypes, self.auto.SysFreeString.restype = (ptr,), None
        self.auto.VariantClear.argtypes, self.auto.VariantClear.restype = (ctypes.POINTER(_Variant),), hr

    @contextlib.contextmanager
    def bstr(self, value):
        p = self.auto.SysAllocString(value)
        _require(p, 'BSTR allocation failed')
        try:
            yield p
        finally:
            self.auto.SysFreeString(p)

    def __enter__(self):
        ptr, long, ulong, hr = ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32, ctypes.c_int32
        try:
            _hr(self.ole.CoInitializeEx(None, 0), 'CoInitializeEx')
            self.initialized = True
            # 仅独立 worker 的 COM 进程安全；不更改宿主 COM、注册表、权限或系统服务设置。
            _hr(self.ole.CoInitializeSecurity(None, -1, None, None, 0, 3, None, 0, None), 'CoInitializeSecurity')
            cls = _Guid.from_buffer_copy(uuid.UUID('4590f811-1d3a-11d0-891f-00aa004b2e24').bytes_le)
            iid = _Guid.from_buffer_copy(uuid.UUID('dc12a687-737f-11cf-884d-00aa004b2e24').bytes_le)
            _hr(self.ole.CoCreateInstance(ctypes.byref(cls), None, 1, ctypes.byref(iid), ctypes.byref(self.locator)), 'CoCreateInstance')
            with self.bstr('ROOT\\CIMV2') as namespace:
                connect = _method(self.locator, 3, hr, ptr, ptr, ptr, ptr, long, ptr, ptr, ctypes.POINTER(ptr))
                _hr(connect(self.locator, namespace, None, None, None, 0, None, None, ctypes.byref(self.service)), 'ConnectServer')
            _hr(self.ole.CoSetProxyBlanket(self.service, 10, 0, None, 3, 3, None, 0), 'CoSetProxyBlanket')
            with self.bstr('WQL') as language, self.bstr(WMI_QUERY) as query:
                execute = _method(self.service, 20, hr, ptr, ptr, long, ptr, ctypes.POINTER(ptr))
                _hr(execute(self.service, language, query, 0x10 | 0x20, None, ctypes.byref(self.enumerator)), 'ExecQuery')
            _require(self.enumerator, 'missing WMI enumerator')
            return self
        except BaseException:
            self.close()
            raise

    def _property(self, obj, name):
        value, cimtype = _Variant(), ctypes.c_int32()
        get = _method(obj, 4, ctypes.c_int32, ctypes.c_wchar_p, ctypes.c_int32,
                      ctypes.POINTER(_Variant), ctypes.POINTER(ctypes.c_int32), ctypes.c_void_p)
        _hr(get(obj, name, 0, ctypes.byref(value), ctypes.byref(cimtype), None), 'Get ' + name)
        try:
            if name == 'ProcessId':
                _require(cimtype.value == 19 and value.vt in (3, 19), 'unexpected PID CIM/VARIANT type')
                return int(value.unsigned)
            _require(cimtype.value == 8 and value.vt in (0, 1, 8), 'unexpected CommandLine CIM/VARIANT type')
            if value.vt in (0, 1):
                # 只有 provider 明确返回 NULL/EMPTY 才为空；HRESULT 失败绝不混成空字符串。
                return None
            count = self.auto.SysStringLen(value.pointer)
            _require(count <= 32767, 'CommandLine exceeds Windows UTF16 limit')
            return ctypes.wstring_at(value.pointer, count) if count else ''
        finally:
            _hr(self.auto.VariantClear(ctypes.byref(value)), 'VariantClear')

    def next_batch(self, timeout_ms):
        objects, count = (ctypes.c_void_p * _BATCH)(), ctypes.c_uint32()
        next_fn = _method(self.enumerator, 4, ctypes.c_int32, ctypes.c_int32, ctypes.c_uint32,
                          ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32))
        rows = []
        try:
            status = next_fn(self.enumerator, timeout_ms, _BATCH, objects, ctypes.byref(count))
            _hr(status, 'Next')
            _require(count.value <= _BATCH, 'invalid WMI batch count')
            for index in range(count.value):
                _require(objects[index], 'missing WMI row')
                rows.append((self._property(objects[index], 'ProcessId'), self._property(objects[index], 'CommandLine')))
            return status, rows
        finally:
            for item in objects:
                if item:
                    _release(ctypes.c_void_p(item))

    def close(self):
        for pointer in (self.enumerator, self.service, self.locator):
            _release(pointer)
        if self.initialized:
            self.ole.CoUninitialize()
            self.initialized = False

    def __exit__(self, *exc):
        self.close()


def read_windows_process_listing(timeout=15):
    """必须在可回收的独立 worker 调用；ConnectServer/ExecQuery 本身没有 15s 硬取消保证。"""
    _budget(timeout)
    end = time.monotonic() + timeout
    with _WmiSession() as session:
        return _collect_inventory(session.next_batch, end - time.monotonic())


def _windows_inventory_main():
    try:
        _require(len(sys.argv) == 1, 'worker does not accept target/query/credentials arguments')
        result = read_windows_process_listing()
        sys.stdout.buffer.write(result.encode('utf-8'))
        sys.stdout.buffer.flush()
        return 0
    except Exception as error:
        # 不输出进程命令行、凭据或部分结果；父级原未知状态门禁继续 failclosed。
        print('Windows process inventory unavailable (' + type(error).__name__ + ')', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(_windows_inventory_main())
'''

def install_windows_cim_probe(gateway, compat, spawn_server, platform=None):
    import json, math, os, shutil, subprocess, sys, time
    if (platform or os.name) != 'nt':
        return lambda: None
    original = compat.bounded_probe_run
    original_listing = gateway._windows_process_listing
    query = """Get-CimInstance Win32_Process | ForEach-Object {   'CommandLine=' + ($_.CommandLine -replace "`r`n",' ' -replace "`n",' ');   'ProcessId=' + $_.ProcessId;   '' }"""

    def complete_inventory(value):
        # 仅验完整原 LIST 协议，不改变 scanner 输入、raw CommandLine 或 PID 身份判定。
        if not isinstance(value, str) or not value.strip() or '\0' in value or len(value) > 1048576:
            return False
        pending, seen = False, set()
        for raw in value.split('\n'):
            line = raw.strip()
            if not line:
                continue
            if line.startswith('CommandLine=') and not pending:
                pending = True
            elif line.startswith('ProcessId=') and pending:
                number = line[len('ProcessId='):]
                if not number.isascii() or not number.isdecimal():
                    return False
                pid = int(number)
                if not 0 <= pid <= 0xffffffff or pid in seen:
                    return False
                seen.add(pid)
                pending = False
            else:
                return False
        return bool(seen) and not pending

    def com_probe(argv, *, timeout, errors):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= 15:
            raise SystemExit('Hermes CIM probe deadline contract changed')
        proc = job = None
        start = time.monotonic()
        end = start + timeout
        def observe(event, **fields):
            if os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING') != '1':
                return
            try:
                print('CLAWPANEL_HERMES_CIM_PROBE ' + json.dumps(dict(event=event, pid=getattr(proc,'pid',None),
                    elapsedMs=round((time.monotonic()-start)*1000,3), **fields)), file=sys.stderr, flush=True)
            except Exception:
                pass
        try:
            # 已准入私有解释器，-I/-B 保持隔离；worker 仅查询本地完整 Win32_Process。
            projected = [sys.executable, '-I', '-B', '-c', HERMES_WINDOWS_WMI_WORKER]
            # 与既有安装器/task presence一致：独立 worker 不携带异版 PS 模块路径。
            child_env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
            proc, job = spawn_server(projected, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL, text=True, encoding='utf-8', errors=errors,
                env=child_env, cwd=None, creationflags=compat.windows_hide_flags())
            observe('start', deadlineMs=timeout*1000)
            if job is None:
                raise RuntimeError('owned probe Job missing')
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    out, err = proc.communicate(timeout=min(.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    # 仅在真正的 worker 已退出后关自有 Job，回收仍持管道的自有后代。
                    # 不用于 MSYS 父 stub 先退出的普通命令，不杀其他 HOME 或任务。
                    if job is not None and proc.poll() is not None:
                        observe('direct-exit-before-pipe-eof', directExitCode=proc.returncode)
                        job.close()
                        job = None
            if not isinstance(out, str) or not isinstance(err, str) or len(out) + len(err) > 1048576:
                raise RuntimeError('CIM output budget exceeded')
            if proc.returncode == 0 and not complete_inventory(out):
                raise RuntimeError('COM process inventory incomplete')
            observe('finish', directExitCode=proc.returncode)
            return subprocess.CompletedProcess(list(argv) if argv is not None else projected, proc.returncode, out, err)
        except Exception as error:
            observe('failure', exceptionType=type(error).__name__, directExitCode=proc.poll() if proc else None)
            if proc is not None and os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING') == '1':
                try:
                    import psutil
                    child = psutil.Process(proc.pid)
                    status = child.status()
                    cpu = child.cpu_times()
                    observe('child-state', status=status if status in ('running','suspended','stopped') else 'unknown',
                        threads=len(child.threads()), cpuUserMs=round(cpu.user*1000,3), cpuSystemMs=round(cpu.system*1000,3))
                except Exception as state_error:
                    observe('child-state-unavailable', exceptionType=type(state_error).__name__)
            compat._close_job(job)
            job = None
            if proc is not None:
                drain = getattr(compat, 'kill_and_drain', None)
                if callable(drain):
                    drain(proc, 1)
                else:
                    compat.kill_process_tree(proc)
                    try:
                        proc.communicate(timeout=1)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        # 同原旧版收尾：不在 reader 线程持有时主动 close pipe 导致无界等待。
                        proc.stdin = proc.stdout = proc.stderr = None
            return None
        finally:
            compat._close_job(job)

    def bounded(argv, *, timeout, errors='replace', **kwargs):
        # 不接管 git/MSYS exec、其他 PowerShell、带输入/环境覆盖或未知接口。
        if (not isinstance(argv, (list, tuple)) or len(argv) != 4 or
                os.path.basename(str(argv[0]).replace('\\', '/')).lower() not in ('powershell', 'powershell.exe', 'pwsh', 'pwsh.exe') or
                list(argv[1:]) != ['-NoProfile', '-Command', query] or kwargs):
            return original(argv, timeout=timeout, errors=errors, **kwargs)
        return com_probe(argv, timeout=timeout, errors=errors)

    def listing():
        try:
            # 保留固定源原 WMIC 优先、10s 和 errors=ignore；不存在或原失败条件才转 COM15s。
            # 顺序最坏 25s，可能撞上上层20s；不擅自增加、缩短或共享原预算。
            wmic = shutil.which('wmic')
            result = original([wmic, 'process', 'get', 'ProcessId,CommandLine', '/FORMAT:LIST'],
                timeout=10, errors='ignore') if wmic else None
            if result is None or result.returncode != 0 or not result.stdout:
                result = com_probe(None, timeout=15, errors='ignore')
            value = result.stdout if result is not None and result.returncode == 0 else None
        except Exception:
            raise SystemExit('Hermes Windows process inventory failed; operation not accepted') from None
        if not complete_inventory(value):
            # 原调用者会吞 Exception；未知/部分库存必须停止，不变成“无冲突”。
            raise SystemExit('Hermes Windows process inventory unavailable; startup/stop not accepted')
        return value

    compat.bounded_probe_run = bounded
    gateway._windows_process_listing = listing
    def restore():
        if compat.bounded_probe_run is bounded:
            compat.bounded_probe_run = original
        if gateway._windows_process_listing is listing:
            gateway._windows_process_listing = original_listing
    return restore
