# 只启动/停止本测试的私有Python和回环socket；不安装Hermes、不读注册表、不查询宿主进程表。
import ast
import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import types
from typing import Any, Optional
import psutil

payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
fixture = payload['fixture']
result = dict(scope='fixed-native-stop-live-owned-child-not-Hermes-qualification', cases=[], qualificationPass=False)
child_source = r'''
import ast,hashlib,inspect,json,os,re,socket,sys,types
from pathlib import Path
import psutil
d=json.loads(sys.stdin.buffer.readline().decode('utf-8'));f=d['fixture']
root,home=Path(sys.argv[1]),Path(sys.argv[2]);name=d['name'];active=home if name=='default' else home/'profiles'/name
g=types.ModuleType('gateway');g.__path__=[];s=types.ModuleType('gateway.status');g.status=s
sys.modules.update({'gateway':g,'gateway.status':s})
tree=ast.parse(f['status']['functions']);nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_build_pid_record']
s.__dict__.update(os=os,sys=sys,_GATEWAY_KIND='hermes-gateway',_record_argv=lambda:list(sys.argv),_get_process_start_time=lambda pid:round(psutil.Process(pid).create_time()*100),_canonical_hermes_home=lambda x:x,_get_process_hermes_home=lambda:active)
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<fixed-native-pid-factory>','exec'),s.__dict__)
def match(record,pid,*,expected_home=None):return False
s._record_matches_live_gateway_pid=match
h=types.ModuleType('hermes_cli');h.__path__=[];l=types.ModuleType('hermes_cli._launchers');h._launchers=l
l.resolve_store_python=lambda root,publication=True:Path(sys.executable)
sys.modules.update({'hermes_cli':h,'hermes_cli._launchers':l})
ns=dict(Path=Path,inspect=inspect,hashlib=hashlib,re=re,PIN=f['pin'])
def require(condition,message):
 if not condition:raise RuntimeError(message)
ns['require']=require
if d['identity']:
 exec(d['identity'],ns);ns['install_private_gateway_identity'](root,home,d['child_source'])
sys.argv=[str(root/'hermes_cli/main.py'),'--profile',name,'gateway','run']
record=s._build_pid_record();server=socket.socket();server.bind(('127.0.0.1',0));server.listen(1)
print(json.dumps(dict(record=record,port=server.getsockname()[1])),flush=True)
connection,_=server.accept()
with connection:
 assert connection.recv(4)==b'STOP';connection.sendall(b'BYE')
server.close()
'''

def load_native(home, current, record):
    options = types.ModuleType('hermes_state_holders'); exec(fixture['options']['source'], options.__dict__)
    sys.modules[options.__name__] = options
    inline = {}; exec(fixture['inline']['source'], inline)
    gateway = types.ModuleType('gateway'); gateway.__path__ = []
    status = types.ModuleType('gateway.status'); gateway.status = status
    status.__dict__.update(dict(Any=Any, Optional=Optional, Path=Path, shlex=shlex, **{k:inline[k] for k in ['command_line_runs_inline_source','inline_bootstrap_argv','inline_source_flag_index']}))
    exec(fixture['status']['functions'], status.__dict__)
    sys.modules.update({'gateway': gateway, 'gateway.status': status})
    status._GATEWAY_KIND = 'hermes-gateway'
    status._read_process_cmdline = lambda pid: ' '.join(psutil.Process(pid).cmdline())
    status._record_argv = lambda: []
    status._get_process_hermes_home = lambda: current
    status._host_gateway_serves_home = lambda *a: False
    status._command_line_belongs_to_profile = lambda command, expected: expected == current
    status._get_process_start_time = lambda pid: round(psutil.Process(pid).create_time() * 100)
    status._get_pid_path = lambda: current / 'gateway.pid'
    status._get_gateway_lock_path = lambda p: current / 'gateway.lock'
    status.is_gateway_runtime_lock_active = lambda p: True
    status._live_pid_from_record = lambda r: r['pid'] if r and psutil.pid_exists(r['pid']) else None
    status._pid_record_belongs_to_current_profile = lambda r: r.get('hermes_home') == str(current)
    status.recorded_gateway_home_conflicts = lambda r, expected_home: r.get('hermes_home') != str(expected_home)
    status.get_runtime_status_running_pid = lambda: None
    status._cleanup_invalid_pid_path = lambda *a, **kw: None
    status._read_pid_record = status._read_gateway_lock_record = lambda p: record
    return status

with tempfile.TemporaryDirectory(prefix='hermes-owned-stop-') as tmp:
    home = Path(tmp).resolve(); root = home / 'hermes-agent'; (root / 'hermes_cli').mkdir(parents=True)
    (root / 'hermes_cli/main.py').touch()
    tools = home / 'tools'; tools.mkdir(); python = tools / Path(sys.executable).name
    # 复制已有解释器而非venv redirector；仅此测试临时目录，不运行pip/安装器或写PATH。
    source_python = Path(sys.base_prefix) / ('python.exe' if os.name == 'nt' else 'bin/python3')
    if not source_python.exists(): source_python = Path(sys.executable).resolve()
    shutil.copy2(source_python, python)
    if os.name == 'nt':
        for pattern in ('python*.dll', 'vcruntime*.dll'):
            for dll in Path(sys.base_prefix).glob(pattern): shutil.copy2(dll, tools / dll.name)
    (tools / 'pyvenv.cfg').write_text('home = ' + str(source_python.parent) + '\ninclude-system-site-packages = true\n', encoding='utf-8')
    for name in ('default', 'named'):
        active = home if name == 'default' else home / 'profiles' / name
        active.mkdir(parents=True, exist_ok=True)
        args = [str(python), '-I', '-B', '-c', child_source, str(root), str(home), fixture['pin'], '--', '--profile', name, 'gateway', 'run']
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        birth = psutil.Process(child.pid).create_time(); port = None
        try:
            child.stdin.write(json.dumps(dict(fixture=fixture, identity=payload['identity'], child_source=child_source, name=name)) + '\n'); child.stdin.close()
            line = child.stdout.readline()
            assert line, child.stderr.read()
            ready = json.loads(line); record, port = ready['record'], ready['port']
            status = load_native(home, active, record)
            original = status._record_matches_live_gateway_pid
            assert original(record, child.pid, expected_home=active) is False
            launchers = types.ModuleType('hermes_cli._launchers'); launchers.resolve_store_python = lambda root, publication=True: python
            hermes = types.ModuleType('hermes_cli'); hermes.__path__ = []; hermes._launchers = launchers
            sys.modules.update({'hermes_cli': hermes, 'hermes_cli._launchers': launchers})
            ns = dict(Path=Path, inspect=inspect, hashlib=hashlib, re=re, PIN=fixture['pin'])
            def require(condition, message):
                if not condition: raise RuntimeError(message)
            ns['require'] = require
            restore = lambda: None
            if payload['identity']:
                exec(payload['identity'], ns); restore = ns['install_private_gateway_identity'](root, home, child_source)
            assert status.get_running_pid(cleanup_stale=False) == child.pid, '原生识别漏掉真实owned子进程'
            # 同厘秒的错误精确birth也必须拒绝；不改原PID/原fingerprint字段。
            original_birth = record['clawpanel_pm_identity']['create_time']
            record['clawpanel_pm_identity']['create_time'] += 0.0001
            assert status.get_running_pid(cleanup_stale=False) is None
            record['clawpanel_pm_identity']['create_time'] = original_birth
            cli = types.ModuleType('hermes_cli.gateway'); cli.__dict__.update(os=os, time=__import__('time'), logger=types.SimpleNamespace(debug=lambda *a:None))
            exec(fixture['cli']['functions'], cli.__dict__)
            cli.is_windows = lambda: True
            cli._reap_unsupervised_gateway_orphans = lambda **kw: False
            win = types.ModuleType('hermes_cli.gateway_windows')
            def drain(pid, timeout):
                assert pid == child.pid and psutil.Process(pid).create_time() == birth
                with socket.create_connection(('127.0.0.1', port), timeout=2) as connection:
                    connection.sendall(b'STOP'); assert connection.recv(3) == b'BYE'
                child.wait(timeout=5); return True
            win._drain_gateway_pid = drain; win._windows_stop_drain_timeout = lambda: 30
            win._force_terminate_known_gateway_pids = lambda *a: (_ for _ in ()).throw(AssertionError('不准宽泛force kill'))
            sys.modules['hermes_cli.gateway_windows'] = win
            status.get_process_start_time = status._get_process_start_time
            status._pid_exists = psutil.pid_exists; status.remove_pid_file = lambda: None
            stopped = cli.stop_profile_gateway()
            assert stopped and child.poll() == 0
            with socket.socket() as connection: closed = connection.connect_ex(('127.0.0.1', port)) != 0
            assert closed
            result['cases'].append(dict(profile=name, pid=child.pid, createTime=birth, originalRejected=True, nativeStop=stopped, pidExited=True, portClosed=closed, realCmdlineSha256=hashlib.sha256(subprocess.list2cmdline(args).encode()).hexdigest()))
            restore()
        finally:
            if child.poll() is None:
                if port is not None:
                    with socket.create_connection(('127.0.0.1', port), timeout=2) as connection: connection.sendall(b'STOP'); connection.recv(3)
                elif psutil.Process(child.pid).create_time() == birth:
                    child.terminate()
                child.wait(timeout=5)
print(json.dumps(result))
