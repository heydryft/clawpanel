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
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public class FixtureProcessIdentity {
  public int pid;
  public string status;
  public string executablePath;
  public string creationTimeFileTimeHex;
  public long createdAtMs;
  public long exitAtMs;
  public long sampledAtMs;
  public int nativeError;
  public int imageQueryError;
  public uint waitResult;
}
public static class FixtureProcessReader {
  [StructLayout(LayoutKind.Sequential)] private struct FT { public uint low; public uint high; }
  [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr h, out FT creation, out FT exit, out FT kernel, out FT user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder image, ref uint length);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
  private static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000L; }
  private static ulong Raw(FT t) { return ((ulong)t.high << 32) | t.low; }
  private static long Unix(FT t) { ulong raw = Raw(t); return raw == 0 ? 0 : (DateTime.FromFileTimeUtc((long)raw).Ticks - 621355968000000000L) / 10000L; }
  public static FixtureProcessIdentity Read(int pid) {
    var row = new FixtureProcessIdentity { pid=pid, status="error" };
    IntPtr handle = OpenProcess(0x00100000 | 0x00001000, false, pid);
    if (handle == IntPtr.Zero) { row.nativeError=Marshal.GetLastWin32Error(); row.status=row.nativeError==87 ? "missing" : "error"; row.sampledAtMs=Now(); return row; }
    try {
      FT creation, exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) { row.nativeError=Marshal.GetLastWin32Error(); return row; }
      row.creationTimeFileTimeHex=Raw(creation).ToString("x16");
      row.createdAtMs=Unix(creation); row.exitAtMs=Unix(exit);
      uint state=WaitForSingleObject(handle, 0);
      row.waitResult=state;
      if (state==0) row.status="exited";
      else if (state==258) row.status="running";
      else row.nativeError=Marshal.GetLastWin32Error();
      var image=new StringBuilder(32768); uint length=(uint)image.Capacity;
      if (QueryFullProcessImageName(handle, 0, image, ref length)) row.executablePath=image.ToString();
      else {
        row.imageQueryError=Marshal.GetLastWin32Error();
        if (state!=0 || row.exitAtMs==0) { row.status="error"; row.nativeError=row.imageQueryError; }
      }
      return row;
    } finally { row.sampledAtMs=Now(); CloseHandle(handle); }
  }
}
'@
[Console]::Out.WriteLine('{"event":"ready","protocol":1}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json $line
  $rows = @($request.pids | ForEach-Object { [FixtureProcessReader]::Read([int]$_) })
  $reply = @{id=$request.id; processes=@($rows)} | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.WriteLine($reply)
}
`

export async function startWindowsFixtureProcessObserver() {
  if (process.platform !== 'win32') throw new Error('Windows native fixture observer requires Windows')
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', nativeScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
  const lines = createInterface({ input: child.stdout })
  let nextId = 0, stderr = '', readyResolve, readyReject, closed = false
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const onFailure = error => {
    readyReject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000) })
  child.once('error', onFailure)
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; onFailure(new Error(`fixture identity observer closed ${code}/${signal}: ${stderr}`)); resolve() }))
  lines.on('line', line => {
    try {
      const message = JSON.parse(line)
      if (message.event === 'ready') { readyResolve(); return }
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
      if (closed) throw new Error('fixture identity observer closed')
      if (!pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('invalid fixture PID')
      const id = ++nextId, startedAtMs = Date.now(), monotonicStart = performance.now()
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture identity observation timeout')) }, 2000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id, pids }) + '\n', error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error) } })
      })
      if (!Array.isArray(reply.processes)) throw new Error('identity processes response missing')
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
