import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import * as runtime from '../scripts/hermes-pm-runtime.js'

test('显式 completion 先准备选中工具链的独立 checker，再保留严格 current guard', t => {
  const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  if (spawnSync(python, ['--version']).status !== 0) return t.skip('需要 Python 策略执行器；不是实际安装通过')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-pm-currency-'))
  try {
    const filename = path.join(dir, 'completion.py')
    fs.writeFileSync(filename, runtime.HERMES_PRIVATE_COMPLETION_SCRIPT)
    const result = spawnSync(python, ['-I', '-B', '-c', String.raw`
import ast, json, os, sys, tempfile, types
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
definitions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'require','prepare_currency_checker','require_pm_current'}]
start=next(i for i,n in enumerate(tree.body) if isinstance(n,ast.ImportFrom) and n.module=='pm.environments' and any(a.name=='activate_dependencies' for a in n.names))
stop=next(i for i,n in enumerate(tree.body[start:],start) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and n.value.func.id=='require' and any(isinstance(c,ast.Constant) and c.value=='maintenance aliases were imported before private policy' for c in ast.walk(n)))
flow=tree.body[start:stop]
pm=types.ModuleType('pm');pm.__path__=[];sys.modules['pm']=pm
mods={}
for name in ['environments','_uv','runtime','package']:
 m=types.ModuleType('pm.'+name);mods[name]=m;sys.modules[m.__name__]=m
events=[];state={}
class InstallError(Exception):
 def __init__(self,package):self.package=package
mods['package'].InstallError=InstallError
mods['environments'].activate_dependencies=lambda root:events.append('activate')
mods['environments'].install_state_dir=lambda root:home/'installs'/'owned'
mods['environments'].running_from_selected_environment=lambda root:True
mods['_uv']._toolchain=lambda **kw:None if state.get('missing') else (uv,foreign if state.get('foreign') else store)
def prepare(uv_arg,python_arg,destination,**kw):
 assert uv_arg==uv and python_arg==store and destination==home/'installs'/'owned'/'pm-runtime'
 assert kw.get('bootstrap',True) is True
 events.append('prepare-checker');state['ready']=True
 return foreign if state.get('escape') else manager
mods['runtime'].prepare_runtime=prepare
def runtime_python(**kw):
 assert kw.get('bootstrap') is False
 if not state.get('ready'):raise InstallError('pm-runtime')
 return manager
mods['runtime'].runtime_python=runtime_python
pm.venv_is_current=lambda **kw:state.get('app',True) if state.get('ready') else False
passed=[]
with tempfile.TemporaryDirectory() as tmp:
 home=Path(tmp)/'home';home.mkdir();root=home/'hermes-agent';root.mkdir()
 store=home/'tools'/'python'/'bin'/'python3';store.parent.mkdir(parents=True);store.touch()
 uv=home/'tools'/'uv'/'uv';uv.parent.mkdir(parents=True);uv.touch()
 manager=home/'installs'/'owned'/'pm-runtime'/'generations'/'real-api'/'bin'/'python3';manager.parent.mkdir(parents=True);manager.touch()
 foreign=Path(tmp)/'foreign-python';foreign.touch()
 for name,initial,should_fail in [
  ('cold-checker',{},False),('warm-checker',{'ready':True},False),
  ('stale-app',{'app':False},True),('unknown-app',{'app':None},True),
  ('missing-toolchain',{'missing':True},True),('foreign-python',{'foreign':True},True),
  ('foreign-checker',{'escape':True},True)]:
  state.clear();state.update(initial);events.clear()
  ns={'Path':Path,'os':os,'sys':sys,'json':json,'root':root,'home':home,'store_python':store}
  exec(compile(ast.Module(body=definitions,type_ignores=[]),'<actual-completion-functions>','exec'),ns)
  try:exec(compile(ast.Module(body=flow,type_ignores=[]),'<actual-completion-flow>','exec'),ns)
  except RuntimeError as error:
   if not should_fail:raise AssertionError(name+': '+str(error))
  else:
   if should_fail:raise AssertionError(name+': unsafe state accepted')
   assert 'prepare-checker' in events
  passed.append(name)
print(json.dumps({'kind':'isolated-completion-flow-not-runtime','passed':passed}))
`, filename], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).passed.length, 7)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('checker 准备仅显式 completion；metadata/ordinary CLI 不放开 bootstrap', () => {
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /def prepare_currency_checker\(/)
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /_toolchain\(realize=False\)/)
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /prepare_runtime\(/)
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /pm\.venv_is_current\(project_root=root\) is True/)
  assert.doesNotMatch(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /\.write_text\(|write_source_stamp\(|\.unlink\(/)
  for (const script of [runtime.HERMES_PRIVATE_METADATA_SCRIPT, runtime.HERMES_PRIVATE_LAUNCH_SCRIPT]) {
    assert.doesNotMatch(script, /prepare_currency_checker|prepare_runtime\(|runtime_python\(bootstrap=True\)/)
    assert.match(script, /venv_is_current\(project_root=root\)/)
  }
})

test('currency 失败导出有限诊断原因，不打印 HOME/env/facts 内容', () => {
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /def require_pm_current\(/)
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /checkerReady/)
  assert.match(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /selectedDependenciesActive/)
  assert.doesNotMatch(runtime.HERMES_PRIVATE_COMPLETION_SCRIPT, /dict\(os\.environ\)|json\.dumps\(os\.environ|json\.dumps\(facts/)
})
