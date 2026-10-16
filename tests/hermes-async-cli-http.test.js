// 原始 HTTP middleware + 慢受管 CLI 黑盒；fixture health 不是实际 Hermes 资格。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = path.resolve(process.env.HERMES_ASYNC_TEST_ROOT || new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const evidence = process.env.HERMES_ASYNC_TEST_EVIDENCE

test('非交互 CLI 的 stdin 保持原 EOF，不等待输入耗尽15秒预算', { timeout: 20000 }, async () => {
  const source = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8'), body = source.match(/async function runHermesSilent\(program, args\) \{[^]*?\n\}/)?.[0]
  assert.ok(body)
  const scheduler = source.match(/const HERMES_CLI_CONCURRENCY = 2[^]*?(?=async function runHermesSilent)/)?.[0] || ''
  const run = new Function('execFile', 'buildHermesRuntimeEnv', `${scheduler}\n${body};return runHermesSilent`)(execFile, () => process.env), started = Date.now()
  const result = await run(process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF 完整🦀'))"])
  assert.equal(result.ok, true, result.stderr); assert.equal(result.stdout, 'EOF 完整🦀'); assert.ok(Date.now() - started < 2000)
})

test('准备运行环境也扣原 deadline，已耗尽时不再启动子进程', async () => {
  const source = fs.readFileSync(path.join(root, 'scripts/dev-api.js'), 'utf8')
  const body = source.match(/const HERMES_CLI_CONCURRENCY = 2[^]*?async function runHermesSilent\(program, args\) \{[^]*?\n\}/)?.[0]
  assert.ok(body)
  let now = 0, launched = 0
  const run = new Function('execFile', 'buildHermesRuntimeEnv', 'performance', `${body};return runHermesSilent`)(
    (_program, _args, _options, callback) => { launched++; callback(new Error('unexpected launch'), '', ''); return {} },
    () => { now = 16000; return {} }, { now: () => now })
  const result = await run(process.execPath, ['--version'])
  assert.equal(launched, 0, '环境准备耗尽预算后不应执行')
  assert.equal(result.ok, false); assert.match(result.stderr, /deadline/)
})

test('真实并发 HTTP：慢 profiles/sessions 不阻塞独立快速 health，不串行、不重放；慢上游仍按5秒失败', { timeout: 45000 }, async t => {
  const base = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-async-http-')), home = path.join(dir, 'h'), cliLog = path.join(dir, 'cli.jsonl')
  let child, gateway, serverBase, healthDelay = 100, sawHealth
  const observations = [], payload = { status: 'ok', platform: 'hermes-agent', version: 'fixture-only', nonce: 'real-upstream-not-synthetic-panel' }
  t.after(async () => {
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed }
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'http-report.json'), JSON.stringify({ scope: 'production middleware / isolated CLI and upstream HTTP', root, observations, cli: fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [] }, null, 2)) }
    const rel = path.relative(base, fs.realpathSync(dir)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true }); const bin = path.join(home, '.hermes/bin'); fs.mkdirSync(bin, { recursive: true })
  const preload = path.join(dir, 'cli-preload.mjs')
  fs.writeFileSync(preload, `import fs from 'node:fs';import path from 'node:path';const copied=/^hermes(?:\\.exe)?$/i.test(path.basename(process.execPath));if(copied||process.argv[1]?.endsWith('/hermes')){const args=process.argv.slice(copied?1:2).map((v,i)=>copied&&i===0?path.basename(v):v);fs.appendFileSync(${JSON.stringify(cliLog)},JSON.stringify({args,pid:process.pid,start:Date.now()})+String.fromCharCode(10));await new Promise(r=>setTimeout(r,6200));console.log(args.includes('profile')?'* default':JSON.stringify({id:'fixture-session',messages:[{role:'assistant',content:'完整 Unicode 🦀'}]}));process.exit(0)}`)
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(bin, 'hermes.exe'))
  else { const cli = path.join(bin, 'hermes'); fs.writeFileSync(cli, '#!' + process.execPath + '\n' + fs.readFileSync(preload, 'utf8')); fs.chmodSync(cli, 0o755) }
  fs.writeFileSync(path.join(home, '.openclaw/clawpanel.json'), JSON.stringify({ ignoreRisk: true, engineMode: 'hermes', enabledEngines: ['hermes'] }))
  gateway = http.createServer((q, r) => { const item = { requestAt: Date.now(), path: q.url }; observations.push(item); sawHealth?.(); setTimeout(() => { item.responseAt = Date.now(); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(payload)) }, healthDelay) })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); const gatewayPort = gateway.address().port
  const panel = path.join(home, '.openclaw/clawpanel.json'); fs.writeFileSync(panel, JSON.stringify({ ignoreRisk: true, engineMode: 'hermes', enabledEngines: ['hermes'], hermes: { gatewayUrl: `http://127.0.0.1:${gatewayPort}` } }))
  const server = path.join(dir, 'server.mjs')
  fs.writeFileSync(server, `import http from 'node:http';import {_initApi,_apiMiddleware} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/dev-api.js')).href)};_initApi();const s=http.createServer((q,r)=>{Promise.resolve(_apiMiddleware(q,r,()=>{r.statusCode=404;r.end()})).catch(e=>{r.statusCode=500;r.end(JSON.stringify({error:String(e)}))})});s.listen(0,'127.0.0.1',()=>console.log('READY '+s.address().port))`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'), OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'), NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, PATH: bin + path.delimiter + process.env.PATH }
  child = spawn(process.execPath, [server], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error('HTTP startup timeout')), 10000); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(Error('server exited ' + code + ': ' + out)) }); child.stdout.on('data', b => { out += b; const m = out.match(/READY (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } }); child.stderr.on('data', b => { out += b }) })
  serverBase = `http://127.0.0.1:${port}`
  const api = async (cmd, args = {}) => { const start = Date.now(), r = await fetch(serverBase + '/__api/' + cmd, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(30000) }); return { status: r.status, value: await r.json(), ms: Date.now() - start } }
  const received = new Promise(resolve => { sawHealth = resolve }), health = api('hermes_health_check'); await received; sawHealth = null
  const started = Date.now(), burst = await Promise.all([api('hermes_profiles_list'), api('hermes_sessions_list'), api('check_hermes')]), result = await health
  observations.push({ phase: 'burst', health: result, burst, wallMs: Date.now() - started })
  assert.equal(result.status, 200, JSON.stringify(observations)); assert.deepEqual(result.value, payload); assert.ok(result.ms < 5000, '快速上游不得被CLI占满5秒预算')
  assert.ok(burst.every(r => r.status === 200)); assert.ok(Date.now() - started < 11000, '两个CLI应并发而非各6.2秒串行')
  const events = fs.readFileSync(cliLog, 'utf8').trim().split('\n').map(s => JSON.parse(s)); assert.equal(events.length, 2, '不重放CLI'); assert.ok(Math.abs(events[0].start - events[1].start) < 2000)
  assert.equal(burst[0].value.active, 'default'); assert.equal(burst[0].value.profiles[0].name, 'default'); assert.equal(burst[1].value[0].id, 'fixture-session'); assert.equal(observations.filter(x => x.path === '/health').length, 1, '健康不重试')
  healthDelay = 5500; const slow = await api('hermes_health_check'); observations.push({ phase: 'slow-upstream', result: slow }); assert.equal(slow.status, 500); assert.match(slow.value.error, /timeout|aborted/i); assert.ok(slow.ms >= 4800 && slow.ms < 6500, '原5秒预算不放宽')
})
