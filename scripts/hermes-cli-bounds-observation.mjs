// 仅供合成 CLI 边界测试：按原生创建身份观察，不终止被查询的 PID。
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const imageKey = value => path.win32.normalize(String(value || '')).toLowerCase()

export function classifyFixtureIdentitySample({ starts, processes, expectedExecutable }) {
  const receipts = new Map(starts.filter(row => row.event === 'start').map(row => [row.pid, row]))
  const identities = new Map(processes.map(row => [row.pid, row]))
  const classified = []
  for (const [pid, receipt] of receipts) {
    const row = identities.get(pid)
    if (!row) throw new Error(`identity missing for fixture PID ${pid}`)
    if (!['running', 'exited', 'missing'].includes(row.status)) throw new Error(`identity unavailable for fixture PID ${pid}: ${JSON.stringify(row)}`)
    const provedExitWithoutImage = row.status === 'exited' && row.waitResult === 0 && row.exitAtMs > 0 && row.creationTimeFileTimeHex
    if (row.status !== 'missing' && (!row.creationTimeFileTimeHex || (!row.executablePath && !provedExitWithoutImage))) throw new Error(`identity unavailable for fixture PID ${pid}: missing image or creation time`)
    const belongsToFixture = row.status !== 'missing' && Boolean(row.executablePath) && imageKey(row.executablePath) === imageKey(expectedExecutable)
    classified.push({ ...row, receipt, belongsToFixture, newerThanRecordedStart: row.createdAtMs > receipt.at, active: belongsToFixture && row.status === 'running' })
  }
  return { activeCount: classified.filter(row => row.active).length, processes: classified }
}

// 每轮查询仅短暂持有句柄；不跨采样保留句柄，避免人为阻止 PID 复用。
const nativeScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
# 只为这5个只读Win32签名创建内存绑定；不用Add-Type/csc，不启动编译器孩子。
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('FixtureProcessNative')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('native')
$type = $module.DefineType('FixtureNative', 'Public, Abstract, Sealed')
$lastError = $type.DefineField('LastError', [int], 'Public, Static')
function Add-FixtureNativeMethod($name, $returnType, [Type[]]$parameters) {
  $method = $type.DefineMethod(('Native_' + $name), 'Private, Static, PinvokeImpl', $returnType, $parameters)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@([Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'), [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'), [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'))
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@('kernel32.dll'), $fields, [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode, $name))
  $method.SetCustomAttribute($attribute)
  # 必须在同一托管方法内立即保存GetLastWin32Error；回到PS动态binder后错误码可已被覆盖。
  $wrapper = $type.DefineMethod($name, 'Public, Static', $returnType, $parameters)
  $il = $wrapper.GetILGenerator()
  $result = $il.DeclareLocal($returnType)
  for($i=0; $i -lt $parameters.Length; $i++){$il.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]$i)}
  $il.Emit([Reflection.Emit.OpCodes]::Call, $method)
  $il.Emit([Reflection.Emit.OpCodes]::Stloc, $result)
  $il.Emit([Reflection.Emit.OpCodes]::Call, [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error'))
  $il.Emit([Reflection.Emit.OpCodes]::Stsfld, $lastError)
  $il.Emit([Reflection.Emit.OpCodes]::Ldloc, $result)
  $il.Emit([Reflection.Emit.OpCodes]::Ret)
}
Add-FixtureNativeMethod 'OpenProcess' ([IntPtr]) @([uint32], [bool], [int])
Add-FixtureNativeMethod 'GetProcessTimes' ([bool]) @([IntPtr], [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType(), [long].MakeByRefType())
Add-FixtureNativeMethod 'QueryFullProcessImageNameW' ([bool]) @([IntPtr], [uint32], [Text.StringBuilder], [uint32].MakeByRefType())
Add-FixtureNativeMethod 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
Add-FixtureNativeMethod 'CloseHandle' ([bool]) @([IntPtr])
$native = $type.CreateType()
function Fixture-Now { return ([DateTime]::UtcNow.Ticks - 621355968000000000L) / 10000L -as [long] }
function Fixture-Unix([long]$fileTime) { if($fileTime -eq 0){return 0L}; return ([DateTime]::FromFileTimeUtc($fileTime).Ticks - 621355968000000000L) / 10000L -as [long] }
function Read-FixtureIdentity([int]$processId) {
  $row = [ordered]@{pid=$processId;status='error';executablePath=$null;creationTimeFileTimeHex=$null;createdAtMs=0L;exitAtMs=0L;sampledAtMs=0L;nativeError=0;imageQueryError=0;waitResult=[uint32]::MaxValue}
  $handle = $native::OpenProcess(0x00101000, $false, $processId)
  if($handle -eq [IntPtr]::Zero) {
    $row.nativeError=$native::LastError
    if($row.nativeError -eq 87){$row.status='missing'}
    $row.sampledAtMs=Fixture-Now
    return $row
  }
  try {
    [long]$creation=0; [long]$exit=0; [long]$kernel=0; [long]$user=0
    if(-not $native::GetProcessTimes($handle,[ref]$creation,[ref]$exit,[ref]$kernel,[ref]$user)) {
      $row.nativeError=$native::LastError; return $row
    }
    $row.creationTimeFileTimeHex=$creation.ToString('x16'); $row.createdAtMs=Fixture-Unix $creation
    $image = New-Object System.Text.StringBuilder(32768)
    [uint32]$length = $image.Capacity
    $imageOk = $native::QueryFullProcessImageNameW($handle,0,$image,[ref]$length)
    if($imageOk){$row.executablePath=$image.ToString()}else{$row.imageQueryError=$native::LastError}
    # 镜像查询可能正好遇到退出；在同一句柄上后取wait和times，不用旧running状态猜退出。
    # 镜像失败只等待一次最多10ms，让终止中的内核对象完成；仍非signaled则保持红灯。
    $row.waitResult=$native::WaitForSingleObject($handle, $(if($imageOk){0}else{10}))
    if($row.waitResult -ne 0 -and $row.waitResult -ne 258){$row.nativeError=$native::LastError; return $row}
    [long]$finalCreation=0
    if(-not $native::GetProcessTimes($handle,[ref]$finalCreation,[ref]$exit,[ref]$kernel,[ref]$user)) {
      $row.nativeError=$native::LastError; return $row
    }
    if($finalCreation -ne $creation){$row.nativeError=13; return $row}
    if($row.waitResult -eq 0 -and $exit -gt 0){$row.status='exited'; $row.exitAtMs=Fixture-Unix $exit}
    elseif($row.waitResult -eq 258 -and $imageOk){$row.status='running'}
    else{$row.nativeError=$row.imageQueryError}
    return $row
  } finally { $row.sampledAtMs=Fixture-Now; $null=$native::CloseHandle($handle) }
}
# 在ready前预热只读本观察器自身：JIT/JSON不挤占首个实际样本的2秒预算。
$warm = Read-FixtureIdentity $PID
if($warm.status -ne 'running'){throw 'native identity observer warmup failed'}
$null = ConvertFrom-Json '{"id":0,"pids":[]}'
$null = @{id=0;processes=@($warm)} | ConvertTo-Json -Depth 6 -Compress
[Console]::Out.WriteLine('{"event":"ready","protocol":1}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json $line
  $rows = @(); foreach($processId in $request.pids){$rows += Read-FixtureIdentity ([int]$processId)}
  $reply = @{id=$request.id; processes=@($rows)} | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.WriteLine($reply)
}
`

export async function startWindowsFixtureProcessObserver({ spawnProcess = spawn } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows native fixture observer requires Windows')
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-Command', nativeScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  return startFixtureObserverTransport(child)
}

// 只服务合成测试子进程；所有失败终止本观察器，保留首红，不重放查询。
export async function startFixtureObserverTransport(child) {
  const lines = createInterface({ input: child.stdout })
  let nextId = 0, stderr = '', readyResolve, readyReject, closed = false, failure = null
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const onFailure = error => {
    if (failure) return
    failure = error
    readyReject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
    if (!closed) child.kill()
  }
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000) })
  child.once('error', onFailure)
  child.stdin.on('error', onFailure)
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; onFailure(new Error(`fixture identity observer closed ${code}/${signal}: ${stderr}`)); resolve() }))
  lines.on('line', line => {
    if (failure) return
    try {
      const message = JSON.parse(line)
      if (message.event === 'ready') { if (message.protocol !== 1) throw new Error('identity observer protocol mismatch'); readyResolve(); return }
      const item = pending.get(message.id)
      if (!item) throw new Error('unexpected identity observer response ' + message.id)
      pending.delete(message.id); clearTimeout(item.timer); item.resolve(message)
    } catch (error) { onFailure(error) }
  })
  const startupTimer = setTimeout(() => onFailure(new Error('fixture identity observer startup timeout: ' + stderr)), 7000)
  try { await ready } catch (error) { if (!closed) child.kill(); await exited; throw error } finally { clearTimeout(startupTimer) }
  return {
    pid: child.pid,
    async snapshot(pids) {
      if (failure) throw failure
      if (closed) throw new Error('fixture identity observer closed')
      if (!pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('invalid fixture PID')
      const id = ++nextId, startedAtMs = Date.now(), monotonicStart = performance.now()
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => onFailure(new Error('fixture identity observation timeout')), 2000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id, pids }) + '\n', error => { if (error) onFailure(error) })
      })
      if (!Array.isArray(reply.processes)) { const error = new Error('identity processes response missing'); onFailure(error); throw error }
      return { startedAtMs, completedAtMs: Date.now(), durationMs: performance.now() - monotonicStart, processes: reply.processes }
    },
    async close() {
      if (closed) return
      child.stdin.end()
      const timer = setTimeout(() => { if (!closed) child.kill() }, 2000)
      try { await exited } finally { clearTimeout(timer); lines.close() }
    },
  }
}
