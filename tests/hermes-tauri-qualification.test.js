import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const load = () => import('../scripts/test-hermes-tauri-qualification.mjs')
test('R6 Hermes session真实HTTP first-red：私有UDD经tauri webviewOptions且原错误仍抛出',async()=>{
 const {NativeWebDriver}=await load(),folder='C:\\qualification\\h\\.webview2-native-qualification',seen=[];let fail=false
 const server=http.createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):null;seen.push({url:req.url,body});res.setHeader('content-type','application/json');if(req.url==='/session'){if(fail||body?.capabilities?.alwaysMatch?.['tauri:options']?.webviewOptions?.userDataFolder!==folder){res.writeHead(500);res.end(JSON.stringify({value:{error:'session not created',message:"DevToolsActivePort file doesn't exist"}}));return}res.end(JSON.stringify({value:{sessionId:'isolated-http-not-native',capabilities:{browserName:'webview2'}}}))}else res.end(JSON.stringify({value:null}))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const c=new NativeWebDriver('http://127.0.0.1:'+server.address().port);await c.create('C:\\candidate\\clawpanel.exe',folder);assert.deepEqual(seen[0].body,{capabilities:{alwaysMatch:{'tauri:options':{application:'C:\\candidate\\clawpanel.exe',webviewOptions:{userDataFolder:folder}}}}});assert.equal(Object.hasOwn(seen[0].body.capabilities.alwaysMatch,'ms:edgeOptions'),false);assert.deepEqual(c.requestedCapabilities,seen[0].body);assert.deepEqual(seen[1].body,{script:120000,pageLoad:60000,implicit:0});await c.close();fail=true;await assert.rejects(new NativeWebDriver(c.base).create('C:\\candidate\\clawpanel.exe',folder),/DevToolsActivePort/);const count=seen.length;for(const bad of [undefined,'','relative','http://host/profile','C:\\qualification\\h\\..\\outside']){await assert.rejects(new NativeWebDriver(c.base).create('C:\\candidate\\clawpanel.exe',bad),/profile|userDataFolder/);assert.equal(seen.length,count)}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
})
test('R6 Hermes profile只读诊断：不创建/不遍历/不泄露DevTools endpoint并拒绝越界',async()=>{
 const {webviewProfileMetadata}=await load();assert.equal(typeof webviewProfileMetadata,'function');const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'hm-profile-meta-'))),home=path.join(root,'h'),folder=path.join(home,'udd');fs.mkdirSync(home)
 try{assert.equal(webviewProfileMetadata({home,userDataFolder:folder}).folder.exists,false);assert.equal(fs.existsSync(folder),false);fs.mkdirSync(path.join(folder,'EBWebView'),{recursive:true});const value='49345\n/devtools/browser/private-endpoint\n';fs.writeFileSync(path.join(folder,'DevToolsActivePort'),value);const r=webviewProfileMetadata({home,userDataFolder:folder});assert.equal(r.files.DevToolsActivePort.port,49345);assert.equal(r.files.DevToolsActivePort.sha256,crypto.createHash('sha256').update(value).digest('hex'));assert.equal(JSON.stringify(r).includes('private-endpoint'),false);assert.throws(()=>webviewProfileMetadata({home,userDataFolder:root}));const foreign=path.join(root,'foreign');fs.mkdirSync(foreign);fs.symlinkSync(foreign,path.join(home,'link'),'junction');assert.throws(()=>webviewProfileMetadata({home,userDataFolder:path.join(home,'link')}))
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('R6 Hermes实际启动caps绑定env同一私有UDD，未改120/60s或增加权限flag',()=>{
 const s=fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs',import.meta.url),'utf8');assert.match(s,/client\.create\(app, env\.WEBVIEW2_USER_DATA_FOLDER\)/);assert.match(s,/report\.sessionLaunch/);assert.match(s,/timeout = 120000/);assert.match(s,/pageLoad: 60000/);assert.doesNotMatch(s,/--no-sandbox|ignoreCertificateErrors|disable-web-security/)
})
const home = 'C:\\qualification\\h'
const listener = (port = 18791) => ({ port, pid: 401, creationDate: '2026-10-16T01:00:00.000Z', executablePath: home + '\\.hermes\\venv\\Scripts\\python.exe', commandLine: 'python -m hermes_cli gateway run' })
const stopped = () => ({ productionStop: true, identities: [listener()], present: [], listeners: [], ports: [18791], reachablePorts: [], pidsExited: true, portsClosed: true })
function completeFixture(NATIVE_STEPS) {
  const round = n => ({ round: n, sessionId: `native-session-${n}`, steps: [...NATIVE_STEPS], gatewayListeners: [listener()], profiles: { active: 'default', profiles: [{ name: 'default' }] }, stopProofs: [stopped(), stopped()], samples: Array.from({ length: 42 }, (_, i) => ({ startedMs: i * 5000, finishedMs: i * 5000 + 100, health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] })), elapsedSeconds: 210, observedErrors: [], historyReadbackAfterStop: true, prompts: [{ nonce: `native-${n}-a`, model: n === 1 ? 'native-one' : 'native-two' }, { nonce: `native-${n}-b`, model: n === 1 ? 'native-one' : 'native-two' }] })
  const rounds = [round(1), round(2)]
  return { completed: true, hostUnchanged: true, runtimeHome: home, gatewayPort: 18791, expectedVersion: '0.21.5', nativePage: { url: 'http://tauri.localhost/', ipc: true, windowLabel: 'main' }, rounds, cleanup: { ...stopped(), final: stopped() }, nativeInstallerLifecycle: ['update', 'uninstall', 'reinstall'].map(name => ({ name, passed: true, dataPreserved: true })), nativeProcessesExited: true, driverPortsClosed: true, provider: rounds.flatMap(x => x.prompts.map(p => ({ ...p, title: false, authenticated: true }))), profileRuntimeSource: { version: '0.21.5', commit: oldCommit, headBefore: oldCommit, headAfter: oldCommit }, namedProfiles: [namedProfileFixture()], namedProfileStopProof: stopped(), executionMode: 'actual-github-hosted-windows-vm-native', runner: runnerFixture(), tooling: toolingFixture(), profileQualificationModuleSha256: digest, profileCollisionModuleSha256: digest, profileCollision: collisionFixture(), profileCollisionDerivations: derivationsFixture() }
}
const appSha = 'a'.repeat(40), seedSha = 'b'.repeat(40)
const oldCommit = 'f97608f178d1ffeca59860195ab7da295f7c8e5f', newCommit = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const digest = '1'.repeat(64)
const toolingFiles = ['scripts/test-hermes-tauri-qualification.mjs', 'scripts/test-hermes-windows-qualification.mjs', 'scripts/hermes-qualification-provider.mjs', 'scripts/hermes-qualification-profiles.mjs', 'scripts/hermes-qualification-profile-collision.mjs']
function runnerFixture() { return { platform: 'win32', arch: 'x64', runnerEnvironment: 'github-hosted', runnerOS: 'Windows', event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'qingchencloud/clawpanel', workflowRef: 'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main', workflowSha: appSha, toolingSha: appSha, runId: '123', attempt: '1', imageOS: 'win25', imageVersion: '20261016', userName: 'runneradmin', sid: 'S-1-5-21-1-2-3-4', actualProfile: 'C:\\Users\\runneradmin', registeredProfile: 'C:\\Users\\runneradmin', virtualMachine: true } }
function toolingFixture() { const snapshot = { sha: appSha, files: Object.fromEntries(toolingFiles.map(f => [f, { sha256: digest, gitBlob: '2'.repeat(40) }])) }; return { sha: appSha, scope: 'github-hosted-main-native-tooling', before: structuredClone(snapshot), after: structuredClone(snapshot) } }
function artifactBinding(kind) { return { scope: 'actual-native-profile-artifact', toolingSha: appSha, sourceCommit: oldCommit, version: '0.21.5', home, kind, directory: kind === 'named-profile' ? 'named-profile-ui-default' : 'profile-collision', moduleHashes: Object.fromEntries(toolingFiles.map(f => [f, digest])), reportFile: kind === 'named-profile' ? 'profile-qualification.json' : 'profile-collision.json', reportSha256: digest, envelopeFile: 'native-bound.json', envelopeSha256: digest } }
function collisionFixture() {
  const nonce = 'abcdef012345678901234567', marker = 'ClawPanel profile collision 123/1/' + nonce
  const cases = ['rename', 'delete'].map(operation => {
    const name = `qualc-${nonce}-${operation}`, taskName = 'original-' + name, script = `C:\\evidence\\foreign-home\\${operation}\\never-run.ps1`
    const task = { state: 'exists', name: taskName, marker, sha256: digest, enabled: false, triggers: 0, userId: runnerFixture().sid, runLevel: 0, logonType: 3, lastRunTime: '1899-12-30T00:00:00', lastTaskResult: 0x41303, action: script, actions: 1, allowDemandStart: false, executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }
    return { operation, name, renamed: name + '-renamed', stage: 'complete', priorTask: { state: 'missing', hresult: '0x80070002' }, derivation: { taskName, profileHome: `${home}\\.hermes\\profiles\\${name}`, python: `${home}\\.hermes\\hermes-agent\\venv\\Scripts\\python.exe`, method: 'original-get_task_name', sourceCommit: oldCommit }, sentinel: { name: taskName, marker, sid: runnerFixture().sid, script }, taskBefore: task, taskAfter: structuredClone(task), executionCount: 0, executionProof: 'SCHED_S_TASK_HAS_NOT_RUN + unchanged LastRunTime + absent owned execution canary', sentinelRemoved: true, normalCrudPassed: true, normalCrudLayer: 'actual Dashboard API via Rust IPC + filesystem/list readback', collisionDisposition: 'old21-profile-mutation-succeeded-task-retained', receipts: [{ method: operation === 'rename' ? 'PATCH' : 'DELETE', path: '/api/profiles/' + name, ok: true }], treeBefore: [{ path: '', type: 'directory' }], foreignBefore: [{ path: 'never-run.ps1', bytes: 10, sha256: digest }] }
  })
  return { schemaVersion: 1, status: 'passed-windows-profile-collision', evidenceKind: 'real-windows-vm-native-modal', version: '0.21.5', source: { sourceCommit: oldCommit, sourceHashes: Object.fromEntries(['hermes_constants.py', 'hermes_cli/gateway.py', 'hermes_cli/gateway_windows.py', 'hermes_cli/profiles.py'].map(f => [f, digest])) }, nonce, marker, runId: '123', attempt: '1', cases, screenshots: ['rename-collision.png', 'delete-collision.png'].map(file => ({ file, sha256: digest })), gaps: [], errors: [], nativeBinding: artifactBinding('collision') }
}
function derivationsFixture() { return collisionFixture().cases.map(c => ({ profile: c.name, taskName: c.derivation.taskName, sourceCommit: oldCommit, home, profileHome: c.derivation.profileHome, python: c.derivation.python, sourceFile: `${home}\\.hermes\\hermes-agent\\hermes_cli\\gateway_windows.py`, program: c.derivation.python, role: 'legacy-private-venv-get-task-name', exitCode: 0, commandSha256: digest, stdoutSha256: digest, stderrSha256: digest, programSha256: digest, pythonSha256: digest, sourceFileSha256: digest, evidenceKind: 'actual-private-runtime-python' })) }
function namedProfileFixture() {
  const name = 'qualp-123456abcdef', renamed = name + '-renamed'
  return { schemaVersion: 1, status: 'passed', evidenceKind: 'production-ipc-native-gui', version: '0.21.5', expectedCommit: oldCommit, provider: 'custom', model: 'native-two', defaultSessionId: 'native-session-2', modelReadback: { provider: 'custom', model: 'native-two' }, name, renamed, cloneFromDefault: true, noSkills: false,
    steps: ['baseline-history-and-task-definitions', 'dashboard-proxy-create-and-model-readback', 'default-to-named-gui-runtime-and-boot', 'stop-named-restore-default', 'gui-rename-delete-and-physical-readback'],
    screenshots: ['named-visible.png', 'named-active.png', 'restored-default.png', 'before-rename.png', 'renamed-visible.png', 'deleted.png'].map(file => ({ file, sha256: digest })),
    namedListeners: [listener()], defaultListeners: [listener()], namedRuntime: { file: `profiles/${name}/gateway_state.json`, sha256: digest, pid: 401, profile: name }, boot: { applicable: false, reason: 'legacy-no-PM-boot-record-contract' },
    guiReceipts: [{ method: 'PATCH', path: `/api/profiles/${name}`, ok: true, name: renamed }, { method: 'DELETE', path: `/api/profiles/${renamed}`, ok: true, identity_settled: true, settlement_pending: false }],
    historyBefore: { sha256: digest, messages: 2 }, historyAfter: { sha256: digest, messages: 2 }, tasks: { before: [{ name: '\\ReadonlyTask', sha256: digest }], after: [{ name: '\\ReadonlyTask', sha256: digest }] }, nativeBinding: artifactBinding('named-profile'), gaps: [], errors: [], startedAt: '2026-10-16T01:00:00.000Z', finishedAt: '2026-10-16T01:01:00.000Z' }
}
function seedFixture() {
  const runner = { sid: 'S-1-5-21-1-2-3-4', actualProfile: 'C:\\Users\\runneradmin', runId: '123', attempt: '1', imageOS: 'win25', imageVersion: '20261016', virtualMachine: true }
  return { appSha, seedSha, home, webOutput: 'C:\\qualification', runner, seedProof: { ...runner }, release: { version: '0.21.5', commit: oldCommit }, completion: { version: '0.21.5', commit: oldCommit }, prior: { status: 'passed-web-native-missing', candidateSha: seedSha, expectedVersion: '0.21.5', hostUnchanged: true, environment: { home, hermesHome: home + '\\.hermes', sourceSha: seedSha }, stages: ['source-isolation', 'install-privatecompletion', 'runtime-ui', 'update-stop', 'uninstall-reinstall-preserve'].map(name => ({ name, status: 'passed' })), browser: { actualChromium: true, completeReply: true, historyAfterReload: true, pageErrors: [], trace: 'trace.zip', screenshots: ['history.png'], prompts: [{ nonce: 'hq-seed', reply: 'seed reply', model: 'seed' }] } } }
}
function bindingFixture() {
  return { candidateSha: appSha, rootSha: appSha, sourceHashes: Object.fromEntries(['scripts/dev-api.js', 'src-tauri/src/commands/hermes.rs', 'src-tauri/src/lib.rs', 'src-tauri/Cargo.lock', 'package.json'].map(f => [f, digest])), sourceManifestSha256: digest, application: { path: 'C:\\candidate\\clawpanel.exe', sha256: digest }, build: { status: 'passed', candidateSha: appSha, hostUnchanged: true, sourceManifestSha256: digest, application: { path: 'C:\\candidate\\clawpanel.exe', sha256: digest } } }
}
function compatibilityFixture(NATIVE_STEPS) {
  const r = completeFixture(NATIVE_STEPS)
  delete r.nativeInstallerLifecycle
  Object.assign(r, { mode: 'new-app-old-runtime-native', status: 'passed-native-old-runtime-compatibility', seedSha, candidateSha: appSha, ipc: [], application: bindingFixture().application, webQualification: { path: 'C:\\qualification', sha256: digest } })
  r.compatibility = { seed: seedFixture(), appPin: { version: '0.22.2', commit: newCommit }, binding: bindingFixture(), blockedInstallerCommands: [], runtimeChecks: ['before-ui', 'after-round-1', 'after-round-2', 'after-ui'].map(phase => ({ phase, installed: true, version: '0.21.5', commit: oldCommit, hermesHome: home + '\\.hermes' })), finalRuntimeHead: oldCommit, seedMemoryPreserved: true, seedHistoryPreserved: true }
  return r
}

test('实际 Rust 配置目录契约是对象，拒绝字符串、缺失配置和其他 HOME', async () => {
  const { assertNativeConfigDir } = await load()
  assert.equal(typeof assertNativeConfigDir, 'function')
  const dir = process.cwd()
  assert.doesNotThrow(() => assertNativeConfigDir({ path: dir, isCustom: true, configExists: true }, dir))
  for (const bad of [dir, { path: dir }, { path: dir, isCustom: false, configExists: true }, { path: dir, isCustom: true, configExists: false }, { path: dir + '/other', isCustom: true, configExists: true }]) assert.throws(() => assertNativeConfigDir(bad, dir))
})

test('native 必须实际走 Rust 更新、卸载及保留历史重装，不由既有 Web 安装代替', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /ipc\('update_hermes', \{\}, 900000\)/)
  assert.match(source, /ipc\('uninstall_hermes', \{ cleanConfig: false \}\)/)
  assert.match(source, /ipc\('install_hermes', \{ method: 'uv-tool', extras: \[\] \}, 900000\)/)
  assert.match(source, /nativeInstallerLifecycle/)
  assert.match(source, /hermes-install-log/)
})

test('native Tauri 计划只在一次性 Windows runner 执行，不以 Web 代替', async () => {
  const q = await load()
  const plan = q.nativePlan()
  assert.equal(plan.installsOnLocalHost, false)
  assert.equal(plan.webdriver, 'tauri-driver + Microsoft Edge Driver')
  assert.equal(plan.uiRounds, 2)
  assert.equal(plan.holdSeconds, 210)
  assert.equal(plan.webFallback, false)
  assert.equal(plan.productPluginsAdded, false)
})

test('native 参数拒绝浮动 SHA、未知参数和缩短长会话验收', async () => {
  const { nativeArgs } = await load()
  assert.throws(() => nativeArgs(['--sha', 'main']), /SHA/)
  assert.throws(() => nativeArgs(['--execute', '--hold', '10']), /210/)
  assert.throws(() => nativeArgs(['--mock']), /未知/)
  assert.throws(() => nativeArgs(['--version', 'latest']), /版本/)
})

test('native 来源拒绝普通 Web、远程页面、无真实 IPC 及窗口身份', async () => {
  const { assertNativePage } = await load()
  const identity = { url: 'http://tauri.localhost/', ipc: true, windowLabel: 'main' }
  assert.doesNotThrow(() => assertNativePage(identity))
  assert.doesNotThrow(() => assertNativePage({ ...identity, url: 'tauri://localhost/' }))
  for (const bad of [
    { url: 'http://127.0.0.1:1420/' }, { url: 'https://example.test/' },
    { url: 'http://tauri.localhost.evil/' }, { ipc: false }, { windowLabel: '' },
  ]) assert.throws(() => assertNativePage({ ...identity, ...bad }), /native/)
})

test('W3C 真实协议错误不伪造成功、不回退到 HTTP API', async () => {
  const { NativeWebDriver } = await load()
  const calls = []
  const server = http.createServer(async (req, res) => {
    calls.push(req.url)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ value: { error: 'session not created', message: 'driver mismatch' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new NativeWebDriver(`http://127.0.0.1:${server.address().port}`)
    await assert.rejects(client.create('C:\\candidate\\clawpanel.exe', 'C:\\qualification\\h\\.webview2-native-qualification'), /driver mismatch/)
    assert.deepEqual(calls, ['/session'])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('本机 execute 在任何候选/driver 启动前拒绝', async () => {
  await load()
  const r = spawnSync(process.execPath, [new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--execute'], {
    env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', GITHUB_WORKFLOW_REF: '' },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /一次性|资格|runner/)
})

test('native 完整回执拒绝短测、漏步骤、运行错误和原生进程残留', async () => {
  const { assertNativeComplete, NATIVE_STEPS } = await load()
  const r = completeFixture(NATIVE_STEPS)
  assert.doesNotThrow(() => assertNativeComplete(r))
  for (const mutate of [
    x => { x.rounds[0].samples.pop() }, x => { x.rounds[1].elapsedSeconds = 209 },
    x => { x.rounds[0].steps.pop() }, x => { x.rounds[1].observedErrors.push('error') },
    x => { x.cleanup.pidsExited = false }, x => { x.nativeProcessesExited = false },
    x => { x.provider.push(x.provider[0]) }, x => { x.hostUnchanged = false }, x => { x.rounds[0].historyReadbackAfterStop = false },
    x => { x.nativeInstallerLifecycle.pop() }, x => { x.nativeInstallerLifecycle[0].passed = false }, x => { x.nativeInstallerLifecycle[2].dataPreserved = false },
  ]) { const bad = structuredClone(r); mutate(bad); assert.throws(() => assertNativeComplete(bad)) }
})

test('完整与新app旧runtime资格都必须具备完整 namedProfiles 实测，不因default列表/文件存在补绿', async () => {
  const { assertNativeComplete, assertNativeCompatibilityComplete, NATIVE_STEPS } = await load()
  for (const [fixture, gate] of [[completeFixture, assertNativeComplete], [compatibilityFixture, assertNativeCompatibilityComplete]]) {
    const good = fixture(NATIVE_STEPS); assert.doesNotThrow(() => gate(good))
    for (const mutate of [
      r => { delete r.namedProfiles }, r => { r.namedProfiles = [{ status: 'passed', file: 'profile-qualification.json' }] },
      r => { r.namedProfiles[0].evidenceKind = 'isolated-fixture' }, r => { r.namedProfiles[0].steps.pop() },
      r => { r.namedProfiles[0].noSkills = true }, r => { r.namedProfiles[0].cloneFromDefault = false },
      r => { r.namedProfiles[0].defaultSessionId = 'first-round-not-last' }, r => { r.namedProfiles[0].model = 'native-one' },
      r => { r.namedProfiles[0].modelReadback.model = 'other' }, r => { r.namedProfiles[0].namedListeners = [] },
      r => { r.namedProfiles[0].namedRuntime.pid = 999 }, r => { r.namedProfiles[0].defaultListeners = [] },
      r => { r.namedProfiles[0].historyAfter.sha256 = '2'.repeat(64) }, r => { delete r.namedProfiles[0].tasks },
      r => { r.namedProfiles[0].tasks.after = [] }, r => { r.namedProfiles[0].guiReceipts.pop() },
      r => { r.namedProfiles[0].guiReceipts[1].settlement_pending = true }, r => { r.namedProfiles[0].screenshots = [] },
      r => { r.namedProfiles[0].errors.push('unhandled') }, r => { r.namedProfiles[0].gaps.push('missing') },
      r => { r.profileRuntimeSource.headAfter = newCommit }, r => { delete r.namedProfileStopProof },
    ]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => gate(bad), 'namedProfiles 实测缺项必须失败') }
  }
})

test('新22.2 named boot必须绑定真实expectedcommit；旧21.5不虚构PM boot/served字段', async () => {
  const { assertNativeNamedProfiles, NATIVE_STEPS } = await load(); assert.equal(typeof assertNativeNamedProfiles, 'function')
  const old = completeFixture(NATIVE_STEPS); assert.doesNotThrow(() => assertNativeNamedProfiles(old))
  const current = structuredClone(old); current.expectedVersion = '0.22.2'
  current.profileRuntimeSource = { version: '0.22.2', commit: newCommit, headBefore: newCommit, headAfter: newCommit }
  Object.assign(current.namedProfiles[0], { version: '0.22.2', expectedCommit: newCommit, boot: { applicable: true, file: `installs/1234567890abcdef/bootstrap/${current.namedProfiles[0].name}.json`, sha256: digest, identity: newCommit, bootstrappedAt: '2026-10-16T01:00:00Z', steps: ['migrate', 'expose_cli'] } })
  current.namedProfiles[0].namedRuntime.servedProfiles = [current.namedProfiles[0].name]
  Object.assign(current.namedProfiles[0].nativeBinding, { version: '0.22.2', sourceCommit: newCommit })
  assert.doesNotThrow(() => assertNativeNamedProfiles(current))
  for (const mutate of [r => { delete r.namedProfiles[0].boot }, r => { r.namedProfiles[0].boot.identity = oldCommit }, r => { r.namedProfiles[0].boot.steps = [] }, r => { r.namedProfiles[0].expectedCommit = oldCommit }, r => { r.namedProfiles[0].boot.bootstrappedAt = '' }, r => { r.namedProfiles[0].boot.file = 'installs/other-profile.json' }, r => { r.namedProfiles[0].namedRuntime.servedProfiles = [] }]) { const bad = structuredClone(current); mutate(bad); assert.throws(() => assertNativeNamedProfiles(bad)) }
})

test('真实native接线在两轮UI后、installer之前用同client/ipc/端口/监听和最后session，默认true/false', () => {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /import[^\n]*qualifyHermesProfiles[^\n]*hermes-qualification-profiles\.mjs/)
  const call = source.indexOf('await qualifyHermesProfiles('), afterRounds = source.indexOf('for (const prompt of report.rounds.flatMap'), lifecycle = source.indexOf('report.nativeInstallerLifecycle = []')
  assert.ok(call > afterRounds && call < lifecycle)
  const wiring = source.slice(call, source.indexOf('})', call) + 2)
  for (const value of ['ipc', 'client', 'gatewayPort', 'runtimeSnapshot', "model: 'native-two'", "provider: 'custom'", 'defaultSessionId: report.rounds.at(-1).sessionId', 'cloneFromDefault: true', 'noSkills: false', 'expectedCommit: release.commit']) assert.ok(wiring.includes(value), value)
  assert.match(source, /profileQualificationModuleSha256/); assert.match(source, /assertNativeNamedProfiles\(r\)/)
})

// 先列失败方式：fixture冒充、缺 helper/Git blob/pre-post、缺碰撞/派生、来源/owner/Python错、遗漏一个mutation。
test('full/compat都强制真实collision及五个tooling依赖pre/post，fixture/status bool不能补绿', async () => {
  const { NATIVE_STEPS, assertNativeComplete, assertNativeCompatibilityComplete } = await load()
  for (const [make, gate] of [[completeFixture, assertNativeComplete], [compatibilityFixture, assertNativeCompatibilityComplete]]) {
    const good = make(NATIVE_STEPS); assert.doesNotThrow(() => gate(good))
    for (const mutate of [
      r => { delete r.executionMode }, r => { r.executionMode = 'isolated-fixture' }, r => { delete r.tooling },
      r => { r.tooling.sha = seedSha }, r => { r.tooling.scope = 'fixture' }, r => { delete r.tooling.after },
      r => { delete r.tooling.before.files[toolingFiles[3]] }, r => { r.tooling.after.files[toolingFiles[4]].sha256 = '3'.repeat(64) },
      r => { r.profileQualificationModuleSha256 = '' }, r => { r.profileCollisionModuleSha256 = '' },
      r => { delete r.profileCollision }, r => { r.profileCollision = { status: 'passed-windows-profile-collision' } },
      r => { r.profileCollision.evidenceKind = 'isolated-fixture' }, r => { r.profileCollision.status = 'passed-fixture' },
      r => { r.profileCollision.cases.pop() }, r => { r.profileCollision.cases[0].normalCrudPassed = false },
      r => { r.profileCollision.cases[0].executionCount = 1 }, r => { r.profileCollision.cases[0].taskAfter.sha256 = '4'.repeat(64) },
      r => { r.profileCollision.cases[0].taskBefore.enabled = true }, r => { r.profileCollision.cases[0].taskBefore.userId = 'S-1-5-18' },
      r => { for (const key of ['taskBefore', 'taskAfter']) r.profileCollision.cases[0][key].actions = 2 },
      r => { for (const key of ['taskBefore', 'taskAfter']) r.profileCollision.cases[0][key].allowDemandStart = true },
      r => { r.profileCollision.cases[0].sentinel.marker = 'foreign' },
      r => { r.profileCollision.source.sourceCommit = newCommit }, r => { r.profileCollision.source.sourceHashes = {} },
      r => { r.profileCollision.nativeBinding.toolingSha = seedSha }, r => { delete r.namedProfiles[0].nativeBinding },
      r => { delete r.profileCollision.nativeBinding.directory }, r => { r.namedProfiles[0].nativeBinding.directory = '../foreign' },
      r => { r.namedProfiles[0].nativeBinding.moduleHashes[toolingFiles[0]] = '' },
      r => { r.profileCollisionDerivations = [] }, r => { r.profileCollisionDerivations[0].evidenceKind = 'fixture' },
      r => { r.profileCollisionDerivations[0].python = 'C:\\foreign\\python.exe' }, r => { r.profileCollisionDerivations[0].sourceFile = 'C:\\foreign\\gateway_windows.py' },
      r => { r.profileCollisionDerivations[0].exitCode = 1 }, r => { r.profileCollision.errors.push('failed') },
      r => { r.profileCollisionDerivations[0].sourceFileSha256 = 'f'.repeat(64) }, r => { delete r.profileCollisionDerivations[0].programSha256 },
      r => { r.profileCollisionDerivations[0].program = home + '\\foreign\\python.exe' },
    ]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => gate(bad)) }
  }
})

test('tooling读取必须是完整五文件实际Git blob SHA1/SHA256，不接受工作区字节/stale SHA', async t => {
  const { readNativeToolingSnapshot } = await load(); assert.equal(typeof readNativeToolingSnapshot, 'function')
  const base = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'native-tooling-owned-'))
  t.after(() => { assert.ok(path.relative(base, fs.realpathSync(root)).startsWith('native-tooling-owned-')); fs.rmSync(root, { recursive: true, force: true }) })
  const git = a => { const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  git(['init', '-q']); git(['config', 'core.autocrlf', 'false']); git(['config', 'user.name', 'fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  for (const f of toolingFiles) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), '// isolated fixture\n') }
  git(['add', '--', ...toolingFiles]); git(['commit', '-qm', 'fixture']); const sha = git(['rev-parse', 'HEAD'])
  const actual = readNativeToolingSnapshot({ root, sha }); assert.equal(Object.keys(actual.files).length, 5)
  for (const f of toolingFiles) { assert.match(actual.files[f].gitBlob, /^[a-f0-9]{40}$/); assert.match(actual.files[f].sha256, /^[a-f0-9]{64}$/) }
  assert.throws(() => readNativeToolingSnapshot({ root, sha: appSha }))
  fs.appendFileSync(path.join(root, toolingFiles[3]), '// changed'); assert.throws(() => readNativeToolingSnapshot({ root, sha }))
})

test('碰撞实际接线复用privatecompletion，oldvenv/new LAUNCH固定Python不接受HTTP/任意code', async t => {
  const { buildNativeTaskNameCommand } = await load(); assert.equal(typeof buildNativeTaskNameCommand, 'function')
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'native-python-owned-'))
  t.after(() => { assert.ok(path.relative(base, fs.realpathSync(dir)).startsWith('native-python-owned-')); fs.rmSync(dir, { recursive: true, force: true }) })
  const h = path.join(dir, 'h'), root = path.join(dir, 'app'), source = path.join(h, '.hermes/hermes-agent'), profileHome = path.join(h, '.hermes/profiles/qualc-fixture')
  const write = f => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'fixture not executed') }
  fs.mkdirSync(profileHome, { recursive: true })
  const python = path.join(source, 'venv/Scripts/python.exe'), cli = path.join(source, 'venv/Scripts/hermes.exe'); write(python); write(cli)
  const modules = Object.fromEntries(['hermes_cli.main', 'fastapi', 'uvicorn'].map(n => { const f = path.join(source, 'fixture-modules', n + '.py'); write(f); return [n, f] }))
  const stages = ['repository', 'venv', 'python-deps', 'config', 'complete']
  const completion = { version: '0.21.5', commit: oldCommit, python, cli, modules, commandSpec: { program: cli, args: ['--version'], role: 'legacy-managed-hermes-cli' }, requiredStages: stages, stages: stages.map(name => ({ name, exitCode: 0 })) }
  const options = { root, home: h, profileHome, release: { version: '0.21.5', commit: oldCommit }, completion }
  const spec = buildNativeTaskNameCommand(options); assert.equal(spec.program, python); assert.deepEqual(spec.args.slice(0, 3), ['-I', '-B', '-c']); assert.match(spec.args[3], /get_task_name|redirect_stdout/); assert.equal(spec.role, 'legacy-private-venv-get-task-name')
  for (const mutate of [x => { x.profileHome = root }, x => { x.release.commit = newCommit }, x => { x.completion.commandSpec.args = ['-c', 'arbitrary'] }, x => { x.completion.python = 'https://example.invalid/python' }, x => { x.completion.commandSpec.program = 'python' }]) { const bad = structuredClone(options); mutate(bad); assert.throws(() => buildNativeTaskNameCommand(bad)) }
  const helper = path.join(root, 'scripts/hermes-pm-runtime.js'), launch = `PIN='${newCommit}'\n# fixture LAUNCH not executed`, metadata = `PIN='${newCommit}'\n# fixture metadata not executed`
  fs.mkdirSync(path.dirname(helper), { recursive: true }); fs.writeFileSync(helper, `export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw\`${launch}\n\`\nexport const HERMES_PRIVATE_METADATA_SCRIPT = String.raw\`${metadata}\n\`\n`)
  const dependency = path.join(h, '.hermes/installs/key/environments/fixture/Scripts/python.exe'), selected = path.join(h, '.hermes/tools/python/python.exe'); write(dependency); write(selected)
  const current = structuredClone(options); current.release = { version: '0.22.2', commit: newCommit }
  Object.assign(current.completion, { version: '0.22.2', commit: newCommit, python: selected, commandSpec: { program: dependency, args: ['-I', '-B', '-c', metadata, source, newCommit], role: 'pm-bootstrap-metadata', actualSelectedInterpreter: selected }, pm: { selectedStorePython: selected, dependencyPython: dependency, helperSha256: crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex'), completion: { commit: newCommit, current: true, same: true, completed: true, pending: false }, preflight: { commit: newCommit, current: true, same: true, completed: true, command: ['profile', 'list'] } } })
  const pm = buildNativeTaskNameCommand(current); assert.equal(pm.program, dependency); assert.equal(pm.args[3], launch); assert.equal(pm.args.at(-2), '--python-json'); assert.equal(pm.role, 'pm-launch-get-task-name')
  for (const mutate of [x => { x.completion.pm.helperSha256 = '0'.repeat(64) }, x => { x.completion.commandSpec.args[3] = 'arbitrary code' }, x => { x.completion.commandSpec.program = python }]) { const bad = structuredClone(current); mutate(bad); assert.throws(() => buildNativeTaskNameCommand(bad)) }
})

test('完整门禁拒绝补采、错误health、空PID及伪profiles证明', async () => {
  const { assertNativeComplete, NATIVE_STEPS } = await load()
  for (const mutate of [
    r => { r.rounds[0].samples.forEach(s => { s.startedMs = 0; s.finishedMs = 100 }) },
    r => { r.rounds[0].samples[0].finishedMs = 5000 },
    r => { r.rounds[0].samples[1].health.status = 'error' },
    r => { r.rounds[0].samples[1].health.platform = 'other' },
    r => { r.rounds[0].samples[1].health.version = '0.22.2' },
    r => { r.rounds[0].gatewayListeners = [] },
    r => { r.rounds[0].samples[1].listeners = [] },
    r => { r.rounds[0].samples[1].listeners[0].creationDate = '2026-10-16T01:01:00.000Z' },
    r => { r.rounds[0].stopProofs = [] },
    r => { r.cleanup.identities = [] },
    r => { r.cleanup.final.present = [listener()] },
    r => { r.cleanup.final.listeners = [listener()] },
    r => { r.cleanup.final.reachablePorts = [18791] },
    r => { r.cleanup.final.ports = [] },
    r => { r.rounds[0].profiles = { active: 'default', profiles: [] } },
    r => { r.rounds[0].profiles = { active: 'default', profiles: { name: 'default' } } },
  ]) { const bad = completeFixture(NATIVE_STEPS); mutate(bad); assert.throws(() => assertNativeComplete(bad)) }
})

test('严格42窗口调度：慢IPC跨窗立即失败，不补采；健康三字段实际校验', async () => {
  const { collectNativeSamples } = await load()
  assert.equal(typeof collectNativeSamples, 'function')
  let clock = 0, count = 0
  const item = { samples: [] }
  const options = { item, version: '0.21.5', home, port: 18791, expected: [listener()], now: () => clock, sleep: async ms => { clock += ms }, sample: async () => { count++; clock += 100; return { health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] } } }
  await collectNativeSamples(options)
  assert.equal(clock, 210000); assert.equal(count, 42); assert.equal(item.samples.length, 42)
  for (const duration of [5000, 60000]) {
    clock = 0; count = 0
    await assert.rejects(collectNativeSamples({ ...options, item: { samples: [] }, sample: async () => { count++; clock += duration; return { health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5' }, listeners: [listener()] } } }), /窗口/)
    assert.equal(count, 1, '跨窗后不得补采剩余41条')
  }
  for (const patch of [{ status: 'error' }, { platform: 'wrong' }, { version: '0.22.2' }]) {
    clock = 0
    await assert.rejects(collectNativeSamples({ ...options, item: { samples: [] }, sample: async () => ({ health: { status: 'ok', platform: 'hermes-agent', version: '0.21.5', ...patch }, listeners: [listener()] }) }))
  }
})

test('监听身份绑定私有HOME+端口+PID+CreationDate，拒绝空集、换代和伪归属', async () => {
  const { assertNativeListeners } = await load()
  assert.equal(typeof assertNativeListeners, 'function')
  const options = { home, ports: [18791], expected: [listener()] }
  assert.doesNotThrow(() => assertNativeListeners([listener()], options))
  for (const rows of [[], [{ ...listener(), pid: 0 }], [{ ...listener(), port: 9119 }], [{ ...listener(), creationDate: null }], [{ ...listener(), creationDate: '2026-10-16T01:02:00.000Z' }], [{ ...listener(), executablePath: 'C:\\Windows\\python.exe', commandLine: 'python' }], [{ ...listener(), executablePath: home + '-other\\python.exe' }]]) assert.throws(() => assertNativeListeners(rows, options))
  assert.doesNotThrow(() => assertNativeListeners([{ ...listener(), executablePath: 'C:\\Python\\python.exe', commandLine: `python "${home}\\.hermes\\hermes-agent\\hermes.py"` }], { home, ports: [18791] }))
})

test('STOP非空身份与全部端口强校验，PID复用不得误认旧进程存活', async () => {
  const { assertNativeStopped } = await load()
  assert.equal(typeof assertNativeStopped, 'function')
  assert.doesNotThrow(() => assertNativeStopped(stopped()))
  assert.doesNotThrow(() => assertNativeStopped({ ...stopped(), present: [{ ...listener(), creationDate: '2026-10-16T02:00:00.000Z' }] }))
  for (const patch of [{ identities: [] }, { ports: [] }, { present: [listener()] }, { listeners: [listener()] }, { reachablePorts: [18791] }]) assert.throws(() => assertNativeStopped({ ...stopped(), ...patch }))
})

test('清理每项独立：截图/STOP失败也执行dashboard、session和最终PID端口校验', async () => {
  const { runNativeCleanup } = await load()
  assert.equal(typeof runNativeCleanup, 'function')
  const calls = []
  const failures = await runNativeCleanup(Object.fromEntries(['screenshot', 'gatewayStop', 'dashboardStop', 'sessionClose', 'driver', 'provider', 'native', 'runtimeFinal', 'portsFinal', 'hostFinal'].map(name => [name, async () => { calls.push(name); if (['screenshot', 'gatewayStop', 'sessionClose'].includes(name)) throw new Error(name + ' failed') }])))
  assert.deepEqual(calls, ['screenshot', 'gatewayStop', 'dashboardStop', 'sessionClose', 'driver', 'provider', 'native', 'runtimeFinal', 'portsFinal', 'hostFinal'])
  assert.deepEqual(failures.map(x => x.step), ['screenshot', 'gatewayStop', 'sessionClose'])
})

test('profiles必须实际数组并含default，明确每次refresh监听空窗', async () => {
  const { assertNativeProfiles } = await load()
  assert.equal(typeof assertNativeProfiles, 'function')
  assert.doesNotThrow(() => assertNativeProfiles({ active: 'default', profiles: [{ name: 'default' }] }))
  for (const bad of [null, true, {}, { active: 'default', profiles: [] }, { profiles: { name: 'default' } }, { profiles: [{ name: 'other' }] }]) assert.throws(() => assertNativeProfiles(bad))
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  assert.match(source, /errorObservationScope:[^\n]*every refresh/)
})

function nativePsEncodingPrefixes() {
  const source = fs.readFileSync(new URL('../scripts/test-hermes-tauri-qualification.mjs', import.meta.url), 'utf8')
  return ['runtimeSnapshot', 'applicationPids'].map(name => {
    const start = source.indexOf(`  function ${name}() {`)
    assert.ok(start >= 0)
    const declaration = source.indexOf('const code = `', start)
    const end = source.indexOf('`\n    const r = spawnSync', declaration)
    assert.ok(declaration > start && end > declaration)
    const body = source.slice(declaration, end)
    const prefix = body.match(/\[Console\]::OutputEncoding=\[Text\.UTF8Encoding\]::new\(\$false\);?/g)?.[0] || ''
    return { name, prefix, body }
  })
}

test('native两个PS5 JSON观察helper都在CIM读取前固定Console UTF8', () => {
  for (const { name, prefix, body } of nativePsEncodingPrefixes()) assert.ok(prefix && body.indexOf(prefix) < body.indexOf('Get-CimInstance'), `${name}缺失Console UTF8，长cmdline弯引号会best-fit破坏JSON`)
})

test('PS5常量探针必须先确认进程成功和同源schema，启动超时不能冒充预期JSON错误', () => {
  const payload = 'x'.repeat(20500) + '中文“quoted”'
  const frame = { schemaVersion: 1, source: 'native-helper-encoding-fixture-v1', powershellMajor: 5, positiveCodePages: [65001, 65001], legacyCodePage: 437, helperModes: ['runtimeSnapshot', 'applicationPids'], payloadChars: payload.length }
  const wire = (header, value = payload) => ['{"commandLine":"中文"quoted""}', JSON.stringify({ commandLine: value }), JSON.stringify({ commandLine: value }), JSON.stringify(header)].join('\r\n') + '\r\n'
  const good = { status: 0, signal: null, stdout: wire(frame), stderr: '' }
  assert.equal(decodeNativeEncodingProbe(good).positive[0].commandLine, payload)
  for (const bad of [
    { ...good, status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } },
    { ...good, status: 1 }, { ...good, stdout: 'not-json' },
    ...[x => { x.source = 'other-fixture' }, x => { x.schemaVersion = 0 }, x => { x.positiveCodePages[0] = 437 }, x => { x.powershellMajor = 7 }, x => { x.helperModes.pop() }, x => { delete x.payloadChars }].map(mutate => { const x = structuredClone(frame); mutate(x); return { ...good, stdout: wire(x) } }),
    { ...good, stdout: wire(frame, null) },
  ]) assert.throws(() => decodeNativeEncodingProbe(bad), error => error.code === 'ERR_ASSERTION' && !(error instanceof SyntaxError))
})

function decodeNativeEncodingProbe(result) {
  assert.ok(result?.status === 0 && !result.signal && !result.error, `fixture PS5 process failed: status=${result?.status}; signal=${result?.signal}; code=${result?.error?.code || 'none'}`)
  const lines = String(result.stdout).replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
  assert.equal(lines.length, 4, 'fixture四帧不完整')
  const parse = value => { try { return JSON.parse(value) } catch { assert.fail('fixture envelope/UTF8 JSON无效，不能冒充预期legacy语法错误') } }
  const header = parse(lines[3])
  assert.equal(header.schemaVersion, 1); assert.equal(header.source, 'native-helper-encoding-fixture-v1'); assert.equal(header.powershellMajor, 5)
  assert.equal(header.legacyCodePage, 437); assert.deepEqual(header.positiveCodePages, [65001, 65001]); assert.deepEqual(header.helperModes, ['runtimeSnapshot', 'applicationPids'])
  assert.ok(Number.isInteger(header.payloadChars) && header.payloadChars > 20000)
  const positive = [parse(lines[1]), parse(lines[2])]
  for (const row of positive) { assert.deepEqual(Object.keys(row), ['commandLine']); assert.equal(typeof row.commandLine, 'string'); assert.equal(row.commandLine.length, header.payloadChars) }
  return { header, legacyJson: lines[0], positive }
}

test('PS5只读常量长JSON复现OEM best-fit quote并验证两个native前缀，不查询宿主CIM/任务', { skip: process.platform !== 'win32' }, () => {
  // 单个子进程、无cmdlet/autoload；仅已知不含ASCII引号/反斜线/换行的常量才手工拼JSON。
  // 真实CIM+ConvertTo-Json由独立process-observation覆盖；本fixture仍用15s，不修改任何产品预算。
  const token = '中文“quoted”-‘single’-', value = 'x'.repeat(20500) + token
  assert.doesNotMatch(value, /["\\\r\n]/)
  const data = Buffer.from(token).toString('base64'), modes = nativePsEncodingPrefixes()
  for (const { name, prefix } of modes) assert.ok(prefix, `${name}未提供实际UTF8前缀`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const code = `$ErrorActionPreference='Stop';$v=('x'*20500)+[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'));$j='{"commandLine":"'+$v+'"}';
[Console]::OutputEncoding=[Text.Encoding]::GetEncoding(437);$legacy=[Console]::OutputEncoding.CodePage;[Console]::WriteLine($j);
${modes[0].prefix};$cp1=[Console]::OutputEncoding.CodePage;[Console]::WriteLine($j);
${modes[1].prefix};$cp2=[Console]::OutputEncoding.CodePage;[Console]::WriteLine($j);
$h='{"schemaVersion":1,"source":"native-helper-encoding-fixture-v1","powershellMajor":'+$PSVersionTable.PSVersion.Major+',"legacyCodePage":'+$legacy+',"positiveCodePages":['+$cp1+','+$cp2+'],"helperModes":["runtimeSnapshot","applicationPids"],"payloadChars":'+$v.Length+'}';[Console]::WriteLine($h);`
  const encoded = Buffer.from(code, 'utf16le').toString('base64'), started = performance.now()
  assert.ok(encoded.length < 32767, 'fixture命令行必须短于Windows限制')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
  const elapsedMs = performance.now() - started
  const decoded = decodeNativeEncodingProbe(result)
  assert.throws(() => JSON.parse(decoded.legacyJson), SyntaxError, '实际CP437坏JSON必须仍被拒绝')
  for (const [i, { name }] of modes.entries()) assert.equal(decoded.positive[i].commandLine, value, `${name}长JSON Unicode未完整保留`)
  if (process.env.HERMES_NATIVE_ENCODING_TEST_EVIDENCE) {
    const directory = process.env.HERMES_NATIVE_ENCODING_TEST_EVIDENCE; fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'native-encoding-probe.ps1'), code)
    fs.writeFileSync(path.join(directory, 'native-encoding-probe.json'), JSON.stringify({ scope: 'local harmless PS5 fixture, not product runtime', header: decoded.header, spawnCalls: 1, timeoutMs: 15000, encodedChars: encoded.length, elapsedMs, status: result.status, signal: result.signal, errorCode: result.error?.code || null, environmentPolicy: 'parent-copy-without-PSModulePath', stdoutSha256: crypto.createHash('sha256').update(result.stdout).digest('hex'), positiveUnicodeRoundtrip: true, cp437SyntaxErrorConfirmed: true }, null, 2))
  }
})

test('native Provider只读metadata逐项404留证，不当聊天；unknown/坏JSON/错误chat认证仍红', async () => {
  const { createNativeProvider } = await load()
  assert.equal(typeof createNativeProvider, 'function')
  const report = { provider: [], metadata: [] }
  const server = await createNativeProvider({ report })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (route, body, key = 'qualification-native-no-secret') => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  try {
    const metadata = await request('/api/show', { name: 'native-one' })
    assert.equal(metadata.status, 404)
    assert.equal(report.provider.length, 0)
    assert.equal(report.metadata.length, 1)
    assert.ok(report.metadata[0].kind)
    assert.equal(report.metadata[0].provider, 'ollama')
    assert.equal(report.metadata[0].method, 'POST'); assert.equal(report.metadata[0].path, '/api/show'); assert.equal(report.metadata[0].status, 404)
    assert.ok(!report.providerError)
    for (const route of ['/api/tags', '/v1/models/native-one']) {
      assert.equal((await fetch(base + route)).status, 404)
      const record = report.metadata.at(-1)
      assert.equal(record.kind, 'metadata'); assert.equal(record.method, 'GET'); assert.equal(record.path, route); assert.equal(record.status, 404)
    }
    assert.equal(report.metadata.length, 3); assert.equal(report.provider.length, 0)
    const catalog = await fetch(base + '/v1/models')
    assert.equal(catalog.status, 200)
    assert.deepEqual((await catalog.json()).data.map(m => m.id), ['native-one', 'native-two'])
    assert.equal(report.metadata.at(-1).provider, 'openai-catalog'); assert.equal(report.metadata.at(-1).status, 200)
    assert.equal(report.metadata.length, 4); assert.equal(report.provider.length, 0)
    const nonce = 'native-acceptance-12345678-1234-1234-1234-123456789abc'
    const body = { model: 'native-one', messages: [{ role: 'user', content: nonce }], stream: false }
    const chat = await request('/v1/chat/completions', body)
    assert.equal(chat.status, 200)
    assert.equal((await chat.json()).choices[0].message.content, `原生完整回复：${nonce}；模型：native-one。`)
    assert.equal(report.provider.length, 1); assert.equal(report.provider[0].nonce, nonce); assert.equal(report.provider[0].authenticated, true)
    for (const [route, data, key] of [['/api/unknown', {}, undefined], ['/v1/models', {}, undefined], ['/api/show', '{bad', undefined], ['/api/show', { model: 'native-one' }, undefined], ['/api/show', { name: 'undeclared' }, undefined], ['/v1/chat/completions', body, 'wrong'], ['/v1/chat/completions', { ...body, messages: [] }, undefined]]) {
      delete report.providerError
      assert.equal((await request(route, data, key)).status, 500)
      assert.ok(report.providerError)
      assert.equal(report.metadata.length, 4, 'unknown或坏请求不得冒充metadata')
      assert.equal(report.provider.length, 1, '错误请求不得计入chat')
    }
    delete report.providerError
    const getWithBody = await new Promise((resolve, reject) => {
      const req = http.request(base + '/v1/models', { method: 'GET', headers: { 'content-length': '2' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject); req.end('{}')
    })
    assert.equal(getWithBody, 500); assert.ok(report.providerError); assert.equal(report.metadata.length, 4)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('兼容参数固定21.5与两个不同完整SHA，非seed模式仍保留完整安装资格', async () => {
  const { nativeArgs } = await load()
  assert.equal(nativeArgs(['--sha', appSha, '--seed-sha', seedSha, '--version', '0.21.5'])['--seed-sha'], seedSha)
  for (const args of [ ['--seed-sha', 'main'], ['--seed-sha', seedSha], ['--sha', appSha, '--seed-sha', appSha, '--version', '0.21.5'], ['--sha', appSha, '--seed-sha', seedSha, '--version', '0.22.2'] ]) assert.throws(() => nativeArgs(args))
})

test('兼容seed必须完整旧Web生命周期、同VM、精确HOME与旧source pin', async () => {
  const { assertNativeCompatibilitySeed } = await load()
  assert.equal(typeof assertNativeCompatibilitySeed, 'function')
  assert.doesNotThrow(() => assertNativeCompatibilitySeed(seedFixture()))
  for (const mutate of [ x => { delete x.seedSha }, x => { x.prior.candidateSha = appSha }, x => { x.prior.status = 'failed' }, x => { x.prior.stages.pop() }, x => { x.prior.environment.home += '-other' }, x => { x.home += '-other' }, x => { x.seedProof.runId = 'other' }, x => { x.seedProof.sid += '-other' }, x => { x.release.commit = newCommit }, x => { x.completion.version = '0.22.2' }, x => { x.prior.browser.pageErrors.push('bad') }, x => { x.prior.hostUnchanged = false } ]) { const x = seedFixture(); mutate(x); assert.throws(() => assertNativeCompatibilitySeed(x)) }
})

test('新app必须真实22.2双端pin，build应用与完整新源码绑定不接受旧seed清单', async () => {
  const { assertNativeCompatibilityPins, assertNativeCompatibilityBinding } = await load()
  assert.equal(typeof assertNativeCompatibilityPins, 'function'); assert.equal(typeof assertNativeCompatibilityBinding, 'function')
  const pins = { web: `const HERMES_STABLE_VERSION = '0.22.2'\nconst HERMES_STABLE_COMMIT = '${newCommit}'`, rust: `const HERMES_STABLE_VERSION: &str = "0.22.2";\nconst HERMES_STABLE_COMMIT: &str = "${newCommit}";` }
  assert.deepEqual(assertNativeCompatibilityPins(pins), { version: '0.22.2', commit: newCommit })
  for (const key of ['web', 'rust']) { assert.throws(() => assertNativeCompatibilityPins({ ...pins, [key]: pins[key].replace('0.22.2', '0.21.5') })); assert.throws(() => assertNativeCompatibilityPins({ ...pins, [key]: pins[key].replace(newCommit, oldCommit) })) }
  assert.doesNotThrow(() => assertNativeCompatibilityBinding(bindingFixture()))
  for (const mutate of [ x => { x.rootSha = seedSha }, x => { x.sourceHashes = {} }, x => { x.build.candidateSha = seedSha }, x => { x.build.application.sha256 = '2'.repeat(64) }, x => { x.build.application.path += '-other' }, x => { x.build.sourceManifestSha256 = '2'.repeat(64) }, x => { x.build.status = 'failed' } ]) { const x = bindingFixture(); mutate(x); assert.throws(() => assertNativeCompatibilityBinding(x)) }
})

test('兼容IPC在送出前拒绝所有installer，普通真实W3C IPC仍送出并留证', async () => {
  const { NativeWebDriver } = await load()
  const calls = []
  const server = http.createServer(async (req, res) => { let body = ''; for await (const b of req) body += b; calls.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: { ok: true, value: { installed: true } } })) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new NativeWebDriver(`http://127.0.0.1:${server.address().port}`, { compatibility: true }); client.session = 'actual-protocol-test'
    for (const cmd of ['install_hermes', 'update_hermes', 'uninstall_hermes']) await assert.rejects(client.ipc(cmd), /installer|安装/)
    assert.equal(calls.length, 0)
    assert.deepEqual(client.blockedInstallerCommands, ['install_hermes', 'update_hermes', 'uninstall_hermes'])
    assert.equal((await client.ipc('check_hermes')).installed, true); assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'check_hermes')
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('兼容独立门禁：缺seed/偷调installer/少UI/升级旧source均红，绝不补绿full', async () => {
  const { assertNativeCompatibilityComplete, assertNativeComplete, NATIVE_STEPS } = await load()
  assert.equal(typeof assertNativeCompatibilityComplete, 'function')
  const good = compatibilityFixture(NATIVE_STEPS)
  assert.doesNotThrow(() => assertNativeCompatibilityComplete(good)); assert.throws(() => assertNativeComplete(good))
  assert.throws(() => assertNativeCompatibilityComplete(completeFixture(NATIVE_STEPS)))
  for (const mutate of [ x => { delete x.seedSha }, x => { x.candidateSha = seedSha }, x => { x.expectedVersion = '0.22.2' }, x => { x.runtimeHome += '-other' }, x => { x.compatibility.appPin.commit = oldCommit }, x => { x.compatibility.binding.rootSha = seedSha }, x => { x.application.sha256 = '3'.repeat(64) }, x => { x.ipc.push({ cmd: 'install_hermes', ok: false }) }, x => { x.compatibility.blockedInstallerCommands.push('update_hermes') }, x => { x.nativeInstallerLifecycle = [] }, x => { x.rounds.pop() }, x => { x.rounds[0].steps.pop() }, x => { x.rounds[0].samples.pop() }, x => { x.rounds[0].elapsedSeconds = 209 }, x => { x.compatibility.runtimeChecks[2].commit = newCommit }, x => { x.compatibility.runtimeChecks[0].version = '0.22.2' }, x => { x.compatibility.runtimeChecks.pop() }, x => { x.compatibility.finalRuntimeHead = newCommit }, x => { x.compatibility.seedHistoryPreserved = false }, x => { x.compatibility.seedMemoryPreserved = false }, x => { x.hostUnchanged = false } ]) { const x = structuredClone(good); mutate(x); assert.throws(() => assertNativeCompatibilityComplete(x)) }
  const forged = structuredClone(good); forged.nativeInstallerLifecycle = completeFixture(NATIVE_STEPS).nativeInstallerLifecycle; assert.throws(() => assertNativeComplete(forged))
  for (const status of [undefined, 'failed', 'passed-native-tauri']) { const bad = structuredClone(good); bad.status = status; assert.throws(() => assertNativeCompatibilityComplete(bad)) }
})

test('兼容新source读取绑定实际Git blob与build manifest，篡改源码或EXE先红', async () => {
  const { readNativeCompatibilityBinding } = await load()
  assert.equal(typeof readNativeCompatibilityBinding, 'function')
  // macOS 的 /var 临时根本身是链接；fixture 先选物理根，不放松产品拒绝链接的门禁。
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-native-compat-source-'))
  try {
    const git = args => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'fixture'])
    const files = Object.keys(bindingFixture().sourceHashes)
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'fixture\n') }
    git(['add', '--', ...files]); git(['-c', 'core.autocrlf=false', 'commit', '-qm', 'fixture'])
    const sha = git(['rev-parse', 'HEAD']), app = path.join(dir, 'clawpanel.exe'), manifest = path.join(dir, 'source-sha256.json'), receipt = path.join(dir, 'build-receipt.json')
    fs.writeFileSync(app, 'fixture exe')
    const crypto = await import('node:crypto'), hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
    fs.writeFileSync(manifest, JSON.stringify({ sha, files: Object.fromEntries(files.map(f => [f, hash(path.join(dir, f))])) }))
    fs.writeFileSync(receipt, JSON.stringify({ status: 'passed', candidateSha: sha, hostUnchanged: true, sourceManifestSha256: hash(manifest), application: { path: app, sha256: hash(app) } }))
    assert.doesNotThrow(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt }))
    fs.appendFileSync(app, 'changed'); assert.throws(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt })); fs.writeFileSync(app, 'fixture exe')
    fs.appendFileSync(path.join(dir, files[0]), 'changed'); assert.throws(() => readNativeCompatibilityBinding({ root: dir, app, sha, buildReceipt: receipt }))
  } finally {
    const relative = path.relative(base, fs.realpathSync(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(dir).startsWith('hermes-native-compat-source-'), '只清理本测试独占临时目录')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
