import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { HERMES_PRIVATE_LAUNCH_SCRIPT as script } from '../scripts/hermes-pm-runtime.js'

// 与实际 Web/Rust 调用及固定 Dashboard hub routes 对照；这里只验证命令策略，不冒充 Windows runtime。
const ordinary = [
  ['gateway', 'run'], ['gateway', 'stop'], ['gateway', 'status'],
  ['dashboard', '--no-open'], ['dashboard', '--status'], ['dashboard', '--stop'],
  ['tools', 'list', '--platform', 'cli'],
  ['sessions', 'export', '-'], ['sessions', 'export', '-', '--source', 'api'],
  ['sessions', 'list', '--limit', '80', '--source', 'api'],
  ['sessions', 'export', '-', '--session-id', 'fixture-session'],
  ['sessions', 'delete', 'fixture-session', '--yes'],
  ['sessions', 'rename', 'fixture-session', 'fixture title'],
  ['profile', 'list'], ['profile', 'use', 'named'],
  ['logs', 'list'], ['logs', 'gateway.log', '-n', '200', '--level', 'INFO'],
]
const hub = [
  ['skills', 'install', 'official/fixture-skill', '--yes'],
  ['skills', 'uninstall', 'fixture-skill', '--yes'],
  ['skills', 'update'],
]
const outside = [
  ['skills'], ['skills', 'publish', 'fixture'], ['skills', 'tap', 'add', 'fixture'],
  ['skills', 'snapshot', 'import', 'fixture.json'], ['skills', 'repair-official', 'all'],
  ['skills', 'install', 'fixture', '--force', '--yes'],
  ['skills', 'install', 'fixture', '--category', 'fixture', '--yes'],
  ['skills', 'install', '--force', '--yes'], ['skills', 'install', '', '--yes'],
  ['skills', 'install', 'fixture'], ['skills', 'uninstall', 'fixture', '--force', '--yes'],
  ['skills', 'update', '--force'], ['skills', 'update', 'fixture'],
  ['gateway', 'start'], ['gateway', 'restart'], ['gateway', 'install'],
  ['gateway', 'uninstall'], ['gateway', 'migrate', '--multiplex', '--yes'],
  ['profile', 'create', 'fixture'], ['update'], ['setup'],
]

function policyResults(t) {
  const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  if (spawnSync(python, ['--version']).status !== 0) {
    t.skip('需要 Python 执行真实 policy AST；不是 Windows runtime 资格')
    return null
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-entrypoints-'))
  try {
    const source = path.join(dir, 'launch.py')
    fs.writeFileSync(source, script)
    const result = spawnSync(python, ['-I', '-B', '-c', String.raw`
import ast, json, sys, types
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
require=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='require')
policy=next((n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='validate_windows_entrypoint'),None)
# 旧脚本原 inline gate 也可执行，留下真实命令被阻断的红灯，而非只测缺少新函数。
if policy is None:
 gate=next(n for n in tree.body if isinstance(n,ast.If) and ast.unparse(n.test)=="sys.platform == 'win32'")
 nodes=[require,gate]
else:nodes=[require,policy]
out=[]
for group in json.loads(sys.argv[2]):
 results=[]
 for words in group:
  ns={'sys':types.SimpleNamespace(platform='win32'),'words':words}
  try:
   exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual-private-policy>','exec'),ns)
   if policy is not None:ns['validate_windows_entrypoint'](words)
  except RuntimeError as error:results.append({'argv':words,'allowed':False,'error':str(error)})
  else:results.append({'argv':words,'allowed':True})
 out.append(results)
print(json.dumps({'kind':'isolated-actual-policy-not-Windows-runtime','groups':out}))
`, source, JSON.stringify([ordinary, hub, outside])], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    if (process.env.HERMES_ENTRYPOINT_EVIDENCE) fs.writeFileSync(process.env.HERMES_ENTRYPOINT_EVIDENCE, JSON.stringify(report, null, 2) + '\n')
    return report.groups
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('既有普通 Web/Rust argv 保持允许，native hub 三项不因命令名一概失败', t => {
  const results = policyResults(t)
  if (!results) return
  for (const item of [...results[0], ...results[1]]) assert.equal(item.allowed, true, JSON.stringify(item))
})

test('hub 只开放实际三种 argv；额外 flag/命令/服务/终端仍在边界外', t => {
  const results = policyResults(t)
  if (!results) return
  for (const item of results[2]) assert.equal(item.allowed, false, JSON.stringify(item))
})

test('JS/Rust 同一策略仍先确认 PM/products/profile/boot，再进入原 main', () => {
  assert.match(script, /def validate_windows_entrypoint\(words\):/)
  assert.match(script, /validate_windows_entrypoint\(words\)/)
  assert.ok(script.indexOf('validate_runtime_state(root)\n') < script.indexOf('validate_windows_entrypoint(words)\n'))
  assert.ok(script.indexOf('validate_windows_entrypoint(words)\n') < script.indexOf('record = private_boot(root)'))
  assert.ok(script.indexOf('record = private_boot(root)') < script.indexOf("runpy.run_module('hermes_cli.main'"))
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  assert.match(rust, /include_str!\("\.\.\/\.\.\/\.\.\/scripts\/hermes-pm-runtime.js"\)/)
})
