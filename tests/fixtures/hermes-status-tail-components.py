"""自有组件子进程；合成 module/进程表不是 canonical Hermes 或 VM 事实。"""
import ast
import contextlib
import hashlib
import importlib.machinery
import inspect
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import types

data = json.loads(sys.stdin.buffer.read().decode('utf8'))
ns = {'__name__': 'owned_tail_component'}
exec(compile(data['source'], '<owned-tail-helper>', 'exec'), ns)
group, passed = sys.argv[1], 0
names = ('_print_duplicate_credential_warnings', '_print_other_profiles_gateway_status', '_print_standalone_by_config')
source = '\n'.join('def ' + name + '():\n    return token\n' for name in names)


def owned(root, text=source):
    file = root / 'hermes_cli' / 'gateway.py'
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding='utf8')
    module = types.ModuleType('hermes_cli.gateway')
    module.__file__ = str(file)
    module.__spec__ = importlib.machinery.ModuleSpec(module.__name__, loader=None, origin=str(file))
    module.token = object()
    exec(compile(text, str(file), 'exec'), module.__dict__)
    sys.modules[module.__name__] = module
    return module, file, text.encode('utf8')


def observation(module, file, content):
    # 仅调用拆分的自有绑定组件；绝不让合成 SHA 通过正式 pinned installer。
    targets = ns['_checked_targets'](module, file, content)
    return ns['_TailObservation'](module, targets, hashlib.sha256(content).hexdigest())


def events(stream):
    return [json.loads(line.removeprefix(ns['_PREFIX'])) for line in stream.getvalue().splitlines()]


with tempfile.TemporaryDirectory(prefix='cp-tail-owned-') as temp:
    root = Path(temp).resolve()
    module, file, content = owned(root)
    out, err = io.StringIO(), io.StringIO()
    originals = {name: getattr(module, name) for name in names}
    if group == 'transparent':
        text = '''def _print_duplicate_credential_warnings():
    calls.append('return')
    print('OWNED_STDOUT')
    return token
def _print_other_profiles_gateway_status():
    calls.append('swallowed')
    try: raise error
    except ValueError: pass
    return token
def _print_standalone_by_config():
    calls.append('raise')
    raise error
'''
        module, file, content = owned(root, text)
        module.calls, module.error = [], ValueError('SECRET exception/env/path/args must not appear')
        before = dict(os.environ)
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            obs = observation(module, file, content)
            assert module._print_duplicate_credential_warnings() is module.token
            assert module._print_other_profiles_gateway_status() is module.token
            previous_traceback = module.error.__traceback__
            try: module._print_standalone_by_config()
            except ValueError as error:
                assert error is module.error
                assert error.__traceback__.tb_next.tb_frame.f_code.co_name == 'wrapped'
                assert error.__traceback__.tb_next.tb_next.tb_frame.f_code.co_name == names[2]
                assert error.__traceback__.tb_next.tb_next.tb_next is previous_traceback
            else: raise AssertionError('original exception lost')
            obs.restore()
        assert module.calls == ['return', 'swallowed', 'raise']
        assert out.getvalue() == 'OWNED_STDOUT\n' and dict(os.environ) == before
        assert [r['event'] for r in events(err)][1:7] == ['enter', 'return', 'enter', 'return', 'enter', 'raise']
        assert 'SECRET' not in err.getvalue()
        passed = 7
    elif group == 'guards':
        for pin, words in [('wrong', ['gateway', 'status']), (ns['_PIN'], ['gateway', 'run']), (ns['_PIN'], ['gateway', 'status', '--deep'])]:
            with contextlib.redirect_stderr(err): obs = ns['install_status_tail_observation'](module, root, pin, words)
            assert not obs.valid and all(getattr(module, k) is v for k, v in originals.items())
        with contextlib.redirect_stderr(err): obs = ns['install_status_tail_observation'](module, root, ns['_PIN'], ['gateway', 'status'])
        assert not obs.valid, '合成源码必须被正式固定 SHA 拒绝'
        assert all(getattr(module, k) is v for k, v in originals.items())
        for change in ['origin', 'file', 'ABI', 'code', 'module', 'globals', 'wrapped', 'defaults']:
            module, file, content = owned(root)
            f = getattr(module, names[0])
            if change == 'origin': module.__spec__.origin = str(root / 'foreign.py')
            elif change == 'file': module.__file__ = str(root / 'foreign.py')
            elif change == 'ABI': f.__code__ = compile('def x(arg): pass', str(file), 'exec').co_consts[0]
            elif change == 'code': f.__code__ = f.__code__.replace(co_consts=(None, 'foreign'))
            elif change == 'module': f.__module__ = 'foreign'
            elif change == 'globals': setattr(module, names[0], types.FunctionType(f.__code__, dict(module.__dict__), f.__name__))
            elif change == 'wrapped': f.__wrapped__ = f
            elif change == 'defaults': f.__defaults__ = (1,)
            try: ns['_checked_targets'](module, file, content)
            except (ValueError, TypeError): pass
            else: raise AssertionError('accepted ' + change)
        passed = 12
    elif group == 'restore':
        with contextlib.redirect_stderr(err):
            obs = observation(module, file, content)
            # 正式 installer 的重复接线也不得复盖原 wrapper，且须使首个 observation 无效。
            bindings = [getattr(module, k) for k in names]
            second = ns['install_status_tail_observation'](module, root, ns['_PIN'], ['gateway', 'status'])
            assert not second.valid and not obs.valid
            assert [getattr(module, k) for k in names] == bindings
            obs.restore(); obs.restore()
        assert all(getattr(module, k) is v for k, v in originals.items())
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            obs = observation(module, file, content)
            for name in names: assert getattr(module, name)() is module.token
            foreign = lambda: 'external binding'
            setattr(module, names[1], foreign)
            obs.restore()
        assert not obs.valid and getattr(module, names[1]) is foreign
        assert getattr(module, names[0]) is originals[names[0]] and getattr(module, names[2]) is originals[names[2]]
        assert events(err)[-1]['target'] == 'observer' and events(err)[-1]['event'] == 'raise'
        passed = 7
    elif group == 'logging':
        class Broken:
            def write(self, value): raise BrokenPipeError('SECRET')
            def flush(self): raise BrokenPipeError('SECRET')
        class Partial:
            def write(self, value): return len(value) - 1
            def flush(self): pass
        for sink in (Broken(), Partial()):
            module, file, content = owned(root)
            with contextlib.redirect_stderr(sink):
                obs = observation(module, file, content)
                for name in names: assert getattr(module, name)() is module.token
                obs.restore()
            assert not obs.valid
        module, file, content = owned(root)
        module.error = KeyboardInterrupt('SECRET')
        def raising(): raise module.error
        with contextlib.redirect_stderr(Broken()):
            obs = ns['_TailObservation'](module, {names[0]: raising}, hashlib.sha256(content).hexdigest())
            try: getattr(module, names[0])()
            except KeyboardInterrupt as error: assert error is module.error
            else: raise AssertionError('logging changed exception')
            obs.restore()
        module, file, content = owned(root)
        with contextlib.redirect_stderr(err):
            obs = observation(module, file, content)
            for i in range(200): assert getattr(module, names[0])() is module.token
            obs.restore()
        assert not obs.valid and len(err.getvalue().encode('utf8')) <= 8192
        assert all(len(line.encode('utf8')) + 1 <= 1024 for line in err.getvalue().splitlines())
        passed = 8
    elif group == 'validation':
        # 合成的协议正负控；从未声称其字段是实际 VM/source 回执。
        rows = []
        for i, (target, event) in enumerate([('observer', 'enter'), *[(n, e) for n in names for e in ('enter', 'return')], ('observer', 'return')], 1):
            rows.append(dict(schemaVersion=1, scope='hermes-status-tail-diagnostic', target=target, event=event, pid=101, ppid=100, elapsedMs=i, utc='2026-10-17T00:00:00.000000+00:00', sequence=i, moduleSha256=ns['_SOURCE_SHA']))
        encode = lambda rs: ''.join(ns['_PREFIX'] + json.dumps(r) + '\n' for r in rs)
        validate = lambda s: ns['validate_status_tail_events'](s, pid=101, ppid=100)
        good = validate(encode(rows))
        assert good['diagnosticValid'] and good['qualificationPass'] is False
        cases = [rows[:-1], rows[:2], rows + rows, rows[:3] + rows[4:]]
        for key, value in [('schemaVersion', 2), ('scope', 'foreign'), ('pid', 102), ('ppid', 99), ('moduleSha256', '0'*64), ('sequence', 50), ('elapsedMs', -1), ('utc', 'yesterday'), ('args', 'SECRET'), ('target', 'foreign'), ('event', 'raise')]:
            altered = [dict(r) for r in rows]; altered[3][key] = value; cases.append(altered)
        for rs in cases: assert not validate(encode(rs))['diagnosticValid']
        for s in ('', ns['_PREFIX'] + '{bad}\n', encode(rows).encode() + b'\xff', ns['_PREFIX'] + 'x'*8192): assert not validate(s)['diagnosticValid']
        assert not validate(encode(rows[:-1]))['qualificationPass']
        passed = 19
    elif group == 'no-hooks':
        tree = ast.parse(data['source'])
        banned = {'settrace', 'setprofile', '__import__', 'Popen', 'run', 'Process', 'meta_path'}
        assert not any(isinstance(n, ast.Attribute) and n.attr in banned for n in ast.walk(tree))
        assert not any(isinstance(n, (ast.Import, ast.ImportFrom)) and any('hermes' in a.name or 'gateway' in a.name for a in n.names) for n in ast.walk(tree))
        imports = set(sys.modules)
        phase = lambda name: None
        phase.__dict__.update(t=123, p=456, i=7)
        before = dict(phase.__dict__)
        with contextlib.redirect_stderr(err):
            obs = observation(module, file, content)
            for name in names: getattr(module, name)()
            obs.restore()
        assert phase.__dict__ == before and set(sys.modules) == imports
        assert obs.valid
        rows = events(err)
        assert len(rows) == 8
        fields = {'schemaVersion', 'scope', 'target', 'event', 'pid', 'ppid', 'elapsedMs', 'utc', 'sequence', 'moduleSha256'}
        assert all(set(r) == fields for r in rows)
        assert all(r['pid'] == os.getpid() and r['ppid'] == os.getppid() for r in rows)
        assert all(not inspect.signature(getattr(module, name)).parameters for name in names)
        passed = 7
    elif group == 'identity':
        # 只执行面板自有 identity adapter；所有进程/上游模块均为自有桩，没有 psutil 查询。
        owner = root; install = owner / 'hermes-agent'; install.mkdir()
        python = owner / 'tools' / 'python.exe'; python.parent.mkdir(); python.write_bytes(b'owned non executable data')
        active = owner
        status = types.ModuleType('gateway.status')
        def original(record, pid, *, expected_home=None): return False
        status._record_matches_live_gateway_pid = original
        status._get_process_hermes_home = lambda: str(active)
        status._get_process_start_time = lambda pid: 123
        status._GATEWAY_KIND = 'owned-fixture-gateway'
        status._build_pid_record = lambda: dict(pid=321, kind=status._GATEWAY_KIND, hermes_home=str(active), start_time=123, argv=[str(install / 'hermes_cli/main.py'), 'gateway', 'run'])
        gateway = types.ModuleType('gateway'); gateway.status = status
        launchers = types.ModuleType('hermes_cli._launchers'); launchers.resolve_store_python = lambda *a, **kw: python
        package = types.ModuleType('hermes_cli'); package._launchers = launchers
        process_argv = [str(python), '-I', '-B', '-c', data['diagnosticWire'], str(install), str(owner), ns['_PIN'], '--', 'gateway', 'run']
        class Process:
            pid = 321
            def __init__(self, pid=None): pass
            def create_time(self): return 1.0
            def cmdline(self): return process_argv
            def exe(self): return str(python)
            def username(self): return 'owned-fixture-user'
            def is_running(self): return True
        psutil = types.ModuleType('psutil'); psutil.Process = Process
        sys.modules.update({'gateway': gateway, 'gateway.status': status, 'hermes_cli': package, 'hermes_cli._launchers': launchers, 'psutil': psutil})
        scope = dict(hashlib=hashlib, inspect=inspect, Path=Path, re=re, PIN=ns['_PIN'])
        def require(ok, message):
            if not ok: raise ValueError(message)
        scope['require'] = require
        # 原 decoder 仅解析候选字节，绝不 exec 这些 body。
        import base64
        import zlib
        scope.update(base64=base64, zlib=zlib)
        exec(data['decoder'], scope); exec(data['identity'], scope)
        decoder = scope['decode_clawpanel_private_script_bytes']
        body = decoder(data['diagnosticWire'], ns['_PIN'])
        ast.parse(body)
        scope['_CLAWPANEL_EXECUTED_SCRIPT_BYTES'] = body
        restore = scope['install_private_gateway_identity'](install, owner, data['diagnosticWire'], script_bytes=decoder)
        record = status._build_pid_record(); assert status._record_matches_live_gateway_pid(record, 321, expected_home=owner)
        restore()
        scope['_CLAWPANEL_EXECUTED_SCRIPT_BYTES'] = decoder(data['normalWire'], ns['_PIN'])
        restore = scope['install_private_gateway_identity'](install, owner, data['normalWire'], script_bytes=decoder)
        normal_record = status._build_pid_record(); restore()
        scope['_CLAWPANEL_EXECUTED_SCRIPT_BYTES'] = body
        restore = scope['install_private_gateway_identity'](install, owner, data['diagnosticWire'], script_bytes=decoder)
        assert not status._record_matches_live_gateway_pid(normal_record, 321, expected_home=owner)
        for key in ['_CLAWPANEL_EXECUTED_SCRIPT_BYTES']:
            scope[key] = b'foreign'
            try: scope['install_private_gateway_identity'](install, owner, data['diagnosticWire'], script_bytes=decoder)
            except ValueError: pass
            else: raise AssertionError('foreign executed body accepted')
        restore(); passed = 4
    elif group == 'bare-gateway':
        # 只执行面板接线 AST；helper exec 由自有 spy 接收，绝不运行 CLI 或上游函数。
        failures = []
        tree = ast.parse(data['body'])
        gate = next(n for n in ast.walk(tree) if isinstance(n, ast.If) and n.body and
                    isinstance(n.body[0], ast.Assign) and any(isinstance(t, ast.Name) and t.id == '_cp_tail_source' for t in n.body[0].targets))
        for words in (['gateway'], ['gateway', 'run'], ['gateway', 'stop'], ['gateway', 'status', '--deep'], ['gateway', 'status']):
            calls = []
            def install(*args): calls.append(('install', args[-1])); return object()
            def helper_exec(code, scope): calls.append(('exec',)); scope['install_status_tail_observation'] = install
            def require(ok, message): assert ok, message
            scope = dict(os=types.SimpleNamespace(name='nt'), words=words, hashlib=hashlib, require=require,
                         _cp_g=module, root=root, PIN=ns['_PIN'], exec=helper_exec)
            with contextlib.redirect_stderr(err):
                exec(compile(ast.Module(body=[gate], type_ignores=[]), '<owned-composer-gate>', 'exec'), scope)
            if calls != ([('exec',), ('install', words)] if words == ['gateway', 'status'] else []):
                failures.append(('composer must not activate', words, calls))
            assert err.getvalue() == ''
        reads = []
        class OwnPath:
            def resolve(self, **kw): return self
            def __truediv__(self, child): return self
            def open(self, *args): reads.append('source-read'); raise AssertionError('bare gateway must not inspect source')
        original_path = ns['Path']
        ns['Path'] = lambda value: OwnPath()
        try:
            with contextlib.redirect_stderr(err):
                obs = ns['install_status_tail_observation'](module, root, ns['_PIN'], ['gateway'])
            if obs.valid or reads or err.getvalue():
                failures.append(('installer must not activate/read/emit', reads, obs.valid, err.getvalue()))
            assert all(getattr(module, name) is fn for name, fn in originals.items())
        finally: ns['Path'] = original_path
        assert not failures, failures
        passed = 8
    elif group == 'argv':
        units = [len(subprocess.list2cmdline(row).encode('utf-16-le')) // 2 + 1 for row in data['rows']]
        assert all(n <= 32767 for n in units), units
        ast.parse(data['body']); passed = len(units)
    elif group == 'source-ast':
        source_bytes = Path(data['upstream']).read_bytes()
        assert hashlib.sha256(source_bytes).hexdigest() == ns['_SOURCE_SHA']
        tree = ast.parse(source_bytes)
        targets = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names}
        assert set(targets) == set(names)
        assert [targets[n].lineno for n in names] == [1675, 1659, 5715]
        for n in targets.values():
            assert not n.args.posonlyargs + n.args.args + n.args.kwonlyargs and n.args.vararg is None and n.args.kwarg is None and not n.decorator_list
        cmd = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_cmd_status')
        calls = [n.value.func.id for n in cmd.body[-3:] if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)]
        assert calls == list(names)
        table = next(n.value for n in tree.body if isinstance(n, ast.Assign) and
                     any(isinstance(t, ast.Name) and t.id == '_GATEWAY_SUBCOMMANDS' for t in n.targets))
        dispatch = {key.value: value.id for key, value in zip(table.keys, table.values)}
        assert dispatch[None] == dispatch['run'] == '_cmd_run' and dispatch['status'] == '_cmd_status'
        compile(source_bytes, '<static-upstream-no-execution>', 'exec')
        passed = 8
    else: raise AssertionError('unknown component group')

result = dict(scope='own-components-not-Hermes-or-VM-proof', qualificationPass=False, group=group, passed=passed)
if group == 'argv': result['units'] = units
print(json.dumps(result))
