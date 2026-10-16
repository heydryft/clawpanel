# 先失败合同，再诊断：仅自有临时layout/进程，不安装或启动Hermes。
import ast, contextlib, hashlib, importlib.util, io, json, os
from pathlib import Path
import stat, subprocess, sys, tempfile, types, unittest
from unittest.mock import patch

helper, contract, mode = sys.argv[1:4]
spec = importlib.util.spec_from_file_location('owned_path_guard', helper)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
expected = json.loads(Path(contract).read_text(encoding='utf-8'))
PREFIX = 'CLAWPANEL_HERMES_LEGACY_PATH '
receipts = []


class Contract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cp-legacy-path-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve() / '.hermes'
        self.root = self.home / 'hermes-agent'
        self.base = self.root / '.hermes-runtime/python/cpython-3.11-windows-x86_64-none'
        self.base.mkdir(parents=True)
        (self.root / 'venv/Scripts').mkdir(parents=True)
        (self.root / '.git').mkdir()
        for file in [self.base/'python.exe', self.root/'venv/Scripts/python.exe']:
            file.write_bytes(b'owned not executable')
        (self.root/'venv/pyvenv.cfg').write_text('home = '+str(self.base)+'\ninclude-system-site-packages = false\n')
        (self.root/'.git/HEAD').write_text(m.LEGACY_PIN+'\n')
        env = patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'CLAWPANEL_HERMES_PHASE_TIMING': '1'})
        env.start(); self.addCleanup(env.stop)
        self.facts = dict(platform='win32', os_name='nt', native_machine=0x8664, process_machine=0,
            bits=64, isolated=1, dont_write_bytecode=True, prefix=str(self.root/'venv'),
            executable=str(self.root/'venv/Scripts/python.exe'), base_executable=str(self.base/'python.exe'),
            base_prefix=str(self.base), process_executable=str(self.base/'python.exe'), process_id=os.getpid(),
            process_create_time_filetime_100ns=133700000000000000)

    def deny_at(self, path):
        original = Path.lstat
        def fake(value):
            info = original(value)
            return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400,
                st_reparse_tag=0xa0000003) if value == path else info
        return patch.object(Path, 'lstat', fake)

    def record(self, value, slot='facts.base-executable', target=None, enabled='1'):
        out = io.StringIO()
        with patch.dict(os.environ, {'CLAWPANEL_HERMES_PHASE_TIMING': enabled}), self.deny_at(self.base), \
                patch('os.readlink', return_value=str(target or self.base.parent/'cpython-3.11.17-windows-x86_64-none')) as readlink, \
                contextlib.redirect_stderr(out):
            with self.assertRaisesRegex(SystemExit, 'physical path link/reparse denied'):
                m._physical(value, slot=slot)
        return out.getvalue(), readlink.call_count

    def event(self, text):
        lines = text.splitlines(); self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith(PREFIX)); self.assertLess(len(lines[0].encode()), 4096)
        return json.loads(lines[0][len(PREFIX):])

    def test_default_off_no_new_io_or_stderr_original_error(self):
        for flag in ['', '0', 'true', '01']:
            text, calls = self.record(self.base/'python.exe', enabled=flag)
            self.assertEqual((text, calls), ('', 0))

    def test_exact_slot_component_and_managed_relative_path_no_absolute(self):
        text, calls = self.record(self.base/'python.exe')
        data = self.event(text)
        self.assertEqual(data['slot'], 'facts.base-executable')
        self.assertEqual(data['reason'], 'link-reparse')
        self.assertEqual(data['valueType'], 'path')
        self.assertEqual(data['fileAttributes'], 0x400)
        self.assertEqual(data['reparseTag'], 0xa0000003)
        self.assertEqual(data['requested']['relative'], 'hermes-agent/.hermes-runtime/python/cpython-3.11-windows-x86_64-none/python.exe')
        self.assertEqual(data['component']['relative'], 'hermes-agent/.hermes-runtime/python/cpython-3.11-windows-x86_64-none')
        self.assertEqual(data['target']['relative'], 'hermes-agent/.hermes-runtime/python/cpython-3.11.17-windows-x86_64-none')
        self.assertEqual(data['component']['sha256'], hashlib.sha256(str(self.base).encode('utf-8', 'surrogatepass')).hexdigest())
        self.assertEqual(calls, 1)
        self.assertNotIn(str(self.home), text)
        receipts.append({'case':'isolated-reparse-contract-not-VM', 'event':data, 'guardRejected':True})

    def test_unknown_slot_and_target_names_not_leaked_or_accepted(self):
        for target in [self.home/'PRIVATE_SECRET_DO_NOT_LOG', self.home.parent/'FOREIGN_SECRET',
                '//REMOTE_SECRET/share', '../ESCAPE_SECRET']:
            text, calls = self.record(self.base/'python.exe', slot='USER_SECRET\nINJECTION', target=target)
            data = self.event(text)
            self.assertEqual(data['slot'], 'unknown')
            self.assertIsNone(data['target']['relative'])
            self.assertNotIn('SECRET', text)
            self.assertEqual(calls, 1)

    def test_readlink_failure_preserves_guard_without_exception_message(self):
        out = io.StringIO()
        with self.deny_at(self.base), patch('os.readlink', side_effect=OSError(5, 'PRIVATE_SECRET')), contextlib.redirect_stderr(out):
            with self.assertRaisesRegex(SystemExit, 'physical path link/reparse denied'):
                m._physical(self.base/'python.exe', slot='facts.base-executable')
        data = self.event(out.getvalue())
        self.assertEqual(data['readlinkError'], {'type':'OSError', 'errno':5, 'winerror':None})
        self.assertNotIn('PRIVATE_SECRET', out.getvalue())

    def test_unknown_metadata_type_not_printed_as_path_or_tag(self):
        original = Path.lstat
        def fake(value):
            info = original(value)
            return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400,
                st_reparse_tag='PRIVATE_SECRET') if value == self.base else info
        out = io.StringIO()
        with patch.object(Path, 'lstat', fake), patch('os.readlink', side_effect=OSError(5,'private')), contextlib.redirect_stderr(out):
            with self.assertRaisesRegex(SystemExit, 'physical path link/reparse denied'):
                m._physical(self.base/'python.exe', slot='facts.base-executable')
        data = self.event(out.getvalue())
        self.assertIsNone(data['reparseTag'])
        self.assertNotIn('PRIVATE_SECRET', out.getvalue())

    def test_logging_failure_does_not_change_original_guard(self):
        class Broken:
            def write(self, value): raise OSError('owned diagnostic writer unavailable')
            def flush(self): pass
        with self.deny_at(self.base), patch('os.readlink', side_effect=OSError(5, 'private')), contextlib.redirect_stderr(Broken()):
            with self.assertRaisesRegex(SystemExit, 'physical path link/reparse denied'):
                m._physical(self.base/'python.exe', slot='facts.base-executable')

    def test_lstat_error_slot_and_type_only_no_guard_change(self):
        out = io.StringIO()
        with patch.object(Path, 'lstat', side_effect=PermissionError(13,'PRIVATE_SECRET')), contextlib.redirect_stderr(out):
            with self.assertRaisesRegex(SystemExit, 'physical path unavailable'):
                m._physical(self.root, slot='layout.root')
        data = self.event(out.getvalue())
        self.assertEqual(data['slot'], 'layout.root')
        self.assertEqual(data['reason'], 'path-unavailable')
        self.assertEqual(data['error']['type'], 'OSError')
        self.assertEqual(data['error']['errno'], 13)
        self.assertNotIn('PRIVATE_SECRET', out.getvalue())

    def test_each_actual_layout_call_has_precise_fixed_slot(self):
        physical = m._physical
        slots = ['layout.root','layout.home','layout.venv','facts.prefix','facts.executable',
            'layout.venv-executable','facts.base-executable','layout.python-store','facts.base-prefix',
            'facts.process-executable','layout.venv-config','venv-config.home','layout.git','layout.git-head']
        for slot in slots:
            with self.subTest(slot=slot):
                out = io.StringIO()
                def wrapper(value, **kwargs):
                    if kwargs.get('slot') == slot:
                        with self.deny_at(Path(value)), patch('os.readlink', side_effect=OSError(5,'fixture')):
                            return physical(value, **kwargs)
                    return physical(value, **kwargs)
                with patch.object(m, '_physical', wrapper), contextlib.redirect_stderr(out):
                    with self.assertRaisesRegex(SystemExit, 'physical path link/reparse denied'):
                        m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts)
                self.assertEqual(self.event(out.getvalue())['slot'], slot)

    def test_only_three_fixed_alias_operands_change_other_layout_profile_identity_and_pin_ast_unchanged(self):
        aliases = []
        class StripSlots(ast.NodeTransformer):
            def visit_Call(self, node):
                self.generic_visit(node)
                if isinstance(node.func, ast.Name) and node.func.id == '_legacy_managed_base_physical':
                    self_outer.assertEqual(len(node.args), 3)
                    self_outer.assertEqual(ast.dump(node.args[1]), ast.dump(ast.Name(id='root',ctx=ast.Load())))
                    self_outer.assertEqual(ast.dump(node.args[2]), ast.dump(ast.Name(id='facts',ctx=ast.Load())))
                    self_outer.assertEqual(len(node.keywords), 1)
                    slot = node.keywords[0].value.value
                    operands = {'facts.base-executable': "facts['base_executable']",
                        'facts.base-prefix': "facts['base_prefix']", 'venv-config.home': "cfg.get('home', '')"}
                    self_outer.assertIn(slot, operands)
                    self_outer.assertEqual(ast.dump(node.args[0]), ast.dump(ast.parse(operands[slot],mode='eval').body))
                    aliases.append(slot)
                    node.func.id = '_physical'; node.args = node.args[:1]
                if isinstance(node.func, ast.Name) and node.func.id == '_physical':
                    self_outer.assertEqual(len(node.keywords), 1)
                    self_outer.assertEqual(node.keywords[0].arg, 'slot')
                    self_outer.assertIsInstance(node.keywords[0].value, ast.Constant)
                    node.keywords = []
                return node
        self_outer = self
        tree = ast.parse(Path(helper).read_text(encoding='utf-8'))
        for node in tree.body:
            if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in expected['unchangedAstExceptSlotKeywords']:
                clean = StripSlots().visit(node)
                self.assertEqual(hashlib.sha256(ast.dump(clean,include_attributes=False).encode()).hexdigest(), expected['unchangedAstExceptSlotKeywords'][node.name], node.name)
        self.assertCountEqual(aliases, ['facts.base-executable','facts.base-prefix','venv-config.home'])
        hashes = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SOURCE_HASHES' for t in n.targets))
        self.assertEqual(hashes,expected['sourceHashes'])

    def test_success_has_no_diagnostic_or_extra_link_probe_and_env_unchanged(self):
        before = dict(os.environ); out = io.StringIO()
        with patch('os.readlink', side_effect=AssertionError('success must not readlink')), contextlib.redirect_stderr(out):
            self.assertEqual(m._validate_layout(self.root,self.home,m.LEGACY_PIN,'console',self.facts),self.root)
        self.assertEqual(out.getvalue(),''); self.assertEqual(dict(os.environ),before)


class Live(Contract):
    # opt-in真实子进程仅跑此用例；不是Hermes安装/Windows VM资格。
    def test_owned_real_link_child_guard_off_on_and_target_unchanged(self):
        target = self.base.parent/'cpython-3.11.17-windows-x86_64-none'; target.mkdir()
        canary = target/'python.exe'; canary.write_bytes(b'owned target canary never executed')
        alias = self.base.parent/'cpython-3.11.19-windows-x86_64-none'
        try:
            if os.name == 'nt':
                args = ['powershell.exe','-NoProfile','-NonInteractive','-Command',
                    '$v=[Console]::In.ReadToEnd()|ConvertFrom-Json; New-Item -ItemType Junction -Path $v.link -Target $v.target -ErrorAction Stop|Out-Null']
                r = subprocess.run(args,input=json.dumps({'link':str(alias),'target':str(target)}),capture_output=True,text=True,creationflags=0x08000000,timeout=20)
                self.assertEqual(r.returncode,0,r.stderr)
            else:
                alias.symlink_to(target,target_is_directory=True)
            code = "import importlib.util,sys; s=importlib.util.spec_from_file_location('owned',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m._physical(sys.argv[2],slot='facts.base-executable')"
            cases=[];before=hashlib.sha256(canary.read_bytes()).hexdigest()
            for flag in ['0','1']:
                r=subprocess.run([sys.executable,'-I','-B','-c',code,helper,str(alias/'python.exe')],capture_output=True,text=True,encoding='utf-8',timeout=5,
                    env={**os.environ,'CLAWPANEL_HERMES_PHASE_TIMING':flag},**({'creationflags':0x08000000} if os.name=='nt' else {}))
                self.assertEqual(r.returncode,1);self.assertEqual(r.stdout,'')
                self.assertTrue(r.stderr.endswith('ClawPanel legacy Windows: physical path link/reparse denied\n'))
                if flag=='0':self.assertEqual(r.stderr,'ClawPanel legacy Windows: physical path link/reparse denied\n')
                else:
                    d=self.event(r.stderr.split('ClawPanel legacy Windows:')[0]);self.assertEqual(d['slot'],'facts.base-executable')
                    self.assertEqual(d['target']['relative'],'hermes-agent/.hermes-runtime/python/cpython-3.11.17-windows-x86_64-none')
                cases.append({'phaseTiming':flag,'exit':r.returncode,'rejected':True})
            self.assertEqual(hashlib.sha256(canary.read_bytes()).hexdigest(),before)
            receipts.append({'case':'owned-real-link-subprocess-not-Hermes-VM','platform':sys.platform,'cases':cases,'targetUnchanged':True})
        finally:
            if alias.is_symlink():alias.unlink()
            elif alias.exists():
                self.assertTrue(getattr(alias.lstat(),'st_file_attributes',0)&0x400)
                os.rmdir(alias)
            self.assertTrue(canary.is_file())


suite=unittest.TestSuite([Live('test_owned_real_link_child_guard_off_on_and_target_unchanged')]) if mode=='live' else unittest.defaultTestLoader.loadTestsFromTestCase(Contract)
r=unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'scope':'isolated-path-diagnostic-not-Hermes-or-VM','qualificationPass':False,'tests':r.testsRun,'failures':len(r.failures)+len(r.errors),'skips':len(r.skipped),'receipts':receipts}))
raise SystemExit(not r.wasSuccessful())
