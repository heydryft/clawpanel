// 清理只证明旧创建身份消失；原raw存活结果和真实CI首红不得覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const saved = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-cli-cleanup-ci1b6b061.json', import.meta.url), 'utf8'))
const load = () => import('../scripts/hermes-cli-owned-identity.mjs')
const B = 1792186730000, epoch = 116444736000000000n
const hex = ms => (epoch + BigInt(ms) * 10000n).toString(16).padStart(16, '0')
const copy = structuredClone
const native = (pid, birth = B + pid, at = B + 100) => ({ pid, status: 'running', creationTimeFileTimeHex: hex(birth), createdAtMs: birth, exitAtMs: 0, sampledAtMs: at, queryStartedAtMs: at, queryCompletedAtMs: at, belongsToFixture: true, nativeError: 0, imageQueryError: 0, waitResult: 258 })
const missing = pid => ({ pid, status: 'missing', sampledAtMs: B + 1000, queryStartedAtMs: B + 1000, queryCompletedAtMs: B + 1000, creationTimeFileTimeHex: null, createdAtMs: 0, exitAtMs: 0, nativeError: 87, imageQueryError: 0, waitResult: 4294967295 })
function material() {
  const events = [1, 2, 3].map(pid => ({ event: 'start', pid, name: 'burst-' + pid, at: B + 20, monotonicMs: 20, birthId: 'birth-' + pid }))
  return { events, historyNativeRows: events.map(s => native(s.pid)), cleanupNativeRows: events.map(s => native(s.pid, B + s.pid, B + 1000)),
    rawProbes: events.map((s, i) => ({ pid: s.pid, alive: true, errorCode: null, startedAtMs: B + 1100, completedAtMs: B + 1100, startedAtNs: String(1100000000 + i * 10000), completedAtNs: String(1100001000 + i * 10000) })),
    rawOrder: { kind: 'captured-after-final-native', nativeCompletedAtMs: B + 1001, startedAtMs: B + 1100, completedAtMs: B + 1101 }, observerErrors: [] }
}
async function gate(m, nativeIdentityAvailable = true) {
  const { qualifyFixtureCleanup } = await load()
  assert.equal(typeof qualifyFixtureCleanup, 'function')
  const r = qualifyFixtureCleanup(m, { nativeIdentityAvailable })
  assert.equal(r.allOldFixtureIdentitiesAbsent, true, JSON.stringify(r))
  return r
}
function actualMaterial() {
  return { events: saved.cleanup.map(r => r.receipt), historyNativeRows: saved.peak.proofs.filter(p => p.pid === 1856).map(p => ({ pid: p.pid, ...p.baseline })),
    cleanupNativeRows: copy(saved.cleanup), rawProbes: saved.cleanup.map(r => ({ pid: r.pid, alive: r.rawAlive })), observerErrors: [],
    // 不伪造UTC或ESRCH：冻结源码先await整个snapshot，再同步map kill0；仅此下界有证据。
    rawOrder: { kind: 'frozen-source-order-lower-bound', sourceSha: saved.provenance.sourceSha, sourceTestSha256: saved.provenance.boundsTestSha256,
      notBeforeMs: Math.max(...saved.cleanup.map(r => r.queryCompletedAtMs)) - 1, awaitFinalNativeBeforeRaw: true } }
}

test('真实1b6原样清理收据：原all raw inactive断言必红，PID1856替代身份原样保留', () => {
  assert.equal(saved.provenance.runId, 38970520687)
  assert.equal(saved.cleanup.length, 8)
  assert.throws(() => assert.ok(saved.cleanup.every(p => !p.alive)), { code: 'ERR_ASSERTION' })
  assert.equal(saved.cleanup[0].rawAlive, true)
  assert.equal(saved.cleanup[0].nativeOwnedActive, false)
  assert.equal(saved.cleanup[0].creationTimeFileTimeHex, '01dd5db6c5eb6d05')
})

test('HTTP finally接线：保留原raw采集和独立peak门禁，只按清理旧创建身份判定', () => {
  const source = fs.readFileSync(new URL('./hermes-cli-bounds.test.js', import.meta.url), 'utf8')
  assert.match(source, /report\.cleanupGate = qualifyFixtureCleanup\(/)
  assert.match(source, /assert\.ok\(report\.cleanupGate\.allOldFixtureIdentitiesAbsent/)
  assert.match(source, /rawAlive, alive: rawAlive, nativeOwnedActive: row\.active/)
  assert.match(source, /assert\.ok\(peak <= 2,/)
  assert.match(source, /assert\.ok\(report\.nativePeak <= 2,/)
  assert.match(source, /const sink = \{ count: 0, probes: \[\] \}/)
  assert.doesNotMatch(source, /taskkill|process\.kill\([^,]+,\s*['"]SIG/)
})

test('真实1b6完整回放：只有旧fixture已消失，raw1856仍活跃；短任务missing87不补造baseline/ESRCH', async () => {
  const m = actualMaterial(), before = copy(m), r = await gate(m)
  assert.deepEqual(m, before)
  assert.equal(r.rawAliveCount, 1)
  assert.equal(r.rows[0].proof.kind, 'replacement-born-before-raw')
  assert.equal(r.rows[0].rawAlive, true)
  assert.equal(r.rows[0].oldFixtureIdentityAbsent, true)
  assert.equal(r.rawTiming, 'source-order-lower-bound-not-captured-raw-time')
  assert.ok(r.rows.slice(1).every(p => p.proof.kind === 'explicit-native-missing-before-raw'))
  assert.equal(m.rawProbes[6].errorCode, undefined)
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-real-ci-replay.json'), JSON.stringify({ provenance: saved.provenance, result: r }, null, 2))
})

test('清理反例：三个当前创建身份活跃，即使nativeOwnedActive全false也仍红', async () => {
  const m = material(); m.cleanupNativeRows.forEach(r => { r.nativeOwnedActive = false; r.active = false })
  await assert.rejects(gate(m), { code: 'ERR_ASSERTION' })
})

for (const [label, mutate] of [
  ['缺旧baseline', m => { m.historyNativeRows = [] }],
  ['只有foreign镜像而无替代出生', m => { m.cleanupNativeRows.forEach(r => { r.belongsToFixture = false; r.nativeOwnedActive = false }) }],
  ['替代出生晚于raw', m => { m.cleanupNativeRows[0] = { ...native(1, B + 1101, B + 1200), belongsToFixture: false } }],
  ['替代出生正好raw下界', m => { m.cleanupNativeRows[0] = { ...native(1, B + 1100, B + 1100), belongsToFixture: false }; m.rawOrder.nativeCompletedAtMs = B + 1100 }],
  ['未知状态', m => { m.cleanupNativeRows[0].status = 'unknown' }],
  ['原生AccessDenied', m => { m.cleanupNativeRows[0] = { ...missing(1), status: 'error', nativeError: 5 } }],
  ['raw错误不是ESRCH', m => { Object.assign(m.rawProbes[0], { alive: false, errorCode: 'EPERM' }) }],
  ['raw缺错误记录', m => { m.rawProbes[0].alive = false; delete m.rawProbes[0].errorCode }],
  ['缺前置出生字段', m => { delete m.historyNativeRows[0].creationTimeFileTimeHex }],
  ['缺raw完整材料', m => { m.rawProbes.pop() }],
  ['空清单不作vacuous通过', m => { m.events = []; m.rawProbes = []; m.cleanupNativeRows = []; m.historyNativeRows = [] }],
  ['跨同PID新start', m => { m.events.push({ ...m.events[0], birthId: 'another-birth', at: B + 900 }) }],
  ['query区间缺失', m => { delete m.cleanupNativeRows[0].queryStartedAtMs }],
  ['缺最终native收据', m => { m.cleanupNativeRows.pop() }],
  ['观察失败', m => { m.observerErrors.push('SECRET-ERROR-CANARY') }],
  ['raw单调时间反向', m => { m.rawProbes[0].completedAtNs = '0' }],
  ['原生先前缺失后又同身份running', m => { m.historyNativeRows.push({ ...missing(1), sampledAtMs: B + 900, queryStartedAtMs: B + 900, queryCompletedAtMs: B + 900 }) }],
  ['材料超预算', m => { m.materialOverflow = true }],
]) test('清理缺证据必须红：' + label, async () => { const m = material(); mutate(m); await assert.rejects(gate(m)) })

test('严格替代出生可证旧身份消失，但不依赖foreign镜像；全部raw仍true', async () => {
  const m = material(); m.cleanupNativeRows = m.events.map(s => native(s.pid, B + 800, B + 1000))
  const r = await gate(m); assert.equal(r.rawAliveCount, 3)
  assert.ok(r.rows.every(p => p.proof.kind === 'replacement-born-before-raw'))
})

test('短fail/recovery没有baseline：实际ESRCH与明确前置missing分别可证消失', async () => {
  const m = material(); m.events = m.events.slice(0, 2).map((s, i) => ({ ...s, name: i ? 'recovery' : 'fail' })); m.historyNativeRows = []
  m.rawProbes = m.rawProbes.slice(0, 2).map(p => ({ ...p, alive: false, errorCode: 'ESRCH' })); m.cleanupNativeRows = m.events.map(s => missing(s.pid))
  const r = await gate(m); assert.ok(r.rows.every(p => p.proof.kind === 'raw-esrch'))
  const legacy = actualMaterial(); legacy.historyNativeRows = []; legacy.events = legacy.events.slice(-2); legacy.rawProbes = legacy.rawProbes.slice(-2); legacy.cleanupNativeRows = legacy.cleanupNativeRows.slice(-2)
  await gate(legacy)
  legacy.cleanupNativeRows[0].nativeError = 5; await assert.rejects(gate(legacy))
})

test('source顺序下界不是任意时间补造：缺来源/顺序、rawtrue缺baseline、unknown误写false均红', async () => {
  for (const mutate of [m => { delete m.rawOrder.sourceSha }, m => { m.rawOrder.awaitFinalNativeBeforeRaw = false }, m => { m.historyNativeRows = [] }, m => { m.rawProbes[0].observationFailed = true }, m => { m.rawOrder.notBeforeMs = B }, m => { m.rawOrder.notBeforeMs += 100 }]) {
    const m = actualMaterial(); mutate(m); await assert.rejects(gate(m))
  }
})

test('捕获raw=true必须有原成功错误码null；不得把未记录的错误默认为成功', async () => {
  const m = material(); m.cleanupNativeRows = m.events.map(s => native(s.pid, B + 800, B + 1000))
  delete m.rawProbes[0].errorCode
  await assert.rejects(gate(m), /CLEANUP_RAW_ERROR_OR_TIME/)
})

test('清理独立JSON行超过24KiB拒绝而非截断；白名单不带env/原生路径', async () => {
  const { qualifyFixtureCleanup, encodeFixtureIdentityEvidence, FIXTURE_IDENTITY_LIMITS } = await load()
  const m = actualMaterial(); m.env = { SECRET_CANARY: 'NEVER-PUBLISH' }
  const r = qualifyFixtureCleanup(m), line = encodeFixtureIdentityEvidence(r)
  assert.ok(Buffer.byteLength(line) <= FIXTURE_IDENTITY_LIMITS.outputBytes)
  assert.doesNotMatch(line, /NEVER-PUBLISH|TiWorker|WinSxS|executablePath/)
  r.rows = Array.from({ length: 128 }, () => copy(r.rows[0]))
  assert.throws(() => encodeFixtureIdentityEvidence(r), /OUTPUT_BUDGET/)
})

test('非Windows清理仍保守：真实ESRCH才绿；rawtrue或未知失败保持红', async () => {
  const m = material(); m.cleanupNativeRows = []; m.historyNativeRows = []; m.rawOrder.kind = 'captured-raw-only'
  m.rawProbes.forEach(p => { p.alive = false; p.errorCode = 'ESRCH' }); await gate(m, false)
  Object.assign(m.rawProbes[0], { alive: true, errorCode: null }); await assert.rejects(gate(m, false))
})

test('原生UTC四舍五入而JS向下取整：保留先await顺序与1ms包络，不用它排除临界出生', async () => {
  const m = material(); m.historyNativeRows = []; m.cleanupNativeRows = m.events.map(s => ({ ...missing(s.pid), sampledAtMs: B + 1101, queryStartedAtMs: B + 1101, queryCompletedAtMs: B + 1101 }))
  m.rawOrder.nativeCompletedAtMs = B + 1100
  m.rawProbes.forEach(p => { p.alive = false; p.errorCode = 'ESRCH' })
  await gate(m)
  m.cleanupNativeRows[0].queryCompletedAtMs++; m.cleanupNativeRows[0].sampledAtMs++
  await assert.rejects(gate(m), /CLEANUP_NATIVE_AFTER_RAW_BOUND/)
})

test('真实自有Node清理：只按原ChildProcess句柄退出，原一次kill0/原生观察回读保留', { timeout: 12000 }, async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bounds-cleanup-identity-'))
  let child, observer
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise(r => child.once('close', r)); child.kill(); await closed }
    await observer?.close()
    const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  const executable = path.join(dir, process.platform === 'win32' ? 'cleanup-node.exe' : 'cleanup-node')
  fs.copyFileSync(process.execPath, executable); if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  child = spawn(executable, ['--eval', 'process.stdin.resume();process.stdin.once("data",()=>process.exit(0));console.log("READY")'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir } })
  const closed = new Promise(r => child.once('close', r))
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
  const start = { event: 'start', pid: child.pid, name: 'recovery', birthId: 'own-real-child', at: Date.now(), monotonicMs: Number(process.hrtime.bigint() / 1000000n) }
  let historyNativeRows = [], cleanupNativeRows = [], nativeCompletedAtMs
  if (process.platform === 'win32') {
    const { startWindowsFixtureProcessObserver, classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
    observer = await startWindowsFixtureProcessObserver()
    historyNativeRows = classifyFixtureIdentitySample({ starts: [start], processes: (await observer.snapshot([child.pid])).processes, expectedExecutable: executable }).processes
  }
  child.stdin.end('exit'); await closed
  if (observer) {
    const n = await observer.snapshot([child.pid]); nativeCompletedAtMs = n.completedAtMs
    const { classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
    cleanupNativeRows = classifyFixtureIdentitySample({ starts: [start], processes: n.processes, expectedExecutable: executable }).processes
  }
  const startedAtMs = Date.now(), startedAtNs = process.hrtime.bigint().toString(); let alive = false, errorCode = null
  try { process.kill(child.pid, 0); alive = true } catch (error) { errorCode = error.code }
  const completedAtMs = Date.now(), completedAtNs = process.hrtime.bigint().toString()
  const m = { events: [start], historyNativeRows, cleanupNativeRows, rawProbes: [{ pid: child.pid, alive, errorCode, startedAtMs, completedAtMs, startedAtNs, completedAtNs }],
    rawOrder: { kind: observer ? 'captured-after-final-native' : 'captured-raw-only', nativeCompletedAtMs, startedAtMs, completedAtMs }, observerErrors: [] }
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-own-node-before-gate.json'), JSON.stringify(m, null, 2))
  const result = await gate(m, !!observer)
  if (process.env.HERMES_BOUNDS_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_BOUNDS_TEST_EVIDENCE, 'cleanup-own-node-e2e.json'), JSON.stringify({ environment: { node: process.version, platform: process.platform }, material: m, result, noForeignKill: true }, null, 2))
})
