# 先失败合同及真实自有junction组件；不运行Hermes或下载/安装Python。
import contextlib, hashlib, importlib.util, io, json, os
from pathlib import Path
import stat, subprocess, sys, tempfile, types, unittest
from unittest.mock import patch

entry, output = sys.argv[1:3]
spec = importlib.util.spec_from_file_location('owned_legacy_alias', entry)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
receipts = []


class Alias(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cp-owned-uv-alias-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()/'.hermes'; self.root = self.home/'hermes-agent'
        self.store = self.root/'.hermes-runtime/python'
        self.alias = self.store/'cpython-3.11-windows-x86_64-none'
        self.target = self.store/'cpython-3.11.17-windows-x86_64-none'
        self.target.mkdir(parents=True)
        self.exe = self.target/'python.exe'; self.exe.write_bytes(b'owned binary canary; never executed')
        (self.root/'venv/Scripts').mkdir(parents=True)
        (self.root/'venv/Scripts/python.exe').write_bytes(b'owned venv canary')
        (self.root/'venv/pyvenv.cfg').write_text('home = '+str(self.alias)+'\ninclude-system-site-packages = false\n')
        (self.root/'.git').mkdir(); (self.root/'.git/HEAD').write_text(m.LEGACY_PIN+'\n')
        # 只在此测试进程替换固定源合同；产品没有路径/hash覆盖参数。
        self.hashes = {}
        for rel in m.SOURCE_HASHES:
            f=self.root/rel; f.parent.mkdir(parents=True,exist_ok=True); f.write_bytes(b'# owned source not imported\n')
            self.hashes[rel]=hashlib.sha256(f.read_bytes()).hexdigest()
        env=patch.dict(os.environ,{'HERMES_HOME':str(self.home),'CLAWPANEL_HERMES_PHASE_TIMING':'0'})
        env.start();self.addCleanup(env.stop)
        hashes=patch.object(m,'SOURCE_HASHES',self.hashes);hashes.start();self.addCleanup(hashes.stop)
        self.facts=dict(platform='win32',os_name='nt',native_machine=0x8664,process_machine=0,bits=64,
            isolated=1,dont_write_bytecode=True,executable=str(self.root/'venv/Scripts/python.exe'),
            prefix=str(self.root/'venv'),base_executable=str(self.alias/'python.exe'),base_prefix=str(self.alias),
            process_executable=str(self.exe),process_id=os.getpid(),process_create_time_filetime_100ns=133700000000000000)
        if os.name=='nt':
            # 此处两端均为刚创建的自有目录；没有宿主安装/全局设置。
            assert self.alias.parent.resolve()==self.store.resolve() and self.target.resolve().is_relative_to(Path(self.temp.name).resolve())
            r=subprocess.run([os.environ.get('ComSpec','cmd.exe'),'/d','/c','mklink','/J',str(self.alias),str(self.target)],
                capture_output=True,timeout=5,creationflags=0x08000000)
            self.assertEqual(r.returncode,0,r.stderr)
            self.addCleanup(lambda:os.rmdir(self.alias) if os.path.lexists(self.alias) else None)
        else:
            # 非Windows只模拟精确junction的lstat/readlink元数据，不声称原生通过。
            self.alias.symlink_to(self.target,target_is_directory=True)
            original=Path.lstat
            def lstat(p):
                info=original(p)
                return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_file_attributes=1040,
                    st_reparse_tag=0xa0000003,st_dev=info.st_dev,st_ino=info.st_ino,st_mtime_ns=info.st_mtime_ns) if p==self.alias else info
            patcher=patch.object(Path,'lstat',lstat);patcher.start();self.addCleanup(patcher.stop)

    def resolve(self, value=None, facts=None, fresh=None):
        with patch.object(m,'_runtime_facts',return_value=dict(self.facts) if fresh is None else fresh), \
                patch.object(sys,'version_info',(3,11,17)):
            return m._legacy_managed_base_physical(self.alias/'python.exe' if value is None else value,
                self.root,self.facts if facts is None else facts,slot='facts.base-executable')

    def rejected(self, **kwargs):
        with self.assertRaises(SystemExit): self.resolve(**kwargs)

    def test_00_real_owned_junction_resolves_only_exact_binary_without_mutation(self):
        before=dict(os.environ);facts=dict(self.facts);raw=self.exe.read_bytes()
        self.assertEqual(self.resolve(),self.exe)
        self.assertEqual(self.resolve(self.alias),self.target)
        self.assertEqual(self.facts,facts);self.assertEqual(dict(os.environ),before);self.assertEqual(self.exe.read_bytes(),raw)
        with self.assertRaisesRegex(SystemExit,'link/reparse'):m._physical(self.alias/'python.exe')
        receipts.append(dict(case='own-junction-component-not-VM',nativeJunction=os.name=='nt',
            rawFactsUnchanged=self.facts==facts,targetSha256=hashlib.sha256(raw).hexdigest(),qualificationPass=False))

    def test_wrong_source_hash_is_rejected(self):
        (self.root/'hermes_cli/main.py').write_bytes(b'# tampered\n');self.rejected()

    def test_wrong_detached_pin_is_rejected(self):
        (self.root/'.git/HEAD').write_text('ref: refs/heads/main\n');self.rejected()

    def test_foreign_native_image_is_rejected(self):
        x=dict(self.facts,process_executable=str(self.root/'venv/Scripts/python.exe'));self.rejected(facts=x,fresh=x)

    def test_changed_birth_or_pid_is_rejected(self):
        for k in ['process_id','process_create_time_filetime_100ns']:
            with self.subTest(field=k):self.rejected(fresh=dict(self.facts,**{k:self.facts[k]+1}))

    def test_foreign_prefix_or_base_facts_is_rejected(self):
        for k in ['executable','prefix','base_executable','base_prefix']:
            with self.subTest(field=k):self.rejected(fresh=dict(self.facts,**{k:str(self.home.parent)}))

    def test_unknown_native_machine_or_nonisolated_rejected(self):
        for k,v in [('native_machine',0xaa64),('process_machine',0x14c),('bits',32),('isolated',0)]:
            with self.subTest(field=k):self.rejected(fresh=dict(self.facts,**{k:v}))

    def test_other_version_and_alias_child_are_not_generalized(self):
        for p in [self.alias/'DLLs',self.alias/'python.exe:stream',self.alias/'..'/'escape']:
            with self.subTest(path=str(p)):self.rejected(value=p)

    def test_unknown_target_or_relative_target_is_rejected(self):
        for target in [str(self.store/'cpython-3.11.18-windows-x86_64-none'),str(self.home.parent/'foreign'),
                '../cpython-3.11.17-windows-x86_64-none','\\\\host\\share']:
            with self.subTest(target=target),patch('os.readlink',return_value=target):self.rejected()

    def test_wrong_tag_or_symbolic_link_is_rejected(self):
        original=Path.lstat
        for tag,mode in [(0xa000000c,stat.S_IFLNK|0o777),(0xa000001d,stat.S_IFDIR|0o700)]:
            def altered(p):
                info=original(p)
                return types.SimpleNamespace(st_mode=mode,st_file_attributes=1040,st_reparse_tag=tag) if p==self.alias else info
            with self.subTest(tag=tag),patch.object(Path,'lstat',altered):self.rejected()

    def test_target_components_remain_regular(self):
        original=Path.lstat
        for component in [self.store,self.target,self.exe,self.root]:
            def altered(p):
                info=original(p)
                return types.SimpleNamespace(st_mode=info.st_mode,st_file_attributes=0x400,st_reparse_tag=0xa0000003) if p==component else info
            with self.subTest(component=str(component)),patch.object(Path,'lstat',altered):self.rejected()

    def test_readlink_and_image_read_fail_closed(self):
        with patch('os.readlink',side_effect=PermissionError(13,'owned denial')):self.rejected()
        with patch.object(Path,'open',side_effect=PermissionError(13,'owned denial')):self.rejected()

    def test_binary_alias_read_cannot_substitute_another_handle(self):
        other=self.store/'other.exe';other.write_bytes(self.exe.read_bytes());original=Path.open
        def opened(p,*args,**kwargs):return original(other if p==self.alias/'python.exe' else p,*args,**kwargs)
        with patch.object(Path,'open',opened):self.rejected()

    def test_original_version_and_runtime_facts_are_not_rewritten(self):
        with patch.object(sys,'version_info',(3,11,18)),patch.object(m,'_runtime_facts',return_value=dict(self.facts)):
            with self.assertRaises(SystemExit):m._legacy_managed_base_physical(self.alias/'python.exe',self.root,self.facts,slot='facts.base-executable')

    def test_full_layout_accepts_fixture_alias_but_preserves_other_admission(self):
        with patch.object(m,'_runtime_facts',return_value=dict(self.facts)),patch.object(sys,'version_info',(3,11,17)):
            self.assertEqual(m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts),self.root)
            (self.root/'venv/pyvenv.cfg').write_text('home = '+str(self.alias)+'\ninclude-system-site-packages = true\n')
            with self.assertRaisesRegex(SystemExit,'site'):m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)

    def test_reparse_read_change_is_not_cached_as_success(self):
        original=os.readlink;count=0
        def changed(p,*args,**kwargs):
            nonlocal count
            count+=1
            return original(p,*args,**kwargs) if count==1 else str(self.store/'foreign')
        with patch('os.readlink',changed):self.rejected()

    def test_alias_type_must_still_be_junction_on_first_and_final_snapshot(self):
        original=Path.lstat
        for switch_at in [2,3]:
            count=0
            def altered(p):
                nonlocal count
                info=original(p)
                if p==self.alias:
                    count+=1
                    if count>=switch_at:
                        return types.SimpleNamespace(st_mode=stat.S_IFLNK|0o777,st_file_attributes=1040,
                            st_reparse_tag=0xa000000c,st_dev=info.st_dev,st_ino=info.st_ino,st_mtime_ns=info.st_mtime_ns)
                return info
            with self.subTest(switch_at=switch_at),patch.object(Path,'lstat',altered):self.rejected()

    def test_helper_does_not_become_general_physical_resolver(self):
        with patch.object(m,'_runtime_facts',return_value=dict(self.facts)),patch.object(sys,'version_info',(3,11,17)):
            for slot in ['contract.source','facts.executable','unknown']:
                with self.subTest(slot=slot),self.assertRaises(SystemExit):
                    m._legacy_managed_base_physical(self.alias/'python.exe',self.root,self.facts,slot=slot)

    def test_optin_admission_receipt_contains_actual_binary_and_birth_not_path_text_hash(self):
        out=io.StringIO()
        with patch.dict(os.environ,{'CLAWPANEL_HERMES_PHASE_TIMING':'1'}),contextlib.redirect_stderr(out):
            self.assertEqual(self.resolve(),self.exe)
        lines=out.getvalue().splitlines();self.assertEqual(len(lines),1)
        prefix='CLAWPANEL_HERMES_LEGACY_ALIAS '
        self.assertTrue(lines[0].startswith(prefix));row=json.loads(lines[0][len(prefix):])
        self.assertEqual(row['binarySha256'],hashlib.sha256(self.exe.read_bytes()).hexdigest())
        self.assertEqual(row['processId'],os.getpid())
        self.assertEqual(row['creationTimeFiletime100ns'],self.facts['process_create_time_filetime_100ns'])
        self.assertEqual(row['pin'],m.LEGACY_PIN);self.assertEqual(row['sourceFilesVerified'],13)
        self.assertNotIn(str(self.home),lines[0]);self.assertEqual(row['binaryHashScope'],'stable-live-image-file-not-vendor-attestation')
        receipts.append(dict(case='fixture-optin-alias-admission-not-VM',receipt=row))


result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Alias))
report=dict(schemaVersion=1,scope='owned-fixture-component-not-Hermes-VM',testsRun=result.testsRun,
    failures=len(result.failures),errors=len(result.errors),skips=len(result.skipped),qualificationPass=False,receipts=receipts)
Path(output).write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
raise SystemExit(not result.wasSuccessful())
