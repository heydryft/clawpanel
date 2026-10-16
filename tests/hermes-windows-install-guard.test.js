import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import * as pm from '../scripts/hermes-pm-runtime.js'

const cases = [
  { platform:'win32', processArch:'arm64', nativeArch:'ARM64', arm64:true },
  { platform:'win32', processArch:'x64', nativeArch:'ARM64', arm64:true },
  { platform:'win32', processArch:'x64', nativeArch:'AMD64', emulatedNativeArch:'ARM64', arm64:true },
  { platform:'win32', processArch:'ia32', nativeArch:'ARM64', arm64:true },
  { platform:'win32', processArch:'x64', nativeArch:'AMD64', allowed:true },
  { platform:'win32', processArch:'x64', nativeArch:'', blocked:true },
  { platform:'linux', processArch:'arm64', nativeArch:'ARM64', allowed:true },
  { platform:'darwin', processArch:'arm64', nativeArch:'ARM64', allowed:true },
]
test('Windows 原生 ARM64/unknown 均拒绝，仅 native AMD64 进入受管私有链', () => {
  assert.equal(typeof pm.hermesManagedInstallPlatformError,'function')
  for (const c of cases) {
    const result=pm.hermesManagedInstallPlatformError(c)
    if(c.allowed)assert.equal(result,null)
    else if(c.arm64)assert.match(result,/ARM64/)
    else assert.match(result,/Windows/)
  }
})
test('Web/Rust 共用安装与更新入口在所有副作用前检查，不能仅靠进程架构', () => {
  const web=fs.readFileSync(new URL('../scripts/dev-api.js',import.meta.url),'utf8')
  const rust=fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs',import.meta.url),'utf8')
  const w=web.match(/export async function installHermesManagedSource[^]*?\n}/)?.[0]||''
  const r=rust.match(/async fn install_hermes_managed_source[^]*?\n}/)?.[0]||''
  assert.ok(w.indexOf('assertHermesManagedInstallPlatform()')>=0 && w.indexOf('assertHermesManagedInstallPlatform()')<w.indexOf('hermesInstallerPlan()'))
  assert.ok(r.indexOf('ensure_hermes_managed_install_platform()?')>=0 && r.indexOf('ensure_hermes_managed_install_platform()?')<r.indexOf('ensure_hermes_portable_dirs()?'))
  assert.match(web,/PROCESSOR_ARCHITEW6432/);assert.match(web,/\/reg:64/)
  assert.match(rust,/PROCESSOR_ARCHITEW6432/);assert.match(rust,/\/reg:64/)
})
