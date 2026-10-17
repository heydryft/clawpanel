import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// 真实既有浏览器 + 自有HTTP；实际页面/engine及原15秒poll，不安装内核或浏览器。
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => i % 2 ? a : (a.push([v.slice(2), all[i + 1]]), a), []))
for (const k of ['root', 'output', 'vite', 'playwright', 'browser']) assert.ok(args[k], k)
const root = path.resolve(args.root), out = path.resolve(args.output), scenario = args.scenario || 'recovery'
const consumer = /^consumer-(setup|services|about|dashboard)-(unknown|error|absent)$/.exec(scenario)
const sendEntry = /^sendguard-(unknown|absent|down|config|healthy|active-controls)$/.exec(scenario)
fs.mkdirSync(out, { recursive: true })
const { createServer } = await import(pathToFileURL(path.join(args.vite, 'dist/node/index.js')))
const { chromium } = await import(pathToFileURL(args.playwright))
const deps = path.dirname(args.vite)
const report = { scope: 'actual existing headless Chrome + owned HTTP fault inputs; not Hermes VM', scenario, node: process.version, sourceHashes: Object.fromEntries(['src/engines/hermes/index.js', 'src/engines/hermes/pages/chat.js', 'src/engines/hermes/lib/chat-store.js', 'src/lib/tauri-api.js', 'tests/hermes-chat-health.e2e.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), requests: [], steps: [], errors: [], violations: [], external: [] }
let server, browser, context, page, pending, activeStream, profile = 'default', checks = 0
const healthy = { installed: true, version: '0.22.2', configExists: true, gatewayRunning: true, model: 'own-model', detectionError: null }
const unknownFault = { ...healthy, installed: null, version: null, detectionError: 'Bearer ownedBearer sk-ownedKey password=ownedPassword', cmd: 'private argv ownedPassword', env: { PASSWORD: 'ownedPassword' } }
const faultKind = sendEntry?.[1] || scenario
const fault = faultKind === 'absent' ? { ...healthy, installed: false, version: null } : faultKind === 'down' ? { ...healthy, gatewayRunning: false } : faultKind === 'config' ? { ...healthy, configExists: false } : ['healthy', 'active-controls'].includes(faultKind) ? healthy : unknownFault
const terminal = sendEntry ? faultKind === 'active-controls' ? unknownFault : healthy : ['absent', 'down', 'config'].includes(scenario) ? fault : healthy
const chatHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="mount"></div><script type="module">
import '/src/style/variables.css';import '/src/style/reset.css';import '/src/style/components.css';import '/src/engines/hermes/style/hermes.css';
import {initI18n} from '/src/lib/i18n.js';import engine from '/src/engines/hermes/index.js';import {render} from '/src/engines/hermes/pages/chat.js';import {getChatStore} from '/src/engines/hermes/lib/chat-store.js';
await initI18n();const active=new Set();const subscribe=engine.onStateChange;engine.onStateChange=function(fn){active.add(fn);const unsub=subscribe.call(this,fn);return()=>{active.delete(fn);unsub()}};
await engine.boot();window.healthFixture={engine,store:getChatStore(),active,unmount(){document.querySelector('#mount').replaceChildren()},mount(){document.querySelector('#mount').append(render())}};window.healthFixture.mount();
</script></body></html>`
const consumerModule = consumer?.[1] === 'about' ? '/src/pages/about.js' : '/src/engines/hermes/pages/' + consumer?.[1] + '.js'
const html = !consumer ? chatHtml : `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="mount"></div><script type="module">
import '/src/style/variables.css';import '/src/style/reset.css';import '/src/style/components.css';import '/src/engines/hermes/style/hermes.css';
import {initI18n} from '/src/lib/i18n.js';import engine from '/src/engines/hermes/index.js';import{registerEngine,activateEngine}from'/src/lib/engine-manager.js';import{render}from'${consumerModule}';
await initI18n();registerEngine(engine);await activateEngine('hermes',false);document.querySelector('#mount').append(await render());
</script></body></html>`
const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)) }
const defaults = (cmd, body) => ({
  check_python: { installed: true, version: '3.13.0', versionOk: true, hasGit: true, hasUv: true },
  read_panel_config: { engineMode: 'hermes', ignoreRisk: true },
  check_panel_update: { hasUpdate: false },
  hermes_profiles_list: { active: profile, profiles: [{ name: 'default', active: profile === 'default', gatewayRunning: true }, { name: 'named', active: profile === 'named', gatewayRunning: true }] },
  hermes_sessions_list: [], hermes_session_detail: { messages: [] }, hermes_models_list: [],
}[cmd] || {})
async function state(label) {
  const s = await page.evaluate(() => {
    const input = document.querySelector('#hm-chat-input'), store = window.healthFixture?.store
    return { route: location.href, input: input?.value, selection: input ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null, attachments: [...document.querySelectorAll('.hm-chat-attach-chip img')].map(i => ({ name: i.alt, dataUrl: i.src })), messageCount: store?.activeSession()?.messages.length, userMessages: store?.activeSession()?.messages.filter(m => m.role === 'user').map(m => ({ content: m.content, attachments: m.attachments?.map(a => ({ name: a.name, dataUrl: a.dataUrl })) })), disabled: document.querySelector('#hm-chat-send')?.disabled, banner: document.querySelector('.hm-chat-health-banner')?.textContent || '', profile: store?.state.activeProfile, subscriptions: window.healthFixture?.active.size, mounted: !!input }
  })
  report.steps.push({ label, ...s }); return s
}
const expect = (ok, label) => { if (!ok) report.violations.push(label) }
async function sendEntryScenario() {
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const sends = () => report.requests.filter(x => x.cmd === 'hermes_agent_run_stream')
  const text = 'owned send guard 中文 café é Ω🙂'
  await page.locator('#hm-chat-input').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('#hm-chat-new-chat').click({ timeout: 30000 })
  await page.locator('#hm-chat-input').fill(text)
  expect((await state('initial-unknown')).disabled === true, 'initial unknown must not enable Send')
  assert.ok(pending, 'actual chat initial check must be pending')
  const bResponse = page.waitForResponse(r => r.url().endsWith('/__api/check_hermes') && r.status() === 200, { timeout: 30000 })
  json(pending, fault); pending = null; await (await bResponse).finished(); await settle()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const image = path.join(out, 'owned-health-attachment.png'); fs.writeFileSync(image, png)
  await page.locator('#hm-chat-attach-input').setInputFiles(image)
  await page.waitForFunction(() => document.querySelectorAll('.hm-chat-attach-chip').length === 1, null, { timeout: 30000 })
  await page.locator('#hm-chat-send').scrollIntoViewIfNeeded()
  await page.locator('#hm-chat-input').evaluate(input => { input.focus(); input.setSelectionRange(6, 17, 'backward') })
  const before = await state('B-before-keyboard'); const beforeSends = sends().length
  const blocked = ['unknown', 'absent', 'down', 'config'].includes(sendEntry[1])
  if (blocked) {
    expect(before.disabled === true, 'B must disable Send')
    await page.locator('#hm-chat-input').press('Enter')
    await page.waitForFunction(() => window.healthFixture.store.state.streaming === false, null, { timeout: 30000 }); await settle()
    const after = await state('B-after-real-Enter')
    expect(sends().length === beforeSends, 'blocked Enter must issue zero actual HTTP sends')
    expect(after.input === before.input, 'blocked Enter must preserve draft')
    expect(JSON.stringify(after.attachments) === JSON.stringify(before.attachments), 'blocked Enter must preserve PNG attachments')
    expect(JSON.stringify(after.selection) === JSON.stringify(before.selection), 'blocked Enter must preserve selected range and direction')
    expect(after.messageCount === before.messageCount && JSON.stringify(after.userMessages) === JSON.stringify(before.userMessages), 'blocked Enter must not write user messages')
    const box = await page.locator('#hm-chat-send').boundingBox(); assert.ok(box)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await settle()
    const afterButton = await state('B-after-real-disabled-button-click')
    expect(sends().length === beforeSends, 'blocked button must issue zero actual HTTP sends')
    expect(afterButton.input === before.input && JSON.stringify(afterButton.attachments) === JSON.stringify(before.attachments), 'blocked button must preserve composer')
    expect(JSON.stringify(afterButton.selection) === JSON.stringify(before.selection), 'blocked button must preserve selected range')
    expect(afterButton.messageCount === before.messageCount, 'blocked button must not write user messages')
    // C只来自原15秒engine poll；不重填正文/附件、不改路由、不手动检测。
    const cResponse = await page.waitForResponse(r => r.url().endsWith('/__api/check_hermes'), { timeout: 20000 }); await cResponse.finished(); await settle()
    const c = await state('C-existing-poll-recovered')
    expect(c.disabled === false, 'C must restore keyboard/button send')
    expect(c.input === text && JSON.stringify(c.attachments) === JSON.stringify(before.attachments), 'C must retain unsent text and PNG without refill')
    expect(c.route === before.route, 'C must not navigate')
    expect(checks === 3, 'C must use only existing boot/chat/poll probes')
    if (c.input !== text) return
  }
  await page.locator('#hm-chat-input').press('Enter')
  if (sendEntry[1] === 'active-controls') {
    await page.waitForFunction(() => window.healthFixture.store.state.pendingApproval?.runId === 'owned-health-run', null, { timeout: 30000 })
    const cResponse = await page.waitForResponse(r => r.url().endsWith('/__api/check_hermes'), { timeout: 20000 }); await cResponse.finished(); await settle()
    expect(/检测失败|detection failed/i.test((await state('C-unknown-during-task')).banner), 'health must actually become unknown during live task')
    // 原页面未渲染审批按钮：仅检验真实公共store与HTTP，不冒充审批GUI资格。
    await page.evaluate(() => window.healthFixture.store.respondApproval('once'))
    expect(report.requests.filter(x => x.cmd === 'hermes_run_approval' && x.body.runId === 'owned-health-run' && x.body.choice === 'once').length === 1, 'unknown must not block existing approval API')
    await page.locator('#hm-chat-stop').click({ timeout: 30000 })
    await page.waitForFunction(() => window.healthFixture.store.state.streaming === false, null, { timeout: 30000 })
    report.taskControlsScope = 'actual STOP UI/local abort and public-store approval HTTP; no rendered approval button or actual kernel STOP qualification'
    expect(sends().length === 1, 'task controls must not replay user sends')
  } else {
    await page.waitForFunction(() => document.body.textContent.includes('owned health reply') && !window.healthFixture.store.state.streaming, null, { timeout: 30000 }); await settle()
    const accepted = await state('accepted-real-Enter-once')
    expect(sends().length === 1 && sends()[0].body.input === text, 'verified Enter must send exactly once with unchanged text')
    expect(accepted.input === '' && accepted.attachments.length === 0, 'verified send clears only submitted composer')
    expect(accepted.userMessages.length === 1 && accepted.userMessages[0].content === text && accepted.userMessages[0].attachments?.length === 1, 'accepted Enter must keep one user message with original PNG')
    expect(accepted.userMessages[0]?.attachments?.[0]?.dataUrl === 'data:image/png;base64,' + png.toString('base64'), 'accepted message attachment bytes must match')
    report.webAttachmentTransportObserved = Object.hasOwn(sends()[0]?.body || {}, 'attachments')
  }
}
try {
  server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), define: { __APP_VERSION__: '"owned-health-fixture"' }, resolve: { alias: ['@tauri-apps/api', '@tauri-apps/plugin-shell', '@tauri-apps/plugin-autostart', 'yaml'].map(find => ({ find, replacement: path.join(deps, find) })) }, optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root, deps] } }, plugins: [{ name: 'own-health-http', configureServer(s) { s.middlewares.use((req, res, next) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname === '/__health_fixture__') { res.setHeader('content-type', 'text/html'); return res.end(html) }
    if (!u.pathname.startsWith('/__api/')) return next()
    const cmd = u.pathname.slice(7); let raw = ''
    req.on('data', b => { raw += b; assert.ok(raw.length < 65536) })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}'); report.requests.push({ cmd, at: Date.now(), profile, body })
      if (/install|uninstall|upgrade/.test(cmd)) { report.errors.push('forbidden write ' + cmd); res.statusCode = 500; return json(res, {}) }
      if (cmd === 'check_hermes') {
        checks++
        if (consumer) {
          if (consumer[2] === 'error') { res.statusCode = 500; return json(res, { error: 'Bearer ownedBearer sk-ownedKey password=ownedPassword' }) }
          return json(res, consumer[2] === 'absent' ? { ...healthy, installed: false, version: null } : { ...fault, installed: null, version: null })
        }
        if (checks === 2) { pending = res; return }
        return json(res, checks === 1 ? healthy : terminal)
      }
      if (cmd === 'hermes_profile_use') profile = body.name
      if (cmd === 'hermes_agent_run_stream') {
        res.setHeader('content-type', 'application/x-ndjson')
        if (sendEntry?.[1] === 'active-controls') { activeStream = res; return res.write(JSON.stringify({ event: 'approval.request', run_id: 'owned-health-run', request_id: 'owned-health-approval', tool: 'owned-tool', choices: ['once', 'deny'] }) + '\n') }
        return res.end(JSON.stringify({ event: 'run.completed', output: 'owned health reply' }) + '\n')
      }
      json(res, defaults(cmd, body))
    })
  }) } }] })
  await server.listen(); const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch({ executablePath: args.browser, headless: true }); report.browser = browser.version(); report.browserSha256 = createHash('sha256').update(fs.readFileSync(args.browser)).digest('hex')
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (new URL(url).origin !== origin) {
      // 关于页既有二维码只用自有像素占位；真实外网始终阻断，不涉及安装判态。
      if (consumer?.[1] === 'about' && route.request().resourceType() === 'image' && ['https://qt.cool/c/OpenClawDY/qr.png', 'https://qt.cool/c/feishu/qr.png'].includes(url)) {
        ;(report.interceptedLegacyImages ||= []).push(url)
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+P+/HgAFhAJ/wfQ1WQAAAABJRU5ErkJggg==', 'base64') })
      }
      report.external.push(url.split('?')[0]); return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message))
  const consumerResponse = consumer ? page.waitForResponse(r => r.url().endsWith('/__api/check_hermes'), { timeout: 30000 }) : null
  await page.goto(origin + '/__health_fixture__', { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (consumer) {
    await (await consumerResponse).finished()
    await page.waitForFunction(() => document.querySelector('#version-cards .stat-card') || document.querySelector('.hermes-detect-list') || document.querySelector('.hm-hero-h1'), null, { timeout: 30000 })
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const body = await page.locator('body').innerText()
    const unknown = consumer[2] !== 'absent'
    const enabledInstalls = await page.locator('.hermes-install-btn:enabled,.hm-services-install:enabled,#btn-hermes-install:enabled').count()
    const setupLinks = await page.locator('#version-cards a[href="#/h/setup"]').count()
    expect(!unknown || /Hermes.*检测失败|Hermes.*detection failed/i.test(body), 'unknown must show safe detection failure in ' + consumer[1])
    expect(!unknown || (!/Hermes Agent 未安装|未检测到 Hermes Agent|未安装 Hermes Agent/.test(body) && enabledInstalls === 0 && setupLinks === 0), 'unknown must not offer missing/installation in ' + consumer[1])
    for (const secret of ['ownedBearer', 'ownedKey', 'ownedPassword']) expect(!body.includes(secret), 'consumer must not render raw credential')
    expect(report.requests.every(x => !/^(install_hermes|update_hermes|uninstall_hermes|configure_hermes|hermes_gateway_action)$/.test(x.cmd)), 'consumer must not auto-write')
    report.consumer = { page: consumer[1], response: consumer[2], checks, enabledInstalls, setupLinks, textSha256: createHash('sha256').update(body).digest('hex') }
  } else if (sendEntry) { await sendEntryScenario() } else {
  await page.locator('#hm-chat-input').waitFor({ state: 'visible', timeout: 30000 }); await page.locator('#hm-chat-new-chat').click({ timeout: 30000 })
  const text = 'owned health draft 中文 café é Ω🙂'; await page.locator('#hm-chat-input').fill(text)
  expect((await state('initial-unknown')).disabled === true, 'initial unknown must not enable Send')
  assert.ok(pending, 'actual chat initial check must be pending')
  if (scenario === 'unmount') { await page.evaluate(() => window.healthFixture.unmount()); await page.waitForFunction(() => window.healthFixture.active.size === 0, null, { timeout: 30000 }); json(pending, healthy); pending = null; await state('unmounted-late-response'); expect(!(await state('unmounted')).mounted, 'late reply must not remount page') }
  else {
    if (scenario === 'profile') { await page.evaluate(() => window.healthFixture.store.switchProfile('named')); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); expect((await state('profile-boundary')).input === '', 'default draft must be cleared on profile change'); await page.locator('#hm-chat-new-chat').click({ timeout: 30000 }); await page.locator('#hm-chat-input').fill('named-only draft') }
    const bResponse = page.waitForResponse(r => r.url().endsWith('/__api/check_hermes') && r.status() === 200, { timeout: 30000 })
    json(pending, fault); pending = null; await (await bResponse).finished()
    // B已交付后等实际DOM回调；不改产品timer、不在listener补请求。
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const b = await state('B-probe-failed'); expect(b.disabled === true, 'failed/absent/down/config must block Send')
    for (const secret of ['ownedBearer', 'ownedKey', 'ownedPassword', 'private argv']) expect(!(await page.locator('body').innerText()).includes(secret), 'raw credential must not appear in UI')
    if (scenario === 'recovery') { expect(/检测失败|detection failed/i.test(b.banner), 'probe error must be visible, not missing installation'); expect(b.input === text, 'B must retain filled draft') }
    if (scenario === 'profile') expect(b.input === 'named-only draft' && b.profile === 'named', 'late default response must not overwrite named draft')
    // C来自engine.boot启动的原15秒poll。没有手工detect/额外API/自动重试。
    const cResponse = await page.waitForResponse(r => r.url().endsWith('/__api/check_hermes') && r.status() === 200, { timeout: 20000 }); await cResponse.finished()
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    const c = await state('C-existing-poll'); expect(c.route.endsWith('/__health_fixture__'), 'no route navigation')
    if (['recovery', 'profile'].includes(scenario)) { expect(c.disabled === false, 'C must restore Send without route/refill'); if (scenario === 'recovery') expect(c.input === text, 'C must retain original draft') }
    else expect(c.disabled === true, scenario + ' must remain blocked')
    if (scenario === 'recovery' && c.disabled === false) { await page.locator('#hm-chat-send').click({ timeout: 30000 }); await page.waitForFunction(() => document.body.textContent.includes('owned health reply'), null, { timeout: 30000 }); expect(report.requests.filter(x => x.cmd === 'hermes_agent_run_stream').length === 1, 'one real click, one send') }
  }
  }
  await page.screenshot({ path: path.join(out, 'final.png') }); assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []); assert.deepEqual(report.violations, [])
  report.passed = true
} catch (e) { report.passed = false; report.failure = { message: e.message, stack: e.stack }; if (page) { await state('failure').catch(() => {}); await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}) } }
finally { pending?.destroy(); activeStream?.destroy(); await page?.evaluate(() => { window.healthFixture?.unmount(); window.healthFixture?.engine.cleanup() }).catch(() => {}); if (context) await context.tracing.stop({ path: path.join(out, 'trace.zip') }); await context?.close(); await browser?.close(); await server?.close(); report.cleanup = { browserDisconnected: !browser?.isConnected(), serverClosed: !server?.httpServer?.listening, forbiddenWrites: report.requests.filter(x => /install|uninstall|upgrade/.test(x.cmd)).length }; fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n') }
console.log(JSON.stringify({ passed: report.passed, violations: report.violations, checks, steps: report.steps, output: out }, null, 2)); process.exitCode = report.passed ? 0 : 1
