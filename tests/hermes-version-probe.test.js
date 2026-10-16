import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../scripts/dev-api.js', import.meta.url), 'utf8')
const body = source.match(/(?:async )?function runHermesVersionSilent\(\) \{[^]*?\n\}/)?.[0]

function probe(runSilent, managed = () => null) {
  assert.ok(body, '版本探测函数应存在')
  return new Function('runHermesSilent', 'runHermesManagedMetadataSilent', `${body}\nreturn runHermesVersionSilent()`)(runSilent, managed)
}

test('已提交 PM 使用官方本地 metadata 接口，版本探针不等待远程更新检查', async () => {
  const result = await probe(() => { throw new Error('受管 PM 不应执行远程 CLI update check') },
    () => ({ ok: true, stdout: 'Hermes Agent v0.22.2' }))
  assert.equal(result.stdout, 'Hermes Agent v0.22.2')
})

test('受管 metadata 失败时保持 fail-closed，不用 legacy 子命令触发隐式修复', async () => {
  const failed = { ok: false, stderr: 'PM currency false' }
  assert.equal(await probe(() => { throw new Error('不应回退') }, () => failed), failed)
})

test('现代 Hermes 版本探测只走 metadata，避免 legacy version 触发 source completion', async () => {
  const calls = []
  const result = await probe((program, args) => {
    calls.push([program, ...args])
    assert.deepEqual(args, ['--version'], '不应先进入会触发首次维护的 version 子命令')
    return { ok: true, stdout: '0.22.2' }
  })
  assert.deepEqual(calls, [['hermes', '--version']])
  assert.equal(result.stdout, '0.22.2')
})

test('仅旧 version 子命令可用时保留一次 fallback', async () => {
  const calls = []
  const result = await probe((_program, args) => {
    calls.push(args)
    return args[0] === '--version' ? { ok: false, stderr: 'unsupported flag' } : { ok: true, stdout: 'legacy-version' }
  })
  assert.deepEqual(calls, [['--version'], ['version']])
  assert.equal(result.stdout, 'legacy-version')
})

test('两个版本入口都失败时返回实际 fallback 错误而非伪造成功', async () => {
  const calls = []
  const result = await probe((_program, args) => {
    calls.push(args)
    return { ok: false, stderr: args[0] }
  })
  assert.deepEqual(calls, [['--version'], ['version']])
  assert.deepEqual(result, { ok: false, stderr: 'version' })
})
