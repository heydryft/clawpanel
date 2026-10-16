import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { hermesWindowsScript, hermesLegacyWindowsSpec, decodeHermesWindowsScript } from '../scripts/hermes-windows-script-envelope.js'
import { HERMES_PRIVATE_LAUNCH_SCRIPT } from '../scripts/hermes-pm-runtime.js'

test('新旧完整生产body含COM；原入口保留且含所有路径/profile的Windows UTF16命令未溢出', t => {
  const parent = fs.realpathSync.native(os.tmpdir())
  const home = fs.mkdtempSync(path.join(parent, 'cp-wmi-wire-'))
  const root = path.join(home, 'hermes-agent')
  const python = path.join(root, 'venv/Scripts/python.exe')
  fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, 'owned non-executable fixture')
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(home)), parent); fs.rmSync(home, { recursive: true, force: true }) })
  const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
  const input = [], receipts = []
  for (const profile of ['default', 'n'.repeat(63)]) {
    const args = ['--profile', profile, 'gateway', 'run']
    const old = hermesLegacyWindowsSpec(args, { platform: 'win32', home, root })
    const wire = hermesWindowsScript(HERMES_PRIVATE_LAUNCH_SCRIPT, { platform: 'win32', version: '0.22.2', pin })
    const specs = [[old, '0.21.5'], [{ program: path.join(root, '.hermes-runtime/environments/owned-fixture/Scripts/python.exe'),
      args: ['-I', '-B', '-c', wire, root, home, pin, '--', ...args] }, '0.22.2']]
    for (const [spec, version] of specs) {
      const body = decodeHermesWindowsScript(spec.args[3]).script
      assert.match(body, /HERMES_WINDOWS_WMI_WORKER = r'''/)
      assert.match(body, /SELECT ProcessId,CommandLine FROM Win32_Process/)
      assert.match(body, /if compat.bounded_probe_run is bounded:/)
      if (version === '0.22.2') {
        for (const line of HERMES_PRIVATE_LAUNCH_SCRIPT.replaceAll('\r\n', '\n').trim().split('\n')) assert.ok(body.includes(line), '原PM行被删除')
      } else {
        for (const file of ['scripts/hermes-legacy-gateway-identity.py', 'scripts/hermes-legacy-windows-launch.py']) {
          assert.ok(body.includes(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')), file)
        }
      }
      // 测完整OS参数串，不拿wire.length冒充32767检查；另给96字符HOME/260字符program压力形态。
      input.push([spec.program, ...spec.args])
      const stress = [spec.program + 'p'.repeat(Math.max(0, 260 - spec.program.length)), ...spec.args]
      stress[6] = 'C:\\private-home\\' + 'h'.repeat(96 - 'C:\\private-home\\'.length)
      stress[5] = stress[6] + '\\hermes-agent'
      input.push(stress)
      receipts.push({ version, profileLength: profile.length, wireUnits: spec.args[3].length,
        bodyBytes: Buffer.byteLength(body), bodySha256: crypto.createHash('sha256').update(body).digest('hex') })
    }
  }
  const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B', '-c',
    'import json,subprocess,sys; print(json.dumps([len(subprocess.list2cmdline(a).encode("utf-16-le"))//2+1 for a in json.load(sys.stdin)]))'],
  { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(r.status, 0, r.stderr)
  const units = JSON.parse(r.stdout)
  for (const length of units) assert.ok(length <= 32767, `完整命令溢出 ${length}`)
  for (let i = 0; i < receipts.length; i++) Object.assign(receipts[i], { actualCompleteUtf16WithNul: units[i * 2], stressCompleteUtf16WithNul: units[i * 2 + 1] })
  if (process.env.HERMES_WMI_COM_EVIDENCE) {
    fs.mkdirSync(process.env.HERMES_WMI_COM_EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(process.env.HERMES_WMI_COM_EVIDENCE, 'envelopes.json'), JSON.stringify({ qualificationPass: false, receipts }, null, 2))
  }
})
