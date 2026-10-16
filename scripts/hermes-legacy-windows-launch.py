"""固定旧版 Windows 入口；原模块加载后接入外层身份及 CIM 适配，不伪装原生 argv。"""

import hashlib
import importlib
import importlib.machinery
import importlib.util
import inspect
import os
from pathlib import Path
import re
import stat
import struct
import sys
import types


LEGACY_PIN = 'f97608f178d1ffeca59860195ab7da295f7c8e5f'
# 固定官方 commit 的 LF 内容；只容许 Git 的 CRLF 换行差异，不回写原文件。
SOURCE_HASHES = {
    'hermes_cli/__init__.py': 'd05c98cd44e22781497a20cd968af0d9b8962406b909f1889168c624545b229e',
    'hermes_cli/main.py': '3b89b46e67f35398ba0af6b3441172490469702cd0e4e0381ff7e45ea78b2eef',
    'hermes_cli/gateway.py': 'd8cdbd900dbebcbaffc0406442711bbd592f292614e1d59578f9b4c163c379f3',
    'hermes_cli/_subprocess_compat.py': 'f7b8523add2524094ab0b0ea781c718c8cbcb43a49746dfc8c09c20050974825',
    'hermes_cli/local_runtime/__init__.py': 'bf9ecb796553a40a231163520caaeeb3d3eb5486ea13ea1745b3717c19fa1de8',
    'hermes_cli/local_runtime/processes.py': '763c450a9fe8b7eea5684576564b1fe8ffd58d6c16fc444dfd5e3b14986efb2b',
    'hermes_cli/gateway_windows.py': 'b7fc0d1549baf46f55931fdb28eed47984869ea4efa4d910ff5e701a05795e1c',
    'hermes_cli/service_manager.py': '9f1e567f9c77f4bd697844feac59e57736df84ed96f9e99723372f5590bf604c',
    'hermes_cli/_startup_fast.py': '694995a782f451a887c139895e8ac29b3d0f20e86f1f0368cbd19b9e6990ef58',
    'hermes_cli/_early_recovery.py': 'f1e62e68dde843d0575fcca24c9c3782f36f492a366d8edd480bc8f09c7f9c14',
    'hermes_bootstrap.py': '7e46edcde82897d5dbd95e7ae8a601b9b1f13009f98d8a07d19116c85d7f4d2a',
    'gateway/__init__.py': '8920ead12b3b78cc727b2c6257192e954bc790717676484ad66b3238e511b95e',
    'gateway/status.py': 'b7923018b5285d042313cf41421c3aec3260e560c4b5a326544b64f000ca424c',
}

_STATUS_IDENTITY_SLOTS = ('_build_pid_record', '_record_matches_live_gateway_pid', '_looks_like_gateway_process')
_GATEWAY_IDENTITY_SLOTS = ('_scan_gateway_pids', '_capture_gateway_argv')


def _require(ok, message):
    if not ok:
        # SystemExit 穿过上游会吞普通 Exception 的探针边界，未知不当作无冲突。
        raise SystemExit('ClawPanel legacy Windows: ' + message)


_PHYSICAL_DIAGNOSTIC_SLOTS = frozenset((
    'layout.root', 'layout.home', 'layout.venv', 'facts.prefix', 'facts.executable',
    'layout.venv-executable', 'facts.base-executable', 'layout.python-store', 'facts.base-prefix',
    'facts.process-executable', 'layout.venv-config', 'venv-config.home', 'layout.git', 'layout.git-head',
    'effective.home', 'contract.root', 'contract.source', 'contract.spec-origin',
    'contract.loader-filename', 'contract.loaded-module', 'interface.code-file', 'interface.module-file',
    'identity.effective-home',
))


def _physical_diagnostic(slot, value, raw, component, info=None, error=None):
    """仅失败且显式开启时观察元数据；不解析/放行目标，不改变准入结果。"""
    if os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING') != '1':
        return
    try:
        import json
        home = os.environ.get('HERMES_HOME', '')
        known = {'.', 'hermes-agent', 'hermes-agent/venv', 'hermes-agent/venv/Scripts',
            'hermes-agent/venv/Scripts/python.exe', 'hermes-agent/venv/pyvenv.cfg',
            'hermes-agent/.git', 'hermes-agent/.git/HEAD', 'hermes-agent/.hermes-runtime',
            'hermes-agent/.hermes-runtime/python'}
        for file in SOURCE_HASHES:
            path = Path('hermes-agent') / file
            known.add(path.as_posix())
            known.update(part.as_posix() for part in path.parents)

        def describe(path):
            text = os.fspath(path)
            # 只为日志识别本地 extended path；绝不用于原 _physical 的准入/resolve。
            lexical = text[4:] if text.startswith('\\\\?\\') and re.match(r'[a-zA-Z]:[\\/]', text[4:]) else text
            relative, scope = None, 'outside'
            try:
                if not home or not Path(home).is_absolute():
                    scope = 'unknown'
                else:
                    rel = Path(lexical).relative_to(Path(home)).as_posix()
                    scope = 'managed-redacted'
                    if rel in known or re.fullmatch(r'hermes-agent/\.hermes-runtime/python/cpython-3\.11(?:\.\d+)?-windows-x86_64-none(?:/python\.exe)?', rel):
                        relative, scope = rel, 'managed'
            except ValueError:
                pass
            return dict(sha256=hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest(),
                        relative=relative, scope=scope)

        def failure(exc):
            return dict(type='OSError' if isinstance(exc, OSError) else 'other',
                errno=getattr(exc, 'errno', None) if isinstance(getattr(exc, 'errno', None), int) else None,
                winerror=getattr(exc, 'winerror', None) if isinstance(getattr(exc, 'winerror', None), int) else None)

        row = dict(schemaVersion=1, pid=os.getpid(), pathHashKind='path-text-utf8-surrogatepass',
            pathScope='lexical-only-not-admission', slot=slot if slot in _PHYSICAL_DIAGNOSTIC_SLOTS else 'unknown',
            reason='path-unavailable' if error is not None else 'link-reparse',
            valueType='path' if isinstance(value, Path) else 'str' if isinstance(value, str) else 'other',
            requested=describe(raw), component=describe(component))
        if error is not None:
            row['error'] = failure(error)
        if info is not None:
            for field, attribute in [('fileAttributes', 'st_file_attributes'), ('reparseTag', 'st_reparse_tag')]:
                number = getattr(info, attribute, None)
                row[field] = number if type(number) is int and 0 <= number <= 0xffffffff else None
            row['componentType'] = 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'other'
            try:
                target = os.readlink(component)
                target_path = Path(target) if Path(target).is_absolute() else component.parent / target
                row['target'] = describe(target_path)
            except Exception as exc:
                row['readlinkError'] = failure(exc)
        line = 'CLAWPANEL_HERMES_LEGACY_PATH ' + json.dumps(row, ensure_ascii=True, separators=(',', ':'))
        if len(line) < 4096:
            print(line, file=sys.stderr, flush=True)
    except Exception:
        # 日志、readlink或JSON故障均不能吞原拒绝，也不能把未知路径当成功。
        pass


def _physical(value, *, slot='unknown'):
    """拒绝链接/重解析点、网络路径、ADS 与父目录逃逸；支持物理 8.3 别名归一。"""
    raw = os.fspath(value)
    _require(isinstance(raw, str) and raw and '\0' not in raw, 'physical path invalid')
    _require(not raw.startswith(('\\\\', '//')) and '..' not in raw.replace('\\', '/').split('/'), 'physical path escape')
    p = Path(raw)
    _require(p.is_absolute() and ':' not in raw[len(p.drive):], 'physical path must be absolute without ADS')
    try:
        for part in reversed((p, *p.parents)):
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                _physical_diagnostic(slot, value, raw, part, info=info)
            _require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
                     'physical path link/reparse denied')
        return p.resolve(strict=True)
    except OSError as error:
        _physical_diagnostic(slot, value, raw, part, error=error)
        raise SystemExit('ClawPanel legacy Windows: physical path unavailable') from None


def _runtime_facts():
    _require(os.name == 'nt' and sys.platform == 'win32', 'native Windows required')
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    query = kernel.IsWow64Process2
    query.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.WORD))
    query.restype = wintypes.BOOL
    process, native = wintypes.WORD(), wintypes.WORD()
    handle = kernel.GetCurrentProcess()
    _require(query(handle, ctypes.byref(process), ctypes.byref(native)), 'native machine query failed')
    image = kernel.QueryFullProcessImageNameW
    image.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    image.restype = wintypes.BOOL
    size = wintypes.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    _require(image(handle, 0, buffer, ctypes.byref(size)), 'native process image unavailable')
    times = kernel.GetProcessTimes
    times.argtypes = (wintypes.HANDLE, *(ctypes.POINTER(wintypes.FILETIME),) * 4)
    times.restype = wintypes.BOOL
    creation, exit_time, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
    _require(times(handle, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_time),
                   ctypes.byref(user_time)), 'native process creation time unavailable')
    creation_ticks = creation.dwHighDateTime << 32 | creation.dwLowDateTime
    return dict(platform=sys.platform, os_name=os.name, native_machine=native.value,
                process_machine=process.value, bits=struct.calcsize('P') * 8,
                isolated=sys.flags.isolated, dont_write_bytecode=sys.dont_write_bytecode,
                executable=sys.executable, prefix=sys.prefix,
                base_executable=getattr(sys, '_base_executable', ''), base_prefix=sys.base_prefix,
                process_executable=buffer.value, process_id=os.getpid(),
                process_create_time_filetime_100ns=creation_ticks)


def _legacy_managed_base_physical(value, root, facts, *, slot):
    """仅R20实测UV3.11→3.11.17私有junction；原始事实/通用物理守卫保持不变。"""
    alias = root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none'
    requested = Path(value)
    if slot not in ('facts.base-executable', 'facts.base-prefix', 'venv-config.home') or requested not in (alias, alias / 'python.exe'):
        return _physical(value, slot=slot)
    try:
        link = alias.lstat()
        if not getattr(link, 'st_file_attributes', 0) & 0x400:
            return _physical(value, slot=slot)
        if (stat.S_ISLNK(link.st_mode) or not stat.S_ISDIR(link.st_mode) or
                getattr(link, 'st_reparse_tag', None) != 0xa0000003):
            return _physical(value, slot=slot)
        store = _physical(root / '.hermes-runtime/python', slot='layout.python-store')
        target = store / 'cpython-3.11.17-windows-x86_64-none'

        def link_state():
            info = alias.lstat()
            _require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
                getattr(info, 'st_file_attributes', 0) & 0x400 and getattr(info, 'st_reparse_tag', None) == 0xa0000003,
                'managed Python alias is not the fixed directory junction')
            text = os.readlink(alias)
            # 只识别本地Win32 extended drive语法；UNC/相对/其他目标仍被原守卫拒绝。
            if text.startswith('\\\\?\\') and re.match(r'[a-zA-Z]:[\\/]', text[4:]):
                text = text[4:]
            _require(Path(text) == target and '..' not in text.replace('\\', '/').split('/'),
                     'managed Python alias target mismatch')
            return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_mode,
                    getattr(info, 'st_file_attributes', 0), getattr(info, 'st_reparse_tag', None), text)

        before_link = link_state()
        _require(_physical(target, slot='facts.base-prefix') == target and target.is_dir(),
                 'managed Python alias target must be physical directory')
        image = _physical(target / 'python.exe', slot='facts.process-executable')
        _require(sys.version_info[:3] == (3, 11, 17), 'managed Python alias version mismatch')
        head = _physical(root / '.git/HEAD', slot='layout.git-head').read_bytes()
        _require(head in (LEGACY_PIN.encode(), (LEGACY_PIN+'\n').encode(), (LEGACY_PIN+'\r\n').encode()),
                 'Git detached pin mismatch')
        _SourceContract(root, SOURCE_HASHES)

        def native_identity():
            current = _runtime_facts()
            _require(all(current.get(k) == v for k, v in dict(platform='win32', os_name='nt',
                native_machine=0x8664, process_machine=0, bits=64, isolated=1, dont_write_bytecode=True).items()),
                'managed Python alias requires native isolated runtime')
            keys = ('executable', 'prefix', 'base_executable', 'base_prefix', 'process_executable',
                    'process_id', 'process_create_time_filetime_100ns')
            _require(all(current.get(k) == facts.get(k) for k in keys) and
                current['process_id'] == os.getpid() and type(current['process_create_time_filetime_100ns']) is int and
                current['process_create_time_filetime_100ns'] > 116444736000000000,
                'managed Python alias process facts changed')
            _require(_physical(current['executable'], slot='facts.executable') == root / 'venv/Scripts/python.exe' and
                _physical(current['prefix'], slot='facts.prefix') == root / 'venv' and
                Path(current['base_executable']) == alias / 'python.exe' and
                Path(current['base_prefix']) in (alias, target) and
                _physical(current['process_executable'], slot='facts.process-executable') == image,
                'managed Python alias native image mismatch')

        def binary_state(path):
            with path.open('rb') as stream:
                info = os.fstat(stream.fileno())
                _require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 64 * 1024 * 1024 and
                    info.st_ino > 0 and not getattr(info, 'st_file_attributes', 0) & 0x400,
                    'managed Python alias image is not a bounded regular file')
                data = stream.read(64 * 1024 * 1024 + 1)
                after = os.fstat(stream.fileno())
                identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                _require(identity(info) == identity(after) and len(data) == info.st_size,
                         'managed Python alias image changed during read')
                return identity(info), hashlib.sha256(data).hexdigest()

        native_identity()
        binary = binary_state(image)
        _require(binary_state(alias / 'python.exe') == binary and binary_state(image) == binary,
                 'managed Python alias binary identity/hash mismatch')
        _require(link_state() == before_link, 'managed Python alias changed during admission')
        _require(_physical(target / 'python.exe', slot='facts.process-executable') == image,
                 'managed Python alias target changed')
        native_identity()
        if os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING') == '1':
            try:
                import json
                print('CLAWPANEL_HERMES_LEGACY_ALIAS ' + json.dumps(dict(schemaVersion=1,
                    processId=facts['process_id'], creationTimeFiletime100ns=facts['process_create_time_filetime_100ns'],
                    pin=LEGACY_PIN, sourceFilesVerified=len(SOURCE_HASHES), junctionTag=0xa0000003,
                    aliasRelative=alias.relative_to(root).as_posix(), targetRelative=target.relative_to(root).as_posix(),
                    binarySha256=binary[1], binaryHashScope='stable-live-image-file-not-vendor-attestation'),
                    separators=(',', ':')), file=sys.stderr, flush=True)
            except (OSError, ValueError):
                pass
        return target if requested == alias else image
    except (OSError, ValueError, TypeError, KeyError):
        raise SystemExit('ClawPanel legacy Windows: managed Python alias unavailable') from None


def _validate_layout(root, home, pin, mode, facts):
    """内部纯准入检查；生产仅使用 _runtime_facts 实测值，无 CLI 覆盖参数。"""
    _require(pin == LEGACY_PIN and mode == 'console', 'pin/mode contract mismatch')
    _require(facts['platform'] == 'win32' and facts['os_name'] == 'nt' and
             facts['native_machine'] == 0x8664 and facts['process_machine'] == 0 and facts['bits'] == 64,
             'native Windows AMD64 required; emulation denied')
    _require(facts['isolated'] == 1 and facts['dont_write_bytecode'], 'isolated -I -B interpreter required')
    root, home = _physical(root, slot='layout.root'), _physical(home, slot='layout.home')
    _require(root == home / 'hermes-agent', 'root must be physical managed HOME/hermes-agent')
    _validate_effective_home(home)
    venv = _physical(root / 'venv', slot='layout.venv')
    _require(_physical(facts['prefix'], slot='facts.prefix') == venv and
             _physical(facts['executable'], slot='facts.executable') == _physical(venv / 'Scripts/python.exe', slot='layout.venv-executable'), 'managed venv interpreter mismatch')
    base = _legacy_managed_base_physical(facts['base_executable'], root, facts, slot='facts.base-executable')
    store = _physical(root / '.hermes-runtime/python', slot='layout.python-store')
    _require(base.name.lower() == 'python.exe' and store in base.parents and
             _legacy_managed_base_physical(facts['base_prefix'], root, facts, slot='facts.base-prefix') == base.parent, 'managed base interpreter mismatch')
    # venv 是启动器/逻辑 Python；此时正在执行的 Win32 image 是真实 base Python。
    _require(_physical(facts.get('process_executable', ''), slot='facts.process-executable') == base, 'native process image differs from managed base Python')
    _require(type(facts.get('process_id')) is int and facts['process_id'] == os.getpid(), 'native process PID mismatch')
    created = facts.get('process_create_time_filetime_100ns')
    _require(type(created) is int and created > 116444736000000000, 'native process creation time invalid')
    cfg = {}
    for line in _physical(venv / 'pyvenv.cfg', slot='layout.venv-config').read_text(encoding='utf-8').splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            key = key.strip().lower()
            _require(key not in cfg, 'duplicate venv configuration')
            cfg[key] = value.strip()
    _require(cfg.get('include-system-site-packages', '').lower() == 'false', 'system site packages denied')
    _require(_legacy_managed_base_physical(cfg.get('home', ''), root, facts, slot='venv-config.home') == base.parent, 'venv base home mismatch')
    git = _physical(root / '.git', slot='layout.git')
    _require(git.is_dir(), 'physical Git directory required')
    head = _physical(git / 'HEAD', slot='layout.git-head').read_bytes()
    _require(head in (LEGACY_PIN.encode(), (LEGACY_PIN+'\n').encode(), (LEGACY_PIN+'\r\n').encode()),
             'Git detached pin mismatch')
    return root


def _validate_effective_home(home):
    effective = _physical(os.environ.get('HERMES_HOME', ''), slot='effective.home')
    _require(effective == home or (effective.parent.parent == home and effective.parent.name == 'profiles'),
             'HERMES_HOME outside private HOME/profile')


class _SourceContract:
    def __init__(self, root, hashes):
        self.root = _physical(root, slot='contract.root')
        self.hashes = dict(hashes)
        self.modules = {}
        for rel, digest in self.hashes.items():
            _require(re.fullmatch(r'[a-zA-Z0-9_/]+\.py', rel) and re.fullmatch(r'[a-f0-9]{64}', digest), 'source contract malformed')
            name = rel[:-3].replace('/', '.')
            if name.endswith('.__init__'):
                name = name[:-9]
            self.modules[name] = rel
        self.verify_all()

    def read(self, rel):
        p = _physical(self.root / rel, slot='contract.source')
        _require(p == self.root / rel and p.is_file(), 'source physical origin mismatch')
        raw = p.read_bytes()
        _require(hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest() == self.hashes[rel], 'source hash mismatch: '+rel)
        return raw

    def verify_all(self):
        for rel in self.hashes:
            self.read(rel)

    def check_spec(self, fullname, spec):
        rel = self.modules[fullname]
        _require(spec is not None and spec.origin and _physical(spec.origin, slot='contract.spec-origin') == self.root / rel, 'module origin mismatch: '+fullname)
        loader = spec.loader
        _require(type(loader) is importlib.machinery.SourceFileLoader, 'unknown module loader: '+fullname)
        _require(_physical(loader.get_filename(fullname), slot='contract.loader-filename') == self.root / rel, 'loader origin mismatch')
        raw = self.read(rel)
        # 原 loader 仍负责执行；先拒绝时间戳伪造/旁路 .pyc，不将源 hash 当作执行字节证明。
        code = loader.get_code(fullname)
        expected = compile(raw, str(self.root / rel), 'exec', dont_inherit=True, optimize=sys.flags.optimize)
        _require(isinstance(code, types.CodeType) and code == expected, 'loader bytecode/source mismatch: '+fullname)
        return loader

    def check_module(self, fullname, module):
        _require(isinstance(module, types.ModuleType) and module.__name__ == fullname and
                 _physical(module.__file__, slot='contract.loaded-module') == self.root / self.modules[fullname], 'loaded module origin mismatch')
        self.check_spec(fullname, module.__spec__)


def _check_interface(module, name, parameters):
    value = getattr(module, name, None)
    _require(isinstance(value, types.FunctionType) and value.__module__ == module.__name__ and
             _physical(value.__code__.co_filename, slot='interface.code-file') == _physical(module.__file__, slot='interface.module-file'), 'function interface origin mismatch: '+name)
    actual = [(p.name, p.kind, p.default) for p in inspect.signature(value).parameters.values()]
    _require(actual == parameters, 'function interface mismatch: '+name)
    return value


class _GatewayLoader:
    """仅代理两个精确目标 loader；其他接口保持原委托，回调始终在原执行完成后。"""
    def __init__(self, original, finder):
        self.original, self.finder = original, finder

    def __getattr__(self, name):
        return getattr(self.original, name)

    def create_module(self, spec):
        return self.original.create_module(spec)

    def exec_module(self, module):
        try:
            self.original.exec_module(module)
            _require(sys.modules.get(module.__name__) is module, 'loaded module identity changed')
            if module.__loader__ is self:
                module.__loader__ = self.original
            if module.__spec__.loader is self:
                module.__spec__.loader = self.original
            self.finder.after_module(module)
        finally:
            if module.__loader__ is self:
                module.__loader__ = self.original
            if module.__spec__.loader is self:
                module.__spec__.loader = self.original


class _OwnedIdentityHooks:
    """登记外层阶段回调的已知挂点；安装中途失败也能撤回，不覆盖后续所有者。"""
    def __init__(self, slots):
        self.originals = [(obj, name, getattr(obj, name)) for obj, name in slots]
        self.edits = []
        self.restore = None

    def install(self, installer, status, gateway, context):
        try:
            self.restore = installer(status, gateway, context)
            _require(callable(self.restore), 'identity installer must return restore callable')
        finally:
            self.edits = [(obj, name, original, getattr(obj, name)) for obj, name, original in self.originals]

    def close(self):
        try:
            if callable(self.restore) and all(getattr(o, n) is changed for o, n, _, changed in self.edits):
                self.restore()
        finally:
            for obj, name, original, changed in self.edits:
                if getattr(obj, name) is changed:
                    setattr(obj, name, original)


class _PinnedFinder:
    def __init__(self, contract, installer, identity_installer, runtime_facts):
        self.contract, self.installer = contract, installer
        self.identity_installer = identity_installer
        self.runtime_facts = types.MappingProxyType(dict(runtime_facts))
        self.python_orig_argv = tuple(sys.orig_argv)
        self.loading = set()
        self.restore = None
        self.edits = []
        self.identity_groups = []
        self.status = None

    def find_spec(self, fullname, path=None, target=None):
        if fullname not in self.contract.modules:
            return None
        if fullname in ('hermes_cli.gateway', 'gateway.status'):
            _require(fullname not in self.loading, 'identity module re-execution denied')
            # 原 profile 解析已经发生；先核其物理边界，再允许原 Gateway import。
            _validate_effective_home(self.contract.root.parent)
            self.loading.add(fullname)
        # 按 Python 当前 finder 顺序继续；不跳过 editable finder，不吞其异常。
        chain = tuple(sys.meta_path)
        start = next(i for i, finder in enumerate(chain) if finder is self) + 1
        for finder in chain[start:]:
            find = getattr(finder, 'find_spec', None)
            if find is not None:
                spec = find(fullname, path, target)
            else:
                legacy = finder.find_module(fullname, path)
                spec = importlib.util.spec_from_loader(fullname, legacy) if legacy is not None else None
            if spec is not None:
                loader = self.contract.check_spec(fullname, spec)
                if fullname in ('hermes_cli.gateway', 'gateway.status'):
                    spec.loader = _GatewayLoader(loader, self)
                return spec
        raise ModuleNotFoundError('No module named '+repr(fullname), name=fullname)

    def _install_identity(self, phase, status, gateway):
        slots = [(status, name) for name in _STATUS_IDENTITY_SLOTS]
        if gateway is not None:
            slots.extend((gateway, name) for name in _GATEWAY_IDENTITY_SLOTS)
        group = _OwnedIdentityHooks(slots)
        self.identity_groups.append(group)
        context = types.MappingProxyType(dict(schema_version=1, version='0.21.5', pin=LEGACY_PIN,
            source_root=str(self.contract.root), owner_home=str(self.contract.root.parent),
            effective_home=str(_physical(os.environ['HERMES_HOME'], slot='identity.effective-home')), phase=phase,
            cli_argv=tuple(sys.argv), python_orig_argv=self.python_orig_argv,
            runtime_facts=self.runtime_facts, source_hashes=types.MappingProxyType(dict(self.contract.hashes))))
        group.install(self.identity_installer, status, gateway, context)
        if phase == 'gateway':
            _require(all(getattr(obj, name) is original for obj, name, original in group.originals
                         if obj is status), 'gateway identity phase must not rewrap status hooks')

    def after_module(self, module):
        if module.__name__ == 'gateway.status':
            _validate_effective_home(self.contract.root.parent)
            self.contract.check_module('gateway.status', module)
            P, K, E = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY, inspect.Parameter.empty)
            _check_interface(module, '_build_pid_record', [])
            _check_interface(module, '_record_matches_live_gateway_pid', [('record', P, E), ('pid', P, E), ('expected_home', K, None)])
            _check_interface(module, '_looks_like_gateway_process', [('pid', P, E)])
            self._install_identity('status', module, None)
            self.status = module
            return
        self.after_gateway(module)

    def after_gateway(self, gateway):
        # 不提前导入 gateway/compat/runtime；原 main 已先完成 profile 解析。
        _validate_effective_home(self.contract.root.parent)
        self.contract.check_module('hermes_cli.gateway', gateway)
        _require(self.status is not None and sys.modules.get('gateway.status') is self.status,
                 'original status module/identity phase missing before CLI Gateway')
        P, E = inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.empty
        _check_interface(gateway, '_scan_gateway_pids', [('exclude_pids', P, E), ('all_profiles', P, False),
                                                      ('include_restart_managers', P, False)])
        _check_interface(gateway, '_capture_gateway_argv', [('pid', P, E)])
        self._install_identity('gateway', self.status, gateway)
        compat = importlib.import_module('hermes_cli._subprocess_compat')
        processes = importlib.import_module('hermes_cli.local_runtime.processes')
        self.contract.check_module(compat.__name__, compat)
        self.contract.check_module(processes.__name__, processes)
        P, K, V, E = (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY,
                      inspect.Parameter.VAR_KEYWORD, inspect.Parameter.empty)
        _check_interface(gateway, '_windows_process_listing', [])
        _check_interface(compat, 'bounded_probe_run', [('argv',P,E),('timeout',K,E),('errors',K,'replace'),
            ('env',K,None),('cwd',K,None),('raise_on_spawn_failure',K,False)])
        _check_interface(compat, 'windows_hide_flags', [])
        _check_interface(compat, '_close_job', [('job',P,E)])
        _check_interface(compat, 'kill_process_tree', [('proc',P,E)])
        spawn_server = _check_interface(processes, 'spawn_server', [('cmd',P,E),('kwargs',V,E)])
        originals = [(gateway,'_windows_process_listing',gateway._windows_process_listing),
                     (compat,'bounded_probe_run',compat.bounded_probe_run)]
        try:
            self.restore = self.installer(gateway, compat, spawn_server)
            _require(callable(self.restore), 'CIM installer must return restore callable')
        finally:
            # installer 中途失败也只收回本次两个已知挂点，不改其他模块状态。
            self.edits = [(obj,name,original,getattr(obj,name)) for obj,name,original in originals]

    def close(self):
        failures = []
        try:
            if callable(self.restore) and all(getattr(o,n) is changed for o,n,_,changed in self.edits):
                self.restore()
        except BaseException as error:
            failures.append(error)
        finally:
            for obj, name, original, changed in self.edits:
                if getattr(obj, name) is changed:
                    setattr(obj, name, original)
        for group in reversed(self.identity_groups):
            try:
                group.close()
            except BaseException as error:
                failures.append(error)
        if failures:
            raise failures[0]


def _run_console(contract, args, installer, *, identity_installer=None, runtime_facts=None):
    """内部 console 调用；生产只能由已验证固定布局及固定 SOURCE_HASHES 进入。"""
    _require(callable(installer), 'outer install_windows_cim_probe callable required')
    _require(not any(name == 'gateway' or name.startswith(('gateway.', 'hermes_cli', 'hermes_bootstrap'))
                     for name in sys.modules), 'preloaded Hermes module denied')
    contract.verify_all()
    _require(callable(identity_installer), 'outer install_windows_private_identity callable required')
    _require(isinstance(runtime_facts, dict), 'measured native runtime facts required')
    _validate_layout(contract.root, contract.root.parent, LEGACY_PIN, 'console', runtime_facts)
    original_argv = sys.argv
    # 只加已经物理/hash 核验的源码根。-I 保留受管 venv site，而不接受 cwd/PYTHONPATH。
    class _RootPath(str):
        pass
    added = _RootPath(str(contract.root))
    finder = _PinnedFinder(contract, installer, identity_installer, runtime_facts)
    sys.path.insert(0, added)
    sys.meta_path.insert(0, finder)
    # 只去掉本入口元数据；保留实际 -c，不构造能骗过原身份 matcher 的 console 路径。
    sys.argv = [original_argv[0], *args]
    try:
        from hermes_cli.main import main
        _require(sys.modules['hermes_cli'].__version__ == '0.21.5', 'package version mismatch')
        return main()
    finally:
        primary = sys.exc_info()[1]
        try:
            finder.close()
        except BaseException as cleanup_error:
            if primary is None:
                raise
            primary.add_note('ClawPanel private adapter restore failed: '+type(cleanup_error).__name__)
        finally:
            sys.meta_path[:] = [item for item in sys.meta_path if item is not finder]
            sys.path[:] = [item for item in sys.path if item is not added]
            sys.argv = original_argv


def _parse_args(args):
    _require(len(args) >= 5 and args[4] == '--' and all(isinstance(x,str) and '\0' not in x for x in args),
             'expected ROOT HOME PIN console -- original-args')
    return (*args[:4], args[5:])


if __name__ == '__main__':
    _root, _home, _pin, _mode, _args = _parse_args(sys.argv[1:])
    _facts = _runtime_facts()
    _root = _validate_layout(_root, _home, _pin, _mode, _facts)
    # 仅使用外层已审、已验 hash 的组合模板，不接收模块/脚本路径或下载代码。
    _installer = globals().get('install_windows_cim_probe')
    _identity_installer = globals().get('install_windows_private_identity')
    raise SystemExit(_run_console(_SourceContract(_root, SOURCE_HASHES), _args, _installer,
        identity_installer=_identity_installer, runtime_facts=_facts))
