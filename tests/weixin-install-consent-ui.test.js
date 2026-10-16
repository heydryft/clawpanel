// 失败先行：默认摘要不展示空声明/哈希墙，非空新增能力和风险不可折叠。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}}
test('微信确认摘要中文、技术详情完整且票据永不进入DOM',async()=>{
 const {renderWeixinConsentReview}=await import('../src/pages/channels-weixin-consent.js')
 const ticket=crypto.randomBytes(32).toString('base64url')
 const p={operation:'install',hostVersion:'2026.10.4',confirmationToken:ticket,expiresAt:'2026-10-17T14:05:00.000Z',artifact:{packageName:'@tencent-weixin/openclaw-weixin',version:'2.4.9',url:'https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz',sha256:'a'.repeat(64),integrity:'sha512-fixture'},review:{declared:{channels:['openclaw-weixin'],tools:[]},addedDeclared:{channels:['openclaw-weixin'],tools:['danger<&tool>']},previousDeclared:null,manifestSha256:'b'.repeat(64),reviewToken:'c'.repeat(64),warnings:['network-code: 12 files','environment-access: 2 files','不可隐藏的额外风险'],scan:{findings:[]}}}
 const html=renderWeixinConsentReview(p),summary=html.split('<details')[0],details=html.split('<details')[1]
 assert.ok(!html.includes(ticket),'DOM不得出现随机fixture票据');assert.ok(!summary.includes('sha512-'));assert.ok(!summary.includes('"tools":'))
 for(const text of ['安装','2.4.9','2026.10.4','registry.npmjs.org','消息渠道','微信','danger&lt;&amp;tool&gt;','不可隐藏的额外风险','网络','环境变量','5 分钟'])assert.ok(summary.includes(text),text)
 for(const text of [p.artifact.url,p.artifact.sha256,p.artifact.integrity,p.review.manifestSha256,p.review.reviewToken,'技术详情'])assert.ok(details.includes(text),text)
 assert.ok(!/^\s+open[ >]/.test(details));assert.ok(html.includes('data-weixin-consent-accept'));assert.ok(!html.includes('11px'));assert.ok(!summary.includes('network-code'));assert.ok(!summary.includes('environment-access'))
 const upgrade=renderWeixinConsentReview({...p,operation:'upgrade',review:{...p.review,addedDeclared:{}}})
 assert.ok(upgrade.includes('升级'));assert.ok(upgrade.includes('无新增能力'));assert.ok(!upgrade.includes('Operation: install'))
})

test('手动命令说明保留原生交互确认，不将force当作能力同意或静默加flag',async()=>{
 const {renderWeixinManualConsentHint}=await import('../src/pages/channels-weixin-consent.js')
 const hint=renderWeixinManualConsentHint();assert.ok(hint.includes('交互'));assert.ok(hint.includes('--force'));assert.ok(hint.includes('不代表能力同意'));assert.ok(hint.includes('不自动附加'))
})
