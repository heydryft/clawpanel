// 先红：实际后端spec函数在受限VM中只调用记录器，不导入/执行内核。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const body = source.match(/function hermesLaunchSpec\(args\) \{[\s\S]*?\n\}/)?.[0]

test('真实后端spec只接显式1；run/status/stop共用同一composer选项且正常模式关闭', () => {
  assert.ok(body)
  for (const flag of [undefined, '', '0', 'false', 'true', '1']) {
    const options = [], context = vm.createContext({
      path, isWindows: true, process: { platform: 'win32', env: flag === undefined ? {} : { CLAWPANEL_HERMES_STATUS_TAIL_DIAGNOSTIC: flag } },
      hermesHome: () => 'C:/own/home', hermesSourceDir: () => 'C:/own/source', resolveHermesPmEnvironment: () => 'C:/own/env',
      HERMES_STABLE_VERSION: '0.22.2', HERMES_STABLE_COMMIT: 'd923a5eb487a17c0a68801bba9ef0f56c81040a8', HERMES_PRIVATE_LAUNCH_SCRIPT: 'never execute fixture',
      hermesWindowsScript: (script, option) => { assert.equal(script, 'never execute fixture'); options.push(JSON.parse(JSON.stringify(option))); return option.statusTailDiagnostic ? 'diagnostic-wire' : 'original-wire' },
    })
    const fn = vm.runInContext('(' + body + ')', context)
    for (const action of ['run', 'status', 'stop']) {
      const args = ['gateway', action], spec = fn(args)
      assert.equal(spec.args[3], flag === '1' ? 'diagnostic-wire' : 'original-wire')
      assert.deepEqual(JSON.parse(JSON.stringify(spec.args.slice(-2))), args)
    }
    assert.equal(options.length, 3)
    assert.ok(options.every(option => option.platform === 'win32' && option.version === '0.22.2' && option.pin === 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' && option.statusTailDiagnostic === (flag === '1')))
    assert.deepEqual(options[0], options[1]); assert.deepEqual(options[1], options[2])
  }
})
