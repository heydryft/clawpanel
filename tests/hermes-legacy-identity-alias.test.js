import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hermesLegacyWindowsSpec, decodeHermesWindowsScript } from '../scripts/hermes-windows-script-envelope.js'

// 先失败：入口已接受固定UV junction，身份侧三个base字段仍独立拒绝。只执行自有隔离组件，不安装Hermes。
test('旧身份seam：生产JS wire + 原203 resolver + 完整fresh facts + status/gateway/restore/原负向', { timeout: 60000 }, () => {
  const out = process.env.HERMES_LEGACY_IDENTITY_ALIAS_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-legacy-identity-alias-'))
  fs.mkdirSync(out, { recursive: true })
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'cp-legacy-spec-'))
  try {
    const home = path.join(dir, '.hermes'), root = path.join(home, 'hermes-agent'), python = path.join(root, 'venv/Scripts/python.exe')
    fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, 'fixture-role-only-never-execute')
    const spec = hermesLegacyWindowsSpec(['--profile', 'work', 'gateway', 'run'], { platform: 'win32', home, root })
    assert.ok(spec)
    const decoded = decodeHermesWindowsScript(spec.args[3])
    assert.equal(decoded.pin, 'f97608f178d1ffeca59860195ab7da295f7c8e5f')
    const identity = fs.readFileSync(new URL('../scripts/hermes-legacy-gateway-identity.py', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    assert.ok(decoded.script.includes(identity))
    const sample = path.join(out, 'production-wire.json'), report = path.join(out, 'component.json')
    fs.writeFileSync(sample, JSON.stringify({ spec, bodyBase64: Buffer.from(decoded.script).toString('base64'), bodySha256: decoded.sha256, identitySha256: crypto.createHash('sha256').update(identity).digest('hex') }))
    const result = spawnSync(process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B',
      fileURLToPath(new URL('./fixtures/hermes-legacy-identity-alias.py', import.meta.url)), sample,
      fileURLToPath(new URL('../scripts/hermes-legacy-windows-launch.py', import.meta.url)), report],
    { encoding: 'utf8', windowsHide: true, timeout: 55000, maxBuffer: 2 * 1024 * 1024 })
    fs.writeFileSync(path.join(out, 'child-receipt.json'), JSON.stringify({ exit: result.status, error: result.error?.code, stdout: result.stdout, stderr: result.stderr }, null, 2))
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
    const actual = JSON.parse(fs.readFileSync(report, 'utf8'))
    assert.equal(actual.testsRun, 31); assert.equal(actual.failures, 0); assert.equal(actual.errors, 0); assert.equal(actual.skips, 0)
    assert.deepEqual(actual.gatewayExecutable, { testsRun: 6, failures: 0, errors: 0, skips: 0 })
    assert.equal(actual.productionBodySha256, decoded.sha256)
    assert.equal(actual.receipts.find(r => r.case === 'gateway-current-wire-redirector-matrix')?.cases.length, 12)
    assert.ok(actual.receipts.some(r => r.case === 'gateway-fresh-executable-admission' && r.cachedSuccess === false))
    assert.ok(actual.receipts.some(r => r.case === 'gateway-real-late-junction-drift' && r.rejected))
    assert.equal(actual.qualificationPass, false)
    assert.ok(actual.maxCompleteUtf16IncludingNul < 32767)
    assert.ok(actual.receipts.some(r => r.case === 'combined-identity-default-and-named' && r.restore && r.nativeFallback))
    assert.ok(actual.receipts.some(r => r.case === 'real-sourcefileloader-and-carver-finder' && r.publicAdmission && r.restored))
  } finally {
    assert.equal(path.dirname(fs.realpathSync(dir)), parent)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
