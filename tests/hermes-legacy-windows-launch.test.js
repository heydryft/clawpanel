import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = new URL('../scripts/hermes-legacy-windows-launch.py', import.meta.url)

// 只执行自有临时源码/模块；不导入、安装或启动真正的 Hermes。
const driver = String.raw`
import base64, contextlib, hashlib, importlib, importlib.util, io, json, os, pathlib
import subprocess, sys, tempfile, unittest, zlib

entry, output = map(pathlib.Path, sys.argv[1:3])
spec = importlib.util.spec_from_file_location('_cp_legacy_entry', entry)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
receipts = []

class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cp-legacy-entry-')
        self.home = pathlib.Path(self.temp.name).resolve() / 'private' / '.hermes'
        self.root = self.home / 'hermes-agent'
        self.root.mkdir(parents=True)
        (self.home / 'profiles/work').mkdir(parents=True)
        self.addCleanup(self.temp.cleanup)
        self.old_env = dict(os.environ)
        self.old_path = sys.path[:]
        self.old_argv = sys.argv[:]
        self.old_meta = sys.meta_path[:]
        self.old_modules = {k:v for k,v in sys.modules.items() if k == 'gateway' or k.startswith(('gateway.', 'hermes_cli', 'hermes_bootstrap'))}
        for k in self.old_modules: del sys.modules[k]
        self.addCleanup(self.restore)
        self.events = []
        self.identity_events = []
        self.identity_contexts = []
        self.write('hermes_cli/__init__.py', "__version__='0.21.5'\n")
        self.write('hermes_cli/main.py', '''import os,sys,json
def emit(value):
    with open(os.environ['CP_EVENTS'],'a',encoding='utf-8') as f: f.write(json.dumps(value)+'\\n')
if '--profile' in sys.argv:
    i=sys.argv.index('--profile');name=sys.argv[i+1]
    os.environ['HERMES_HOME']=os.path.join(os.environ['HERMES_HOME'],'profiles',name)
    sys.argv=sys.argv[:i]+sys.argv[i+2:]
emit(['profile',os.environ['HERMES_HOME'],sys.argv[1:]])
def main():
    emit(['main',sys.argv[0],sys.argv[1:]])
    if '--help' in sys.argv: return 7
    if 'status-only' in sys.argv:
        import gateway.status as status
        emit(['status-only',status._record_matches_live_gateway_pid({'native':True},os.getpid())])
        return 17
    from hermes_cli import gateway
    emit(['guards',gateway.service_guard(),gateway.foreign_guard(),gateway.boot_guard(),gateway.identity_guard()])
    return gateway.run()
''')
        self.write('hermes_cli/_subprocess_compat.py', '''def bounded_probe_run(argv, *, timeout, errors='replace', env=None, cwd=None, raise_on_spawn_failure=False):
    return 'original-probe'
def windows_hide_flags(): return 0
def kill_process_tree(proc): pass
def _close_job(job): pass
''')
        self.write('hermes_cli/local_runtime/__init__.py', '')
        self.write('hermes_cli/local_runtime/processes.py', 'def spawn_server(cmd, **kwargs): return cmd,kwargs\n')
        self.write('gateway/__init__.py','')
        self.write('gateway/status.py', '''import os,sys
from hermes_cli.main import emit
emit(['status-exec',os.environ['HERMES_HOME']])
finished=True
def _build_pid_record(): return {'pid':os.getpid(),'argv':list(sys.argv),'native':True}
def _record_matches_live_gateway_pid(record,pid,*,expected_home=None): return record.get('native') is True
def _looks_like_gateway_process(pid): return False
''')
        self.write('hermes_cli/gateway.py', '''import os,sys
from hermes_cli.main import emit
import gateway.status as status
emit(['gateway-exec',os.environ['HERMES_HOME']])
original_record=status._build_pid_record()
finished=True
def _windows_process_listing(): return 'ProcessId=123\\nCommandLine=fixture\\n'
def _scan_gateway_pids(exclude_pids,all_profiles=False,include_restart_managers=False): return []
def _capture_gateway_argv(pid): return list(sys.orig_argv) if pid==os.getpid() else None
def service_guard(): return 'service-retained'
def foreign_guard(): return 'foreign-retained'
def boot_guard(): return 'boot-retained'
def identity_guard(): return 'identity-retained'
def run():
    emit(['run',_windows_process_listing()])
    return 19
''')
        (self.root / '.git').mkdir()
        self.write('.git/HEAD', m.LEGACY_PIN+'\n')
        (self.root / 'venv/Scripts').mkdir(parents=True)
        self.write('venv/Scripts/python.exe', 'owned-fixture-not-executable')
        (self.root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none').mkdir(parents=True)
        self.base = self.root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none'
        self.write(str((self.base/'python.exe').relative_to(self.root)), 'owned-fixture-not-executable')
        self.write('venv/pyvenv.cfg', 'home = '+str(self.base)+'\ninclude-system-site-packages = false\n')
        os.environ['HERMES_HOME'] = str(self.home)
        os.environ['CP_EVENTS'] = str(pathlib.Path(self.temp.name)/'events.jsonl')
        self.facts = {'platform':'win32', 'os_name':'nt', 'native_machine':0x8664,
            'process_machine':0, 'bits':64, 'isolated':1, 'dont_write_bytecode':1,
            'executable':str(self.root/'venv/Scripts/python.exe'), 'prefix':str(self.root/'venv'),
            'base_executable':str(self.base/'python.exe'), 'base_prefix':str(self.base),
            'process_executable':str(self.base/'python.exe'),'process_id':os.getpid(),
            'process_create_time_filetime_100ns':133700000000000000}

    def restore(self):
        sys.path[:] = self.old_path
        sys.argv[:] = self.old_argv
        sys.meta_path[:] = self.old_meta
        for k in list(sys.modules):
            if k == 'gateway' or k.startswith(('gateway.', 'hermes_cli', 'hermes_bootstrap')): del sys.modules[k]
        sys.modules.update(self.old_modules)
        os.environ.clear(); os.environ.update(self.old_env)

    def write(self, rel, text):
        p=self.root/rel; p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(text.encode('utf-8'));return p

    def hashes(self):
        return {p.relative_to(self.root).as_posix():hashlib.sha256(p.read_bytes().replace(b'\r\n',b'\n')).hexdigest()
            for directory in ['hermes_cli','gateway'] for p in (self.root/directory).rglob('*.py')}

    def contract(self): return m._SourceContract(self.root,self.hashes())

    def installer(self,gateway,compat,spawn_server):
        self.assertTrue(gateway.finished)
        self.assertEqual(os.environ['HERMES_HOME'],str(self.home/'profiles/work'))
        self.assertEqual(compat.bounded_probe_run([],timeout=1),'original-probe')
        self.assertEqual(spawn_server(['owned'])[0],['owned'])
        self.events.append('installed')
        original=gateway._windows_process_listing
        def patched(): return 'owned-patched-inventory'
        gateway._windows_process_listing=patched
        def restore():
            gateway._windows_process_listing=original
            self.events.append('restored')
        return restore

    def identity_installer(self,status,gateway,context):
        phase=context['phase'];self.assertTrue(status.finished)
        self.assertEqual(context['source_root'],str(self.root))
        self.assertEqual(context['effective_home'],os.environ['HERMES_HOME'])
        self.assertEqual(context['runtime_facts']['process_executable'],str(self.base/'python.exe'))
        self.assertNotEqual(context['runtime_facts']['process_executable'],context['runtime_facts']['executable'])
        self.assertEqual(context['cli_argv'][0],self.old_argv[0])
        self.assertEqual(context['python_orig_argv'],tuple(sys.orig_argv))
        with self.assertRaises(TypeError):context['phase']='spoof'
        with self.assertRaises(TypeError):context['runtime_facts']['process_id']=0
        self.identity_contexts.append(context)
        if phase=='status':
            self.assertIsNone(gateway)
            slots=['_build_pid_record','_record_matches_live_gateway_pid','_looks_like_gateway_process']
            module=status
        else:
            self.assertEqual(phase,'gateway');self.assertTrue(gateway.finished)
            slots=['_scan_gateway_pids','_capture_gateway_argv'];module=gateway
        originals={name:getattr(module,name) for name in slots}
        def wrap(original):
            def delegate(*args,**kwargs):return original(*args,**kwargs)
            return delegate
        for name,original in originals.items():setattr(module,name,wrap(original))
        self.identity_events.append(phase+'-installed')
        def restore():
            for name,value in originals.items():setattr(module,name,value)
            self.identity_events.append(phase+'-restored')
        return restore

    def run_console(self, args=None, install=None, identity=None):
        return m._run_console(self.contract(), ['--profile','work','gateway','run'] if args is None else args,
            self.installer if install is None else install,
            identity_installer=self.identity_installer if identity is None else identity,runtime_facts=self.facts)

    def test_console_e2e_profile_before_import_and_exit_restore(self):
        before={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        meta=sys.meta_path[:];argv=sys.argv[:];search=sys.path[:]
        rc=self.run_console()
        actual=[json.loads(x) for x in pathlib.Path(os.environ['CP_EVENTS']).read_text(encoding='utf-8').splitlines()]
        self.assertEqual(rc,19);self.assertEqual(self.events,['installed','restored'])
        self.assertEqual([x[0] for x in actual],['profile','main','status-exec','gateway-exec','guards','run'])
        self.assertEqual(actual[0][1],str(self.home/'profiles/work'))
        self.assertEqual(actual[1][1],self.old_argv[0])
        self.assertNotEqual(actual[1][1],str(self.root/'venv/Scripts/hermes'))
        self.assertEqual(actual[-2][1:],['service-retained','foreign-retained','boot-retained','identity-retained'])
        self.assertEqual(actual[-1][1],'owned-patched-inventory')
        self.assertEqual(sys.meta_path,meta);self.assertEqual(sys.argv,argv);self.assertEqual(sys.path,search)
        g=sys.modules['hermes_cli.gateway'];self.assertIn('ProcessId=123',g._windows_process_listing())
        self.assertIs(g.__loader__,g.__spec__.loader)
        self.assertIn('service_guard',g.__loader__.get_source(g.__name__))
        self.assertEqual(self.identity_events,['status-installed','gateway-installed','gateway-restored','status-restored'])
        status=sys.modules['gateway.status']
        self.assertEqual(g.original_record['argv'][0],self.old_argv[0])
        self.assertEqual(set(g.original_record),{'pid','argv','native'})
        self.assertEqual(status._build_pid_record.__module__,'gateway.status')
        self.assertEqual(status._record_matches_live_gateway_pid.__module__,'gateway.status')
        self.assertEqual(status._looks_like_gateway_process.__module__,'gateway.status')
        self.assertEqual(g._scan_gateway_pids.__module__,'hermes_cli.gateway')
        self.assertEqual(g._capture_gateway_argv.__module__,'hermes_cli.gateway')
        after={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before,after)
        receipts.append({'case':'owned-console-profile-e2e','expectedExit':19,'actualExit':rc,
            'events':actual,'adapter':self.events,'sourceAndGitUnchanged':before==after,
            'metaPathRestored':sys.meta_path==meta,'scope':'fixture-not-Hermes-VM'})

    def test_help_no_eager_gateway_or_installer(self):
        self.assertEqual(self.run_console(['--help']),7)
        self.assertNotIn('hermes_cli.gateway',sys.modules);self.assertEqual(self.events,[])
        self.assertEqual(self.identity_events,[])

    def test_status_only_uses_original_loader_then_identity_without_cli_import(self):
        self.assertEqual(self.run_console(['--profile','work','status-only']),17)
        self.assertNotIn('hermes_cli.gateway',sys.modules)
        self.assertEqual(self.identity_events,['status-installed','status-restored'])
        self.assertTrue(sys.modules['gateway.status']._record_matches_live_gateway_pid({'native':True},os.getpid()))
        self.assertFalse(sys.modules['gateway.status']._record_matches_live_gateway_pid({'native':False},os.getpid()))

    def test_status_loader_error_keeps_original_exception(self):
        self.write('gateway/status.py',"raise LookupError('original-status-loader-failed')\n")
        with self.assertRaisesRegex(LookupError,'original-status-loader-failed'):self.run_console()
        self.assertEqual(self.identity_events,[]);self.assertEqual(self.events,[])

    def test_wrong_status_origin_rejected_before_exec(self):
        wrong=self.write('outside.py',"raise RuntimeError('must-not-exec')\n")
        class Hijack:
            def find_spec(self,name,path=None,target=None):
                if name=='gateway.status':return importlib.util.spec_from_file_location(name,wrong)
        sys.meta_path.insert(0,Hijack())
        with self.assertRaisesRegex(SystemExit,'origin'):self.run_console()
        self.assertEqual(self.identity_events,[])

    def test_status_signature_change_rejected_before_identity_installer(self):
        p=self.root/'gateway/status.py';self.write('gateway/status.py',p.read_text().replace('expected_home=None','expected_home=None, permissive=True'))
        with self.assertRaisesRegex(SystemExit,'interface'):self.run_console()
        self.assertEqual(self.identity_events,[])

    def test_identity_partial_status_failure_restores_factory_checker(self):
        captured=[]
        def broken(s,g,c):
            captured.append(s);s._build_pid_record=lambda:{'fake':True}
            s._record_matches_live_gateway_pid=lambda *a,**k:True
            raise LookupError('identity-install-failed')
        with self.assertRaisesRegex(LookupError,'identity-install-failed'):self.run_console(identity=broken)
        self.assertEqual(captured[0]._build_pid_record.__module__,'gateway.status')
        self.assertEqual(captured[0]._record_matches_live_gateway_pid.__module__,'gateway.status')
        self.assertEqual(self.events,[]);self.assertEqual(sys.meta_path,self.old_meta)

    def test_identity_gateway_failure_restores_prior_status_phase(self):
        captured=[]
        def broken(s,g,c):
            if c['phase']=='status':return self.identity_installer(s,g,c)
            captured.append(g);g._scan_gateway_pids=lambda *a,**k:[999]
            raise LookupError('identity-gateway-failed')
        with self.assertRaisesRegex(LookupError,'identity-gateway-failed'):self.run_console(identity=broken)
        self.assertEqual(captured[0]._scan_gateway_pids.__module__,'hermes_cli.gateway')
        self.assertEqual(sys.modules['gateway.status']._build_pid_record.__module__,'gateway.status')
        self.assertEqual(self.identity_events,['status-installed','status-restored'])

    def test_identity_gateway_phase_cannot_rewrap_status_slots(self):
        def wrong(s,g,c):
            restore=self.identity_installer(s,g,c)
            if c['phase']=='gateway':s._build_pid_record=lambda:{'fake':True}
            return restore
        with self.assertRaisesRegex(SystemExit,'phase'):self.run_console(identity=wrong)
        self.assertEqual(sys.modules['gateway.status']._build_pid_record.__module__,'gateway.status')

    def test_identity_installer_restore_required(self):
        with self.assertRaisesRegex(SystemExit,'restore'):self.run_console(identity=lambda s,g,c:None)

    def test_identity_foreign_subsequent_owner_not_clobbered(self):
        foreign=lambda:{'later-owner':True}
        def install(s,g,c):
            restore=self.identity_installer(s,g,c)
            if g is not None:
                def run():s._build_pid_record=foreign;return 41
                g.run=run
            return restore
        self.assertEqual(self.run_console(identity=install),41)
        self.assertIs(sys.modules['gateway.status']._build_pid_record,foreign)
        self.assertEqual(sys.modules['gateway.status']._record_matches_live_gateway_pid.__module__,'gateway.status')

    def test_missing_identity_callback_fails_before_main(self):
        with self.assertRaisesRegex(SystemExit,'identity'):
            m._run_console(self.contract(),[],self.installer,identity_installer=None,runtime_facts=self.facts)
        self.assertNotIn('hermes_cli.main',sys.modules)

    def test_original_profile_resolves_foreign_home_rejected_before_gateway_exec(self):
        p=self.root/'hermes_cli/main.py'
        self.write('hermes_cli/main.py',p.read_text().replace("os.path.join(os.environ['HERMES_HOME'],'profiles',name)",
            repr(str(pathlib.Path(self.temp.name)))))
        with self.assertRaisesRegex(SystemExit,'HOME'):self.run_console()
        values=[json.loads(x) for x in pathlib.Path(os.environ['CP_EVENTS']).read_text(encoding='utf-8').splitlines()]
        self.assertNotIn('gateway-exec',[x[0] for x in values]);self.assertEqual(self.events,[])

    def test_original_main_system_exit_preserved(self):
        self.write('hermes_cli/main.py','def main(): raise SystemExit(23)\n')
        with self.assertRaises(SystemExit) as e:self.run_console([])
        self.assertEqual(e.exception.code,23)

    def test_original_loader_exception_preserved_and_no_install(self):
        self.write('hermes_cli/gateway.py',"raise LookupError('owned-loader-failure')\n")
        with self.assertRaisesRegex(LookupError,'owned-loader-failure'):self.run_console()
        self.assertEqual(self.events,[]);self.assertEqual(sys.meta_path,self.old_meta)

    def test_finder_exception_preserved(self):
        sentinel=OSError('finder exact failure')
        class Finder:
            def find_spec(self,name,path=None,target=None):
                if name=='hermes_cli.gateway':raise sentinel
        sys.meta_path.insert(0,Finder())
        with self.assertRaises(OSError) as e:self.run_console()
        self.assertIs(e.exception,sentinel)

    def test_original_finder_order_and_other_modules(self):
        seen=[]
        class Observer:
            def __init__(self,label):self.label=label
            def find_spec(self,name,path=None,target=None):
                if name in ('hermes_cli.gateway','hermes_cli.local_runtime.processes'):seen.append((self.label,name))
        sys.meta_path[:0]=[Observer('a'),Observer('b')]
        self.assertEqual(self.run_console(),19)
        for name in ('hermes_cli.gateway','hermes_cli.local_runtime.processes'):
            self.assertEqual([label for label,n in seen if n==name],['a','b'])

    def test_wrong_gateway_origin_rejected_before_exec(self):
        wrong=self.write('outside.py',"raise RuntimeError('must-not-exec')\n")
        class Hijack:
            def find_spec(self,name,path=None,target=None):
                if name=='hermes_cli.gateway':return importlib.util.spec_from_file_location(name,wrong)
        sys.meta_path.insert(0,Hijack())
        with self.assertRaisesRegex(SystemExit,'origin'):self.run_console()
        self.assertEqual(self.events,[])

    def test_unknown_loader_rejected_even_with_expected_origin(self):
        class Loader:
            def create_module(self,spec): return None
            def exec_module(self,module):raise RuntimeError('must-not-exec')
        class Hijack:
            def find_spec(self,name,path=None,target=None):
                if name=='hermes_cli.gateway':return importlib.util.spec_from_loader(name,Loader(),origin=str(self_root/'hermes_cli/gateway.py'))
        self_root=self.root;sys.meta_path.insert(0,Hijack())
        with self.assertRaisesRegex(SystemExit,'loader'):self.run_console()

    def test_wrong_main_origin_rejected(self):
        wrong=self.write('outside.py',"raise RuntimeError('must-not-exec')\n")
        class Hijack:
            def find_spec(self,name,path=None,target=None):
                if name=='hermes_cli.main':return importlib.util.spec_from_file_location(name,wrong)
        sys.meta_path.insert(0,Hijack())
        with self.assertRaisesRegex(SystemExit,'origin'):self.run_console()

    def test_critical_source_changed_after_admission(self):
        contract=self.contract();self.write('hermes_cli/gateway.py',"raise RuntimeError('must-not-exec')\n")
        with self.assertRaisesRegex(SystemExit,'hash'):m._run_console(contract,[],self.installer,identity_installer=self.identity_installer,runtime_facts=self.facts)

    def test_crlf_is_verified_without_rewriting_source(self):
        contract=self.contract();p=self.root/'hermes_cli/gateway.py';p.write_bytes(p.read_bytes().replace(b'\n',b'\r\n'))
        m._run_console(contract,['--help'],self.installer,identity_installer=self.identity_installer,runtime_facts=self.facts)
        self.assertIn(b'\r\n',p.read_bytes())

    def test_sourceless_or_forged_pyc_not_used(self):
        import importlib._bootstrap_external as be
        source=self.root/'hermes_cli/gateway.py';raw=source.read_bytes();stat=source.stat()
        code=compile("raise RuntimeError('forged-bytecode-must-not-run')",str(source),'exec')
        pyc=pathlib.Path(importlib.util.cache_from_source(str(source)));pyc.parent.mkdir(parents=True,exist_ok=True)
        pyc.write_bytes(be._code_to_timestamp_pyc(code,int(stat.st_mtime),len(raw)))
        with self.assertRaisesRegex(SystemExit,'bytecode'):self.run_console()

    def test_preloaded_module_rejected(self):
        import types
        for name in ['hermes_cli','hermes_cli.main','hermes_cli.gateway','gateway.status','hermes_bootstrap']:
            sys.modules[name]=types.ModuleType(name)
            with self.assertRaisesRegex(SystemExit,'preloaded'):self.run_console([])
            del sys.modules[name]

    def test_installer_exception_preserved_and_own_edits_restored(self):
        captured=[]
        def broken(g,c,s):
            captured.append(g)
            g._windows_process_listing=lambda:None
            raise ValueError('adapter-failed')
        with self.assertRaisesRegex(ValueError,'adapter-failed'):self.run_console(install=broken)
        # 原 importlib 在 exec_module 失败时删除失败模块；保持这个行为，不伪造已加载记录。
        self.assertNotIn('hermes_cli.gateway',sys.modules)
        self.assertIn('ProcessId=123',captured[0]._windows_process_listing())
        self.assertEqual(sys.meta_path,self.old_meta)

    def test_installer_must_return_restore(self):
        with self.assertRaisesRegex(SystemExit,'restore'):self.run_console(install=lambda g,c,s:None)

    def test_real_cim_helper_unknown_listing_failclosed(self):
        p=self.root/'hermes_cli/gateway.py';self.write('hermes_cli/gateway.py',p.read_text().replace("return 'ProcessId=123\\nCommandLine=fixture\\n'",'return None'))
        ns={};helper=entry.with_name('hermes-windows-cim-probe.py')
        exec(compile(helper.read_bytes(),str(helper),'exec'),ns)
        calls=[]
        def unknown_spawn(argv,**kwargs):
            calls.append(argv)
            raise OSError('owned COM inventory unavailable')
        def install(g,c,s):return ns['install_windows_cim_probe'](g,c,unknown_spawn,platform='nt')
        from unittest.mock import patch
        # getter已窄接WMIC/COM；不依赖测试宿主有没有WMIC，实际COM未知仍须中止原console。
        with patch('shutil.which',return_value=None),self.assertRaisesRegex(SystemExit,'inventory unavailable'):
            self.run_console(install=install)
        self.assertEqual(len(calls),1)
        self.assertEqual(calls[0][1:4],['-I','-B','-c'])
        self.assertIsNone(sys.modules['hermes_cli.gateway']._windows_process_listing())

    def test_do_not_clobber_subsequent_loader_or_finder(self):
        late=object();foreign=lambda:'later-owner'
        def install(g,c,s):
            original=g._windows_process_listing
            g._windows_process_listing=lambda:'ours'
            def restore():g._windows_process_listing=original
            # 在 main/run 结束前模拟另一模块接管；入口只撤自己的补丁。
            def run():
                g._windows_process_listing=foreign;sys.meta_path.append(late);return 31
            g.run=run
            return restore
        self.assertEqual(self.run_console(install=install),31)
        self.assertIs(sys.modules['hermes_cli.gateway']._windows_process_listing,foreign)
        self.assertIn(late,sys.meta_path)

    def test_subprocess_signature_change_failclosed_before_install(self):
        p=self.root/'hermes_cli/_subprocess_compat.py';self.write('hermes_cli/_subprocess_compat.py',p.read_text().replace('raise_on_spawn_failure=False','raise_on_spawn_failure=False, extra=None'))
        with self.assertRaisesRegex(SystemExit,'interface'):self.run_console()
        self.assertEqual(self.events,[])

    def test_layout_fixture_admission_and_no_environment_mutation(self):
        before=dict(os.environ)
        got=m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)
        self.assertEqual(got,self.root);self.assertEqual(dict(os.environ),before)

    def test_layout_native_platform_and_managed_interpreter_failures(self):
        changes=[('platform','linux'),('os_name','posix'),('native_machine',0xaa64),('process_machine',0x8664),
            ('bits',32),('isolated',0),('dont_write_bytecode',0),('executable',sys.executable),
            ('prefix',str(self.home)),('base_executable',sys.executable),('base_prefix',str(self.home))]
        for key,value in changes:
            with self.subTest(key=key), self.assertRaises(SystemExit):
                m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',{**self.facts,key:value})

    def test_actual_process_image_and_creation_date_roles_failclosed(self):
        changes=[('process_executable',str(self.root/'venv/Scripts/python.exe')),
            ('process_executable',sys.executable),('process_id',0),('process_id',os.getpid()+100000),
            ('process_create_time_filetime_100ns',None),('process_create_time_filetime_100ns',True),
            ('process_create_time_filetime_100ns',0),('process_create_time_filetime_100ns',float('nan'))]
        for key,value in changes:
            with self.subTest(key=key,value=value),self.assertRaises(SystemExit):
                m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',{**self.facts,key:value})

    def test_native_self_process_snapshot_is_real_and_separate_from_logical_executable(self):
        if os.name!='nt':
            with self.assertRaises(SystemExit):m._runtime_facts()
            return
        facts=m._runtime_facts()
        self.assertEqual(facts['process_id'],os.getpid())
        self.assertGreater(facts['process_create_time_filetime_100ns'],116444736000000000)
        self.assertTrue(pathlib.Path(facts['process_executable']).is_file())
        self.assertIn('executable',facts);self.assertIn('base_executable',facts)
        receipts.append({'case':'actual-native-self-image-and-creation-readonly','pid':facts['process_id'],
            'nativeImage':facts['process_executable'],'logicalExecutable':facts['executable'],
            'creationFiletime100ns':facts['process_create_time_filetime_100ns'],'scope':'host-self-only-not-managed-Hermes'})

    def test_layout_pin_mode_branch_and_system_site_denied(self):
        for pin,mode in [('bad','console'),(m.LEGACY_PIN,'eval')]:
            with self.assertRaises(SystemExit):m._validate_layout(self.root,self.home,pin,mode,self.facts)
        self.write('.git/HEAD','ref: refs/heads/main\n')
        with self.assertRaisesRegex(SystemExit,'detached'):m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)
        self.write('.git/HEAD',m.LEGACY_PIN+'\n')
        self.write('venv/pyvenv.cfg','home = '+str(self.base)+'\ninclude-system-site-packages = true\n')
        with self.assertRaisesRegex(SystemExit,'site'):m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)

    def test_layout_foreign_home_and_root_denied(self):
        os.environ['HERMES_HOME']=str(pathlib.Path(self.temp.name))
        with self.assertRaisesRegex(SystemExit,'HOME'):m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)
        os.environ['HERMES_HOME']=str(self.home)
        with self.assertRaisesRegex(SystemExit,'root'):m._validate_layout(self.root,self.home.parent,m.LEGACY_PIN,'console',self.facts)

    def test_private_existing_profile_is_not_rewritten(self):
        profile=self.home/'profiles/work';profile.mkdir(parents=True,exist_ok=True);os.environ['HERMES_HOME']=str(profile)
        m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)
        self.assertEqual(os.environ['HERMES_HOME'],str(profile))

    def test_paths_reject_relative_network_ads_and_parent_escape(self):
        for p in ['relative','../escape',r'\\server\share\x',r'\\?\C:\x',str(self.root)+':evil']:
            with self.subTest(p=p),self.assertRaises(SystemExit):m._physical(p)

    def test_physical_path_rejects_owned_junction_or_symlink(self):
        link=pathlib.Path(self.temp.name)/'link'
        if os.name=='nt':
            import ctypes
            # 自有 NTFS junction 不需要管理员；不执行任何系统安装。
            r=subprocess.run([os.environ.get('ComSpec','cmd.exe'),'/d','/c','mklink','/J',str(link),str(self.home)],capture_output=True,timeout=5)
            self.assertEqual(r.returncode,0,r.stderr)
            self.addCleanup(lambda:os.rmdir(link) if os.path.lexists(link) else None)
        else:link.symlink_to(self.home,target_is_directory=True)
        with self.assertRaisesRegex(SystemExit,'reparse|link'):m._physical(link/'hermes-agent')

    def test_cli_parser_strict_delimiter_and_original_args(self):
        values=[str(self.root),str(self.home),m.LEGACY_PIN,'console','--','--profile','a b','gateway','run']
        got=m._parse_args(values)
        self.assertEqual(got[-1],values[5:])
        for bad in [values[:4],values[:4]+['no-delimiter'],values[:5]+['bad\0arg']]:
            with self.assertRaises(SystemExit):m._parse_args(bad)

    def test_production_cli_rejects_actual_host_before_any_hermes_import(self):
        # 保留真实-c入口；测试自身也不能把扩大的未压缩源码塞爆Windows命令行。
        raw=entry.read_bytes();encoded=base64.b64encode(zlib.compress(raw,9)).decode('ascii')
        payload="import base64,zlib,hashlib;d=zlib.decompress(base64.b64decode('"+encoded+"'));assert hashlib.sha256(d).hexdigest()=='"+hashlib.sha256(raw).hexdigest()+"';exec(compile(d,'<owned-legacy-entry>','exec'))"
        command=[sys.executable,'-I','-B','-c',payload,str(self.root),str(self.home),m.LEGACY_PIN,'console','--','--help']
        self.assertLessEqual(len(subprocess.list2cmdline(command).encode('utf-16-le'))//2+1,32767)
        p=subprocess.run(command,
            capture_output=True,text=True,timeout=10,env=dict(os.environ))
        self.assertNotEqual(p.returncode,0)
        self.assertFalse(pathlib.Path(os.environ['CP_EVENTS']).exists())
        receipts.append({'case':'real-host-unmanaged-production-rejected','exit':p.returncode,
            'stderr':p.stderr[-800:],'hermesImported':False})

suite=unittest.defaultTestLoader.loadTestsFromTestCase(LaunchTests)
result=unittest.TextTestRunner(verbosity=2).run(suite)
report={'schemaVersion':1,'scope':'owned-fixture-only-not-VM-qualification','entrySha256':hashlib.sha256(entry.read_bytes()).hexdigest(),
    'python':sys.version,'isolated':sys.flags.isolated,'testsRun':result.testsRun,'failures':len(result.failures),
    'errors':len(result.errors),'skips':len(result.skipped),'receipts':receipts}
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
raise SystemExit(not result.wasSuccessful())
`

test('legacy Windows console entry: owned subprocess/module E2E and failclosed boundaries', () => {
  assert.ok(fs.existsSync(entry), '缺少固定旧版受管入口，原 console 还没有精确 Gateway hook')
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-legacy-launch-suite-')))
  // 允许调用者保存完整产物；默认只保留自有临时目录，不触及 HOME/source 或其他运行时。
  const reportPath = process.env.CLAWPANEL_LEGACY_LAUNCH_REPORT || path.join(root, 'report.json')
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const r = spawnSync(python, ['-I', '-B', '-c', driver, fileURLToPath(entry), reportPath], {
    encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024,
  })
  assert.equal(r.error, undefined, r.error?.stack)
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}\nreport=${reportPath}`)
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.equal(report.testsRun, 40)
  assert.equal(report.failures, 0); assert.equal(report.errors, 0); assert.equal(report.skips, 0)
  assert.equal(report.receipts.find(x => x.case === 'owned-console-profile-e2e')?.sourceAndGitUnchanged, true)
})
