import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import * as pm from '../scripts/hermes-pm-runtime.js'
import { hermesWindowsScript, decodeHermesWindowsScript, HERMES_WINDOWS_CIM_INSTALL } from '../scripts/hermes-windows-script-envelope.js'

// 实现前的失败清单：默认字节漂移、错误准入、提前导入、原语义丢失、身份异体、日志缺失/越界。
// 本文件只运行自有组件及固定源码 AST；不导入/安装上游运行时，不构成实际 Windows/Hermes 证明。
const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const options = { platform: 'win32', version: '0.22.2', pin }
const helperURL = new URL('../scripts/hermes-status-tail-observation.py', import.meta.url)
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const norm = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const diagnostic = () => hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { ...options, statusTailDiagnostic: true })
function component(group, extra = {}) {
  const r = spawnSync(process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['-I', '-B', fileURLToPath(new URL('./fixtures/hermes-status-tail-components.py', import.meta.url)), group], {
      input: JSON.stringify({ source: fs.readFileSync(helperURL, 'utf8').replaceAll('\r\n', '\n'), ...extra }),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
  if (process.env.HERMES_STATUS_TAIL_EVIDENCE) {
    fs.mkdirSync(process.env.HERMES_STATUS_TAIL_EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(process.env.HERMES_STATUS_TAIL_EVIDENCE, `${group}.json`), JSON.stringify({ scope: 'own-components-not-Hermes-or-VM-proof', qualificationPass: false, exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
  }
  assert.equal(r.status, 0, r.stderr || r.error?.message || r.stdout)
  const result = JSON.parse(r.stdout)
  assert.equal(result.qualificationPass, false)
  assert.equal(result.scope, 'own-components-not-Hermes-or-VM-proof')
  assert.ok(result.passed > 0)
  return result
}

test('disabled：22.2/21.5 原 capsule/body SHA 固定；各平台无新增 helper 读取', () => {
  const legacy = norm('../scripts/hermes-legacy-gateway-identity.py') + '\n' + norm('../scripts/hermes-legacy-windows-launch.py')
  for (const [base, opt, wireSHA, bodySHA] of [
    [pm.HERMES_PRIVATE_LAUNCH_SCRIPT, options, '6f6c6f64d1b21453d920640600fd9955d4f954175e9d6a991cae1a5a57e6e560', '3940e4cc5bb8da7bb5d0d5fede54814cedd5872b5622213a15e530c46d54af72'],
    [legacy, { ...options, version: '0.21.5', pin: 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }, '0be87490674260cef251c0dabf65e4037320abf097b57067afe78c21974fb0c7', 'f3e8140c503add568f9bc1d158ec8734135cff583a39838b2399931d96ffcc17'],
  ]) {
    const originalRead = fs.readFileSync
    const reads = []
    fs.readFileSync = function (file, ...args) { reads.push(String(file)); return originalRead.call(this, file, ...args) }
    try {
      for (const statusTailDiagnostic of [undefined, false]) {
        const wire = hermesWindowsScript(base, { ...opt, statusTailDiagnostic })
        assert.equal(sha(wire), wireSHA); assert.equal(decodeHermesWindowsScript(wire).sha256, bodySHA)
      }
    } finally { fs.readFileSync = originalRead }
    assert.ok(reads.every(file => file.endsWith('/hermes-pm-runtime.js')))
    for (const platform of ['linux', 'darwin', 'other']) assert.equal(hermesWindowsScript(base, { platform, version: 'unknown', statusTailDiagnostic: false }), base)
  }
})

test('opt-in：严格布尔/Windows/d923/原始 PM 模板，旧 pin 与别的平台拒绝', () => {
  for (const bad of [{ platform: 'linux' }, { platform: 'darwin' }, { version: '0.21.5', pin: 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }, { pin: '0'.repeat(40) }]) {
    assert.throws(() => hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { ...options, ...bad, statusTailDiagnostic: true }), /contract|unsupported/)
  }
  for (const statusTailDiagnostic of [null, 1, 'true', {}, []]) assert.throws(() => hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { ...options, statusTailDiagnostic }), /boolean|contract/)
  assert.throws(() => hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT + '#changed\n', { ...options, statusTailDiagnostic: true }), /contract/)
})

test('enabled：静态 helper 双侧 SHA、原 CIM 导入后接线、原 guard/_hp/identity 行全保留', () => {
  const body = decodeHermesWindowsScript(diagnostic()).script
  const normal = decodeHermesWindowsScript(hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, options)).script
  assert.notEqual(sha(body), sha(normal))
  assert.ok(body.indexOf('install_status_tail_observation') > body.indexOf(HERMES_WINDOWS_CIM_INSTALL.trim()))
  assert.ok(body.indexOf('_cp_tail_observation = _cp_tail_scope') < body.indexOf("    _hp('main_b')"))
  assert.match(body, /words in \(\['gateway'\], \['gateway', 'status'\]\)/)
  for (const line of normal.trim().split('\n')) assert.ok(body.includes(line), `原行被删除: ${line.slice(0, 100)}`)
  assert.ok(body.includes(sha(fs.readFileSync(helperURL, 'utf8').replaceAll('\r\n', '\n'))))
  const composer = fs.readFileSync(new URL('../scripts/hermes-windows-script-envelope.js', import.meta.url), 'utf8')
  assert.match(composer, /statusTailDiagnostic = false/)
  assert.match(composer, /hash\(tailSource\) !== '[a-f0-9]{64}'/)
  assert.match(body, /_cp_tail_observation\.restore\(\)/)
  assert.ok(!/sys\.settrace|sys\.setprofile|meta_path|importlib|atexit|threading/.test(body.slice(body.indexOf('_cp_tail_source ='))))
})

test('component：helper 源变化拒绝；仅 enabled 读取，非 Windows/旧 pin 不触达', () => {
  const read = fs.readFileSync
  let reads = 0
  fs.readFileSync = function (file, ...args) {
    if (String(file).endsWith('/hermes-status-tail-observation.py')) { reads++; return read.call(this, file, ...args) + '\n# mutation' }
    return read.call(this, file, ...args)
  }
  try { assert.throws(diagnostic, /source|contract/); assert.equal(reads, 1) } finally { fs.readFileSync = read }
})

for (const group of ['transparent', 'guards', 'restore', 'logging', 'validation', 'no-hooks']) {
  test(`own Python component：${group}（非 Hermes/VM 资格）`, () => component(group))
}

test('component identity：统一 body 为 run/status/stop 保持原身份检查；status-only 异体失败', () => {
  const wires = ['run', 'status', 'stop'].map(() => diagnostic())
  assert.ok(wires.every(wire => wire === wires[0]))
  component('identity', { diagnosticWire: wires[0], normalWire: hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, options), identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT, decoder: pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER })
})

test('component：完整 Windows UTF16 argv（含 NUL/转义/长 HOME/260 program/named63）守住原上限', () => {
  const wire = diagnostic(), decoded = decodeHermesWindowsScript(wire)
  assert.ok(Buffer.byteLength(decoded.script) <= 131072); assert.ok(wire.length <= 30000)
  const rows = []
  for (const home of ['C:\\private home\\' + 'h'.repeat(96), 'C:\\' + '中🧪'.repeat(95)]) {
    const root = home + '\\hermes-agent'
    const program = 'C:\\private python\\' + 'p'.repeat(260 - 'C:\\private python\\'.length - '\\python.exe'.length) + '\\python.exe'
    assert.equal(program.length, 260)
    for (const profile of ['default', 'n'.repeat(63)]) for (const command of ['run', 'status', 'stop']) rows.push([program, '-I', '-B', '-c', wire, root, home, pin, '--', '--profile', profile, 'gateway', command])
  }
  const result = component('argv', { rows, body: decoded.script })
  assert.ok(result.units.every(units => units <= 32767), JSON.stringify(result.units))
})

test('source-derived AST only：可选 exact d923 文件只读 hash/ABI/调用顺序，绝不执行定义', { skip: !process.env.HERMES_STATUS_TAIL_UPSTREAM_SOURCE }, () => {
  component('source-ast', { upstream: process.env.HERMES_STATUS_TAIL_UPSTREAM_SOURCE })
})
