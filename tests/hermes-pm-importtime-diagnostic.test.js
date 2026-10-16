import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as pm from '../scripts/hermes-pm-runtime.js'

const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const enabled = { optIn: '1', context: 'qualification-vm-only' }
const prepare = (spec, options) => pm.prepareHermesPmImporttimeDiagnostic(spec, options)
function spec({ mode = '--', profile = '', homeLength = 96 } = {}) {
  const home = 'D:\\qualification space\\🦀\\'.padEnd(homeLength, 'x') + '\\.hermes'
  return {
    program: home + '\\installs\\' + 'a'.repeat(16) + '\\environments\\' + 'b'.repeat(28) + '\\venv\\Scripts\\python.exe',
    args: ['-I', '-B', '-c', pm.HERMES_PRIVATE_LAUNCH_SCRIPT, home + '\\hermes-agent', home, pin, mode,
      ...(profile ? ['--profile', profile] : []), 'gateway', 'run'],
    timeout: 15000,
    healthBudgetMs: 20000,
  }
}

test('独立opt-in默认关闭，非精确1及环境同名开关均不自动改变命令', () => {
  const original = spec(), before = structuredClone(original), environment = { ...process.env }
  for (const optIn of [undefined, '', '0', 'true', true, 1, '01', '1 ']) assert.equal(prepare(original, { optIn }), null)
  assert.equal(prepare(original), null)
  assert.deepEqual(original, before)
  assert.deepEqual({ ...process.env }, environment)
})

test('启用时必须显式资格VM上下文，不把context当作VM证明或自行启动进程', () => {
  for (const context of [undefined, '', 'local', 'production', true]) {
    assert.throws(() => prepare(spec(), { optIn: '1', context }), /qualification-vm-only/)
  }
})

test('只插入显式-X importtime，原脚本/args/预算/对象不变，诊断永远不代表验收通过', () => {
  for (const mode of ['--', '--portable']) {
    const original = spec({ mode, profile: 'n'.repeat(63) }), before = structuredClone(original)
    const result = prepare(original, enabled)
    assert.equal(result.scope, 'diagnostic-only-not-acceptance')
    assert.equal(result.qualificationPass, false)
    assert.deepEqual(result.spec.args, ['-I', '-B', '-X', 'importtime', ...original.args.slice(2)])
    assert.equal(result.spec.args.filter(v => v === '--profile').length, 1)
    assert.equal(result.spec.timeout, 15000)
    assert.equal(result.spec.healthBudgetMs, 20000)
    assert.equal(result.spec.program, original.program)
    assert.equal(result.spec.args[5], pm.HERMES_PRIVATE_LAUNCH_SCRIPT)
    assert.deepEqual(original, before)
    assert.notEqual(result.spec, original)
    assert.notEqual(result.spec.args, original.args)
  }
})

test('非固定脚本/源pin/启动形态/其他命令/重复注入均拒绝，不回显原始args或路径', () => {
  const changes = [
    s => { s.args[0] = '-E' }, s => { s.args[1] = '-S' }, s => { s.args[2] = '-m' },
    s => { s.args[3] += '\n# SECRET_CANARY' }, s => { s.args[6] = 'wrong-pin' },
    s => { s.args[7] = '--preflight' }, s => { s.args[7] = '--python-json' },
    s => { s.args[s.args.length - 1] = 'stop' }, s => { s.args.push('--force') },
    s => { s.args.splice(2, 0, '-X', 'importtime') }, s => { s.program = '' },
    s => { s.args[4] = 123 }, s => { s.args[5] += '\0SECRET_CANARY' },
  ]
  for (const change of changes) {
    const original = spec(); change(original)
    assert.throws(() => prepare(original, enabled), error => {
      assert.doesNotMatch(error.message, /SECRET_CANARY|qualification space|wrong-pin/)
      return /diagnostic.*contract/i.test(error.message)
    })
  }
})

test('named profile仅允许固定前置--profile语法，原selected argv不重组', () => {
  for (const name of ['n'.repeat(65), '../other', 'profile space', '--force']) {
    assert.throws(() => prepare(spec({ profile: name }), enabled), /diagnostic.*contract/i)
  }
  const original = spec({ profile: 'named-63_' + 'x'.repeat(54) })
  assert.deepEqual(prepare(original, enabled).spec.args.slice(10), original.args.slice(8))
})

test('Windows完整list2cmdline含NUL按UTF16计算，HOME96/named63/转义与Python实际结果一致', () => {
  const cases = [spec(), spec({ profile: 'n'.repeat(63) }), spec({ mode: '--portable', profile: 'n'.repeat(63) })]
  const escaped = spec(); escaped.program += '\\'; cases.push(escaped)
  const results = cases.map(s => prepare(s, enabled))
  const actual = spawnSync(python, ['-I', '-B', '-c', String.raw`
import json,subprocess,sys
rows=json.loads(sys.stdin.buffer.read().decode('utf-8'))
print(json.dumps([len(subprocess.list2cmdline([r['program'],*r['args']]).encode('utf-16-le'))//2+1 for r in rows]))
`], { input: JSON.stringify(results.map(r => r.spec)), encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(actual.status, 0, actual.stderr || actual.error?.message)
  assert.deepEqual(results.map(r => r.windowsCommandLineUtf16WithNul), JSON.parse(actual.stdout))
  assert.ok(results.every(r => r.windowsCommandLineUtf16WithNul <= 32767), JSON.stringify(results.map(r => r.windowsCommandLineUtf16WithNul)))
})

test('32767 UTF16含NUL的精确边界通过，32768在执行前报错，不截断或缩短原脚本', () => {
  const original = spec(), initial = prepare(original, enabled).windowsCommandLineUtf16WithNul
  original.program += 'x'.repeat(32767 - initial)
  assert.equal(prepare(original, enabled).windowsCommandLineUtf16WithNul, 32767)
  original.program += 'x'
  assert.throws(() => prepare(original, enabled), /32767.*UTF16/)
})

test('STOP适配后的launch固定指纹，completion/metadata逐字节保持eae，无检查豁免或vendor改写', () => {
  for (const [script, expected] of [
    [pm.HERMES_PRIVATE_LAUNCH_SCRIPT, '655496bcf4631841d394d40f2093b5f0d1517f24ba0f68c9b31905643c824c8a'],
    [pm.HERMES_PRIVATE_COMPLETION_SCRIPT, 'f091fc3e0c7a40d641bd8e674e0d3621adc0a67813b4eb6a6ba326b3f1573df2'],
    [pm.HERMES_PRIVATE_METADATA_SCRIPT, '1e819b3c44954f5b5baa55bcae501142d7b40a4b617760859cf65ec68a3ec6c1'],
  ]) assert.equal(crypto.createHash('sha256').update(script).digest('hex'), expected)
})

test('真实stdlib Python启用importtime，原reexec_selected_python完整透传-X并保留非0退出码', () => {
  const flags = prepare(spec(), enabled).spec.args.slice(0, 4)
  const code = String.raw`
import ast,json,os,subprocess,sys
if sys.argv[1:]==['child']:
    print(json.dumps({'child':True,'importtime':sys._xoptions.get('importtime'),'isolated':sys.flags.isolated,'dontWrite':sys.dont_write_bytecode}),flush=True)
    raise SystemExit(17)
payload=json.loads(sys.stdin.buffer.read().decode('utf-8'))
node=next(n for n in ast.parse(payload).body if isinstance(n,ast.FunctionDef) and n.name=='reexec_selected_python')
ns={'subprocess':subprocess,'os':os,'sys':sys}
exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-reexec-function>','exec'),ns)
sys.orig_argv.append('child')
ns['reexec_selected_python'](sys.executable)
`
  const result = spawnSync(python, [...flags, '-c', code], { input: JSON.stringify(pm.HERMES_PRIVATE_LAUNCH_SCRIPT), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 17, result.stderr || result.error?.message)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { child: true, importtime: true, isolated: 1, dontWrite: true })
  assert.match(result.stderr, /import time:\s+\d+\s+\|\s+\d+\s+\|\s+.*json/)
})
