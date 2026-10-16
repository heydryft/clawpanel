import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import YAML from 'yaml'

// 先保留真实faefa26清理时序红灯；CI必须导出完整自有fixture材料，不能只留错误枚举刷重跑。
test('CI在原Node入口前准备自有证据目录，失败也只上传受控bounds报告，不改权限或测试命令', () => {
  const ci = YAML.parse(fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')), job = ci.jobs.check
  assert.equal(ci.permissions.contents, 'read')
  assert.equal(job.env?.HERMES_BOUNDS_TEST_EVIDENCE, undefined, 'runner context在step作用域使用，不放入job env')
  const node = job.steps.findIndex(s => s.name === 'Node 单元测试'), setup = job.steps.findIndex(s => s.name === '准备 CLI 自有夹具诊断目录')
  assert.ok(setup >= 0 && setup < node)
  for (const index of [setup, node]) assert.equal(job.steps[index].env?.HERMES_BOUNDS_TEST_EVIDENCE, '${{ runner.temp }}/hermes-bounds-ci')
  assert.equal(job.steps[node].run, 'node --test tests/*.test.js')
  assert.equal(job.steps[node]['continue-on-error'], undefined)
  assert.ok(job.steps[setup].run.includes('fs.mkdirSync(process.env.HERMES_BOUNDS_TEST_EVIDENCE'))
  const upload = job.steps.find(s => s.name === '保留 CLI 自有夹具失败现场')
  assert.equal(upload?.uses, 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02')
  assert.equal(upload.if, 'always()')
  assert.equal(upload.with.path, '${{ runner.temp }}/hermes-bounds-ci/bounds-http-report.json')
  assert.equal(upload.with['include-hidden-files'], false)
  assert.equal(upload.with['retention-days'], 7)
  assert.equal(job.steps.find(s => s.name === '安装 Node.js').with['node-version'], '22.22.3')
})
