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
import sys,os,time,pathlib,subprocess,json,types
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2];source=pathlib.Path(sys.argv[3]);marker=root/'closed';state={'closes':0,'polls':0};children=[]
class Job:
 def close(self):
  state['closes']+=1;marker.write_text('closed')
def spawn_server(argv,**kw):
 if mode=='spawn-error':raise OSError('fixture spawn failed')
 code="import time,pathlib,sys; sys.stdout.reconfigure(encoding='utf-8'); m=pathlib.Path(sys.argv[1]); print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); end=time.monotonic()+4;\nwhile not m.exists() and time.monotonic()<end:time.sleep(.01)"
 if mode not in ('timeout','legacy-timeout'):
  keeper=code.replace("print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); ","")
  code="import subprocess,sys; sys.stdout.reconfigure(encoding='utf-8'); subprocess.Popen([sys.executable,'-I','-B','-c',"+repr(keeper)+",sys.argv[1]],stdout=sys.stdout,stderr=sys.stderr); print('CommandLine=中文',flush=True); print('ProcessId=42',flush=True); print('parent-complete',flush=True)"
 p=subprocess.Popen([sys.executable,'-I','-B','-c',code,str(marker)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,stdin=subprocess.DEVNULL,text=True,encoding='utf8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
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
if restore:restore()
marker.write_text('closed')
for p in children:
 try:p.communicate(timeout=2)
 except Exception:p.kill();p.communicate(timeout=2)
print(json.dumps({'result':result,'error':error,'elapsed':elapsed,'state':state,'restored':c.bounded_probe_run is old and g._windows_process_listing is listing}))
`
  const r = spawnSync(process.env.PYTHON || 'python', ['-I', '-B', '-c', driver, dir, mode, module], { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 1048576 })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
test('父进程已退出、后代仍持管道时先关闭自有 Job，不白等原预算；完整 UTF8 与返回值保留', { timeout: 10000 }, t => {
  const r = probe(t, 'inherited-pipe')
  assert.equal(r.error, null); assert.match(r.result || '', /CommandLine=中文/); assert.match(r.result, /parent-complete/)
  assert.ok(r.elapsed < .65, JSON.stringify(r)); assert.equal(r.state.closes, 1); assert.equal(r.restored, true)
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
