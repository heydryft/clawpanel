import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import test from 'node:test'
import { resolveHermesPmEnvironment } from '../scripts/hermes-pm-runtime.js'

test('PM 按 canonical checkout 选择已提交环境，不将旧 venv 当作新环境', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pm-'))
  try {
    const source = path.join(home, 'hermes-agent'); fs.mkdirSync(source)
    assert.equal(resolveHermesPmEnvironment(home, source), null)
    const key = crypto.createHash('sha256').update(fs.realpathSync(source)).digest('hex').slice(0, 16)
    const state = path.join(home, 'installs', key), env = path.join(state, 'environments', 'generation-1')
    fs.mkdirSync(env, { recursive: true }); fs.writeFileSync(path.join(env, 'pyvenv.cfg'), 'home = private\n')
    const facts = path.join(state, 'facts.json')
    fs.writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: env } } }))
    assert.equal(resolveHermesPmEnvironment(home, source), fs.realpathSync(env))
    fs.writeFileSync(facts, '{broken')
    assert.throws(() => resolveHermesPmEnvironment(home, source), /PM/)
    fs.writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: source } } }))
    assert.throws(() => resolveHermesPmEnvironment(home, source), /PM/)
    fs.writeFileSync(facts, JSON.stringify({ packages: { venv: { environment: 42 } } }))
    assert.throws(() => resolveHermesPmEnvironment(home, source), /PM/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// 显式配置优先于自动发现；先留下失败再修实现。
test('显式 HERMES_PYTHON 必须先于 PM 自动发现', () => {
  const rust = fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs', import.meta.url), 'utf8')
  const body = rust.match(/fn hermes_venv_python\(\)[^]*?\n}/)?.[0] || ''
  const pm = body.indexOf('hermes_pm_environment_at')
  const explicit = body.indexOf('HERMES_PYTHON')
  assert.ok(explicit >= 0 && (pm < 0 || explicit < pm), '显式解释器被 PM 自动发现遮蔽')
})

test('PM environments 根目录链接越界也必须拒绝', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pm-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pm-outside-'))
  try {
    const source = path.join(home, 'hermes-agent'); fs.mkdirSync(source)
    const key = crypto.createHash('sha256').update(fs.realpathSync(source)).digest('hex').slice(0, 16)
    const state = path.join(home, 'installs', key); fs.mkdirSync(state, { recursive: true })
    const selected = path.join(outside, 'generation-1'); fs.mkdirSync(selected)
    fs.writeFileSync(path.join(selected, 'pyvenv.cfg'), 'home = outside\n')
    fs.symlinkSync(outside, path.join(state, 'environments'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.writeFileSync(path.join(state, 'facts.json'), JSON.stringify({ packages: { venv: { environment: selected } } }))
    assert.throws(() => resolveHermesPmEnvironment(home, source), /PM/)
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})
