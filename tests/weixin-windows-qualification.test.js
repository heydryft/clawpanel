// 先列资格误绿情形；这里只跑隔离契约，不安装 runtime、不启动 GUI/查询宿主任务。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import vm from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseArgs, runnerProofFailures, validateRunnerProof, HOSTS, REQUIRED_CASES, assertNativeComplete, assertOriginDenial, inspectTarMember, W3C, redact, processObservationSource, assertInstallObservation, assertPreparedTicket, expectedArtifact } from '../scripts/test-weixin-windows-qualification.mjs'

const proof = () => ({ platform:'win32',arch:'x64',runnerEnvironment:'github-hosted',runnerOS:'Windows',event:'workflow_dispatch',ref:'refs/heads/main',repository:'qingchencloud/clawpanel',workflowRef:'qingchencloud/clawpanel/.github/workflows/weixin-qualification.yml@refs/heads/main',workflowSha:'a'.repeat(40),toolingSha:'a'.repeat(40),runId:'1234',attempt:'1',virtualMachine:true,imageOS:'win25',imageVersion:'20261017.1',userName:'runneradmin',sid:'S-1-5-21-123-234-345-1001',actualProfile:'C:\\Users\\runneradmin',registeredProfile:'C:\\Users\\runneradmin' })
test('新 workflow 自己验证完整合取，不把 ref 改写后交老 validator',()=>{
  validateRunnerProof(proof()); assert.deepEqual(runnerProofFailures(proof()),[])
  assert.throws(()=>validateRunnerProof({...proof(),workflowRef:'qingchencloud/clawpanel/.github/workflows/hermes-qualification.yml@refs/heads/main'}))
})
for (const [key,value] of Object.entries({platform:'linux',arch:'arm64',runnerEnvironment:'self-hosted',runnerOS:'Linux',event:'push',ref:'refs/heads/work',repository:'fork/clawpanel',workflowRef:'wrong',workflowSha:'bad',toolingSha:'b'.repeat(40),runId:'',attempt:'',virtualMachine:false,imageOS:'win22',imageVersion:'',userName:'keh5',sid:'S-1-5-18',actualProfile:'D:\\home',registeredProfile:'C:\\Users\\other'})) {
  test(`门禁独立红灯 ${key}`,()=>assert.throws(()=>validateRunnerProof({...proof(),[key]:value})))
}
test('仅完整 SHA / 不接受 shell、浮动 host、默认不执行',()=>{
  assert.deepEqual(parseArgs([]),{})
  assert.throws(()=>parseArgs(['--execute','--sha','main']))
  assert.throws(()=>parseArgs(['--sha','a'.repeat(40),'--sha','b'.repeat(40)]))
  assert.throws(()=>parseArgs(['--host','2026.10.4-beta.1']))
  assert.throws(()=>parseArgs(['--execute','--plan']))
  assert.throws(()=>parseArgs(['--scope','fixture']))
  assert.equal(parseArgs(['--sha','a'.repeat(40),'--host','2026.10.4'])['--host'],'2026.10.4')
  for(const [v,p] of Object.entries(HOSTS)){assert.match(v,/^2026\.(5\.12|9\.8|10\.4)$/);assert.match(p.integrity,/^sha512-/);assert.match(p.manifest,/^[a-f0-9]{64}$/);assert.match(p.entry,/^[a-f0-9]{64}$/)}
})
test('本机 execute 在创建输出/安装/GUI之前拒绝',()=>{
  const r=spawnSync(process.execPath,['scripts/test-weixin-windows-qualification.mjs','--execute','--sha','a'.repeat(40),'--host','2026.10.4','--root','.','--output','DO-NOT-CREATE-WEIXIN'],{encoding:'utf8'})
  assert.notEqual(r.status,0); assert.match(r.stderr,/GitHub|hosted|Windows/); assert.equal(fs.existsSync('DO-NOT-CREATE-WEIXIN'),false)
})
test('无效key/SOP/缺API/超时不能冒充真实 frame ACL拒绝',()=>{
  const valid={frameUrl:'http://127.0.0.1:4321/probe.html',frameOrigin:'http://127.0.0.1:4321',messageOrigin:'http://127.0.0.1:4321',htmlSha256:'a'.repeat(64),sourceMatched:true,validInvokeKey:true,transport:'native-custom-protocol',response:'error',error:'Command prepare_weixin_install not allowed by ACL'}
  assertOriginDenial(valid)
  for(const patch of [{error:'missing __TAURI__'},{error:'invalid invoke key'},{error:'Failed to fetch'},{error:'timeout'},{response:'ok'},{sourceMatched:false},{validInvokeKey:false},{messageOrigin:'https://evil.test'},{htmlSha256:''},{transport:'parent-proxy'}])assert.throws(()=>assertOriginDenial({...valid,...patch}))
  assertOriginDenial({...valid,frameOrigin:'null',messageOrigin:'null',opaque:true})
  assert.throws(()=>assertOriginDenial({...valid,frameOrigin:'null',messageOrigin:'null',opaque:true,allowSameOrigin:true}))
})
test('tar固定位成员校验不接受链接、重复、超限/逃逸',()=>{
  const tar=(name,type='0')=>{const h=Buffer.alloc(512);h.write(name);h.write('00000000001\0',124);h[156]=type.charCodeAt();h.fill(32,148,156);const sum=h.reduce((a,b)=>a+b,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([h,Buffer.from('x'),Buffer.alloc(511),Buffer.alloc(1024)])}
  assert.equal(inspectTarMember(tar('package/package.json'),'package/package.json').toString(),'x')
  for(const b of [tar('package/package.json','2'),tar('../x'),Buffer.alloc(300*1024*1024+1)])assert.throws(()=>inspectTarMember(b,'package/package.json'))
})
const hash='a'.repeat(64)
function fixtureReport(){
  const source={file:{sha256:hash,gitBlob:'b'.repeat(40)}}
  return {status:'pass-native',scope:'complete',executionMode:'actual-github-hosted-windows-vm-weixin',runner:proof(),candidateSha:'c'.repeat(40),hostVersion:'2026.10.4',artifact:expectedArtifact('2026.10.4'),tooling:{sha:proof().toolingSha,before:structuredClone(source),after:structuredClone(source)},source:{sha:'c'.repeat(40),before:structuredClone(source),after:structuredClone(source)},build:{sha:'c'.repeat(40),noBundle:true,exeSha256:hash,dist:{'index.html':hash}},drivers:{tauri:{version:'tauri-driver 2.1.0',sha256:hash},edge:{version:'140.0.1.2',runtimeVersion:'140.0.1.2',sha256:hash}},cases:REQUIRED_CASES.map(id=>({id,status:'passed',evidenceKind:'actual-native',receipts:[hash]})),cleanup:{hostUnchanged:true,processes:[],listeners:[],errors:[],identities:[{pid:111,creationDate:'2026-10-17T00:00:00.000Z'}]},gaps:[],errors:[]}
}
test('完整validator不接受partial、少negative/伪proof/stalehash/失败清理',()=>{
  assertNativeComplete(fixtureReport())
  const changes=[r=>r.artifact=expectedArtifact('2026.9.8'),r=>delete r.artifact,r=>r.scope='ui-origin',r=>r.status='passed-native-ui-origin-partial',r=>r.cases.pop(),r=>r.cases[0].status='skipped',r=>r.cases[0].receipts=[],r=>r.cases[0].evidenceKind='fixture',r=>r.runner.workflowRef='wrong',r=>r.source.sha='d'.repeat(40),r=>r.tooling.after.file.sha256='e'.repeat(64),r=>r.build.exeSha256='',r=>r.build.dist={},r=>r.drivers.edge.runtimeVersion='141.0.0.1',r=>r.cleanup.identities=[],r=>r.cleanup.processes=[{pid:111}],r=>r.gaps=['wrong-window NOT RUN'],r=>r.errors=['scannerfailed']]
  for(const change of changes){const r=fixtureReport();change(r);assert.throws(()=>assertNativeComplete(r))}
})
test('W3C失败响应不吞、trace脱敏不保存票据/key',async()=>{
  const c=new W3C('http://127.0.0.1:1')
  assert.throws(()=>new W3C('https://remote.test'))
  await assert.rejects(c.request('GET','/status',undefined,1000))
  const x=redact({confirmationToken:'secret',headers:{'Tauri-Invoke-Key':'native-key'},nested:{password:'p'},error:'WEIXIN_USED'})
  assert.equal(x.confirmationToken,'[REDACTED]');assert.equal(x.headers['Tauri-Invoke-Key'],'[REDACTED]');assert.equal(x.error,'WEIXIN_USED')
})
test('观察脚本排除控制器自身，不接受空PID/CreationDate替清理证据',()=>{
  const source=processObservationSource('C:\\private',[1234],[],9911)
  assert.match(source,/ProcessId -ne 9911/);assert.match(source,/ProcessId -ne \$PID/);assert.match(source,/CreationDate/);assert.match(source,/commandLine/)
})
test('必须观察真实private CLI安装命令，legacy不可新flag，现代必须两确认flag',()=>{
  const row={pid:77,creationDate:'2026-10-17T00:00:00Z',commandLine:'node C:\\private\\openclaw.mjs plugins install C:\\private\\artifact.tgz'}
  assertInstallObservation([row],'2026.5.12','C:\\private')
  assert.throws(()=>assertInstallObservation([],'2026.5.12','C:\\private'))
  assert.throws(()=>assertInstallObservation([{...row,commandLine:row.commandLine+' --accept-capabilities'}],'2026.5.12','C:\\private'))
  assert.throws(()=>assertInstallObservation([row],'2026.10.4','C:\\private'))
  assertInstallObservation([{...row,commandLine:row.commandLine+' --force --accept-capabilities'}],'2026.10.4','C:\\private')
  assert.throws(()=>assertInstallObservation([{...row,creationDate:null}],'2026.5.12','C:\\private'))
})
test('UI准备结果必须固定artifact/review/host并真实有效，不能只看modal存在',()=>{
 const p={protocolVersion:1,kind:'weixin-install-consent',operationId:'b38b0908-08bc-41f9-a46b-dd58dd04d390',confirmationToken:'x'.repeat(43),expiresAt:new Date(Date.now()+300000).toISOString(),hostVersion:'2026.10.4',capabilityMode:'native-cli',artifact:expectedArtifact('2026.10.4'),repairingIncompatible:false,priorCompatibility:{compatible:null,compatError:''},review:{manifestSha256:expectedArtifact('2026.10.4').manifestSha256,declared:{channels:['openclaw-weixin'],providers:[],tools:[],contracts:[],hooks:[],mcpServers:[],cliCommands:[],cliBackends:[],skills:[],dangerousConfigFlags:[]},reviewToken:'4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d'}}
 assertPreparedTicket(p,'2026.10.4')
 for(const change of [x=>x.hostVersion='2026.9.8',x=>x.artifact.sha256='0'.repeat(64),x=>x.review.reviewToken='bad',x=>x.expiresAt='2000-01-01',x=>x.capabilityMode='legacy-reviewed']){const q=structuredClone(p);change(q);assert.throws(()=>assertPreparedTicket(q,'2026.10.4'))}
})
test('隔离真实HTTP W3C收据：create/click/error/delete；不算native GUI',async()=>{
 const seen=[];const server=http.createServer((req,res)=>{let data='';req.on('data',b=>data+=b);req.on('end',()=>{seen.push({method:req.method,url:req.url,body:data?JSON.parse(data):null});res.setHeader('content-type','application/json');if(req.url==='/session')res.end(JSON.stringify({value:{sessionId:'fixture-session'}}));else if(req.url.endsWith('/element'))res.end(JSON.stringify({value:{'element-6066-11e4-a52e-4f735466cecf':'fixture-element'}}));else if(req.url.endsWith('/execute/sync')){res.statusCode=500;res.end(JSON.stringify({value:{error:'javascript error',message:'fixture native rejection'}}))}else res.end(JSON.stringify({value:null}))})})
 await new Promise(r=>server.listen(0,'127.0.0.1',r));try{const c=new W3C('http://127.0.0.1:'+server.address().port);await c.create('fixture.exe');await c.click('[data-weixin-consent-accept]');await assert.rejects(c.script('throw Error()'),/fixture native rejection/);await c.close();assert.ok(seen.some(x=>x.url.endsWith('/fixture-element/click')));assert.ok(seen.some(x=>x.method==='DELETE'));assert.ok(c.events.every(e=>!Object.hasOwn(e,'body')))}finally{await new Promise(r=>server.close(r))}
})
test('workflow仅main手工canonical、精确SHA经环境输入、readonly/无持久凭据',()=>{
  const w=fs.readFileSync(new URL('../.github/workflows/weixin-qualification.yml',import.meta.url),'utf8')
  assert.match(w,/workflow_dispatch:/);assert.match(w,/contents: read/);assert.match(w,/refs\/heads\/main/);assert.match(w,/github\.repository == 'qingchencloud\/clawpanel'/);assert.match(w,/runs-on: windows-2025/)
  assert.equal((w.match(/persist-credentials: false/g)||[]).length,2);assert.doesNotMatch(w,/pull_request_target|contents: write|secrets\.|self-hosted/)
  assert.match(w,/CANDIDATE_SHA: \$\{\{ inputs.candidate_sha \}\}/);assert.doesNotMatch(w,/--sha ['"]?\$\{\{/)
})
test('所有嵌入的WebDriver脚本逐个经真实V8 parser，不能只node --check外层mjs',()=>{
 const source=fs.readFileSync(new URL('../scripts/test-weixin-windows-qualification.mjs',import.meta.url),'utf8')
 const literals=[...source.matchAll(/(?:\.script\(|script:)\s*(String\.raw`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g)]
 assert.ok(literals.length>=16,'注入脚本提取覆盖意外减少')
 for(const m of literals){const script=vm.runInNewContext('('+m[1]+')');assert.equal(typeof script,'string');assert.doesNotThrow(()=>new vm.Script('(function(){\n'+script+'\n})'),`注入JS@${source.slice(0,m.index).split('\n').length}`)}
})
test('运行时完整脚本清单包含audit/HTML；动态脚本也在native发送前解析',async()=>{
 const {injectionScripts,validateInjectionSyntax}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const rows=injectionScripts();assert.ok(rows.length>=18);assert.ok(rows.some(x=>x.name==='audit'));assert.ok(rows.some(x=>x.name==='untrusted-frame-html'));validateInjectionSyntax()
 const c=new W3C('http://127.0.0.1:1');c.session='fixture';await assert.rejects(c.script('function(}'),/injected JS syntax|Unexpected/);assert.equal(c.events.length,0)
})

test('v2原生host精确选择两份独立artifact，同一reviewToken不能混用',async()=>{
 const {expectedArtifact}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const legacy=expectedArtifact('2026.5.12'),modern=expectedArtifact('2026.10.4')
 assert.equal(legacy.version,'2.4.9');assert.deepEqual(legacy,expectedArtifact('2026.9.8'));assert.equal(modern.version,'2.4.10');assert.equal(legacy.reviewToken,modern.reviewToken);assert.notEqual(legacy.sha256,modern.sha256);assert.notEqual(legacy.manifestSha256,modern.manifestSha256);assert.equal(modern.fileCount,131)
 for(const v of ['2026.10.5','2026.10.4-beta.1','2026.9.8-zh.bad','2026.9.8-zh.1-beta.1','latest',''])assert.throws(()=>expectedArtifact(v))
})

test('现代SDK回读不依赖已废弃installs，但任何矛盾/重复/未loaded必须红',async()=>{
 const {assertSdkReadback}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const status={installed:true,installedVersion:'2.4.10',extensionDir:'C:\\private\\ext'},cfg={plugins:{entries:{'openclaw-weixin':{enabled:true}}}},inventory={plugins:[{id:'openclaw-weixin',version:'2.4.10',status:'loaded',enabled:true,rootDir:status.extensionDir,channelIds:['openclaw-weixin']}]}
 assert.equal(assertSdkReadback(status,cfg,inventory,'2026.10.4'),status.extensionDir)
 const changes=[x=>x.s.installedVersion='2.4.9',x=>x.s.installed=false,x=>x.s.extensionDir='',x=>x.i.plugins.push({...x.i.plugins[0]}),x=>x.i.plugins[0].rootDir='C:\\foreign',x=>x.i.plugins[0].status='error',x=>x.i.plugins[0].enabled=false,x=>x.i.plugins[0].channelIds=[],x=>x.i.plugins[0].channelIds='openclaw-weixin',x=>x.i.plugins[0].dependencyStatus={requiredInstalled:false},x=>x.i.plugins[0].dependencyStatus={missing:['sdk']},x=>x.c.plugins.entries['openclaw-weixin'].enabled=false,x=>x.c.plugins.installs=null,x=>x.c.plugins.installs={'openclaw-weixin':{version:'2.4.9',installPath:status.extensionDir}},x=>x.c.plugins.installs={'openclaw-weixin':{version:'2.4.10',installPath:'C:\\foreign'}}]
 for(const change of changes){const x={s:structuredClone(status),c:structuredClone(cfg),i:structuredClone(inventory)};change(x);assert.throws(()=>assertSdkReadback(x.s,x.c,x.i,'2026.10.4'))}
})

test('窗口surface只能凭源码及真实枚举证明不可达，不把拒绝create当wrong-window通过',async()=>{
 const {assessWindowSurface}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const config={app:{windows:[{title:'ClawPanel'}]}},capabilities=[{windows:['main'],permissions:['core:default']}],source={'src/lib.js':'console.log(1)','src-tauri/src/tray.rs':'app.get_webview_window("main");'}
 const p=assessWindowSurface(config,capabilities,source,{windows:['main'],webviews:['main'],handles:['0']});assert.equal(p.status,'unreachable-existing-surface');assert.equal(p.negativeExecuted,false)
 for(const patch of [{windows:[],webviews:['main'],handles:['0']},{windows:['main'],webviews:['main','other'],handles:['0']},{windows:['main'],webviews:['main'],handles:['0','1']}])assert.throws(()=>assessWindowSurface(config,capabilities,source,patch))
 assert.throws(()=>assessWindowSurface(config,capabilities,{...source,'src-tauri/src/new.rs':'WebviewWindowBuilder::new(app,"secondary")'},{windows:['main'],webviews:['main'],handles:['0']}))
 assert.throws(()=>assessWindowSurface(config,[{windows:['main'],permissions:['core:webview:allow-create-webview-window']}],source,{windows:['main'],webviews:['main'],handles:['0']}))
})

test('实际执行私有operator policy协议：精确归档/manifest/host才记录block，坏来源不得算scanner绿',async()=>{
 const {makeInstallPolicyProgram,assertPolicyDenial}=await import('../scripts/test-weixin-windows-qualification.mjs')
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'weixin-policy-contract-'))),artifact=expectedArtifact('2026.10.4'),sha=b=>crypto.createHash('sha256').update(b).digest('hex')
 try{
  const source=path.join(root,'source');fs.mkdirSync(source);const manifest=Buffer.from('{"id":"fixture"}'),archive=Buffer.from('fixture-not-vendor');fs.writeFileSync(path.join(source,'openclaw.plugin.json'),manifest);const tgz=path.join(root,'artifact.tgz');fs.writeFileSync(tgz,archive);const file=path.join(root,'receipt.json'),nonce='7'.repeat(32),program=makeInstallPolicyProgram({root,receiptFile:file,nonce,host:'2026.10.4',artifact:{...artifact,sha256:sha(archive),manifestSha256:sha(manifest)}});new vm.Script(program)
  const request={protocolVersion:1,openclawVersion:'2026.10.4',targetType:'plugin',targetName:'openclaw-weixin',sourcePath:source,sourcePathKind:'directory',request:{kind:'plugin-archive',mode:'install',requestedSpecifier:tgz},plugin:{pluginId:'openclaw-weixin',packageName:artifact.packageName,version:artifact.version}}
  const r=spawnSync(process.execPath,['-e',program],{input:JSON.stringify(request),encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{protocolVersion:1,decision:'block',reason:'clawpanel-native-policy-'+nonce});const receipt=JSON.parse(fs.readFileSync(file));assert.equal(receipt.nonce,nonce);assert.equal(receipt.artifactSha256,sha(archive));assert.equal(receipt.manifestSha256,sha(manifest))
  const valid={r:{ok:false,error:'WEIXIN_INSTALL_FAILED: CLI 1: Install blocked by policy\n\n  Plugin: openclaw-weixin\n  Reason: clawpanel-native-policy-'+nonce},receipt,nonce,artifact:{...artifact,sha256:sha(archive),manifestSha256:sha(manifest)},host:'2026.10.4',progress:'0%',log:'Install blocked by policy\n\n  Plugin: openclaw-weixin\n  Reason: clawpanel-native-policy-'+nonce,before:{config:'x',files:{}},after:{config:'x',files:{}},replay:{ok:false,error:'WEIXIN_USED'}};assertPolicyDenial(valid)
  for(const patch of [{r:{ok:true}},{r:{ok:false,error:'WEIXIN_HOST_CHANGED'}},{r:{ok:false,error:'WEIXIN_INSTALL_FAILED: clawpanel-native-policy-'+nonce}},{progress:'100%'},{log:''},{receipt:{...receipt,nonce:'forged'}},{after:{config:'changed'}},{replay:{ok:true}}])assert.throws(()=>assertPolicyDenial({...valid,...patch}))
  fs.unlinkSync(file)
  for(const patch of [{openclawVersion:'2026.9.8'},{sourcePath:os.tmpdir()},{request:{kind:'plugin-npm',mode:'install',requestedSpecifier:'remote'}},{plugin:{...request.plugin,version:'2.4.9'}}]){const bad=spawnSync(process.execPath,['-e',program],{input:JSON.stringify({...request,...patch}),encoding:'utf8',timeout:5000});assert.notEqual(bad.status,0);assert.equal(fs.existsSync(file),false)}
 }finally{assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})}
})
