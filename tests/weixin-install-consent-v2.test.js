// 失败先行：10.4只接固定2410，旧host249不变；坏249修复升级仍是单次显式确认。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {buildWeixinCompatibilityStatus,weixinCompatibility,resolveWeixinInstallVersion} from '../scripts/weixin-compat.js'
const load=()=>import('../scripts/weixin-install-consent.js')
const b10=fs.readFileSync(new URL('./weixin-install-consent-2410.tgz',import.meta.url)),b9=fs.readFileSync(new URL('./weixin-install-consent-249.tgz',import.meta.url))
const context={sessionKey:'a'.repeat(64),origin:'http://localhost:1420',valid:()=>true}
const confirm=p=>({operationId:p.operationId,confirmationToken:p.confirmationToken,accepted:true,artifactSha256:p.artifact.sha256,reviewToken:p.review.reviewToken})
async function fixture(t,old=null,changes={}){
 const {createWeixinConsentManager}=await load(),base=fs.realpathSync.native(os.tmpdir()),root=fs.realpathSync.native(fs.mkdtempSync(path.join(base,'weixin-v2-')));t.after(()=>{assert.equal(path.dirname(fs.realpathSync.native(root)),base);fs.rmSync(root,{recursive:true,force:true})})
 const state={hostVersion:'2026.10.4',hostSdk:{supported:true},installed:!!old,installedVersion:old,path:old?path.join(root,'extensions/openclaw-weixin'):null,configIdentity:'config-preserved',cliIdentity:'core104',capabilityMode:'native-cli',previousDeclared:old?{channels:['openclaw-weixin']}:null,...changes},calls=[],downloads=[]
 const manager=createWeixinConsentManager({root,readState:async()=>structuredClone(state),download:async artifact=>{downloads.push(artifact);return artifact?.version==='2.4.10'?b10:b9},run:async args=>{calls.push(args);return {status:0,stdout:'scanner still enabled'}},readback:async review=>({installed:true,version:review.version,enabled:true,sdkLoaded:true,configVerified:true})})
 return {root,state,calls,downloads,manager}
}
test('固定2410 tar及tag源码已核，旧249常量/全部旧断言仍保留',async()=>{
 const {WEIXIN_ARTIFACT,WEIXIN_ARTIFACTS,reviewWeixinArchive}=await load();assert.equal(WEIXIN_ARTIFACT.version,'2.4.9');const a=WEIXIN_ARTIFACTS['2.4.10'];assert.equal(a.sha256,'69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb')
 assert.equal(a.integrity,'sha512-qCN7rFtBK5BO/i5YGEJLdpC/8WQrm0dtPlQ0xNxku4RSyzGaRsiBoLVheU5hgpoOIBvfc5pUwKTktMbROLcIVg==');const r=reviewWeixinArchive(b10,a)
 assert.equal(r.version,'2.4.10');assert.equal(r.fileCount,131);assert.equal(r.unpackedSize,696593);assert.equal(r.manifestSha256,'43957bcf2852862a337f7606a4c352c443e67eda16424a4cd158425768e6b1b8');assert.deepEqual(r.declared.channels,['openclaw-weixin']);assert.equal(r.reviewToken,'4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d')
 assert.equal(reviewWeixinArchive(b9).fileCount,125);assert.throws(()=>reviewWeixinArchive(b9,a));assert.throws(()=>reviewWeixinArchive(b10,WEIXIN_ARTIFACT));assert.ok(r.warnings.length);assert.equal(r.scan.status,'reviewed')
})
test('10.4旧249明确不兼容且可修复升级；2410正常；5.12/9.8继续249',()=>{
 const bad=buildWeixinCompatibilityStatus('2026.10.4','2.4.9');assert.equal(bad.compatible,false);assert.equal(bad.recommendedVersion,'2.4.10');assert.equal(bad.updateAvailable,true);assert.equal(bad.installAllowed,true);assert.match(bad.compatError,/SDK|2026.10.4/)
 assert.equal(weixinCompatibility('v2026.10.4-1-zh.2','2.4.10').compatible,true)
 for(const h of ['2026.5.12','2026.9.8']){assert.equal(resolveWeixinInstallVersion(h),'2.4.9');assert.equal(weixinCompatibility(h,'2.4.9').compatible,true);const newer=buildWeixinCompatibilityStatus(h,'2.4.10');assert.equal(newer.recommendedVersion,null);assert.equal(newer.installAllowed,false);assert.match(newer.installError,/保留|降级/)}
})
test('未来/preview/未知组合不猜，不退回旧插件线',async t=>{
 for(const hostVersion of ['2026.10.5','2026.11.1','2027.1.1','2026.10.4-preview.1','2026.10.4-zh.bad','unknown']){const s=buildWeixinCompatibilityStatus(hostVersion,'2.4.9');assert.equal(s.compatible,null,hostVersion);assert.equal(s.recommendedVersion,null);assert.equal(s.installAllowed,false);const f=await fixture(t,null,{hostVersion});await assert.rejects(f.manager.prepare({operation:'install'},context));assert.equal(f.calls.length,0);assert.equal(f.downloads.length,0)}
})
test('10.4新装只下载审查2410，能力/扫描/版本都由实际回读确认',async t=>{
 const f=await fixture(t),p=await f.manager.prepare({operation:'install'},context);assert.equal(p.protocolVersion,1);assert.equal(p.artifact.version,'2.4.10');assert.equal(f.calls.length,0);assert.equal(f.downloads[0].version,'2.4.10')
 const r=await f.manager.confirm(confirm(p),context);assert.equal(r.ok,true);assert.equal(r.version,'2.4.10');assert.equal(r.readback.sdkLoaded,true);assert.deepEqual(f.calls[0].slice(3),['--force','--accept-capabilities']);await assert.rejects(f.manager.confirm(confirm(p),context),e=>e.code==='WEIXIN_USED')
})
test('249修复升级必须保留身份/单次ticket，错artifact即使reviewToken相同也拒绝',async t=>{
 const f=await fixture(t,'2.4.9'),p=await f.manager.prepare({operation:'upgrade'},context);assert.equal(p.installedVersion,'2.4.9');assert.equal(p.repairingIncompatible,true);assert.equal(p.priorCompatibility.compatible,false);assert.equal(p.artifact.version,'2.4.10');assert.deepEqual(p.review.addedDeclared.channels,[])
 await assert.rejects(f.manager.confirm({...confirm(p),artifactSha256:'467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4'},context),e=>e.code==='WEIXIN_ARTIFACT_CHANGED');assert.equal(f.calls.length,0)
 const r=await f.manager.confirm(confirm(p),context);assert.equal(r.ok,true);assert.equal(r.version,'2.4.10');const audit=fs.readFileSync(path.join(f.root,'.clawpanel-weixin-install/audit.json'),'utf8');assert.ok(audit.includes(p.artifact.sha256));assert.ok(!audit.includes(p.confirmationToken))
})
test('2410 SDK先验只检查固定新temp-path，不插造旧infra-runtime导出',async t=>{
 const {inspectWeixinConsentHostSdk,WEIXIN_ARTIFACTS}=await load(),f=await fixture(t);fs.writeFileSync(path.join(f.root,'sdk.js'),'export {}');fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify({name:'openclaw',version:'2026.10.4',exports:{'./plugin-sdk/temp-path':{default:'./sdk.js'}}}));assert.equal(inspectWeixinConsentHostSdk(f.root,WEIXIN_ARTIFACTS['2.4.10']).supported,true);assert.equal(inspectWeixinConsentHostSdk(f.root).supported,false)
})
test('2410修复确认UI必须明确旧版不兼容，校验固定host/artifact且不显示票据',async t=>{
 globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}}
 const {isWeixinConsentPreparation,renderWeixinConsentReview}=await import('../src/pages/channels-weixin-consent.js'),f=await fixture(t,'2.4.9'),p=await f.manager.prepare({operation:'upgrade'},context)
 assert.equal(isWeixinConsentPreparation(p),true);for(const changed of [{...p,hostVersion:'2026.9.8'},{...p,artifact:{...p.artifact,version:'3.0.0'}},{...p,artifact:{...p.artifact,sha256:'0'.repeat(64)}}])assert.equal(isWeixinConsentPreparation(changed),false)
 const html=renderWeixinConsentReview(p),summary=html.split('<details')[0];assert.ok(summary.includes('修复升级'));assert.ok(summary.includes('2.4.9'));assert.ok(summary.includes('2.4.10'));assert.ok(summary.includes('不兼容'));assert.ok(!html.includes(p.confirmationToken));assert.ok(summary.includes('保留'))
})
