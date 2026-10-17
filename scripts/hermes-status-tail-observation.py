"""仅固定 Windows status 的三尾观测；不是资格、性能修复或独立采集器。"""
import datetime
import functools
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import sys
import time
import types

_PIN = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
_SOURCE_SHA = 'a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899'
_TAILS = ('_print_duplicate_credential_warnings', '_print_other_profiles_gateway_status', '_print_standalone_by_config')
_PREFIX = 'CLAWPANEL_HERMES_STATUS_TAIL '
_STEPS = tuple((name, event) for name in _TAILS for event in ('enter', 'return'))
_FIELDS = {'schemaVersion', 'scope', 'target', 'event', 'pid', 'ppid', 'elapsedMs', 'utc', 'sequence', 'moduleSha256'}
_ACTIVE = {}


def _checked_targets(module, file, source):
    # compile 只取 code 常量，绝不执行上游源码/导入其下游模块。
    if (type(module) is not types.ModuleType or module.__name__ != 'hermes_cli.gateway' or
            sys.modules.get(module.__name__) is not module or file.resolve(strict=True) != file or
            Path(module.__file__) != file or module.__spec__.name != module.__name__ or
            Path(module.__spec__.origin) != file):
        raise ValueError('tail module origin mismatch')
    code = compile(source, str(file), 'exec', dont_inherit=True)
    expected = {c.co_name: c for c in code.co_consts if type(c) is types.CodeType and c.co_name in _TAILS}
    if set(expected) != set(_TAILS):
        raise ValueError('tail source ABI mismatch')
    targets = {}
    for name in _TAILS:
        fn = module.__dict__.get(name)
        if (type(fn) is not types.FunctionType or fn.__module__ != module.__name__ or
                fn.__globals__ is not module.__dict__ or fn.__name__ != name or fn.__qualname__ != name or
                fn.__code__.co_filename != str(file) or fn.__code__ != expected[name] or
                fn.__defaults__ is not None or fn.__kwdefaults__ is not None or fn.__closure__ is not None or
                fn.__dict__ or inspect.signature(fn, follow_wrapped=False).parameters):
            raise ValueError('tail callable origin/ABI mismatch')
        targets[name] = fn
    return targets


class _TailObservation:
    def __init__(self, module, targets, source_sha):
        self.module, self.targets, self.source_sha = module, targets, source_sha
        self.wrappers = {}
        self.valid, self.closed, self.failed = module is not None, False, False
        self.sequence = self.used = self.cursor = 0
        self.origin = None
        if not self.valid:
            return
        if module in _ACTIVE:
            _ACTIVE[module].valid = self.valid = False
            return
        _ACTIVE[module] = self
        self._emit('observer', 'enter')
        for name, fn in targets.items():
            wrapper = self._wrap(name, fn)
            self.wrappers[name] = wrapper
            module.__dict__[name] = wrapper

    def _emit(self, label, event):
        # 每次单次 write+flush；短写/错误/超限只使材料无效，不影响 CLI。
        if self.failed:
            return
        try:
            if self.sequence >= 24:
                raise ValueError('tail event count exceeded')
            self.sequence += 1
            stamp = time.perf_counter_ns()
            if self.origin is None:
                self.origin = stamp
            row = dict(schemaVersion=1, scope='hermes-status-tail-diagnostic', target=label, event=event,
                       pid=os.getpid(), ppid=os.getppid(), elapsedMs=round((stamp-self.origin)/1e6, 3),
                       utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       sequence=self.sequence, moduleSha256=self.source_sha)
            line = _PREFIX + json.dumps(row, separators=(',', ':')) + '\n'
            size = len(line.encode('utf8'))
            if size > 1024 or self.used + size > 8192:
                raise ValueError('tail event bytes exceeded')
            self.used += size
            if sys.stderr.write(line) != len(line):
                raise OSError('tail short write')
            sys.stderr.flush()
        except BaseException:
            self.valid, self.failed = False, True

    def _note(self, name, event):
        if self.cursor >= len(_STEPS) or _STEPS[self.cursor] != (name, event):
            self.valid = False
        self.cursor += 1
        self._emit(name, event)

    def _wrap(self, name, fn):
        @functools.wraps(fn)
        def wrapped():
            self._note(name, 'enter')
            try:
                result = fn()
            except BaseException:
                self._note(name, 'raise')
                raise
            self._note(name, 'return')
            return result
        return wrapped

    def restore(self):
        if self.closed:
            return
        self.closed = True
        for name, wrapper in self.wrappers.items():
            if self.module.__dict__.get(name) is wrapper:
                self.module.__dict__[name] = self.targets[name]
            else:
                self.valid = False
        if self.module is not None and _ACTIVE.get(self.module) is self:
            del _ACTIVE[self.module]
        self.valid = self.valid and self.cursor == len(_STEPS)
        if self.module is not None:
            self._emit('observer', 'return' if self.valid else 'raise')


def install_status_tail_observation(module, root, pin, words):
    # 调用者已正常导入/CIM 安装；不补导入，不放松原 PM/身份准入。
    previous = _ACTIVE.get(module)
    if previous is not None:
        previous.valid = False
        previous._emit('observer', 'raise')
        return _TailObservation(None, {}, '')
    try:
        root = Path(root)
        if (os.name != 'nt' or sys.platform != 'win32' or pin != _PIN or
                words != ['gateway', 'status'] or root.resolve(strict=True) != root):
            raise ValueError('tail observation contract mismatch')
        file = root / 'hermes_cli' / 'gateway.py'
        with file.open('rb') as stream:
            source = stream.read(1048577)
        if len(source) > 1048576 or hashlib.sha256(source).hexdigest() != _SOURCE_SHA:
            raise ValueError('tail binary source mismatch')
        targets = _checked_targets(module, file, source)
    except BaseException:
        # 未核验原模块时不发冒称 observed 的事件；缺事件必为无效诊断。
        return _TailObservation(None, {}, '')
    return _TailObservation(module, targets, _SOURCE_SHA)


def validate_status_tail_events(stderr, *, pid, ppid):
    """离线严格解析同一 stderr；完整诊断也永远不构成正式资格。"""
    valid = False
    try:
        text = stderr.decode('utf8', errors='strict') if type(stderr) is bytes else stderr
        expected = (('observer', 'enter'), *_STEPS, ('observer', 'return'))
        rows, used, clock = [], 0, 0
        for line in text.splitlines(keepends=True):
            if not line.startswith(_PREFIX):
                continue
            size = len(line.encode('utf8'))
            used += size
            if size > 1024 or used > 8192 or not line.endswith('\n') or len(rows) >= len(expected):
                raise ValueError('tail stream budget/closure mismatch')
            row = json.loads(line[len(_PREFIX):])
            if (set(row) != _FIELDS or (row['target'], row['event']) != expected[len(rows)] or
                    type(row['schemaVersion']) is not int or row['schemaVersion'] != 1 or
                    row['scope'] != 'hermes-status-tail-diagnostic' or
                    type(row['pid']) is not int or type(row['ppid']) is not int or
                    row['pid'] != pid or row['ppid'] != ppid or
                    type(row['sequence']) is not int or row['sequence'] != len(rows) + 1 or
                    row['moduleSha256'] != _SOURCE_SHA or type(row['elapsedMs']) not in (int, float) or
                    not math.isfinite(row['elapsedMs']) or row['elapsedMs'] < clock or not row['utc'].endswith('+00:00') or
                    datetime.datetime.fromisoformat(row['utc']).utcoffset() != datetime.timedelta(0)):
                raise ValueError('tail event contract mismatch')
            clock = row['elapsedMs']
            rows.append(row)
        valid = len(rows) == len(expected)
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        pass
    return dict(diagnosticValid=valid, qualificationPass=False)
