"""固定0.21.5私有Windows入口身份adapter；仅可信组合入口调用，不作为CLI。"""
import hashlib, importlib.machinery, inspect, math, os
from pathlib import Path
import re, stat, sys, types

LEGACY_IDENTITY_PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
LEGACY_STATUS_SHA256 = "b7923018b5285d042313cf41421c3aec3260e560c4b5a326544b64f000ca424c"

def decode_clawpanel_private_script_bytes(source, pin):
    import base64, hashlib, re, zlib
    if type(source) is not str or pin not in ('d923a5eb487a17c0a68801bba9ef0f56c81040a8', 'f97608f178d1ffeca59860195ab7da295f7c8e5f') or '\0' in source:
        raise ValueError('private script contract mismatch')
    if not source.startswith('# CLAWPANEL_PRIVATE_SCRIPT'):
        raw = source.encode('utf-8')
        if len(raw) > 131072:
            raise ValueError('private script source budget exceeded')
        return raw
    if len(source) > 30000:
        raise ValueError('private script wire budget exceeded')
    header = re.match(r'# CLAWPANEL_PRIVATE_SCRIPT_V1 ([a-f0-9]{40}) ([a-f0-9]{64})\n', source)
    payload = re.search(r"_cp_b\.b64decode\('([A-Za-z0-9+/=]+)',validate=True\)", source)
    if header is None or header[1] != pin or payload is None:
        raise ValueError('private script envelope mismatch')
    template = """# CLAWPANEL_PRIVATE_SCRIPT_V1 {pin} {sha}
import base64 as _cp_b, zlib as _cp_z, hashlib as _cp_h
_cp_d=_cp_z.decompressobj()
_CLAWPANEL_EXECUTED_SCRIPT_BYTES=_cp_d.decompress(_cp_b.b64decode('{data}',validate=True),131073)
if len(_CLAWPANEL_EXECUTED_SCRIPT_BYTES)>131072 or not _cp_d.eof or _cp_d.unused_data or _cp_h.sha256(_CLAWPANEL_EXECUTED_SCRIPT_BYTES).hexdigest()!='{sha}':raise SystemExit('ClawPanel private script integrity failed')
exec(compile(_CLAWPANEL_EXECUTED_SCRIPT_BYTES,'<clawpanel-hermes-private>','exec'))
"""
    if source != template.format(pin=pin, sha=header[2], data=payload[1]):
        raise ValueError('private script envelope mismatch')
    try:
        compressed = base64.b64decode(payload[1], validate=True)
        if base64.b64encode(compressed).decode('ascii') != payload[1]:
            raise ValueError('private script encoding mismatch')
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, 131073)
        if len(raw) > 131072 or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or hashlib.sha256(raw).hexdigest() != header[2]:
            raise ValueError('private script integrity mismatch')
        if '\0' in raw.decode('utf-8'):
            raise ValueError('private script contains NUL')
        return raw
    except (zlib.error, base64.binascii.Error) as error:
        raise ValueError('private script decoding failed') from error


def _legacy_identity_require(ok, message):
    if not ok:
        raise SystemExit('ClawPanel legacy identity: ' + message)


def _legacy_identity_physical(value):
    raw = os.fspath(value)
    _legacy_identity_require(isinstance(raw, str) and raw and '\0' not in raw and
        not raw.startswith(('\\\\', '//')) and '..' not in raw.replace('\\', '/').split('/'), 'physical path invalid')
    p = Path(raw)
    _legacy_identity_require(p.is_absolute() and ':' not in raw[len(p.drive):], 'physical path escape')
    for part in reversed((p, *p.parents)):
        info = part.lstat()
        _legacy_identity_require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 0x400,
            'physical path link/reparse denied')
    return p.resolve(strict=True)


def _legacy_identity_runtime_facts():
    _legacy_identity_require(os.name == 'nt' and sys.platform == 'win32', 'native Windows required')
    import ctypes, struct
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    query = kernel.IsWow64Process2
    query.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.WORD))
    query.restype = wintypes.BOOL
    process, native = wintypes.WORD(), wintypes.WORD()
    _legacy_identity_require(query(kernel.GetCurrentProcess(), ctypes.byref(process), ctypes.byref(native)), 'native query failed')
    return dict(executable=sys.executable, prefix=sys.prefix, base_executable=getattr(sys, '_base_executable', ''),
        base_prefix=sys.base_prefix, platform=sys.platform, os_name=os.name, native_machine=native.value,
        process_machine=process.value, bits=struct.calcsize('P') * 8, isolated=sys.flags.isolated,
        dont_write_bytecode=sys.dont_write_bytecode)


def _legacy_identity_base_physical(value, root, facts, *, slot):
    """仅三个base字段接固定entry resolver；独立身份事实及其他物理守卫不变。"""
    alias = root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none'
    if slot not in ('facts.base-executable', 'facts.base-prefix', 'venv-config.home') or Path(value) not in (alias, alias / 'python.exe'):
        return _legacy_identity_physical(value)
    try:
        if not getattr(alias.lstat(), 'st_file_attributes', 0) & 0x400:
            return _legacy_identity_physical(value)
        collector, resolver = globals().get('_runtime_facts'), globals().get('_legacy_managed_base_physical')
        _legacy_identity_require(all(type(fn) is types.FunctionType and fn.__globals__ is globals()
            for fn in (collector, resolver)), 'trusted entry runtime resolver unavailable')
        full = collector()
        keys = ('executable', 'prefix', 'base_executable', 'base_prefix', 'platform', 'os_name',
                'native_machine', 'process_machine', 'bits', 'isolated', 'dont_write_bytecode')
        _legacy_identity_require(type(full) is dict and all(k in full and k in facts and
            type(full[k]) is type(facts[k]) and full[k] == facts[k] for k in keys), 'entry/identity runtime facts differ')
        _legacy_identity_require(type(full.get('process_executable')) is str and full['process_executable'] and
            type(full.get('process_id')) is int and full['process_id'] == os.getpid() and
            type(full.get('process_create_time_filetime_100ns')) is int and
            full['process_create_time_filetime_100ns'] > 116444736000000000, 'full native process facts unavailable')
        # 原始完整fresh facts直接传入；不从context/有限身份字段制造canonical facts，不缓存alias成功。
        return resolver(value, root, full, slot=slot)
    except (OSError, ValueError, TypeError, KeyError):
        raise SystemExit('ClawPanel legacy identity: managed base admission unavailable') from None


def _legacy_runtime_layout(root, home, facts):
    _legacy_identity_require(facts['platform'] == 'win32' and facts['os_name'] == 'nt' and facts['native_machine'] == 0x8664 and
        facts['process_machine'] == 0 and facts['bits'] == 64 and facts['isolated'] == 1 and facts['dont_write_bytecode'], 'native AMD64 isolated runtime required')
    root, home = _legacy_identity_physical(root), _legacy_identity_physical(home)
    _legacy_identity_require(root == home / 'hermes-agent', 'source outside private HOME')
    venv = _legacy_identity_physical(root / 'venv/Scripts/python.exe')
    base = _legacy_identity_base_physical(facts['base_executable'], root, facts, slot='facts.base-executable')
    store = _legacy_identity_physical(root / '.hermes-runtime/python')
    _legacy_identity_require(_legacy_identity_physical(facts['executable']) == venv and
        _legacy_identity_physical(facts['prefix']) == root / 'venv' and base.name.lower() == 'python.exe' and
        store in base.parents and _legacy_identity_base_physical(facts['base_prefix'], root, facts, slot='facts.base-prefix') == base.parent, 'venv/base interpreter identity mismatch')
    cfg = {}
    for line in _legacy_identity_physical(root / 'venv/pyvenv.cfg').read_text(encoding='utf-8').splitlines():
        if '=' in line:
            key, value = line.split('=', 1); key = key.strip().lower()
            _legacy_identity_require(key not in cfg, 'duplicate venv configuration')
            cfg[key] = value.strip()
    _legacy_identity_require(cfg.get('include-system-site-packages', '').lower() == 'false' and
        _legacy_identity_base_physical(cfg.get('home', ''), root, facts, slot='venv-config.home') == base.parent, 'venv base configuration mismatch')
    git = _legacy_identity_physical(root / '.git')
    _legacy_identity_require(git.is_dir() and _legacy_identity_physical(git / 'HEAD').read_bytes() in
        (LEGACY_IDENTITY_PIN.encode(), (LEGACY_IDENTITY_PIN+'\n').encode(), (LEGACY_IDENTITY_PIN+'\r\n').encode()), 'detached source pin mismatch')
    return root, home, venv, base


def _verify_legacy_status(status, root):
    p = _legacy_identity_physical(root / 'gateway/status.py')
    _legacy_identity_require(type(status) is types.ModuleType and status.__name__ == 'gateway.status' and
        _legacy_identity_physical(status.__file__) == p and type(status.__loader__) is importlib.machinery.SourceFileLoader and
        _legacy_identity_physical(status.__loader__.get_filename(status.__name__)) == p, 'status module origin mismatch')
    raw = p.read_bytes().replace(b'\r\n', b'\n')
    _legacy_identity_require(hashlib.sha256(raw).hexdigest() == LEGACY_STATUS_SHA256, 'fixed status source mismatch')
    compiled = compile(raw, str(p), 'exec', dont_inherit=True, optimize=sys.flags.optimize)
    expected = {code.co_name: code for code in compiled.co_consts if isinstance(code, types.CodeType)}
    for name in ('_build_pid_record', '_record_matches_live_gateway_pid'):
        fn = getattr(status, name, None)
        _legacy_identity_require(isinstance(fn, types.FunctionType) and fn.__module__ == status.__name__ and
            fn.__globals__ is vars(status) and fn.__code__ == expected[name] and fn.__defaults__ in (None, ()) and
            fn.__kwdefaults__ == ({'expected_home': None} if name == '_record_matches_live_gateway_pid' else None), 'status executable code/defaults mismatch')


def _install_legacy_gateway_identity(status, root, home, venv, base, launch_script):
    """内部已准入核心；生产只从下方实测布局+固定源入口调用。"""
    import psutil
    original, factory = status._record_matches_live_gateway_pid, status._build_pid_record
    _legacy_identity_require(list(inspect.signature(original).parameters) == ['record', 'pid', 'expected_home'] and
        not inspect.signature(factory).parameters, 'status interface mismatch')
    body = decode_clawpanel_private_script_bytes(launch_script, LEGACY_IDENTITY_PIN)
    executed = globals().get('_CLAWPANEL_EXECUTED_SCRIPT_BYTES', body if not launch_script.startswith('# CLAWPANEL_PRIVATE_SCRIPT') else None)
    _legacy_identity_require(type(executed) is bytes and executed == body, 'executed private body mismatch')
    digest = hashlib.sha256(body).hexdigest()
    def build():
        process = psutil.Process(); birth = process.create_time()
        record = factory()
        _legacy_identity_require(record['pid'] == process.pid and math.isfinite(birth) and birth > 0 and
            psutil.Process(process.pid).create_time() == birth, 'creation identity changed')
        # 只扩展原native工厂的真实当前record；原argv/锁/writer保持不变。
        record['clawpanel_legacy_identity'] = dict(create_time=birth, script_sha256=digest, pin=LEGACY_IDENTITY_PIN)
        return record
    def matches(record, pid, *, expected_home=None):
        if 'clawpanel_legacy_identity' not in record:
            return original(record, pid, expected_home=expected_home)
        try:
            process = psutil.Process(pid); birth = process.create_time()
            proof = record['clawpanel_legacy_identity']
            active = _legacy_identity_physical(expected_home or status._get_process_hermes_home())
            name = 'default' if active == home else active.name
            if active != home and (active.parent != home / 'profiles' or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name)):
                return False
            if (type(pid) is not int or record.get('pid') != pid or record.get('kind') != status._GATEWAY_KIND or
                record.get('hermes_home') != str(active) or proof.get('pin') != LEGACY_IDENTITY_PIN or
                proof.get('script_sha256') != digest or type(proof.get('create_time')) is not float or
                proof['create_time'] != birth or not math.isfinite(birth) or birth <= 0 or
                record.get('start_time') != status._get_process_start_time(pid) or
                record.get('argv') != ['-c', 'gateway', 'run']):
                return False
            argv = process.cmdline()
            if argv[3:5] == ['-X', 'importtime']:
                argv = argv[:3] + argv[5:]
            if (argv[1:4] != ['-I', '-B', '-c'] or decode_clawpanel_private_script_bytes(argv[4], LEGACY_IDENTITY_PIN) != body or
                _legacy_identity_physical(argv[0]) != venv or _legacy_identity_physical(process.exe()) != base or
                _legacy_identity_physical(argv[5]) != root or _legacy_identity_physical(argv[6]) != home or
                argv[7:10] != [LEGACY_IDENTITY_PIN, 'console', '--'] or
                _legacy_identity_physical(process.environ().get('HERMES_HOME', '')) != active):
                return False
            words, selector, i = [], None, 10
            while i < len(argv):
                word = argv[i]
                if word in ('-p', '--profile') or word.startswith(('-p=', '--profile=')):
                    if selector is not None:
                        return False
                    if '=' in word: selector = word.split('=', 1)[1]
                    else: i += 1; selector = argv[i]
                else: words.append(word)
                i += 1
            return (words == ['gateway', 'run'] and selector in (None, name) and process.is_running() and
                process.username() == psutil.Process().username() and psutil.Process(pid).create_time() == birth)
        except (Exception, SystemExit):
            return False
    status._build_pid_record, status._record_matches_live_gateway_pid = build, matches
    def restore():
        if status._build_pid_record is build: status._build_pid_record = factory
        if status._record_matches_live_gateway_pid is matches: status._record_matches_live_gateway_pid = original
    return restore


def install_legacy_gateway_identity(root, home, launch_script):
    """在Carver原profile解析及Gateway加载后调用；没有CLI/facts/source覆盖入口。"""
    try:
        root, home, venv, base = _legacy_runtime_layout(root, home, _legacy_identity_runtime_facts())
        status = sys.modules.get('gateway.status')
        _verify_legacy_status(status, root)
        return _install_legacy_gateway_identity(status, root, home, venv, base, launch_script)
    except Exception as error:
        raise SystemExit('ClawPanel legacy identity: admission unavailable (' + type(error).__name__ + ')') from None


_legacy_identity_bridges = {}


def install_windows_private_identity(status, gateway, context):
    """Carver R2两阶段公开桥；status走完整真实准入，gateway不重包status或改scan/capture。"""
    try:
        _legacy_identity_require(type(context) is types.MappingProxyType and context.get('schema_version') == 1 and
            context.get('version') == '0.21.5' and context.get('pin') == LEGACY_IDENTITY_PIN, 'readonly context/version mismatch')
        phase = context.get('phase')
        _legacy_identity_require(phase in ('status', 'gateway') and
            type(context.get('source_hashes')) is types.MappingProxyType and
            context['source_hashes'].get('gateway/status.py') == LEGACY_STATUS_SHA256 and
            type(context.get('runtime_facts')) is types.MappingProxyType, 'phase/source context mismatch')
        root = _legacy_identity_physical(context['source_root'])
        home = _legacy_identity_physical(context['owner_home'])
        active = _legacy_identity_physical(context['effective_home'])
        _legacy_identity_require(root == home / 'hermes-agent' and
            active == _legacy_identity_physical(os.environ['HERMES_HOME']) and
            (active == home or (active.parent == home / 'profiles' and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', active.name))), 'active profile context mismatch')
        orig = context['python_orig_argv']
        _legacy_identity_require(type(orig) is tuple and orig == tuple(sys.orig_argv) and
            all(type(v) is str and '\0' not in v for v in orig), 'original Python argv mismatch')
        argv = list(orig)
        if argv[3:5] == ['-X', 'importtime']: argv = argv[:3] + argv[5:]
        _legacy_identity_require(argv[1:4] == ['-I', '-B', '-c'] and
            _legacy_identity_physical(argv[5]) == root and _legacy_identity_physical(argv[6]) == home and
            argv[7:10] == [LEGACY_IDENTITY_PIN, 'console', '--'] and context['cli_argv'][0] == '-c', 'original launch scope mismatch')
        launch_script = argv[4]
        key = id(status)
        if phase == 'status':
            _legacy_identity_require(gateway is None and key not in _legacy_identity_bridges and sys.modules.get('gateway.status') is status,
                'status phase duplicate/module mismatch')
            # 不以context伪造facts、不直调内部核心；仍执行本模块原公开真实layout/source准入。
            restore = install_legacy_gateway_identity(root, home, launch_script)
            state = (status, root, home, active, launch_script, status._build_pid_record, status._record_matches_live_gateway_pid)
            _legacy_identity_bridges[key] = state
            def close():
                try: restore()
                finally:
                    if _legacy_identity_bridges.get(key) is state: _legacy_identity_bridges.pop(key)
            return close
        state = _legacy_identity_bridges.get(key)
        _legacy_identity_require(state is not None and state[:5] == (status, root, home, active, launch_script) and
            status._build_pid_record is state[5] and status._record_matches_live_gateway_pid is state[6], 'gateway phase missing/changed status owner')
        _legacy_identity_require(type(gateway) is types.ModuleType and gateway.__name__ == 'hermes_cli.gateway' and
            _legacy_identity_physical(gateway.__file__) == root / 'hermes_cli/gateway.py' and
            context['source_hashes'].get('hermes_cli/gateway.py') == 'd8cdbd900dbebcbaffc0406442711bbd592f292614e1d59578f9b4c163c379f3' and
            hashlib.sha256((root / 'hermes_cli/gateway.py').read_bytes().replace(b'\r\n', b'\n')).hexdigest() == context['source_hashes']['hermes_cli/gateway.py'], 'gateway source context mismatch')
        # 有record的真实STOP由status matcher闭合；无record scan/update capture仍为原实现，未声称适配。
        return lambda: None
    except Exception as error:
        raise SystemExit('ClawPanel legacy identity: bridge unavailable (' + type(error).__name__ + ')') from None
