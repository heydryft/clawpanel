import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as pm from '../scripts/hermes-pm-runtime.js'
const script = pm.HERMES_PRIVATE_LAUNCH_SCRIPT

// 固定上游原函数 + 隔离进程表；不连接真实Hermes/HOME/注册表，不模拟资格通过。
const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const driver = new URL('./fixtures/hermes-pm-stop-identity.py', import.meta.url)
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-pm-stop-upstream.json', import.meta.url), 'utf8'))
for (const group of ['native', 'negative', 'fallback']) {
  for (const profile of ['default', 'n'.repeat(63)]) test(`固定原生STOP契约：${group}/${profile}`, () => {
    const r = spawnSync(python, ['-I', '-B', driver.pathname.replace(/^\/(?=[A-Za-z]:)/, ''), group], {
      input: JSON.stringify({ script, fixture, profile, identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT || '' }), encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    if (process.env.HERMES_STOP_IDENTITY_EVIDENCE) {
      fs.mkdirSync(process.env.HERMES_STOP_IDENTITY_EVIDENCE, { recursive: true })
      fs.writeFileSync(path.join(process.env.HERMES_STOP_IDENTITY_EVIDENCE, `${group}-${profile}.json`), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    }
    assert.equal(r.status, 0, r.stderr || r.error?.message || r.stdout)
    const result = JSON.parse(r.stdout)
    assert.equal(result.scope, 'fixed-upstream-contract-not-Windows-qualification')
    assert.equal(result.profile, profile)
    assert.equal(result.nativeRecordArgv.length, 3, '原main必须已消费profile selector，原record不得人为重写')
    assert.ok(result.passed > 0)
  })
}

test('adapter在全部preflight/task guard后启用，finally恢复；Rust读取同一raw脚本', () => {
  assert.match(pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT || '', /def install_private_gateway_identity\(/)
  const call = script.indexOf('restore_identity = install_private_gateway_identity(')
  assert.ok(call > script.indexOf('restore_profile_policy = install_private_profile_task_policy('))
  assert.ok(call > script.indexOf("_hp('state2_e')"))
  assert.ok(call > script.indexOf("_hp('debt2_e')"))
  assert.match(script, /if restore_identity is not None:\n\s+restore_identity\(\)/)
  for (const file of ['gateway/status.py', 'gateway/status_inline_source.py', 'hermes_state_holders.py']) assert.ok(script.includes(`'${file}':`), file)
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  assert.match(rust, /include_str!\("\.\.\/\.\.\/\.\.\/scripts\/hermes-pm-runtime\.js"\)/)
  assert.match(rust, /export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`/)
  const moduleSource = fs.readFileSync(new URL('../scripts/hermes-pm-runtime.js', import.meta.url), 'utf8')
  assert.equal(moduleSource.split('export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`')[1].split('\n`')[0], script.slice(0, -1), 'Rust提取与JS实际raw必须逐字节相同')
})

// 显式实进程合同：复用已有psutil，不安装依赖；不是实际Hermes/Windows VM资格。
if (process.env.HERMES_STOP_IDENTITY_LIVE === '1') {
  test('真实owned子进程：原生PID识别→原生STOP分流→回环退出/PID/端口清理', () => {
    const live = new URL('./fixtures/hermes-pm-stop-live.py', import.meta.url)
    const r = spawnSync(python, ['-I', '-B', live.pathname.replace(/^\/(?=[A-Za-z]:)/, '')], {
      input: JSON.stringify({ script, fixture, identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT || '' }),
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    })
    if (process.env.HERMES_STOP_IDENTITY_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_STOP_IDENTITY_EVIDENCE, 'live-owned-child.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message)
    const result = JSON.parse(r.stdout)
    assert.equal(result.scope, 'fixed-native-stop-live-owned-child-not-Hermes-qualification')
    assert.equal(result.cases.length, 2)
    for (const row of result.cases) {
      assert.ok(row.originalRejected && row.nativeStop && row.pidExited && row.portClosed, JSON.stringify(row))
      assert.equal(row.nativeRecordArgv.length, 3)
    }
  })
}
