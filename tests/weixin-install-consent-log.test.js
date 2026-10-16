import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
globalThis.window={location:{hostname:'localhost'}}
globalThis.localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}}
const {api,getRequestLogs,clearRequestLogs}=await import('../src/lib/tauri-api.js')
test('实际API debug logger递归掩码确认票据/authsession，不缓存prepare/confirm/cancel参数',async t=>{
 const ticket=crypto.randomBytes(32).toString('base64url'),session=crypto.randomBytes(32).toString('base64url'),original=globalThis.fetch
 t.after(()=>{globalThis.fetch=original;clearRequestLogs()})
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}})
 clearRequestLogs();await api.writePanelConfig({confirmationToken:ticket,nested:{authSession:session,password:ticket},safe:'kept'})
 const logs=JSON.stringify(getRequestLogs());assert.ok(!logs.includes(ticket),'随机测试ticket不得出现在日志');assert.ok(!logs.includes(session),'随机测试session不得出现在日志');assert.ok(logs.includes('kept'))
 // writePanelConfig 的既有 invalidate_path_cache 后台请求先完成，再隔离确认方法日志。
 await new Promise(resolve=>setImmediate(resolve));clearRequestLogs()
 globalThis.fetch=async()=>new Response(JSON.stringify({event:'result',result:{ok:true,readback:{sdkLoaded:true}}})+'\n',{headers:{'content-type':'application/x-ndjson'}})
 const payload={operationId:'fixture',confirmationToken:ticket,accepted:true,artifactSha256:'a'.repeat(64),reviewToken:'b'.repeat(64)}
 await api.confirmWeixinInstall(payload);assert.equal(payload.confirmationToken,null);assert.equal(getRequestLogs().length,0)
 globalThis.fetch=async()=>new Response(JSON.stringify({event:'error',error:'failure '+ticket})+'\n',{headers:{'content-type':'application/x-ndjson'}})
 const failed={...payload,confirmationToken:ticket}
 await assert.rejects(api.confirmWeixinInstall(failed),e=>!e.message.includes(ticket));assert.equal(failed.confirmationToken,null)
})

test('stream log/result及transport异常不得带确认票据或authsession，失败也清空客户端payload',async t=>{
 const {safeTauriListen}=await import('../src/lib/tauri-api.js')
 const ticket=crypto.randomBytes(32).toString('base64url'),session=crypto.randomBytes(32).toString('base64url'),oldFetch=globalThis.fetch,events=[]
 t.after(()=>{globalThis.fetch=oldFetch;clearRequestLogs()})
 const stop=await safeTauriListen('channel-action-log',e=>events.push(e.payload));t.after(stop)
 const payload=()=>({operationId:'fixture',confirmationToken:ticket,accepted:true,artifactSha256:'a'.repeat(64),reviewToken:'b'.repeat(64)})
 globalThis.fetch=async()=>new Response([
  {event:'channel-action-log',payload:{message:`ticket ${ticket}; authSession=${session}`,confirmationToken:ticket}},
  {event:'result',result:{ok:true,readback:{sdkLoaded:true},message:`ticket ${ticket}`,authSession:session}},
 ].map(x=>JSON.stringify(x)).join('\n')+'\n')
 const input=payload(),result=await api.confirmWeixinInstall(input)
 assert.equal(input.confirmationToken,null)
 const publicEvidence=JSON.stringify({events,result,logs:getRequestLogs()})
 assert.ok(!publicEvidence.includes(ticket),'公开stream/log/result必须脱敏随机票据');assert.ok(!publicEvidence.includes(session),'公开stream/log/result必须脱敏随机会话')
 globalThis.fetch=async()=>{throw Error(`transport ${ticket} authSession=${session}`)}
 const failed=payload();await assert.rejects(api.confirmWeixinInstall(failed),e=>!e.message.includes(ticket)&&!e.message.includes(session));assert.equal(failed.confirmationToken,null)
 globalThis.fetch=async()=>new Response(JSON.stringify({error:`cancel ${ticket} authSession=${session}`}),{status:409})
 await assert.rejects(api.cancelWeixinInstall('fixture',ticket),e=>!e.message.includes(ticket)&&!e.message.includes(session))
 assert.equal(getRequestLogs().length,0)
})
