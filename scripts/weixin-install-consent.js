import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {buildWeixinCompatibilityStatus} from './weixin-compat.js'
import {WEIXIN_ARTIFACT,reviewWeixinArchive,consentError} from './weixin-install-consent-artifact.js'
export {WEIXIN_ARTIFACT,reviewWeixinArchive,readBoundedWeixinTar,verifyWeixinInstalledFiles} from './weixin-install-consent-artifact.js'
const hash=x=>crypto.createHash('sha256').update(x).digest('hex')
const fail=(code,message)=>{throw consentError(code,message)}
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}

export function resolveWeixinConsentHostMode(hostVersion,installHelp) {
 const match=String(hostVersion||'').match(/^v?(2026\.(?:5\.12|9\.8|10\.4))(?:-\d+)?(?:-zh\.\d+)?$/)
 if(!match)return 'unknown'
 const native=/--accept-capabilities\b/.test(String(installHelp||''))
 return match[1]==='2026.5.12' ? native?'unknown':'legacy-reviewed' : native?'native-cli':'unknown'
}

export function inspectWeixinConsentHostSdk(packageRoot) {
 const required='openclaw/plugin-sdk/infra-runtime'
 try{
  const root=fs.realpathSync.native(packageRoot),manifest=path.join(root,'package.json'),stat=fs.lstatSync(manifest)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)return {supported:false,required}
  const bytes=fs.readFileSync(manifest),pkg=JSON.parse(bytes),entry=pkg.exports?.['./plugin-sdk/infra-runtime'],target=typeof entry==='string'?entry:entry?.default
  if(!['openclaw','@qingchencloud/openclaw-zh'].includes(pkg.name)||typeof target!=='string'||!target.startsWith('./')||target.includes('\\'))return {supported:false,required}
  const file=path.resolve(root,target),relative=path.relative(root,file)
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return {supported:false,required}
  const s=fs.lstatSync(file)
  if(!s.isFile()||s.isSymbolicLink()||s.size>1048576||path.relative(fs.realpathSync.native(file),file)!=='')return {supported:false,required}
  return {supported:true,required,manifestSha256:hash(bytes),moduleSha256:hash(fs.readFileSync(file))}
 }catch{return {supported:false,required}}
}

// 官方5.12写版本/时间戳，9.8另写两项迁移标记。只识别这些元数据，不忽略整个meta/plugins。
export function verifyWeixinConfigReadback(before,after,hostVersion) {
 const normalize=value=>{
  const config=structuredClone(value),empty=(parent,key)=>{if(parent?.[key]&&typeof parent[key]==='object'&&!Array.isArray(parent[key])&&!Object.keys(parent[key]).length)delete parent[key]}
  const entry=config.plugins?.entries?.['openclaw-weixin']
  if(entry&&typeof entry==='object'&&!Array.isArray(entry)){delete entry.enabled;empty(config.plugins.entries,'openclaw-weixin')}
  if(config.plugins){empty(config.plugins,'entries');empty(config,'plugins')}
  const meta=config.meta
  if(meta&&typeof meta==='object'&&!Array.isArray(meta)){
   if(meta.lastTouchedVersion===hostVersion){delete meta.lastTouchedVersion;if(typeof meta.lastTouchedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(meta.lastTouchedAt)&&Number.isFinite(Date.parse(meta.lastTouchedAt)))delete meta.lastTouchedAt}
   if(meta.migrations&&typeof meta.migrations==='object'&&!Array.isArray(meta.migrations)){
    for(const key of ['modelPolicyAllowlist','utilityModelSeparation'])if(meta.migrations[key]===true)delete meta.migrations[key]
    empty(meta,'migrations')
   }
   empty(config,'meta')
  }
  const stable=item=>Array.isArray(item)?item.map(stable):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(k=>[k,stable(item[k])])):item
  return JSON.stringify(stable(config))
 }
 return normalize(before)===normalize(after)
}

export function isWeixinInstallTarget({packageName,pluginId}={}) {
 let name=String(packageName||'').toLowerCase();try{name=decodeURIComponent(name)}catch{}
 return ['weixin','wechat','openclaw-weixin'].includes(String(pluginId||'').trim().toLowerCase())||name.includes('@tencent-weixin/openclaw-weixin')||/openclaw-weixin(?:-|\/)/.test(name)
}
export function validateWeixinRequestOrigin(req) {
 let origin,host
 try{origin=new URL(req.headers.origin);host=new URL(origin.protocol+'//'+req.headers.host)}catch{fail('WEIXIN_ORIGIN','微信安装需要同源 POST 和显式请求标记')}
 if(req.method!=='POST'||!['http:','https:'].includes(origin.protocol)||origin.origin!==req.headers.origin||origin.host!==host.host||origin.username||origin.password||req.headers['x-clawpanel-consent']!=='1'||(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site'])))fail('WEIXIN_ORIGIN','微信安装请求不是已确认的同源操作')
 return origin.origin
}

async function downloadArtifact() {
 const response=await fetch(WEIXIN_ARTIFACT.url,{redirect:'error',signal:AbortSignal.timeout(30000)})
 if(!response.ok||Number(response.headers.get('content-length')||0)>1048576)fail('WEIXIN_UNSAFE_ARTIFACT','下载固定微信包失败或超出配额')
 let size=0;const chunks=[]
 for await(const chunk of response.body){size+=chunk.length;if(size>1048576)fail('WEIXIN_UNSAFE_ARTIFACT','微信包超过压缩体配额');chunks.push(chunk)}
 return Buffer.concat(chunks)
}

// 能力保留于当前进程；CLI 失败不恢复票据，不自动重试或改为 registry/latest。
export function createWeixinConsentManager({root,readState,run,readback,download=downloadArtifact,clock=Date.now}) {
 const records=new Map();let preparing=0,running=false
 const base=path.join(path.resolve(root),'.clawpanel-weixin-install')
 const ctx=c=>{if(!c||!/^[a-f0-9]{64}$/.test(c.sessionKey||'')||!/^https?:\/\//.test(c.origin||'')||typeof c.valid!=='function'||!c.valid())fail('WEIXIN_SESSION','微信安装会话已失效，请重新准备')}
 const physicalDir=p=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||path.relative(fs.realpathSync.native(p),p)!=='')fail('WEIXIN_UNSAFE_ARTIFACT','微信暂存目录不是物理私有目录')}
 const init=()=>{physicalDir(path.resolve(root));if(!fs.existsSync(base))fs.mkdirSync(base,{mode:0o700});physicalDir(base)}
 const discard=r=>{
  // 仅移除本进程创建的固定文件和空目录，从不递归或跟随未知内容。
  if(!r.dir)return
  try{physicalDir(r.dir);if(fs.existsSync(r.file)||fs.lstatSync(r.dir).isDirectory()){try{fs.unlinkSync(r.file)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(r.dir);r.dir=null}catch{r.cleanupIncomplete=true}
 }
 const prune=()=>{
  for(const [id,r]of records){if(clock()>r.expiresAt){discard(r);if(clock()>r.expiresAt+300000)records.delete(id)}}
  // 重启留下的过期专属目录也只允许 artifact.tgz 一个普通文件；未知目录不删除。
  for(const name of fs.readdirSync(base)){if(!/^op-[a-f0-9-]{36}$/.test(name))continue;const dir=path.join(base,name);if([...records.values()].some(r=>r.dir===dir))continue
   try{physicalDir(dir);const s=fs.statSync(dir);if(Date.now()-s.mtimeMs>600000&&fs.readdirSync(dir).every(n=>n==='artifact.tgz')){const f=path.join(dir,'artifact.tgz');if(fs.existsSync(f)&&fs.lstatSync(f).isFile()&&!fs.lstatSync(f).isSymbolicLink())fs.unlinkSync(f);fs.rmdirSync(dir)}}catch{}
  }
 }
 const audit=(r,outcome,error)=>{
  const file=path.join(base,'audit.json');let items=[]
  try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>1048576)fail('WEIXIN_UNSAFE_ARTIFACT','审计记录不安全');items=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(items))throw Error()}catch(e){if(e.code!=='ENOENT')throw e}
  items.push({operationId:r.id,operation:r.operation,at:new Date(clock()).toISOString(),hostVersion:r.state.hostVersion,artifactSha256:WEIXIN_ARTIFACT.sha256,manifestSha256:r.review.manifestSha256,reviewToken:r.review.reviewToken,scan:r.review.scan,outcome,errorCode:error?.code||null,output:r.output||null})
  fs.writeFileSync(file,JSON.stringify(items.slice(-64)),{mode:0o600,flag:'w'})
 }
 const tokenRecord=(input,c)=>{
  ctx(c);const r=records.get(input?.operationId)
  if(!r||r.session!==c.sessionKey||r.origin!==c.origin||!same(r.tokenHash,hash(String(input.confirmationToken||''))))fail('WEIXIN_SESSION','微信安装能力不属于当前会话/来源')
  if(clock()>r.expiresAt){discard(r);fail('WEIXIN_EXPIRED','微信安装确认已过期，请重新准备')}
  if(r.used)fail('WEIXIN_USED','微信安装确认已使用或取消，请重新准备')
  return r
 }
 const stateIdentity=s=>JSON.stringify(s)
 return {
  async prepare(input,c) {
   ctx(c);if(!input||!['install','upgrade'].includes(input.operation)||Object.keys(input).some(k=>k!=='operation'))fail('WEIXIN_CONSENT_REQUIRED','仅允许明确安装或升级固定微信249')
   init();prune()
   if(running||preparing||records.size>=64||[...records.values()].filter(r=>!r.used&&clock()<=r.expiresAt).length>=8||[...records.values()].filter(r=>!r.used&&r.session===c.sessionKey&&clock()<=r.expiresAt).length>=2||fs.readdirSync(base).filter(n=>n.startsWith('op-')).length>=8)fail('WEIXIN_BUSY','微信安装暂存/会话配额已满或已有安装进行中')
   preparing++
   let r
   try{
    const state=await readState();ctx(c)
    const compatible=buildWeixinCompatibilityStatus(state.hostVersion,state.installedVersion)
    if(compatible.installAllowed!==true||compatible.recommendedVersion!=='2.4.9')fail('WEIXIN_HOST_CHANGED',compatible.installError||'当前内核不适用固定微信249')
    if(state.hostSdk?.supported!==true)fail('WEIXIN_SDK_UNSUPPORTED',`固定微信2.4.9需要 openclaw/plugin-sdk/infra-runtime；当前内核 ${state.hostVersion} 缺少已核实的SDK导出。未安装或替换插件；不自动升级插件或降级内核。`)
    if(!['native-cli','legacy-reviewed'].includes(state.capabilityMode)||resolveWeixinConsentHostMode(state.hostVersion,state.capabilityMode==='native-cli'?'--accept-capabilities':'')!==state.capabilityMode)fail('WEIXIN_LEGACY_UNSUPPORTED','当前 CLI 能力确认契约尚未核实（已核实9.8、10.4和5.12）')
    if(state.capabilityMode==='legacy-reviewed'&&!/^v?2026\.5\.12(?:-\d+)?(?:-zh\.\d+)?$/.test(state.hostVersion))fail('WEIXIN_LEGACY_UNSUPPORTED','旧 CLI 仅已核实2026.5.12')
    if((input.operation==='install')===!!state.installed)fail('WEIXIN_HOST_CHANGED','安装状态已变化，请使用与实际状态相符的安装/升级操作')
    const bytes=await download();ctx(c);const review=reviewWeixinArchive(bytes)
    const id=crypto.randomUUID(),dir=path.join(base,'op-'+id);fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'artifact.tgz');fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600})
    const token=crypto.randomBytes(32).toString('base64url'),expiresAt=clock()+300000
    r={id,dir,file,state,operation:input.operation,review,tokenHash:hash(token),session:c.sessionKey,origin:c.origin,expiresAt,used:false};records.set(id,r);audit(r,'prepared')
    const prior=state.previousDeclared||null,added=Object.fromEntries(Object.entries(review.declared).map(([k,v])=>[k,v.filter(x=>!prior?.[k]?.includes(x))]))
    const {files,...publicReview}=review
    return {kind:'weixin-install-consent',protocolVersion:1,operationId:id,confirmationToken:token,expiresAt:new Date(expiresAt).toISOString(),operation:r.operation,hostVersion:state.hostVersion,capabilityMode:state.capabilityMode,installedVersion:state.installedVersion,artifact:{...WEIXIN_ARTIFACT},review:{...publicReview,previousDeclared:prior,addedDeclared:added}}
   }catch(e){if(r){r.used=true;discard(r)}throw e}finally{preparing--}
  },
  async cancel(input,c){const r=tokenRecord(input,c);r.used=true;audit(r,'cancelled');discard(r);return {cancelled:true}},
  async confirm(input,c,onEvent=()=>{}){
   const r=tokenRecord(input,c)
   const scrub=value=>{let s=c.redact?c.redact(String(value)):String(value);if(input.confirmationToken)s=s.split(input.confirmationToken).join('[REDACTED]');return s.replace(/((?:confirmationToken|authSession(?:Token)?|sessionToken|token|password|secret|api[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi,'$1[REDACTED]')}
   const emit=event=>onEvent(JSON.parse(scrub(JSON.stringify(event))))
   if(input.accepted!==true)fail('WEIXIN_CONSENT_REQUIRED','需要用户明确勾选并确认本次安装')
   if(input.artifactSha256!==WEIXIN_ARTIFACT.sha256||input.reviewToken!==r.review.reviewToken||Object.keys(input).some(k=>!['operationId','confirmationToken','accepted','artifactSha256','reviewToken'].includes(k)))fail('WEIXIN_ARTIFACT_CHANGED','确认对象与准备的 artifact/声明面不匹配')
   if(running||preparing)fail('WEIXIN_BUSY','已有微信安装进行中，请等待')
   running=true;r.used=true
   try{
    const current=await readState();ctx(c)
    if(stateIdentity(current)!==stateIdentity(r.state))fail('WEIXIN_HOST_CHANGED','内核/原插件/配置身份已变化，请重新准备')
    let bytes,review
    try{physicalDir(r.dir);const stat=fs.lstatSync(r.file);if(!stat.isFile()||stat.isSymbolicLink()||path.relative(fs.realpathSync.native(r.file),r.file)!==''||stat.size!==WEIXIN_ARTIFACT.compressedSize)throw Error();bytes=fs.readFileSync(r.file);review=reviewWeixinArchive(bytes)}catch{fail('WEIXIN_ARTIFACT_CHANGED','暂存微信包/manifest/声明面已变化')}
    if(review.manifestSha256!==r.review.manifestSha256||review.reviewToken!==r.review.reviewToken)fail('WEIXIN_ARTIFACT_CHANGED','声明面已变化')
    ctx(c);if(clock()>r.expiresAt)fail('WEIXIN_EXPIRED','确认已过期')
    audit(r,'accepted')
    const args=['plugins','install',r.file]
    // 官方9.8/10.4把本地归档来源确认也交给force；只有本次明确确认后才传，不传unsafe。
    if(r.operation==='upgrade'||r.state.capabilityMode==='native-cli')args.push('--force')
    if(r.state.capabilityMode==='native-cli')args.push('--accept-capabilities')
    const result=await run(args,emit)
    r.output=scrub([result.stdout,result.stderr].filter(Boolean).join('\n')).slice(-12000)
    if(result.status!==0)fail('WEIXIN_INSTALL_FAILED',`微信安装退出码 ${result.status??'unknown'}\n${r.output}`)
    const actual=await readback(review,emit,r.state)
    if(actual.installed!==true||actual.version!=='2.4.9'||actual.enabled!==true||actual.sdkLoaded!==true||actual.configVerified!==true)fail('WEIXIN_READBACK_FAILED','CLI exit0，但插件版本/路径/SDK/config实际回读未通过')
    audit(r,'verified')
    return {ok:true,operationId:r.id,version:'2.4.9',hostVersion:r.state.hostVersion,message:'微信插件2.4.9安装及实际SDK/配置回读通过',readback:actual,warnings:review.warnings}
   }catch(e){const clean=consentError(typeof e.code==='string'&&/^WEIXIN_[A-Z_]+$/.test(e.code)?e.code:'WEIXIN_INSTALL_FAILED',scrub(e.message||e));audit(r,'failed',clean);throw clean}finally{discard(r);running=false}
  },
 }
}
