import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
const web=fs.readFileSync(new URL('../scripts/dev-api.js',import.meta.url),'utf8')
const rust=fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs',import.meta.url),'utf8')
test('新旧Windows安装器必须显式按已审pin分流，不能将22.2送入21.5 wrapper',()=>{
 const plan=web.match(/export function hermesInstallerPlan\([^]*?\n\}/)?.[0]||''
 assert.match(plan,/HERMES_STABLE_VERSION === '0\.21\.5'/)
 assert.match(plan,/HERMES_STABLE_COMMIT !== 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'/)
 const builder=rust.match(/fn build_hermes_installer_stage_command\([^]*?\n\}/)?.[0]||''
 assert.match(builder,/if HERMES_STABLE_VERSION == "0\.21\.5"/)
 assert.match(builder,/else[\s\S]*?command\.arg\(script_path\)/)
 assert.match(builder,/HERMES_STABLE_COMMIT == "d923a5eb487a17c0a68801bba9ef0f56c81040a8"/)
})
