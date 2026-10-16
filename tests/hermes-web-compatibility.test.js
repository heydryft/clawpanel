// 失败清单先行；这些是隔离契约/HTTP拦截实测，不冒充 Windows VM 的真实兼容资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
const entry = new URL('../scripts/test-hermes-web-compatibility.mjs', import.meta.url), load = () => import(entry)
const oldSha = 'b'.repeat(40), newSha = 'a'.repeat(40), commit = 'f97608f178d1ffeca59860195ab7da295f7c8e5f', digest = '1'.repeat(64)

test('独立 Web scope；没有本机执行、安装、复制venv或native full资格', async () => {
  const m = await load(), p = m.webCompatibilityPlan()
  assert.equal(p.scope, 'new-app-old-runtime-web'); assert.equal(p.localExecution, false); assert.equal(p.installsKernel, false); assert.equal(p.copiesVenv, false); assert.equal(p.nativeQualification, false)
  const good = ['--execute', '--root', 'candidate-compat', '--sha', newSha, '--seed-sha', oldSha, '--web-output', 'old', '--build-output', 'build', '--output', 'new-output']
  assert.equal(m.webCompatibilityArgs(good)['--seed-sha'], oldSha)
  for (const args of [['--sha', 'main'], ['--seed-sha', 'abc1234'], ['--sha', oldSha, '--seed-sha', oldSha], ['--force'], ['--execute', '--plan'], ['--root', 'x', '--root', 'y']]) assert.throws(() => m.webCompatibilityArgs(args))
})

function complete() {
  const prompt = (i, model) => ({ nonce: 'native-acceptance-' + `${i}`.repeat(8) + '-0000-4000-8000-000000000000', model, reply: '完整 Unicode 🦀中文；' + i, sessionId: 'session-' + i, clickedSend: true, complete: true, refreshed: true })
  const prompts = [prompt(1, 'native-one'), prompt(2, 'native-two'), prompt(3, 'native-two')]
  return { status: 'passed-web-old-runtime-compatibility', scope: 'new-app-old-runtime-web', candidateSha: newSha, seedSha: oldSha, runtimeVersion: '0.21.5', actualChromium: true, browserVersion: 'fixture-Chromium', playwrightVersion: '1.60.0', prompts, provider: prompts.map(p => ({ nonce: p.nonce, model: p.model, title: false, authenticated: true })), runtimeChecks: ['before-ui', 'after-model-one', 'after-model-two', 'after-cleanup'].map(phase => ({ phase, installed: true, version: '0.21.5', commit })), blockedInstallerCommands: [], offline: { before: 2, after: 2, reconnected: true }, historyPreserved: true, memoryPreserved: true, hostUnchanged: true, sourceUnchanged: true, binaryUnchanged: true, distUnchanged: true, pageErrors: [], cleanup: { productionStop: true, pidsExited: true, portsClosed: true, identities: [{ pid: 401, creationDate: '2026-10-16T01:00:00.000Z' }], ports: [18791], present: [], listeners: [], reachablePorts: [] }, ownedPorts: [18791, 1420, 21420], finalOpenPorts: [], ownedProcessesExited: true, artifacts: { trace: { file: 'trace.zip', sha256: digest, bytes: 123 }, screenshots: [{ file: 'chat.png', sha256: digest, bytes: 123 }] }, sourceManifestSha256: digest, applicationSha256: digest, seedWebReportSha256: digest, seedNativeReportSha256: digest, buildReportSha256: digest, browserExecutableSha256: digest, playwrightEntrySha256: digest, playwrightPackageSha256: digest, coreEntrySha256: digest, corePackageSha256: digest, coreBundleSha256: digest, browserManifestSha256: digest }
}

test('Web 独立完整回执门禁接收全部证据；不以 Provider 的 native 名称视为native验收', async () => {
  const m = await load(); assert.doesNotThrow(() => m.assertWebCompatibilityComplete(complete()))
})

for (const fault of ['wrong-status', 'version-upgraded', 'source-upgraded', 'missing-version-phase', 'missing-model', 'not-clicked', 'incomplete-reply', 'no-refresh', 'replay', 'offline-replay', 'installer-attempt', 'history-lost', 'memory-lost', 'host-drift', 'source-drift', 'binary-drift', 'dist-drift', 'missing-trace', 'missing-screenshot', 'missing-seed-native', 'live-pid', 'open-port', 'page-error']) {
  test('失败清单保持红灯：' + fault, async () => {
    const m = await load(), r = complete()
    if (fault === 'wrong-status') r.status = 'passed-native-tauri'
    if (fault === 'version-upgraded') r.runtimeChecks[1].version = '0.22.2'
    if (fault === 'source-upgraded') r.runtimeChecks[1].commit = newSha
    if (fault === 'missing-version-phase') r.runtimeChecks.pop()
    if (fault === 'missing-model') r.prompts[0].model = 'native-two'
    if (fault === 'not-clicked') r.prompts[0].clickedSend = false
    if (fault === 'incomplete-reply') r.prompts[0].complete = false
    if (fault === 'no-refresh') r.prompts[0].refreshed = false
    if (fault === 'replay') r.provider.push({ ...r.provider[0] })
    if (fault === 'offline-replay') r.offline.after++
    if (fault === 'installer-attempt') r.blockedInstallerCommands.push({ cmd: 'update_hermes' })
    if (fault === 'history-lost') r.historyPreserved = false
    if (fault === 'memory-lost') r.memoryPreserved = false
    if (fault === 'host-drift') r.hostUnchanged = false
    if (fault === 'source-drift') r.sourceUnchanged = false
    if (fault === 'binary-drift') r.binaryUnchanged = false
    if (fault === 'dist-drift') r.distUnchanged = false
    if (fault === 'missing-trace') delete r.artifacts.trace
    if (fault === 'missing-screenshot') r.artifacts.screenshots = []
    if (fault === 'missing-seed-native') delete r.seedNativeReportSha256
    if (fault === 'live-pid') r.cleanup.present = [...r.cleanup.identities]
    if (fault === 'open-port') r.finalOpenPorts = [1420]
    if (fault === 'page-error') r.pageErrors.push('真实浏览器错误')
    assert.throws(() => m.assertWebCompatibilityComplete(r))
  })
}

test('真实 HTTP installer pre-import guard 在处理器之前拒绝全部变更入口，保留每条红灯', async t => {
  const m = await load(), base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'hermes-web-guard-'))
  let child
  t.after(async () => { if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)) }; const rel = path.relative(base, fs.realpathSync(root)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(root, { recursive: true, force: true }) })
  const guard = path.join(root, 'guard.mjs'), log = path.join(root, 'blocked.jsonl'), server = path.join(root, 'server.mjs')
  fs.writeFileSync(guard, m.installerGuardSource(log))
  fs.writeFileSync(server, `import http from 'node:http';const s=http.createServer((q,r)=>r.end('handler-ran'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`)
  child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, server], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('fixture server timeout')), 10000); child.once('error', reject); child.stdout.once('data', b => { clearTimeout(timer); resolve(Number(String(b).trim())) }) })
  for (const cmd of ['install_hermes', 'update_hermes', 'uninstall_hermes']) {
    const r = await fetch(`http://127.0.0.1:${port}/__api/${cmd}`, { method: 'POST', body: '{}' }); assert.equal(r.status, 403); assert.notEqual(await r.text(), 'handler-ran')
  }
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/__api/check_hermes`)).text(), 'handler-ran')
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).cmd), ['install_hermes', 'update_hermes', 'uninstall_hermes'])
})

test('本机 execute 在读取输入/HOME/hostSnapshot和启动候选前拒绝', async () => {
  await load()
  const r = spawnSync(process.execPath, [fileURLToPath(entry), '--execute', '--root', 'does-not-exist', '--sha', newSha, '--seed-sha', oldSha], { windowsHide: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' } })
  assert.equal(r.status, 1); assert.match(r.stderr, /资格|本机|runner|托管/); assert.doesNotMatch(r.stderr, /ENOENT/)
})

test('复用精确已安装 browser-tools，不增依赖、不改 pin；新serve与完整种子/rawmanifest校验先行', async () => {
  await load(); const text = fs.readFileSync(entry, 'utf8')
  assert.match(text, /browser-tools\/node_modules\/playwright\/index\.mjs/); assert.match(text, /1\.60\.0/)
  assert.match(text, /coreBundle\.registry\.registry\.findExecutable\('chromium-headless-shell'\)/)
  assert.match(text, /await loadQualificationChromium\(/); assert.match(text, /chromium\.launch\(\{ headless: true, executablePath: browserExe, env \}\)/)
  assert.match(text, /assertNativeComplete\(/); assert.match(text, /gitSourceManifest\(/); assert.match(text, /readNativeCompatibilityBinding\(/)
  assert.match(text, /scripts\/serve\.js/); assert.doesNotMatch(text, /npm.*install|pip.*install|copiesVenv:\s*true/)
  assert.ok(text.indexOf('validateRunnerProof(proof)') < text.indexOf('hostSnapshot(proof)'))
})

test('实际 CIM 模板枚举 HOME owned PID 的额外监听，不只看预选端口；STOP端口全被最终canary覆盖', async () => {
  const m = await load(), code = m.windowsWebSnapshotSource({ home: 'C:\\private\\h', ports: [1420], tracked: [401], webPid: 402, ownerPid: 403 })
  assert.match(code, /Get-CimInstance Win32_Process -ErrorAction Stop/)
  assert.match(code, /Get-NetTCPConnection -ErrorAction Stop/)
  assert.match(code, /\$private\.ProcessId -contains \[int\]\$_.OwningProcess/)
  assert.match(code, /CreationDate/); assert.match(code, /LocalAddress/)
  const r = complete(); r.cleanup.ports.push(45678); assert.throws(() => m.assertWebCompatibilityComplete(r))
})

test('真实文件回读拒绝原种子/build/manifest/工具二进制的缺失或字节漂移', async t => {
  const m = await load(), base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-web-files-'))
  t.after(() => { const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true }) })
  const files = {}
  for (const name of ['seed-web.json', 'seed-native.json', 'build-receipt.json', 'source-sha256.json', 'browser.exe']) { const f = path.join(dir, name); fs.writeFileSync(f, 'original fixture bytes'); files[f] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') }
  assert.doesNotThrow(() => m.assertWebFileCanaries(files))
  const file = Object.keys(files)[0]; fs.appendFileSync(file, 'drift'); assert.throws(() => m.assertWebFileCanaries(files))
  fs.unlinkSync(file); assert.throws(() => m.assertWebFileCanaries(files))
})

test('CIM读取失败也关闭 owned Chromium，并保持原失败', async () => {
  const m = await load(); let closed = false
  await assert.rejects(m.closeCompatibilityBrowser({ close: async () => { closed = true } }, () => { throw Error('CIM-read-failed') }), /CIM-read-failed/)
  assert.equal(closed, true)
})

// 新失败清单：旧/浮动PW或core、headed路径、非私有cache、缺exe/模块、链接、七项字节漂移；不安装/启动browser。
test('完整回执精确1.60.0且七项browser输入hash缺失均保持红灯', async () => {
  const m = await load()
  for (const version of ['1.58.2', '1.60.1', undefined]) { const r = complete(); r.playwrightVersion = version; assert.throws(() => m.assertWebCompatibilityComplete(r)) }
  for (const field of ['browserExecutableSha256', 'playwrightEntrySha256', 'playwrightPackageSha256', 'coreEntrySha256', 'corePackageSha256', 'coreBundleSha256', 'browserManifestSha256']) { const r = complete(); delete r[field]; assert.throws(() => m.assertWebCompatibilityComplete(r), assert.AssertionError, field) }
})

function browserFixture(t) {
  const parent = fs.realpathSync.native(os.tmpdir()), home = fs.mkdtempSync(path.join(parent, 'hermes-web-pw160-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(home)), parent); fs.rmSync(home, { recursive: true, force: true }) })
  const modules = path.join(home, 'browser-tools/node_modules'), pw = path.join(modules, 'playwright'), core = path.join(modules, 'playwright-core'), cache = path.join(home, '.browsers'), exe = path.join(cache, 'chromium_headless_shell-fixture', 'chrome-headless-shell.exe')
  for (const d of [pw, path.join(core, 'lib'), path.dirname(exe)]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(pw, 'index.mjs'), '// 自有惰性module字节canary，禁止browser启动')
  fs.writeFileSync(path.join(pw, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.60.0' }))
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.60.0' }))
  fs.writeFileSync(path.join(core, 'index.mjs'), '// 自有core module字节canary')
  fs.writeFileSync(path.join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: 'fixture' }] }))
  fs.writeFileSync(path.join(core, 'lib/coreBundle.js'), `const path=require('path');module.exports={registry:{registry:{findExecutable(name){if(name!=='chromium-headless-shell')throw Error('headed path forbidden');return {name,executablePath:()=>process.env.OWNED_BROWSER_OUTSIDE||path.join(process.env.PLAYWRIGHT_BROWSERS_PATH,'chromium_headless_shell-fixture','chrome-headless-shell.exe')}}}}}`)
  fs.writeFileSync(exe, 'owned inert bytes, not an executable or installation marker')
  return { home, cache, pw, core, exe, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache } }
}

test('真实私有child只解析headless-shell；七文件前后canary逐项拒绝漂移且不改父env', async t => {
  const m = await load(); assert.equal(typeof m.resolveWebCompatibilityBrowser, 'function')
  const envDigest = () => crypto.createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex')
  const f = browserFixture(t), parentEnv = envDigest(), r = m.resolveWebCompatibilityBrowser(f)
  assert.equal(r.browserExe, f.exe); assert.equal(r.playwrightEntry, path.join(f.pw, 'index.mjs')); assert.equal(r.playwrightVersion, '1.60.0'); assert.equal(Object.keys(r.files).length, 7)
  assert.equal(envDigest(), parentEnv, '只比较实际环境内容，避免特殊env原型和明文环境diff')
  for (const file of Object.keys(r.files)) { const original = fs.readFileSync(file); fs.appendFileSync(file, 'drift'); assert.throws(() => m.assertWebFileCanaries(r.files)); fs.writeFileSync(file, original) }
  assert.doesNotThrow(() => m.assertWebFileCanaries(r.files))
})

test('旧package/core、错误cache、cache外路径、缺binary和链接祖先均拒绝，不查全局或回退headed', async t => {
  const m = await load(); assert.equal(typeof m.resolveWebCompatibilityBrowser, 'function')
  const f = browserFixture(t)
  for (const file of [path.join(f.pw, 'package.json'), path.join(f.core, 'package.json')]) { const original = fs.readFileSync(file); fs.writeFileSync(file, JSON.stringify({ version: '1.58.2' })); assert.throws(() => m.resolveWebCompatibilityBrowser(f)); fs.writeFileSync(file, original) }
  assert.throws(() => m.resolveWebCompatibilityBrowser({ ...f, env: { ...f.env, PLAYWRIGHT_BROWSERS_PATH: f.home } }))
  assert.throws(() => m.resolveWebCompatibilityBrowser({ ...f, env: { ...f.env, OWNED_BROWSER_OUTSIDE: path.join(f.home, 'outside/chrome.exe') } }))
  fs.unlinkSync(f.exe); assert.throws(() => m.resolveWebCompatibilityBrowser(f)); fs.writeFileSync(f.exe, 'owned inert bytes')
  const moved = path.join(f.home, 'moved-cache'); fs.renameSync(f.cache, moved); fs.symlinkSync(moved, f.cache, process.platform === 'win32' ? 'junction' : 'dir')
  try { assert.throws(() => m.resolveWebCompatibilityBrowser(f)) } finally { fs.unlinkSync(f.cache); fs.renameSync(moved, f.cache) }
})
