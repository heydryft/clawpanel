import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// 真实自有 Python 父子进程/继承管道；协作 marker 模拟关闭自有 Job。
// 不执行 Hermes、PowerShell、安装器或系统任务；实际 Windows Job 另须托管 VM 验收。
function probe(t, mode) {
  const base = fs.realpathSync.native(os.tmpdir()), dir = fs.mkdtempSync(path.join(base, 'hermes-cim-pipe-'))
  t.after(() => { assert.equal(path.dirname(fs.realpathSync.native(dir)), base); fs.rmSync(dir, { recursive: true, force: true }) })
  const module = path.resolve('scripts/hermes-windows-cim-probe.py')
  const driver = String.raw`
import sys,os,time,pathlib,subprocess,json,types,importlib.util,importlib.abc
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2];source=pathlib.Path(sys.argv[3]);marker=root/'closed';state={'closes':0,'polls':0};children=[]
if os.environ.get('CLAWPANEL_TEST_NO_PSUTIL')=='1':
 class DenyPsutil(importlib.abc.MetaPathFinder):
  def find_spec(self,fullname,*a):
   if fullname=='psutil':raise ModuleNotFoundError('fixture optional diagnostic module absent')
 sys.meta_path.insert(0,DenyPsutil())
try:state['psutilAvailable']=importlib.util.find_spec('psutil') is not None
except ModuleNotFoundError:state['psutilAvailable']=False
if mode=='observe-timeout':os.environ['CLAWPANEL_HERMES_PHASE_TIMING']='1'
os.environ['PSModulePath']='fixture-pwsh7-only-module';os.environ['CLAWPANEL_CIM_ENV_CANARY']='retained';parent_env=dict(os.environ)
class Job:
 def close(self):
  state['closes']+=1;marker.write_text('closed')
def spawn_server(argv,**kw):
 state['query']=argv[3] if len(argv)==4 else None
 state['explicitEnv']=isinstance(kw.get('env'),dict);state['foreignModulePath']=any(k.lower()=='psmodulepath' for k in (kw.get('env') or os.environ));state['otherEnv']=(kw.get('env') or os.environ).get('CLAWPANEL_CIM_ENV_CANARY')
 if mode=='spawn-error':raise OSError('fixture spawn failed')
 code="import time,pathlib,sys; sys.stdout.reconfigure(encoding='utf-8'); m=pathlib.Path(sys.argv[1]); print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); end=time.monotonic()+4;\nwhile not m.exists() and time.monotonic()<end:time.sleep(.01)"
 if mode not in ('timeout','legacy-timeout','observe-timeout'):
  keeper=code.replace("print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); ","")
  code="import subprocess,sys; sys.stdout.reconfigure(encoding='utf-8'); subprocess.Popen([sys.executable,'-I','-B','-c',"+repr(keeper)+",sys.argv[1]],stdout=sys.stdout,stderr=sys.stderr); print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); print('parent-complete',flush=True)"
 p=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(marker)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,text=True,encoding='utf8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),env=kw.get('env'))
 children.append(p);return p,Job()
def old(argv,*,timeout,errors='replace',**kw):
 p,j=spawn_server(argv)
 try:out,err=p.communicate(timeout=timeout)
 except Exception as e:
  state['timeout']=isinstance(e,subprocess.TimeoutExpired);state['directExitBeforeClose']=p.poll();j.close();out,err=p.communicate(timeout=2);state['drained']=out;state['drainError']=err;return None
 j.close();return subprocess.CompletedProcess(argv,p.returncode,out,err)
c=types.SimpleNamespace(bounded_probe_run=old,windows_hide_flags=lambda:0,_close_job=lambda j:j.close() if j else None,kill_and_drain=lambda p,s:p.communicate(timeout=s))
if mode=='legacy-timeout':
 del c.kill_and_drain
 def legacy_cleanup(proc):state['legacyCleanup']=state.get('legacyCleanup',0)+1
 c.kill_process_tree=legacy_cleanup
g=types.SimpleNamespace()
query="""Get-CimInstance Win32_Process | ForEach-Object {   'CommandLine=' + ($_.CommandLine -replace "<BT>r<BT>n",' ' -replace "<BT>n",' ');   'ProcessId=' + $_.ProcessId;   '' }""".replace('<BT>',chr(96))
argv=['powershell.exe','-NoProfile','-Command',query]
def listing():
 if mode=='listing-error':raise ValueError('fixture unknown inventory')
 if mode=='empty-result':return ''
 r=c.bounded_probe_run(argv,timeout=.7,errors='ignore');return None if r is None or r.returncode else r.stdout
g._windows_process_listing=listing
restore=None
if source.exists():
 exec(compile(source.read_text(encoding='utf8'),str(source),'exec'))
 restore=install_windows_cim_probe(g,c,spawn_server,platform='nt')
started=time.monotonic();error=None;result=None
try:result=g._windows_process_listing()
except BaseException as e:error={'type':type(e).__name__,'message':str(e)}
elapsed=time.monotonic()-started
state['childReturncodes']=[p.poll() for p in children]
state['parentEnvUnchanged']=dict(os.environ)==parent_env
if restore:restore()
marker.write_text('closed')
for p in children:
 try:p.communicate(timeout=2)
 except Exception:p.kill();p.communicate(timeout=2)
print(json.dumps({'result':result,'error':error,'elapsed':elapsed,'state':state,'restored':c.bounded_probe_run is old and g._windows_process_listing is listing}))
`
  const r = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-B', '-c', driver, dir, mode, module], { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 1048576 })
  assert.equal(r.status, 0, r.stderr)
  const result = JSON.parse(r.stdout)
  result.observation = r.stderr.split(/\r?\n/).filter(s => s.startsWith('CLAWPANEL_HERMES_CIM_PROBE ')).map(s => JSON.parse(s.slice('CLAWPANEL_HERMES_CIM_PROBE '.length)))
  return result
}
test('父进程已退出、后代仍持管道时先关闭自有 Job，不白等原预算；完整 UTF8 与返回值保留', { timeout: 10000 }, t => {
  const r = probe(t, 'inherited-pipe')
  assert.equal(r.error, null); assert.match(r.result || '', /CommandLine=中文/); assert.match(r.result, /parent-complete/)
  assert.ok(r.elapsed < .65, JSON.stringify(r)); assert.equal(r.state.closes, 1); assert.equal(r.restored, true)
})

test('固定CIM调用只投影原来实际使用的两个字段，仍遍历全进程，不减少冲突检查', { timeout: 10000 }, t => {
  const r = probe(t, 'inherited-pipe')
  assert.match(r.state.query, /Get-CimInstance Win32_Process -Property ProcessId,CommandLine/)
  assert.doesNotMatch(r.state.query, /-Filter|-Query|Where-Object|Select-Object|-ErrorAction\s+(?:Ignore|Continue|SilentlyContinue)/)
  assert.match(r.state.query, /'CommandLine='/); assert.match(r.state.query, /'ProcessId='/)
})
test('实际子进程未退出仍守原 deadline，未知列表明确失败，不把空集合当无冲突', { timeout: 10000 }, t => {
  const r = probe(t, 'timeout')
  assert.equal(r.result, null); assert.equal(r.error?.type, 'SystemExit'); assert.ok(r.elapsed >= .65 && r.elapsed < 2)
  assert.equal(r.restored, true)
})
test('spawn 失败不假装成功，restore 不改原生对象', { timeout: 10000 }, t => {
  const r = probe(t, 'spawn-error')
  assert.equal(r.result, null); assert.equal(r.error?.type, 'SystemExit'); assert.equal(r.restored, true)
})

test('未知列表内部异常也要拦截启动，不被上游 Exception fail-open', { timeout: 10000 }, t => {
  const r = probe(t, 'listing-error')
  assert.equal(r.error?.type, 'SystemExit'); assert.equal(r.result, null); assert.equal(r.restored, true)
})

test('旧兼容层没有 kill_and_drain 时仍执行原有有界树清理，不泄漏异常帮助进程', { timeout: 10000 }, t => {
  const r = probe(t, 'legacy-timeout')
  assert.equal(r.error?.type, 'SystemExit'); assert.equal(r.state.legacyCleanup, 1); assert.ok(r.elapsed < 2)
  assert.equal(r.restored, true)
})

test('实际deadline失败只记录数值/类型/直接子进程状态，不打印argv输出或异常消息', { timeout: 10000 }, t => {
  const r = probe(t, 'observe-timeout')
  const failed = r.observation.find(v => v.event === 'failure')
  assert.ok(failed, '原R12库存失败未保留直接子进程状态，机制仍未定位')
  assert.equal(failed.exceptionType, 'TimeoutExpired'); assert.equal(failed.directExitCode, null)
  assert.ok(failed.elapsedMs >= 650 && failed.elapsedMs < 1700)
  assert.ok(failed.pid > 0); assert.equal(r.error?.type, 'SystemExit')
  for (const row of r.observation) for (const key of Object.keys(row)) assert.ok(['event','pid','elapsedMs','exceptionType','directExitCode','deadlineMs','status','threads','cpuUserMs','cpuSystemMs'].includes(key), key)
  const state = r.observation.find(v => v.event === 'child-state')
  if (r.state.psutilAvailable) {
    assert.ok(state, '实际活子进程必须区分suspended/CPU工作，不能继续猜测管道')
    assert.ok(['running','suspended','stopped','unknown'].includes(state.status))
    assert.ok(Number.isInteger(state.threads) && state.threads > 0)
    assert.ok(Number.isFinite(state.cpuUserMs) && Number.isFinite(state.cpuSystemMs))
  } else {
    // 普通Node CI不安装Hermes依赖；可选只读元数据缺失不准改写已断言的timeout失败。
    assert.equal(state, undefined)
    assert.equal(r.observation.find(v => v.event === 'child-state-unavailable')?.exceptionType, 'ModuleNotFoundError')
    assert.equal(r.error?.type, 'SystemExit'); assert.equal(r.result, null)
  }
})

test('CIM专属PowerShell子环境不继承异版PSModulePath，其他变量和父环境不变', { timeout: 10000 }, t => {
  const r = probe(t, 'inherited-pipe')
  assert.equal(r.state.explicitEnv, true); assert.equal(r.state.foreignModulePath, false)
  assert.equal(r.state.otherEnv, 'retained'); assert.equal(r.state.parentEnvUnchanged, true)
  assert.equal(r.error, null); assert.equal(r.restored, true)
})

test('Windows PS5用本地WMI完整表，Core保留CIM；UTF8和Stop错误策略，不添加远程或提权参数', { timeout: 10000 }, t => {
  const r = probe(t, 'inherited-pipe')
  assert.match(r.state.query, /\$PSVersionTable\.PSEdition -eq 'Desktop'/)
  assert.match(r.state.query, /Get-WmiObject -Class Win32_Process -Property ProcessId,CommandLine/)
  assert.match(r.state.query, /else \{ Get-CimInstance Win32_Process -Property ProcessId,CommandLine \}/)
  assert.match(r.state.query, /\$ErrorActionPreference='Stop'/)
  assert.match(r.state.query, /\[Console\]::OutputEncoding=.*UTF8Encoding/)
  assert.doesNotMatch(r.state.query, /ComputerName|Credential|EnableAllPrivileges|Set-MpPreference|ErrorAction\s+(?:Ignore|Continue)/)
})

test('空进程表不等于没有冲突，保持失败；真实Windows至少有查询进程自身', { timeout: 10000 }, t => {
  const r = probe(t, 'empty-result')
  assert.equal(r.error?.type, 'SystemExit'); assert.equal(r.result, null); assert.equal(r.restored, true)
})
