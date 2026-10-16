import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {gunzipSync} from 'node:zlib'

export const WEIXIN_ARTIFACT = Object.freeze({
 packageName:'@tencent-weixin/openclaw-weixin',version:'2.4.9',
 url:'https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.9.tgz',
 integrity:'sha512-SfaYehR1Cwq2VV5HxJBp9sVilMms420VfZlMbF4YjRbWomr5+GxfXp9HkeU6y5TbnOc4Ysq0qPw1yBvJwbenBA==',
 sha256:'467e8047f7114e45944961fcd3eda9421843c9c65db61ea24176e252ab800ee4',
 fileCount:125,unpackedSize:696653,compressedSize:172146,
})
export const consentError = (code,message) => Object.assign(new Error(message),{code})
const fail = message => {throw consentError('WEIXIN_UNSAFE_ARTIFACT',message)}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const text = bytes => new TextDecoder('utf-8',{fatal:true}).decode(bytes)

// 只在内存内有界读取 tar，不写解包树，不接受链接、设备、PAX 或 Windows 特殊路径。
export function readBoundedWeixinTar(bytes) {
 if(!Buffer.isBuffer(bytes)||bytes.length>1048576)fail('微信包压缩体超过安全配额')
 let raw
 try{raw=gunzipSync(bytes,{maxOutputLength:4194304})}catch{fail('微信包解压失败或超过安全配额')}
 const files=[],seen=new Set();let offset=0,entries=0,total=0,ended=false
 const str=b=>{const i=b.indexOf(0);return text(i<0?b:b.subarray(0,i))}
 const octal=b=>{const s=str(b).trim();if(!/^[0-7]+$/.test(s))fail('非法 tar 数值');return parseInt(s,8)}
 while(offset+512<=raw.length){
  const h=raw.subarray(offset,offset+512)
  if(h.every(x=>x===0)){if(raw.length-offset<1024||!raw.subarray(offset).every(x=>x===0))fail('tar 尾部无效');ended=true;break}
  if(++entries>256)fail('tar 条目超过安全配额')
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:h[i]
  if(sum!==octal(h.subarray(148,156)))fail('tar checksum 不匹配')
  const prefix=str(h.subarray(345,500)),name=(prefix?prefix+'/':'')+str(h.subarray(0,100)),size=octal(h.subarray(124,136)),type=h[156]
  if(![0,48,53].includes(type))fail('tar 含链接或特殊条目')
  const clean=type===53?name.replace(/\/$/,''):name,parts=clean.split('/')
  if(name.length>220||parts.length>12||parts[0]!=='package'||parts.length<2||parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00-\x1f\x7f]/.test(p)||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))fail('tar 路径不安全')
  const key=clean.toLowerCase();if(seen.has(key))fail('tar 重复或大小写冲突路径');seen.add(key)
  if(size>1048576||size<0||(total+=size)>4194304||offset+512+size>raw.length)fail('tar 文件超过安全配额')
  if(type===53&&size!==0)fail('tar 目录包含正文')
  if(type!==53){const content=raw.subarray(offset+512,offset+512+size);files.push({path:clean.slice(8),content,sha256:hash(content),size})}
  offset+=512+Math.ceil(size/512)*512
 }
 if(!ended)fail('tar 不完整')
 return {files,unpackedSize:total}
}

export function reviewWeixinArchive(bytes) {
 if(!Buffer.isBuffer(bytes)||bytes.length!==WEIXIN_ARTIFACT.compressedSize||hash(bytes)!==WEIXIN_ARTIFACT.sha256||'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')!==WEIXIN_ARTIFACT.integrity)throw consentError('WEIXIN_ARTIFACT_CHANGED','微信包 SRI/SHA256/长度与固定249发行不一致')
 const archive=readBoundedWeixinTar(bytes),byName=new Map(archive.files.map(f=>[f.path,f]))
 if(archive.files.length!==125||archive.unpackedSize!==696653)fail('微信包文件数或展开大小不匹配')
 const manifestFile=byName.get('openclaw.plugin.json'),pkgFile=byName.get('package.json')
 if(!manifestFile||!pkgFile)fail('微信包缺少 manifest')
 const manifest=JSON.parse(text(manifestFile.content)),pkg=JSON.parse(text(pkgFile.content))
 if(manifestFile.sha256!=='48e1be8ff065494ea9fc58ca8d1333ec60e6d91c51ada182c700ee190638d5cd'||manifest.id!=='openclaw-weixin'||manifest.version!=='2.4.9'||pkg.name!==WEIXIN_ARTIFACT.packageName||pkg.version!=='2.4.9')fail('微信包身份不匹配')
 for(const key of ['preinstall','install','postinstall','prepare'])if(pkg.scripts?.[key])fail('微信包含未核实安装脚本')
 const declared={channels:['openclaw-weixin'],providers:[],tools:[],contracts:[],hooks:[],mcpServers:[],cliCommands:[],cliBackends:[],skills:[],dangerousConfigFlags:[]}
 const findings=[]
 for(const [rule,re]of [['network-code',/\bfetch\s*\(|https?:\/\//],['environment-access',/process\.env/],['process-execution',/child_process|\bexecSync\s*\(|\bspawn\s*\(/]]){
  const count=archive.files.filter(f=>/\.(?:[cm]?js|ts)$/.test(f.path)&&re.test(text(f.content))).length
  if(count)findings.push({rule,severity:'warning',files:count})
 }
 return {fileCount:125,unpackedSize:696653,manifestSha256:manifestFile.sha256,declared,reviewToken:hash(JSON.stringify(declared)),files:archive.files.map(({content,...f})=>f),scan:{status:'reviewed',scope:'bounded-static-exact-artifact; upstream installer scan remains mandatory',findings},warnings:['第三方插件将在 Gateway 进程中运行；声明面不是 OS 沙箱，代码可访问本地数据与外部服务。','固定 registry tarball 属于外部本地归档来源，不代表 ClawHub 审查；本次同意同时确认此来源，不跳过危险代码阻断。','静态检查不保证无风险；上游安装器安全扫描、策略阻断和告警仍完整保留。',...findings.map(f=>`${f.rule}: ${f.files} files`)]}
}

export function verifyWeixinInstalledFiles(packageRoot,review) {
 const root=fs.realpathSync.native(packageRoot)
 for(const f of review.files){const p=path.join(root,f.path),s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||path.relative(fs.realpathSync.native(p),p)!==''||s.size!==f.size||hash(fs.readFileSync(p))!==f.sha256)throw consentError('WEIXIN_READBACK_FAILED','安装后实际包字节与确认 artifact 不一致')}
 return true
}
