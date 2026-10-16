// 真实 HTTP/middleware 负向：直接旧安装入口和伪 origin 不得触发任何 CLI。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
test('真实 HTTP 微信安装拒绝无确认/跨origin，私有CLI sink保持零执行',async t=>{
 const parent=fs.realpathSync.native(os.tmpdir()),home=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'weixin-consent-http-')))
 const marker=path.join(home,'cli-called'),cli=path.join(home,process.platform==='win32'?'openclaw.cmd':'openclaw')
 fs.writeFileSync(cli,process.platform==='win32'?`@echo off\r\necho invoked>>"${marker}"\r\nexit /b 0\r\n`:`#!/bin/sh\nprintf invoked >> '${marker}'\nexit 0\n`,{mode:0o700})
 fs.mkdirSync(path.join(home,'.openclaw'));fs.writeFileSync(path.join(home,'.openclaw','clawpanel.json'),JSON.stringify({ignoreRisk:true,openclawCliPath:cli}));fs.writeFileSync(path.join(home,'.openclaw','openclaw.json'),'{}')
 const script=`import http from 'node:http';import {_apiMiddleware,_initApi} from ${JSON.stringify(new URL('../scripts/dev-api.js',import.meta.url).href)};_initApi();const s=http.createServer((q,r)=>_apiMiddleware(q,r,()=>{r.statusCode=404;r.end()}));s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port));`
 const env={...process.env,HOME:home,USERPROFILE:home,OPENCLAW_CONFIG_DIR:path.join(home,'.openclaw'),APPDATA:home,LOCALAPPDATA:home,XDG_CONFIG_HOME:home,XDG_CACHE_HOME:home,XDG_DATA_HOME:home,TEMP:home,TMP:home,TMPDIR:home}
 delete env.NODE_OPTIONS
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr=''
 child.stdout.on('data',b=>{stdout+=b});child.stderr.on('data',b=>{stderr+=b})
 t.after(async()=>{child.kill('SIGTERM');if(child.exitCode===null&&child.signalCode===null)await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,5000))]);assert.equal(path.dirname(fs.realpathSync.native(home)),parent);fs.rmSync(home,{recursive:true,force:true})})
 const until=Date.now()+15000;while(!stdout.includes('READY:')&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,25))
 assert.match(stdout,/READY:(\d+)/,stderr);const base='http://127.0.0.1:'+stdout.match(/READY:(\d+)/)[1]
 const post=async(cmd,body,headers={})=>{const r=await fetch(base+'/__api/'+cmd,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json()}}
 for(const [cmd,body]of [['install_channel_plugin',{packageName:'@tencent-weixin/openclaw-weixin',pluginId:'openclaw-weixin',version:'2.4.9'}],['run_channel_action',{platform:'weixin',action:'install'}],['install_plugin',{packageName:'@tencent-weixin/openclaw-weixin@2.4.9'}]]){
  const r=await post(cmd,body);assert.equal(r.status,409,cmd);assert.equal(r.body.code,'WEIXIN_CONSENT_REQUIRED',cmd)
 }
 for(const h of [{},{origin:'http://foreign.invalid','x-clawpanel-consent':'1'},{origin:base}]){const r=await post('prepare_weixin_install',{operation:'install'},h);assert.equal(r.status,403);assert.equal(r.body.code,'WEIXIN_ORIGIN')}
 assert.equal(fs.existsSync(marker),false,'任何未确认入口都不得执行CLI')
})
