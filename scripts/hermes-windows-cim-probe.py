"""仅修复固定 CIM 查询的自有 Job/继承管道收尾；不替换进程列表或身份判定。"""
def install_windows_cim_probe(gateway, compat, spawn_server, platform=None):
    import os, subprocess, time
    if (platform or os.name) != 'nt':
        return lambda: None
    original = compat.bounded_probe_run
    original_listing = gateway._windows_process_listing
    query = """Get-CimInstance Win32_Process | ForEach-Object {   'CommandLine=' + ($_.CommandLine -replace "`r`n",' ' -replace "`n",' ');   'ProcessId=' + $_.ProcessId;   '' }"""

    def bounded(argv, *, timeout, errors='replace', **kwargs):
        # 不接管 git/MSYS exec、其他 PowerShell、带输入/环境覆盖或未知接口。
        if (not isinstance(argv, (list, tuple)) or len(argv) != 4 or
                os.path.basename(str(argv[0]).replace('\\', '/')).lower() not in ('powershell', 'powershell.exe', 'pwsh', 'pwsh.exe') or
                list(argv[1:]) != ['-NoProfile', '-Command', query] or kwargs):
            return original(argv, timeout=timeout, errors=errors, **kwargs)
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 15:
            raise SystemExit('Hermes CIM probe deadline contract changed')
        proc = job = None
        end = time.monotonic() + timeout
        try:
            proc, job = spawn_server(list(argv), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL, text=True, encoding='utf-8', errors=errors,
                env=None, cwd=None, creationflags=compat.windows_hide_flags())
            if job is None:
                raise RuntimeError('owned probe Job missing')
            while True:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    out, err = proc.communicate(timeout=min(.1, remaining))
                    break
                except subprocess.TimeoutExpired:
                    # 仅在真正的 PowerShell 已退出后关自有 Job；释放 conhost 等继承写端。
                    # 不用于 MSYS 父 stub 先退出的普通命令，不杀其他 HOME 或任务。
                    if job is not None and proc.poll() is not None:
                        job.close()
                        job = None
            if len(out) + len(err) > 1048576:
                raise RuntimeError('CIM output budget exceeded')
            return subprocess.CompletedProcess(list(argv), proc.returncode, out, err)
        except Exception:
            compat._close_job(job)
            job = None
            if proc is not None:
                drain = getattr(compat, 'kill_and_drain', None)
                if callable(drain):
                    drain(proc, 1)
                else:
                    compat.kill_process_tree(proc)
                    try:
                        proc.communicate(timeout=1)
                    except (OSError, ValueError, subprocess.SubprocessError):
                        # 同原旧版收尾：不在 reader 线程持有时主动 close pipe 导致无界等待。
                        proc.stdin = proc.stdout = proc.stderr = None
            return None
        finally:
            compat._close_job(job)

    def listing():
        try:
            value = original_listing()
        except Exception:
            raise SystemExit('Hermes Windows process inventory failed; operation not accepted') from None
        if value is None:
            # 原调用者会吞 Exception；未知库存必须停止，不能变成“无冲突”。
            raise SystemExit('Hermes Windows process inventory unavailable; startup/stop not accepted')
        return value

    compat.bounded_probe_run = bounded
    gateway._windows_process_listing = listing
    def restore():
        compat.bounded_probe_run = original
        gateway._windows_process_listing = original_listing
    return restore
