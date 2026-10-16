# 自有私有base/venv + 固定官方spawn_server真实Job；不安装Hermes，不启动GUI或系统任务。
import ast, contextlib, ctypes, hashlib, importlib.util, json, os
from pathlib import Path
import shutil, subprocess, sys, tempfile, time, types, venv, zipfile

if os.environ.get('OWNED_WMI_JOB_CHILD') == '1':
    helper, processes, site, contracts = map(Path, sys.argv[1:5])
    # 仅控制器复用已安装psutil；真正-I/-B COM worker只依赖私有stdlib。
    sys.path.insert(0, str(site))
    import psutil
    expected = '763c450a9fe8b7eea5684576564b1fe8ffd58d6c16fc444dfd5e3b14986efb2b'
    assert hashlib.sha256(processes.read_bytes()).hexdigest() == expected
    def load(name, file):
        spec = importlib.util.spec_from_file_location(name, file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    p, m = load('owned_original_processes', processes), load('owned_cim', helper)
    own = json.loads(sys.stdin.buffer.read())
    launches, jobs, children = [], [], []
    def spawn(args, **kwargs):
        assert args[0] == sys.executable and args[1:4] == ['-I', '-B', '-c']
        assert len(args) == 5 and kwargs['stdin'] == subprocess.DEVNULL
        assert Path(args[0]).resolve() == Path(own['venv']).resolve()
        proc, job = p.spawn_server(args, **kwargs)
        assert job is not None
        children.append(proc); jobs.append(job)
        launches.append({'programIsPrivateVenv': True, 'isolated': True, 'noBytecode': True,
            'wireUtf16WithNul': len(subprocess.list2cmdline(args).encode('utf-16-le')) // 2 + 1,
            'backend': 'stdlib-local-wmi-com', 'pid': proc.pid})
        return proc, job
    def original(*a, **kw): raise AssertionError('live case must not spawn WMIC/PS')
    def drain(proc, timeout):
        if proc.poll() is None: proc.kill()
        proc.communicate(timeout=timeout)
    c = types.SimpleNamespace(bounded_probe_run=original, windows_hide_flags=lambda: subprocess.CREATE_NO_WINDOW,
        _close_job=lambda job: job.close() if job else None, kill_and_drain=drain)
    g = types.SimpleNamespace(_windows_process_listing=original)
    from unittest.mock import patch
    with patch('shutil.which', return_value=None):
        restore = m.install_windows_cim_probe(g, c, spawn)
        started = time.monotonic()
        try: listing = g._windows_process_listing()
        finally: restore()
        elapsed = (time.monotonic() - started) * 1000
    contract = json.loads(contracts.read_text(encoding='utf-8'))[0]
    assert hashlib.sha256(contract['parser'].encode()).hexdigest() == contract['parserSha256']
    ns = {'contextlib': contextlib}; exec(contract['parser'], ns)
    inventory = dict(ns['_iter_windows_list_processes'](listing))
    assert len(inventory) > len(own['children'])
    proofs = []
    for item in own['children']:
        assert inventory.get(item['pid']) == item['raw'].replace('\r\n', ' ').replace('\n', ' ')
        proofs.append({'pid': item['pid'], 'exact': True, 'rawSha256': hashlib.sha256(item['raw'].encode()).hexdigest(),
            'rawUtf16Units': len(item['raw'].encode('utf-16-le')) // 2})
    saved_worker = m.HERMES_WINDOWS_WMI_WORKER
    failures = []
    for kind, code, deadline in [('partial-error', "print('CommandLine=partial');raise SystemExit(1)", 15),
            ('partial-exit-zero', "print('CommandLine=partial')", 15),
            ('getter-deadline-15', 'import time;time.sleep(20)', 15),
            ('timeout', 'import time;time.sleep(20)', .2)]:
        m.HERMES_WINDOWS_WMI_WORKER = code
        restore = m.install_windows_cim_probe(g, c, spawn)
        t = time.monotonic()
        try:
            if kind == 'timeout':
                result = c.bounded_probe_run(['powershell.exe', '-NoProfile', '-Command', own['query']], timeout=deadline)
                assert result is None
            else:
                with patch('shutil.which', return_value=None):
                    try: g._windows_process_listing()
                    except SystemExit: pass
                    else: raise AssertionError('partial worker inventory accepted')
        finally: restore()
        duration = (time.monotonic() - t) * 1000
        assert kind != 'timeout' or duration < 1500
        assert kind != 'getter-deadline-15' or 14900 <= duration < 17000
        failures.append({'case': kind, 'rejected': True, 'elapsedMs': round(duration, 3)})
    m.HERMES_WINDOWS_WMI_WORKER = saved_worker
    assert all(proc.poll() is not None for proc in children)
    assert all(job._handle is None for job in jobs)
    assert Path(psutil.Process().exe()).resolve() == Path(own['base']).resolve()
    assert g._windows_process_listing is original and c.bounded_probe_run is original
    print(json.dumps({'scope': 'private-venv-original-Job-component-not-Hermes-or-VM', 'qualificationPass': False,
        'python': sys.version, 'elapsedMs': round(elapsed, 3), 'processCount': len(inventory),
        'listingCharacters': len(listing), 'owned': proofs, 'launches': launches,
        'negativeCases': failures, 'jobsClosed': True, 'childrenExited': True, 'baseVsVenvVerified': True,
        'powershellSpawned': False, 'hostCommandlinesPersisted': False}))
    raise SystemExit(0)

helper, processes, contracts = map(Path, sys.argv[1:4])
assert os.name == 'nt'
import psutil
before = dict(os.environ)
with tempfile.TemporaryDirectory(prefix='cp-wmi-private-job-') as tmp:
    root = Path(tmp).resolve()
    store = root / '.hermes-runtime/python/owned-existing-python'
    store.mkdir(parents=True)
    base = store / 'python.exe'
    shutil.copy2(Path(sys.base_prefix) / 'python.exe', base)
    for pattern in ('python*.dll', 'vcruntime*.dll'):
        for file in Path(sys.base_prefix).glob(pattern): shutil.copy2(file, store / file.name)
    lib = Path(sys.base_prefix) / 'Lib'
    with zipfile.ZipFile(store / f'python{sys.version_info.major}{sys.version_info.minor}.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in lib.rglob('*.py'):
            if not any(part in {'site-packages', '__pycache__', 'test', 'tests', 'tkinter', 'idlelib', 'turtledemo'} for part in file.relative_to(lib).parts):
                archive.write(file, file.relative_to(lib).as_posix())
    shutil.copytree(Path(sys.base_prefix) / 'DLLs', store / 'DLLs')
    venv.create(root / 'venv', with_pip=False, symlinks=False)
    vp = root / 'venv/Scripts/python.exe'
    (root / 'venv/pyvenv.cfg').write_text(f'home = {store}\ninclude-system-site-packages = false\nexecutable = {base}\n')
    ready_script = "import ctypes,json,os,sys;k=ctypes.WinDLL('kernel32');k.GetCommandLineW.restype=ctypes.c_wchar_p;print(json.dumps({'pid':os.getpid(),'raw':k.GetCommandLineW()}),flush=True);sys.stdin.buffer.read(1)"
    children, ready = [], []
    try:
        for args in [['--profile', 'work', 'gateway', 'run', '汉字😀', 'a b', '\\"tail\\'],
                ['foreign-looking', 'gateway', 'run', 'CommandLine=evil\r\nProcessId=9999'], ['long-argv', '汉😀' * 7000]]:
            child = subprocess.Popen([str(vp), '-I', '-B', '-c', ready_script, *args], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
            children.append(child)
            line = child.stdout.readline()
            assert line, child.stderr.read()
            ready.append(json.loads(line))
        source = Path(__file__).read_text(encoding='utf-8')
        query = next(n.value.value for n in ast.walk(ast.parse(helper.read_text(encoding='utf-8')))
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'query' for t in n.targets))
        args = [str(vp), '-I', '-B', '-c', source, str(helper), str(processes), str(Path(psutil.__file__).parent.parent), str(contracts)]
        payload = {'children': ready, 'venv': str(vp), 'base': str(base), 'query': query}
        r = subprocess.run(args, input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8', timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW, env={**os.environ, 'OWNED_WMI_JOB_CHILD': '1'})
        assert r.returncode == 0, r.stderr
        report = json.loads(r.stdout)
    finally:
        for child in children:
            if child.poll() is None: child.stdin.write('x'); child.stdin.flush()
            child.wait(timeout=3)
            child.stdin.close(); child.stdout.close(); child.stderr.close()
    assert dict(os.environ) == before
    report.update(ownedCleanup=all(p.poll() == 0 for p in children), parentEnvUnchanged=True)
    print(json.dumps(report))
