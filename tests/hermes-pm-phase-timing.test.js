import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HERMES_PRIVATE_COMPLETION_SCRIPT, HERMES_PRIVATE_LAUNCH_SCRIPT, HERMES_PRIVATE_METADATA_SCRIPT } from '../scripts/hermes-pm-runtime.js'

// 只执行实际诊断函数/顶层currency片段；不导入PM/vendor，不查询宿主HOME/注册表。
const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
function isolated(script, scope, body) {
  assert.ok(script.includes('def _hp(name):'), '缺少默认关闭的诊断函数')
  const code = `import ast, contextlib, io, json, os, sys, time, types
payload=json.loads(sys.stdin.buffer.read().decode('utf-8'))
tree=ast.parse(payload['script'])
node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_hp')
ns={'os':os,'sys':sys,'json':json}
exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-phase-function>','exec'),ns)
phase=ns['_hp'];scope=payload['scope']
exec(payload['body'])
print('isolated-phase-contract-PASS')
`
  const result = spawnSync(python, ['-I', '-B', '-c', code], { input: JSON.stringify({ script, scope, body }), encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.equal(result.stdout.trim(), 'isolated-phase-contract-PASS')
}

for (const [scope, script] of [['launch', HERMES_PRIVATE_LAUNCH_SCRIPT], ['metadata', HERMES_PRIVATE_METADATA_SCRIPT]]) {
  test(`${scope} 默认关闭且只精确1启用，不改变原环境/stdout`, () => isolated(script, scope, String.raw`
out,err=io.StringIO(),io.StringIO()
original_clock=time.perf_counter_ns
def forbidden_clock(): raise AssertionError('disabled timing read clock')
time.perf_counter_ns=forbidden_clock
try:
    with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
        for value in (None,'','0','true','01','1 '):
            if value is None: os.environ.pop('CLAWPANEL_HERMES_PHASE_TIMING',None)
            else: os.environ['CLAWPANEL_HERMES_PHASE_TIMING']=value
            before=dict(os.environ);phase('entry');assert dict(os.environ)==before
finally: time.perf_counter_ns=original_clock
assert out.getvalue()==err.getvalue()=='' and not phase.__dict__
`))

  test(`${scope} 启用后仅固定字段/标签、PID/PPID和单调耗时，stderr失败不影响原调用`, () => isolated(script, scope, String.raw`
os.environ['CLAWPANEL_HERMES_PHASE_TIMING']='1'
os.environ['SECRET_CANARY']='DO-NOT-PRINT-HOME-path-argv-config-token'
out,err=io.StringIO(),io.StringIO();before=dict(os.environ)
original_clock=time.perf_counter_ns;values=iter((1000000000,1001500000))
time.perf_counter_ns=lambda:next(values)
try:
    with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
        phase('entry');phase('DO-NOT-PRINT-HOME-path-argv-config-token');phase('cur_b')
finally: time.perf_counter_ns=original_clock
rows=[json.loads(s.removeprefix('CLAWPANEL_HERMES_PHASE ')) for s in err.getvalue().splitlines()]
assert out.getvalue()=='' and dict(os.environ)==before
assert [r['phase'] for r in rows]==['entry','cur_b']
assert all(set(r)=={'schemaVersion','scope','phase','pid','ppid','sequence','elapsedMs','deltaMs'} for r in rows)
assert all(r['schemaVersion']==1 and r['scope']==scope and r['pid']==os.getpid() and r['ppid']==os.getppid() for r in rows)
assert [r['sequence'] for r in rows]==[1,2]
assert [r['deltaMs'] for r in rows]==[0.0,1.5] and [r['elapsedMs'] for r in rows]==[0.0,1.5]
assert 'DO-NOT-PRINT' not in err.getvalue()
class BrokenDiagnostic:
    def write(self,value): raise BrokenPipeError('diagnostic unavailable')
    def flush(self): raise BrokenPipeError('diagnostic unavailable')
with contextlib.redirect_stderr(BrokenDiagnostic()): phase('main_exit')
`))

  test(`${scope} 实际顶层currency的false/unknown仍失败且不产生end，True顺序不变`, () => isolated(script, scope, String.raw`
os.environ['CLAWPANEL_HERMES_PHASE_TIMING']='1'
def marker(node,label):
    return isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='_hp' and node.value.args[0].value==label
start=next(i for i,n in enumerate(tree.body) if marker(n,'cur_b'))
end=next(i for i,n in enumerate(tree.body[start+1:],start+1) if marker(n,'cur_e'))
fragment=ast.Module(body=tree.body[start:end+1],type_ignores=[])
def require(condition,message):
    if not condition: raise RuntimeError(message)
ns.update(require=require,root='isolated-no-filesystem-root')
for value in (False,None,True):
    ns['pm']=types.SimpleNamespace(venv_is_current=lambda **kw:value)
    err=io.StringIO();failed=False
    with contextlib.redirect_stderr(err):
        try: exec(compile(fragment,'<actual-top-level-currency>','exec'),ns)
        except RuntimeError: failed=True
    assert failed is (value is not True)
    labels=[json.loads(s.removeprefix('CLAWPANEL_HERMES_PHASE '))['phase'] for s in err.getvalue().splitlines()]
    assert labels==(['cur_b','cur_e'] if value is True else ['cur_b'])
`))
}

test('计时只在顶层调用前后，不给原函数注入闭包依赖，不触碰completion/预算/字节码变量', () => {
  for (const [scope, script] of [['launch', HERMES_PRIVATE_LAUNCH_SCRIPT], ['metadata', HERMES_PRIVATE_METADATA_SCRIPT]]) {
    isolated(script, scope, String.raw`
for function in (n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name!='_hp'):
    assert not any(isinstance(n,ast.Name) and n.id=='_hp' for n in ast.walk(function)),function.name
calls=[n for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='_hp']
assert calls and all(len(n.args)==1 and isinstance(n.args[0],ast.Constant) and isinstance(n.args[0].value,str) for n in calls)
labels={n.args[0].value for n in calls}
assert {'entry','src_b','src_e','store','reexec','act_b','act_e','cur_b','cur_e'}<=labels
`)
    assert.doesNotMatch(script, /UV_COMPILE_BYTECODE|PYTHONDONTWRITEBYTECODE|PYTHONPROFILEIMPORTTIME/)
  }
  for (const phase of ['imp_b', 'imp_e', 'debt1_b', 'debt1_e', 'state1_b', 'state1_e', 'prof_b', 'prof_e', 'boot_b', 'boot_e', 'state2_b', 'state2_e', 'debt2_b', 'debt2_e', 'policy_b', 'policy_e', 'main_b', 'main_exit', 'preflight']) assert.ok(HERMES_PRIVATE_LAUNCH_SCRIPT.includes(`_hp('${phase}')`), phase)
  assert.doesNotMatch(HERMES_PRIVATE_COMPLETION_SCRIPT, /_hp|CLAWPANEL_HERMES_PHASE_TIMING/)
})

test('Windows完整list2cmdline含NUL：HOME96/named63/实际native固定snippet均小于32767 UTF16', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  const snippets = []
  for (const match of rust.matchAll(/pub async fn (hermes_\w+)\(/g)) {
    const body = rust.slice(match.index, rust.indexOf('\n}', match.index) + 2)
    if (!body.includes('run_venv_python_json(')) continue
    for (const raw of body.matchAll(/r(#+)"([\s\S]*?)"\1/g)) {
      const snippet = raw[2].replaceAll('{feature_literal}', JSON.stringify('f'.repeat(63)))
        .replaceAll('{features_literal}', JSON.stringify(['platform.telegram', 'platform.discord', 'tool.browser']))
        .replaceAll('{{', '{').replaceAll('}}', '}')
      snippets.push({ name: match[1], code: snippet })
    }
  }
  assert.equal(snippets.length, 3, '必须包含全部实际native Python JSON固定snippet')
  const code = String.raw`
import json,subprocess,sys
d=json.loads(sys.stdin.buffer.read().decode('utf-8'));home=('D:\\qualification space\\🦀\\').ljust(96,'x')
assert len(home.encode('utf-16-le'))//2==97
# emoji占两个UTF16单元；切为实际96单元而非只数Python码点。
home=home[:-1];assert len(home.encode('utf-16-le'))//2==96
owner=home+'\\.hermes';root=owner+'\\hermes-agent'
python=owner+'\\installs\\'+'a'*16+'\\environments\\'+'b'*28+'\\venv\\Scripts\\python.exe'
prefix=[python,'-I','-B','-c',d['script'],root,owner,'d923a5eb487a17c0a68801bba9ef0f56c81040a8']
cases=[('named-gateway',['--','--profile','n'*63,'gateway','run']),('portable-named',['--portable','--profile','n'*63,'dashboard','--no-open'])]
for snippet in d['snippets']:
    cases.extend((('native-'+snippet['name'],['--python-json',snippet['code']]),('portable-'+snippet['name'],['--portable-python-json',snippet['code']])))
rows=[]
for name,tail in cases:
    size=len(subprocess.list2cmdline(prefix+tail).encode('utf-16-le'))//2+1
    rows.append({'case':name,'utf16WithNul':size,'remaining':32767-size})
print(json.dumps(rows))
`
  const result = spawnSync(python, ['-I', '-B', '-c', code], { input: JSON.stringify({ script: HERMES_PRIVATE_LAUNCH_SCRIPT, snippets }), encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  const rows = JSON.parse(result.stdout)
  assert.equal(rows.length, 8)
  assert.ok(rows.every(r => r.utf16WithNul < 32767), JSON.stringify(rows))
  if (process.env.HERMES_PHASE_TEST_EVIDENCE) {
    fs.mkdirSync(process.env.HERMES_PHASE_TEST_EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(process.env.HERMES_PHASE_TEST_EVIDENCE, 'windows-argv-sizes.json'), JSON.stringify(rows, null, 2))
  }
})
