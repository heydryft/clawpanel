// 原生产 middleware、私有 HOME、真实子进程；不代表实际 Hermes 内核资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(process.env.HERMES_ASYNC_TEST_ROOT || fileURLToPath(new URL('..', import.meta.url)))
const evidence = process.env.HERMES_BOUNDS_TEST_EVIDENCE
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('PID 身份观察：复用、退出、未知和真实三活跃不得被裸PID或逻辑完成事件混淆', async () => {
  const { classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  const executable = 'C:\\fixture\\hermes.exe'
  const starts = [1, 2, 3].map(pid => ({ event: 'start', pid, name: 'burst-' + pid, birthId: 'birth-' + pid, at: 1000 }))
  const running = pid => ({ pid, status: 'running', executablePath: executable, creationTimeFileTimeHex: 'time-' + pid, createdAtMs: 900, sampledAtMs: 1100 })
  assert.equal(classifyFixtureIdentitySample({ starts, processes: starts.map(s => running(s.pid)), expectedExecutable: executable }).activeCount, 3, '真实三活跃必须继续为3，不能靠write/JS exit事件滤掉')
  const foreign = { ...running(3), executablePath: 'C:\\other-worker\\node.exe', creationTimeFileTimeHex: 'reused-time', createdAtMs: 1050 }
  const reused = classifyFixtureIdentitySample({ starts, processes: [running(1), running(2), foreign], expectedExecutable: executable })
  assert.equal(reused.activeCount, 2)
  assert.equal(reused.processes.find(p => p.pid === 3).belongsToFixture, false)
  assert.equal(reused.processes.find(p => p.pid === 3).newerThanRecordedStart, true)
  const exited = classifyFixtureIdentitySample({ starts, processes: [running(1), running(2), { ...running(3), status: 'exited', exitAtMs: 1090 }], expectedExecutable: executable })
  assert.equal(exited.activeCount, 2, 'native已signaled不能因kill0仍true计活')
  const goneImage = { ...running(3), status: 'exited', executablePath: null, waitResult: 0, exitAtMs: 1090, imageQueryError: 31 }
  assert.equal(classifyFixtureIdentitySample({ starts, processes: [running(1), running(2), goneImage], expectedExecutable: executable }).activeCount, 2, '退出对象可已丢失镜像：必须有原生signaled和退出时间，不把ERROR_GEN_FAILURE直接等同退出')
  assert.throws(() => classifyFixtureIdentitySample({ starts, processes: [running(1), running(2), { ...goneImage, waitResult: 258 }], expectedExecutable: executable }), /identity.*unavailable/i)
  assert.throws(() => classifyFixtureIdentitySample({ starts, processes: [running(1), running(2), { pid: 3, status: 'error', nativeError: 5 }], expectedExecutable: executable }), /identity.*unavailable/i)
  assert.throws(() => classifyFixtureIdentitySample({ starts, processes: [running(1), running(2)], expectedExecutable: executable }), /identity.*missing/i)
  const logicalDone = starts.concat({ event: 'write', pid: 3, birthId: 'birth-3', at: 1095 })
  assert.equal(classifyFixtureIdentitySample({ starts: logicalDone.filter(e => e.event === 'start'), processes: starts.map(s => running(s.pid)), expectedExecutable: executable }).activeCount, 3, '逻辑write不是OS进程退出')
})

test('PID 身份观察：Windows自有真实Node孩子的创建身份和退出状态可重复回读', { timeout: 12000 }, async t => {
  const { startWindowsFixtureProcessObserver } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  if (process.platform !== 'win32') {
    await assert.rejects(startWindowsFixtureProcessObserver(), /Windows/)
    return
  }
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'bounds-native-identity-'))
  const executable = path.join(dir, 'fixture-node.exe')
  fs.copyFileSync(process.execPath, executable)
  let observer, child
  const controls = []
  const report = { scope: 'native identity of one owned fixture Node child, no Hermes installation', executable, samples: [] }
  t.after(async () => {
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed }
    await Promise.all(controls.map(({ process: control, closed }) => { if (control.exitCode === null) control.kill(); return closed }))
    await observer?.close()
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'observer-realchild-report.json'), JSON.stringify(report, null, 2)) }
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  observer = await startWindowsFixtureProcessObserver()
  child = spawn(executable, ['--eval', 'setTimeout(()=>process.exit(0),700)'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir } })
  const closed = new Promise(resolve => child.once('close', resolve))
  const first = await observer.snapshot([child.pid]); report.samples.push(first)
  assert.equal(first.processes[0].status, 'running')
  assert.match(first.processes[0].creationTimeFileTimeHex, /^[0-9a-f]{16}$/i)
  assert.equal(path.win32.normalize(first.processes[0].executablePath).toLowerCase(), path.win32.normalize(executable).toLowerCase())
  const second = await observer.snapshot([child.pid]); report.samples.push(second)
  assert.equal(second.processes[0].creationTimeFileTimeHex, first.processes[0].creationTimeFileTimeHex)
  await closed
  const after = await observer.snapshot([child.pid]); report.samples.push(after)
  assert.ok(after.processes[0].status === 'missing' || after.processes[0].status === 'exited' || after.processes[0].creationTimeFileTimeHex !== first.processes[0].creationTimeFileTimeHex)
  // 真实三活跃负控：观察器必须看到3，不能把物理过载“修正”为2。
  for (let i = 0; i < 4; i++) {
    const control = spawn(i === 3 ? process.execPath : executable, ['--eval', 'setTimeout(()=>process.exit(0),700)'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '', HOME: dir, USERPROFILE: dir } })
    controls.push({ process: control, closed: new Promise(resolve => control.once('close', resolve)), receipt: { event: 'start', pid: control.pid, at: Date.now(), name: 'native-control-' + i } })
  }
  const controlSample = await observer.snapshot(controls.map(row => row.process.pid)); report.samples.push(controlSample)
  const { classifyFixtureIdentitySample } = await import('../scripts/hermes-cli-bounds-observation.mjs')
  assert.equal(classifyFixtureIdentitySample({ starts: controls.map(row => row.receipt), processes: controlSample.processes, expectedExecutable: executable }).activeCount, 3)
  assert.equal(classifyFixtureIdentitySample({ starts: [controls[0].receipt, controls[1].receipt, controls[3].receipt], processes: controlSample.processes, expectedExecutable: executable }).activeCount, 2, '真实异镜像Node进程不计为CLI，即使裸PID存活')
  report.nativeThreeActiveControl = { expected: 3, actual: 3 }
  report.nativeForeignImageControl = { expected: 2, actual: 2 }
})

test('真实 HTTP 过载：CLI最多2执行/8排队、排队计入15秒、不重放写命令，health独立响应且失败后释放', { timeout: 35000 }, async t => {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-cli-bounds-'))
  const home = path.join(dir, 'h'), bin = path.join(home, '.hermes/bin'), log = path.join(dir, 'cli.jsonl')
  const readEvents = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
  let child, gateway, sampler, nativeSampler, observer, sampleInFlight, pressureChild, pressureTask, stopPressure = false, peak = 0
  const report = { scope: 'production middleware / isolated CLI concurrency and real HTTP', root, requests: [], health: [], peak: 0, legacyPeak: 0, nativePeak: 0, observations: [], observerErrors: [], pressure: [], environment: { platform: process.platform, node: process.version, executable: process.execPath }, pressureEnabled: process.env.HERMES_BOUNDS_OBSERVATION_PRESSURE === '1' }
  const expectedExecutable = path.join(bin, 'hermes.exe')
  const sample = async () => {
    const starts = readEvents().filter(e => e.event === 'start'), pids = [...new Set(starts.map(e => e.pid))]
    const rawAtMs = Date.now(), raw = pids.map(pid => ({ pid, alive: alive(pid) }))
    if (!observer) return
    const native = await observer.snapshot(pids)
    const observation = { rawAtMs, raw, starts, ...native }; report.observations.push(observation)
    const classified = (await import('../scripts/hermes-cli-bounds-observation.mjs')).classifyFixtureIdentitySample({ starts, processes: native.processes, expectedExecutable })
    report.nativePeak = Math.max(report.nativePeak, classified.activeCount)
    Object.assign(observation, classified)
  }
  t.after(async () => {
    clearInterval(sampler)
    clearInterval(nativeSampler)
    await sampleInFlight
    stopPressure = true
    if (pressureChild && pressureChild.exitCode === null) pressureChild.kill()
    await pressureTask
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed }
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    report.events = readEvents(); report.peak = peak
    const pids = [...new Set(report.events.map(e => e.pid))]
    if (observer) {
      try {
        const native = await observer.snapshot(pids)
        const classified = (await import('../scripts/hermes-cli-bounds-observation.mjs')).classifyFixtureIdentitySample({ starts: report.events.filter(e => e.event === 'start'), processes: native.processes, expectedExecutable })
        report.cleanup = classified.processes.map(row => { const rawAlive = alive(row.pid); return { ...row, rawAlive, alive: rawAlive, nativeOwnedActive: row.active } })
      } catch (error) { report.observerErrors.push(String(error)); report.cleanup = pids.map(pid => ({ pid, alive: true, observationFailed: true })) }
      await observer.close()
    } else report.cleanup = pids.map(pid => ({ pid, alive: alive(pid) }))
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'bounds-http-report.json'), JSON.stringify(report, null, 2)) }
    assert.deepEqual(report.observerErrors, [], '身份观察失败必须显式红灯')
    assert.ok(report.cleanup.every(p => !p.alive), JSON.stringify(report.cleanup))
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true }); fs.mkdirSync(bin, { recursive: true })
  const preload = path.join(dir, 'cli-preload.mjs')
  fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';const copied=/^hermes(?:\\.exe)?$/i.test(path.basename(process.execPath));if(copied||process.argv[1]?.endsWith('/hermes')){const birthId=randomUUID(),args=process.argv.slice(copied?1:2).map((v,i)=>copied&&i===0?path.basename(v):v),name=args.at(-1);const record=event=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,name,pid:process.pid,birthId,at:Date.now(),monotonicMs:Number(process.hrtime.bigint()/1000000n)})+String.fromCharCode(10));record('start');process.on('exit',()=>record('exit'));await new Promise(r=>setTimeout(r,name.startsWith('burst-')?6200:30));if(name==='fail'){record('failure');console.error('fixture exit failure');process.exit(7)}record('write');console.log('ok');process.exit(0)}`)
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(bin, 'hermes.exe'))
  else { const cli = path.join(bin, 'hermes'); fs.writeFileSync(cli, '#!' + process.execPath + '\n' + fs.readFileSync(preload, 'utf8')); fs.chmodSync(cli, 0o755) }
  const healthPayload = { status: 'ok', nonce: 'bounded-cli-real-upstream' }
  gateway = http.createServer((_q, r) => { report.health.push({ at: Date.now() }); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(healthPayload)) })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  fs.writeFileSync(path.join(home, '.openclaw/clawpanel.json'), JSON.stringify({ ignoreRisk: true, engineMode: 'hermes', enabledEngines: ['hermes'], hermes: { gatewayUrl: `http://127.0.0.1:${gateway.address().port}` } }))
  const server = path.join(dir, 'server.mjs')
  fs.writeFileSync(server, `import http from 'node:http';import {_initApi,_apiMiddleware} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/dev-api.js')).href)};_initApi();http.createServer((q,r)=>{Promise.resolve(_apiMiddleware(q,r,()=>{r.statusCode=404;r.end()})).catch(e=>{r.statusCode=500;r.end(JSON.stringify({error:String(e)}))})}).listen(0,'127.0.0.1',function(){console.log('READY '+this.address().port)})`)
  child = spawn(process.execPath, [server], { env: { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'), OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'), NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, PATH: bin + path.delimiter + process.env.PATH }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error('HTTP startup timeout')), 10000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(Error('server exited ' + code + ': ' + out)) }); child.stdout.on('data', b => { out += b; const m = out.match(/READY (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } }); child.stderr.on('data', b => { out += b }) })
  const api = async (cmd, args = {}) => { const at = performance.now(), r = await fetch(`http://127.0.0.1:${port}/__api/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(22000) }); return { status: r.status, value: await r.json(), ms: performance.now() - at } }
  if (process.platform === 'win32') {
    observer = await (await import('../scripts/hermes-cli-bounds-observation.mjs')).startWindowsFixtureProcessObserver()
    report.observerPid = observer.pid
  }
  // 保留原25ms裸PID门禁；不被原生侧车的异步busy/采样速度合并或跳过。
  sampler = setInterval(() => { const pids = [...new Set(readEvents().filter(e => e.event === 'start').map(e => e.pid))]; peak = Math.max(peak, pids.filter(alive).length); report.legacyPeak = peak }, 25)
  // 原生侧车独立采样；逐PID并非atomic snapshot，不能替代原门禁。
  if (observer) nativeSampler = setInterval(() => {
    if (sampleInFlight) return
    sampleInFlight = sample().catch(error => { report.observerErrors.push(String(error)) }).finally(() => { sampleInFlight = null })
  }, 25)
  if (report.pressureEnabled) {
    // 单孩子、最多64次/17秒；只通过本次 ChildProcess 句柄停止，不碰历史 PID 或其他 worker。
    pressureTask = (async () => {
      const until = performance.now() + 17000
      for (let i = 0; i < 64 && !stopPressure && performance.now() < until; i++) {
        pressureChild = spawn(process.execPath, ['--eval', 'setTimeout(()=>process.exit(0),75)'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '', HOME: home, USERPROFILE: home } })
        const item = { index: i, pid: pressureChild.pid, startedAtMs: Date.now(), executable: process.execPath }; report.pressure.push(item)
        await new Promise((resolve, reject) => { pressureChild.once('error', reject); pressureChild.once('close', (code, signal) => { item.closedAtMs = Date.now(); item.code = code; item.signal = signal; resolve() }) })
        pressureChild = null
        await delay(120)
      }
    })()
  }
  const started = performance.now(), startedMonotonicMs = Number(process.hrtime.bigint()/1000000n), pending = Array.from({ length: 12 }, (_, i) => api('hermes_profile_use', { name: `burst-${i}` }).then(result => { const item = { name: `burst-${i}`, ...result }; report.requests.push(item); return item }))
  await delay(350)
  const health = await api('hermes_health_check'); report.fastHealth = health
  const results = await Promise.all(pending); report.wallMs = performance.now() - started
  await sampleInFlight
  assert.deepEqual(report.observerErrors, [], '身份观察失败必须显式红灯')
  // 先保存完整红灯事实，再断言；不让第一个并发失败掩盖其他观测。
  report.events = readEvents(); report.peak = peak
  assert.equal(health.status, 200, JSON.stringify(health)); assert.deepEqual(health.value, healthPayload); assert.ok(health.ms < 2000, 'CLI过载期间真实health: ' + JSON.stringify(health))
  assert.ok(peak <= 2, `实际子进程峰值 ${peak}，不应无界启动`)
  assert.ok(report.nativePeak <= 2, `另时刻逐PID原生观察峰值 ${report.nativePeak}；仅附加门禁，不替代原kill0门禁`)
  const busy = results.filter(r => r.status === 500 && /queue.*full/i.test(r.value.error))
  assert.equal(busy.length, 2, JSON.stringify(results)); assert.ok(busy.every(r => r.ms < 2000), '队满立即失败')
  assert.ok(report.wallMs >= 14500 && report.wallMs < 17500, '排队不能额外获得15秒执行预算')
  assert.ok(results.some(r => /deadline/i.test(r.value?.error || '')), '队列过期必须明确报错')
  const starts = readEvents().filter(e => e.event === 'start')
  assert.ok(starts.length <= 6 && starts.length >= 4, JSON.stringify(starts))
  assert.equal(new Set(starts.map(e => e.name)).size, starts.length, '写命令不重放')
  assert.ok(starts.every(e => e.monotonicMs - startedMonotonicMs < 15000), 'deadline后不启动过期写命令')
  const failed = await api('hermes_profile_use', { name: 'fail' }); report.failed = failed
  assert.equal(failed.status, 500); assert.match(failed.value.error, /fixture exit failure/)
  const recovery = await api('hermes_profile_use', { name: 'recovery' }); report.recovery = recovery
  assert.equal(recovery.status, 200); assert.equal(recovery.value, 'ok'); assert.ok(recovery.ms < 2000)
  await delay(100)
  const finalEvents = readEvents(), writes = finalEvents.filter(e => e.event === 'write')
  assert.equal(finalEvents.filter(e => e.event === 'start' && e.name === 'recovery').length, 1)
  assert.deepEqual(writes.filter(e => e.name.startsWith('burst-')).map(e => e.name).sort(), results.filter(r => r.status === 200).map(r => r.name).sort())
})
