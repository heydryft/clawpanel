import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { execFile } from 'node:child_process'
import { redactPluginOutput } from '../scripts/channel-plugin-install.js'

const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
function fn(name, globals = {}) {
  const start = source.indexOf('export function ' + name + '(')
  assert.ok(start >= 0, name + ' actual production function missing')
  return vm.runInNewContext('(' + source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '') + ')', { fs, path, isWindows: process.platform === 'win32', redactPluginOutput, ...globals })
}

test('P1检测失败不遍历全局PATH，UNC/映射盘/超长PATH不引入同步FS', () => {
  const own = path.resolve(os.tmpdir(), 'hermes-health-owned-presence')
  for (const PATH of ['\\\\offline\\share;Z:\\remote', 'relative;' + 'x'.repeat(100000)]) {
    const paths = []
    const fakeFs = { lstatSync(p) { paths.push(p); if (p === path.join(own, 'hermes-agent')) { const e = new Error('missing'); e.code = 'ENOENT'; throw e } return { isSymbolicLink: () => false, isDirectory: () => true } } }
    const presence = fn('hermesCliPresence', { fs: fakeFs })
    presence(own, path.join(own, 'hermes-agent'), { PATH })
    assert.ok(paths.length <= 3)
    assert.ok(paths.every(p => p === own || p === path.join(own, 'installs') || p === path.join(own, 'hermes-agent')))
  }
  const forbidden = fn('hermesCliPresence', { fs: { lstatSync() { throw new Error('不应查询此路径') } } })
  for (const home of ['\\\\offline\\share', '//offline/share', 'x'.repeat(5000), 'relative']) assert.equal(forbidden(home, home + '/hermes-agent'), null)
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  const start = rust.indexOf('fn hermes_cli_presence_at('), end = rust.indexOf('\n}', start) + 2
  assert.ok(!/split_paths|PATHEXT|enhanced/.test(rust.slice(start, end)), 'Rust不得新增全局PATH同步查询')
})

test('实际execFile结构化ENOENT限定bare program；解释器/guard/退出失败不确认缺失', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-health-spawn-')))
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  const start = source.indexOf('async function runHermesSilent('), end = source.indexOf('\n}', start) + 2
  async function invoke(spec) {
    const run = vm.runInNewContext('(' + source.slice(start, end) + ')', {
      performance, HERMES_CLI_DEADLINE_MS: 15000, acquireHermesCliSlot: async () => () => {}, execFile,
      hermesLaunchSpec: () => { if (spec.guard) throw Object.assign(new Error('owned guard ENOENT'), { code: 'ENOENT' }); return spec },
      buildHermesRuntimeEnv: () => ({ ...process.env, PATH: root }),
    })
    return run('hermes', ['--version'])
  }
  const missing = await invoke({ program: 'hermes', args: [] })
  assert.equal(missing.code, 'ENOENT'); assert.equal(missing.cliMissing, true)
  const privatePython = await invoke({ program: path.join(root, 'missing-python.exe'), args: [] })
  assert.equal(privatePython.code, 'ENOENT'); assert.equal(privatePython.cliMissing, false)
  assert.notEqual((await invoke({ guard: true })).cliMissing, true)
  const exited = await invoke({ program: process.execPath, args: ['-e', 'process.stderr.write("ENOENT password=ownedPassword");process.exit(7)'] })
  assert.equal(exited.code, 7); assert.equal(exited.cliMissing, false)
})
test('Hermes安装判态：超时/队满/私有布局损坏未知，只有确证缺CLI为false；正文不泄露', () => {
  const classify = fn('hermesDetectionState')
  for (const stderr of ['timeout sk-secret', 'queue full', 'invalid facts ENOENT', 'AccessDenied']) {
    const x = classify({ ok: false, stdout: 'Gateway running', stderr, killed: true }, true)
    assert.equal(x.installed, null); assert.equal(x.detectionError, 'CLI_PROBE_FAILED'); assert.equal(x.version, null)
    assert.ok(!JSON.stringify(x).includes(stderr))
  }
  assert.equal(classify({ ok: false, cliMissing: true }, false).installed, false)
  assert.equal(classify({ ok: false, code: 'ENOENT', stderr: 'ENOENT' }, false).installed, null)
  assert.equal(classify({ ok: false }, null).installed, null)
  for (const stdout of ['', 'warning only', 'Gateway is running']) assert.equal(classify({ ok: true, stdout }, true).installed, null)
  for (const version of ['0.21.5', '0.22.2', '0.22.2-rc.1']) {
    const x = classify({ ok: true, stdout: 'Hermes Agent v' + version }, true)
    assert.equal(x.installed, true); assert.equal(x.version, version); assert.equal(x.detectionError, null)
  }
})
test('安装存在证据只读自有文件：缺失/损坏/源布局/命令文件/链接，不启动which或CLI', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-health-own-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), sourceDir = path.join(home, 'hermes-agent'), bin = path.join(root, 'bin'); fs.mkdirSync(bin)
  const presence = fn('hermesCliPresence')
  const env = { PATH: bin, PATHEXT: '.EXE;.CMD;.BAT;.COM' }
  assert.equal(presence(home, sourceDir, env), false)
  fs.mkdirSync(sourceDir, { recursive: true }); assert.equal(presence(home, sourceDir, env), true)
  fs.writeFileSync(path.join(sourceDir, 'facts.json'), '{bad'); assert.equal(presence(home, sourceDir, env), true)
  fs.rmSync(sourceDir, { recursive: true }); fs.mkdirSync(path.join(home, 'installs')); assert.equal(presence(home, sourceDir, env), false)
  fs.rmSync(path.join(home, 'installs'), { recursive: true }); fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'hermes.cmd' : 'hermes'), 'owned non-executed fixture')
  assert.equal(presence(home, sourceDir, env), false, '全局命令文件不再由presence同步访问')
  const denied = fn('hermesCliPresence', { fs: { lstatSync() { const e = new Error('secret path'); e.code = 'EACCES'; throw e } } })
  assert.equal(denied(home, sourceDir, env), null)
})

test('实际受管卸载保留历史/配置后，只有当前CLI确证不存在才false；历史不是损坏CLI', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-health-uninstall-')))
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), sourceDir = path.join(home, 'hermes-agent'), bin = path.join(root, 'bin')
  fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(home, 'installs'))
  fs.writeFileSync(path.join(home, 'config.yaml'), 'owned: preserved')
  const start = source.indexOf('export async function uninstallHermesManagedSourceAt(')
  const uninstall = vm.runInNewContext('(' + source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '') + ')', { fs, path, isWindows: process.platform === 'win32', hermesSourceDir: h => path.join(h, 'hermes-agent'), _hermesGwProcess: null, handlers: { _dashPid: 0 } })
  const env = { PATH: bin, PATHEXT: '.EXE;.CMD;.BAT;.COM' }
  const presence = fn('hermesCliPresence')
  assert.equal(presence(home, sourceDir, env), true)
  assert.equal(await uninstall(home, false), true)
  assert.equal(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), 'owned: preserved')
  assert.equal(presence(home, sourceDir, env), false)
  assert.equal(fn('hermesDetectionState')({ ok: false, cliMissing: true }, presence(home, sourceDir, env)).installed, false)
  fs.rmSync(path.join(home, 'installs'), { recursive: true }); fs.writeFileSync(path.join(home, 'installs'), 'broken directory')
  assert.equal(presence(home, sourceDir, env), null)
})
test('actual check_hermes handler在probe失败时保留配置/port/socket读取，不调用安装写入', async () => {
  const begin = source.indexOf('  async check_hermes() {'), end = source.indexOf('\n  async install_hermes(', begin)
  let probes = 0
  const handler = vm.runInNewContext('({' + source.slice(begin, end).replace(/,\s*$/, '') + '})', {
    hermesHome: () => '/own', hermesSourceDir: () => '/own/hermes-agent', path, process: { env: {} },
    runHermesVersionSilent: async () => { probes++; return { ok: false, stderr: 'deadline exceeded token=secret' } },
    hermesCliPresence: () => { throw new Error('普通失败不得追加presence IO') }, hermesDetectionState: fn('hermesDetectionState'), buildHermesRuntimeEnv: () => ({}),
    fs: { existsSync: () => true, readFileSync: () => 'model:\n  default: own-model' },
    hermesGatewayPort: () => 8642, hermesGatewayUrl: () => 'http://127.0.0.1:8642',
    net: { Socket: class { setTimeout() {} connect(p, host, cb) { cb() } destroy() {} on() {} } },
  })
  const result = await handler.check_hermes()
  assert.equal(probes, 1); assert.equal(result.installed, null); assert.equal(result.configExists, true); assert.equal(result.gatewayRunning, true); assert.equal(result.gatewayPort, 8642)
  assert.equal(result.detectionError, 'CLI_PROBE_FAILED'); assert.ok(!JSON.stringify(result).includes('secret'))
})
test('Hermes安全health投影只含primitive，每个消费者隔离，unknown不保留上次绿灯', async () => {
  const index = fs.readFileSync(new URL('../src/engines/hermes/index.js', import.meta.url), 'utf8'); const start = index.indexOf('export function projectHermesHealth('); assert.ok(start >= 0); const projectHermesHealth = vm.runInNewContext('(' + index.slice(start, index.indexOf('\n}', start) + 2).replace('export ', '') + ')')
  const raw = { installed: true, configExists: true, gatewayRunning: true, version: '0.22.2', token: 'secret', nested: { key: 'secret' }, model: 'private-profile-model' }
  const a = projectHermesHealth(raw), b = projectHermesHealth(raw)
  assert.notEqual(a, b); assert.ok(Object.isFrozen(a)); assert.ok(!JSON.stringify(a).includes('secret')); assert.ok(!('model' in a))
  assert.throws(() => { a.installed = false }); assert.equal(raw.installed, true); assert.equal(b.installed, true)
  assert.equal(projectHermesHealth({ installed: null, detectionError: 'token=secret' }).installed, null)
  assert.ok(!JSON.stringify(projectHermesHealth({ installed: null, detectionError: 'token=secret' })).includes('secret'))
  for (const version of ['1.0.0-sk-ownedKey', '1.0.0+' + 'a'.repeat(2000)]) {
    const projected = projectHermesHealth({ ...raw, version })
    assert.equal(projected.version, null)
    assert.ok(!JSON.stringify(projected).includes('ownedKey'))
  }
})
test('卸载/晚回包/profile边界：仅当前范围的新观测可以应用', async () => {
  const index = fs.readFileSync(new URL('../src/engines/hermes/index.js', import.meta.url), 'utf8'); const start = index.indexOf('export function healthObservationApplies('); assert.ok(start >= 0); const healthObservationApplies = vm.runInNewContext('(' + index.slice(start, index.indexOf('\n}', start) + 2).replace('export ', '') + ')')
  assert.equal(healthObservationApplies(12, 10, 11, false), true)
  for (const args of [[9, 10, 8, false], [10, 0, 11, false], [12, 10, 11, true], [NaN, 0, 0, false]]) assert.equal(healthObservationApplies(...args), false)
  assert.equal(healthObservationApplies(12, 10, 11, false, 1, 3), false, '同名profile往返后旧generation仍须拒绝')
})

test('检测说明有界且不序列化Error.cmd/argv/env或stdout凭据', () => {
  const classify = fn('hermesDetectionState')
  const secret = 'Bearer ownedBearer sk-ownedKey password=ownedPassword'
  const error = Object.assign(new Error(secret.repeat(20000)), { cmd: secret, argv: [secret], env: { PASSWORD: secret } })
  error.toJSON = () => { throw new Error('禁止序列化原Error') }
  for (const probe of [
    { ok: false, error, stderr: secret, stdout: secret },
    { ok: true, stdout: secret },
    { ok: true, stdout: 'Hermes 1.0.0-sk-ownedKey' },
    { ok: true, stdout: 'Hermes 1.0.0+' + 'a'.repeat(2000) },
    { ok: false, get cmd() { throw new Error('禁止读取cmd') }, get argv() { throw new Error('禁止读取argv') }, get env() { throw new Error('禁止读取env') } },
  ]) {
    const result = classify(probe, true), wire = JSON.stringify(result)
    assert.equal(result.installed, null)
    assert.equal(typeof result.detectionError, 'string')
    assert.ok(result.detectionError.length > 0 && result.detectionError.length <= 160)
    for (const value of ['ownedBearer', 'ownedKey', 'ownedPassword', '"cmd"', '"argv"', '"env"']) assert.ok(!wire.includes(value))
  }
})

test('PATH空段/相对目录/重复键都不确认缺失，版本前缀规范一致', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-health-path-')))
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), sourceDir = path.join(home, 'hermes-agent')
  const presence = fn('hermesCliPresence')
  for (const PATH of [root + path.delimiter, path.delimiter + root, '.', '']) {
    assert.equal(presence(home, sourceDir, { PATH }), false, '仅受管布局缺失，不探测PATH')
    assert.equal(fn('hermesDetectionState')({ ok: false }, presence(home, sourceDir, { PATH })).installed, null, '没有真实spawn缺失收据仍未知')
  }
  assert.equal(presence(home, sourceDir, { PATH: root, Path: root }), false)
  assert.equal(fn('hermesDetectionState')({ ok: true, stdout: 'Hermes V0.22.2' }, true).version, '0.22.2')
})

function actualEngine(api) {
  const source = fs.readFileSync(new URL('../src/engines/hermes/index.js', import.meta.url), 'utf8')
  const timers = [], invalidations = []
  const engine = vm.runInNewContext('"use strict";\n' + source.replace(/^import .*$/gm, '').replaceAll('export function ', 'function ').replace('export default ', 'const engine = ') + '\nengine', {
    api, t: key => key, performance, invalidate: (...args) => invalidations.push(args),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return 1 }, clearInterval: () => {},
  })
  return { engine, timers, invalidations }
}

test('实际engine listener突变/抛错不污染cache或其它consumer，unsub与cleanup取消晚回包', async () => {
  const raw = { installed: true, configExists: true, gatewayRunning: true, version: '0.22.2', token: 'ownedSecret' }
  let calls = 0, release
  const { engine, timers, invalidations } = actualEngine({ checkHermes: async () => { calls++; return calls < 3 ? raw : await new Promise(r => { release = r }) } })
  const seen = []
  engine.onStateChange(event => { event.info.installed = false })
  engine.onStateChange(() => { throw new Error('owned listener failure') })
  const unsub = engine.onStateChange(event => seen.push(event))
  await engine.boot()
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 15000)
  assert.equal(calls, 1); assert.equal(raw.installed, true); assert.equal(seen[0].info.installed, true)
  assert.ok(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0].info))
  assert.ok(!JSON.stringify(seen[0]).includes('ownedSecret'))
  await timers[0].fn()
  assert.equal(calls, 2); assert.notEqual(seen[0].info, seen[1].info)
  unsub()
  const pending = timers[0].fn()
  engine.cleanup(); release(raw); await pending
  assert.equal(seen.length, 2); assert.equal(calls, 3); assert.equal(invalidations.length, 3)
})

test('实际engine返回rejected Promise的listener独立消化，不产生unhandledRejection', () => {
  // 自有Node子进程隔离全局unhandledRejection；不安装/执行Hermes，不改测试器异常处理。
  const engineSource = fs.readFileSync(new URL('../src/engines/hermes/index.js', import.meta.url), 'utf8')
  const entry = `import vm from 'node:vm';
const failures=[];process.on('unhandledRejection',()=>failures.push('unhandledRejection'));
let calls=0;const seen=[];const raw={installed:true,configExists:true,gatewayRunning:true,version:'0.22.2',token:'ownedPrivateKey'};
const source=${JSON.stringify(engineSource)};
const engine=vm.runInNewContext('"use strict";\\n'+source.replace(/^import .*$/gm,'').replaceAll('export function ','function ').replace('export default ','const engine = ')+'\\nengine',{api:{checkHermes:async()=>{calls++;return raw}},t:k=>k,invalidate:()=>{},performance,setInterval:()=>1,clearInterval:()=>{}});
engine.onStateChange(async()=>{throw new Error('owned async listener failure')});
engine.onStateChange(event=>seen.push(event));await engine.boot();
await new Promise(setImmediate);await new Promise(setImmediate);engine.cleanup();
console.log(JSON.stringify({failures,calls,seen:seen.length,frozen:Object.isFrozen(seen[0].info),cacheInstalled:raw.installed,publicLeak:JSON.stringify(seen).includes('ownedPrivateKey')}));`
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', entry], { encoding: 'utf8', timeout: 3000, windowsHide: true })
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout.trim())
  assert.deepEqual(result, { failures: [], calls: 1, seen: 1, frozen: true, cacheInstalled: true, publicLeak: false })
})

test('聊天已有启动按钮的检测RPC失败仍为unknown，既有一次写/一次读不增量', async () => {
  const chat = fs.readFileSync(new URL('../src/engines/hermes/pages/chat.js', import.meta.url), 'utf8')
  const start = chat.indexOf('  async function startGateway() {'), end = chat.indexOf('\n  }', start) + 4
  const applied = [], toasts = []; let writes = 0, reads = 0
  const run = vm.runInNewContext('(' + chat.slice(start, end) + ')', {
    gatewayStarting: false, healthDisposed: false, store: { state: { profileGeneration: 1 } }, performance,
    draw() {}, invalidate() {}, applyHealth: info => applied.push(info), t: k => k,
    toast: msg => toasts.push(String(msg)), humanizeError: error => error.message,
    api: { hermesGatewayAction: async () => { writes++ }, checkHermes: async () => { reads++; throw new Error('Bearer ownedBearer sk-ownedKey password=ownedPassword') } },
  })
  await run()
  assert.equal(writes, 1); assert.equal(reads, 1)
  assert.equal(applied.length, 1); assert.equal(applied[0].installed, null)
  for (const secret of ['ownedBearer', 'ownedKey', 'ownedPassword']) assert.ok(!JSON.stringify({ applied, toasts }).includes(secret))
})
