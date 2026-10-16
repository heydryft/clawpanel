# 固定上游原函数契约；所有进程/文件状态均在本隔离上下文，不查询宿主进程表。
import ast
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import types
from typing import Any, Optional

payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
script, fixture = payload['script'], payload['fixture']
group = sys.argv[1]
tree = ast.parse(script)
nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'require', 'install_private_gateway_identity'}]
scope = dict(Path=Path, os=os, sys=sys, inspect=inspect, hashlib=hashlib, re=re, json=json, PIN=fixture['pin'])
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<actual-private-identity>', 'exec'), scope)
# 执行实际launcher的固定嵌入加载器，逐字节核对公开可审查源，不另造测试实现。
loader = [n for n in ast.walk(tree) if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_gateway_identity_code' for t in n.targets)]
if loader:
    exec(compile(ast.Module(body=loader, type_ignores=[]), '<actual-identity-loader>', 'exec'), scope)
    assert scope['_gateway_identity_code'].decode('utf-8') == payload['identity']
    exec(scope['_gateway_identity_code'], scope)
options = types.ModuleType('hermes_state_holders')
exec(fixture['options']['source'], options.__dict__)
sys.modules[options.__name__] = options
inline = {}
exec(fixture['inline']['source'], inline)
gateway = types.ModuleType('gateway'); gateway.__path__ = []
status = types.ModuleType('gateway.status')
status.__dict__.update(dict(Any=Any, Optional=Optional, Path=Path, shlex=shlex, **{k: inline[k] for k in ['command_line_runs_inline_source', 'inline_bootstrap_argv', 'inline_source_flag_index']}))
exec(fixture['status']['functions'], status.__dict__)
gateway.status = status
sys.modules.update({'gateway': gateway, 'gateway.status': status})
hermes = types.ModuleType('hermes_cli'); hermes.__path__ = []
launchers = types.ModuleType('hermes_cli._launchers')
hermes._launchers = launchers
sys.modules.update({'hermes_cli': hermes, 'hermes_cli._launchers': launchers})
events = []
with tempfile.TemporaryDirectory(prefix='hermes-pm-stop-') as tmp:
    home = Path(tmp).resolve(); root = home / 'hermes-agent'; root.mkdir()
    (root / 'hermes_cli').mkdir(); (root / 'hermes_cli/main.py').touch()
    selected = home / 'tools/python.exe'; selected.parent.mkdir(); selected.touch()
    launchers.resolve_store_python = lambda root, publication=True: selected
    birth = 1000.125
    target = dict(pid=901, birth=birth, exe=str(selected), command=[str(selected), '-I', '-B', '-c', script, str(root), str(home), fixture['pin'], '--', 'gateway', 'run'], running=True, user='fixture-owner')
    caller_pid = 901
    class Process:
        def __init__(self, pid=None): self.pid = caller_pid if pid is None else pid; self.birth = target['birth']
        def create_time(self): return self.birth
        def cmdline(self): return target['command'][:]
        def exe(self): return target['exe']
        def username(self):
            if self.pid == 901 and target.pop('reuse_on_username', False): target['birth'] += 0.001
            return target['user'] if self.pid == 901 else 'fixture-owner'
        def is_running(self): return target['running'] and self.birth == target['birth']
    psutil = types.ModuleType('psutil'); psutil.Process = Process
    sys.modules['psutil'] = psutil
    current = home
    native_argv = [str(root / 'hermes_cli/main.py'), '--profile', 'default', 'gateway', 'run']
    status._GATEWAY_KIND = 'hermes-gateway'
    status.os = types.SimpleNamespace(getpid=lambda: 901)
    status._record_argv = lambda: native_argv[:]
    status._get_process_start_time = lambda pid: round(target['birth'] * 100)
    status._get_process_hermes_home = lambda: current
    status._canonical_hermes_home = lambda p: p
    status._read_process_cmdline = lambda pid: ' '.join(target['command'])
    status._host_gateway_serves_home = lambda *a: False
    status._command_line_belongs_to_profile = lambda command, expected: expected == current
    status._get_pid_path = lambda: current / 'gateway.pid'
    status._get_gateway_lock_path = lambda p: current / 'gateway.lock'
    status.is_gateway_runtime_lock_active = lambda p: True
    status._live_pid_from_record = lambda r: r['pid'] if r and target['running'] else None
    status._pid_record_belongs_to_current_profile = lambda r: r.get('hermes_home') == str(current)
    status.recorded_gateway_home_conflicts = lambda r, expected_home: r.get('hermes_home') != str(expected_home)
    status.get_runtime_status_running_pid = lambda: None
    status._cleanup_invalid_pid_path = lambda *a, **kw: events.append('cleanup')
    original_match = status._record_matches_live_gateway_pid
    original_build = status._build_pid_record
    install = scope.get('install_private_gateway_identity')
    restore = install(root, home, script) if install else lambda: None
    record = status._build_pid_record()
    caller_pid = 1901
    status._read_pid_record = status._read_gateway_lock_record = lambda p: record
    cli = types.ModuleType('hermes_cli.gateway')
    cli.__dict__.update(dict(os=status.os, time=types.SimpleNamespace(sleep=lambda seconds: None), logger=types.SimpleNamespace(debug=lambda *a: None)))
    exec(fixture['cli']['functions'], cli.__dict__)
    cli._append_unique_pid = lambda pids, pid, excluded: pids.append(pid) if pid and pid not in excluded and pid not in pids else None
    cli._get_service_pids = lambda **kw: []
    cli.supports_systemd_services = lambda: False
    cli._scan_gateway_pids = lambda *a, **kw: []
    cli.is_windows = lambda: True
    cli._reap_unsupervised_gateway_orphans = lambda **kw: False
    def drain(pid, timeout):
        events.append(('native-drain', pid)); target['running'] = False; return True
    win = types.ModuleType('hermes_cli.gateway_windows')
    win._drain_gateway_pid = drain
    win._windows_stop_drain_timeout = lambda: 30
    win._force_terminate_known_gateway_pids = lambda *a: (_ for _ in ()).throw(AssertionError('unexpected force kill'))
    sys.modules['hermes_cli.gateway_windows'] = win
    status.get_process_start_time = status._get_process_start_time
    status._pid_exists = lambda pid: target['running']
    status.remove_pid_file = lambda: events.append('native-remove')
    passed = 0
    def accepted(): return status._record_matches_live_gateway_pid(record, 901, expected_home=current)
    if group == 'native':
        assert original_match(record, 901, expected_home=current) is False, '原固定matcher必须真实拒绝私有wrapper'
        if install is None:
            assert cli.find_gateway_pids() == [] and cli.stop_profile_gateway() is False
            print('原生find_gateway_pids=[]，原生STOP=False，目标仍活；未调用任何kill/drain', file=sys.stderr)
        assert status.get_running_pid(cleanup_stale=False) == 901, '原生get_running_pid漏掉仍活的精确私有wrapper'
        assert cli.find_gateway_pids() == [901]
        assert cli.stop_profile_gateway() is True, '原生STOP未到达drain'
        assert ('native-drain', 901) in events
        assert all('force' not in str(x) for x in events)
        passed = 5
    elif group == 'negative':
        assert accepted(), '精确wrapper正对照失败'
        baseline = copy.deepcopy(target); original_record = copy.deepcopy(record)
        mutations = [
            ('script', lambda: target['command'].__setitem__(4, script + '\n# foreign')),
            ('pin', lambda: target['command'].__setitem__(7, '0' * 40)),
            ('root', lambda: target['command'].__setitem__(5, str(home))),
            ('home', lambda: target['command'].__setitem__(6, str(root))),
            ('mode', lambda: target['command'].__setitem__(8, '--portable')),
            ('python-argv', lambda: target['command'].__setitem__(0, str(root / 'foreign.exe'))),
            ('exe', lambda: target.__setitem__('exe', str(root / 'foreign.exe'))),
            ('not-c', lambda: target['command'].__setitem__(3, '-m')),
            ('not-run', lambda: target['command'].__setitem__(-1, 'stop')),
            ('trailing', lambda: target['command'].append('--replace')),
            ('profile', lambda: target['command'].extend(['--profile', 'foreign'])),
            ('duplicate-profile', lambda: target['command'].extend(['--profile', 'default', '-p', 'default'])),
            ('foreign-record-home', lambda: record.__setitem__('hermes_home', str(root))),
            ('record-argv', lambda: record['argv'].__setitem__(2, 'foreign')),
            ('record-pid', lambda: record.__setitem__('pid', 902)),
            ('unreadable-cmdline', lambda: target.__setitem__('command', [])),
            ('foreign-user', lambda: target.__setitem__('user', 'foreign-owner')),
            ('source-alias', lambda: target['command'].__setitem__(5, str(root / '..' / root.name))),
            ('missing-precise-birth', lambda: record['clawpanel_pm_identity'].pop('create_time')),
            ('wrong-proof-hash', lambda: record['clawpanel_pm_identity'].__setitem__('script_sha256', '0' * 64)),
            ('dead', lambda: target.__setitem__('running', False)),
            ('reused', lambda: target.__setitem__('birth', birth + 1)),
            ('reused-same-centisecond', lambda: target.__setitem__('birth', birth + 0.001)),
            ('reused-after-is-running-cache', lambda: target.__setitem__('reuse_on_username', True)),
        ]
        for name, mutate in mutations:
            target.clear(); target.update(copy.deepcopy(baseline)); record.clear(); record.update(copy.deepcopy(original_record))
            mutate(); assert not accepted(), name; passed += 1
        target.clear(); target.update(copy.deepcopy(baseline)); record.clear(); record.update(copy.deepcopy(original_record))
        target['command'] = ['python', '-m', 'hermes_cli.main', 'gateway', 'run']
        assert original_match(record, 901, expected_home=current) is True
        assert not accepted(), '带私有proof的记录不准通过宽松native fallback'; passed += 1
        target.clear(); target.update(copy.deepcopy(baseline)); record.clear(); record.update(copy.deepcopy(original_record))
        saved = current; current = root
        assert not accepted(), 'foreign queried profile accepted'; current = saved; passed += 1
        # 原工厂原字段保持；额外精确birth必须是实际Process回读，不用厘秒冒充。
        original = original_build()
        assert all(record[k] == v for k, v in original.items())
        assert record.get('clawpanel_pm_identity', {}).get('create_time') == birth
        passed += 2
    else:
        assert status.looks_like_gateway_command_line('python -m hermes_cli.main gateway run')
        target['command'] = ['python', '-m', 'hermes_cli.main', 'gateway', 'run']
        record.pop('clawpanel_pm_identity', None)
        assert accepted(), '原生canonical fallback丢失'
        restore()
        assert status._record_matches_live_gateway_pid is original_match
        assert status._build_pid_record is original_build
        passed = 4
    print(json.dumps(dict(scope='fixed-upstream-contract-not-Windows-qualification', group=group, passed=passed, nativeStopActions=events)))
