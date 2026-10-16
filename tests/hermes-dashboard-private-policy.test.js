import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { HERMES_PRIVATE_LAUNCH_SCRIPT as script } from '../scripts/hermes-pm-runtime.js'

test('Dashboard 生命周期保留私有 policy，所有原始 aliases 在退出时还原', () => {
  assert.match(script, /def install_private_runtime_policy\(/)
  assert.match(script, /restore_policy = install_private_runtime_policy\(/)
  assert.match(script, /finally:\n\s+if restore_identity is not None:\n\s+restore_identity\(\)\n\s+restore_policy\(\)/)
  assert.match(script, /profiles, '_get_wrapper_dir'/)
  assert.match(script, /launchers, 'runtime_command'/)
  assert.match(script, /dashboard, '_route_named_profile_dashboard'/)
  assert.doesNotMatch(script, /subprocess\.Popen\s*=|os\.execvpe\s*=/)
})

test('普通参数只留一个已核验 profile，拒绝重复 selector，保留 -- passthrough', () => {
  assert.match(script, /multiple profile selectors/)
  assert.match(script, /_scan_profile_flag'\]\(sys\.argv\[1:\]\)/)
  assert.match(script, /sys\.argv = \['hermes', '--profile', get_active_profile_name\(\), \*selected_argv\]/)
})

test('隔离 policy：延迟 boot、私有 alias、子进程和 default reroute 不绕 guard', (t) => {
  assert.match(script, /def install_private_runtime_policy\(/)
  const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  if (spawnSync(python, ['--version']).status !== 0) return t.skip('Python contract runtime 缺失；不代表 Windows 资格')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-dashboard-policy-'))
  try {
    const filename = path.join(dir, 'launch.py')
    fs.writeFileSync(filename, script)
    const result = spawnSync(python, ['-I', '-B', '-c', String.raw`
import ast, inspect, json, os, subprocess, sys, tempfile, types
from pathlib import Path
tree=ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
ns={'Path':Path,'inspect':inspect,'os':os,'sys':sys,'subprocess':subprocess,'PIN':'fixture-pin'}
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'require','install_private_runtime_policy'}],type_ignores=[]),'<real-policy>','exec'),ns)
package=types.ModuleType('hermes_cli'); package.__path__=[];sys.modules['hermes_cli']=package
mods={}
for name in ('_launchers','_install_repair','post_update','update_cmd_maint','profiles','main_dashboard'):
 m=types.ModuleType('hermes_cli.'+name);mods[name]=m;setattr(package,name,m);sys.modules[m.__name__]=m
launch,repair,post,maint,profiles,dashboard=[mods[k] for k in mods]
events=[]
def expose(project_root=None,*,create=True):events.append('GLOBAL-expose');return {'ok':True}
def migrate(root,*,windows=None,read_user_path=None,write_user_path=None):events.append('GLOBAL-path');return True
def runtime(repo_root,args=(),*,module='hermes_cli.main',code=None,python=None,home=None):return ['UNGUARDED',*args]
launch.expose_cli=post.expose_cli=expose;repair.migrate_windows_bin_path=migrate;launch.runtime_command=runtime
post.HOME_STEPS=(('migrate',lambda:{'ok':True}),('expose_cli',expose));post.BOOT_HOME_STEPS=post.HOME_STEPS
maint._ensure_fhs_path_guard=lambda:events.append('GLOBAL-FHS')
captured=[]
fake_process=types.SimpleNamespace(Popen=lambda argv,**kw:captured.append((argv,kw)))
route_globals={'sys':sys,'subprocess':fake_process,'os':os}
exec("def route(args, _headless_backend, _ssh_owner_nonce, _token_file):\n return subprocess.Popen([sys.executable,'-m','hermes_cli.main','-p','default','dashboard','--open-profile','named'],env={'HERMES_HOME':'fixture-default'})",route_globals)
dashboard._route_named_profile_dashboard=route_globals['route']
with tempfile.TemporaryDirectory() as tmp:
 home=Path(tmp)/'home';home.mkdir();root=home/'hermes-agent';root.mkdir()
 python=home/'tools'/'python.exe';python.parent.mkdir();python.touch()
 launch.resolve_store_python=lambda root,publication=True:python
 profiles._get_wrapper_dir=lambda:Path(tmp)/'GLOBAL-bin'
 saved=(launch.expose_cli,launch.runtime_command,profiles._get_wrapper_dir,dashboard._route_named_profile_dashboard,post.BOOT_HOME_STEPS)
 restore=ns['install_private_runtime_policy'](root,home,'FIXTURE-PRIVATE-LAUNCH',False)
 assert post.BOOT_HOME_STEPS[-1][1]()['skipped']=='clawpanel-private-managed'
 assert not events
 alias=profiles._get_wrapper_dir()/'named.bat';alias.parent.mkdir(parents=True);alias.write_text('fixture alias')
 assert alias.is_relative_to(home) and not (Path(tmp)/'GLOBAL-bin').exists()
 child=launch.runtime_command(root,['-p','named','gateway','run'])
 assert 'FIXTURE-PRIVATE-LAUNCH' in child and child[-4:]==['-p','named','gateway','run']
 assert child.count('-p')==1 and child.count('--profile')==0
 dashboard._route_named_profile_dashboard(None,False,'','')
 command,env=captured[-1]
 assert 'FIXTURE-PRIVATE-LAUNCH' in command
 assert command[-5:]==['-p','default','dashboard','--open-profile','named']
 assert env['env']['HERMES_HOME']=='fixture-default'
 assert subprocess.Popen is ns['subprocess'].Popen
 try:launch.runtime_command(Path(tmp)/'foreign',['profile','list'])
 except RuntimeError:pass
 else:raise AssertionError('foreign checkout accepted')
 restore()
 assert (launch.expose_cli,launch.runtime_command,profiles._get_wrapper_dir,dashboard._route_named_profile_dashboard,post.BOOT_HOME_STEPS)==saved
print(json.dumps({'kind':'isolated-policy-not-Windows-runtime','passed':6}))
`, filename], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(JSON.parse(result.stdout).passed, 6)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
