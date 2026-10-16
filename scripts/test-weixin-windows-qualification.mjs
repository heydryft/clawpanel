#!/usr/bin/env node
// 可信 main 手工 VM 侧车；不修改产品/权限，不把隔离测试或阶段报告补成 native 完整资格。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import vm from 'node:vm'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tooling=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const hash=f=>sha(fs.readFileSync(f))
const exactSha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)
const validHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const privateSecrets=new Set()
const CRATE_METADATA_URL='https://crates.io/api/v1/crates/tauri-driver/2.1.0'
const CRATE_API_HEADERS=Object.freeze({'User-Agent':'ClawPanel-Weixin-Native-Qualification/1.0 (https://github.com/qingchencloud/clawpanel)','Accept':'application/json'})
const TAURI_CRATE_CHECKSUM='2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953'
const TAURI_SOURCE_PINS=Object.freeze({'Cargo.toml':'b30161d77b195300c06d5b461907134e640f9c8ca84284d7de421bb5920fa3ed','src/cli.rs':'d08a622c036becf29cad6cbcae5974ae630005354370f7605582f68bf2709a7c','src/server.rs':'4670240b353c3430ecf5c5a6192e9107952ec5bd4eea97ee24bfb2564746fdfa'})
const TAURI_HELP='USAGE: tauri-driver [FLAGS] [OPTIONS]\n\nFLAGS:\n  -h, --help              Prints help information\n\nOPTIONS:\n  --port NUMBER           Sets the tauri-driver intermediary port\n  --native-port NUMBER    Sets the port of the underlying WebDriver\n  --native-host HOST      Sets the host of the underlying WebDriver (Linux only)\n  --native-driver PATH    Sets the path to the native WebDriver binary'
const wait=ms=>new Promise(r=>setTimeout(r,ms))
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''))
const inside=(root,file)=>{const r=path.relative(root,file);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r)}
export const HOSTS=Object.freeze({
 '2026.5.12':Object.freeze({integrity:'sha512-hHg88OFSF0rhDNUbmjMEJO0UdnGn4mNq0F23Hk/NmTKY3OaPCUXiHutd8Ea6S5TGouponytMMWCYgPRrwsW2Xg==',manifest:'84cb48b639a69a10703eb9d24c612f8f4780f73163dc09927309a6e0026968f2',entry:'ee861ae6f3298a0c2062ff52a682b5ce4786ae515a3eb816921f9a128341c733',accept:false}),
 '2026.9.8':Object.freeze({integrity:'sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==',manifest:'d2e734563bfb126d273beeb1e2cc5d4525b4d59efe00fdfec50a39b427524f56',entry:'aa8606ca0d62ff133ef5b7bd2323ec8ff3f8eb384404399cd5e742918d63b0a1',accept:true}),
 '2026.10.4':Object.freeze({integrity:'sha512-+FH0StZF1tlTazM7JJGY6JePeJmhFNSRByi2Q3jXPRiLO7o4dJh2xa9Vy4Dk8Cd2ic8B7Zkf5NfEaCCWUkgqnQ==',manifest:'1ef9c6031d4789c57f1d7632d0b1c149d31e194b2a9441d93dcfc0010d8d74f6',entry:'aa8606ca0d62ff133ef5b7bd2323ec8ff3f8eb384404399cd5e742918d63b0a1',accept:true}),
})
const REVIEW_TOKEN='4a6ad49339885fb96a4109d552d1cb3c87838ec519726805888d8cadd73d696d'
const ARTIFACTS=Object.freeze({
 '2.4.9':Object.freeze({packageName:'@tencent-weixin/openclaw-weixin',version:'2.4.9',url:'https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz',sha256:'467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4',integrity:'sha512-SfaYehR1Cwq2VV5HxJBp9sVilMms420VfZlMbF4YjRbWomr5+GxfXp9HkeU6y5TbnOc4Ysq0qPw1yBvJwbenBA==',manifestSha256:'48e1be8ff065494ea9fc58ca8d1333ec60e6d91c51ada182c700ee190638d5cd',fileCount:125,unpackedSize:696653,compressedSize:172146,sdkSubpath:'openclaw/plugin-sdk/infra-runtime',sourceCommit:'43675b66551d12d6853155a7869a50fb12a18a1e',reviewToken:REVIEW_TOKEN}),
 '2.4.10':Object.freeze({packageName:'@tencent-weixin/openclaw-weixin',version:'2.4.10',url:'https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.10.tgz',sha256:'69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb',integrity:'sha512-qCN7rFtBK5BO/i5YGEJLdpC/8WQrm0dtPlQ0xNxku4RSyzGaRsiBoLVheU5hgpoOIBvfc5pUwKTktMbROLcIVg==',manifestSha256:'43957bcf2852862a337f7606a4c352c443e67eda16424a4cd158425768e6b1b8',fileCount:131,unpackedSize:696593,compressedSize:172518,sdkSubpath:'openclaw/plugin-sdk/temp-path',sourceCommit:'c6643f6f0ac03574eb126f2d69569ea4267cc3c6',reviewToken:REVIEW_TOKEN}),
})
export function expectedArtifact(version){assert.ok(Object.hasOwn(HOSTS,version),'未审查的精确官方host');return ARTIFACTS[version==='2026.10.4'?'2.4.10':'2.4.9']}
export const REQUIRED_CASES=Object.freeze(['prepare-ui-unchecked','cancel-ui','accepted-false','artifact-change','review-change','wrong-host','generic-aliases','remote-iframe','opaque-iframe','subframe-valid-ticket','explicit-ui-install-sdk','one-use-replay','unknown-top-origin','wrong-window','scanner-failure'])
const PHASE_CASES=REQUIRED_CASES.filter(k=>!['wrong-window','scanner-failure'].includes(k))
export function parseArgs(args){
 const o={},values=new Set(['--root','--sha','--host','--output','--scope'])
 for(let i=0;i<args.length;i++){const k=args[i];assert.ok(!Object.hasOwn(o,k),'重复参数');if(['--execute','--plan'].includes(k))o[k]=true;else{assert.ok(values.has(k)&&args[i+1]&&!args[i+1].startsWith('--'),'未知或缺值参数');o[k]=args[++i]}}
 if(o['--sha'])assert.ok(exactSha(o['--sha']),'SHA 必须完整40位')
 if(o['--host'])assert.ok(Object.hasOwn(HOSTS,o['--host']),'仅固定官方5.12/9.8/10.4')
 if(o['--scope'])assert.ok(['complete','ui-origin'].includes(o['--scope']),'scope无效')
 assert.ok(!(o['--execute']&&o['--plan']),'模式互斥');return o
}
export function runnerProofFailures(p={}){
 // 完整复制合取语义，但用本 workflow 精确身份；从不改写 proof 去通过 Hermes 门禁。
 const c={platform:p.platform==='win32',architecture:p.arch==='x64','runner-environment':p.runnerEnvironment==='github-hosted','runner-os':p.runnerOS==='Windows',event:p.event==='workflow_dispatch','main-ref':p.ref==='refs/heads/main',repository:p.repository==='qingchencloud/clawpanel','workflow-ref':p.workflowRef==='qingchencloud/clawpanel/.github/workflows/weixin-qualification.yml@refs/heads/main','workflow-sha-format':exactSha(p.workflowSha),'workflow-sha-match':p.workflowSha===p.toolingSha,'run-id':/^\d+$/.test(p.runId||''),'run-attempt':/^\d+$/.test(p.attempt||''),'virtual-machine':p.virtualMachine===true,'image-os':['win25','win25-vs2026'].includes(p.imageOS),'image-version':!!p.imageVersion,'user-name':p.userName?.toLowerCase()==='runneradmin','sid-format':/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(p.sid||''),'actual-profile':/^[a-z]:\\Users\\runneradmin$/i.test(p.actualProfile||''),'profile-registration':p.actualProfile?.toLowerCase()===p.registeredProfile?.toLowerCase()}
 return Object.entries(c).filter(([,v])=>!v).map(([k])=>k)
}
export function validateRunnerProof(p){const f=runnerProofFailures(p);assert.equal(f.length,0,'Windows GitHub-hosted main/VM/SID/ProfileList门禁失败: '+f.join(','))}
export function redact(v){
 if(Array.isArray(v))return v.map(redact)
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/confirmationToken|invoke.?key|authorization|cookie|password|secret|^token$/i.test(k)?'[REDACTED]':redact(x)]))
 if(typeof v==='string'){for(const secret of privateSecrets)v=v.replaceAll(secret,'[REDACTED]');return v.replace(/((?:confirmationToken|Tauri-Invoke-Key|api[_-]?key|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi,'$1[REDACTED]')}
 return v
}
export function assertOriginDenial(p){
 assert.ok(p&&validHash(p.htmlSha256)&&p.sourceMatched===true&&p.validInvokeKey===true&&p.transport==='native-custom-protocol','无真实 frame/native transport 证明')
 assert.equal(p.messageOrigin,p.frameOrigin,'frame消息来源不符')
 assert.equal(p.response,'error','不可信来源 native invoke 成功')
 assert.match(p.error||'',/not allowed by ACL|not allowed from remote context|WEIXIN_ORIGIN|Origin header is not a valid URL|missing Origin header/,'不是可归因来源拒绝')
 assert.ok(!p.allowSameOrigin,'opaque探针不放宽sandbox')
 if(p.opaque)assert.equal(p.frameOrigin,'null');else assert.equal(new URL(p.frameUrl).origin,p.frameOrigin)
}
export function assertPreparedTicket(p,version){
 const a=expectedArtifact(version)
 assert.equal(p.kind,'weixin-install-consent');assert.equal(p.protocolVersion,1);assert.equal(p.hostVersion,version);assert.equal(p.capabilityMode,HOSTS[version].accept?'native-cli':'legacy-reviewed');assert.match(p.operationId||'',/^[a-f0-9-]{36}$/);assert.match(p.confirmationToken||'',/^[A-Za-z0-9_-]{43}$/);assert.ok(Date.parse(p.expiresAt)>Date.now())
 for(const [key,value]of Object.entries(a))if(key!=='reviewToken')assert.equal(p.artifact[key],value,'prepare artifact '+key)
 assert.equal(p.review.reviewToken,a.reviewToken);assert.equal(p.review.manifestSha256,a.manifestSha256)
 assert.deepEqual(p.review.declared,{channels:['openclaw-weixin'],providers:[],tools:[],contracts:[],hooks:[],mcpServers:[],cliCommands:[],cliBackends:[],skills:[],dangerousConfigFlags:[]})
 assert.equal(typeof p.repairingIncompatible,'boolean');assert.ok(p.priorCompatibility&&[true,false,null].includes(p.priorCompatibility.compatible));assert.equal(typeof p.priorCompatibility.compatError,'string')
}
export function assertSdkReadback(status,config,inventory,host){
 const a=expectedArtifact(host),root=status?.extensionDir,match=p=>typeof p==='string'&&path.win32.isAbsolute(p)&&path.win32.normalize(p).toLowerCase()===path.win32.normalize(root).toLowerCase()
 assert.equal(status?.installed,true);assert.equal(status.installedVersion,a.version);assert.ok(typeof root==='string'&&root&&path.win32.isAbsolute(root),'SDK路径缺失')
 assert.ok(Array.isArray(inventory?.plugins));const rows=inventory.plugins.filter(p=>p.id==='openclaw-weixin');assert.equal(rows.length,1);const p=rows[0]
 assert.equal(p.version,a.version);assert.equal(p.status,'loaded');assert.equal(p.enabled,true);assert.ok(match(p.rootDir));assert.ok(Array.isArray(p.channelIds)&&p.channelIds.includes('openclaw-weixin'));assert.notEqual(p.dependencyStatus?.requiredInstalled,false);assert.ok(p.dependencyStatus?.missing===undefined||Array.isArray(p.dependencyStatus.missing)&&p.dependencyStatus.missing.length===0)
 assert.equal(config?.plugins?.entries?.['openclaw-weixin']?.enabled,true)
 if(Object.hasOwn(config.plugins,'installs')){const installs=config.plugins.installs;assert.ok(installs&&typeof installs==='object'&&!Array.isArray(installs));if(Object.hasOwn(installs,'openclaw-weixin')){assert.equal(installs['openclaw-weixin']?.version,a.version);assert.ok(match(installs['openclaw-weixin']?.installPath))}}
 return root
}
export function assessWindowSurface(config,capabilities,sources,actual){
 assert.ok(Array.isArray(config?.app?.windows)&&config.app.windows.length===1);assert.equal(config.app.windows[0].label||'main','main')
 assert.ok(capabilities.length&&capabilities.every(c=>JSON.stringify(c.windows)===JSON.stringify(['main'])&&!c.remote&&!c.permissions.some(p=>/allow-create-|allow-add-child/.test(typeof p==='string'?p:p.identifier))))
 const creation=/WebviewWindowBuilder|WebviewBuilder|WindowBuilder|new\s+WebviewWindow|createWebviewWindow|create_webview_window|\.add_child\s*\(/
 assert.ok(Object.keys(sources).length);for(const [name,text]of Object.entries(sources))assert.ok(!creation.test(text),'未审计的窗口创建入口 '+name)
 assert.deepEqual(actual.windows,['main']);assert.deepEqual(actual.webviews,['main']);assert.ok(Array.isArray(actual.handles)&&actual.handles.length===1&&actual.handles[0])
 return {status:'unreachable-existing-surface',negativeExecuted:false,actual,sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(Buffer.from(v))])),reason:'仅main窗口的配置/全部产品创建入口扫描与实际window+webview+W3C枚举一致；未创建窗口或扩大capability；不是wrong-window命令拒绝证明'}
}
export function makeInstallPolicyProgram({root,receiptFile,nonce,host,artifact}){
 assert.ok(/^[a-f0-9]{32}$/.test(nonce)&&inside(physical(root),physical(receiptFile)));assert.ok(Object.hasOwn(HOSTS,host)&&validHash(artifact.sha256)&&validHash(artifact.manifestSha256))
 // 这是操作者提供给上游 security.installPolicy 的真实拒绝程序，不替换 vendor/CLI/scanner。
 // 输入不符则直接失败，绝不把另一来源/版本或权限失败写成预期 block 收据。
 return `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const p=${JSON.stringify({root,receiptFile,nonce,host,artifact})},chunks=[];let size=0;const timer=setTimeout(()=>process.exit(2),5000);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function privatePath(v){assert.equal(typeof v,'string');const file=path.resolve(v),rel=path.relative(p.root,file);assert.ok(path.isAbsolute(v)&&rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));for(let q=file;;q=path.dirname(q)){assert.ok(!fs.lstatSync(q).isSymbolicLink());if(q===p.root)break;assert.notEqual(path.dirname(q),q)}assert.equal(fs.realpathSync.native(file).toLowerCase(),file.toLowerCase());return file}
process.stdin.on('data',b=>{size+=b.length;if(size>262144)process.exit(2);chunks.push(b)});process.stdin.on('end',()=>{try{
 const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));assert.equal(request.protocolVersion,1);assert.equal(request.openclawVersion,p.host);assert.equal(request.targetType,'plugin');assert.equal(request.targetName,'openclaw-weixin');assert.equal(request.sourcePathKind,'directory');assert.equal(request.request.kind,'plugin-archive');assert.equal(request.request.mode,'install');assert.equal(request.plugin.pluginId,'openclaw-weixin');assert.equal(request.plugin.packageName,p.artifact.packageName);assert.equal(request.plugin.version,p.artifact.version);
 const source=privatePath(request.sourcePath),archive=privatePath(request.request.requestedSpecifier),manifest=privatePath(path.join(source,'openclaw.plugin.json'));assert.ok(fs.statSync(archive).size<=1048576&&fs.statSync(manifest).size<=1048576);const artifactSha256=hash(fs.readFileSync(archive)),manifestSha256=hash(fs.readFileSync(manifest));assert.equal(artifactSha256,p.artifact.sha256);assert.equal(manifestSha256,p.artifact.manifestSha256);
 fs.writeFileSync(p.receiptFile,JSON.stringify({kind:'upstream-operator-install-policy-block',nonce:p.nonce,request,artifactSha256,manifestSha256,pid:process.pid,at:new Date().toISOString()}),{flag:'wx'});process.stdout.write(JSON.stringify({protocolVersion:1,decision:'block',reason:'clawpanel-native-policy-'+p.nonce}));clearTimeout(timer)
 }catch(e){process.stderr.write('native qualification policy input mismatch: '+e.message);clearTimeout(timer);process.exitCode=2}});`
}
export function assertPolicyDenial(p){
 const marker='clawpanel-native-policy-'+p.nonce
 assert.equal(p.r?.ok,false);assert.match(p.r.error,/WEIXIN_INSTALL_FAILED/);assert.match(p.r.error,new RegExp('Install blocked by policy\\s+Plugin: openclaw-weixin\\s+Reason: '+marker),'不是固定上游CLI格式的预期策略拒绝')
 assert.equal(p.receipt?.kind,'upstream-operator-install-policy-block');assert.equal(p.receipt.nonce,p.nonce);assert.equal(p.receipt.artifactSha256,p.artifact.sha256);assert.equal(p.receipt.manifestSha256,p.artifact.manifestSha256);assert.equal(p.receipt.request?.openclawVersion,p.host);assert.equal(p.receipt.request?.plugin?.version,p.artifact.version)
 assert.notEqual(p.progress,'100%');assert.ok(p.log?.includes(marker),'UI未显示真实策略拒绝');assert.deepEqual(p.after,p.before,'拒绝后插件/config发生安装变化');assert.equal(p.replay?.ok,false);assert.match(p.replay.error,/WEIXIN_USED/)
}
export function assertInstallObservation(rows,version,home){
 const installs=rows.filter(p=>/\bplugins\s+install\b/.test(p.commandLine||''));assert.ok(installs.length,'没有真实CLI安装argv观察')
 for(const p of installs){assert.ok(Number.isInteger(p.pid)&&p.pid>0&&Number.isFinite(Date.parse(p.creationDate)),'安装观察缺PID/CreationDate');assert.ok(p.commandLine.toLowerCase().includes(home.toLowerCase())&&/\.tgz(?:\b|["'])/.test(p.commandLine),'安装源不是私有固定归档');assert.equal(/--accept-capabilities\b/.test(p.commandLine),HOSTS[version].accept,'legacy/modern参数不符');assert.equal(/--force\b/.test(p.commandLine),HOSTS[version].accept,'首装来源确认参数不符');assert.ok(!/--(?:dangerously|unsafe|allow-all)/.test(p.commandLine))}
}
export function parseMicrosoftEdgeDriverVersion(text){
 // 同一官方工具的旧/新名称；真实154命令改名不改变签名、binary hash或四段版本门禁。
 assert.equal(typeof text,'string');assert.ok(text.length<=4096);const m=/^(?:MSEdgeDriver|Microsoft Edge WebDriver) (\d+\.\d+\.\d+\.\d+)(?: \([^\r\n()]+\))?$/.exec(text.trim());assert.ok(m,'实际Microsoft driver版本输出格式不符');return m[1]
}
export function validateTauriDriverHelp(text){assert.equal(typeof text,'string');assert.equal(text.replaceAll('\r\n','\n').trim(),TAURI_HELP,'固定2.1.0 CLI help不符；不接受伪造version stdout')}
export function parseTauriDriverInstallReceipt(raw){
 assert.ok(typeof raw==='string'&&Buffer.byteLength(raw)<=1024*1024);const data=JSON.parse(raw.replace(/^\uFEFF/,'')),installs=data.installs
 assert.ok(installs&&typeof installs==='object'&&!Array.isArray(installs));assert.equal(Object.keys(installs).length,1,'私有全新安装root必须只有一个固定crate')
 const [packageId,record]=Object.entries(installs)[0],match=/^([a-z][a-z0-9-]*) (\d+\.\d+\.\d+) \(([^)]+)\)$/.exec(packageId);assert.ok(match,'Cargo packageId格式不符')
 const [,name,version,source]=match;assert.equal(name,'tauri-driver');assert.equal(version,'2.1.0');assert.equal(source,'registry+https://github.com/rust-lang/crates.io-index');assert.ok(['2.1.0','=2.1.0'].includes(record.version_req));assert.deepEqual(record.bins,['tauri-driver.exe']);assert.deepEqual(record.features,[]);assert.equal(record.all_features,false);assert.equal(record.no_default_features,false);assert.equal(record.profile,'release');assert.equal(record.target,'x86_64-pc-windows-msvc');assert.match(record.rustc||'',/^rustc \d+\.\d+\./)
 return {name,version,source,packageId,versionRequirement:record.version_req,bins:record.bins,profile:record.profile,target:record.target,rustc:record.rustc}
}
export function assertTauriDriverEvidence(t,edge,application){
 const installed=parseTauriDriverInstallReceipt(t.receipt?.rawJson);assert.equal(t.receipt.sha256,sha(Buffer.from(t.receipt.rawJson)));assert.equal(t.version,installed.version);assert.equal(t.packageId,installed.packageId);assert.equal(t.versionSource,'cargo-install-tracking')
 assert.equal(t.crateChecksum,TAURI_CRATE_CHECKSUM);assert.equal(t.crateArchive?.sha256,TAURI_CRATE_CHECKSUM);assert.ok(path.win32.isAbsolute(t.crateArchive.path));assert.deepEqual(t.sourceHashes,TAURI_SOURCE_PINS);assert.ok(validHash(t.sha256));assert.equal(t.sha256AfterHelp,t.sha256);assert.equal(t.sha256AfterSession,t.sha256);validateTauriDriverHelp(t.help?.text);assert.equal(t.help.sha256,sha(Buffer.from(t.help.text)))
 const c=t.installCommand;assert.equal(c?.ok,true);assert.equal(c.code,0);assert.ok(Number.isInteger(c.pid)&&c.pid>0&&path.win32.isAbsolute(c.program));assert.equal(c.args.length,9);assert.deepEqual(c.args.slice(0,6),['install','tauri-driver','--version',installed.version,'--locked','--root']);assert.equal(c.args[7],'--target-dir');assert.equal(path.win32.normalize(c.args[6]).toLowerCase(),path.win32.dirname(path.win32.dirname(t.path)).toLowerCase())
 const s=t.session,same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.win32.isAbsolute(a)&&path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();assert.ok(typeof s?.sessionId==='string'&&s.sessionId.length>0);assert.ok(s.capabilities&&typeof s.capabilities.browserName==='string'&&s.capabilities.browserName.length>0);assert.equal(s.capabilities.browserVersion,edge.runtimeVersion);assert.ok(same(s.application,application))
 for(const key of ['intermediary','native']){const p=s.processes?.[key],port=s.ports?.[key];assert.ok(Number.isInteger(p?.pid)&&p.pid>0&&Number.isFinite(Date.parse(p.creationDate)));assert.ok(same(p.exe,key==='intermediary'?t.path:edge.path));assert.ok(Number.isInteger(port)&&port>0&&port<65536);assert.ok(s.listeners?.some(x=>x.port===port&&x.pid===p.pid),'driver监听端口/PID不匹配')}
 assert.notEqual(s.ports.native,s.ports.intermediary);assert.notEqual(s.processes.native.pid,s.processes.intermediary.pid)
}
export function assertNativeComplete(r){
 assert.equal(r.status,'pass-native');assert.equal(r.scope,'complete');assert.equal(r.executionMode,'actual-github-hosted-windows-vm-weixin');validateRunnerProof(r.runner)
 assert.ok(exactSha(r.candidateSha)&&Object.hasOwn(HOSTS,r.hostVersion));assert.equal(r.source.sha,r.candidateSha);assert.equal(r.build.sha,r.candidateSha);assert.equal(r.build.noBundle,true)
 assert.deepEqual(r.artifact,expectedArtifact(r.hostVersion),'报告artifact与精确host不符')
 for(const binding of [r.source,r.tooling]){assert.ok(Object.keys(binding.before).length);for(const v of Object.values(binding.before))assert.ok(validHash(v.sha256)&&exactSha(v.gitBlob));assert.deepEqual(binding.after,binding.before,'源码/tooling哈希漂移')}
 assert.equal(r.tooling.sha,r.runner.toolingSha);assert.ok(validHash(r.build.exeSha256));assert.ok(Object.keys(r.build.dist).length&&Object.values(r.build.dist).every(validHash))
 assertTauriDriverEvidence(r.drivers.tauri,r.drivers.edge,r.build.application);assert.match(r.drivers.edge.version,/^\d+\.\d+\.\d+\.\d+$/);assert.equal(r.drivers.edge.version,r.drivers.edge.runtimeVersion);assert.ok(validHash(r.drivers.edge.sha256))
 assert.deepEqual(r.cases.map(x=>x.id).sort(),[...REQUIRED_CASES].sort())
 for(const c of r.cases){assert.equal(c.status,'passed',c.id);assert.equal(c.evidenceKind,'actual-native');assert.ok(c.receipts?.length&&c.receipts.every(validHash),c.id+'缺真实回执')}
 assert.deepEqual(r.gaps,[]);assert.deepEqual(r.errors,[]);assert.equal(r.cleanup.hostUnchanged,true);assert.deepEqual(r.cleanup.errors,[]);assert.deepEqual(r.cleanup.processes,[]);assert.deepEqual(r.cleanup.listeners,[]);assert.ok(r.cleanup.identities?.length)
 for(const p of r.cleanup.identities)assert.ok(Number.isInteger(p.pid)&&p.pid>0&&Number.isFinite(Date.parse(p.creationDate)))
}
function tarEntries(bytes){
 assert.ok(bytes.length<=300*1024*1024,'tar预算超限');let offset=0,count=0;const rows=[],seen=new Set()
 while(offset+512<=bytes.length){const h=bytes.subarray(offset,offset+512);if(h.every(b=>b===0)){assert.ok(bytes.subarray(offset).every(b=>b===0));return rows}
  assert.ok(++count<=25000);const txt=b=>b.toString('utf8').split('\0')[0],oct=b=>parseInt(txt(b).trim()||'0',8),name=[txt(h.subarray(345,500)),txt(h.subarray(0,100))].filter(Boolean).join('/'),size=oct(h.subarray(124,136))
  assert.equal(h.reduce((s,b,i)=>s+(i>=148&&i<156?32:b),0),oct(h.subarray(148,156)),'tar checksum')
  assert.ok(name.startsWith('package/')&&!name.includes('\\')&&!name.split('/').some(x=>x==='..'||x==='.')&&!seen.has(name),'tar路径/重复');seen.add(name)
  assert.ok([0,48,53].includes(h[156])&&Number.isSafeInteger(size)&&size<=32*1024*1024,'tar链接/成员预算');assert.ok(offset+512+size<=bytes.length)
  if(h[156]!==53)rows.push({name,bytes:bytes.subarray(offset+512,offset+512+size)})
  offset+=512+Math.ceil(size/512)*512
 }throw Error('tar缺结束标记')
}
export function inspectTarMember(bytes,name){const rows=tarEntries(bytes).filter(x=>x.name===name);assert.equal(rows.length,1,'固定tar成员缺失');return rows[0].bytes}
export class W3C{
 constructor(base){const u=new URL(base);assert.ok(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password);this.base=u.origin;this.session=null;this.events=[]}
 async request(method,route,body,timeout=120000){assert.ok(timeout>0&&timeout<=720000);if(typeof body?.script==='string')compileInjected(body.script,route);const start=Date.now();const r=await fetch(this.base+route,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout)});const j=await r.json();this.events.push({method,route,status:r.status,elapsedMs:Date.now()-start});assert.ok(r.ok&&!j.value?.error,`W3C ${route}: ${redact(j.value?.message||j.value?.error||r.status)}`);return j.value}
 command(method,route,body,timeout){assert.ok(this.session);return this.request(method,`/session/${this.session}${route}`,body,timeout)}
 async create(application){const v=await this.request('POST','/session',{capabilities:{alwaysMatch:{'tauri:options':{application}}}});assert.ok(v.sessionId);this.session=v.sessionId;this.sessionInfo={sessionId:v.sessionId,capabilities:v.capabilities,application};await this.command('POST','/timeouts',{script:120000,pageLoad:60000,implicit:0})}
 script(script,args=[]){return this.command('POST','/execute/sync',{script,args})}
 async ipc(cmd,args={}){const x=await this.command('POST','/execute/async',{script:'const [cmd,args,done]=arguments;window.__TAURI__.core.invoke(cmd,args).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}))',args:[cmd,args]});return x}
 async click(selector){const x=await this.command('POST','/element',{using:'css selector',value:selector}),id=x['element-6066-11e4-a52e-4f735466cecf'];assert.ok(id);await this.command('POST',`/element/${id}/click`,{})}
 async screenshot(file){const b=Buffer.from(await this.command('GET','/screenshot'),'base64');assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');fs.writeFileSync(file,b);return hash(file)}
 async close(){if(this.session){await this.command('DELETE','');this.session=null}}
}
async function until(fn,timeout=120000){const end=Date.now()+timeout;do{const v=await fn();if(v)return v;await wait(300)}while(Date.now()<end);throw Error('bounded wait timeout')}
function physical(p){p=path.resolve(p);for(let q=p;;q=path.dirname(q)){if(fs.existsSync(q)){assert.ok(!fs.lstatSync(q).isSymbolicLink(),'路径链接');const real=fs.realpathSync.native(q);assert.equal(real.toLowerCase(),q.toLowerCase(),'非physical路径');}if(path.dirname(q)===q)break}return p}
function git(root,args,input){const r=spawnSync('git',['--no-optional-locks','-C',root,...args],{input,windowsHide:true,timeout:60000,maxBuffer:512*1024*1024});assert.equal(r.status,0,'Git读取失败');return r.stdout}
function gitSnapshot(root,commit,exportTo){
 assert.equal(git(root,['rev-parse','HEAD']).toString().trim(),commit,'候选SHA不符')
 const entries=git(root,['ls-tree','-rz','--full-tree',commit]).toString('utf8').split('\0').filter(Boolean).map(v=>{const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(v);assert.ok(m,'拒绝非普通Git blob');return {mode:m[1],id:m[2],file:m[3]}})
 const batch=git(root,['cat-file','--batch'],entries.map(e=>e.id).join('\n')+'\n');let offset=0;const result={}
 for(const e of entries){const end=batch.indexOf(10,offset),head=batch.subarray(offset,end).toString(),m=/^([a-f0-9]{40}) blob (\d+)$/.exec(head);assert.ok(m&&m[1]===e.id);const size=Number(m[2]),b=batch.subarray(end+1,end+1+size);assert.equal(crypto.createHash('sha1').update(`blob ${size}\0`).update(b).digest('hex'),e.id);offset=end+size+2;const f=path.resolve(exportTo||root,e.file);assert.ok(inside(exportTo||root,f));if(exportTo){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);if(process.platform!=='win32')fs.chmodSync(f,e.mode==='100755'?0o755:0o644)}else assert.equal(hash(physical(f)),sha(b),'源码/tooling实际字节不匹配 '+e.file);result[e.file]={gitBlob:e.id,sha256:sha(b)}}return result
}
function directoryHashes(root,allowEmpty=false){const out={};let bytes=0;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);assert.ok(!e.isSymbolicLink());if(e.isDirectory())walk(f);else{bytes+=fs.statSync(f).size;assert.ok(bytes<200*1024*1024);out[path.relative(root,f).replaceAll('\\','/')]=hash(f)}}};walk(root);assert.ok(allowEmpty||Object.keys(out).length);return out}
async function freePort(){return await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})}
async function download(url,max,timeout=300000,{fetchImpl=fetch,headers}={}){const r=await fetchImpl(url,{headers,redirect:'error',signal:AbortSignal.timeout(timeout)});assert.equal(r.status,200,'固定源下载失败: '+url);const chunks=[];let size=0;for await(const b of r.body){size+=b.length;assert.ok(size<=max,'下载预算');chunks.push(b)}return Buffer.concat(chunks)}
export async function readPinnedTauriDriverMetadata(fetchImpl=fetch){
 // crates.io API 要求标识实际调用工具；不伪装浏览器，不重试/换源，不改变固定版本及摘要。
 const crate=JSON.parse((await download(CRATE_METADATA_URL,2*1024*1024,300000,{fetchImpl,headers:CRATE_API_HEADERS})).toString('utf8'))
 assert.equal(crate.version.crate,'tauri-driver');assert.equal(crate.version.num,'2.1.0');assert.equal(crate.version.checksum,'2f2e29bd6900fb718dfdc06f2e7a371d6087c085daaf83709847ef3e6b0c1953');assert.equal(crate.version.yanked,false)
 return crate
}

// 注入仅观察真实 fetch 请求/克隆响应；既不改参数/来源，也不代替产品 UI 返回成功。
const AUDIT_SCRIPT=String.raw`
if(!window.__wxAudit){
 const audit=window.__wxAudit={events:[],tickets:{},errors:[],key:null};const original=window.fetch;
 addEventListener('error',e=>audit.errors.push(String(e.error?.stack||e.message)));addEventListener('unhandledrejection',e=>audit.errors.push(String(e.reason?.stack||e.reason)));
 window.fetch=function(input,options){const u=new URL(typeof input==='string'?input:input.url,location.href);const target=u.hostname==='ipc.localhost';let item;
  if(target){const headers=new Headers(options?.headers||{});const key=headers.get('Tauri-Invoke-Key');if(key)audit.key=key;let args={};try{args=JSON.parse(options?.body||'{}')}catch{};item={cmd:decodeURIComponent(u.pathname.slice(1)),args,at:Date.now()};audit.events.push(item)}
  const result=original.apply(this,arguments);if(item)result.then(response=>{item.response=response.headers.get('Tauri-Response');response.clone().text().then(text=>{try{item.value=JSON.parse(text)}catch{item.value=text};item.done=true;if(item.cmd==='prepare_weixin_install'&&item.response==='ok')audit.tickets[item.value.operationId]=item.value})},e=>{item.transportError=String(e);item.done=true});return result
 }
}return true;`
function frameHtml(){return `<!doctype html><meta charset="utf-8"><title>Weixin qualification untrusted frame</title><script>
addEventListener('message',async e=>{if(e.source!==parent||!e.data||e.data.kind!=='weixin-native-negative')return;const p=e.data;const replies=[];for(const attempt of p.attempts){try{const r=await fetch(p.ipc+'/'+attempt.cmd,{method:'POST',headers:{'Content-Type':'application/json','Tauri-Callback':'900001','Tauri-Error':'900002','Tauri-Invoke-Key':p.key},body:JSON.stringify(attempt.args),signal:AbortSignal.timeout(15000)});replies.push({cmd:attempt.cmd,status:r.status,response:r.headers.get('Tauri-Response')||'error',error:await r.text()})}catch(error){replies.push({cmd:attempt.cmd,response:'transport-error',error:String(error)})}}parent.postMessage({kind:'weixin-native-result',nonce:p.nonce,frameUrl:location.href,frameOrigin:origin,replies},'*')});parent.postMessage({kind:'weixin-native-ready',frameUrl:location.href,frameOrigin:origin},'*');
</script>`}
function compileInjected(script,name){try{return new vm.Script('(function(){\n'+script+'\n})',{filename:'weixin-injected-'+name})}catch(e){throw Error('injected JS syntax '+name+': '+e.message)}}
export function injectionScripts(){
 const source=fs.readFileSync(fileURLToPath(import.meta.url),'utf8'),rows=[{name:'audit',script:AUDIT_SCRIPT},{name:'untrusted-frame-html',script:frameHtml().split('<script>')[1].split('</script>')[0]}]
 for(const m of source.matchAll(/(?:\.script\(|script:)\s*(String\.raw`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g))rows.push({name:'literal-line-'+source.slice(0,m.index).split('\n').length,script:vm.runInNewContext('('+m[1]+')')})
 return rows
}
export function validateInjectionSyntax(){const rows=injectionScripts();assert.ok(rows.length>=18,'注入清单覆盖减少');for(const row of rows)compileInjected(row.script,row.name);return rows.map(r=>({name:r.name,sha256:sha(Buffer.from(r.script))}))}
function ps(code){
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toLowerCase()!=='psmodulepath'))
 const r=spawnSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n"+code,'utf16le').toString('base64')],{env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});assert.equal(r.status,0,'PS5只读观察失败: '+r.stderr);return r.stdout.trim()
}
const psValue=s=>`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s).toString('base64')}'))`
export function processObservationSource(root,ports,tracked=[],controllerPid=process.pid){
 assert.ok(Number.isInteger(controllerPid)&&controllerPid>0&&ports.every(p=>Number.isInteger(p)&&p>0&&p<65536)&&tracked.every(p=>Number.isInteger(p.pid)&&p.pid>0))
 return `$h=${psValue(root)};$ports=@(${ports.join(',')});$ids=@(${tracked.map(x=>x.pid).join(',')});$all=@(Get-CimInstance Win32_Process -ErrorAction Stop);$owned=@($all|Where-Object {$_.ProcessId -ne $PID -and $_.ProcessId -ne ${controllerPid} -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($h+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($h+'\\',[StringComparison]::OrdinalIgnoreCase) -ge 0))});function Row($p){if(!$p.CreationDate){throw 'Missing CreationDate'};@{pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath;commandLine=$(if($owned.ProcessId -contains $p.ProcessId){$p.CommandLine}else{$null})}};$listeners=@(Get-NetTCPConnection -ErrorAction Stop|Where-Object {$_.State -eq 'Listen' -and $ports -contains [int]$_.LocalPort}|ForEach-Object {@{port=[int]$_.LocalPort;pid=[int]$_.OwningProcess}});@{processes=@($owned|ForEach-Object {Row $_});present=@($all|Where-Object {$ids -contains [int]$_.ProcessId}|ForEach-Object {Row $_});listeners=$listeners}|ConvertTo-Json -Compress -Depth 5`
}
function processSnapshot(root,ports,tracked=[]){
 const out=ps(processObservationSource(root,ports,tracked))
 return JSON.parse(out)
}
function hostExtra(profile){
 const result={};for(const d of new Set((process.env.PATH||process.env.Path||'').split(';').filter(Boolean)))if(fs.existsSync(d)&&fs.statSync(d).isDirectory())for(const name of fs.readdirSync(d).filter(n=>/^openclaw(?:[.-]|$)/i.test(n))){const file=path.join(d,name),s=fs.lstatSync(file);result[file]=s.isSymbolicLink()?{link:fs.readlinkSync(file)}:s.isFile()?{sha256:hash(file)}:{kind:'non-file'}}
 const home=path.join(profile,'.openclaw');result.actualOpenclawHome=fs.existsSync(home)?directoryHashes(home):'absent';return result
}
async function execute(o){
 validateInjectionSyntax()
 // 这两项平台事实在任何目录创建、下载或候选执行之前检查；没有本机执行开关。
 assert.ok(process.platform==='win32'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted','Windows GitHub-hosted VM only; no local install/GUI')
 const shared=await import('./test-hermes-windows-qualification.mjs')
 const proof=shared.actualRunnerProof();validateRunnerProof(proof)
 for(const key of ['--root','--sha','--host','--output'])assert.ok(o[key],'缺少 '+key)
 const candidate=physical(o['--root']),output=physical(o['--output']),tempRoot=physical(process.env.RUNNER_TEMP)
 assert.ok(inside(tempRoot,output)&&!fs.existsSync(output),'输出必须RUNNER_TEMP全新physical目录')
 fs.mkdirSync(output);const pub=path.join(output,'public');fs.mkdirSync(pub)
 const artifact=expectedArtifact(o['--host']),scope=o['--scope']||'complete',report={status:'failed',scope,executionMode:'actual-github-hosted-windows-vm-weixin',candidateSha:o['--sha'],hostVersion:o['--host'],artifact,runner:proof,cases:[],commands:[],errors:[],gaps:[],cleanup:{errors:[]}}
 const save=()=>fs.writeFileSync(path.join(pub,'report.json'),JSON.stringify(redact(report),null,2))
 const receipt=(name,value)=>{const f=path.join(pub,name+'.json');fs.writeFileSync(f,JSON.stringify(redact(value),null,2));return hash(f)}
 const pass=(id,value)=>{assert.ok(!report.cases.some(x=>x.id===id));report.cases.push({id,status:'passed',evidenceKind:'actual-native',receipts:[receipt('case-'+id,value)]});save()}
 receipt('runner-proof',proof);receipt('injection-syntax',{harnessSha256:hash(fileURLToPath(import.meta.url)),scripts:validateInjectionSyntax()});save()
 let before,extraBefore
 try{before=shared.hostSnapshot(proof);extraBefore=hostExtra(proof.actualProfile);receipt('host-before',before);receipt('host-extra-before',extraBefore)}catch(e){report.errors.push(redact(e.stack||String(e)));save();throw e}
 const home=path.join(output,'h'),tmp=path.join(output,'tmp'),root=path.join(output,'source');for(const p of [home,tmp,root])fs.mkdirSync(p)
 const env=shared.isolationEnv({home,temp:tmp,realProfile:proof.actualProfile});for(const k of ['ProgramFiles','ProgramFiles(x86)','ProgramW6432'])if(process.env[k])env[k]=process.env[k]
 // 所有修改均为子环境副本；不写 HKCU、全局PATH、全局npm配置、父环境或真实Profile。
 env.PATH=path.dirname(process.execPath)+';'+env.PATH;env.WEBVIEW2_USER_DATA_FOLDER=path.join(home,'.webview2');env.TAURI_WEBVIEW_AUTOMATION='1';env.CARGO_HOME=path.join(home,'.cargo');env.RUSTUP_HOME=path.join(home,'.rustup');env.CARGO_TARGET_DIR=path.join(output,'target')
 fs.mkdirSync(env.APPDATA,{recursive:true});fs.mkdirSync(env.LOCALAPPDATA,{recursive:true})
 receipt('isolation-env',{...env,policy:'no inherited credentials; no registry/global launcher writes'})
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');assert.ok(fs.statSync(npm).isFile())
 const pending=new Set(),identities=new Map(),ports=new Set(),driverLogs={stdout:[],stderr:[]},driverLogBytes={stdout:0,stderr:0};let client,driver,server,invokeKey,driverOverflow=false
 async function run(program,args,timeout=120000,cwd=root){
  const index=report.commands.length,item={program,args,timeout,cwd,startedAt:new Date().toISOString(),ok:false};report.commands.push(item);save()
  const stdout=[],stderr=[];let size=0
  const result=await new Promise((resolve,reject)=>{const child=spawn(program,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});if(child.pid){pending.add(child.pid);item.pid=child.pid}
   let failure,grace;const kill=()=>{if(child.pid)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{env,windowsHide:true,timeout:30000});if(!grace)grace=setTimeout(()=>reject(failure||Error('命令终止后未关闭')),3000)};const timer=setTimeout(()=>{failure=Error('命令预算超时');item.timedOut=true;kill()},timeout)
   for(const [stream,chunks]of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',b=>{size+=b.length;if(size>32*1024*1024){failure=Error('命令输出预算');kill()}else chunks.push(b)})
   child.once('error',e=>{clearTimeout(timer);clearTimeout(grace);reject(e)});child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(grace);pending.delete(child.pid);Object.assign(item,{code,signal,elapsedMs:Date.now()-Date.parse(item.startedAt),ok:code===0&&!failure});const out=Buffer.concat(stdout).toString('utf8'),err=Buffer.concat(stderr).toString('utf8');receipt('command-'+index,{...item,stdout:out,stderr:err});save();if(failure)reject(failure);else resolve({code,out,err})})})
  assert.equal(result.code,0,redact(result.err.slice(-5000)));return result.out.trim()
 }
 async function installHost(version){
  const pin=HOSTS[version],hostRoot=path.join(home,'hosts',version);fs.mkdirSync(hostRoot,{recursive:true})
  const metadata=JSON.parse((await download('https://registry.npmjs.org/openclaw/'+version,2*1024*1024)).toString('utf8'));assert.equal(metadata.version,version);assert.equal(metadata.dist.integrity,pin.integrity)
  const url=`https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`;assert.equal(metadata.dist.tarball,url)
  const bytes=await download(url,150*1024*1024);assert.equal('sha512-'+crypto.createHash('sha512').update(bytes).digest('base64'),pin.integrity)
  const archive=path.join(hostRoot,'openclaw.tgz');fs.writeFileSync(archive,bytes,{flag:'wx'});const tar=zlib.gunzipSync(bytes,{maxOutputLength:300*1024*1024}),members=tarEntries(tar)
  assert.equal(sha(inspectTarMember(tar,'package/package.json')),pin.manifest);assert.equal(sha(inspectTarMember(tar,'package/openclaw.mjs')),pin.entry)
  const prefix=path.join(hostRoot,'npm');await run(process.execPath,[npm,'install','--global','--prefix',prefix,'--registry=https://registry.npmjs.org','--no-audit','--no-fund',archive],900000,hostRoot)
  const pkg=path.join(prefix,'node_modules/openclaw'),cli=path.join(prefix,'openclaw.cmd');assert.ok(fs.statSync(cli).isFile());assert.equal(hash(path.join(pkg,'package.json')),pin.manifest);assert.equal(hash(path.join(pkg,'openclaw.mjs')),pin.entry)
  const source={};for(const m of members){const file=physical(path.join(pkg,m.name.slice('package/'.length)));assert.ok(inside(pkg,file));assert.equal(hash(file),sha(m.bytes),'安装source不等于官方包 '+m.name);source[m.name.slice(8)]=sha(m.bytes)}
  const help=await run(process.execPath,[path.join(pkg,'openclaw.mjs'),'plugins','install','--help'],60000,home);assert.equal(/--accept-capabilities\b/.test(help),pin.accept);assert.match(help,/--force/)
  const evidence={version,integrity:pin.integrity,tarballSha256:sha(bytes),manifestSha256:pin.manifest,entrySha256:pin.entry,cliSha256:hash(cli),cli,pkg,source,help};receipt('host-'+version,evidence);return evidence
 }
 try{
  report.tooling={sha:proof.toolingSha,before:gitSnapshot(tooling,proof.toolingSha)}
  report.source={sha:o['--sha'],before:gitSnapshot(candidate,o['--sha'],root)}
  for(const f of ['src-tauri/src/commands/weixin_install_consent.rs','src/pages/channels-weixin-consent.js'])assert.ok(Object.hasOwn(report.source.before,f),'候选缺少已集成微信确认实现 '+f)
  assert.match(fs.readFileSync(path.join(root,'src-tauri/Cargo.lock'),'utf8'),/\nname = "tauri"\nversion = "2\.11\.1"\n/,'来源审计固定Tauri2.11.1，不推定其它版本')
  receipt('acl-source-inputs',{defaultCapability:read(path.join(root,'src-tauri/capabilities/default.json')),tauriConfig:read(path.join(root,'src-tauri/tauri.conf.json')),buildRs:fs.readFileSync(path.join(root,'src-tauri/build.rs'),'utf8'),sourcePins:Object.fromEntries(['src-tauri/capabilities/default.json','src-tauri/tauri.conf.json','src-tauri/build.rs','src-tauri/Cargo.lock'].map(f=>[f,report.source.before[f]]))})
  save()
  // 采用 runner 既有 rustup 可执行文件，仅在私有 HOME 下载工具链/驱动和构建缓存。
  const rustup=path.join(proof.actualProfile,'.cargo/bin/rustup.exe');assert.ok(fs.statSync(rustup).isFile());await run(rustup,['toolchain','install','stable-x86_64-pc-windows-msvc','--profile','minimal','--no-self-update'],900000)
  const cargo=await run(rustup,['which','cargo','--toolchain','stable-x86_64-pc-windows-msvc']);assert.ok(inside(home,physical(cargo)));env.PATH=path.dirname(cargo)+';'+env.PATH
  receipt('rust-toolchain',{rustupSha256:hash(rustup),cargoSha256:hash(cargo),cargoVersion:await run(cargo,['--version']),rustcVersion:await run(rustup,['run','stable-x86_64-pc-windows-msvc','rustc','--version'])})
   const crate=await readPinnedTauriDriverMetadata();receipt('tauri-driver-metadata',{url:CRATE_METADATA_URL,requestHeaders:CRATE_API_HEADERS,version:{crate:crate.version.crate,num:crate.version.num,checksum:crate.version.checksum,yanked:crate.version.yanked}})
  const driverRoot=path.join(home,'tauri-driver');await run(cargo,['install','tauri-driver','--version','2.1.0','--locked','--root',driverRoot,'--target-dir',path.join(output,'driver-target')],1200000)
  const installCommand=structuredClone(report.commands.at(-1)),tauri=physical(path.join(driverRoot,'bin/tauri-driver.exe')),trackingFile=physical(path.join(driverRoot,'.crates2.json')),trackingRaw=fs.readFileSync(trackingFile,'utf8'),installedDriver=parseTauriDriverInstallReceipt(trackingRaw)
  const cache=path.join(env.CARGO_HOME,'registry/cache'),cached=fs.readdirSync(cache).map(d=>path.join(cache,d,'tauri-driver-2.1.0.crate')).filter(f=>fs.existsSync(f));assert.equal(cached.length,1,'实际Cargo crate归档不明确');const crateArchive={path:physical(cached[0]),sha256:hash(cached[0])};assert.equal(crateArchive.sha256,TAURI_CRATE_CHECKSUM);assert.equal(crate.version.checksum,crateArchive.sha256)
  const installedSources=path.join(env.CARGO_HOME,'registry/src'),sourceRoots=fs.readdirSync(installedSources).map(d=>path.join(installedSources,d,'tauri-driver-2.1.0')).filter(d=>fs.existsSync(d));assert.equal(sourceRoots.length,1,'实际Cargo driver源码不明确');const driverSourceHashes={};for(const [file,pin]of Object.entries(TAURI_SOURCE_PINS)){const f=physical(path.join(sourceRoots[0],file));assert.ok(inside(env.CARGO_HOME,f));assert.equal(hash(f),pin,'固定crate源码改变 '+file);driverSourceHashes[file]=hash(f);fs.copyFileSync(f,path.join(pub,'tauri-driver-2.1.0-'+file.replaceAll('/','-')))}
  const tauriHash=hash(tauri),tauriHelp=await run(tauri,['--help']);validateTauriDriverHelp(tauriHelp);assert.equal(hash(tauri),tauriHash)
  const tauriEvidence={path:tauri,version:installedDriver.version,packageId:installedDriver.packageId,versionSource:'cargo-install-tracking',sha256:tauriHash,sha256AfterHelp:hash(tauri),crateChecksum:crate.version.checksum,crateArchive,sourceHashes:driverSourceHashes,receipt:{rawJson:trackingRaw,sha256:hash(trackingFile)},help:{text:tauriHelp,sha256:sha(Buffer.from(tauriHelp))},installCommand};receipt('tauri-driver-install-identity',tauriEvidence)
  const runtime=JSON.parse(ps(`$guid='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';$keys=@('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\','HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\','HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\','HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\');foreach($key in $keys){$r=Get-ItemProperty -LiteralPath ($key+$guid) -ErrorAction SilentlyContinue;if($r.pv -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$'){foreach($base in @(([Environment]::GetFolderPath('ProgramFilesX86')+'\\Microsoft\\EdgeWebView\\Application'),([Environment]::GetFolderPath('ProgramFiles')+'\\Microsoft\\EdgeWebView\\Application'),(${psValue(proof.actualProfile)}+'\\AppData\\Local\\Microsoft\\EdgeWebView\\Application'))){$f=Join-Path (Join-Path $base $r.pv) 'msedgewebview2.exe';if(Test-Path -LiteralPath $f){@{version=$r.pv;binaryVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($f).ProductVersion;path=$f;registry=($key+$guid)}|ConvertTo-Json;exit 0}}}};throw 'No matching WebView2 runtime'`));assert.equal(runtime.binaryVersion.match(/^\d+\.\d+\.\d+\.\d+/)?.[0],runtime.version)
  const edge=path.join(home,'edge/msedgedriver.exe'),zip=path.join(home,'edge/driver.zip');fs.mkdirSync(path.dirname(edge));const edgeBytes=await download(`https://msedgedriver.microsoft.com/${runtime.version}/edgedriver_win64.zip`,100*1024*1024);fs.writeFileSync(zip,edgeBytes,{flag:'wx'})
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead(${psValue(zip)});try{$e=$z.GetEntry('msedgedriver.exe');if(!$e){throw 'Missing driver'};[IO.Compression.ZipFileExtensions]::ExtractToFile($e,${psValue(edge)},$false)}finally{$z.Dispose()};$s=Get-AuthenticodeSignature -LiteralPath (${psValue(edge)});if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'Invalid Microsoft driver signature'}`)
  const edgeVersion=parseMicrosoftEdgeDriverVersion(await run(edge,['--version']));assert.equal(edgeVersion,runtime.version)
  report.drivers={tauri:tauriEvidence,edge:{path:edge,version:edgeVersion,runtimeVersion:runtime.version,sha256:hash(edge),zipSha256:sha(edgeBytes),runtime}};save()
  await run(process.execPath,[npm,'ci','--registry=https://registry.npmjs.org','--no-audit','--no-fund'],600000)
  await run(process.execPath,[npm,'run','tauri','build','--','--no-bundle','--ci','--','--locked'],2400000)
  const registry=path.join(env.CARGO_HOME,'registry/src');const tauriRoots=fs.readdirSync(registry).map(d=>path.join(registry,d,'tauri-2.11.1')).filter(d=>fs.existsSync(d));assert.equal(tauriRoots.length,1,'不明确的Tauri实际编译源码')
  for(const [file,expected]of [['src/webview/mod.rs','954cf212cb79d6b566c10b76d2ff2da05bc637cfc9f666c2f03d4e3dddf35f1c'],['src/ipc/mod.rs','8c18c612897de97dc4e1b3c1aa62869b66d610e85093e2015b1b6abc3418364d']]){const bytes=fs.readFileSync(path.join(tauriRoots[0],file));assert.equal(sha(bytes),expected,'Tauri2.11.1框架源不符');fs.writeFileSync(path.join(pub,'tauri-2.11.1-'+file.replaceAll('/','-')),bytes)}
  const buildOutputs=path.join(env.CARGO_TARGET_DIR,'release/build');for(const name of ['capabilities.json','acl-manifests.json']){const matches=fs.readdirSync(buildOutputs).filter(d=>d.startsWith('clawpanel-')).map(d=>path.join(buildOutputs,d,'out',name)).filter(f=>fs.existsSync(f));assert.equal(matches.length,1,'实际生成ACL输出不明确');fs.copyFileSync(matches[0],path.join(pub,'generated-'+name))}
  const application=physical(path.join(env.CARGO_TARGET_DIR,'release/clawpanel.exe'));report.build={sha:o['--sha'],noBundle:true,exeSha256:hash(application),application,dist:directoryHashes(path.join(root,'dist'))};receipt('build',report.build)
  const selected=await installHost(o['--host']),alternate=await installHost(o['--host']==='2026.5.12'?'2026.9.8':'2026.5.12');report.hosts=[{version:selected.version,integrity:selected.integrity},{version:alternate.version,integrity:alternate.integrity}]
  const panel=path.join(home,'.openclaw');fs.mkdirSync(panel,{recursive:true});const configFile=path.join(panel,'openclaw.json'),panelFile=path.join(panel,'clawpanel.json');fs.writeFileSync(configFile,JSON.stringify({gateway:{mode:'local'},channels:{},plugins:{entries:{}}}));const panelConfig={ignoreRisk:true,openclawDir:panel,nodePath:path.dirname(process.execPath),openclawCliPath:selected.cli,openclawSearchPaths:[selected.cli],engineMode:'openclaw',enabledEngines:['openclaw'],engineSetupChoice:'explicit',autoStartGateway:false};fs.writeFileSync(panelFile,JSON.stringify(panelConfig))
  env.NPM_CONFIG_PREFIX=path.dirname(selected.cli);env.PATH=path.dirname(selected.cli)+';'+env.PATH
  const driverPort=await freePort(),nativePort=await freePort();ports.add(driverPort);ports.add(nativePort)
  driver=spawn(tauri,['--port',String(driverPort),'--native-port',String(nativePort),'--native-driver',edge],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});assert.ok(driver.pid);pending.add(driver.pid)
  for(const [stream,key] of [[driver.stdout,'stdout'],[driver.stderr,'stderr']])stream.on('data',b=>{driverLogBytes[key]+=b.length;if(driverLogBytes[key]>16*1024*1024){driverOverflow=true;driver.kill()}else driverLogs[key].push(b)})
  await until(async()=>{try{return (await fetch(`http://127.0.0.1:${driverPort}/status`,{signal:AbortSignal.timeout(1000)})).ok}catch{return false}},30000)
  client=new W3C(`http://127.0.0.1:${driverPort}`);await client.create(application)
  const nativeProcesses=processSnapshot(output,[...ports]);assert.ok(nativeProcesses.processes.some(p=>p.exe?.toLowerCase()===application.toLowerCase()),'没有同SHA exe的真实PID');assert.ok(nativeProcesses.processes.some(p=>p.exe?.toLowerCase()===runtime.path.toLowerCase()),'实际WebView2进程不是精确配套runtime');for(const p of nativeProcesses.processes)identities.set(`${p.pid}:${p.creationDate}`,p);receipt('native-process-identities',nativeProcesses)
  const intermediary=nativeProcesses.processes.find(p=>p.pid===driver.pid),nativeDriver=nativeProcesses.processes.filter(p=>p.exe?.toLowerCase()===edge.toLowerCase());assert.equal(nativeDriver.length,1,'实际Microsoft driver进程不明确');tauriEvidence.sha256AfterSession=hash(tauri);tauriEvidence.session={...client.sessionInfo,ports:{intermediary:driverPort,native:nativePort},processes:{intermediary,native:nativeDriver[0]},listeners:nativeProcesses.listeners};assertTauriDriverEvidence(tauriEvidence,report.drivers.edge,application);receipt('tauri-driver-native-session-identity',tauriEvidence);save()
  await until(()=>client.script('return !!window.__TAURI__?.core?.invoke'))
  const identity=await client.script('return {url:location.href,label:window.__TAURI__.webviewWindow.getCurrentWebviewWindow().label,ipc:!!window.__TAURI__.core.invoke}')
  assert.ok(['http://tauri.localhost','https://tauri.localhost','tauri://localhost'].includes(new URL(identity.url).origin==='null'?new URL(identity.url).protocol+'//'+new URL(identity.url).hostname:new URL(identity.url).origin));assert.equal(identity.label,'main');receipt('native-identity',identity)
   const actualSurface=await client.command('POST','/execute/async',{script:'const done=arguments[arguments.length-1];Promise.all([window.__TAURI__.window.getAllWindows(),window.__TAURI__.webview.getAllWebviews()]).then(([w,v])=>done({windows:w.map(x=>x.label).sort(),webviews:v.map(x=>x.label).sort()}),e=>done({error:String(e)}))',args:[]});actualSurface.handles=await client.command('GET','/window/handles')
   const windowSources=Object.fromEntries(Object.keys(report.source.before).filter(f=>/^(src\/.*\.(?:js|ts|html)|src-tauri\/src\/.*\.rs)$/.test(f)).map(f=>[f,fs.readFileSync(path.join(root,f),'utf8')]))
   const capabilityFiles=Object.keys(report.source.before).filter(f=>/^src-tauri\/capabilities\/.*\.json$/.test(f)),surface=assessWindowSurface(read(path.join(root,'src-tauri/tauri.conf.json')),capabilityFiles.map(f=>read(path.join(root,f))),windowSources,actualSurface)
   const surfaceHash=receipt('native-window-surface',{...surface,config:report.source.before['src-tauri/tauri.conf.json'],capabilities:Object.fromEntries(capabilityFiles.map(f=>[f,report.source.before[f]]))});report.cases.push({id:'wrong-window',status:surface.status,negativeExecuted:false,reason:surface.reason,evidenceKind:'actual-native-surface-with-source-audit',receipts:[surfaceHash]});report.gaps.push('wrong-window: '+surface.reason);save()
  const nativeConfig=await client.ipc('get_openclaw_dir');assert.equal(nativeConfig.ok,true);assert.equal(path.resolve(nativeConfig.value.path),path.resolve(panel))
  await client.script(AUDIT_SCRIPT);await client.script("location.hash='/channels';return true")
  await until(()=>client.script('return !!document.querySelector(".platform-pick[data-pid=weixin]")'));await client.click('.platform-pick[data-pid="weixin"]')
  const install='[data-channel-action="install"]',review='[data-weixin-consent-review]',accept='[data-weixin-consent-accept]',confirm='[data-weixin-consent-confirm]',cancel='[data-weixin-consent-cancel]'
  await until(()=>client.script('return !!document.querySelector(arguments[0])&&!document.querySelector(arguments[0]).disabled',[install]))
  const unchanged=()=>({config:hash(configFile),pluginFiles:Object.fromEntries(['extensions','npm',...fs.readdirSync(panel).filter(n=>n.startsWith('.clawpanel-weixin-consent-'))].map(name=>[name,fs.existsSync(path.join(panel,name))?directoryHashes(path.join(panel,name),true):{}]))})
  const initial=unchanged();await client.click(install);await until(()=>client.script('return !!document.querySelector(arguments[0])',[review]),180000)
  const prepared=await until(()=>client.script('return Object.values(window.__wxAudit.tickets).at(-1)||null'));if(prepared.confirmationToken)privateSecrets.add(prepared.confirmationToken);assertPreparedTicket(prepared,o['--host'])
  await client.click(review+' details > summary');const visibleReview=await client.script('return JSON.parse(document.querySelector(arguments[0]).querySelector("pre").textContent)',[review]);assert.equal(visibleReview.SHA256,artifact.sha256);assert.equal(visibleReview.reviewToken,artifact.reviewToken);assert.equal(visibleReview.version,artifact.version);assert.equal(visibleReview.sourceURL,artifact.url);assert.equal(visibleReview.SRI,artifact.integrity);assert.equal(visibleReview.manifestHash,artifact.manifestSha256);assert.equal(visibleReview.sourceCommit,artifact.sourceCommit);assert.equal(visibleReview.requiredSDK,artifact.sdkSubpath);assert.deepEqual(visibleReview.declared,prepared.review.declared);assert.equal(Object.keys(visibleReview.declared).length,10);assert.equal(await client.script('return document.body.textContent.includes(arguments[0])',[prepared.confirmationToken]),false,'UI泄露单次token')
  assert.equal(await client.script('return document.querySelector(arguments[0]).disabled',[confirm]),true)
  await client.script('document.querySelector(arguments[0]).click();return true',[confirm]);await wait(300);assert.deepEqual(unchanged(),initial)
  const audit=()=>client.script('return JSON.parse(JSON.stringify(window.__wxAudit.events,(k,v)=>k==="confirmationToken"?"[REDACTED]":v))')
  assert.equal((await audit()).filter(x=>x.cmd==='confirm_weixin_install').length,0);pass('prepare-ui-unchecked',{initial,after:unchanged(),confirmDisabled:true,visibleReview,screenshot:await client.screenshot(path.join(pub,'unchecked.png')),audit:await audit()})
  await client.click(cancel);await until(()=>client.script('return !document.querySelector(arguments[0])',[review]));await until(async()=>(await audit()).some(x=>x.cmd==='cancel_weixin_install'&&x.response==='ok'&&x.done));assert.deepEqual(unchanged(),initial);pass('cancel-ui',{initial,after:unchanged(),audit:await audit()})
   const policySources={};for(const [f,pin]of Object.entries(selected.source))if(f.startsWith('dist/')&&f.endsWith('.js')){const text=fs.readFileSync(path.join(selected.pkg,f),'utf8');if(text.includes('security.installPolicy')||text.includes('blocked by install policy: '))policySources[f]=pin}
   receipt('upstream-policy-source',{host:selected.version,officialSourceHashes:policySources,hostReceipt:'host-'+selected.version+'.json'})
   if(HOSTS[selected.version].accept){
    assert.ok(Object.keys(policySources).length,'固定现代上游未包含已审计operator policy入口')
    const originalConfig=fs.readFileSync(configFile),policyDir=path.join(home,'operator-policy');fs.mkdirSync(policyDir);const policyExe=path.join(policyDir,'node.exe'),policyScript=path.join(policyDir,'block.cjs'),policyReceipt=path.join(policyDir,'receipt.json'),policyNonce=crypto.randomBytes(16).toString('hex')
    fs.copyFileSync(process.execPath,policyExe,fs.constants.COPYFILE_EXCL);assert.equal(hash(policyExe),hash(process.execPath));fs.writeFileSync(policyScript,makeInstallPolicyProgram({root:output,receiptFile:policyReceipt,nonce:policyNonce,host:selected.version,artifact}),{flag:'wx'})
    const policyConfig=JSON.parse(originalConfig);policyConfig.security={...policyConfig.security,installPolicy:{enabled:true,targets:['plugin'],exec:{command:policyExe,args:[policyScript],trustedDirs:[policyDir],timeoutMs:10000,noOutputTimeoutMs:10000,maxOutputBytes:65536}}};fs.writeFileSync(configFile,JSON.stringify(policyConfig))
    const pluginState=()=>({entries:read(configFile).plugins.entries,installRecord:read(configFile).plugins.installs?.['openclaw-weixin']??null,files:Object.fromEntries(['extensions','npm'].map(n=>[n,fs.existsSync(path.join(panel,n))?directoryHashes(path.join(panel,n),true):{}]))}),policyBefore=pluginState()
    receipt('policy-fixture-input',{nonce:policyNonce,policyExeSha256:hash(policyExe),policyScriptSha256:hash(policyScript),configSha256:hash(configFile),originalConfigSha256:sha(originalConfig),policyConfig,policySources})
    await until(()=>client.script('return !document.querySelector(arguments[0]).disabled',[install]));await client.click(install);await until(()=>client.script('return !!document.querySelector(arguments[0])',[review]),180000)
    const t=await until(()=>client.script('return Object.values(window.__wxAudit.tickets).at(-1)||null'));assertPreparedTicket(t,selected.version);privateSecrets.add(t.confirmationToken);assert.equal(t.operation,'install')
    await client.click(accept);await client.click(confirm);const policyObservations=[]
    const done=await until(async()=>{const snapshot=processSnapshot(output,[...ports]);for(const p of snapshot.processes){identities.set(`${p.pid}:${p.creationDate}`,p);if(/\bplugins\s+install\b/.test(p.commandLine||''))policyObservations.push(p)}return await client.script('const e=window.__wxAudit.events.find(e=>e.cmd==="confirm_weixin_install"&&e.args.operationId===arguments[0]&&e.done);return e?{response:e.response,value:e.value}:null',[t.operationId])},720000)
    await until(()=>client.script('return !!document.querySelector("#channel-action-log-box")?.textContent.includes(arguments[0])',['clawpanel-native-policy-'+policyNonce]));const ui=await client.script('return {progress:document.querySelector("#channel-action-progress-text")?.textContent,log:document.querySelector("#channel-action-log-box")?.textContent}')
    const replay=await client.ipc('confirm_weixin_install',{operationId:t.operationId,confirmationToken:t.confirmationToken,accepted:true,artifactSha256:t.artifact.sha256,reviewToken:t.review.reviewToken})
    const evidence={r:{ok:done.response==='ok',error:String(done.value)},receipt:read(policyReceipt),nonce:policyNonce,artifact,host:selected.version,...ui,before:policyBefore,after:pluginState(),replay,policyObservations,policySources,configAfterSha256:hash(configFile),screenshot:await client.screenshot(path.join(pub,'upstream-policy-block.png'))};receipt('attempt-scanner-failure',evidence);assertInstallObservation(policyObservations,selected.version,home);assertPolicyDenial(evidence);pass('scanner-failure',{...evidence,scope:'actual upstream operator install-policy block, not fabricated code scanner findings'})
    // 仅在真实预期拒绝成立后恢复本轮自己的配置，供下一份新票据正向安装；失败保留现场。
    await until(()=>client.script('return !document.querySelector(arguments[0]).disabled',[install]));fs.writeFileSync(configFile,originalConfig);assert.equal(hash(configFile),sha(originalConfig));receipt('policy-fixture-restored',{configSha256:hash(configFile),originalConfigSha256:sha(originalConfig)});assert.deepEqual(unchanged(),initial)
   }else{
    assert.equal(Object.keys(policySources).length,0,'legacy源码出现未知policy入口，须重新审计而非跳过')
    const reason='该固定官方5.12归档未包含security.installPolicy入口；未改vendor/制造scanner错误，legacy的真实scanner-failure仍未验';report.cases.push({id:'scanner-failure',status:'not-executed',reason,receipts:[receipt('legacy-scanner-gap',{host:selected.version,policySources,sourceReceipt:'host-'+selected.version+'.json',reason})]});report.gaps.push('scanner-failure: '+reason)
   }
  await until(()=>client.script('return !document.querySelector(arguments[0]).disabled',[install]));await client.click(install);await until(()=>client.script('return !!document.querySelector(arguments[0])',[review]),180000)
   const activeTicket=await until(()=>client.script('return Object.values(window.__wxAudit.tickets).at(-1)||null'));assertPreparedTicket(activeTicket,selected.version);privateSecrets.add(activeTicket.confirmationToken);const ticketId=activeTicket.operationId
  async function ticketInvoke(patch){return await client.command('POST','/execute/async',{script:'const [id,patch,done]=arguments;const t=window.__wxAudit.tickets[id];window.__TAURI__.core.invoke("confirm_weixin_install",{operationId:t.operationId,confirmationToken:t.confirmationToken,accepted:true,artifactSha256:t.artifact.sha256,reviewToken:t.review.reviewToken,...patch}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error)}))',args:[ticketId,patch]})}
  for(const [id,patch,code]of [['accepted-false',{accepted:false},'WEIXIN_CONSENT_REQUIRED'],['artifact-change',{artifactSha256:'0'.repeat(64)},'WEIXIN_ARTIFACT_CHANGED'],['review-change',{reviewToken:'0'.repeat(64)},'WEIXIN_ARTIFACT_CHANGED']]){const r=await ticketInvoke(patch);receipt('attempt-'+id,{r,before:initial,after:unchanged()});assert.equal(r.ok,false);assert.match(r.error,new RegExp(code));assert.deepEqual(unchanged(),initial);pass(id,{r,before:initial,after:unchanged()})}
  const originalPanel=fs.readFileSync(panelFile);try{fs.writeFileSync(panelFile,JSON.stringify({...panelConfig,openclawCliPath:alternate.cli,openclawSearchPaths:[alternate.cli]}));const r=await ticketInvoke({});assert.equal(r.ok,false);assert.match(r.error,/WEIXIN_HOST_CHANGED/);assert.deepEqual(unchanged(),initial);pass('wrong-host',{r,actualAlternateVersion:alternate.version,before:initial,after:unchanged()})}finally{fs.writeFileSync(panelFile,originalPanel)}
  const aliasResults=[];for(const [cmd,args]of [['run_channel_action',{platform:'weixin',action:'install'}],['install_plugin',{packageName:'@tencent-weixin/openclaw-weixin@2.4.9'}],['install_plugin',{packageName:'alias@npm:@tencent-weixin/openclaw-weixin@2.4.9'}],['install_plugin',{packageName:'https://example.invalid/renamed.tgz'}],['install_channel_plugin',{packageName:'renamed.tgz',pluginId:'openclaw-weixin',version:'2.4.9'}]]){const r=await client.ipc(cmd,args);assert.equal(r.ok,false);assert.match(r.error,/WEIXIN_CONSENT_REQUIRED/);aliasResults.push({cmd,args,r});assert.deepEqual(unchanged(),initial)}pass('generic-aliases',aliasResults)
  const html=frameHtml(),htmlHash=sha(Buffer.from(html)),nonce=crypto.randomBytes(12).toString('hex');fs.writeFileSync(path.join(pub,'untrusted-frame.html'),html)
  server=http.createServer((req,res)=>{if(req.method!=='GET'||req.url!==`/${nonce}.html`){res.writeHead(404).end();return}res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});res.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const serverPort=server.address().port;ports.add(serverPort);const frameUrl=`http://127.0.0.1:${serverPort}/${nonce}.html`
  invokeKey=await client.script('return window.__wxAudit.key');assert.ok(typeof invokeKey==='string'&&invokeKey.length>=16,'未观察到真实IPC key，不能以缺API假绿');privateSecrets.add(invokeKey)
  for(const opaque of [false,true]){
   const id=opaque?'opaque-iframe':'remote-iframe'
   const result=await client.command('POST','/execute/async',{script:String.raw`const [url,id,key,opaque,nonce,done]=arguments;const iframe=document.createElement('iframe');iframe.dataset.weixinProbe=nonce;if(opaque)iframe.sandbox='allow-scripts';let finished=false;const finish=x=>{if(finished)return;finished=true;clearTimeout(timer);removeEventListener('message',onMessage);const observed={...x,sandbox:iframe.getAttribute('sandbox'),allowSameOrigin:iframe.sandbox.contains('allow-same-origin'),frameElement:iframe.outerHTML};iframe.remove();done(observed)};const timer=setTimeout(()=>finish({error:'frame IPC timeout'}),55000);function onMessage(e){if(e.source!==iframe.contentWindow)return;if(e.data?.kind==='weixin-native-ready'){const t=window.__wxAudit.tickets[id];iframe.contentWindow.postMessage({kind:'weixin-native-negative',nonce,key,ipc:new URL(window.__TAURI_INTERNALS__.convertFileSrc('','ipc')).origin,attempts:[{cmd:'prepare_weixin_install',args:{operation:'install'}},{cmd:'confirm_weixin_install',args:{operationId:id,confirmationToken:t.confirmationToken,accepted:true,artifactSha256:t.artifact.sha256,reviewToken:t.review.reviewToken}},{cmd:'cancel_weixin_install',args:{operationId:id,confirmationToken:t.confirmationToken}}]},'*')}else if(e.data?.kind==='weixin-native-result'&&e.data.nonce===nonce)finish({...e.data,messageOrigin:e.origin,sourceMatched:true})}addEventListener('message',onMessage);iframe.src=url;document.body.append(iframe);`,args:[frameUrl,ticketId,invokeKey,opaque,nonce]})
   receipt('attempt-'+id,{...result,htmlSha256:htmlHash,opaque,validInvokeKey:true,before:initial,after:unchanged()});assert.ok(Array.isArray(result.replies)&&result.replies.length===3,'缺真实iframe native回执')
   for(const r of result.replies)assertOriginDenial({...result,...r,htmlSha256:htmlHash,transport:'native-custom-protocol',validInvokeKey:true,opaque})
   assert.deepEqual(unchanged(),initial);pass(id,{...result,htmlSha256:htmlHash,opaque,validInvokeKey:true,before:initial,after:unchanged()})
  }
  pass('subframe-valid-ticket',{ticketId,remoteAndOpaque:'all prepare/confirm/cancel native denied; real key and unexpired main ticket',htmlSha256:htmlHash})
  // 可信主窗口仍使用同一票据，从而证明 iframe 拒绝并非票据无效/已消费。
  await client.click(accept);assert.equal(await client.script('return document.querySelector(arguments[0]).disabled',[confirm]),false);await client.click(confirm)
  const observations=[];await until(async()=>{const snapshot=processSnapshot(output,[...ports]);for(const p of snapshot.processes){identities.set(`${p.pid}:${p.creationDate}`,p);if(/\bplugins\s+install\b/.test(p.commandLine||''))observations.push(p)};const done=await client.script('const e=window.__wxAudit.events.find(e=>e.cmd==="confirm_weixin_install"&&e.args.operationId===arguments[0]&&e.done);return e?{done:true,response:e.response,value:e.value}:null',[ticketId]);if(done){assert.equal(done.response,'ok',String(done.value));return true}return false},720000)
  receipt('actual-installer-command-lines',observations);assertInstallObservation(observations,o['--host'],home)
  await until(()=>client.script('return document.querySelector("#channel-action-progress-text")?.textContent==="100%"'))
  const result=(await audit()).find(x=>x.cmd==='confirm_weixin_install'&&x.args.operationId===ticketId&&x.response==='ok');assert.equal(result.value.ok,true);assert.equal(result.value.version,artifact.version);for(const k of ['installed','enabled','sdkLoaded','configVerified'])assert.equal(result.value.readback[k],true)
  const status=await client.ipc('check_weixin_plugin_status');assert.equal(status.ok,true);assert.equal(status.value.installedVersion,artifact.version)
  const cfg=read(configFile);const rawInventory=await run(process.execPath,[path.join(selected.pkg,'openclaw.mjs'),'plugins','list','--json'],120000,home),inventory=JSON.parse(rawInventory.slice(rawInventory.indexOf('{')));const installed=physical(assertSdkReadback(status.value,cfg,inventory,o['--host']));assert.ok(inside(panel,installed));assert.equal(read(path.join(installed,'package.json')).name,artifact.packageName);assert.equal(read(path.join(installed,'package.json')).version,artifact.version);receipt('independent-sdk-readback',{status:status.value,configSha256:hash(configFile),inventory})
  const reviewedArchive=await download(artifact.url,1048576,30000);assert.equal(sha(reviewedArchive),artifact.sha256);const reviewedMembers=tarEntries(zlib.gunzipSync(reviewedArchive,{maxOutputLength:4194304}));assert.equal(reviewedArchive.length,artifact.compressedSize);assert.equal('sha512-'+crypto.createHash('sha512').update(reviewedArchive).digest('base64'),artifact.integrity);assert.equal(reviewedMembers.length,artifact.fileCount);assert.equal(reviewedMembers.reduce((n,m)=>n+m.bytes.length,0),artifact.unpackedSize);assert.equal(sha(inspectTarMember(zlib.gunzipSync(reviewedArchive),'package/openclaw.plugin.json')),artifact.manifestSha256);const installedFiles={};for(const m of reviewedMembers){const relative=m.name.slice(8),file=physical(path.join(installed,relative));assert.ok(inside(installed,file));assert.equal(hash(file),sha(m.bytes));installedFiles[relative]=sha(m.bytes)}receipt('installed-plugin-files',{path:installed,artifactSha256:artifact.sha256,files:installedFiles})
  pass('explicit-ui-install-sdk',{result,status,configSha256:hash(configFile),screenshot:await client.screenshot(path.join(pub,'success-100.png')),audit:await audit()})
  const replay=await ticketInvoke({});assert.equal(replay.ok,false);assert.match(replay.error,/WEIXIN_USED/);pass('one-use-replay',replay)
  const pageErrors=await client.script('return window.__wxAudit.errors');receipt('native-observed-errors',{scope:'after audit injection through UI install/replay, before untrusted top navigation',errors:pageErrors});assert.deepEqual(pageErrors,[],'native UI存在未处理错误')
  // 最后导航不可信顶页；真实W3C切换页面，使用同一已验证传输key，不从父页代理请求。
  await client.command('POST','/url',{url:frameUrl});await until(()=>client.script('return location.href===arguments[0]',[frameUrl]));const top=await client.command('POST','/execute/async',{script:'const [key,done]=arguments;fetch("http://ipc.localhost/prepare_weixin_install",{method:"POST",headers:{"Content-Type":"application/json","Tauri-Callback":"900003","Tauri-Error":"900004","Tauri-Invoke-Key":key},body:JSON.stringify({operation:"upgrade"}),signal:AbortSignal.timeout(15000)}).then(async r=>done({frameUrl:location.href,frameOrigin:origin,messageOrigin:origin,response:r.headers.get("Tauri-Response")||"error",error:await r.text()}),e=>done({error:String(e)}))',args:[invokeKey]})
  receipt('attempt-unknown-top-origin',{...top,htmlSha256:htmlHash});assertOriginDenial({...top,sourceMatched:top.frameUrl===frameUrl,validInvokeKey:true,transport:'native-custom-protocol',htmlSha256:htmlHash});pass('unknown-top-origin',{...top,htmlSha256:htmlHash})
  for(const version of [selected,alternate])for(const [file,expected]of Object.entries(version.source))assert.equal(hash(path.join(version.pkg,file)),expected,'官方runtime source安装后改变 '+file)
  report.source.after=gitSnapshot(candidate,o['--sha']);for(const [file,value]of Object.entries(report.source.before))assert.equal(hash(path.join(root,file)),value.sha256,'构建源发生变化 '+file)
  report.tooling.after=gitSnapshot(tooling,proof.toolingSha)
   assert.deepEqual(report.cases.filter(x=>x.status==='passed').map(x=>x.id).sort(),[...PHASE_CASES,...(HOSTS[selected.version].accept?['scanner-failure']:[])].sort());report.status='passed-native-ui-origin-partial'
 }catch(e){report.errors.push(redact(e.stack||String(e)));report.status='failed';process.exitCode=1}
 finally{
  // 每项独立尝试；失败后不改宿主/外部任务来追绿。保留私有HOME，不上传。
  try{if(client){receipt('webdriver-trace',client.events);await client.screenshot(path.join(pub,'final.png'))}}catch(e){report.cleanup.errors.push('native final screenshot: '+redact(String(e)))}
  try{if(client)await client.close()}catch(e){report.cleanup.errors.push('native session close: '+redact(String(e)))}
  try{if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}}catch(e){report.cleanup.errors.push('frame server close: '+String(e))}
  try{const snap=processSnapshot(output,[...ports]);receipt('processes-before-cleanup',snap);for(const p of snap.processes)identities.set(`${p.pid}:${p.creationDate}`,p);for(const pid of pending){if(![...identities.values()].some(x=>x.pid===pid)){const r=ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p){@{pid=[int]$p.ProcessId;creationDate=$p.CreationDate.ToUniversalTime().ToString('o');exe=$p.ExecutablePath}|ConvertTo-Json}else{'null'}`);const p=JSON.parse(r);if(p)identities.set(`${p.pid}:${p.creationDate}`,p)}}
   assert.ok(identities.size,'清理身份集合为空');for(const p of identities.values()){const current=processSnapshot(output,[],[p]).present.find(x=>x.pid===p.pid&&x.creationDate===p.creationDate);if(current)spawnSync('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,timeout:30000})}
   let after;await until(async()=>{after=processSnapshot(output,[...ports],[...identities.values()]);return !after.processes.length&&!after.listeners.length&&!after.present.some(x=>identities.has(`${x.pid}:${x.creationDate}`))},30000)
   Object.assign(report.cleanup,{processes:after.processes,listeners:after.listeners,identities:[...identities.values()]});receipt('processes-after-cleanup',after)
  }catch(e){report.cleanup.errors.push('PID/CreationDate/port cleanup: '+redact(String(e)))}
  try{const after=shared.hostSnapshot(proof),extraAfter=hostExtra(proof.actualProfile);receipt('host-after',after);receipt('host-extra-after',extraAfter);shared.assertHostUnchanged(before,after);assert.deepEqual(extraAfter,extraBefore);report.cleanup.hostUnchanged=true}catch(e){report.cleanup.errors.push('host canary: '+redact(String(e)))}
  try{if(report.tooling){report.tooling.after=gitSnapshot(tooling,proof.toolingSha);assert.deepEqual(report.tooling.after,report.tooling.before)}if(report.source){report.source.after=gitSnapshot(candidate,o['--sha']);assert.deepEqual(report.source.after,report.source.before)}}catch(e){report.cleanup.errors.push('source/tooling post check: '+String(e))}
  for(const [key,chunks]of Object.entries(driverLogs)){let text=redact(Buffer.concat(chunks).toString('utf8'));if(invokeKey)text=text.replaceAll(invokeKey,'[REDACTED]');fs.writeFileSync(path.join(pub,'driver-'+key+'.log'),text)}
  if(driverOverflow)report.cleanup.errors.push('driver输出超预算')
  if(report.cleanup.errors.length){report.status='failed';process.exitCode=1}
  if(report.status!=='failed'&&scope==='complete'){try{report.status='pass-native';assertNativeComplete(report)}catch(e){report.status='incomplete-native';report.errors.push(String(e));process.exitCode=1}}
  save();const files=fs.readdirSync(pub).filter(f=>fs.statSync(path.join(pub,f)).isFile());fs.writeFileSync(path.join(pub,'SHA256SUMS.txt'),files.filter(f=>f!=='SHA256SUMS.txt').sort().map(f=>hash(path.join(pub,f))+'  '+f).join('\n')+'\n')
 }
 console.log(JSON.stringify({status:report.status,candidateSha:report.candidateSha,hostVersion:report.hostVersion,casesPassed:report.cases.filter(x=>x.status==='passed').length,required:REQUIRED_CASES.length,gaps:report.gaps,report:path.join(pub,'report.json')}))
 return report
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const o=parseArgs(process.argv.slice(2));if(o['--execute'])await execute(o);else console.log(JSON.stringify({status:'not-run',localInstall:false,scope:o['--scope']||'complete',candidateSha:o['--sha']||null,hosts:Object.keys(HOSTS),requiredCases:REQUIRED_CASES,phaseOneCases:PHASE_CASES,expectedArtifacts:Object.fromEntries(Object.keys(HOSTS).map(v=>[v,expectedArtifact(v)])),pendingNativeChecks:REQUIRED_CASES,expectedSurfaceLimit:'main-only surface must be proven by exact source and actual enumeration; never a passed wrong-window negative',legacyScannerLimit:'5.12 has no reviewed operator policy entry; real scanner rejection remains required for complete'}))}catch(e){console.error(redact(e.stack||String(e)));process.exitCode=1}
}
