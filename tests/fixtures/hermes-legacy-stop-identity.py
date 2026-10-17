# 只执行固定原函数及自有临时文件/隔离进程表，不启动Hermes、不读取注册表。
import ast, base64, copy, hashlib, importlib.machinery, importlib.util, inspect, json, os
from pathlib import Path
import re, shlex, sys, tempfile, types, zlib
from typing import Any, Optional

helper, fixture_file, group = sys.argv[1:]
fixture = json.loads(Path(fixture_file).read_text(encoding='utf-8'))
module = None
if Path(helper).exists():
    spec = importlib.util.spec_from_file_location('owned_legacy_identity', helper)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
native_source = zlib.decompress(base64.b64decode(fixture['statusZlibBase64'])).decode()
assert hashlib.sha256(native_source.encode()).hexdigest() == fixture['statusSha256']

def frame(body, level=9, tail=b''):
    sha = hashlib.sha256(body).hexdigest()
    data = base64.b64encode(zlib.compress(body, level) + tail).decode()
    return f"""# CLAWPANEL_PRIVATE_SCRIPT_V1 {fixture['pin']} {sha}
import base64 as _cp_b, zlib as _cp_z, hashlib as _cp_h
_cp_d=_cp_z.decompressobj()
_CLAWPANEL_EXECUTED_SCRIPT_BYTES=_cp_d.decompress(_cp_b.b64decode('{data}',validate=True),131073)
if len(_CLAWPANEL_EXECUTED_SCRIPT_BYTES)>131072 or not _cp_d.eof or _cp_d.unused_data or _cp_h.sha256(_CLAWPANEL_EXECUTED_SCRIPT_BYTES).hexdigest()!='{sha}':raise SystemExit('ClawPanel private script integrity failed')
exec(compile(_CLAWPANEL_EXECUTED_SCRIPT_BYTES,'<clawpanel-hermes-private>','exec'))
"""

with tempfile.TemporaryDirectory(prefix='cp-old-identity-') as tmp:
    home = Path(tmp).resolve() / '.hermes'; root = home / 'hermes-agent'
    source_file = root / 'gateway/status.py'; source_file.parent.mkdir(parents=True); source_file.write_text(native_source, encoding='utf-8', newline='\n')
    (root / '.git').mkdir(); (root / '.git/HEAD').write_text(fixture['pin']+'\n')
    venv = root / 'venv/Scripts/python.exe'; venv.parent.mkdir(parents=True); venv.touch()
    base = root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none/python.exe'; base.parent.mkdir(parents=True); base.touch()
    (root / 'venv/pyvenv.cfg').write_text('home = '+str(base.parent)+'\ninclude-system-site-packages = false\n')
    active = home
    body = b'# owned complete private source\nraise RuntimeError("must-not-execute")\n'
    wire = frame(body)
    if os.environ.get('HERMES_LEGACY_WIRE_SAMPLE'):
        sample=json.loads(Path(os.environ['HERMES_LEGACY_WIRE_SAMPLE']).read_text(encoding='utf-8'))
        wire=sample['wire']
        body=base64.b64decode(sample['bodyBase64'])
        assert hashlib.sha256(body).hexdigest()==sample['bodySha256']
    birth = 1000.125
    target = dict(pid=901, birth=birth, exe=str(base), argv=[str(venv), '-I', '-B', '-c', wire, str(root), str(home), fixture['pin'], 'console', '--', 'gateway', 'run'], env={'HERMES_HOME': str(active)}, user='owner', running=True)
    caller = 901
    class Process:
        def __init__(self, pid=None): self.pid = caller if pid is None else pid; self.birth = target['birth']
        def create_time(self): return self.birth
        def cmdline(self): return target['argv'][:]
        def exe(self): return target['exe']
        def environ(self):
            if target.get('unreadable_env'): raise PermissionError('owned negative')
            return target['env'].copy()
        def username(self):
            if self.pid == 901 and target.pop('reused_late', False): target['birth'] += 0.001
            return target['user'] if self.pid == 901 else 'owner'
        def is_running(self): return target['running']
    psutil = types.ModuleType('psutil'); psutil.Process = Process; sys.modules['psutil'] = psutil
    gateway = types.ModuleType('gateway'); gateway.__path__ = []
    status = types.ModuleType('gateway.status'); gateway.status = status
    status.__file__ = str(source_file); status.__loader__ = importlib.machinery.SourceFileLoader('gateway.status', str(source_file))
    status.__spec__ = importlib.util.spec_from_loader('gateway.status', status.__loader__)
    status.__dict__.update(dict(Any=Any, Optional=Optional, Path=Path, shlex=shlex, sys=types.SimpleNamespace(argv=['-c','gateway','run']), os=types.SimpleNamespace(getpid=lambda:901), _GATEWAY_KIND='hermes-gateway'))
    names=set(fixture['status']['lines']); tree=ast.parse(native_source)
    nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(source_file),'exec'),status.__dict__)
    # 3.13编译器会依整个模块已知import选择LOAD_ATTR形式；直接使用完整固定模块原code对象，
    # 但不执行模块级vendor import。保留函数默认值/原始行号与真实body。
    full = compile(native_source, str(source_file), 'exec', dont_inherit=True, optimize=sys.flags.optimize)
    fixed_codes = {c.co_name:c for c in full.co_consts if isinstance(c,types.CodeType)}
    for name in names:status.__dict__[name].__code__=fixed_codes[name]
    sys.modules.update({'gateway':gateway,'gateway.status':status})
    status._read_process_cmdline=lambda pid:' '.join(target['argv'])
    status._get_process_start_time=lambda pid:round(target['birth']*100)
    status._get_process_hermes_home=lambda:active
    status._canonical_hermes_home=lambda p:p
    status._host_gateway_serves_home=lambda *a:False
    status._command_line_belongs_to_profile=lambda command,p:p==active
    status._get_pid_path=lambda:active/'gateway.pid'
    status._get_gateway_lock_path=lambda p:active/'gateway.lock'
    status.is_gateway_runtime_lock_active=lambda p:True
    status._live_pid_from_record=lambda r:r['pid'] if r and target['running'] else None
    status._pid_record_belongs_to_current_profile=lambda r:r.get('hermes_home')==str(active)
    status.recorded_gateway_home_conflicts=lambda r,expected_home:r.get('hermes_home')!=str(expected_home)
    status._cleanup_invalid_pid_path=lambda *a,**kw:None
    status.get_runtime_status_running_pid=lambda:None
    original, factory = status._record_matches_live_gateway_pid, status._build_pid_record
    if module and group not in {'source', 'layout', 'decoder', 'phases'}:
        module._CLAWPANEL_EXECUTED_SCRIPT_BYTES=body
        restore=module._install_legacy_gateway_identity(status,root,home,venv,base,wire)
    else:restore=lambda:None
    record=status._build_pid_record();caller=1901
    status._read_pid_record=status._read_gateway_lock_record=lambda p:record
    cli=types.ModuleType('hermes_cli.gateway')
    cli.__dict__.update(os=status.os,time=types.SimpleNamespace(sleep=lambda s:None),logger=types.SimpleNamespace(debug=lambda *a:None))
    exec(fixture['cli']['source'],cli.__dict__)
    cli._append_unique_pid=lambda pids,pid,excluded:pids.append(pid) if pid and pid not in excluded and pid not in pids else None
    cli._get_service_pids=lambda **kw:[];cli.supports_systemd_services=lambda:False;cli._scan_gateway_pids=lambda *a,**kw:[]
    cli._reap_unsupervised_gateway_orphans=lambda **kw:False;cli.is_windows=lambda:True
    events=[]
    def drain(pid,timeout):events.append(('native-drain',pid));target['running']=False;return True
    win=types.ModuleType('hermes_cli.gateway_windows');win._drain_gateway_pid=drain;win._windows_stop_drain_timeout=lambda:30
    win._force_terminate_known_gateway_pids=lambda *a:(_ for _ in ()).throw(AssertionError('force forbidden'))
    sys.modules['hermes_cli.gateway_windows']=win
    status.get_process_start_time=status._get_process_start_time;status._pid_exists=lambda pid:target['running'];status.remove_pid_file=lambda:events.append('remove')
    def accepted():return status._record_matches_live_gateway_pid(record,901,expected_home=active)
    passed=0
    if group=='native':
        assert not original(record,901,expected_home=active),'原matcher正应拒绝opaque wire'
        assert status.get_running_pid(cleanup_stale=False)==901,'旧native原matcher漏精确存活私有wrapper'
        assert cli.find_gateway_pids()==[901]
        assert cli.stop_profile_gateway() and ('native-drain',901) in events
        assert all(record[k]==v for k,v in factory().items())
        passed=5
    elif group=='negative':
        assert accepted(),'正对照失败'
        # 用真实独立物理同bytes文件作foreign负例；合法canonical base不再充当反例。
        foreign_python=base.with_name('foreign-python.exe');foreign_python.write_bytes(base.read_bytes())
        assert foreign_python.is_file() and not foreign_python.is_symlink() and not getattr(foreign_python.lstat(),'st_file_attributes',0)&0x400
        assert not foreign_python.samefile(base) and foreign_python.read_bytes()==base.read_bytes()
        baseline=copy.deepcopy(target);saved=copy.deepcopy(record)
        mutations=[
          ('foreign-argv0',lambda:target['argv'].__setitem__(0,str(foreign_python))),('base',lambda:target.__setitem__('exe',str(venv))),
          ('other-private-base',lambda:target.__setitem__('exe',str(base.parent/'other/python.exe'))),
          ('source',lambda:target['argv'].__setitem__(5,str(home))),('home',lambda:target['argv'].__setitem__(6,str(root))),
          ('pin',lambda:target['argv'].__setitem__(7,'0'*40)),('mode',lambda:target['argv'].__setitem__(8,'--')),
          ('delimiter',lambda:target['argv'].__setitem__(9,'console')),('unknown-wire',lambda:target['argv'].__setitem__(4,wire+'\nprint(1)')),
          ('body',lambda:target['argv'].__setitem__(4,frame(body+b'#foreign'))),('trail',lambda:target['argv'].append('--replace')),
          ('stop',lambda:target['argv'].__setitem__(-1,'stop')),('profile',lambda:target['argv'].extend(['--profile','foreign'])),
          ('duplicate',lambda:target['argv'].extend(['--profile','default','-p','default'])),
          ('foreign-env',lambda:target['env'].__setitem__('HERMES_HOME',str(root))),('unreadable-env',lambda:target.__setitem__('unreadable_env',True)),
          ('birth',lambda:target.__setitem__('birth',birth+0.001)),('fresh-read',lambda:target.__setitem__('reused_late',True)),
          ('proof',lambda:record['clawpanel_legacy_identity'].__setitem__('script_sha256','0'*64)),
          ('foreign-user',lambda:target.__setitem__('user','foreign')),('record-argv',lambda:record['argv'].extend(['--profile','default'])),
        ]
        for label,change in mutations:
            target.clear();target.update(copy.deepcopy(baseline));record.clear();record.update(copy.deepcopy(saved));change()
            assert not accepted(),label;passed+=1
        target.clear();target.update(copy.deepcopy(baseline));record.clear();record.update(copy.deepcopy(saved))
        active=home/'profiles/work';active.mkdir(parents=True);target['env']['HERMES_HOME']=str(active);record['hermes_home']=str(active)
        target['argv'][10:10]=['--profile','work'];assert accepted(),'named profile不应要求改写native record argv'
        target['argv'][4]=frame(body,1);assert accepted(),'不同压缩流同完整body应识别'
        passed+=2
    elif group=='fallback':
        record.pop('clawpanel_legacy_identity',None);target['argv']=['python','-m','hermes_cli.main','gateway','run']
        assert accepted(),'旧native canonical fallback丢失'
        restore();assert status._record_matches_live_gateway_pid is original and status._build_pid_record is factory
        passed=2
    elif group=='source':
        assert module,'缺少独立旧版helper'
        module._verify_legacy_status(status,root)
        saved_defaults=status._record_matches_live_gateway_pid.__kwdefaults__
        status._record_matches_live_gateway_pid.__kwdefaults__={'expected_home': 'foreign'}
        try:module._verify_legacy_status(status,root)
        except SystemExit:pass
        else:raise AssertionError('native函数默认值被替换但仍获准')
        status._record_matches_live_gateway_pid.__kwdefaults__=saved_defaults
        raw=source_file.read_bytes();source_file.write_bytes(raw+b'\n#tampered')
        try:module._verify_legacy_status(status,root)
        except SystemExit:pass
        else:raise AssertionError('fixed source改动未拒绝')
        source_file.write_bytes(raw)
        status._build_pid_record=lambda:{'pid':901}
        try:module._verify_legacy_status(status,root)
        except SystemExit:pass
        else:raise AssertionError('非固定执行代码未拒绝')
        passed=3
    elif group=='layout':
        assert module,'缺少独立旧版helper'
        facts=dict(executable=str(venv),prefix=str(root/'venv'),base_executable=str(base),base_prefix=str(base.parent),platform='win32',os_name='nt',native_machine=0x8664,process_machine=0,bits=64,isolated=1,dont_write_bytecode=True)
        assert module._legacy_runtime_layout(root,home,facts)==(root,home,venv,base)
        try:module.install_legacy_gateway_identity(root,home,wire)
        except SystemExit:pass
        else:raise AssertionError('实际宿主非本fixture私有解释器未拒绝')
        for key,value in [('executable',str(base)),('base_executable',str(venv)),('base_prefix',str(root)),('native_machine',0xaa64),('process_machine',0x8664),('isolated',0)]:
            try:module._legacy_runtime_layout(root,home,{**facts,key:value})
            except SystemExit:pass
            else:raise AssertionError(key)
        passed=7
    elif group=='phases':
        assert module,'缺少R2阶段adapter'
        source=zlib.decompress(base64.b64decode(fixture['cliZlibBase64'])).decode()
        p=root/'hermes_cli/gateway.py';p.parent.mkdir();p.write_text(source,encoding='utf-8')
        cli.__file__=str(p);cli.__loader__=importlib.machinery.SourceFileLoader(cli.__name__,str(p));cli.__spec__=importlib.util.spec_from_loader(cli.__name__,cli.__loader__)
        # 真实固定函数code、原默认值；只有native进程表枚举被隔离为空。
        full=compile(source,str(p),'exec',dont_inherit=True,optimize=sys.flags.optimize)
        codes={c.co_name:c for c in full.co_consts if isinstance(c,types.CodeType)}
        for name in ('_scan_gateway_pids','_capture_gateway_argv'):cli.__dict__[name].__code__=codes[name]
        cli._get_ancestor_pids=lambda:set();cli.get_hermes_home=lambda:active;cli._profile_arg=lambda h:''
        cli._windows_process_listing=lambda:'';cli._iter_windows_list_processes=lambda s:iter(())
        for name in ('profile_flag_value','hermes_home_assignments','command_line_names_hermes_home'):setattr(status,name,lambda *a:None)
        original_looks=status._looks_like_gateway_process
        original_scan,original_capture=cli._scan_gateway_pids,cli._capture_gateway_argv
        facts=types.MappingProxyType(dict(executable=str(venv),prefix=str(root/'venv'),base_executable=str(base),base_prefix=str(base.parent),platform='win32',os_name='nt',native_machine=0x8664,process_machine=0,bits=64,isolated=1,dont_write_bytecode=True,process_executable=str(base),process_id=os.getpid(),process_create_time_filetime_100ns=116444746001250000))
        module.sys=types.SimpleNamespace(executable=str(venv),prefix=str(root/'venv'),_base_executable=str(base),base_prefix=str(base.parent),orig_argv=target['argv'][:],flags=sys.flags,modules=sys.modules)
        os.environ['HERMES_HOME']=str(active)
        context=dict(schema_version=1,version='0.21.5',pin=fixture['pin'],source_root=str(root),owner_home=str(home),effective_home=str(active),phase='status',cli_argv=('-c','gateway','run'),python_orig_argv=tuple(target['argv']),runtime_facts=facts,source_hashes=types.MappingProxyType({'gateway/status.py':fixture['statusSha256'],'hermes_cli/gateway.py':hashlib.sha256(source.encode()).hexdigest()}))
        module._CLAWPANEL_EXECUTED_SCRIPT_BYTES=body
        module._legacy_identity_runtime_facts=lambda:dict(facts)
        install=module.install_windows_private_identity
        try:install(status,cli,types.MappingProxyType({**context,'phase':'gateway'}))
        except SystemExit:pass
        else:raise AssertionError('gateway阶段缺status前置未阻断')
        r1=install(status,None,types.MappingProxyType(context))
        assert status._looks_like_gateway_process is original_looks,'最小桥保留原无record进程谓词'
        caller=901;record=status._build_pid_record();caller=1901
        assert status.get_running_pid(cleanup_stale=False)==901
        wrapped=status._record_matches_live_gateway_pid
        r2=install(status,cli,types.MappingProxyType({**context,'phase':'gateway'}))
        assert status._record_matches_live_gateway_pid is wrapped,'第二阶段重复包status'
        assert cli._scan_gateway_pids is original_scan and cli._capture_gateway_argv is original_capture,'gateway阶段为owned no-op，不谎报scan/capture已适配'
        target['birth']+=0.001
        assert status.get_running_pid(cleanup_stale=False) is None
        target['birth']=birth
        r2();assert cli._scan_gateway_pids is original_scan and cli._capture_gateway_argv is original_capture
        r1();assert status._looks_like_gateway_process is original_looks and status._build_pid_record is factory
        passed=10
    else:
        assert module,'缺少独立旧版helper'
        fn=module.decode_clawpanel_private_script_bytes
        assert fn(wire,fixture['pin'])==body and fn(frame(body,1),fixture['pin'])==body
        for bad in [wire+'\nprint(1)',frame(body,tail=b'tail'),frame(b'A'*131073),wire.replace(fixture['pin'],'0'*40)]:
            try:fn(bad,fixture['pin'])
            except ValueError:pass
            else:raise AssertionError('bad wire')
        passed=6
    print(json.dumps(dict(scope='fixed-old-native-contract-not-Windows-qualification',qualificationPass=False,group=group,passed=passed,events=events)))
