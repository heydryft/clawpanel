# 原203组件不改；复用其setup/19负向，新增真实组合身份准入。事实/进程表替身仅本测试进程生效，不声称VM资格。
import ast, asyncio, base64, contextlib, copy, hashlib, importlib.util, json, os
from pathlib import Path
import shlex, stat, subprocess, sys, types, unittest, zlib
from unittest.mock import patch
from typing import Any, Optional

sample_file, entry_file, output = map(Path, sys.argv[1:4])
sample = json.loads(sample_file.read_text(encoding='utf-8'))
body = base64.b64decode(sample['bodyBase64']); assert hashlib.sha256(body).hexdigest() == sample['bodySha256']
wire = sample['spec']['args'][3]
old_driver = Path(__file__).with_name('hermes-legacy-private-python-alias.py')
tree = ast.parse(old_driver.read_text(encoding='utf-8')); prefix = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'result' for t in node.targets): break
    prefix.append(node)
scope = {'__name__': 'owned_reused_alias_fixture', '__file__': str(old_driver)}
with patch.object(sys, 'argv', [str(old_driver), str(entry_file), str(output)]):
    exec(compile(ast.Module(body=prefix, type_ignores=[]), str(old_driver), 'exec'), scope)
m = types.ModuleType('owned_combined_identity_alias'); m.__file__ = '<clawpanel-hermes-private>'
exec(compile(body, m.__file__, 'exec'), vars(m))
assert m.decode_clawpanel_private_script_bytes(wire, m.LEGACY_PIN) == body
scope['m'] = m
fixture = json.loads(Path(__file__).with_name('hermes-legacy-stop-upstream.json').read_text(encoding='utf-8'))
live = Path(__file__).with_name('hermes-legacy-stop-live.py')
load_node = next(n for n in ast.parse(live.read_text(encoding='utf-8')).body if isinstance(n, ast.FunctionDef) and n.name == 'load_status')
exec(compile(ast.Module(body=[load_node], type_ignores=[]), str(live), 'exec'), globals())
receipts = scope['receipts']
home96 = 'C:\\' + 'h' * 93
stress = [home96 + '\\hermes-agent\\venv\\Scripts\\python.exe', '-I', '-B', '-c', wire,
          home96 + '\\hermes-agent', home96, m.LEGACY_PIN, 'console', '--', '--profile', 'w' * 63, 'gateway', 'run']
max_utf16 = len(subprocess.list2cmdline(stress).encode('utf-16-le')) // 2 + 1
assert len(wire) <= 30000 and len(body) <= 131072 and max_utf16 < 32767


class IdentityAlias(scope['Alias']):
    def setUp(self):
        super().setUp()
        self.saved_modules = {k: v for k, v in sys.modules.items() if k == 'gateway' or k.startswith('gateway.') or k in ('psutil', 'hermes_constants', 'utils')}
        self.addCleanup(self.restore_modules)
        self.target_process = dict(pid=os.getpid(), birth=1700000000.125, exe=str(self.exe),
            argv=[str(self.root/'venv/Scripts/python.exe'), '-I', '-B', '-c', wire, str(self.root), str(self.home), m.LEGACY_PIN, 'console', '--', 'gateway', 'run'],
            env={'HERMES_HOME': str(self.home)}, user='owned', running=True)
        state = self.target_process
        class Process:
            def __init__(self, pid=None):
                self.pid = state['pid'] if pid is None else pid
                if self.pid != state['pid']: raise ProcessLookupError(pid)
                self.birth = state['birth']
            def create_time(self): return self.birth
            def exe(self):
                hook = state.get('before_exe')
                if hook: hook()
                return state['exe']
            def cmdline(self): return state['argv'][:]
            def environ(self): return state['env'].copy()
            def username(self):
                if state.pop('reused_late', False): state['birth'] += 0.001
                return state['user']
            def is_running(self): return state['running']
        global psutil
        psutil = types.ModuleType('psutil'); psutil.Process = Process
        sys.modules['psutil'] = psutil
        self.status = load_status(self.root, self.home)
        for key, field in [('gateway/status.py', 'statusZlibBase64'), ('hermes_cli/gateway.py', 'cliZlibBase64')]:
            raw = zlib.decompress(base64.b64decode(fixture[field]))
            p = self.root/key; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(raw)
            self.hashes[key] = hashlib.sha256(raw).hexdigest()
        self.original, self.factory = self.status._record_matches_live_gateway_pid, self.status._build_pid_record
        self.independent = {k: v for k, v in self.facts.items() if k not in ('process_executable', 'process_id', 'process_create_time_filetime_100ns')}
        self.provider_calls = []
        m._test_fresh_entry_facts = self.facts
        m._test_resolver = m._legacy_managed_base_physical
        m._test_provider_calls = self.provider_calls
        scope2 = {}
        exec("def _runtime_facts():\n    return dict(_test_fresh_entry_facts)\ndef _legacy_managed_base_physical(value, root, facts, *, slot):\n    _test_provider_calls.append(dict(slot=slot, facts=dict(facts)))\n    return _test_resolver(value, root, facts, slot=slot)\n", vars(m), scope2)
        self.fresh_provider, self.resolver_spy = scope2['_runtime_facts'], scope2['_legacy_managed_base_physical']
        m._CLAWPANEL_EXECUTED_SCRIPT_BYTES = body

    def restore_modules(self):
        for k in list(sys.modules):
            if k == 'gateway' or k.startswith('gateway.') or k in ('psutil', 'hermes_constants', 'utils'): sys.modules.pop(k, None)
        sys.modules.update(self.saved_modules)
        m._legacy_identity_bridges.clear()

    @contextlib.contextmanager
    def admission(self):
        with patch.object(m, '_runtime_facts', self.fresh_provider), patch.object(m, '_legacy_managed_base_physical', self.resolver_spy), \
             patch.object(m, '_legacy_identity_runtime_facts', return_value=dict(self.independent)), \
             patch.object(sys, 'version_info', (3, 11, 17)), patch.object(sys, 'argv', ['-c', 'gateway', 'run']), \
             patch.object(sys, 'orig_argv', self.target_process['argv'][:]):
            yield

    def layout(self): return m._legacy_runtime_layout(self.root, self.home, dict(self.independent))
    def positive(self):
        self.assertEqual(self.layout(), (self.root, self.home, self.root/'venv/Scripts/python.exe', self.exe))

    def test_identity_00_real_junction_uses_exact_three_roles_and_full_raw_facts(self):
        before = dict(self.facts)
        with self.admission(): self.positive()
        self.assertEqual([x['slot'] for x in self.provider_calls], ['facts.base-executable', 'facts.base-prefix', 'venv-config.home'])
        self.assertTrue(all(x['facts'] == before for x in self.provider_calls))
        self.assertEqual(self.facts, before)
        with self.assertRaises(SystemExit): m._legacy_identity_physical(self.alias/'python.exe')
        receipts.append(dict(case='identity-shared-resolver-real-junction-component', nativeJunction=os.name == 'nt', fullRawFacts=True, exactRoles=True, qualificationPass=False))

    def test_identity_physical_old_layout_needs_no_alias_seam(self):
        facts = dict(self.independent, base_executable=str(self.exe), base_prefix=str(self.target))
        (self.root/'venv/pyvenv.cfg').write_text('home = '+str(self.target)+'\ninclude-system-site-packages = false\n')
        with patch.object(m, '_runtime_facts', None), patch.object(m, '_legacy_managed_base_physical', None):
            self.assertEqual(m._legacy_runtime_layout(self.root, self.home, facts), (self.root, self.home, self.root/'venv/Scripts/python.exe', self.exe))

    def test_identity_alias_allows_real_raw_physical_base_prefix_and_cfg(self):
        self.facts['base_prefix'] = self.independent['base_prefix'] = str(self.target)
        (self.root/'venv/pyvenv.cfg').write_text('home = '+str(self.target)+'\ninclude-system-site-packages = false\n')
        with self.admission(): self.positive()
        self.assertEqual([x['slot'] for x in self.provider_calls], ['facts.base-executable'])

    def test_identity_missing_or_foreign_seam_rejects(self):
        with self.admission():
            self.positive()
            for name, value in [('_runtime_facts', None), ('_legacy_managed_base_physical', None), ('_runtime_facts', lambda: dict(self.facts))]:
                with self.subTest(name=name, value=str(value)), patch.object(m, name, value), self.assertRaises(SystemExit): self.layout()

    def test_identity_incomplete_or_changed_full_facts_rejects_without_canonicalizing(self):
        with self.admission():
            self.positive()
            for key in self.facts:
                for value in [None, str(self.home/'foreign')] if isinstance(self.facts[key], str) else [None]:
                    changed = dict(self.facts); changed[key] = value
                    with self.subTest(key=key), patch.object(m, '_test_fresh_entry_facts', changed), self.assertRaises(SystemExit): self.layout()

    def test_identity_source_pin_hash_and_nonbase_reparse_still_reject(self):
        with self.admission():
            self.positive()
            for rel, content in [('.git/HEAD', '0'*40+'\n'), ('hermes_cli/main.py', '# modified source\n')]:
                p = self.root/rel; saved = p.read_bytes(); p.write_text(content)
                try:
                    with self.assertRaises(SystemExit): self.layout()
                finally: p.write_bytes(saved)
            original_lstat = Path.lstat
            for part in [self.root, self.home, self.root/'venv/Scripts/python.exe', self.store, self.exe]:
                def altered(p):
                    s = original_lstat(p)
                    return types.SimpleNamespace(st_mode=s.st_mode, st_file_attributes=0x400) if p == part else s
                with self.subTest(part=str(part)), patch.object(Path, 'lstat', altered), self.assertRaises(SystemExit): self.layout()

    def test_identity_actual_foreign_junction_target_is_rejected(self):
        with self.admission():
            self.positive()
            foreign = self.store/'owned-foreign'; foreign.mkdir(); (foreign/'python.exe').write_bytes(self.exe.read_bytes())
            if os.name == 'nt':
                os.rmdir(self.alias)
                r = subprocess.run([os.environ.get('ComSpec', 'cmd.exe'), '/d', '/c', 'mklink', '/J', str(self.alias), str(foreign)], capture_output=True, timeout=5, creationflags=0x08000000)
                self.assertEqual(r.returncode, 0, r.stderr)
            else: self.alias.unlink(); self.alias.symlink_to(foreign, target_is_directory=True)
            with self.assertRaises(SystemExit): self.layout()

    def test_identity_reparse_target_race_and_binary_handle_substitution_reject(self):
        with self.admission():
            self.positive()
            original = os.readlink; calls = 0
            def changed(p, *a, **kw):
                nonlocal calls
                calls += 1
                return original(p, *a, **kw) if calls == 1 else str(self.store/'foreign')
            with patch('os.readlink', changed), self.assertRaises(SystemExit): self.layout()
            other = self.store/'other.exe'; other.write_bytes(self.exe.read_bytes()); original_open = Path.open
            def opened(p, *a, **kw): return original_open(other if p == self.alias/'python.exe' else p, *a, **kw)
            with patch.object(Path, 'open', opened), self.assertRaises(SystemExit): self.layout()

    def test_identity_public_bridge_default_named_original_factory_fallback_and_restore(self):
        with self.admission():
            self.positive()
            for name in ['default', 'work']:
                active = self.home if name == 'default' else self.home/'profiles'/name
                active.mkdir(parents=True, exist_ok=True); os.environ['HERMES_HOME'] = str(active)
                self.target_process['env']['HERMES_HOME'] = str(active)
                self.target_process['argv'][10:] = ['--profile', name, 'gateway', 'run']; sys.orig_argv = self.target_process['argv'][:]
                self.status._get_process_hermes_home = lambda: active
                context = types.MappingProxyType(dict(schema_version=1, version='0.21.5', pin=m.LEGACY_PIN, phase='status',
                    source_root=str(self.root), owner_home=str(self.home), effective_home=str(active), cli_argv=tuple(sys.argv),
                    python_orig_argv=tuple(sys.orig_argv), runtime_facts=types.MappingProxyType(dict(self.facts)), source_hashes=types.MappingProxyType(self.hashes)))
                close = m.install_windows_private_identity(self.status, None, context)
                try:
                    record = self.status._build_pid_record(); pid = self.target_process['pid']
                    self.assertFalse(self.original(record, pid, expected_home=active))
                    self.assertTrue(self.status._record_matches_live_gateway_pid(record, pid, expected_home=active))
                    for k, v in self.factory().items(): self.assertEqual(record[k], v)
                    wrapped = self.status._record_matches_live_gateway_pid
                    gateway = types.ModuleType('hermes_cli.gateway'); gateway.__file__ = str(self.root/'hermes_cli/gateway.py')
                    no_op = m.install_windows_private_identity(self.status, gateway, types.MappingProxyType({**context, 'phase': 'gateway'}))
                    self.assertIs(self.status._record_matches_live_gateway_pid, wrapped); no_op()
                    native = dict(record); native.pop('clawpanel_legacy_identity'); saved = self.target_process['argv']
                    self.target_process['argv'] = ['python', '-m', 'hermes_cli.main', 'gateway', 'run']
                    self.assertTrue(self.status._record_matches_live_gateway_pid(native, pid, expected_home=active)); self.target_process['argv'] = saved
                finally: close()
                self.assertIs(self.status._record_matches_live_gateway_pid, self.original); self.assertIs(self.status._build_pid_record, self.factory)
            receipts.append(dict(case='combined-identity-default-and-named', restore=True, nativeFallback=True, gatewayNoop=True, qualificationPass=False))

    def test_identity_body_birth_argv_and_incomplete_proof_reject(self):
        with self.admission():
            self.positive(); close = m.install_legacy_gateway_identity(self.root, self.home, wire)
            try:
                record = self.status._build_pid_record(); saved = copy.deepcopy(self.target_process)
                match = lambda r: self.status._record_matches_live_gateway_pid(r, self.target_process['pid'], expected_home=self.home)
                self.assertTrue(match(record))
                for field in ['create_time', 'script_sha256', 'pin']:
                    r = copy.deepcopy(record); r['clawpanel_legacy_identity'].pop(field); self.assertFalse(match(r), field)
                # canonical base现为合法redirector argv0；此处仍保留真正foreign argv0的原拒绝断言。
                for index, value in [(0, str(self.store/'foreign.exe')), (4, wire+'\nprint(1)'), (5, str(self.home)), (6, str(self.root)), (7, '0'*40), (11, 'stop')]:
                    self.target_process['argv'][index] = value; self.assertFalse(match(record), str(index)); self.target_process.update(copy.deepcopy(saved))
                self.target_process['birth'] += 0.001; self.assertFalse(match(record)); self.target_process.update(copy.deepcopy(saved))
                self.target_process['reused_late'] = True; self.assertFalse(match(record)); self.target_process.update(copy.deepcopy(saved))
                self.target_process['exe'] = str(self.root/'venv/Scripts/python.exe'); self.assertFalse(match(record))
            finally: close()

    def test_identity_new_version_is_not_qualified_by_old_alias(self):
        with self.admission():
            self.positive()
            with patch.object(sys, 'version_info', (3, 11, 18)), self.assertRaises(SystemExit): self.layout()
            (self.root/'.git/HEAD').write_text('d923a5eb487a17c0a68801bba9ef0f56c81040a8\n')
            with self.assertRaises(SystemExit): self.layout()

    def test_identity_real_sourcefileloader_finder_context_and_owned_restore(self):
        with self.admission():
            self.positive()
            for name in list(sys.modules):
                if name == 'gateway' or name.startswith('gateway.'): sys.modules.pop(name)
            constants = types.ModuleType('hermes_constants')
            constants._get_platform_default_hermes_home = constants.get_hermes_home = constants.get_process_hermes_home = lambda: self.home
            utils = types.ModuleType('utils'); utils.atomic_json_write = lambda *a, **kw: None
            sys.modules.update(hermes_constants=constants, utils=utils)
            contract = m._SourceContract(self.root, self.hashes)
            finder = m._PinnedFinder(contract, lambda *a: lambda: None, m.install_windows_private_identity, dict(self.facts))
            saved_path, saved_meta = sys.path[:], sys.meta_path[:]
            sys.path.insert(0, str(self.root)); sys.meta_path.insert(0, finder)
            try:
                import gateway.status as loaded
                self.assertIs(finder.status, loaded)
                loaded._get_process_start_time = lambda pid: round(self.target_process['birth'] * 100)
                loaded._read_process_cmdline = lambda pid: ' '.join(self.target_process['argv'])
                record = loaded._build_pid_record()
                self.assertTrue(loaded._record_matches_live_gateway_pid(record, self.target_process['pid'], expected_home=self.home))
                gateway = types.ModuleType('hermes_cli.gateway'); gateway.__file__ = str(self.root/'hermes_cli/gateway.py')
                exec(fixture['cli']['source'], vars(gateway))
                scan, capture = gateway._scan_gateway_pids, gateway._capture_gateway_argv
                wrapped = loaded._record_matches_live_gateway_pid
                finder._install_identity('gateway', loaded, gateway)
                self.assertIs(loaded._record_matches_live_gateway_pid, wrapped)
                self.assertIs(gateway._scan_gateway_pids, scan); self.assertIs(gateway._capture_gateway_argv, capture)
                finder.close(); m._verify_legacy_status(loaded, self.root)
                self.assertNotIn(id(loaded), m._legacy_identity_bridges)
                receipts.append(dict(case='real-sourcefileloader-and-carver-finder', publicAdmission=True, restored=True, gatewayNoop=True, qualificationPass=False))
            finally:
                finder.close(); sys.path[:] = saved_path; sys.meta_path[:] = saved_meta


class GatewayExecutableAlias(IdentityAlias):
    @contextlib.contextmanager
    def live_match(self, active=None):
        active = self.home if active is None else active
        active.mkdir(parents=True, exist_ok=True)
        os.environ['HERMES_HOME'] = str(active)
        self.target_process['env']['HERMES_HOME'] = str(active)
        self.status._get_process_hermes_home = lambda: active
        with self.admission():
            close = m.install_legacy_gateway_identity(self.root, self.home, wire)
            try:
                record = self.status._build_pid_record()
                self.assertEqual(record['clawpanel_legacy_identity']['script_sha256'], sample['bodySha256'])
                yield record, lambda r=record: self.status._record_matches_live_gateway_pid(r, self.target_process['pid'], expected_home=active)
            finally:
                close()
                self.assertIs(self.status._record_matches_live_gateway_pid, self.original)
                self.assertIs(self.status._build_pid_record, self.factory)

    def retarget_owned_alias(self, destination):
        # 只操作setUp新建的精确junction；不递归删除目标，不接受外部目录。
        self.assertEqual(self.alias.parent.resolve(), self.store.resolve())
        self.assertTrue(destination.resolve().is_relative_to(Path(self.temp.name).resolve()))
        if os.name == 'nt':
            self.assertEqual(self.alias.lstat().st_reparse_tag, 0xa0000003)
            os.rmdir(self.alias)
            r = subprocess.run([os.environ.get('ComSpec', 'cmd.exe'), '/d', '/c', 'mklink', '/J', str(self.alias), str(destination)],
                capture_output=True, timeout=5, creationflags=0x08000000)
            self.assertEqual(r.returncode, 0, r.stderr)
        else:
            self.alias.unlink(); self.alias.symlink_to(destination, target_is_directory=True)

    def test_gateway_00_current_production_wire_accepts_redirector_executables(self):
        original_facts = dict(self.facts); cases = []
        for name in ['default', 'work']:
            active = self.home if name == 'default' else self.home/'profiles'/name
            self.target_process['argv'][10:] = ['gateway', 'run'] if name == 'default' else ['--profile', name, 'gateway', 'run']
            with self.live_match(active) as (record, match):
                for argv0, exe in [(self.root/'venv/Scripts/python.exe', self.exe), (self.root/'venv/Scripts/python.exe', self.alias/'python.exe'),
                                   (self.exe, self.exe), (self.exe, self.alias/'python.exe'),
                                   (self.alias/'python.exe', self.exe), (self.alias/'python.exe', self.alias/'python.exe')]:
                    with self.subTest(profile=name, argv0=str(argv0), exe=str(exe)):
                        self.target_process['argv'][0], self.target_process['exe'] = str(argv0), str(exe)
                        self.assertTrue(match(), 'legal private redirector executable rejected')
                        cases.append(dict(profile=name, argv0Role='venv' if argv0 == self.root/'venv/Scripts/python.exe' else 'base',
                            argv0Alias=argv0 == self.alias/'python.exe', exeAlias=exe == self.alias/'python.exe'))
        self.assertEqual(self.facts, original_facts)
        with self.assertRaises(SystemExit): m._legacy_identity_physical(self.alias/'python.exe')
        receipts.append(dict(case='gateway-current-wire-redirector-matrix', cases=cases, productionBodySha256=sample['bodySha256'],
            nativeJunction=os.name == 'nt', rawFactsUnchanged=True, qualificationPass=False))

    def test_gateway_each_alias_executable_uses_full_fresh_resolver_without_cache(self):
        with self.live_match() as (_, match):
            # 原纯物理路径不需要alias事实；已完成公开布局准入后，不应额外调用Windows alias探针。
            with patch.object(m, '_legacy_identity_runtime_facts', side_effect=AssertionError('physical path must not query alias facts')):
                self.assertTrue(match())
            self.target_process['argv'][0] = self.target_process['exe'] = str(self.alias/'python.exe')
            self.provider_calls.clear()
            self.assertTrue(match())
            self.assertEqual([x['slot'] for x in self.provider_calls], ['facts.base-executable'] * 2)
            self.assertTrue(all(x['facts'] == self.facts for x in self.provider_calls))
            for key in ['process_id', 'process_create_time_filetime_100ns', 'process_executable']:
                changed = dict(self.facts); changed[key] = None
                with self.subTest(key=key), patch.object(m, '_test_fresh_entry_facts', changed):
                    self.assertFalse(match(), 'previous alias success must not hide missing fresh native facts')
            self.assertTrue(match())
        receipts.append(dict(case='gateway-fresh-executable-admission', exactSlots=2, cachedSuccess=False, qualificationPass=False))

    def test_gateway_wrong_root_foreign_binary_or_junction_is_rejected(self):
        with self.live_match() as (_, match):
            self.assertTrue(match())
            original = copy.deepcopy(self.target_process)
            foreign = self.store/'owned-foreign'; foreign.mkdir(); (foreign/'python.exe').write_bytes(self.exe.read_bytes())
            link = self.store/'foreign-junction'
            if os.name == 'nt':
                r = subprocess.run([os.environ.get('ComSpec', 'cmd.exe'), '/d', '/c', 'mklink', '/J', str(link), str(self.target)],
                    capture_output=True, timeout=5, creationflags=0x08000000)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.addCleanup(lambda: os.rmdir(link) if os.path.lexists(link) else None)
            else:
                link.symlink_to(self.target, target_is_directory=True)
            for field, value in [('argv0', str(foreign/'python.exe')), ('exe', str(foreign/'python.exe')),
                                 ('argv0', str(link/'python.exe')), ('exe', str(link/'python.exe')), ('root', str(self.home))]:
                with self.subTest(field=field, value=value):
                    if field == 'argv0': self.target_process['argv'][0] = value
                    elif field == 'exe': self.target_process['exe'] = value
                    else: self.target_process['argv'][5] = value
                    self.assertFalse(match())
                    self.target_process.update(copy.deepcopy(original))

    def test_gateway_venv_remains_invalid_as_live_base_executable(self):
        with self.live_match() as (_, match):
            self.assertTrue(match())
            self.target_process['exe'] = str(self.root/'venv/Scripts/python.exe')
            for argv0 in [self.root/'venv/Scripts/python.exe', self.exe, self.alias/'python.exe']:
                self.target_process['argv'][0] = str(argv0)
                self.assertFalse(match(), 'venv executable must not be accepted as native base image')

    def test_gateway_late_real_alias_drift_between_executable_fields_rejects(self):
        with self.live_match() as (_, match):
            self.target_process['argv'][0] = self.target_process['exe'] = str(self.alias/'python.exe')
            self.assertTrue(match())
            foreign = self.store/'owned-late-foreign'; foreign.mkdir(); (foreign/'python.exe').write_bytes(self.exe.read_bytes())
            calls = []
            def drift():
                if not calls:
                    calls.append('before-exe'); self.retarget_owned_alias(foreign)
            self.target_process['before_exe'] = drift
            self.assertFalse(match())
            self.assertEqual(calls, ['before-exe'])
        receipts.append(dict(case='gateway-real-late-junction-drift', rejected=True, cachedSuccess=False, qualificationPass=False))

    def test_gateway_current_body_digest_rejects_other_well_formed_wire(self):
        with self.live_match() as (record, match):
            self.assertTrue(match())
            different = body + b'\n# different adapter body is not the current executed body\n'
            payload = __import__('re').search(r"_cp_b\.b64decode\('([A-Za-z0-9+/=]+)',validate=True\)", wire)[1]
            other_sha = hashlib.sha256(different).hexdigest()
            other_wire = wire.replace(sample['bodySha256'], other_sha).replace(payload, base64.b64encode(zlib.compress(different, 9)).decode())
            self.assertEqual(m.decode_clawpanel_private_script_bytes(other_wire, m.LEGACY_PIN), different)
            self.target_process['argv'][4] = other_wire
            self.assertFalse(match(record))
            changed = copy.deepcopy(record); changed['clawpanel_legacy_identity']['script_sha256'] = other_sha
            self.assertFalse(match(changed), 'matching older wire and record still must not bypass current body digest')


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(IdentityAlias))
additional = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(
    GatewayExecutableAlias(name) for name in sorted(GatewayExecutableAlias.__dict__) if name.startswith('test_gateway_')))
report = dict(scope='real-owned-junction-composed-source-isolated-facts-not-Hermes-VM', testsRun=result.testsRun,
    failures=len(result.failures), errors=len(result.errors), skips=len(result.skipped), qualificationPass=False,
    gatewayExecutable=dict(testsRun=additional.testsRun, failures=len(additional.failures), errors=len(additional.errors), skips=len(additional.skipped)),
    productionBodySha256=sample['bodySha256'], maxCompleteUtf16IncludingNul=max_utf16, receipts=receipts)
output.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
raise SystemExit(not (result.wasSuccessful() and additional.wasSuccessful()))
