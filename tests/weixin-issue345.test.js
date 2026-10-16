import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildWeixinCompatibilityStatus, resolveWeixinInstallVersion, weixinCompatibility } from '../scripts/weixin-compat.js'

const policy = JSON.parse(fs.readFileSync(new URL('../src/lib/weixin-compat-policy.json', import.meta.url)))
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/weixin-issue345.json', import.meta.url)))

test('#345 官方249原pin全部保留；10.4另用固定2410，不使用浮动latest', () => {
  assert.equal(policy.reviewedVersion, '2.4.10')
  assert.deepEqual(policy.lines.find(l=>l.target==='2.4.9'), { pluginMin: '2.4.5', pluginMax: '2.4.9', hostMin: '2026.5.12', hostBefore: '2026.10.4', target: '2.4.9', label: 'stable' })
  const original=policy.reviewedPackages['2.4.9']
  assert.equal(original.sourceCommit, '43675b66551d12d6853155a7869a50fb12a18a1e')
  assert.equal(original.peerOpenclaw, '>=2026.5.12')
  assert.equal(original.nodeEngine, '>=22.13.0')
  assert.equal(original.tarballSha256, '467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4')
  assert.equal(policy.reviewedPackage.sourceCommit,'c6643f6f0ac03574eb126f2d69569ea4267cc3c6')
  assert.equal(policy.reviewedPackage.tarballSha256,'69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb')
  assert.equal(policy.reviewedPackage.peerOpenclaw,'>=2026.5.12')
  assert.equal(policy.reviewedPackage.nodeEngine,'>=22.13.0')
})

for (const c of cases) test(`#345 精确状态 ${c.host} / ${c.plugin}`, () => {
  const actual = buildWeixinCompatibilityStatus(c.host, c.plugin)
  for (const key of ['compatible', 'recommendedVersion', 'installAllowed', 'updateAvailable']) assert.deepEqual(actual[key], c[key], key)
  if (c.compatible === true) { assert.equal(actual.compatError, ''); assert.equal(actual.installError, '') }
})

test('#345 未来插件提示只归因插件未核实，保留安装，不误导降级或归因host缺失', () => {
  for (const plugin of ['2.4.10', '3.0.0', '2.4.9-beta.0', '2.4.9-1']) {
    const s = buildWeixinCompatibilityStatus('2026.9.8', plugin)
    assert.match(s.installError, /插件/)
    assert.match(s.installError, /保留|降级/)
    assert.doesNotMatch(s.installError, /未识别 OpenClaw|先安装.*内核/)
    assert.equal(s.recommendedVersion, null)
  }
  assert.match(buildWeixinCompatibilityStatus('unknown', '2.4.9').installError, /OpenClaw.*版本|版本.*OpenClaw/)
  assert.match(weixinCompatibility('2026.9.8', 'invalid-plugin').compatError, /插件/)
})

test('#345 精确安装选择保留两条旧线，下限不足及未核实/浮动版本仍失败', () => {
  assert.equal(resolveWeixinInstallVersion('2026.9.8'), '2.4.9')
  assert.equal(resolveWeixinInstallVersion('2026.5.11'), '2.4.4')
  assert.equal(resolveWeixinInstallVersion('2026.3.21'), '1.0.3')
  assert.throws(() => resolveWeixinInstallVersion('2026.5.11', '2.4.9'), /要求 OpenClaw >=2026.5.12/)
  for (const version of ['latest', 'legacy', '2.4.10', '2.4.9-beta.0', '2.4.9-1']) assert.throws(() => resolveWeixinInstallVersion('2026.9.8', version))
})

test('#345 JS/Rust一致拒绝伪稳定host及超范围数值，不把numeric插件preview视作稳定发行', () => {
  for (const host of ['vv2026.9.8', '+2026.9.8', '2026.9.8-', '999999999999999999999.9.8', '2026.9.8-preview.1']) {
    const actual = buildWeixinCompatibilityStatus(host, '2.4.9')
    assert.equal(actual.compatible, null, host)
    assert.equal(actual.installAllowed, false, host)
  }
  assert.equal(buildWeixinCompatibilityStatus('2026.9.8', '2.4.9-1').compatible, null)
})
