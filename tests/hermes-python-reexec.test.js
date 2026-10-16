import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { HERMES_PRIVATE_COMPLETION_SCRIPT, HERMES_PRIVATE_LAUNCH_SCRIPT, HERMES_PRIVATE_METADATA_SCRIPT } from '../scripts/hermes-pm-runtime.js'

// 只提取实际适配器函数到独立Python；不运行PM、安装器、任务查询或真实HOME路径。
const harness = String.raw`
import ast,json,os,subprocess,sys,types
d=json.loads(sys.argv[1]);tree=ast.parse(d['script'])
target='route_execvpe' if d['mode']=='route' else 'reexec_selected_python'
node=next((n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==target),None)
assert node is not None,'缺少跨平台selected Python reexec入口'
ns={'os':os,'subprocess':subprocess,'sys':sys}
exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual-private-reexec>','exec'),ns)
fn=ns[target]
if d['mode']=='posix-contract':
 calls=[]
 ns['os']=types.SimpleNamespace(name='posix',execv=lambda p,a:calls.append([p,a]))
 sys.orig_argv=['old-python','-I','-B','-c','actual code','a b']
 fn('selected-python')
 assert calls==[['selected-python',['selected-python','-I','-B','-c','actual code','a b']]]
 print(json.dumps({'posixExecReplaced':True}))
else:
 code='# explicit multiline command\nimport json,sys; print(json.dumps({"marker":"完整 空格", "args":sys.argv[1:]},ensure_ascii=True));sys.exit('+str(d['exit'])+')'
 sys.orig_argv=['old-python','-I','-B','-c',code,'a b','quote"value','尾巴']
 if d['mode']=='route':
  ns.update(route_os=os,require=lambda condition,message:None if condition else (_ for _ in ()).throw(AssertionError(message)),guarded_route_command=lambda original:[sys.executable,*sys.orig_argv[1:]])
  fn(sys.executable,['original-dashboard-command'],dict(os.environ))
 else:
  fn(sys.executable)
 raise AssertionError('selected Python return must terminate the old adapter')
`
for (const [name, script] of [['completion', HERMES_PRIVATE_COMPLETION_SCRIPT], ['launch', HERMES_PRIVATE_LAUNCH_SCRIPT], ['metadata', HERMES_PRIVATE_METADATA_SCRIPT]]) {
  test(`${name}实际函数：Windows保留多行-c/空格/引号/Unicode并同步传播selected Python退出码`, () => {
    assert.match(script, /def reexec_selected_python\(python\):/)
    assert.match(script, /reexec_selected_python\((?:store_python|python)\)/)
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['path','systemroot','windir','temp','tmp','userprofile'].includes(k.toLowerCase())))
    env.PYTHONUTF8 = '1'
    for (const exit of [0, 7]) {
      const r = spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-I', '-B', '-c', harness, JSON.stringify({ script, mode: 'actual', exit })], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
      assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, exit, r.stderr)
      assert.deepEqual(JSON.parse(r.stdout), { marker: '完整 空格', args: ['a b', 'quote"value', '尾巴'] })
    }
    const p = spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-I', '-B', '-c', harness, JSON.stringify({ script, mode: 'posix-contract' })], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), { posixExecReplaced: true })
  })
}

test('Dashboard/profile route实际execvpe同样保留Windows多行受管脚本并同步等待', () => {
  for (const exit of [0, 7]) {
    const r = spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-I', '-B', '-c', harness, JSON.stringify({ script: HERMES_PRIVATE_LAUNCH_SCRIPT, mode: 'route', exit })], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(r.status, exit, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { marker: '完整 空格', args: ['a b', 'quote"value', '尾巴'] })
  }
})
