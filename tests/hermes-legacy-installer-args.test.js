// R17：真实生产参数须通过冻结 wrapper 的 pin/flags 门禁；到 vendor 读取前即停止，不安装。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const wrapper = path.join(root, 'scripts/hermes-managed-install.ps1')
const old = { version: '0.21.5', tag: 'v2026.9.24', branch: 'v2026.9.24', commit: 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }
const current = { version: '0.22.2', tag: 'v0.22.2', branch: 'release/0.22.2', commit: 'd923a5eb487a17c0a68801bba9ef0f56c81040a8' }
const stages = ['uv', 'git', 'node', 'repository', 'python', 'venv', 'dependencies', 'node-deps', 'config-templates', 'platform-sdks', 'bootstrap-marker']

function temp(t) {
  const base = fs.realpathSync.native(os.tmpdir())
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'hermes-r17-')))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(dir)), base); fs.rmSync(dir, { recursive: true, force: true }) })
  return dir
}

function jsPlan(home, release = old) {
  const source = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8').match(/export function hermesInstallerPlan\([^]*?\n\}/)?.[0]
  assert.ok(source, '缺真实生产 JS 安装计划')
  return new Function('path', 'isWindows', 'hermesHome', 'hermesSourceDir', 'HERMES_STABLE_VERSION', 'HERMES_STABLE_TAG', 'HERMES_STABLE_BRANCH', 'HERMES_STABLE_COMMIT', 'HERMES_INSTALLER_BASE_URL', 'HERMES_INSTALLER_SHA256', source.replace(/^export /, '') + ';return hermesInstallerPlan')(
    path, true, () => home, h => path.join(h, 'hermes-agent'), release.version, release.tag, release.branch, release.commit,
    `https://raw.githubusercontent.com/NousResearch/hermes-agent/${release.commit}/scripts`, { windows: release === old ? '0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2' : 'd7045a813ac5bbaec09ea4b65e5f77e47603ef56ae493414f72a4b3ce01de048' })(home)
}

function paths(dir) {
  const home = path.join(dir, "private 中文 'home")
  fs.mkdirSync(home, { recursive: true })
  return { home, vendor: path.join(home, '.clawpanel-cache', 'install-v2026.9.24.ps1') }
}

function rustBuilder(t, dir) {
  const source = fs.readFileSync(path.join(root, 'src-tauri/src/commands/hermes.rs'), 'utf8').match(/fn build_hermes_installer_stage_command\([^]*?\n\}/)?.[0]
  const block = source?.match(/#\[cfg\(target_os = "windows"\)\]\s*let mut cmd = \{([^]*?)\n    \};/)?.[1]
  assert.ok(block, '缺真实 Rust Windows 命令块')
  // 原生产命令块逐字编译；仅用标准 Command 容器观察 argv，不 spawn、不执行环境/安装器。
  const code = `#![allow(non_snake_case, unused_mut)]
use std::path::PathBuf;
mod tokio { pub mod process { pub type Command = std::process::Command; } }
fn main() {
 let argv: Vec<String> = std::env::args().collect();
 let HERMES_STABLE_VERSION=argv[1].as_str(); let HERMES_STABLE_COMMIT=argv[2].as_str(); let HERMES_STABLE_BRANCH=argv[3].as_str();
 let home=PathBuf::from(&argv[4]); let install_dir=home.join("hermes-agent");
 let script_path=PathBuf::from(&argv[5]); let wrapper_path=PathBuf::from(&argv[6]); let stage=argv[7].as_str();
 let command = {${block}\n};
 println!("{}", command.get_program().to_string_lossy());
 for arg in command.get_args() { println!("{}", arg.to_string_lossy()); }
}
`
  const file = path.join(dir, 'r17.rs'), executable = path.join(dir, process.platform === 'win32' ? 'r17.exe' : 'r17')
  fs.writeFileSync(file, code)
  const compile = spawnSync('rustc', ['--edition', '2021', file, '-o', executable], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  assert.equal(compile.status, 0, compile.stderr || String(compile.error))
  return (p, release = old, stage = 'uv') => {
    const r = spawnSync(executable, [release.version, release.commit, release.branch, p.home, p.vendor, wrapper, stage], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    assert.equal(r.status, 0, r.stderr)
    const [program, ...args] = r.stdout.trimEnd().split(/\r?\n/)
    assert.equal(program, 'powershell.exe')
    return args
  }
}

function guard(args, dir) {
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper])
  const quote = x => `'${String(x).replaceAll("'", "''")}'`
  const switches = new Set(['-ForceCommit', '-SkipSetup', '-SkipComputerUse', '-NonInteractive', '-Json'])
  const values = new Set(['-InstallerPath', '-HermesHome', '-InstallDir', '-Branch', '-Commit', '-Stage'])
  const named = []
  for (let i = 5; i < args.length; i++) {
    assert.ok(switches.has(args[i]) || values.has(args[i]), '未知测试参数')
    named.push(args[i]); if (values.has(args[i])) named.push(quote(args[++i]))
  }
  const script = `. ${quote(wrapper)} ${named.join(' ')}
function Read-ClawPanelLegacyInstaller([string]$SourcePath) { throw 'R17_GUARD_ACCEPTED_NO_VENDOR_IO' }
try { Invoke-ClawPanelLegacyInstaller; throw 'unexpected return' } catch { @{ accepted=([string]$_ -ceq 'R17_GUARD_ACCEPTED_NO_VENDOR_IO'); reason=[string]$_ } | ConvertTo-Json -Compress }
`
  const entry = path.join(dir, 'guard.ps1')
  fs.writeFileSync(entry, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(script)]))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = dir
  const before = JSON.stringify(process.env)
  const p = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', entry], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(p.status, 0, p.stderr || String(p.error))
  assert.equal(JSON.stringify(process.env), before)
  return JSON.parse(p.stdout.trim())
}

function complete(args, stage) {
  for (const flag of ['-ForceCommit', '-SkipSetup', '-SkipComputerUse', '-NonInteractive', '-Json']) assert.equal(args.filter(a => a === flag).length, 1, flag)
  assert.equal(args[args.indexOf('-Branch') + 1], old.tag)
  assert.equal(args[args.indexOf('-Commit') + 1], old.commit)
  assert.equal(args[args.indexOf('-Stage') + 1], stage)
  assert.equal(args[args.indexOf('-File') + 1], wrapper)
}

test('R17：JS 实际旧计划11阶段完整固定 flags；新22.2不进入旧wrapper或添加旧ForceCommit', t => {
  const dir = temp(t), p = paths(dir), plan = jsPlan(p.home)
  assert.deepEqual(plan.stages, stages)
  for (const stage of stages) complete(plan.argsForStage(p.vendor, stage, wrapper), stage)
  const next = jsPlan(p.home, current)
  assert.deepEqual(next.stages, ['repository', 'venv', 'python-deps', 'config', 'complete'])
  for (const stage of next.stages) {
    const args = next.argsForStage(p.vendor, stage, wrapper)
    assert.equal(args.includes(wrapper), false); assert.equal(args.includes('-ForceCommit'), false)
    assert.equal(args.includes('-InstallerPath'), false); assert.equal(args[args.indexOf('-Commit') + 1], current.commit)
  }
})

test('R17：编译执行生产Rust Windows旧命令块11阶段，当前新pin命令不混旧flags', t => {
  const dir = temp(t), p = paths(dir), build = rustBuilder(t, dir)
  for (const stage of stages) complete(build(p, old, stage), stage)
  const next = build(p, current)
  assert.equal(next.includes(wrapper), false); assert.equal(next.includes('-ForceCommit'), false)
  assert.equal(next.includes('-InstallerPath'), false); assert.equal(next[next.indexOf('-Commit') + 1], current.commit)
})

for (const language of ['JS', 'Rust']) test(`R17：${language}真实旧argv通过冻结PS5前置门禁，vendor读取前停止`, { skip: process.platform !== 'win32' }, t => {
  const dir = temp(t), p = paths(dir)
  const args = language === 'JS' ? jsPlan(p.home).argsForStage(p.vendor, 'uv', wrapper) : rustBuilder(t, dir)(p)
  const r = guard(args, dir)
  assert.equal(r.accepted, true, r.reason)
  assert.equal(r.reason, 'R17_GUARD_ACCEPTED_NO_VENDOR_IO')
})

test('R17：原wrapper仍拒绝缺开关/错误pin/错误branch/越界路径/未知stage，未删guard', { skip: process.platform !== 'win32' }, t => {
  const dir = temp(t), p = paths(dir), args = jsPlan(p.home).argsForStage(p.vendor, 'uv', wrapper)
  if (!args.includes('-ForceCommit')) args.push('-ForceCommit') // 仅负向控制，不能代替前面真实构造正向。
  for (const flag of ['-ForceCommit', '-SkipSetup', '-SkipComputerUse', '-NonInteractive', '-Json']) assert.equal(guard(args.filter(a => a !== flag), dir).accepted, false, flag)
  for (const [key, value] of [['-Commit', current.commit], ['-Branch', current.branch], ['-InstallerPath', path.join(dir, 'outside.ps1')], ['-Stage', 'path']]) {
    const modified = [...args]; modified[modified.indexOf(key) + 1] = value
    assert.equal(guard(modified, dir).accepted, false, key)
  }
})
