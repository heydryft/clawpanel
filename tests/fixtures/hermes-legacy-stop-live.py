# 自有真实解释器/venv/socket组件验证；不安装Hermes、不执行vendor、不修改宿主配置。
import ast, base64, hashlib, importlib.machinery, importlib.util, json, os
from pathlib import Path
import shlex, shutil, socket, subprocess, sys, tempfile, types, venv, zipfile, zlib
from typing import Any, Optional
if os.environ.get('OWNED_LEGACY_CHILD') == '1':
    # 本组件复用现有psutil，不pip安装；这不是受管Hermes依赖准入。
    sys.path.insert(0, os.environ['OWNED_LEGACY_SITE'])
import psutil

if os.environ.get('OWNED_LEGACY_CHILD') == '1':
    helper, fixture_path = Path(os.environ['OWNED_LEGACY_HELPER']), Path(os.environ['OWNED_LEGACY_FIXTURE'])
else:
    helper, fixture_path = map(Path, sys.argv[1:3])
fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
spec=importlib.util.spec_from_file_location('owned_identity',helper)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def load_status(root,active):
    raw=zlib.decompress(base64.b64decode(fixture['statusZlibBase64'])).decode()
    p=root/'gateway/status.py';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(raw,encoding='utf-8')
    g=types.ModuleType('gateway');g.__path__=[];s=types.ModuleType('gateway.status');g.status=s
    s.__file__=str(p);s.__loader__=importlib.machinery.SourceFileLoader(s.__name__,str(p));s.__spec__=importlib.util.spec_from_loader(s.__name__,s.__loader__)
    s.__dict__.update(Any=Any,Optional=Optional,Path=Path,shlex=shlex,os=os,sys=sys,_GATEWAY_KIND='hermes-gateway')
    nodes=[n for n in ast.parse(raw).body if isinstance(n,ast.FunctionDef) and n.name in fixture['status']['lines']]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(p),'exec'),s.__dict__)
    full=compile(raw,str(p),'exec',dont_inherit=True,optimize=sys.flags.optimize)
    fixed={c.co_name:c for c in full.co_consts if isinstance(c,types.CodeType)}
    for name in fixture['status']['lines']:s.__dict__[name].__code__=fixed[name]
    sys.modules.update({'gateway':g,'gateway.status':s})
    s._get_process_start_time=lambda pid:round(psutil.Process(pid).create_time()*100)
    s._get_process_hermes_home=lambda:active;s._canonical_hermes_home=lambda p:p
    s._read_process_cmdline=lambda pid:' '.join(psutil.Process(pid).cmdline())
    s._host_gateway_serves_home=lambda *a:False;s._command_line_belongs_to_profile=lambda *a:True
    s._get_pid_path=lambda:active/'gateway.pid';s._get_gateway_lock_path=lambda p:active/'gateway.lock'
    s.is_gateway_runtime_lock_active=lambda p:True
    s._live_pid_from_record=lambda r:r['pid'] if psutil.pid_exists(r['pid']) else None
    s._pid_record_belongs_to_current_profile=lambda r:r.get('hermes_home')==str(active)
    s.recorded_gateway_home_conflicts=lambda r,expected_home:r.get('hermes_home')!=str(expected_home)
    s.get_runtime_status_running_pid=lambda:None;s._cleanup_invalid_pid_path=lambda *a,**kw:None
    return s

def frame(body):
    data=base64.b64encode(zlib.compress(body,9)).decode();sha=hashlib.sha256(body).hexdigest()
    return f"""# CLAWPANEL_PRIVATE_SCRIPT_V1 {fixture['pin']} {sha}
import base64 as _cp_b, zlib as _cp_z, hashlib as _cp_h
_cp_d=_cp_z.decompressobj()
_CLAWPANEL_EXECUTED_SCRIPT_BYTES=_cp_d.decompress(_cp_b.b64decode('{data}',validate=True),131073)
if len(_CLAWPANEL_EXECUTED_SCRIPT_BYTES)>131072 or not _cp_d.eof or _cp_d.unused_data or _cp_h.sha256(_CLAWPANEL_EXECUTED_SCRIPT_BYTES).hexdigest()!='{sha}':raise SystemExit('ClawPanel private script integrity failed')
exec(compile(_CLAWPANEL_EXECUTED_SCRIPT_BYTES,'<clawpanel-hermes-private>','exec'))
"""

if os.environ.get('OWNED_LEGACY_CHILD')=='1':
    d=json.loads(sys.stdin.buffer.readline().decode('utf-8'))
    root,home=Path(sys.argv[1]),Path(sys.argv[2])
    name=sys.argv[sys.argv.index('--profile')+1]
    active=home if name=='default' else home/'profiles'/name
    # 复验Windows真实SetEnvironmentVariable后的PEB环境读回，而非仅匹配继承时值。
    os.environ['HERMES_HOME']=str(active)
    m._CLAWPANEL_EXECUTED_SCRIPT_BYTES=globals()['_CLAWPANEL_EXECUTED_SCRIPT_BYTES']
    original=sys.orig_argv[sys.orig_argv.index('-c')+1]
    finder=None;composition=False
    if d.get('entry'):
        spec=importlib.util.spec_from_file_location('owned_carver_entry',d['entry'])
        e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
        constants=types.ModuleType('hermes_constants')
        constants._get_platform_default_hermes_home=constants.get_hermes_home=constants.get_process_hermes_home=lambda:active
        utils=types.ModuleType('utils');utils.atomic_json_write=lambda *a,**kw:None
        sys.modules.update(hermes_constants=constants,utils=utils)
        init=root/'gateway/__init__.py';init.write_text('',encoding='utf-8')
        contract=e._SourceContract(root,{'gateway/__init__.py':hashlib.sha256(b'').hexdigest(),'gateway/status.py':fixture['statusSha256'],'hermes_cli/gateway.py':hashlib.sha256(zlib.decompress(base64.b64decode(fixture['cliZlibBase64']))).hexdigest()})
        facts=e._runtime_facts();e._validate_layout(root,home,fixture['pin'],'console',facts)
        finder=e._PinnedFinder(contract,lambda *a:lambda:None,m.install_windows_private_identity,facts)
        sys.argv=['-c','gateway','run'];sys.path.insert(0,str(root));sys.meta_path.insert(0,finder)
        from gateway import status
        assert finder.status is status
        composition=True
        # gateway阶段无需导入真实重依赖CLI：用固定原函数code的模块核no-op及恢复；不冒充完整CLI加载。
        gp=root/'hermes_cli/gateway.py';g=types.ModuleType('hermes_cli.gateway');g.__file__=str(gp)
        exec(fixture['cli']['source'],g.__dict__)
        scan,capture=g._scan_gateway_pids,g._capture_gateway_argv
        finder._install_identity('gateway',status,g)
        assert g._scan_gateway_pids is scan and g._capture_gateway_argv is capture
    else:
        status=load_status(root,active)
        m._install_legacy_gateway_identity(status,root,home,Path(d['venv']),Path(d['base']),original)
    sys.argv=['-c','gateway','run']
    record=status._build_pid_record();s=socket.socket();s.bind(('127.0.0.1',0));s.listen(1)
    print(json.dumps(dict(record=record,port=s.getsockname()[1],pid=os.getpid(),composition=composition)),flush=True)
    c,_=s.accept()
    with c:
        assert c.recv(4)==b'STOP';c.sendall(b'BYE')
    s.close()
    if finder is not None:
        finder.close();m._verify_legacy_status(status,root)
    raise SystemExit(0)

result=dict(scope='owned-real-venv-redirector-component-not-Hermes-or-VM-qualification',qualificationPass=False,cases=[])
assert os.name=='nt','此opt-in实进程测试针对Windows venv redirector；普通跨平台隔离合同仍独立运行'
with tempfile.TemporaryDirectory(prefix='cp-legacy-real-') as tmp:
    home=Path(tmp).resolve();root=home/'hermes-agent';root.mkdir()
    (root/'.git').mkdir();(root/'.git/HEAD').write_text(fixture['pin']+'\n')
    load_status(root,home)
    (root/'hermes_cli').mkdir();(root/'hermes_cli/gateway.py').write_bytes(zlib.decompress(base64.b64decode(fixture['cliZlibBase64'])))
    store=root/'.hermes-runtime/python/owned-existing-python';store.mkdir(parents=True)
    base=store/'python.exe';shutil.copy2(Path(sys.base_prefix)/'python.exe',base)
    for pattern in ('python*.dll','vcruntime*.dll'):
        for dll in Path(sys.base_prefix).glob(pattern):shutil.copy2(dll,store/dll.name)
    # 本测试复制现有stdlib/DLL到自有base；真实venv redirector自然启动它，不伪造argv0/PEB。
    lib=Path(sys.base_prefix)/'Lib'
    with zipfile.ZipFile(store/f'python{sys.version_info.major}{sys.version_info.minor}.zip','w',compression=zipfile.ZIP_DEFLATED) as archive:
        for src in lib.rglob('*.py'):
            if not any(part in {'site-packages','__pycache__','test','tests','tkinter','idlelib','turtledemo'} for part in src.relative_to(lib).parts):
                archive.write(src,src.relative_to(lib).as_posix())
    shutil.copytree(Path(sys.base_prefix)/'DLLs',store/'DLLs')
    venv.create(root/'venv',with_pip=False,symlinks=False)
    vp=root/'venv/Scripts/python.exe'
    (root/'venv/pyvenv.cfg').write_text('home = '+str(store)+'\ninclude-system-site-packages = false\nexecutable = '+str(base)+'\n')
    script=Path(__file__).read_text(encoding='utf-8')
    # 真实固定V1外层只执行本测试自有源码，不执行任何Hermes/vendor语句。
    wire=frame(script.encode())
    for name in ['default','work']:
        active=home if name=='default' else home/'profiles'/name;active.mkdir(parents=True,exist_ok=True)
        args=[str(vp),'-I','-B','-c',wire,str(root),str(home),fixture['pin'],'console','--','--profile',name,'gateway','run']
        # -c分支从本fixture文件的固定argv恢复helper/fixture参数，不改OS cmdline。
        child_payload={'helper':str(helper),'fixture':str(fixture_path),'venv':str(vp),'base':str(base),'entry':sys.argv[3] if len(sys.argv)>3 else None}
        env={**os.environ,'OWNED_LEGACY_CHILD':'1','HERMES_HOME':str(home),'OWNED_LEGACY_HELPER':str(helper),'OWNED_LEGACY_FIXTURE':str(fixture_path),'OWNED_LEGACY_SITE':str(Path(psutil.__file__).parent.parent)}
        child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',env=env)
        port=None;pid=None;birth=None
        try:
            child.stdin.write(json.dumps(child_payload)+'\n');child.stdin.close()
            line=child.stdout.readline();assert line,child.stderr.read()
            ready=json.loads(line);pid=ready['pid'];port=ready['port'];record=ready['record'];birth=psutil.Process(pid).create_time()
            actual=psutil.Process(pid);assert Path(actual.exe()).resolve()==base.resolve()
            assert Path(actual.cmdline()[0])==vp and vp!=base
            status=load_status(root,active);original=status._record_matches_live_gateway_pid
            assert not original(record,pid,expected_home=active)
            status._read_pid_record=status._read_gateway_lock_record=lambda p:record
            m._CLAWPANEL_EXECUTED_SCRIPT_BYTES=script.encode()
            restore=m._install_legacy_gateway_identity(status,root,home,vp,base,wire)
            assert status.get_running_pid(cleanup_stale=False)==pid
            proof=record['clawpanel_legacy_identity'];saved=proof['create_time'];proof['create_time']+=0.0001
            assert status.get_running_pid(cleanup_stale=False) is None;proof['create_time']=saved
            cli=types.ModuleType('hermes_cli.gateway');cli.__dict__.update(os=os,time=__import__('time'),logger=types.SimpleNamespace(debug=lambda *a:None))
            exec(fixture['cli']['source'],cli.__dict__);cli.is_windows=lambda:True;cli._reap_unsupervised_gateway_orphans=lambda **kw:False
            win=types.ModuleType('hermes_cli.gateway_windows')
            def drain(target,timeout):
                assert target==pid and psutil.Process(pid).create_time()==birth
                with socket.create_connection(('127.0.0.1',port),timeout=2) as c:c.sendall(b'STOP');assert c.recv(3)==b'BYE'
                child.wait(timeout=5);return True
            win._drain_gateway_pid=drain;win._windows_stop_drain_timeout=lambda:30
            win._force_terminate_known_gateway_pids=lambda *a:(_ for _ in ()).throw(AssertionError('force forbidden'))
            sys.modules['hermes_cli.gateway_windows']=win
            status.get_process_start_time=status._get_process_start_time;status._pid_exists=psutil.pid_exists;status.remove_pid_file=lambda:None
            stopped=cli.stop_profile_gateway();assert stopped and child.poll()==0 and not psutil.pid_exists(pid)
            with socket.socket() as s:closed=s.connect_ex(('127.0.0.1',port))!=0
            assert closed;restore()
            result['cases'].append(dict(profile=name,pid=pid,launcherPid=child.pid,createTime=birth,venvArgv0=str(vp),privateBaseExe=str(base),rolesDistinct=True,originalRejected=True,nativeStop=stopped,pidExited=True,portClosed=True,composition=ready['composition'],publicAdmission=ready['composition'],restored=child.returncode==0,gatewayNoop=ready['composition']))
        finally:
            if child.poll() is None:
                if port is not None:
                    with socket.create_connection(('127.0.0.1',port),timeout=2) as c:c.sendall(b'STOP');c.recv(3)
                else:child.terminate()
                child.wait(timeout=5)
print(json.dumps(result))
