import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import * as runtime from '../scripts/hermes-pm-runtime.js'

const web = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')

test('固定 0.22.2 private completion 的 JS/Rust Python 契约逐字一致', () => {
  assert.equal(typeof runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, 'string')
  assert.match(rust, /include_str!\("\.\.\/\.\.\/\.\.\/scripts\/hermes-pm-runtime\.js"\)/)
  assert.match(rust, /\.split_once\("export const HERMES_PRIVATE_COMPLETION_SCRIPT = String.raw`"\)/)
  assert.match(rust, /hermes_private_completion_script\(\)\?/)
  const shared = fs.readFileSync(new URL('../scripts/hermes-pm-runtime.js', import.meta.url), 'utf8')
  const native = shared.split('export const HERMES_PRIVATE_COMPLETION_SCRIPT = String.raw`')[1]?.split('`\n')[0]
  assert.equal(native, runtime.HERMES_PRIVATE_COMPLETION_SCRIPT)
})

test('private completion 保留原完整尾部与原始 boot maintenance，不自行写 stamp/facts/pending', () => {
  const script = runtime.HERMES_PRIVATE_COMPLETION_SCRIPT || ''
  assert.match(script, /complete_source_checkout\(/)
  assert.match(script, /activate_dependencies\(root\)/)
  assert.match(script, /result is not True/)
  assert.match(script, /run_boot_bootstrap\(root\)/)
  assert.match(script, /_tree_matches_completed_stamp\(root\)/)
  assert.match(script, /venv_is_current\(project_root=root\)/)
  assert.doesNotMatch(script, /write_source_stamp\(|clear_completion\(|\.unlink\(|\.write_text\(/)
})

test('Rust 共享脚本抽取兼容 Windows CRLF，不把编译宿主行尾当协议', () => {
  assert.match(rust, /source\.split_once\('`'\)/)
  assert.doesNotMatch(rust, /source\.split_once\("`\\n"\)/)
  const shared = fs.readFileSync(new URL('../scripts/hermes-pm-runtime.js', import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n')
  const selected = shared.split('export const HERMES_PRIVATE_COMPLETION_SCRIPT = String.raw`')[1].split('`')[0]
  assert.equal(selected.replaceAll('\r\n', '\n'), runtime.HERMES_PRIVATE_COMPLETION_SCRIPT)
})

test('private completion 只隔离 exposure 闭包，保留 checkout launcher/build/其他 maintenance', () => {
  const script = runtime.HERMES_PRIVATE_COMPLETION_SCRIPT || ''
  assert.match(script, /launchers\.expose_cli = private_expose/)
  assert.match(script, /repair\.migrate_windows_bin_path = private_migrate/)
  assert.match(script, /maintenance\._ensure_fhs_path_guard = private_fhs/)
  assert.doesNotMatch(script, /publish_launchers\s*=|build_update_products\s*=|_run_post_update_maintenance\s*=/)
  assert.match(script, /inspect\.signature/)
  assert.match(script, /hashlib\.sha256/)
  assert.match(script, /d923a5eb487a17c0a68801bba9ef0f56c81040a8/)
})

test('Web/Rust 固定安装与更新入口均显式等待 private completion 后才成功', () => {
  const w = web.match(/export async function installHermesManagedSource[^]*?\n}/)?.[0] || ''
  const r = rust.match(/async fn install_hermes_managed_source[^]*?\n}/)?.[0] || ''
  assert.match(w, /await completeHermesManagedSource\(env\)/)
  assert.match(r, /complete_hermes_managed_source\(app\)\.await\?/)
  assert.match(web, /HERMES_STABLE_VERSION !== '0\.22\.2'/)
  assert.match(rust, /HERMES_STABLE_VERSION != "0\.22\.2"/)
})
