import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import test from 'node:test'
import { HERMES_PRIVATE_LAUNCH_SCRIPT as script, HERMES_PRIVATE_COMPLETION_SCRIPT as completion } from '../scripts/hermes-pm-runtime.js'

// 固定d923原rename/delete/cleanup函数原文，压缩仅避免复制整份vendor；不连接宿主任务服务。
const original = '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'
const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const fixture = String.raw`
import ast,base64,contextlib,contextvars,inspect,json,os,re,shutil,subprocess,sys,tempfile,types,zlib
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8');sys.stderr.reconfigure(encoding='utf-8')
source=Path(sys.argv[1]).read_text(encoding='utf-8'); tree=ast.parse(source); mode=sys.argv[2]
ns={'Path':Path,'inspect':inspect,'os':os,'sys':types.SimpleNamespace(platform='win32',modules=sys.modules,stderr=sys.stderr),'subprocess':subprocess,'json':json,'re':re,'PIN':'d923a5eb487a17c0a68801bba9ef0f56c81040a8'}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'require','windows_task_presence','install_private_profile_task_policy'}]
for n in tree.body:
 if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='WINDOWS_TASK_QUERY' for t in n.targets):nodes.insert(0,n)
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual-private-policy>','exec'),ns)
package=types.ModuleType('hermes_cli');package.__path__=[];sys.modules['hermes_cli']=package
mods={}
for name in ['profiles','profiles_service_cleanup','gateway_windows','gateway']:
 m=types.ModuleType('hermes_cli.'+name);m.__package__='hermes_cli';mods[name]=m;setattr(package,name,m);sys.modules[m.__name__]=m
p,cleanup,gw,gateway=[mods[n] for n in mods]
constants=types.ModuleType('hermes_constants'); active=contextvars.ContextVar('home')
constants.set_hermes_home_override=lambda home:active.set(Path(home));constants.reset_hermes_home_override=active.reset;constants.hermes_home_key=lambda home:str(home);sys.modules['hermes_constants']=constants
platform=types.ModuleType('platform');platform.system=lambda:'Windows';sys.modules['platform']=platform
life=types.ModuleType('tools.mcp_tool_lifecycle');life.shutdown_mcp_servers=lambda **kw:None;sys.modules['tools.mcp_tool_lifecycle']=life
identity=types.ModuleType('hermes_cli.profile_identity');identity._migrate_profile_identity=lambda *a:None;sys.modules['hermes_cli.profile_identity']=identity
payload=json.loads(zlib.decompress(base64.b64decode(sys.argv[3])))
with tempfile.TemporaryDirectory() as temp:
 home=Path(temp)/'home';home.mkdir(); root=home/'hermes-agent';root.mkdir(); profiles=home/'profiles';profiles.mkdir()
 old=profiles/'named';old.mkdir();(old/'config.yaml').write_text('sentinel')
 aliases=home/'bin';aliases.mkdir();(aliases/'named.cmd').write_text('alias')
 startup=Path(temp)/'foreign-startup';startup.mkdir()
 events=[];tasks={'Hermes_Gateway_named':{'foreignHome':'FOREIGN','disabled':True}}
 def canon(name):
  if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',name):raise ValueError('name')
  return name
 def profile_dir(name):return home if name=='default' else profiles/canon(name)
 def delete_wrapper(name):
  target=aliases/(name+'.cmd')
  if target.exists():target.unlink();return True
  return False
 def noop(*a,**kw):return None
 def task_name():return 'Hermes_Gateway_'+active.get().name
 def run_task(args):
  events.append(args); tasks.pop(args[-1],None);return (0,'','')
 gw.get_task_name=task_name;gw.is_task_registered=lambda:task_name() in tasks;gw._exec_schtasks=run_task
 gw.get_startup_entry_path=lambda:startup/(task_name()+'.vbs');gw._legacy_startup_entry_path=lambda:startup/(task_name()+'.cmd')
 gateway.get_service_name=lambda:'unused';gateway.get_launchd_plist_path=lambda:startup/'unused';gateway.user_systemd_unit_dir=lambda:startup
 cleanup.__dict__.update(os=os,subprocess=subprocess);exec(payload['cleanup'],cleanup.__dict__);cleanup.remove_system_systemd_unit=lambda:False
 p.__dict__.update(os=os,subprocess=subprocess,Path=Path,contextlib=contextlib)
 for name in ['_maybe_unregister_gateway_service','_stop_gateway_process','_stop_profile_backends','_stop_bot_desktop','mark_named_profile_deleted','_notify_multiplexer','_print_delete_summary','_retarget_active_profile','_record_profile_rename','_migrate_honcho_profile_host','_maybe_register_gateway_service']:setattr(p,name,noop)
 p._canon_valid=p.normalize_profile_name=canon;p.get_profile_dir=profile_dir;p._existing_profile_dir=lambda name:(name,profile_dir(name));p._check_gateway_running=lambda home:False;p._find_our_wrapper=lambda name:aliases/(name+'.cmd');p._purge_identity=lambda name:True;p.remove_wrapper_script=delete_wrapper;p._rmtree_make_writable=noop;p._rmtree_with_retry=lambda path,*args:shutil.rmtree(path);p._live_default_multiplexer=lambda:False;p.check_alias_collision=lambda name:False;p.create_wrapper_script=lambda name:(aliases/(name+'.cmd')).write_text('new alias')
 p.set_profile_display_name=lambda name,value:value;p._get_default_hermes_home=lambda:home
 exec(payload['profiles'],p.__dict__)
 before=(p.rename_profile,p.delete_profile,p._cleanup_gateway_service,cleanup.remove_windows_task)
 query=[]
 def presence(name):
  query.append(name)
  if mode in ['collision-delete','collision-rename','dashboard-delete','dashboard-rename']:return {'state':'exists','hresult':None}
  if mode in ['unknown-delete','unknown-rename']:return {'state':'unknown','hresult':'0x80070005'}
  if mode=='race':tasks[name]={'foreignHome':'RACE'}
  return {'state':'missing','hresult':'0x80070002'}
 ns['windows_task_presence']=presence
 if mode=='startup':(startup/'Hermes_Gateway_named.vbs').write_text('foreign startup')
 if mode in ['missing-delete','missing-rename','race','restore','signature','alias']:tasks.clear()
 install=ns.get('install_private_profile_task_policy')
 if mode=='nonwindows':ns['sys'].platform='linux'
 if mode=='signature':
  p.rename_profile=lambda wrong:None
  try:install(root,home)
  except (RuntimeError,TypeError):pass
  else:raise AssertionError('changed signature accepted')
  print(json.dumps({'mode':mode,'passed':True}));raise SystemExit()
 if mode=='alias':
  imported=types.ModuleType('hermes_cli.stale_fixture');imported.rename_profile=p.rename_profile;sys.modules[imported.__name__]=imported
 restore=install(root,home) if install else lambda:None
 if mode in ['restore','nonwindows']:
  restore();assert (p.rename_profile,p.delete_profile,p._cleanup_gateway_service,cleanup.remove_windows_task)==before
  if mode=='nonwindows':assert not query
 else:
  if mode in ['dashboard-delete','dashboard-rename']:
   import asyncio
   class HTTPException(Exception):
    def __init__(self,status_code,detail):self.status_code,self.detail=status_code,detail
   async def threadpool(fn,*a,**kw):return fn(*a,**kw)
   scope={'HTTPException':HTTPException,'ProfileIdentitySettlementPending':type('Pending',(Exception,),{}),'ProfileRename':object,'run_in_threadpool':threadpool,'_log':types.SimpleNamespace(exception=lambda *a:None)}
   exec(payload['api'],scope);scope['_profile_errors']=contextlib.contextmanager(scope['_profile_errors'])
   try:asyncio.run(scope['delete_profile_endpoint']('named') if mode.endswith('delete') else scope['rename_profile_endpoint']('named',types.SimpleNamespace(new_name='renamed')))
   except HTTPException as error:assert error.status_code==500 and 'private profile mutation blocked' in error.detail
   else:raise AssertionError('Dashboard direct API bypassed policy')
   assert old.is_dir() and (aliases/'named.cmd').is_file() and tasks['Hermes_Gateway_named']['foreignHome']=='FOREIGN' and not events
  elif mode in ['collision-delete','unknown-delete','collision-rename','unknown-rename','startup']:
   operation=p.delete_profile if mode.endswith('delete') or mode=='startup' else p.rename_profile
   try:operation('named',yes=True) if mode.endswith('delete') or mode=='startup' else operation('named','renamed')
   except RuntimeError as error:assert 'private' in str(error).lower() and any(word in str(error).lower()for word in ['task','query','startup'])
   else:raise AssertionError('conflicting mutate allowed')
   assert old.is_dir() and (old/'config.yaml').read_text()=='sentinel' and (aliases/'named.cmd').read_text()=='alias'
   assert tasks['Hermes_Gateway_named']['foreignHome']=='FOREIGN' and not events
   if mode=='startup':assert (startup/'Hermes_Gateway_named.vbs').read_text()=='foreign startup'
  elif mode=='alias':
   assert imported.rename_profile is p.rename_profile
  elif mode in ['missing-delete','missing-rename','race']:
   if mode=='missing-delete':p.delete_profile('named',yes=True);assert not old.exists()
   else:p.rename_profile('named','renamed');assert not old.exists() and (profiles/'renamed'/'config.yaml').read_text()=='sentinel'
   assert not events,'system cleanup must never execute, even after a missing query'
   if mode=='race':assert tasks,'late foreign task was deleted'
  restore()
 print(json.dumps({'mode':mode,'passed':True,'systemMutations':len(events),'queries':query}))
`
function runFixture(mode) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-profile-task-policy-'))
 try {
  const file=path.join(dir,'launch.py');fs.writeFileSync(file,script)
  const result=spawnSync(python,['-I','-B','-c',fixture,file,mode,original],{encoding:'utf8',timeout:15000})
  assert.equal(result.status,0,result.stderr||result.stdout)
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).passed,true)
 } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
}
for(const mode of ['collision-delete','collision-rename','unknown-delete','unknown-rename','missing-delete','missing-rename','race','restore','signature','alias','dashboard-delete','dashboard-rename','startup','nonwindows'])test('固定22.2原函数隔离任务边界 '+mode,()=>runFixture(mode))
test('仅LAUNCH边界固定source/signature，COM只读missing明确区分，completion currency不改',()=>{
 assert.match(script,/profiles_service_cleanup\.py/);assert.match(script,/gateway_windows\.py/)
 assert.match(script,/GetTask/);assert.match(script,/80070002/);assert.doesNotMatch(script,/\.DeleteTask\(/)
 assert.match(script,/restore_profile_policy/)
 assert.match(script,/restore_profile_policy = install_private_profile_task_policy\(root, home\)/)
 assert.ok(script.indexOf('restore_profile_policy = install_private_profile_task_policy(root, home)')<script.indexOf("runpy.run_module('hermes_cli.main'"))
 assert.match(script,/return \[str\(selected\), '-I', '-B', '-c', launch_script/)
 assert.match(completion,/def prepare_currency_checker\(/)
 // 只允许另行真实验证的Windows参数转义差异；PM currency/原completion主体逐字保持。
 const currencyUnchanged = completion.replace(/def reexec_selected_python\(python\):[^]*?\n\n\n/, '').replace('    reexec_selected_python(store_python)', '    os.execv(str(store_python), [str(store_python), *sys.orig_argv[1:]])')
 assert.equal(crypto.createHash('sha256').update(currencyUnchanged).digest('hex'),'05d7cde012fe3800e0197682b51860ee9280f6f5bbdf7e77ca438f0a1f118e0a')
})

test('只读查询backend：非0/timeout/坏JSON/accessDenied不伪装missing，子env不改父env',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-task-query-'))
 try {
  const file=path.join(dir,'launch.py');fs.writeFileSync(file,script)
  const result=spawnSync(python,['-I','-B','-c',String.raw`
import ast,json,os,re,subprocess,sys,types,base64
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'));ns={'Path':Path,'json':json,'os':os,'re':re}
nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)and n.name in {'require','windows_task_presence'}]
nodes[:0]=[n for n in tree.body if isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='WINDOWS_TASK_QUERY' for t in n.targets)]
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual-query>','exec'),ns)
os.environ['PsModulePath']='fixture-parent';before=dict(os.environ);calls=[]
def run(args,**kw):
 calls.append((args,kw));assert args[1:4]==['-NoProfile','-NonInteractive','-EncodedCommand']
 assert base64.b64decode(args[4]).decode('utf-16le')==ns['WINDOWS_TASK_QUERY']
 assert all(k.lower()!='psmodulepath' for k in kw['env']);assert kw['env']['CLAWPANEL_HERMES_TASK_QUERY_NAME']=='Hermes_Gateway_fixture'
 if current=='timeout':raise subprocess.TimeoutExpired(args,10)
 return types.SimpleNamespace(returncode=code,stdout=body,stderr='fixture')
ns['subprocess']=types.SimpleNamespace(run=run,TimeoutExpired=subprocess.TimeoutExpired)
cases=[('missing',0,'{"state":"missing","hresult":"0x80070002"}','missing'),('exists',0,'{"state":"exists","hresult":null}','exists'),('denied',0,'{"state":"missing","hresult":"0x80070005"}','unknown'),('bad',0,'{bad','unknown'),('exit',1,'{"state":"missing","hresult":"0x80070002"}','unknown'),('timeout',0,'','unknown'),('unknown',0,'{"state":"unknown","hresult":"0x80070002"}','unknown')]
for current,code,body,expected in cases:assert ns['windows_task_presence']('Hermes_Gateway_fixture')['state']==expected
assert dict(os.environ)==before
try:ns['windows_task_presence']('foreign/task')
except RuntimeError:pass
else:raise AssertionError('name contract relaxed')
print(json.dumps({'passed':len(cases),'query':ns['WINDOWS_TASK_QUERY']}))
`,file],{encoding:'utf8',timeout:15000})
  assert.equal(result.status,0,result.stderr||result.stdout);assert.equal(JSON.parse(result.stdout).passed,7)
 } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
})

test('COM脚本只在GetTask明确missing时放行：全程Fake COM，无真实宿主任务查询',t=>{
 if(process.platform!=='win32')return t.skip('仅Windows PowerShell运行隔离COM桩，不代表实际任务资格')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hermes-task-com-'))
 try {
  const file=path.join(dir,'launch.py');fs.writeFileSync(file,script)
  const extract=spawnSync(python,['-I','-B','-c',"import ast,json,sys;from pathlib import Path;t=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'));n=next(n for n in t.body if isinstance(n,ast.Assign)and any(isinstance(x,ast.Name)and x.id=='WINDOWS_TASK_QUERY'for x in n.targets));print(json.dumps(ast.literal_eval(n.value)))",file],{encoding:'utf8'})
  assert.equal(extract.status,0,extract.stderr);const query=JSON.parse(extract.stdout)
  for(const [stage,code,state]of [['lookup',0,'exists'],['lookup',-2147024894,'missing'],['lookup',-2147024891,'unknown'],['connect',-2147024894,'unknown'],['folder',-2147024894,'unknown']]){
   const prefix=String.raw`
$global:FixtureStage='__STAGE__';$global:FixtureCode=__CODE__;$global:FixtureFactories=0
$global:FixtureFolder=[pscustomobject]@{}
$global:FixtureFolder|Add-Member ScriptMethod GetTask {param($name) if($global:FixtureStage -eq 'lookup' -and $global:FixtureCode -ne 0){throw [Runtime.InteropServices.COMException]::new('fixture',$global:FixtureCode)};return [pscustomobject]@{Name=$name}}
$global:FixtureService=[pscustomobject]@{}
$global:FixtureService|Add-Member ScriptMethod Connect {if($global:FixtureStage -eq 'connect'){throw [Runtime.InteropServices.COMException]::new('fixture',$global:FixtureCode)}}
$global:FixtureService|Add-Member ScriptMethod GetFolder {param($path) if($global:FixtureStage -eq 'folder'){throw [Runtime.InteropServices.COMException]::new('fixture',$global:FixtureCode)};return $global:FixtureFolder}
function New-Object {param($ComObject) if($ComObject -ne 'Schedule.Service'){throw 'unexpected factory'};$global:FixtureFactories++;return $global:FixtureService}
`.replace('__STAGE__',stage).replace('__CODE__',String(code))
   const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>k.toLowerCase()!=='psmodulepath'));env.CLAWPANEL_HERMES_TASK_QUERY_NAME='Hermes_Gateway_fixture'
   const body=prefix+query+"\nif($global:FixtureFactories -ne 1){throw 'COM fixture was bypassed'}"
   const r=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(body,'utf16le').toString('base64')],{env,encoding:'utf8',timeout:15000,windowsHide:true})
   assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.replace(/^\uFEFF/, '')).state,state,stage+' '+code)
  }
 } finally {assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true})}
})
