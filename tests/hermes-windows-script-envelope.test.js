import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const load = () => import('../scripts/hermes-windows-script-envelope.js')
const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const base = `import os,hashlib\nPIN='${pin}'\nroot=None\ndef _hp(name):pass\ndef require(value,message):assert value,message\ndef restore_policy():pass\ntry:\n    _hp('main_b')\n    print('fixture')\nfinally:\n    if restore_identity is not None:\n        restore_identity()\n    restore_policy()\n`
test('仅 Windows 和已审版本，其他平台原字节保持；未知 pin 或锚点失败', async () => {
  const m = await load()
  assert.equal(m.hermesWindowsScript(base, { platform: 'linux', version: '0.22.2', pin }), base)
  for (const bad of [{ version: 'latest', pin }, { version: '0.22.2', pin: 'a'.repeat(40) }]) assert.throws(() => m.hermesWindowsScript(base, { platform: 'win32', ...bad }), /contract/)
  assert.throws(() => m.hermesWindowsScript('no anchors', { platform: 'win32', version: '0.22.2', pin }), /contract/)
})
test('压缩封装可验证回读，原函数及 source/current/boot 代码不移除；所有原分支保留', async () => {
  const m = await load(), wire = m.hermesWindowsScript(base, { platform: 'win32', version: '0.22.2', pin }), decoded = m.decodeHermesWindowsScript(wire)
  assert.equal(decoded.pin, pin); assert.equal(decoded.sha256, crypto.createHash('sha256').update(decoded.script).digest('hex'))
  for (const line of base.trim().split('\n')) assert.ok(decoded.script.includes(line), line)
  assert.match(decoded.script, /install_windows_cim_probe/); assert.match(decoded.script, /4d036c56de8065099f4b82a50fde9095c43dab7e851e0e3a3fe4cd5c143a212e/)
  assert.match(decoded.script, /_cp_cim_restore\(\)/)
  assert.throws(() => m.decodeHermesWindowsScript(wire.replace(decoded.sha256, '0'.repeat(64))), /integrity|contract/)
  assert.throws(() => m.decodeHermesWindowsScript(wire + '\nprint(1)'), /contract/)
})
test('Windows CRLF 和 UTF8 仅规范可信面板模板，Python AST 解析通过且留足32767余量', async () => {
  const m = await load(), one = m.hermesWindowsScript(base, { platform: 'win32', version: '0.22.2', pin }), two = m.hermesWindowsScript(base.replaceAll('\n','\r\n'), { platform: 'win32', version: '0.22.2', pin })
  assert.equal(one, two); assert.ok(one.length < 20000)
  const r = spawnSync(process.env.PYTHON || 'python', ['-I', '-B', '-c', 'import ast,sys;ast.parse(sys.stdin.buffer.read().decode("utf8"));print("AST_OK")'], { input: m.decodeHermesWindowsScript(one).script, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /AST_OK/)
})

test('真实 Web/Tauri launch spec 均接入封装，保留原受管解释器和 args 边界', () => {
  const web = fs.readFileSync('scripts/dev-api.js','utf8'), rust = fs.readFileSync('src-tauri/src/commands/hermes.rs','utf8')
  assert.match(web, /import \{ hermesWindowsScript \} from '\.\/hermes-windows-script-envelope.js'/)
  assert.match(web.match(/function hermesLaunchSpec[^]*?\n}/)?.[0] || '', /hermesWindowsScript\(HERMES_PRIVATE_LAUNCH_SCRIPT/)
  assert.match(rust.match(/fn hermes_launch_spec[^]*?\n}/)?.[0] || '', /hermes_windows::render/)
})

test('实际 PM 源组合必须注入严格 decoder，Linux 原始字节不变', async () => {
  const pm = await import('../scripts/hermes-pm-runtime.js'), m = await load()
  const wire = m.hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { platform: 'win32', version: '0.22.2', pin })
  const decoded = m.decodeHermesWindowsScript(wire).script
  assert.ok(decoded.includes(pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER))
  assert.ok(decoded.indexOf('def decode_clawpanel_private_script_bytes') < decoded.indexOf("_hp('main_b')"))
  assert.equal(m.hermesWindowsScript(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { platform: 'linux', version: '0.22.2', pin }), pm.HERMES_PRIVATE_LAUNCH_SCRIPT)
})
