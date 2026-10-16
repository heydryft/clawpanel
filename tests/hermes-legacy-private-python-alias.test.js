import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 仅自有临时junction、伪源码和子进程；不是Hermes实装或VM资格证明。
test('旧UV固定私有Python alias：原始事实不改写、精确目标及负向边界', { timeout: 60000 }, () => {
  const out = process.env.HERMES_LEGACY_ALIAS_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'cp-legacy-alias-evidence-'))
  fs.mkdirSync(out, { recursive: true })
  const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B',
    fileURLToPath(new URL('./fixtures/hermes-legacy-private-python-alias.py', import.meta.url)),
    fileURLToPath(new URL('../scripts/hermes-legacy-windows-launch.py', import.meta.url)), path.join(out, 'component.json')],
  { encoding: 'utf8', windowsHide: true, timeout: 55000, maxBuffer: 1048576 })
  fs.writeFileSync(path.join(out, 'child-receipt.json'), JSON.stringify({ exit: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2))
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(fs.readFileSync(path.join(out, 'component.json'), 'utf8'))
  assert.ok(report.testsRun >= 16)
  assert.equal(report.failures, 0); assert.equal(report.errors, 0); assert.equal(report.skips, 0)
  assert.equal(report.qualificationPass, false)
  assert.equal(report.receipts[0]?.rawFactsUnchanged, true)
})
