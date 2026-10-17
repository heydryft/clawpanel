import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// 受控真实页面E2E：显式复用已安装依赖与浏览器，不下载、不启动任何内核。
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:(a.push([v.slice(2),all[i+1]]),a),[]))
for(const key of ['root','output','vite','playwright','browser']) assert.ok(args[key], '--'+key)
const root=path.resolve(args.root), out=path.resolve(args.output)
fs.mkdirSync(out,{recursive:true})
const {createServer}=await import(pathToFileURL(path.join(args.vite,'dist/node/index.js')))
const {chromium}=await import(pathToFileURL(args.playwright))
const deps=path.dirname(args.vite), pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const report={scope:'isolated real headless page + fake loopback API; not real Hermes qualification',scenario:args.scenario||'round-trip',node:process.version,source:root,chatSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'src/engines/hermes/pages/chat.js'))).digest('hex'),storeSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'src/engines/hermes/lib/chat-store.js'))).digest('hex'),harnessSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'),fakeGatewayAlwaysRunning:true,requests:[],steps:[],errors:[],external:[]}
let browser, context, server, page, profile='default', model='model-A', hold=true, pending=[], stream, turn=0
const saved=[]
function data(cmd,body){
 switch(cmd){
 case 'health':return {ok:true,backendVersion:pkg.version,apiContractVersion:1}
 case 'auth_check':return {required:false,authenticated:true}
 case 'read_panel_config':return {engineMode:'hermes',engineSetupChoice:'hermes',enabledEngines:['hermes']}
 case 'check_hermes':return {installed:true,configExists:true,gatewayRunning:true,version:'0.21.5',model}
 case 'hermes_profiles_list':return {active:profile,profiles:[{name:'default',active:profile==='default',gatewayRunning:true,model},{name:'named',active:profile==='named',gatewayRunning:true,model:'model-named'}]}
 case 'hermes_profile_use':profile=body.name;return {ok:true}
 case 'hermes_sessions_list':return saved.filter(s=>s.profile===profile).map(s=>({...s,messages:undefined}))
 case 'hermes_session_detail':case 'hermes_session_export':return saved.find(s=>s.id===(body.sessionId||body.id))||{messages:[]}
 case 'get_portable_status':return {portable:false}
 case 'check_site_announcements':return {items:[]}
 case 'check_panel_update':return {current:pkg.version,latest:pkg.version,hasUpdate:false}
 case 'check_ciao_windowshide_bug':return {affected:false}
 default:return {}
 }
}
function respond(cmd,body,res){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data(cmd,body)))}
async function state(label){
 const s=await page.evaluate(()=>({url:location.hash,input:document.querySelector('#hm-chat-input')?.value,focused:document.activeElement?.id,disabled:document.querySelector('#hm-chat-send')?.disabled,stop:!!document.querySelector('#hm-chat-stop'),profile:document.querySelector('.hm-chat-profile-name')?.textContent,model:document.querySelector('.hm-chat-gw-model')?.textContent,attachments:document.querySelectorAll('[data-attach-remove]').length,events:window.__draftEvents||[]}))
 report.steps.push({label,...s});return s
}
async function settle(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
function release(cmd){const selected=pending.filter(x=>x.cmd===cmd);pending=pending.filter(x=>x.cmd!==cmd);for(const x of selected)respond(x.cmd,x.body,x.res)}
async function round(label,text){
 await page.locator('#hm-chat-input').waitFor({state:'visible',timeout:30000})
 await page.locator('#hm-chat-new-chat').click({timeout:30000})
 await page.locator('#hm-chat-input').fill(text)
 await state(label+'-after-fill')
 for(const cmd of ['hermes_sessions_list','hermes_profiles_list','check_hermes']){release(cmd);await settle();const s=await state(label+'-after-'+cmd);assert.equal(s.input,text,label+' draft lost after '+cmd)}
 hold=false
 // 原真实资格的30秒clickdeadline不放宽。
 await page.locator('#hm-chat-send').click({timeout:30000})
 await page.locator('#hm-chat-stop').waitFor({state:'visible',timeout:30000})
 await state(label+'-streaming')
 assert.equal(report.requests.filter(r=>r.cmd==='hermes_agent_run_stream'&&r.body.input===text).length,1)
 const next=text+' 下一条草稿 Unicode中文Ω🙂'
 await page.locator('#hm-chat-input').fill(next)
 stream.write(JSON.stringify({event:'message.delta',delta:'isolated reply '+text})+'\n');await settle()
 assert.equal((await state(label+'-delta')).input,next,'stream delta lost next draft')
 stream.end(JSON.stringify({event:'run.completed',output:'isolated reply '+text})+'\n')
 await page.locator('#hm-chat-stop').waitFor({state:'detached',timeout:30000});await settle()
 assert.equal((await state(label+'-done')).input,next)
 assert.equal(report.requests.filter(r=>r.cmd==='hermes_agent_run_stream'&&r.body.input===text).length,1)
 assert.equal(report.requests.filter(r=>r.cmd==='hermes_agent_run_stream').length,turn,'must not auto-replay next draft')
 return next
}

// 真PNG/native FileReader；只hold真实load回调交付，观察原change handler的Promise完成。
function installAttachmentBarrier(){
 const observer=window.__attachmentBoundary={heldName:null,reads:[],selections:[],pending:[],release(){const pending=this.pending.splice(0);for(const done of pending)done()}}
 const read=FileReader.prototype.readAsDataURL
 FileReader.prototype.readAsDataURL=function(file){
  if(!file.name.startsWith('owned-attachment-'))return read.call(this,file)
  const done=this.onload,reader=this
  this.onload=function(event){const row={name:file.name,size:file.size,readyState:reader.readyState,trusted:event.isTrusted,result:reader.result,held:file.name===observer.heldName,released:false};observer.reads.push(row);const deliver=()=>{row.released=true;done.call(reader,event)};if(row.held)observer.pending.push(deliver);else deliver()}
  return read.call(this,file)
 }
 const add=EventTarget.prototype.addEventListener
 EventTarget.prototype.addEventListener=function(type,listener,options){
  if(type==='change'&&this instanceof HTMLInputElement&&this.id==='hm-chat-attach-input'&&typeof listener==='function'){
   return add.call(this,type,function(event){const row={files:[...this.files].map(f=>f.name),completed:false,error:null};observer.selections.push(row);const result=listener.call(this,event);Promise.resolve(result).then(()=>{row.completed=true},error=>{row.completed=true;row.error=String(error);queueMicrotask(()=>{throw error})});return result},options)
  }
  return add.call(this,type,listener,options)
 }
}
async function attachmentBoundaryScenario(){
 await page.locator('#hm-chat-input').waitFor({state:'visible',timeout:30000})
 for(const cmd of ['hermes_sessions_list','hermes_profiles_list','check_hermes'])release(cmd)
 hold=false;await settle();await page.locator('#hm-chat-new-chat').click({timeout:30000})
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),names=['owned-attachment-old.png','owned-attachment-queued.png','owned-attachment-current.png'],paths=names.map(name=>path.join(out,name))
 for(const p of paths)fs.writeFileSync(p,png,{flag:'wx'})
 report.attachmentScope='actual local PNG/native FileReader callback barrier and public store profile API; not profile-menu/real Hermes qualification'
 report.png={bytes:png.length,sha256:createHash('sha256').update(png).digest('hex')};report.profileTransitions=[]
 const same=args.scenario==='attachment-same-profile',back=args.scenario==='attachment-profile-round-trip'
 await page.locator('#hm-chat-input').fill('old-default-draft 中文Ω🙂')
 await page.evaluate(name=>{window.__attachmentBoundary.heldName=name},names[0])
 await page.locator('#hm-chat-attach-input').setInputFiles(same?[paths[0]]:[paths[0],paths[1]])
 await page.waitForFunction(()=>window.__attachmentBoundary.reads.some(r=>r.held&&!r.released))
 const held=await page.evaluate(()=>window.__attachmentBoundary.reads.find(r=>r.held));assert.equal(held.readyState,2);assert.equal(held.trusted,true);assert.deepEqual(Buffer.from(held.result.split(',')[1],'base64'),png)
 async function switchProfile(name){const proof=await page.evaluate(async name=>{const store=(await import('/src/engines/hermes/lib/chat-store.js')).getChatStore();await store.switchProfile(name);return {active:store.state.activeProfile,generation:store.state.profileGeneration??null}},name);await settle();assert.equal((await state('profile-'+name)).profile,name);report.profileTransitions.push(proof)}
 if(!same){await switchProfile('named');if(back)await switchProfile('default')}
 const expectedProfile=back||same?'default':'named',draft='new-'+expectedProfile+'-draft 中文Ω🙂'
 await page.locator('#hm-chat-input').fill(draft)
 if(same){await page.locator('#hm-chat-toggle-sidebar').click({timeout:30000});await settle()}
 await state('before-old-reader-release')
 await page.evaluate(()=>window.__attachmentBoundary.release())
 await page.waitForFunction(()=>window.__attachmentBoundary.selections[0]?.completed)
 await settle();report.readerEvidence=await page.evaluate(()=>({reads:window.__attachmentBoundary.reads,selections:window.__attachmentBoundary.selections}))
 const after=await state('after-old-reader-release');assert.equal(after.input,draft,'旧reader回包不得清掉当前draft');assert.equal(after.profile,expectedProfile)
 assert.equal(after.attachments,same?1:0,'旧profile的PNG不得附入新/往返profile')
 if(!same){await page.locator('#hm-chat-attach-input').setInputFiles(paths[2]);await page.waitForFunction(()=>window.__attachmentBoundary.selections[1]?.completed);await settle()}
 const normal=await state('current-attachment-ready');assert.equal(normal.attachments,1);assert.equal(normal.input,draft)
 await page.locator('#hm-chat-toggle-sidebar').click({timeout:30000});await settle();const redrawn=await state('same-profile-redraw');assert.equal(redrawn.attachments,1);assert.equal(redrawn.input,draft)
 await page.screenshot({path:path.join(out,'attachment-before-send.png')})
 await page.locator('#hm-chat-send').click({timeout:30000});await page.locator('#hm-chat-stop').waitFor({state:'visible',timeout:30000})
 const posted=report.requests.filter(r=>r.cmd==='hermes_agent_run_stream');assert.equal(posted.length,1);assert.equal(posted[0].body.input,draft);assert.equal(posted[0].profileAtReceive,expectedProfile)
 const selected=await page.evaluate(async()=>{const store=(await import('/src/engines/hermes/lib/chat-store.js')).getChatStore();return {profile:store.state.activeProfile,user:store.activeSession().messages.filter(m=>m.role==='user').at(-1)}});report.sentComposer=selected
 assert.equal(selected.profile,expectedProfile);assert.equal(selected.user.content,draft);assert.deepEqual(selected.user.attachments.map(a=>a.name),[same?names[0]:names[2]]);assert.deepEqual(Buffer.from(selected.user.attachments[0].dataUrl.split(',')[1],'base64'),png)
 // Web现有stream封装不传附件；只证明真实composer/store所选附件与HTTP文本/profile，不冒称上传。
 report.webAttachmentTransportObserved=Object.hasOwn(posted[0].body,'attachments')
 stream.end(JSON.stringify({event:'run.completed',output:'isolated attachment reply'})+'\n');await page.locator('#hm-chat-stop').waitFor({state:'detached',timeout:30000});await settle()
 assert.equal(report.requests.filter(r=>r.cmd==='hermes_agent_run_stream').length,1)
 report.readerEvidence=await page.evaluate(()=>({reads:window.__attachmentBoundary.reads,selections:window.__attachmentBoundary.selections}))
 assert.ok(report.readerEvidence.selections.every(x=>x.completed&&!x.error))
}

try{
 server=await createServer({root,configFile:false,cacheDir:path.join(out,'vite-cache'),define:{__APP_VERSION__:JSON.stringify(pkg.version)},resolve:{alias:[...['@tauri-apps/api','@tauri-apps/plugin-shell','@tauri-apps/plugin-autostart','yaml'].map(find=>({find,replacement:path.join(deps,find)}))]},optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,deps]}},plugins:[{name:'owned-fake-api',configureServer(s){s.middlewares.use((req,res,next)=>{
  const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/__api/'))return next()
  const cmd=url.pathname.slice(7);let raw='';req.on('data',b=>{raw+=b;assert.ok(raw.length<65536)});req.on('end',()=>{
   const body=JSON.parse(raw||'{}');report.requests.push({cmd,body,profileAtReceive:profile,at:Date.now()})
   if(/install|uninstall|upgrade/.test(cmd)){report.errors.push('forbidden installer '+cmd);res.statusCode=500;return res.end('{}')}
   if(cmd==='hermes_agent_run_stream'){turn++;stream=res;res.setHeader('Content-Type','application/x-ndjson');res.write(JSON.stringify({event:'run.started',run_id:'own-'+turn})+'\n');saved.push({id:body.sessionId,profile,title:body.input,source:'cli',messages:[{role:'user',content:body.input}]});return}
   if(hold&&['hermes_sessions_list','hermes_profiles_list','check_hermes'].includes(cmd))pending.push({cmd,body,res});else respond(cmd,body,res)
  })
 })}}]})
 await server.listen();const address=server.httpServer.address();const origin='http://127.0.0.1:'+address.port
 browser=await chromium.launch({executablePath:args.browser,headless:true})
 report.browser=browser.version();report.browserSha256=createHash('sha256').update(fs.readFileSync(args.browser)).digest('hex')
 context=await browser.newContext({viewport:{width:1280,height:720}});await context.tracing.start({screenshots:true,snapshots:true,sources:true})
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){report.external.push(u.origin);return route.abort()}return route.continue()})
 await context.addInitScript(()=>{window.__draftEvents=[];for(const event of ['input','focus','blur'])document.addEventListener(event,e=>{if(e.target.id==='hm-chat-input')window.__draftEvents.push({event,value:e.target.value,connected:e.target.isConnected,at:performance.now()})},true)})
 if(args.scenario?.startsWith('attachment-'))await context.addInitScript(installAttachmentBarrier)
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message))
 await page.goto(origin+'/#/h/chat',{waitUntil:'domcontentloaded',timeout:30000})
 if(args.scenario==='focus-gap'){
  await page.locator('#hm-chat-input').waitFor({state:'visible',timeout:30000})
  await page.locator('#hm-chat-new-chat').click({timeout:30000})
  await page.locator('#hm-chat-input').focus()
  await state('before-initial-api-completion')
  // 正常文字输入的焦点与插入是两个浏览器动作；用回包barrier精确覆盖中间窗口，不靠sleep或重试。
  for(const cmd of ['hermes_sessions_list','hermes_profiles_list','check_hermes']){release(cmd);await settle();await state('focused-after-'+cmd)}
  hold=false
  await page.keyboard.insertText('own-focused-gap 中文Ω🙂')
  const s=await state('after-real-keyboard-insertion')
  assert.equal(s.input,'own-focused-gap 中文Ω🙂','initial API redraw lost input focus before real text insertion')
  assert.equal(s.disabled,false)
  await page.locator('#hm-chat-send').click({timeout:30000})
  await page.locator('#hm-chat-stop').waitFor({state:'visible',timeout:30000})
  assert.equal(report.requests.filter(r=>r.cmd==='hermes_agent_run_stream').length,1)
  stream.end(JSON.stringify({event:'run.completed',output:'isolated focused reply'})+'\n')
  await page.locator('#hm-chat-stop').waitFor({state:'detached',timeout:30000})
 }else if(args.scenario?.startsWith('attachment-')){
  await attachmentBoundaryScenario()
 }else if(args.scenario==='profile-isolation'){
  await page.locator('#hm-chat-input').waitFor({state:'visible',timeout:30000})
  await page.locator('#hm-chat-new-chat').click({timeout:30000})
  await page.locator('#hm-chat-input').fill('default-profile-private-draft 中文Ω🙂')
  release('hermes_sessions_list');release('check_hermes');await settle()
  profile='named';release('hermes_profiles_list');await settle()
  const s=await state('late-profile-admission')
  assert.equal(s.profile,'named');assert.equal(s.input,'','late profile metadata must not carry default draft into named profile')
 }else{
 await round('initial','own-first 中文Ω🙂')
 await page.screenshot({path:path.join(out,'first.png')})
 model='model-B';hold=true
 await page.reload({waitUntil:'domcontentloaded',timeout:30000})
 await round('reload-model-B','own-second 中文Ω🙂')
 assert.equal((await state('model-B-confirmed')).model,'model-B')
 await page.screenshot({path:path.join(out,'second.png')})
 // 跨profile边界由独立profile-isolation场景从真实初始profiles响应覆盖；不把菜单操作算成本轮已资格。
 }
 assert.deepEqual(report.external,[]);assert.deepEqual(report.errors,[])
 await page.screenshot({path:path.join(out,'success.png')})
 report.passed=true
}catch(e){report.passed=false;report.failure={message:e.message,stack:e.stack};if(page){await state('failure').catch(()=>{});await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}}
finally{
 for(const x of pending){x.res.destroy()}pending=[];stream?.destroy()
 if(context)await context.tracing.stop({path:path.join(out,'trace.zip')});await context?.close();await browser?.close();await server?.close()
 report.cleanup={browserDisconnected:!browser?.isConnected(),loopbackServerClosed:!server?.httpServer?.listening,installerCalls:report.requests.filter(r=>/install|uninstall|upgrade/.test(r.cmd)).length}
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
}
console.log(JSON.stringify({passed:report.passed,failure:report.failure?.message,steps:report.steps.map(({label,input,disabled,profile})=>({label,input,disabled,profile})),output:out},null,2))
process.exitCode=report.passed?0:1
