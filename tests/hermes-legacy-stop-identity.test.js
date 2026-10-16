import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const driver = fileURLToPath(new URL('./fixtures/hermes-legacy-stop-identity.py', import.meta.url))
const helper = fileURLToPath(new URL('../scripts/hermes-legacy-gateway-identity.py', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/hermes-legacy-stop-upstream.json', import.meta.url))
const output = process.env.HERMES_LEGACY_IDENTITY_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-legacy-identity-'))
const entry = process.env.HERMES_LEGACY_ENTRY_SOURCE || fileURLToPath(new URL('../scripts/hermes-legacy-windows-launch.py', import.meta.url))

for (const group of ['native', 'negative', 'fallback', 'source', 'layout', 'decoder', 'phases']) {
  test(`固定旧0.21.5私有STOP：${group}，不声称实际Hermes/Windows资格`, () => {
    fs.mkdirSync(output, { recursive: true })
    const r = spawnSync(python, ['-I', '-B', driver, helper, fixture, group], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, group + '.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message)
    assert.equal(JSON.parse(r.stdout).qualificationPass, false)
  })
}

if (process.env.HERMES_LEGACY_IDENTITY_LIVE === '1' && fs.existsSync(entry)) {
  test('真实Carver R2 SourceFileLoader组合：status完整固定源、公开桥真实准入、两phase/restore', () => {
    const live = fileURLToPath(new URL('./fixtures/hermes-legacy-stop-live.py', import.meta.url))
    const r = spawnSync(python, ['-I', '-B', live, helper, fixture, entry], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'composition.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message)
    const result = JSON.parse(r.stdout)
    assert.equal(result.qualificationPass, false)
    assert.ok(result.cases.every(r => r.composition && r.publicAdmission && r.restored && r.gatewayNoop))
  })
}

if (process.env.HERMES_LEGACY_IDENTITY_LIVE === '1') {
  test('自有真实children：两个精确解释器角色、原STOP分流、PID/端口退出', () => {
    const live = fileURLToPath(new URL('./fixtures/hermes-legacy-stop-live.py', import.meta.url))
    const r = spawnSync(python, ['-I', '-B', live, helper, fixture], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
    fs.writeFileSync(path.join(output, 'live.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.status, 0, r.stderr || r.stdout || r.error?.message)
    const result = JSON.parse(r.stdout)
    assert.equal(result.qualificationPass, false)
    assert.equal(result.cases.length, 2)
    assert.ok(result.cases.every(r => r.originalRejected && r.nativeStop && r.pidExited && r.portClosed && r.rolesDistinct))
  })
}
