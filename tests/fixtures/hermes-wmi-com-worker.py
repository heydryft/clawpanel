# 先列失败场景，再验证原 parser 与自有进程；不安装内核，不保存宿主命令行。
import ast, contextlib, ctypes, hashlib, importlib.util, io, json, os
from pathlib import Path
import subprocess, sys, time, unittest

helper, contracts, mode = sys.argv[1:]
import tempfile
owned_worker = tempfile.TemporaryDirectory(prefix='cp-wmi-worker-')
worker = str(Path(owned_worker.name) / 'worker.py')
node = next(n for n in ast.parse(Path(helper).read_text(encoding='utf-8')).body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'HERMES_WINDOWS_WMI_WORKER' for t in n.targets))
Path(worker).write_text(ast.literal_eval(node.value), encoding='utf-8')
spec = importlib.util.spec_from_file_location('owned_native_inventory', worker)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rows = [(0, None), (42, '"C:\\Program Files\\python.exe" --profile "a b" gateway run'),
        (84, '完整汉字😀 "a\\\\b\\\"c"\r\nCommandLine=not-a-new-row\nProcessId=111'), (91, '')]
receipts = []


class Contract(unittest.TestCase):
    def test_original_parsers_receive_all_complete_rows(self):
        listing = m._format_inventory(rows)
        expected = [(pid, (cmd or '').replace('\r\n', ' ').replace('\n', ' ')) for pid, cmd in rows]
        for item in json.loads(Path(contracts).read_text(encoding='utf-8')):
            self.assertEqual(hashlib.sha256(item['parser'].encode()).hexdigest(), item['parserSha256'])
            ns = {'contextlib': contextlib}; exec(item['parser'], ns)
            self.assertEqual(list(ns['_iter_windows_list_processes'](listing)), expected)

    def test_invalid_pid_and_commandline_reject_whole_result(self):
        for bad in [[], [(42, 'x'), (42, 'y')], [(True, 'x')], [(-1, 'x')], [(2**32, 'x')],
                    [('42', 'x')], [(42, b'bytes')], [(42, {'unknown': True})], [(42, 'nul\0hidden')]]:
            with self.subTest(bad=bad), self.assertRaises(m.InventoryError): m._format_inventory(bad)

    def test_long_unicode_and_exact_quotes_not_reconstructed(self):
        raw = '"C:\\a b\\python.exe"  "" "a\\\\\\\"b" ' + '汉😀' * 10000
        output = m._format_inventory([(1, raw)])
        self.assertEqual(output, 'CommandLine=' + raw + '\nProcessId=1\n\n')

    def test_no_output_truncation(self):
        with self.assertRaises(m.InventoryError): m._format_inventory([(1, 'a' * 1048576)])

    def test_exact_original_text_budget_not_an_artificial_smaller_limit(self):
        overhead = len('CommandLine=\nProcessId=1\n\n')
        batch = [(1, 'a' * (1048576 - overhead))]
        self.assertEqual(len(m._format_inventory(batch)), 1048576)
        self.assertEqual(m._collect_inventory(lambda timeout: (1, batch), 15), m._format_inventory(batch))

    def test_original_text_character_budget_not_utf8_byte_budget(self):
        batch = [(pid, '汉' * 32760) for pid in range(20)]
        output = m._collect_inventory(lambda timeout: (1, batch), 15)
        self.assertLess(len(output), 1048576)
        self.assertGreater(len(output.encode('utf-8')), 1048576)

    def test_final_s_false_rows_are_preserved(self):
        batches = iter([(0, rows[:2]), (1, rows[2:])])
        self.assertEqual(m._collect_inventory(lambda timeout: next(batches), 15), m._format_inventory(rows))

    def test_timeout_is_not_eof_or_partial_success(self):
        ticks = iter([0, 0, .05, .1, .11])
        with self.assertRaises(m.InventoryError):
            m._collect_inventory(lambda timeout: (0x40004, []), .1, now=lambda: next(ticks))

    def test_partial_query_error_is_failclosed_and_stdout_empty(self):
        batches = iter([(0, rows[:1]), (0x80041003, [])])
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(m.InventoryError):
            m._collect_inventory(lambda timeout: next(batches), 15)
        self.assertEqual(out.getvalue(), '')

    def test_provider_exception_not_null_commandline(self):
        def denied(timeout): raise PermissionError('owned denied fixture')
        with self.assertRaises(m.InventoryError): m._collect_inventory(denied, 15)

    def test_empty_eof_unknown_status_or_protocol_rejected(self):
        for status, batch in [(1, []), (0, []), (9, rows), (0, None)]:
            with self.subTest(status=status), self.assertRaises(m.InventoryError):
                m._collect_inventory(lambda timeout: (status, batch), 15)

    def test_original_budget_not_increased(self):
        for timeout in [0, -1, 15.001, True, float('nan'), float('inf')]:
            with self.subTest(timeout=timeout), self.assertRaises(m.InventoryError):
                m._collect_inventory(lambda t: (1, rows), timeout)

    def test_fixed_query_no_filters_no_privilege_changes(self):
        self.assertEqual(m.WMI_QUERY, 'SELECT ProcessId,CommandLine FROM Win32_Process')
        source = Path(worker).read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 11))
        self.assertNotIn('AdjustTokenPrivileges', source)
        self.assertNotIn('win32com', source)


class Live(unittest.TestCase):
    def test_owned_real_raw_commandlines_and_full_native_inventory(self):
        self.assertEqual(os.name, 'nt', '显式 live 场景要求真实 Windows，不以 skip 代替')
        flags = subprocess.CREATE_NO_WINDOW
        script = "import ctypes,json,os,sys; k=ctypes.WinDLL('kernel32'); k.GetCommandLineW.restype=ctypes.c_wchar_p; print(json.dumps({'pid':os.getpid(),'raw':k.GetCommandLineW()}),flush=True); sys.stdin.buffer.read(1)"
        children = []
        try:
            for args in [['--profile', 'work', 'gateway', 'run', 'a b', '汉字😀', '\"quoted\\tail\\'],
                         ['foreign-looking-program', 'gateway', 'run', 'CommandLine=evil\r\nProcessId=9999'],
                         ['long-commandline', '汉😀' * 7000]]:
                child = subprocess.Popen([sys.executable, '-I', '-B', '-c', script, *args], stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=flags)
                children.append(child)
                ready = json.loads(child.stdout.readline())
                child.ready = ready
            begin = time.monotonic()
            result = subprocess.run([sys.executable, '-I', '-B', worker], capture_output=True, timeout=15,
                creationflags=flags)
            elapsed = (time.monotonic() - begin) * 1000
            self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
            listing = result.stdout.decode('utf-8')
            item = json.loads(Path(contracts).read_text(encoding='utf-8'))[0]
            ns = {'contextlib': contextlib}; exec(item['parser'], ns)
            native = dict(ns['_iter_windows_list_processes'](listing))
            self.assertGreater(len(native), len(children))
            proofs = []
            for child in children:
                pid, raw = child.ready['pid'], child.ready['raw']
                normalized = raw.replace('\r\n', ' ').replace('\n', ' ')
                self.assertEqual(native.get(pid), normalized, '自有 PID 的原始完整命令行不一致；不打印宿主清单')
                proofs.append({'pid': pid, 'rawSha256': hashlib.sha256(raw.encode()).hexdigest(),
                    'rawUtf16Units': len(raw.encode('utf-16-le')) // 2, 'exact': True})
            receipts.append({'case': m.BACKEND + '-full-table-owned-children', 'elapsedMs': round(elapsed, 3),
                'processCount': len(native), 'providerNullOrEmpty': sum(not value for value in native.values()),
                'listingBytes': len(result.stdout), 'owned': proofs, 'hostCommandlinesPersisted': False})
        finally:
            for child in children:
                if child.poll() is None:
                    child.stdin.write('x'); child.stdin.flush()
                child.wait(timeout=3)
                child.stdout.close(); child.stderr.close(); child.stdin.close()
            receipts.append({'case': 'owned-cleanup', 'allExited': all(c.poll() == 0 for c in children)})


suite = unittest.defaultTestLoader.loadTestsFromTestCase(Live if mode == 'live' else Contract)
result = unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'scope': 'isolated-component-not-Hermes-or-VM-qualification', 'qualificationPass': False,
    'python': sys.version, 'tests': result.testsRun, 'failures': len(result.failures) + len(result.errors),
    'skips': len(result.skipped), 'receipts': receipts}))
raise SystemExit(not result.wasSuccessful())
