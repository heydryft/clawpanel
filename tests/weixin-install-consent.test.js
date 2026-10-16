// 失败先行：授权绑定、包完整性、解包边界、配额、旧 CLI、真实成功回读及所有旁路。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
const bytes = fs.readFileSync(new URL('./weixin-install-consent-249.tgz',import.meta.url))
const load = () => import('../scripts/weixin-install-consent.js')
const context = (extra={}) => ({sessionKey:'a'.repeat(64),origin:'http://localhost:1420',valid:()=>true,...extra})
async function fixture(t, changes={}) {
 const {createWeixinConsentManager}=await load()
 const parent=fs.realpathSync.native(os.tmpdir()),home=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'weixin-consent-')))
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync.native(home)),parent);fs.rmSync(home,{recursive:true,force:true})})
 const state={hostVersion:'2026.9.8',installedVersion:null,installed:false,path:null,configIdentity:'cfg',cliIdentity:'cli',hostSdk:{supported:true},capabilityMode:'native-cli',previousDeclared:null,...changes}
 const calls=[];let now=100000,valid=true,downloadCalls=0
 const manager=createWeixinConsentManager({root:home,readState:async()=>({...state}),run:async(args)=>{calls.push(args);return {status:0,stdout:'scanner warning retained',stderr:''}},readback:async()=>({installed:true,version:'2.4.9',enabled:true,sdkLoaded:true,configVerified:true}),download:async()=>{downloadCalls++;return bytes},clock:()=>now})
 return {home,state,calls,manager,context:context({valid:()=>valid}),advance:n=>{now+=n},invalidate:()=>{valid=false},downloadCalls:()=>downloadCalls}
}
const confirm = p => ({operationId:p.operationId,confirmationToken:p.confirmationToken,accepted:true,artifactSha256:p.artifact.sha256,reviewToken:p.review.reviewToken})
const error = code => e=>e.code===code

test('只核实9.8/10.4原生与5.12旧CLI，版本和实际help必须同时匹配',async t=>{
 const {resolveWeixinConsentHostMode}=await load()
 for(const host of ['2026.9.8','2026.10.4','v2026.10.4-1-zh.2'])assert.equal(resolveWeixinConsentHostMode(host,'Options: --accept-capabilities'),'native-cli')
 assert.equal(resolveWeixinConsentHostMode('2026.5.12','Options: --force'),'legacy-reviewed')
 for(const host of ['2026.6.1','2026.10.5','2027.1.1','2026.10.4-preview.1','2026.10.4-zh.1+build','unknown']){
  assert.equal(resolveWeixinConsentHostMode(host,'--accept-capabilities'),'unknown')
  const f=await fixture(t,{hostVersion:host});await assert.rejects(f.manager.prepare({operation:'install'},f.context));assert.equal(f.calls.length,0)
 }
 assert.equal(resolveWeixinConsentHostMode('2026.10.4','--force'),'unknown')
 assert.equal(resolveWeixinConsentHostMode('2026.5.12','--accept-capabilities'),'unknown')
})

test('固定官方249真实包静态审查，不运行插件，SRI/manifest/125文件及声明面准确',async()=>{
 const {reviewWeixinArchive,WEIXIN_ARTIFACT}=await load(),r=reviewWeixinArchive(bytes)
 assert.equal(WEIXIN_ARTIFACT.version,'2.4.9');assert.equal(r.fileCount,125)
 assert.equal(r.manifestSha256,'48e1be8ff065494ea9fc58ca8d1333ec60e6d91c51ada182c700ee190638d5cd')
 assert.deepEqual(r.declared.channels,['openclaw-weixin']);assert.deepEqual(r.declared.hooks,[])
 assert.equal(r.reviewToken,'4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d')
 assert.ok(r.warnings.length);assert.equal(r.scan.status,'reviewed')
 for(const b of [Buffer.from('bad'),Buffer.concat([bytes,Buffer.from('x')])])assert.throws(()=>reviewWeixinArchive(b),error('WEIXIN_ARTIFACT_CHANGED'))
})

test('prepare仅下载静态审查；未确认、错误bool和取消均零CLI执行',async t=>{
 const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context)
 assert.equal(p.kind,'weixin-install-consent');assert.equal(p.protocolVersion,1);assert.equal(f.calls.length,0)
 for(const accepted of [false,null,undefined,'true',1])await assert.rejects(f.manager.confirm({...confirm(p),accepted},f.context),error('WEIXIN_CONSENT_REQUIRED'))
 await f.manager.cancel({operationId:p.operationId,confirmationToken:p.confirmationToken},f.context)
 await assert.rejects(f.manager.confirm(confirm(p),f.context),error('WEIXIN_USED'));assert.equal(f.calls.length,0)
})

test('确认只对相同私有artifact一次加accept；成功必须实际readback',async t=>{
 const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context),r=await f.manager.confirm(confirm(p),f.context)
 assert.equal(r.ok,true);assert.equal(r.readback.sdkLoaded,true);assert.equal(f.calls.length,1)
 assert.deepEqual(f.calls[0].slice(0,2),['plugins','install']);assert.ok(f.calls[0][2].startsWith(f.home+path.sep));assert.ok(f.calls[0][2].endsWith('.tgz'))
 // 真实10.4/9.8红灯证明本地归档首次安装也要求显式来源确认；force不是unsafe跳过扫描。
 assert.deepEqual(f.calls[0].slice(3),['--force','--accept-capabilities'])
 await assert.rejects(f.manager.confirm(confirm(p),f.context),error('WEIXIN_USED'));assert.equal(f.calls.length,1)
 assert.ok(!JSON.stringify(fs.readFileSync(path.join(f.home,'.clawpanel-weixin-install','audit.json'),'utf8')).includes(p.confirmationToken))
})

test('foreign session/origin/token、expiry、auth撤销不执行',async t=>{
 const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context)
 for(const ctx of [context({sessionKey:'b'.repeat(64)}),context({origin:'http://foreign.test'}),context({valid:()=>false})])await assert.rejects(f.manager.confirm(confirm(p),ctx))
 await assert.rejects(f.manager.confirm({...confirm(p),confirmationToken:'x'.repeat(43)},f.context))
 assert.equal(f.calls.length,0);f.advance(300001)
 await assert.rejects(f.manager.confirm(confirm(p),f.context),error('WEIXIN_EXPIRED'));assert.equal(f.calls.length,0)
})

test('host/旧安装路径/配置/CLI身份变化及伪造review均拒绝，不自动重下包',async t=>{
 for(const key of ['hostVersion','installedVersion','path','configIdentity','cliIdentity']){
  const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context);f.state[key]='changed'
  await assert.rejects(f.manager.confirm(confirm(p),f.context));assert.equal(f.calls.length,0);assert.equal(f.downloadCalls(),1)
 }
 const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context)
 for(const field of ['artifactSha256','reviewToken'])await assert.rejects(f.manager.confirm({...confirm(p),[field]:'0'.repeat(64)},f.context),error('WEIXIN_ARTIFACT_CHANGED'))
 assert.equal(f.calls.length,0)
})

test('暂存artifact变更或真实链接替换拒绝，未跟随外部目标',async t=>{
 for(const linked of [false,true]){
  const f=await fixture(t),p=await f.manager.prepare({operation:'install'},f.context),base=path.join(f.home,'.clawpanel-weixin-install')
  const dir=fs.readdirSync(base).find(x=>x.startsWith('op-')),artifact=path.join(base,dir,'artifact.tgz')
  if(linked){const foreign=path.join(f.home,'foreign.tgz');fs.writeFileSync(foreign,bytes);fs.unlinkSync(artifact);fs.symlinkSync(foreign,artifact)}else fs.writeFileSync(artifact,'bad')
  await assert.rejects(f.manager.confirm(confirm(p),f.context),error('WEIXIN_ARTIFACT_CHANGED'));assert.equal(f.calls.length,0)
 }
})

test('旧host不传新CLI参数；upgrade仅在已有已核版本时使用force',async t=>{
 const f=await fixture(t,{hostVersion:'2026.5.12',capabilityMode:'legacy-reviewed',installedVersion:'2.4.8',installed:true,path:'/private/old'})
 const p=await f.manager.prepare({operation:'upgrade'},f.context);await f.manager.confirm(confirm(p),f.context)
 assert.deepEqual(f.calls[0].slice(3),['--force']);assert.ok(!f.calls[0].includes('--accept-capabilities'))
 const missing=await fixture(t);await assert.rejects(missing.manager.prepare({operation:'upgrade'},missing.context))
 for(const state of [{hostVersion:'2026.9.8-preview.1'},{installed:true,installedVersion:'3.0.0'},{hostVersion:'2026.6.1',capabilityMode:'unknown'}]){const x=await fixture(t,state);await assert.rejects(x.manager.prepare({operation:'install'},x.context));assert.equal(x.calls.length,0)}
})

test('installer非零或exit0但readback不实，token不恢复且绝不假绿',async t=>{
 const {createWeixinConsentManager}=await load()
 for(const kind of ['exit','version','sdk','config','enabled']){
  const f=await fixture(t);let runs=0
  const manager=createWeixinConsentManager({root:f.home,readState:async()=>({...f.state}),download:async()=>bytes,run:async()=>{runs++;return {status:kind==='exit'?7:0,stdout:'SCAN_BLOCKED',stderr:''}},readback:async()=>({installed:true,version:kind==='version'?'2.4.8':'2.4.9',sdkLoaded:kind!=='sdk',configVerified:kind!=='config',enabled:kind!=='enabled'})})
  const p=await manager.prepare({operation:'install'},f.context)
  await assert.rejects(manager.confirm(confirm(p),f.context));await assert.rejects(manager.confirm(confirm(p),f.context),error('WEIXIN_USED'));assert.equal(runs,1)
 }
})

test('实际安装器扫描输出有界保留且token/authsession脱敏',async t=>{
 const {createWeixinConsentManager}=await load(),f=await fixture(t);let ticket=''
 const m=createWeixinConsentManager({root:f.home,readState:async()=>({...f.state}),download:async()=>bytes,run:async()=>({status:7,stdout:`SCANNER_BLOCKED\nconfirmationToken=${ticket}\nauthSession=private-test-session`,stderr:''}),readback:async()=>({})})
 const p=await m.prepare({operation:'install'},f.context);ticket=p.confirmationToken
 await assert.rejects(m.confirm(confirm(p),f.context))
 const audit=fs.readFileSync(path.join(f.home,'.clawpanel-weixin-install','audit.json'),'utf8')
 assert.ok(audit.includes('SCANNER_BLOCKED'));assert.ok(!audit.includes(ticket));assert.ok(!audit.includes('private-test-session'))
})

test('pending配额与执行并发有界；第二个confirm不并发运行',async t=>{
 const f=await fixture(t);await f.manager.prepare({operation:'install'},f.context);await f.manager.prepare({operation:'install'},f.context)
 await assert.rejects(f.manager.prepare({operation:'install'},f.context),error('WEIXIN_BUSY'))
 const {createWeixinConsentManager}=await load();let release,starts=0
 const x=await fixture(t),m=createWeixinConsentManager({root:x.home,readState:async()=>({...x.state}),download:async()=>bytes,run:()=>{starts++;return new Promise(r=>{release=()=>r({status:7,stderr:'stop'})})},readback:async()=>({})})
 const a=await m.prepare({operation:'install'},x.context),b=await m.prepare({operation:'install'},x.context)
 const running=m.confirm(confirm(a),x.context);while(!release)await new Promise(r=>setTimeout(r,1))
 await assert.rejects(m.confirm(confirm(b),x.context),error('WEIXIN_BUSY'));release();await assert.rejects(running);assert.equal(starts,1)
})

test('Origin/标记/方法严格且旧微信generic别名都识别',async()=>{
 const {validateWeixinRequestOrigin,isWeixinInstallTarget}=await load()
 const req={method:'POST',headers:{host:'localhost:1420',origin:'http://localhost:1420','x-clawpanel-consent':'1','sec-fetch-site':'same-origin'}}
 assert.equal(validateWeixinRequestOrigin(req),'http://localhost:1420')
 for(const change of [{method:'GET'},{headers:{...req.headers,origin:'null'}},{headers:{...req.headers,origin:'http://foreign.test'}},{headers:{...req.headers,'x-clawpanel-consent':undefined}},{headers:{...req.headers,'sec-fetch-site':'cross-site'}}])assert.throws(()=>validateWeixinRequestOrigin({...req,...change}),error('WEIXIN_ORIGIN'))
 for(const a of [{pluginId:'weixin'},{pluginId:'wechat'},{pluginId:'openclaw-weixin'},{packageName:'@tencent-weixin/openclaw-weixin@2.4.9'},{packageName:'x@npm:@tencent-weixin/openclaw-weixin@2.4.9'}])assert.equal(isWeixinInstallTarget(a),true)
 assert.equal(isWeixinInstallTarget({packageName:'other',pluginId:'qqbot'}),false)
})

test('未核压缩包/压缩炸弹、tar路径和链接等低层边界不被包hash掩盖',async()=>{
 const {readBoundedWeixinTar}=await load()
 const tar=(name,type='0',body=Buffer.from('x'))=>{const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write(body.length.toString(8).padStart(11,'0')+'\0',124);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);const sum=h.reduce((n,x)=>n+x,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([h,body,Buffer.alloc((512-body.length%512)%512),Buffer.alloc(1024)])}
 for(const [name,type] of [['../escape','0'],['/absolute','0'],['package/link','2'],['package/hard','1'],['package/a\\b','0'],['package/C:/bad','0']])assert.throws(()=>readBoundedWeixinTar(gzipSync(tar(name,type))))
 assert.throws(()=>readBoundedWeixinTar(gzipSync(Buffer.alloc(5*1024*1024))))
 const good=tar('package/a');assert.equal(readBoundedWeixinTar(gzipSync(good)).files.length,1)
 assert.throws(()=>readBoundedWeixinTar(gzipSync(Buffer.concat([good.subarray(0,1024),good]))))
})

test('manager自身stream/readback异常与审计脱敏，不依赖HTTP二次处理',async t=>{
 const {createWeixinConsentManager}=await load(),f=await fixture(t);let ticket='';const events=[],session='private-session-fixture'
 const m=createWeixinConsentManager({root:f.home,readState:async()=>({...f.state}),download:async()=>bytes,run:async(args,emit)=>{emit({event:'channel-action-log',payload:{message:`ticket ${ticket} authSession=${session}`}});return {status:0}},readback:async()=>{throw Error(`readback ${ticket} authSession=${session}`)}})
 const p=await m.prepare({operation:'install'},f.context);ticket=p.confirmationToken
 await assert.rejects(m.confirm(confirm(p),f.context,event=>events.push(event)),e=>!e.message.includes(ticket)&&!e.message.includes(session))
 const publicEvidence=JSON.stringify(events)+fs.readFileSync(path.join(f.home,'.clawpanel-weixin-install','audit.json'),'utf8')
 assert.ok(!publicEvidence.includes(ticket));assert.ok(!publicEvidence.includes(session))
})

test('真实CLI写入已核meta迁移标记允许，业务配置/未知meta/global allow变化仍拒绝',async()=>{
 const {verifyWeixinConfigReadback}=await load()
 const before={models:{secret:'retained-fixture'},plugins:{entries:{other:{enabled:true}}}}
 const after={...structuredClone(before),plugins:{entries:{other:{enabled:true},'openclaw-weixin':{enabled:true}}},meta:{migrations:{modelPolicyAllowlist:true,utilityModelSeparation:true},lastTouchedVersion:'2026.9.8'}}
 assert.equal(verifyWeixinConfigReadback(before,after,'2026.9.8'),true)
 for(const mutate of [a=>a.models.secret='changed',a=>a.plugins.allow=['*'],a=>a.plugins.entries.other.enabled=false,a=>a.meta.unknown=true,a=>a.meta.lastTouchedVersion='2027.1.1',a=>a.meta.migrations.unknown=true]){const x=structuredClone(after);mutate(x);assert.equal(verifyWeixinConfigReadback(before,x,'2026.9.8'),false)}
 const explicitFalse={meta:{migrations:{modelPolicyAllowlist:false}}};assert.equal(verifyWeixinConfigReadback(explicitFalse,after,'2026.9.8'),false)
 const withOldMeta={...structuredClone(before),meta:{lastTouchedAt:'keep',note:'retain',lastTouchedVersion:'2026.9.8'}}
 assert.equal(verifyWeixinConfigReadback(withOldMeta,{...after,meta:{...after.meta,lastTouchedAt:'keep',note:'retain'}},'2026.9.8'),true)
 assert.equal(verifyWeixinConfigReadback(withOldMeta,after,'2026.9.8'),false)
})

test('真实包manifest SDK先验拒绝10.4缺导出/链接或路径逃逸；不是peer下限推断可用',async t=>{
 const {inspectWeixinConsentHostSdk}=await load(),f=await fixture(t),pkg=path.join(f.home,'core');fs.mkdirSync(pkg);fs.mkdirSync(path.join(pkg,'dist'))
 const manifest={name:'openclaw',version:'2026.9.8',exports:{'./plugin-sdk/infra-runtime':{types:'./missing.d.ts',default:'./dist/infra.js'}}}
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(pkg,'dist','infra.js'),'export {}')
 assert.equal(inspectWeixinConsentHostSdk(pkg).supported,true)
 for(const value of [undefined,'../outside.js','./dist/missing.js',{types:'./dist/infra.js'}]){const x=structuredClone(manifest);x.exports['./plugin-sdk/infra-runtime']=value;fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify(x));assert.equal(inspectWeixinConsentHostSdk(pkg).supported,false)}
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify(manifest));fs.unlinkSync(path.join(pkg,'dist','infra.js'));fs.symlinkSync(path.join(pkg,'package.json'),path.join(pkg,'dist','infra.js'));assert.equal(inspectWeixinConsentHostSdk(pkg).supported,false)
 const blocked=await fixture(t,{hostVersion:'2026.10.4',hostSdk:{supported:false}});await assert.rejects(blocked.manager.prepare({operation:'install'},blocked.context),error('WEIXIN_SDK_UNSUPPORTED'));assert.equal(blocked.downloadCalls(),0);assert.equal(blocked.calls.length,0)
})

test('SDK先验与既有真实manifest入口一致：汉化包同等核验导出，其他包名拒绝',async t=>{
 const {inspectWeixinConsentHostSdk}=await load(),f=await fixture(t);fs.writeFileSync(path.join(f.home,'infra.js'),'export {}')
 for(const name of ['@qingchencloud/openclaw-zh','untrusted-core-name']){fs.writeFileSync(path.join(f.home,'package.json'),JSON.stringify({name,version:'2026.9.8-zh.1',exports:{'./plugin-sdk/infra-runtime':{default:'./infra.js'}}}));assert.equal(inspectWeixinConsentHostSdk(f.home).supported,name==='@qingchencloud/openclaw-zh')}
})
