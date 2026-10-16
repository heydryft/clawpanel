// 真实生产 HTTP middleware + 自有 CLI；不安装或运行 Hermes 内核。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const evidence = process.env.HERMES_STATUS_ERROR_EVIDENCE
const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')

test('status 失败投影不改变原调度/版本/STOP合同；Rust必须检查真实退出状态', () => {
  assert.match(source, /const HERMES_CLI_CONCURRENCY = 2\b/)
  assert.match(source, /const HERMES_CLI_QUEUE_LIMIT = 8\b/)
  assert.match(source, /const HERMES_CLI_DEADLINE_MS = 15000\b/)
  assert.match(source, /env, timeout: remaining, windowsHide: true/)
  assert.match(source, /maxBuffer: 1024 \* 1024/)
  assert.match(source, /if \(!r.ok\) throw new Error\(`Gateway 停止失败:/)
  const status = rust.match(/"status" => \{[^]*?\n        \}/)?.[0]
  assert.ok(status)
  assert.match(status, /cmd\.output\(\)\.await\.map_err\(\|e\| format!\("查询失败: \{e\}"\)\)\?/)
  assert.match(status, /hermes_gateway_status_output\(out\)/)
  assert.match(rust, /fn hermes_gateway_status_output\([^]*?out\.status\.success\(\)/)
})

test('status 真实 HTTP：exit7/15秒timeout双流/成功原文本/STOP/脱敏/无重放与PID清理', { timeout: 45000 }, async t => {
  const parent = fs.realpathSync.native(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(parent, 'hermes-status-error-'))
  const home = path.join(dir, 'home'), bin = path.join(home, '.hermes', 'bin')
  const modeFile = path.join(dir, 'input.json'), log = path.join(dir, 'cli.jsonl')
  const records = []
  let server, output = '', serverClosed
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true })
  fs.writeFileSync(path.join(home, '.openclaw', 'clawpanel.json'), JSON.stringify({ ignoreRisk: true, engineMode: 'hermes', enabledEngines: ['hermes'] }))
  const cli = `import fs from 'node:fs';import path from 'node:path';
const copied=/^hermes(?:\\.exe)?$/i.test(path.basename(process.execPath));
if(copied||path.basename(process.argv[1]||'')==='hermes'){
 const args=process.argv.slice(copied?1:2).map((v,i)=>copied&&i===0?path.basename(v):v);
 const mode=JSON.parse(fs.readFileSync(${JSON.stringify(modeFile)},'utf8'));
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'start',pid:process.pid,args,mode:mode.name,at:Date.now()})+'\\n');
 process.stdout.write(mode.stdout||'');process.stderr.write(mode.stderr||'');
 if(mode.timeout) await new Promise(r=>setTimeout(r,60000));
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({event:'end',pid:process.pid,at:Date.now()})+'\\n');
 process.exit(mode.code||0)
}`
  const preload = path.join(dir, 'fake-cli.mjs')
  fs.writeFileSync(preload, cli)
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, path.join(bin, 'hermes.exe'))
  else {
    fs.writeFileSync(path.join(bin, 'hermes'), '#!' + process.execPath + '\n' + cli)
    fs.chmodSync(path.join(bin, 'hermes'), 0o755)
  }
  const entry = path.join(dir, 'server.mjs')
  fs.writeFileSync(entry, `import http from 'node:http';import {_initApi,_apiMiddleware} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/dev-api.js')).href)};_initApi();const s=http.createServer((q,r)=>_apiMiddleware(q,r,()=>{r.statusCode=404;r.end()}));s.listen(0,'127.0.0.1',()=>console.log('READY '+s.address().port))`)
  const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'), OPENCLAW_CONFIG_DIR: path.join(home, '.openclaw'), NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, PATH: bin + path.delimiter + process.env.PATH }
  server = spawn(process.execPath, [entry], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  serverClosed = new Promise(resolve => server.once('close', resolve))
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill()
    await serverClosed
    const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
    const cleanup = [...new Set(events.map(e => e.pid))].map(pid => { let alive = false; try { process.kill(pid, 0); alive = true } catch {} return { pid, alive } })
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, 'http-report.json'), JSON.stringify({ scope: 'production HTTP middleware / owned fake CLI only', root, node: process.version, platform: process.platform, records, events, cleanup, serverStopped: server.exitCode !== null || server.signalCode !== null }, null, 2))
    }
    assert.ok(cleanup.every(p => !p.alive), JSON.stringify(cleanup))
    const relative = path.relative(parent, fs.realpathSync.native(dir))
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('fixture server startup timeout')), 10000)
    server.once('error', reject)
    server.once('exit', code => { clearTimeout(timer); reject(Error('fixture server exited ' + code + ': ' + output)) })
    server.stderr.on('data', b => { output += b })
    server.stdout.on('data', b => { output += b; const m = output.match(/READY (\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])) } })
  })
  const call = async (mode, action = 'status') => {
    fs.writeFileSync(modeFile, JSON.stringify(mode))
    const start = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/__api/hermes_gateway_action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(25000) })
    const result = { name: mode.name, action, http: response.status, body: await response.json(), ms: performance.now() - start }
    records.push(result)
    return result
  }
  const secrets = 'Bearer fixture-bearer api_key=fixture-apikey token=fixture-token password=fixture-password secret=fixture-secret sk-fixture-key'
  await t.test('exit7+stderr+partial running不是成功状态', async () => {
    const r = await call({ name: 'exit7', code: 7, stdout: 'Gateway running PID 12345\n', stderr: 'fixture failure ' + secrets })
    assert.equal(r.http, 500, JSON.stringify(r))
    assert.match(r.body.error, /Gateway 状态查询失败/)
    assert.match(r.body.error, /code=7/)
    assert.match(r.body.error, /fixture failure/)
    assert.doesNotMatch(r.body.error, /fixture-bearer|fixture-apikey|fixture-token|fixture-password|fixture-secret|sk-fixture-key/)
  })
  await t.test('原15秒真实超时且stderr非空仍保留deadline/signal/killed，partial stdout不当running', async () => {
    const r = await call({ name: 'timeout', timeout: true, stdout: 'Gateway running PID 12345\n', stderr: 'fixture phase completed ' + secrets })
    assert.equal(r.http, 500, JSON.stringify(r))
    assert.match(r.body.error, /timeout|deadline/i)
    assert.match(r.body.error, /15000ms/)
    assert.match(r.body.error, /signal=SIGTERM/)
    assert.match(r.body.error, /killed=true/)
    assert.match(r.body.error, /fixture phase completed/)
    assert.doesNotMatch(r.body.error, /fixture-bearer|fixture-apikey|fixture-token|fixture-password|fixture-secret|sk-fixture-key/)
    assert.ok(r.ms >= 14000 && r.ms < 18000, JSON.stringify(r))
  })
  await t.test('成功与已停止文本保持原trim，不解析/猜测状态协议', async () => {
    for (const stdout of ['  Gateway running PID 12345\n完整 Unicode 🦀\n', 'Gateway is not running.\n', 'unknown', '']) {
      const r = await call({ name: 'success', stdout })
      assert.equal(r.http, 200, JSON.stringify(r)); assert.equal(r.body, stdout.trim())
    }
  })
  await t.test('错误详情6000字符尾部与脱敏，原因在截断外仍保留', async () => {
    const r = await call({ name: 'bounded', code: 7, stderr: 'X'.repeat(8000) + '\nfixture-tail ' + secrets })
    assert.equal(r.http, 500, JSON.stringify(r))
    assert.ok(r.body.error.length <= 6400)
    assert.match(r.body.error, /code=7/); assert.match(r.body.error, /fixture-tail/)
    assert.doesNotMatch(r.body.error, /fixture-bearer|fixture-apikey|fixture-token|fixture-password|fixture-secret|sk-fixture-key/)
  })
  await t.test('STOP原成功/失败语义不变', async () => {
    const good = await call({ name: 'stop-success', stdout: 'fixture stop' }, 'stop')
    assert.equal(good.http, 200); assert.equal(good.body, 'Gateway 已停止')
    const bad = await call({ name: 'stop-failure', code: 7, stderr: 'fixture stop failed' }, 'stop')
    assert.equal(bad.http, 500); assert.equal(bad.body.error, 'Gateway 停止失败: fixture stop failed')
  })
  const starts = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'start')
  assert.equal(starts.length, records.length, '每次API仅一次CLI，不重放')
  assert.deepEqual(starts.map(e => e.args), records.map(r => ['gateway', r.action]))
})
