import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
for (const mode of ['contract', ...(process.env.HERMES_LEGACY_PATH_DIAGNOSTIC_LIVE === '1' ? ['live'] : [])]) {
  test(`旧Windows路径拒绝只读诊断：${mode}，不放宽准入`, { timeout: 45000 }, () => {
    const output = process.env.HERMES_LEGACY_PATH_DIAGNOSTIC_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-path-diagnostic-report-'))
    fs.mkdirSync(output, { recursive: true })
    const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I','-B',
      path.join(root,'tests/fixtures/hermes-legacy-path-diagnostic.py'), path.join(root,'scripts/hermes-legacy-windows-launch.py'),
      path.join(root,'tests/fixtures/hermes-legacy-path-diagnostic-contract.json'), mode],
    { encoding: 'utf8', windowsHide: true, timeout: 40000, maxBuffer: 1048576 })
    fs.writeFileSync(path.join(output, `${mode}.json`), JSON.stringify({ exit:r.status, stdout:r.stdout, stderr:r.stderr },null,2))
    assert.equal(r.error,undefined,r.error?.message)
    assert.equal(r.status,0,r.stderr)
    const report=JSON.parse(r.stdout)
    assert.equal(report.failures,0);assert.equal(report.skips,0);assert.equal(report.qualificationPass,false)
  })
}
