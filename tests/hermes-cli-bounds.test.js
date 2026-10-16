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

test('真实 HTTP 过载：CLI最多2执行/8排队、排队计入15秒、不重放写命令，health独立响应且失败后释放', { timeout: 35000 }, async t => {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-cli-bounds-'))
  const home = path.join(dir, 'h'), bin = path.join(home, '.hermes/bin'), log = path.join(dir, 'cli.jsonl')
  const readEvents = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : []
  let child, gateway, sampler, peak = 0
  const report = { scope: 'production middleware / isolated CLI concurrency and real HTTP', root, requests: [], health: [], peak: 0 }
  t.after(async () => {
    clearInterval(sampler)
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed }
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    report.events = readEvents(); report.peak = peak
    const pids = [...new Set(report.events.map(e => e.pid))]
    report.cleanup = pids.map(pid => ({ pid, alive: alive(pid) }))
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'bounds-http-report.json'), JSON.stringify(report, null, 2)) }
    assert.ok(report.cleanup.every(p => !p.alive), JSON.stringify(report.cleanup))
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true }); fs.mkdirSync(bin, { recursive: true })
  const preload = path.join(dir, 'cli-preload.mjs')
  fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';const copied=/^hermes(?:\\.exe)?$/i.test(path.basename(process.execPath));if(copied||process.argv[1]?.endsWith('/hermes')){const args=process.argv.slice(copied?1:2).map((v,i)=>copied&&i===0?path.basename(v):v),name=args.at(-1);const record=event=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event,name,pid:process.pid,at:Date.now(),monotonicMs:Number(process.hrtime.bigint()/1000000n)})+String.fromCharCode(10));record('start');await new Promise(r=>setTimeout(r,name.startsWith('burst-')?6200:30));if(name==='fail'){record('failure');console.error('fixture exit failure');process.exit(7)}record('write');console.log('ok');process.exit(0)}`)
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
  sampler = setInterval(() => { const pids = [...new Set(readEvents().filter(e => e.event === 'start').map(e => e.pid))]; peak = Math.max(peak, pids.filter(alive).length) }, 25)
  const started = performance.now(), startedMonotonicMs = Number(process.hrtime.bigint()/1000000n), pending = Array.from({ length: 12 }, (_, i) => api('hermes_profile_use', { name: `burst-${i}` }).then(result => { const item = { name: `burst-${i}`, ...result }; report.requests.push(item); return item }))
  await delay(350)
  const health = await api('hermes_health_check'); report.fastHealth = health
  const results = await Promise.all(pending); report.wallMs = performance.now() - started
  // 先保存完整红灯事实，再断言；不让第一个并发失败掩盖其他观测。
  report.events = readEvents(); report.peak = peak
  assert.equal(health.status, 200); assert.deepEqual(health.value, healthPayload); assert.ok(health.ms < 2000)
  assert.ok(peak <= 2, `实际子进程峰值 ${peak}，不应无界启动`)
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
