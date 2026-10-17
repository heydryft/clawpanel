// 实际engine源的Promise/interval组件：不运行真实CLI、HTTP、UI或计时器。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

const source = fs.readFileSync(new URL('../src/engines/hermes/index.js', import.meta.url), 'utf8')
const evidence = process.env.HERMES_LIFECYCLE_TEST_EVIDENCE
const healthy = { installed: true, configExists: true, gatewayRunning: true, version: '0.22.2' }
const down = { installed: false, configExists: false, gatewayRunning: false, version: null }

function fixture(t, id) {
  const requests = [], intervals = new Map(), trace = [], snapshots = [], events = [], invalidations = []
  let nextInterval = 0, intervalInstalls = 0, intervalClears = 0, completed = false, engine
  const record = (event, data = {}) => trace.push({ step: trace.length + 1, event, ...data })
  const api = { checkHermes() {
    const id = requests.length + 1
    let resolve, reject
    const promise = new Promise((a, b) => { resolve = a; reject = b })
    requests.push({ resolve(value) { record('api-resolve', { id }); resolve(value) }, reject(error) { record('api-reject', { id }); reject(error) } })
    record('api-call', { id })
    return promise
  } }
  const body = source.replace(/^import .*$/gm, '').replaceAll('export function ', 'function ').replace('export default ', 'const engine = ')
  engine = vm.runInNewContext('"use strict";\n' + body + '\nengine', {
    api, t: key => key, performance,
    invalidate: (...args) => { invalidations.push(args); record('invalidate', { commands: args }) },
    setInterval(callback, ms) {
      const id = ++nextInterval
      intervalInstalls++; intervals.set(id, { callback, ms }); record('interval-install', { id, ms }); return id
    },
    clearInterval(id) { intervalClears++; intervals.delete(id); record('interval-clear', { id }) },
  }, { filename: 'actual-hermes-engine-index.js' })
  engine.onStateChange(event => { events.push(event); record('health-event', { ready: event.ready, running: event.running, info: JSON.parse(JSON.stringify(event.info)) }) })
  const state = label => {
    const value = { label, apiCalls: requests.length, invalidations: invalidations.length, activeIntervals: intervals.size, intervalInstalls, intervalClears, broadcasts: events.length, ready: engine.isReady(), running: engine.isGatewayRunning() }
    snapshots.push(value); record('checkpoint', value); return value
  }
  t.after(() => {
    const report = { scope: 'actual engine source + controlled Promise and timer inventory only; never real runtime qualification', case: id, node: process.version, sourceSha256: createHash('sha256').update(source).digest('hex'), assertionsCompleted: completed, final: state('after-test'), snapshots, trace }
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, id + '.json'), JSON.stringify(report, null, 2) + '\n') }
  })
  return {
    engine, requests, intervals, events, state,
    resolve: (id, value = healthy) => requests[id - 1].resolve(value),
    reject: id => requests[id - 1].reject(new Error('owned probe rejection')),
    tick() { assert.equal(intervals.size, 1); return [...intervals.values()][0].callback() },
    done() { completed = true },
  }
}

test('H1 正常boot一个15s poll、原tick一次check、cleanup归零且保留listener', async t => {
  const f = fixture(t, 'normal-boot-poll-cleanup')
  let readyEvents = 0
  const unsubscribe = f.engine.onReadyChange(() => readyEvents++)
  const boot = f.engine.boot()
  assert.equal(f.state('boot-pending').apiCalls, 1)
  assert.equal(f.intervals.size, 0)
  f.resolve(1); await boot
  assert.equal(f.state('boot-settled').activeIntervals, 1)
  assert.equal([...f.intervals.values()][0].ms, 15000)
  assert.equal(f.engine.isReady(), true); assert.equal(readyEvents, 1)
  unsubscribe()
  const tick = f.tick()
  assert.equal(f.requests.length, 2)
  f.resolve(2, { ...healthy, configExists: false }); await tick
  assert.equal(f.engine.isReady(), false, '原ready仍是installed与config同时true')
  assert.equal(f.engine.isGatewayRunning(), true)
  assert.equal(readyEvents, 1, '原unsubscribe保留')
  assert.equal(f.events.length, 2)
  assert.ok(Object.isFrozen(f.events[0]) && Object.isFrozen(f.events[0].info))
  f.engine.cleanup()
  const final = f.state('cleanup')
  assert.equal(final.activeIntervals, 0); assert.equal(final.intervalInstalls, 1); assert.equal(final.intervalClears, 1)
  assert.equal(final.apiCalls, 2); assert.equal(final.invalidations, 2)
  f.done()
})

test('H1 pending boot经cleanup后旧成功晚返回不复活poll或健康事件', async t => {
  const f = fixture(t, 'cancelled-late-success'), boot = f.engine.boot()
  f.engine.cleanup(); assert.equal(f.state('cleanup-while-pending').activeIntervals, 0)
  f.resolve(1); await boot
  const final = f.state('old-boot-returned')
  assert.equal(final.activeIntervals, 0, JSON.stringify(final)); assert.equal(final.intervalInstalls, 0)
  assert.equal(final.apiCalls, 1); assert.equal(final.broadcasts, 0); assert.equal(final.ready, false)
  f.done()
})

test('H1 pending boot经cleanup后旧失败晚返回也不复活poll', async t => {
  const f = fixture(t, 'cancelled-late-rejection'), boot = f.engine.boot()
  f.engine.cleanup(); f.reject(1); await boot
  const final = f.state('old-failed-boot-returned')
  assert.equal(final.activeIntervals, 0, JSON.stringify(final)); assert.equal(final.intervalInstalls, 0)
  assert.equal(final.apiCalls, 1); assert.equal(final.broadcasts, 0)
  f.done()
})

test('H1 cleanup后新boot安装一个poll，晚旧boot不抢新scope', async t => {
  const f = fixture(t, 'new-boot-before-cancelled-old')
  const old = f.engine.boot(); f.engine.cleanup(); const fresh = f.engine.boot()
  f.resolve(2); await fresh
  assert.equal(f.state('new-boot-settled').activeIntervals, 1)
  f.resolve(1, down); await old
  const final = f.state('cancelled-old-after-new')
  assert.equal(final.activeIntervals, 1); assert.equal(final.intervalInstalls, 1)
  assert.equal(final.apiCalls, 2); assert.equal(final.broadcasts, 1); assert.equal(final.ready, true)
  f.engine.cleanup(); assert.equal(f.intervals.size, 0)
  f.done()
})

test('H1 parallel boot旧先返回时不为仍pending的新boot安装poll', async t => {
  const f = fixture(t, 'parallel-old-first'), old = f.engine.boot(), fresh = f.engine.boot()
  f.resolve(1, down); await old
  const pending = f.state('old-returned-new-still-pending')
  assert.equal(pending.activeIntervals, 0, JSON.stringify(pending)); assert.equal(pending.broadcasts, 0)
  f.resolve(2); await fresh
  const final = f.state('new-boot-returned')
  assert.equal(final.activeIntervals, 1); assert.equal(final.intervalInstalls, 1)
  assert.equal(final.apiCalls, 2); assert.equal(final.broadcasts, 1); assert.equal(final.ready, true)
  f.engine.cleanup(); f.done()
})

test('H1 parallel boot新先返回后旧结果不改ready或重复安装poll', async t => {
  const f = fixture(t, 'parallel-new-first'), old = f.engine.boot(), fresh = f.engine.boot()
  f.resolve(2); await fresh; f.resolve(1, down); await old
  const final = f.state('parallel-new-then-old')
  assert.equal(final.activeIntervals, 1); assert.equal(final.intervalInstalls, 1)
  assert.equal(final.apiCalls, 2); assert.equal(final.broadcasts, 1); assert.equal(final.ready, true)
  f.engine.cleanup(); f.done()
})

test('H1 listener在boot广播中cleanup，await返回后不重新安装poll', async t => {
  const f = fixture(t, 'listener-cancels-boot')
  const unsubscribe = f.engine.onStateChange(() => f.engine.cleanup())
  const boot = f.engine.boot(); f.resolve(1); await boot
  const final = f.state('listener-cleanup-before-boot-resume')
  assert.equal(final.activeIntervals, 0, JSON.stringify(final)); assert.equal(final.intervalInstalls, 0)
  assert.equal(final.apiCalls, 1); assert.equal(final.broadcasts, 1)
  unsubscribe(); f.done()
})

test('H1 清除已有poll和pending reboot后不复活，后续boot仍可启动一次', async t => {
  const f = fixture(t, 'active-poll-pending-reboot-cleanup')
  const first = f.engine.boot(); f.resolve(1); await first
  const pending = f.engine.boot(); f.engine.cleanup()
  assert.equal(f.state('existing-poll-cleared').activeIntervals, 0)
  f.resolve(2); await pending
  assert.equal(f.state('cancelled-reboot-returned').activeIntervals, 0)
  const fresh = f.engine.boot(); f.resolve(3); await fresh
  const final = f.state('subsequent-new-boot')
  assert.equal(final.activeIntervals, 1); assert.equal(final.intervalInstalls, 2); assert.equal(final.intervalClears, 1)
  assert.equal(final.apiCalls, 3); assert.equal(final.broadcasts, 2)
  f.engine.cleanup(); f.done()
})
