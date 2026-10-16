import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as pm from '../scripts/hermes-pm-runtime.js'

const web = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')

test('native AMD64 可进入私有安装，ARM64/模拟/unknown/矛盾架构先失败', () => {
  assert.equal(pm.hermesManagedInstallPlatformError({ platform: 'win32', processArch: 'x64', nativeArch: 'AMD64' }), null)
  for (const facts of [
    { processArch: 'x64', nativeArch: 'ARM64' },
    { processArch: 'x64', nativeArch: 'AMD64', emulatedNativeArch: 'ARM64' },
    { processArch: 'arm64', nativeArch: 'AMD64' },
    { processArch: 'x64', nativeArch: '' },
    { processArch: 'x64', nativeArch: 'mips' },
    { processArch: 'ia32', nativeArch: 'AMD64' },
    { processArch: 'x64', nativeArch: 'AMD64', reportedArch: 'x86' },
  ]) assert.match(pm.hermesManagedInstallPlatformError({ platform: 'win32', ...facts }), /Windows/)
})

test('Web 所有普通 Hermes CLI 启动统一 wrapper，不经 PATH launcher', () => {
  assert.match(web, /function hermesLaunchSpec\(/)
  assert.match(web, /function spawnHermes\(/)
  assert.doesNotMatch(web, /spawn\('hermes',/)
  assert.match(web.match(/function runHermesSilent[^]*?\n}/)?.[0] || '', /hermesLaunchSpec/)
  assert.match(web, /spawnHermes\(\['gateway', 'run'\]/)
  assert.match(web, /spawnHermes\(\['dashboard', '--no-open'\]/)
})

test('Rust guardian/gateway/dashboard/profile/portable 与 silent/tokio 共用 wrapper', () => {
  assert.match(rust, /fn hermes_launch_spec\(/)
  assert.match(rust, /fn hermes_command\(/)
  assert.match(rust, /fn hermes_tokio_command\(/)
  assert.doesNotMatch(rust, /Command::new\(hermes_program_for_spawn\(\)\?\)/)
  assert.match(rust, /export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`/)
  assert.match(rust.match(/fn run_silent[^]*?\n}/)?.[0] || '', /hermes_command/)
  assert.match(rust.match(/fn run_at_path[^]*?\n}/)?.[0] || '', /hermes_command/)
})

test('同一共享 Python 在任何普通 CLI 前严格检查，不写假的 source/boot 完成状态', () => {
  const script = pm.HERMES_PRIVATE_LAUNCH_SCRIPT
  assert.equal(typeof script, 'string')
  for (const name of ['validate_runtime_state', 'prepare_active_profile', 'validate_boot_record', 'native_windows_amd64', 'private_boot']) {
    assert.match(script, new RegExp('def ' + name + '\\('))
  }
  assert.match(script, /GetNativeSystemInfo/)
  assert.match(script, /resolve_store_python\(root, publication=True\)/)
  assert.match(script, /source_product_current\(/)
  assert.match(script, /_tree_matches_completed_stamp\(root\)/)
  assert.match(script, /completion_pending_path\(root\)/)
  assert.match(script, /venv_is_current\(project_root=root\)/)
  assert.match(script, /run_boot_bootstrap\(root\)/)
  assert.match(script, /_apply_profile_override/)
  assert.match(script, /CLAWPANEL_HERMES_PRIVATE_PREFLIGHT/)
  assert.doesNotMatch(script, /\.write_text\(|\.unlink\(|_write_record\(|write_source_stamp\(/)
})

test('便携 source/HOME 分离显式传递；外部 runtime/stamp 覆盖与 profile 二次改向均阻断', () => {
  const script = pm.HERMES_PRIVATE_LAUNCH_SCRIPT || ''
  assert.match(script, /--portable/)
  assert.match(script, /HERMES_RUNTIME_DIR/)
  assert.match(script, /HERMES_INSTALL_ROOT/)
  assert.match(script, /selected_argv/)
  assert.match(script, /sys\.argv = \['hermes', '--profile',/)
  assert.ok(script.indexOf("'boot record escapes managed home'") < script.indexOf('boot.run_boot_bootstrap(root)'), '写 record 后检查越界已经太晚')
  assert.match(rust, /"--portable"/)
})

test('安装 completion 后必须经过相同 products/active-profile preflight 才返回成功', () => {
  const w = web.match(/async function completeHermesManagedSource[^]*?\n}/)?.[0] || ''
  const r = rust.match(/async fn complete_hermes_managed_source[^]*?\n}/)?.[0] || ''
  assert.match(w, /--preflight/)
  assert.match(r, /--preflight/)
})

test('Rust lazy-deps Python helper 不旁路 PM preflight，legacy 显式 HERMES_PYTHON 保留', () => {
  const body = rust.match(/async fn run_venv_python_json[^]*?\n}/)?.[0] || ''
  assert.match(body, /hermes_launch_spec\(\)\?/)
  assert.match(body, /--python-json/)
  assert.match(body, /hermes_venv_python\(\)/)
  assert.match(pm.HERMES_PRIVATE_LAUNCH_SCRIPT || '', /--python-json/)
})

test('被忽略的 repair/tree-swap debt 与借用 HOME 不得让普通启动进入上游修复', () => {
  const script = pm.HERMES_PRIVATE_LAUNCH_SCRIPT || ''
  for (const marker of ['.update-incomplete', '.lazy-refresh-incomplete', '.repair-incomplete', '.hermes-update-zip-swap', 'hermes-update-pull']) assert.ok(script.includes(marker), marker)
  assert.match(script, /read_live_update\(install_root=root\)/)
  assert.match(script, /owning_home_root\(root\) is None/)
  assert.ok(script.indexOf('validate_no_repair_debt(root)\n') < script.indexOf('activate_dependencies(root)\n'))
})

test('受管 profile 预检错误不伪装成空 default 列表，旧版空列表兼容保留', () => {
  const body = web.match(/  hermes_profiles_list\(\) \{[^]*?\n  }/)?.[0] || ''
  const build = new Function('runHermesSilent', 'parseHermesProfileListOutput', 'fs', 'path', 'hermesSourceDir', `return ({${body}}).hermes_profiles_list()`)
  const failed = () => ({ ok: false, stderr: 'PM currency false' })
  assert.throws(() => build(failed, () => {}, { existsSync: () => true }, path, () => '/fixture'), /PM currency false/)
  assert.deepEqual(build(failed, () => {}, { existsSync: () => false }, path, () => '/fixture'), { active: 'default', profiles: [] })
  assert.match(rust.match(/pub async fn hermes_profiles_list[^]*?\n}/)?.[0] || '', /Err\(error\)[^]*?\.join\("pm"\)[^]*?return Err\(error\)/)
})

test('隔离执行真实 preflight 函数：current/debt/products/record/越界逐项 fail-closed', (t) => {
  assert.equal(typeof pm.HERMES_PRIVATE_LAUNCH_SCRIPT, 'string')
  const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  if (spawnSync(python, ['--version']).status !== 0) return t.skip('此契约需要 Python；真实 Windows runner 仍为独立门禁')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-launch-contract-'))
  try {
    const script = path.join(dir, 'launch.py')
    fs.writeFileSync(script, pm.HERMES_PRIVATE_LAUNCH_SCRIPT)
    const result = spawnSync(python, ['-I', '-B', '-c', String.raw`
import ast, json, sys, tempfile, types
from pathlib import Path
source = ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
names = {'require', 'validate_runtime_state', 'validate_boot_record'}
ns = {'Path': Path}
exec(compile(ast.Module(body=[n for n in source.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), '<real-launch-functions>', 'exec'), ns)
passed = []
def check(name, fn, fail):
    try: fn()
    except RuntimeError:
        if not fail: raise
    else:
        if fail: raise AssertionError(name + ': accepted unsafe state')
    passed.append(name)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    debt = root / 'pending'
    state = {'current': True, 'completed': True, 'products': True}
    ns.update(pm=types.SimpleNamespace(venv_is_current=lambda **kw: state['current']),
      completion_pending_path=lambda root: debt,
      _tree_matches_completed_stamp=lambda root: state['completed'],
      source_product_current=lambda *args: state['products'])
    check('current-clean-products', lambda: ns['validate_runtime_state'](root), False)
    for key, value in [('current', False), ('current', None), ('completed', False), ('products', False)]:
        state[key] = value
        check(key + '-' + str(value), lambda: ns['validate_runtime_state'](root), True)
        state[key] = True
    debt.write_text('original tail owed')
    check('pending-even-with-current-stamp', lambda: ns['validate_runtime_state'](root), True)
    pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
    ns['PIN'] = pin
    for name, record, fail in [
      ('missing', {}, True), ('wrong-id', {'identity': 'other', 'results': {'migrate': {'ok': True}}}, True),
      ('empty', {'identity': pin, 'results': {}}, True),
      ('partial-fail', {'identity': pin, 'results': {'migrate': {'ok': False}}}, True),
      ('unknown-ok', {'identity': pin, 'results': {'migrate': {'ok': 1}}}, True),
      ('real-success', {'identity': pin, 'results': {'migrate': {'ok': True}}}, False)]:
        check('boot-' + name, lambda r=record: ns['validate_boot_record'](r), fail)
print(json.dumps({'kind': 'isolated-contract-not-Windows-runtime', 'passed': passed}))
`, script], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).passed.length, 12)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
