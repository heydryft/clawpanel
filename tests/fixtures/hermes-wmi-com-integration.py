# 失败先行：只操作本进程替身/自有子进程，不安装内核或运行宿主命令。
import ast, importlib.util, json, os, subprocess, sys, types, unittest
from pathlib import Path
from unittest.mock import patch

source = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('owned_cim', source)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
QUERY = """Get-CimInstance Win32_Process | ForEach-Object {   'CommandLine=' + ($_.CommandLine -replace "<BT>r<BT>n",' ' -replace "<BT>n",' ');   'ProcessId=' + $_.ProcessId;   '' }""".replace('<BT>', chr(96))
ARGV = ['powershell.exe', '-NoProfile', '-Command', QUERY]
GOOD = 'CommandLine=完整汉😀 "a b"\nProcessId=42\n\nCommandLine=\nProcessId=0\n\n'
receipts = []


class Adapter(unittest.TestCase):
    def setUp(self):
        self.calls, self.jobs = [], []
        self.output, self.code, self.wmic = GOOD, 0, None
        self.wmic_result = subprocess.CompletedProcess([], 0, GOOD, '')
        self.spawn_error, self.no_job = False, False
        self.parent = dict(os.environ)

        def original(argv, **kw):
            self.calls.append(('original', argv, kw))
            return self.wmic_result

        def listing():
            raise AssertionError('原getter依赖PowerShell，必须窄接getter而非只拦4argv')

        self.original, self.listing = original, listing
        self.c = types.SimpleNamespace(bounded_probe_run=original, windows_hide_flags=lambda: 0,
            _close_job=lambda job: job.close() if job else None, kill_and_drain=lambda p, t: None)
        self.g = types.SimpleNamespace(_windows_process_listing=listing)
        self.restore = None

    def install(self):
        self.which = patch('shutil.which', side_effect=lambda name: self.wmic if name == 'wmic' else None)
        self.which.start()
        self.addCleanup(self.which.stop)
        self.restore = m.install_windows_cim_probe(self.g, self.c, self.spawn, platform='nt')
        self.addCleanup(self.restore)

    def spawn(self, argv, **kw):
        self.calls.append(('spawn', argv, kw))
        if self.spawn_error:
            raise OSError('owned spawn failure')
        outer = self

        class Proc:
            pid, returncode = 123, self.code
            def communicate(self, timeout): return outer.output, ''
            def poll(self): return self.returncode

        class Job:
            closes = 0
            def close(self): self.closes += 1

        job = Job()
        self.jobs.append(job)
        return Proc(), None if self.no_job else job

    def test_no_wmic_no_powershell_uses_complete_local_com(self):
        self.install()
        self.assertEqual(self.g._windows_process_listing(), GOOD)
        self.assertEqual([v[0] for v in self.calls], ['spawn'])
        argv, kw = self.calls[0][1:]
        self.assertEqual(argv, [sys.executable, '-I', '-B', '-c', m.HERMES_WINDOWS_WMI_WORKER])
        self.assertEqual(kw['encoding'], 'utf-8')
        self.assertEqual(kw['stdin'], subprocess.DEVNULL)
        self.assertEqual(kw['stdout'], subprocess.PIPE)
        self.assertEqual(kw['stderr'], subprocess.PIPE)
        self.assertTrue(kw['text'])
        self.assertEqual(dict(os.environ), self.parent)
        self.assertEqual(self.jobs[0].closes, 1)

    def test_wmic_first_exact_original_fast_path(self):
        self.wmic = 'C:/Windows/System32/wbem/WMIC.exe'
        self.install()
        self.assertEqual(self.g._windows_process_listing(), GOOD)
        self.assertEqual(self.calls, [('original', [self.wmic, 'process', 'get', 'ProcessId,CommandLine', '/FORMAT:LIST'], {'timeout': 10, 'errors': 'ignore'})])

    def test_known_wmic_failures_fallback_only_to_com(self):
        self.wmic = 'WMIC.exe'
        self.install()
        for result in [None, subprocess.CompletedProcess([], 1, 'partial', ''), subprocess.CompletedProcess([], 0, '', '')]:
            with self.subTest(result=result):
                self.calls.clear()
                self.wmic_result = result
                self.assertEqual(self.g._windows_process_listing(), GOOD)
                self.assertEqual([v[0] for v in self.calls], ['original', 'spawn'])
                self.assertNotIn('powershell', self.calls[1][1][0].lower())

    def test_wmic_unknown_exception_is_not_empty_success(self):
        self.wmic = 'WMIC.exe'
        self.install()
        def unknown(*args, **kw): raise PermissionError('unknown')
        # 安装时捕获的原接口必须有真实异常，而非安装后替换逃过本适配器。
        self.restore()
        self.c.bounded_probe_run = unknown
        self.restore = m.install_windows_cim_probe(self.g, self.c, self.spawn, platform='nt')
        self.addCleanup(self.restore)
        with self.assertRaises(SystemExit): self.g._windows_process_listing()
        self.assertEqual(self.calls, [])

    def test_fixed_cim_retains_completed_process_args(self):
        self.install()
        r = self.c.bounded_probe_run(ARGV, timeout=15, errors='ignore')
        self.assertEqual(r.args, ARGV)
        self.assertEqual((r.returncode, r.stdout), (0, GOOD))

    def test_other_bounded_commands_unchanged(self):
        self.install()
        for argv, kw in [(['git', 'status'], {'timeout': 3, 'errors': 'strict'}),
                ([*ARGV[:-1], QUERY + ' '], {'timeout': 15, 'errors': 'ignore'}),
                (ARGV, {'timeout': 15, 'errors': 'ignore', 'env': {'OWNED': '1'}})]:
            with self.subTest(argv=argv):
                self.calls.clear()
                self.assertIs(self.c.bounded_probe_run(argv, **kw), self.wmic_result)
                self.assertEqual(self.calls, [('original', argv, kw)])

    def test_empty_partial_malformed_nonzero_unknown_reject(self):
        self.install()
        for out, code in [('', 0), ('CommandLine=x\n', 0), ('ProcessId=42', 0),
                ('CommandLine=x\nProcessId=bad\n\n', 0), (GOOD + 'CommandLine=partial\n', 0),
                (GOOD, 1), (GOOD + GOOD, 0), (GOOD.replace('完整', '\0'), 0), (None, 0)]:
            with self.subTest(out=out, code=code):
                self.output, self.code = out, code
                with self.assertRaises(SystemExit): self.g._windows_process_listing()

    def test_failed_wmic_partial_success_not_accepted(self):
        self.wmic = 'WMIC.exe'
        self.wmic_result = subprocess.CompletedProcess([], 0, GOOD + 'CommandLine=partial', '')
        self.install()
        with self.assertRaises(SystemExit): self.g._windows_process_listing()
        self.assertEqual(len(self.calls), 1)

    def test_spawn_or_job_failure_failclosed(self):
        self.install()
        for attr in ['spawn_error', 'no_job']:
            with self.subTest(attr=attr):
                setattr(self, attr, True)
                with self.assertRaises(SystemExit): self.g._windows_process_listing()
                setattr(self, attr, False)

    def test_output_character_limit_not_raised(self):
        self.output = 'CommandLine=' + 'x' * 1048576 + '\nProcessId=42\n\n'
        self.install()
        with self.assertRaises(SystemExit): self.g._windows_process_listing()

    def test_restore_does_not_clobber_later_owner(self):
        self.install()
        later = lambda *a, **kw: None
        self.c.bounded_probe_run = later
        self.restore()
        self.assertIs(self.c.bounded_probe_run, later)
        self.assertIs(self.g._windows_process_listing, self.listing)
        self.g._windows_process_listing = later
        self.restore()
        self.assertIs(self.g._windows_process_listing, later)

    def test_wmic10_com15_is_25_not_upper20_qualification(self):
        self.wmic = 'WMIC.exe'
        self.wmic_result = None
        self.install()
        observed = []
        # 不等待25s：这里只核真实调用预算，实际冷启动20s门禁由VM独立负责。
        class Clock:
            value = 0
            def __call__(self):
                self.value += .001
                return self.value
        with patch('time.monotonic', Clock()), patch.dict(os.environ, {'CLAWPANEL_HERMES_PHASE_TIMING': '1'}):
            import contextlib, io
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr): self.g._windows_process_listing()
            observed = [json.loads(line.split(' ', 1)[1]) for line in stderr.getvalue().splitlines()]
        self.assertEqual(self.calls[0][2]['timeout'], 10)
        self.assertEqual(next(v['deadlineMs'] for v in observed if v['event'] == 'start'), 15000)
        receipts.append({'case': 'preserved-deadlines', 'wmicSeconds': 10, 'comSeconds': 15,
            'sequentialWorstSeconds': 25, 'upperGatewaySeconds': 20, 'qualificationPass': False})

    def test_nonwindows_no_changes(self):
        restore = m.install_windows_cim_probe(self.g, self.c, self.spawn, platform='posix')
        restore()
        self.assertIs(self.c.bounded_probe_run, self.original)
        self.assertIs(self.g._windows_process_listing, self.listing)


suite = unittest.defaultTestLoader.loadTestsFromTestCase(Adapter)
r = unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'scope': 'adapter-contract-not-Hermes-VM', 'qualificationPass': False, 'tests': r.testsRun,
    'failures': len(r.failures) + len(r.errors), 'skips': len(r.skipped), 'receipts': receipts}))
raise SystemExit(not r.wasSuccessful())
