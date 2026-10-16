import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const helper = path.join(root, 'scripts/hermes-windows-cim-probe.py')
const output = process.env.HERMES_WMI_COM_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-wmi-com-evidence-'))
for (const mode of ['adapter', 'contract', ...(process.env.HERMES_WMI_COM_LIVE === '1' ? ['live'] : [])]) {
  test(`无 PowerShell WMI COM：${mode}，不代替实际内核/VM验收`, { timeout: 50000 }, () => {
    fs.mkdirSync(output, { recursive: true })
    const args = mode === 'adapter'
      ? [path.join(root, 'tests/fixtures/hermes-wmi-com-integration.py'), helper]
      : [path.join(root, 'tests/fixtures/hermes-wmi-com-worker.py'), helper, path.join(root, 'tests/fixtures/hermes-wmi-com-contract.json'), mode]
    const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B', ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    })
    fs.writeFileSync(path.join(output, `${mode}.json`), JSON.stringify({ exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.error, undefined, r.error?.message)
    assert.equal(r.status, 0, r.stderr || r.stdout)
    const report = JSON.parse(r.stdout)
    assert.equal(report.qualificationPass, false)
    assert.equal(report.failures, 0)
    assert.equal(report.skips, 0)
  })
}

if (process.env.HERMES_WMI_COM_JOB_SOURCE) {
  test('私有真实venv/原spawn_server自有Job：全表raw argv、部分结果拒绝、超时回收', { timeout: 60000 }, () => {
    const r = spawnSync(process.env.PYTHON || 'python', ['-I', '-B',
      path.join(root, 'tests/fixtures/hermes-wmi-com-private-job.py'), helper,
      process.env.HERMES_WMI_COM_JOB_SOURCE, path.join(root, 'tests/fixtures/hermes-wmi-com-contract.json')],
    { encoding: 'utf8', windowsHide: true, timeout: 55000, maxBuffer: 2 * 1024 * 1024 })
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'private-job.json'), JSON.stringify({ exit: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
    assert.equal(r.error, undefined, r.error?.message)
    assert.equal(r.status, 0, r.stderr || r.stdout)
    const report = JSON.parse(r.stdout)
    for (const key of ['jobsClosed', 'childrenExited', 'baseVsVenvVerified', 'ownedCleanup', 'parentEnvUnchanged']) assert.equal(report[key], true, key)
    assert.equal(report.powershellSpawned, false)
    assert.equal(report.qualificationPass, false)
    for (const launch of report.launches) assert.ok(launch.wireUtf16WithNul <= 32767)
  })
}
