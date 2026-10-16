/** 只读取该 checkout 已提交的 PM 环境；损坏记录禁止回退旧 ABI。 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// JS 与 Rust 共用这份固定版本适配器；只在独立 Python 子进程内隔离全局曝光。
export const HERMES_PRIVATE_COMPLETION_SCRIPT = String.raw`
# 仅固定 0.22.2：原始完整 completion，子进程内隔离命令曝光边界。
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys

PIN = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
HASHES = {
    'hermes_cli/source_completion.py': 'f3300d162236b9a277afd4102505fb54b4f258958d76fefca9f772c4e8060903',
    'hermes_cli/_launchers.py': '9cf612547558a28a7840544a44c5f5ab866ee527a05f96000aefdf51cd7fcbcd',
    'hermes_cli/_install_repair.py': '66eeac124f1519d8d343fa390a734ce03fb6fdd0deebbb60dcd2c7bd70c3721a',
    'hermes_cli/update_cmd_maint.py': '8943b8b260577cf9fec242e2ab4668004475cfd5fce5a0986c272fd6114e927f',
    'hermes_cli/post_update.py': 'd025e7746a691d753372cac32c64b9ca9121744811f49fb64e822c769a8fea3e',
    'hermes_cli/boot_bootstrap.py': 'ff1cbe91e3ff860ac5c342df0fee581f9393c354f5ce4db3bdebdef332b31ebc',
    'hermes_cli/venv_sync.py': '6de0d12b3de57f4425279589be5d2f39e02e2bec98ba04ef8169e1e9d2b982e9',
    'hermes_cli/source_build.py': 'ebec5fbd2a742a1832d94db466ec0f5255df2be09155622cf8af4cee5bf5c570',
    'hermes_cli/source_stamp.py': '963a62f643725816b779f15a6b2d8498b7fdb1b551eaa6a65afa4ebad96882b1',
    'pm/runtime.py': '68d6ae47d2e0143f3cc377e462e3588abbb0e857bbc9f22442a3f66ebe54c478',
    'pm/_uv.py': '60d4c360aee770e50e3132e82b3bec99cb3759d592cd97ab92aaca56804315ef',
}


def require(condition, message):
    if not condition:
        raise RuntimeError('Hermes private completion: ' + message)


def reexec_selected_python(python):
    command = [str(python), *sys.orig_argv[1:]]
    # Windows CRT execv 不转义多行-c/空格参数，会把首行注释当完整程序并空成功。
    # subprocess 使用正确列表转义并等待真实退出；标准输出仍由原调用方核验。
    if os.name == 'nt':
        raise SystemExit(subprocess.run(command, check=False).returncode)
    os.execv(str(python), command)


def prepare_currency_checker(root, store_python):
    # 显式安装尾部：bootstrap Python 创建的 PM checker 不等于 store Python 的 checker。
    # 仅用已安装的工具准备原独立 PM runtime；不让 fallback 去获取工具或改应用依赖。
    from pm._uv import _toolchain
    from pm.runtime import prepare_runtime
    from pm.environments import install_state_dir
    tools = _toolchain(realize=False)
    require(tools is not None, 'PM checker requires the already installed pinned toolchain')
    uv, python = tools
    require(all(Path(tool).is_file() and Path(tool).resolve().is_relative_to(home / 'tools') for tool in tools),
            'PM checker toolchain escapes the managed store')
    require(os.path.normcase(os.path.abspath(python)) == os.path.normcase(os.path.abspath(store_python)),
            'PM checker Python is not the selected store Python')
    state = install_state_dir(root).resolve()
    require((home / 'installs').resolve() == home / 'installs' and state.is_relative_to(home / 'installs'),
            'PM checker state escapes the managed home')
    manager_root = state / 'pm-runtime'
    require(manager_root.resolve() == manager_root, 'PM checker root escapes install state')
    manager = Path(prepare_runtime(Path(uv), Path(python), manager_root, bootstrap=True)).absolute()
    # POSIX venv 的 python 文件本身会链接到 store；检查其父目录，不能误拒合法文件链接。
    require(manager.is_file() and manager.is_relative_to(manager_root) and
            manager.parent.resolve().is_relative_to(manager_root), 'PM checker executable escapes install state')


def require_pm_current(root):
    if pm.venv_is_current(project_root=root) is True:
        return
    # 只在错误时输出有限布尔值/错误类型，不复制 HOME、环境变量、facts 或凭据。
    from pm.environments import running_from_selected_environment
    from pm.runtime import runtime_python
    from pm.package import InstallError
    details = {'selectedDependenciesActive': running_from_selected_environment(root),
               'prefixIsBase': sys.prefix == sys.base_prefix}
    try:
        runtime_python(bootstrap=False)
        details['checkerReady'] = True
    except InstallError as error:
        details.update(checkerReady=False, checkerErrorPackage=error.package)
    require(False, 'PM currency is false or unknown; readiness=' + json.dumps(details, sort_keys=True))


root = Path(sys.argv[1]).resolve()
home = Path(os.environ['HERMES_HOME']).resolve()
require(len(sys.argv) in (3, 4) and sys.argv[2] == PIN, 'unsupported release')
require(root == home / 'hermes-agent' or sys.argv[3:] == ['--portable'], 'source is outside the managed home')
require(not os.environ.get('HERMES_RUNTIME_DIR') or Path(os.environ['HERMES_RUNTIME_DIR']).resolve() == home / 'tools', 'foreign runtime override')
require(not os.environ.get('HERMES_INSTALL_ROOT') or Path(os.environ['HERMES_INSTALL_ROOT']).resolve() == root, 'foreign install root override')
head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True,
                      text=True, encoding='utf-8', check=True).stdout.strip()
require(head == PIN, 'checkout commit mismatch')
for name, digest in HASHES.items():
    content = (root / name).read_bytes().replace(b'\r\n', b'\n')
    require(hashlib.sha256(content).hexdigest() == digest, 'upstream interface/source changed: ' + name)

sys.path.insert(0, str(root))
from hermes_cli import _launchers as launchers
store_python = launchers.resolve_store_python(root, publication=True)
require(store_python is not None and store_python.is_file(), 'selected PM store Python is missing')
require(store_python.resolve().is_relative_to(home / 'tools'), 'store Python escapes the managed home')
same = os.path.normcase(os.path.abspath(store_python)) == os.path.normcase(os.path.abspath(sys.executable))
if not same:
    require(os.environ.get('CLAWPANEL_HERMES_COMPLETION_REEXEC') != PIN, 'store Python identity mismatch')
    os.environ['CLAWPANEL_HERMES_COMPLETION_REEXEC'] = PIN
    reexec_selected_python(store_python)

# 沿用原 completion 的 own-script 身份，防止导入 bootstrap 再进入同一尾部。
sys.argv[0] = str(root / 'hermes_cli' / 'source_completion.py')
from pm.environments import activate_dependencies
activate_dependencies(root)
import pm
prepare_currency_checker(root, store_python)
require_pm_current(root)
require('hermes_cli.post_update' not in sys.modules, 'maintenance aliases were imported before private policy')
from hermes_cli import _install_repair as repair


def signature(function, names):
    require(list(inspect.signature(function).parameters) == names, 'upstream callable signature changed: ' + function.__name__)


signature(launchers.expose_cli, ['project_root', 'create'])
signature(repair.migrate_windows_bin_path, ['root', 'windows', 'read_user_path', 'write_user_path'])
exposures = []


def private_expose(project_root=None, *, create=True):
    require(project_root is None or Path(project_root).resolve() == root, 'foreign exposure target')
    exposures.append('expose_cli')
    return {'ok': True, 'skipped': 'clawpanel-private-managed', 'written': []}


def private_migrate(root, *, windows=None, read_user_path=None, write_user_path=None):
    exposures.append('windows_user_path_migration')
    return False


def private_fhs():
    exposures.append('fhs_shell_path_guard')


original_expose, original_migrate = launchers.expose_cli, repair.migrate_windows_bin_path
launchers.expose_cli = private_expose
repair.migrate_windows_bin_path = private_migrate
maintenance = None
try:
    from hermes_cli import update_cmd_maint as maintenance
    from hermes_cli import source_completion as completion
    signature(maintenance._ensure_fhs_path_guard, [])
    signature(completion.complete_source_checkout, ['root', 'desktop', 'assume_yes', 'gateway_mode',
              'pre_update_snapshot_id', 'pre_update_version', 'completion_message', 'announce', 'followups', 'before_build'])
    original_fhs = maintenance._ensure_fhs_path_guard
    maintenance._ensure_fhs_path_guard = private_fhs
    owed = []
    result = completion.complete_source_checkout(root, desktop=False, assume_yes=True,
             completion_message='✓ ClawPanel private Hermes install complete', followups=owed)
    if result is not True or owed:
        raise RuntimeError('Hermes private completion failed: ' + repr({'result': result, 'followups': owed}))

    # 使用原始 boot maintenance 生成真实 record，避免首次普通命令再次全局曝光。
    from hermes_cli import boot_bootstrap as boot
    boot.run_boot_bootstrap(root)
    record = boot.read_last_known(boot.record_path(root))
    require(record.get('identity') == PIN, 'boot maintenance did not record the real revision')
    results = record.get('results')
    require(isinstance(results, dict) and results and all(isinstance(value, dict) and value.get('ok') is True
            for value in results.values()), 'boot maintenance has unfinished steps')
    from hermes_cli.venv_sync import _tree_matches_completed_stamp, completion_pending_path
    require(_tree_matches_completed_stamp(root) is True, 'original completion stamp is missing, dirty, adopted or stale')
    require(pm.venv_is_current(project_root=root) is True, 'PM became non-current during completion')
    local = root / '.hermes' / 'bin'
    require(all(any((local / (name + suffix)).is_file() for suffix in ('', '.exe', '.cmd'))
                for name in ('hermes', 'hermes-acp')), 'private launchers were not published')
    print('CLAWPANEL_HERMES_PRIVATE_COMPLETION ' + json.dumps({
        'commit': PIN, 'current': True, 'same': True, 'completed': True,
        'pending': completion_pending_path(root).exists(), 'bootRecord': str(boot.record_path(root)),
        'privateExposurePolicy': exposures,
    }), flush=True)
finally:
    launchers.expose_cli = original_expose
    repair.migrate_windows_bin_path = original_migrate
    if maintenance is not None and 'original_fhs' in locals():
        maintenance._ensure_fhs_path_guard = original_fhs
`

// 版本探针只读本机官方 metadata，不把同步远程更新检查混进安装/状态验收。
export const HERMES_PRIVATE_METADATA_SCRIPT = String.raw`
import hashlib, inspect, json, os, subprocess, sys
from pathlib import Path


# 仅显式启用时输出固定阶段/PID/单调耗时；不含路径、参数、配置或错误内容。
def _hp(name):
    if os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING')!='1' or name not in 'entry src_b src_e store reexec imp_b imp_e cur_b cur_e debt1_b debt1_e act_b act_e state1_b state1_e prof_b prof_e boot_b boot_e state2_b state2_e debt2_b debt2_e policy_b policy_e main_b main_exit preflight meta_b meta_e pyjson_b pyjson_e'.split():return
    import time
    t=time.perf_counter_ns();d=_hp.__dict__;s=d.setdefault('t',t);p=d.get('p',t);i=d.get('i',0)+1
    d.update(p=t,i=i)
    try:
        print('CLAWPANEL_HERMES_PHASE '+json.dumps(dict(schemaVersion=1,scope='metadata',phase=name,pid=os.getpid(),ppid=os.getppid(),sequence=i,elapsedMs=round((t-s)/1e6,3),deltaMs=round((t-p)/1e6,3))),file=sys.stderr,flush=True)
    except (OSError,ValueError):pass

_hp('entry')

def reexec_selected_python(python):
    command = [str(python), *sys.orig_argv[1:]]
    # Windows CRT不能直接承载多行-c；保留参数列表并同步传播真实退出码。
    if os.name == 'nt':
        raise SystemExit(subprocess.run(command, check=False).returncode)
    os.execv(str(python), command)

root = Path(sys.argv[1]).resolve()
pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
home = Path(os.environ['HERMES_HOME']).resolve()
if (root != home / 'hermes-agent' and sys.argv[3:] != ['--portable']) or sys.argv[2] != pin:
    raise RuntimeError('Hermes metadata: managed source/pin mismatch')
if os.environ.get('HERMES_RUNTIME_DIR') and Path(os.environ['HERMES_RUNTIME_DIR']).resolve() != home / 'tools':
    raise RuntimeError('Hermes metadata: foreign runtime override')
if os.environ.get('HERMES_INSTALL_ROOT') and Path(os.environ['HERMES_INSTALL_ROOT']).resolve() != root:
    raise RuntimeError('Hermes metadata: foreign install root override')
_hp('src_b')
head = subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],check=True,capture_output=True,text=True).stdout.strip()
if head != pin:
    raise RuntimeError('Hermes metadata: checkout mismatch')
content = (root / 'hermes_cli/_startup_fast.py').read_bytes().replace(b'\r\n',b'\n')
if hashlib.sha256(content).hexdigest() != '94818a6fcf1f8607e1690a95c9f9042b57aa910ebc9631cf84def5402edf1536':
    raise RuntimeError('Hermes metadata: upstream interface changed')
_hp('src_e')
sys.path.insert(0,str(root))
from hermes_cli._launchers import resolve_store_python
python = resolve_store_python(root,publication=True)
if python is None or not python.is_file() or not python.resolve().is_relative_to(home / 'tools'):
    raise RuntimeError('Hermes metadata: selected store Python is missing or foreign')
_hp('store')
if os.path.normcase(os.path.abspath(python)) != os.path.normcase(os.path.abspath(sys.executable)):
    if os.environ.get('CLAWPANEL_HERMES_METADATA_REEXEC') == pin:
        raise RuntimeError('Hermes metadata: store Python identity mismatch')
    os.environ['CLAWPANEL_HERMES_METADATA_REEXEC'] = pin
    _hp('reexec')
    reexec_selected_python(python)
sys.argv[1:] = ['--version']
_hp('act_b')
from pm.environments import activate_dependencies
activate_dependencies(root)
_hp('act_e')
import pm
_hp('cur_b')
if pm.venv_is_current(project_root=root) is not True:
    raise RuntimeError('Hermes metadata: PM currency false or unknown')
_hp('cur_e')
from hermes_cli._startup_fast import print_fast_version_info
if list(inspect.signature(print_fast_version_info).parameters) != ['check_updates']:
    raise RuntimeError('Hermes metadata: callable signature changed')
_hp('meta_b')
print_fast_version_info(check_updates=False)
_hp('meta_e')
`

// 普通 CLI 的唯一受管入口；不修改上游文件，不用依赖 venv/旧 launcher 启动 CLI。
export const HERMES_PRIVATE_LAUNCH_SCRIPT = String.raw`
import ast
import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys


# 仅显式启用时输出固定阶段/PID/单调耗时；不含路径、参数、配置或错误内容。
def _hp(name):
    if os.environ.get('CLAWPANEL_HERMES_PHASE_TIMING')!='1' or name not in 'entry src_b src_e store reexec imp_b imp_e cur_b cur_e debt1_b debt1_e act_b act_e state1_b state1_e prof_b prof_e boot_b boot_e state2_b state2_e debt2_b debt2_e policy_b policy_e main_b main_exit preflight meta_b meta_e pyjson_b pyjson_e'.split():return
    import time
    t=time.perf_counter_ns();d=_hp.__dict__;s=d.setdefault('t',t);p=d.get('p',t);i=d.get('i',0)+1
    d.update(p=t,i=i)
    try:
        print('CLAWPANEL_HERMES_PHASE '+json.dumps(dict(schemaVersion=1,scope='launch',phase=name,pid=os.getpid(),ppid=os.getppid(),sequence=i,elapsedMs=round((t-s)/1e6,3),deltaMs=round((t-p)/1e6,3))),file=sys.stderr,flush=True)
    except (OSError,ValueError):pass

_hp('entry')

PIN = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
HASHES = {
    'hermes_cli/main.py': '88a7fc166d3bfaac082d44bbfc36c93b53c50f7508ca96e32206dc3f1edfaa82',
    'hermes_cli/main_dashboard.py': 'bb38edb019791482dbe932080002460e97796e84014a551c2c6602dfb935bc02',
    'hermes_cli/web_server_gateway.py': 'fb690737befc0e7a87f96d9f2b80da4bbbfe08fae210b0c7940d098b55e9a406',
    'hermes_cli/web_routers/profiles.py': '42be93f968600f1763a069eecb35fdece9e89d92944ebc0b29f7980632fbc970',
    'hermes_cli/profiles.py': 'f65320d57dfe6bd670c139b5b2c394eb6150cf67b9536b8a82e95f0ea0180f14',
    'hermes_cli/gateway.py': 'a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899',
    'hermes_cli/gateway_windows.py': 'cc1b0b9668e2a7c28fcf79ab07c987e8d314e2b81fc48d144b151e04ec140765',
    'hermes_cli/profiles_service_cleanup.py': 'cdef06affb95f06cb9ce57989b5defaa2362555bc201354bcc48d45d33941110',
    'hermes_cli/_launchers.py': '9cf612547558a28a7840544a44c5f5ab866ee527a05f96000aefdf51cd7fcbcd',
    'hermes_cli/_install_repair.py': '66eeac124f1519d8d343fa390a734ce03fb6fdd0deebbb60dcd2c7bd70c3721a',
    'hermes_cli/update_cmd_maint.py': '8943b8b260577cf9fec242e2ab4668004475cfd5fce5a0986c272fd6114e927f',
    'hermes_cli/post_update.py': 'd025e7746a691d753372cac32c64b9ca9121744811f49fb64e822c769a8fea3e',
    'hermes_cli/boot_bootstrap.py': 'ff1cbe91e3ff860ac5c342df0fee581f9393c354f5ce4db3bdebdef332b31ebc',
    'hermes_cli/venv_sync.py': '6de0d12b3de57f4425279589be5d2f39e02e2bec98ba04ef8169e1e9d2b982e9',
    'hermes_cli/source_build.py': 'ebec5fbd2a742a1832d94db466ec0f5255df2be09155622cf8af4cee5bf5c570',
    'hermes_bootstrap.py': 'f242036b2d35b92283b9a7e97c7059e537607fc4b02026f657a6d00cb4683f69',
    'hermes_constants.py': '8d55a41452b625061f1f2e2f507a7e7ffb2a396e711afcc7aee28b03a6e8fa9d',
    'pm/environments.py': 'ac5a9f09bc622a60aa616880be0906b07bec95bb8ad934924e931aa28dc8b777',
    'pm/paths.py': '8f15860b82f443a424186317dc361ea6063e0e7c3113af9b56a76f6b89e97737',
}


def require(condition, message):
    if not condition:
        raise RuntimeError('Hermes private preflight: ' + message)


def reexec_selected_python(python):
    command = [str(python), *sys.orig_argv[1:]]
    # Windows CRT不能直接承载多行-c；保留参数列表并同步传播真实退出码。
    if os.name == 'nt':
        raise SystemExit(subprocess.run(command, check=False).returncode)
    os.execv(str(python), command)


def native_windows_amd64():
    if sys.platform != 'win32':
        return
    import ctypes
    from ctypes import wintypes
    class SYSTEM_INFO(ctypes.Structure):
        _fields_ = [('arch', wintypes.WORD), ('reserved', wintypes.WORD),
                    ('page', wintypes.DWORD), ('minimum', ctypes.c_void_p), ('maximum', ctypes.c_void_p),
                    ('mask', ctypes.c_size_t), ('count', wintypes.DWORD), ('type', wintypes.DWORD),
                    ('granularity', wintypes.DWORD), ('level', wintypes.WORD), ('revision', wintypes.WORD)]
    info = SYSTEM_INFO()
    query = ctypes.WinDLL('kernel32', use_last_error=True).GetNativeSystemInfo
    query.argtypes = [ctypes.POINTER(SYSTEM_INFO)]
    query.restype = None
    query(ctypes.byref(info))
    require(info.arch == 9 and ctypes.sizeof(ctypes.c_void_p) == 8,
            'Windows native AMD64 required; ARM64/emulation/unknown cannot bootstrap system tools')
    for name in ('PROCESSOR_ARCHITEW6432', 'PROCESSOR_ARCHITECTURE'):
        require(os.environ.get(name, '').strip().lower() in ('', 'amd64', 'x86_64', 'x64'),
                'Windows architecture contradicts native AMD64')


def validate_runtime_state(root):
    require(pm.venv_is_current(project_root=root) is True, 'PM currency is false or unknown')
    require(not completion_pending_path(root).exists(), 'source completion debt remains; run managed completion')
    require(_tree_matches_completed_stamp(root) is True, 'source stamp is missing, adopted, dirty or stale')
    for product, output in (('tui', 'ui-tui/dist'), ('web', 'hermes_cli/web_dist')):
        require(source_product_current(root, product, root / output) is True, 'product receipt is not current: ' + product)


def validate_no_repair_debt(root):
    from pm.environments import install_state_dir, owning_home_root
    from hermes_cli.update_lock import read_live_update
    require(owning_home_root(root) is None, 'borrowed HOME is not the managed checkout owner')
    require(read_live_update(install_root=root) is None, 'source update is still live')
    markers = [root / '.update-incomplete', root / '.lazy-refresh-incomplete',
               root / '.hermes-update-zip-swap', install_state_dir(root) / '.repair-incomplete']
    git_marker = subprocess.run(['git', '-C', str(root), 'rev-parse', '--git-path', 'hermes-update-pull'],
                                check=True, capture_output=True, text=True).stdout.strip()
    marker = Path(git_marker)
    markers.append(marker if marker.is_absolute() else root / marker)
    require(not any(marker.exists() for marker in markers), 'repair or checkout recovery debt remains')


def validate_boot_record(record, expected=None):
    require(isinstance(record, dict) and record.get('identity') == PIN, 'active profile boot identity is missing or stale')
    results = record.get('results')
    require(isinstance(results, dict) and bool(results) and
            all(isinstance(value, dict) and value.get('ok') is True for value in results.values()),
            'active profile boot has failed, empty or unknown steps')
    if expected is not None:
        require(record.get('schemaVersion') == 1 and set(results) == set(expected), 'active profile boot step contract changed')


def prepare_active_profile(root, home, argv):
    # 执行固定 main 中未经改写的解析函数，不导入具有启动副作用的整个 main。
    from hermes_cli import _startup_fast
    names = {'_inside_mcp_add_args', '_looks_like_hermes_invocation', '_exit_invalid_profile_name',
             '_looks_like_option_value', '_scan_profile_flag', '_resolve_sudo_user_profile_env',
             '_under_gateway_supervisor', '_s6_supervised_gateway_run', '_apply_profile_override'}
    tree = ast.parse((root / 'hermes_cli/main.py').read_text(encoding='utf-8'))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    require({node.name for node in nodes} == names, 'upstream profile interface changed')
    scope = {'os': os, 'sys': sys, 're': re, 'Path': Path, '_startup_fast': _startup_fast,
             '_PROFILE_NAME_RE': r'^[a-z0-9][a-z0-9_-]{0,63}$', '_explicit_cli_profile': None}
    sys.argv = ['hermes', *argv]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(root / 'hermes_cli/main.py'), 'exec'), scope)
    from hermes_cli.profiles import get_active_profile_name, resolve_profile_env
    requested, _, _ = scope['_scan_profile_flag'](argv)
    incoming = Path(os.environ['HERMES_HOME'])
    if requested is None and incoming.parent.name == 'profiles':
        requested = incoming.name
    if (requested is None and not scope['_under_gateway_supervisor'](argv)
            and not _startup_fast.is_desktop_ssh_backend_argv(argv) and not scope['_s6_supervised_gateway_run'](argv)):
        sticky = home / 'active_profile'
        if sticky.exists():
            requested = sticky.read_text(encoding='utf-8-sig').strip() or 'default'
    expected = Path(resolve_profile_env(requested or 'default')).resolve()
    scope['_apply_profile_override']()
    require(scope['_scan_profile_flag'](sys.argv[1:])[0] is None, 'multiple profile selectors are ambiguous')
    active = Path(os.environ['HERMES_HOME']).resolve()
    require((home / 'profiles').resolve() == home / 'profiles', 'profile root escapes managed home')
    require(active == home or (active.parent == home / 'profiles' and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', active.name)),
            'active profile escapes managed home')
    name = get_active_profile_name()
    require(name != 'custom' and active == expected and Path(resolve_profile_env(name)).resolve() == active, 'active profile identity mismatch')
    return active


def validate_windows_entrypoint(words):
    require(words[:1] and words[0] in {'gateway', 'dashboard', 'profile', 'tools', 'cron', 'sessions', 'logs', 'skills'},
            'Windows command is outside private managed entrypoints')
    if words[0] == 'gateway':
        require(words[1:2] in (['run'], ['stop'], ['status']), 'Windows service registration is outside private runtime')
    if words[0] == 'profile':
        require(words[1:2] in (['list'], ['use']), 'Windows profile mutation requires separate qualification')
    if words[0] == 'skills':
        # 仅匹配固定 Dashboard hub/profile API 实际生成的普通技能操作，不开放发布/修复或额外 flags。
        ordinary_hub = (len(words) == 4 and words[1] in {'install', 'uninstall'} and
                        bool(words[2].strip()) and not words[2].startswith('-') and words[3] == '--yes')
        require(ordinary_hub or words == ['skills', 'update'], 'Windows skills argv is outside private managed entrypoints')


def private_boot(root):
    from hermes_cli import _launchers as launchers
    from hermes_cli import _install_repair as repair
    require('hermes_cli.post_update' not in sys.modules, 'boot aliases imported before private policy')
    require(list(inspect.signature(launchers.expose_cli).parameters) == ['project_root', 'create'], 'expose signature changed')
    require(list(inspect.signature(repair.migrate_windows_bin_path).parameters) ==
            ['root', 'windows', 'read_user_path', 'write_user_path'], 'migration signature changed')
    def private_expose(project_root=None, *, create=True):
        require(project_root is None or Path(project_root).resolve() == root, 'foreign boot exposure target')
        return {'ok': True, 'skipped': 'clawpanel-private-managed', 'written': []}
    def private_migrate(root, *, windows=None, read_user_path=None, write_user_path=None):
        return False
    def private_fhs():
        return None
    saved_expose, saved_migrate = launchers.expose_cli, repair.migrate_windows_bin_path
    launchers.expose_cli, repair.migrate_windows_bin_path = private_expose, private_migrate
    maintenance = None
    try:
        from hermes_cli import update_cmd_maint as maintenance
        require(list(inspect.signature(maintenance._ensure_fhs_path_guard).parameters) == [], 'FHS signature changed')
        saved_fhs = maintenance._ensure_fhs_path_guard
        maintenance._ensure_fhs_path_guard = private_fhs
        from hermes_cli import boot_bootstrap as boot
        from hermes_cli import post_update
        record = boot.record_path(root)
        require((home / 'installs').resolve() == home / 'installs' and
                record.resolve().is_relative_to(home / 'installs'), 'boot record escapes managed home')
        boot.run_boot_bootstrap(root)
        validate_boot_record(boot.read_last_known(record), [name for name, _ in post_update.BOOT_HOME_STEPS])
        return record
    finally:
        launchers.expose_cli, repair.migrate_windows_bin_path = saved_expose, saved_migrate
        if maintenance is not None and 'saved_fhs' in locals():
            maintenance._ensure_fhs_path_guard = saved_fhs
        # 原 post_update 捕获了曝光 alias；普通 CLI 前还原，真实 record 已是唯一启动凭据。
        if 'hermes_cli.post_update' in sys.modules:
            post = sys.modules['hermes_cli.post_update']
            post.expose_cli = saved_expose
            post.HOME_STEPS = tuple((name, saved_expose if name == 'expose_cli' else fn) for name, fn in post.HOME_STEPS)
            post.BOOT_HOME_STEPS = tuple(step for step in post.HOME_STEPS if step[0] != 'sync_skills')


WINDOWS_TASK_QUERY = r"""
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function TaskHResult($errorObject) {
    $e=$errorObject.Exception
    while($null -ne $e) {
        if($e -is [Runtime.InteropServices.COMException]) { return ('0x{0:x8}' -f ([long]$e.HResult -band 4294967295)) }
        $e=$e.InnerException
    }
    return $null
}
try {
    $service=New-Object -ComObject Schedule.Service
    $service.Connect()
    $folder=$service.GetFolder('\')
    try {
        $task=$folder.GetTask($env:CLAWPANEL_HERMES_TASK_QUERY_NAME)
        if($null -eq $task) { @{state='unknown';hresult=$null}|ConvertTo-Json -Compress }
        else { @{state='exists';hresult=$null}|ConvertTo-Json -Compress }
    } catch {
        $hr=TaskHResult $_
        if($hr -ceq '0x80070002') { @{state='missing';hresult=$hr}|ConvertTo-Json -Compress }
        else { @{state='unknown';hresult=$hr}|ConvertTo-Json -Compress }
    }
} catch { @{state='unknown';hresult=(TaskHResult $_)}|ConvertTo-Json -Compress }
"""


def windows_task_presence(task_name):
    # 只读COM：仅GetTask本身的ERROR_FILE_NOT_FOUND表示不存在，拒绝把任意非0当missing。
    import base64
    require(isinstance(task_name, str) and re.fullmatch(r'Hermes_Gateway(?:_[a-zA-Z0-9_-]+)?', task_name),
            'private profile task name contract changed')
    child_env = {key: value for key, value in os.environ.items() if key.lower() != 'psmodulepath'}
    child_env['CLAWPANEL_HERMES_TASK_QUERY_NAME'] = task_name
    powershell = Path(child_env.get('SystemRoot', 'C:\\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result = subprocess.run([str(powershell), '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(WINDOWS_TASK_QUERY.encode('utf-16le')).decode('ascii')],
                    env=child_env, capture_output=True, text=True, encoding='utf-8', timeout=10, check=False)
        if result.returncode != 0:
            return {'state': 'unknown', 'hresult': None}
        value = json.loads(result.stdout.lstrip('\ufeff'))
        if not isinstance(value, dict) or set(value) != {'state', 'hresult'}:
            return {'state': 'unknown', 'hresult': None}
        if value == {'state': 'missing', 'hresult': '0x80070002'} or value == {'state': 'exists', 'hresult': None}:
            return value
        return {'state': 'unknown', 'hresult': value.get('hresult') if isinstance(value.get('hresult'), str) else None}
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return {'state': 'unknown', 'hresult': None}


def install_private_profile_task_policy(root, owner_home):
    # 保护原函数入口而非cleanup的异常路径：上游cleanup会吞异常，然后继续移动/删除。
    if sys.platform != 'win32':
        return lambda: None
    import functools
    from hermes_cli import profiles, profiles_service_cleanup as cleanup, gateway_windows as gw
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    require(PIN == 'd923a5eb487a17c0a68801bba9ef0f56c81040a8', 'private profile task policy release changed')
    contracts = [(profiles, 'delete_profile', ['name', 'yes']), (profiles, 'rename_profile', ['old_name', 'new_name']),
                 (profiles, '_cleanup_gateway_service', ['name', 'profile_dir']), (profiles, '_canon_valid', ['name']),
                 (profiles, 'get_profile_dir', ['name']), (cleanup, 'remove_windows_task', []),
                 (gw, 'get_task_name', []), (gw, 'get_startup_entry_path', []), (gw, '_legacy_startup_entry_path', [])]
    for module, name, parameters in contracts:
        require(list(inspect.signature(getattr(module, name)).parameters) == parameters,
                'private profile task signature changed: ' + name)
    original_delete, original_rename = profiles.delete_profile, profiles.rename_profile
    saved = []
    def restore():
        for module, name, original in reversed(saved):
            setattr(module, name, original)
    def check_profile(name):
        canon = profiles._canon_valid(name)
        if canon == 'default':
            return
        directory = profiles.get_profile_dir(canon)
        require(directory == owner_home / 'profiles' / canon and directory.resolve() == directory,
                'private profile directory escapes managed home')
        token = set_hermes_home_override(str(directory))
        try:
            task_name = gw.get_task_name()
            state = windows_task_presence(task_name)
            require(state == {'state': 'missing', 'hresult': '0x80070002'},
                    'private profile mutation blocked by external Windows task/query: ' + task_name +
                    ' (' + str(state.get('state')) + ', ' + str(state.get('hresult')) + ')')
            for entry in (gw.get_startup_entry_path(), gw._legacy_startup_entry_path()):
                try:
                    entry.lstat()
                except FileNotFoundError:
                    continue
                except OSError:
                    require(False, 'private profile mutation blocked by unknown Windows Startup entry')
                require(False, 'private profile mutation blocked by existing Windows Startup entry')
        finally:
            reset_hermes_home_override(token)
    @functools.wraps(original_delete)
    def guarded_delete(name, yes=False):
        check_profile(name)
        return original_delete(name, yes=yes)
    @functools.wraps(original_rename)
    def guarded_rename(old_name, new_name):
        check_profile(old_name)
        if profiles._canon_valid(old_name) != 'default':
            check_profile(new_name)
        return original_rename(old_name, new_name)
    def private_cleanup(name, profile_dir):
        # 不做系统cleanup，消除“查无任务后新建同名任务”的TOCTOU删除；不伪称已清理。
        print('ClawPanel private profile: external Windows task/Startup cleanup not performed', file=sys.stderr)
        return False
    def private_remove_windows_task():
        return False
    replacements = [(original_delete, guarded_delete), (original_rename, guarded_rename),
                    (profiles._cleanup_gateway_service, private_cleanup), (cleanup.remove_windows_task, private_remove_windows_task)]
    try:
        # 同时替换固定包中已经捕获的function alias；之后Dashboard延迟导入也读取受保护入口。
        for module_name, module in list(sys.modules.items()):
            if module_name == 'hermes_cli' or module_name.startswith('hermes_cli.'):
                for name, value in list(vars(module).items()):
                    for original, replacement in replacements:
                        if value is original:
                            saved.append((module, name, value)); setattr(module, name, replacement)
    except BaseException:
        restore()
        raise
    return restore


def install_private_runtime_policy(root, owner_home, launch_script, portable=False):
    # Dashboard 请求和其后续子进程仍属于受管会话，不能只保护第一次 boot。
    import types
    from hermes_cli import _launchers as launchers, _install_repair as repair
    from hermes_cli import post_update as post, update_cmd_maint as maintenance, profiles
    from hermes_cli import main_dashboard as dashboard
    require(list(inspect.signature(launchers.runtime_command).parameters) ==
            ['repo_root', 'args', 'module', 'code', 'python', 'home'], 'runtime command interface changed')
    route = dashboard._route_named_profile_dashboard
    require(list(inspect.signature(route).parameters) ==
            ['args', '_headless_backend', '_ssh_owner_nonce', '_token_file'], 'dashboard routing interface changed')
    saved = []
    def bind(module, name, value):
        saved.append((module, name, getattr(module, name)))
        setattr(module, name, value)
    def restore():
        for module, name, value in reversed(saved):
            setattr(module, name, value)
    def private_expose(project_root=None, *, create=True):
        require(project_root is None or Path(project_root).resolve() == root, 'foreign runtime exposure target')
        return {'ok': True, 'skipped': 'clawpanel-private-managed', 'written': []}
    def private_migrate(root, *, windows=None, read_user_path=None, write_user_path=None):
        return False
    def private_fhs():
        return None
    def private_alias_directory():
        directory = owner_home / 'bin' / 'profile-aliases'
        require(directory.resolve() == directory, 'profile aliases escape managed home')
        return directory
    original_runtime_command = launchers.runtime_command
    def managed_runtime_command(repo_root, args=(), *, module='hermes_cli.main', code=None, python=None, home=None):
        require(Path(repo_root).resolve() == root, 'foreign runtime command target')
        # 非 CLI 的官方工具脚本保持原协议；这里不全局拦截 Python 或系统 subprocess。
        if module != 'hermes_cli.main' or code is not None:
            return original_runtime_command(repo_root, args, module=module, code=code, python=python, home=home)
        selected = launchers.resolve_store_python(root, publication=True)
        require(selected is not None and selected.is_file() and selected.resolve().is_relative_to(owner_home / 'tools'),
                'runtime child selected store Python is missing or foreign')
        require(python is None or os.path.normcase(os.path.abspath(python)) == os.path.normcase(os.path.abspath(selected)),
                'runtime child interpreter override is not selected store Python')
        require(home is None, 'runtime child explicit home contract needs qualification')
        return [str(selected), '-I', '-B', '-c', launch_script, str(root), str(owner_home), PIN,
                '--portable' if portable else '--', *args]
    # 只克隆固定原 routing 函数的 globals；保留其真实 HOME/参数/环境处理。
    # 不替换进程全局 subprocess.Popen/os.execvpe，不触碰其他工具/引擎。
    route_processes, route_os = route.__globals__['subprocess'], route.__globals__['os']
    def guarded_route_command(command):
        require(list(command[:3]) == [sys.executable, '-m', 'hermes_cli.main'], 'dashboard reexec contract changed')
        return managed_runtime_command(root, command[3:])
    def route_popen(command, *args, **kwargs):
        return route_processes.Popen(guarded_route_command(command), *args, **kwargs)
    def route_execvpe(executable, command, env):
        require(executable == sys.executable, 'dashboard reexec interpreter changed')
        guarded = guarded_route_command(command)
        # 仅固定Dashboard路由的私有代理；不改变其他模块的os/subprocess。
        if os.name == 'nt':
            raise SystemExit(subprocess.run(guarded, env=env, check=False).returncode)
        return route_os.execvpe(guarded[0], guarded, env)
    class RouteProxy:
        def __init__(self, original, **overrides):
            self.original, self.overrides = original, overrides
        def __getattr__(self, name):
            return self.overrides[name] if name in self.overrides else getattr(self.original, name)
    route_globals = dict(route.__globals__)
    route_globals['subprocess'] = RouteProxy(route_processes, Popen=route_popen)
    route_globals['os'] = RouteProxy(route_os, execvpe=route_execvpe)
    guarded_route = types.FunctionType(route.__code__, route_globals, route.__name__, route.__defaults__, route.__closure__)
    guarded_route.__kwdefaults__ = route.__kwdefaults__
    try:
        bind(launchers, 'expose_cli', private_expose)
        bind(repair, 'migrate_windows_bin_path', private_migrate)
        bind(maintenance, '_ensure_fhs_path_guard', private_fhs)
        bind(post, 'expose_cli', private_expose)
        bind(post, 'HOME_STEPS', tuple((name, private_expose if name == 'expose_cli' else function) for name, function in post.HOME_STEPS))
        bind(post, 'BOOT_HOME_STEPS', tuple(step for step in post.HOME_STEPS if step[0] != 'sync_skills'))
        bind(profiles, '_get_wrapper_dir', private_alias_directory)
        bind(launchers, 'runtime_command', managed_runtime_command)
        bind(dashboard, '_route_named_profile_dashboard', guarded_route)
    except BaseException:
        restore()
        raise
    return restore


native_windows_amd64()
require(len(sys.argv) >= 6 and sys.argv[3] == PIN and
        sys.argv[4] in ('--', '--portable', '--preflight', '--portable-preflight', '--python-json', '--portable-python-json'), 'unsupported launch contract')
root, home = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
argv = sys.argv[5:]
mode = sys.argv[4]
python_json = mode.endswith('python-json')
snippet = argv[0] if python_json and len(argv) == 1 else None
require(not python_json or snippet is not None, 'Python helper contract changed')
if python_json:
    argv = ['profile', 'list']
require(root == home / 'hermes-agent' or mode.startswith('--portable'), 'source escapes managed home')
require(not os.environ.get('HERMES_RUNTIME_DIR') or Path(os.environ['HERMES_RUNTIME_DIR']).resolve() == home / 'tools', 'foreign runtime override')
require(not os.environ.get('HERMES_INSTALL_ROOT') or Path(os.environ['HERMES_INSTALL_ROOT']).resolve() == root, 'foreign install root override')
incoming = Path(os.environ['HERMES_HOME']).resolve()
require(incoming == home or incoming.parent == home / 'profiles', 'incoming home escapes managed installation')
_hp('src_b')
head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
require(head == PIN, 'checkout commit mismatch')
dirty = subprocess.run(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=normal'],
                       check=True, capture_output=True, text=True).stdout.strip()
require(not dirty, 'checkout is dirty')
for name, digest in HASHES.items():
    require(hashlib.sha256((root / name).read_bytes().replace(b'\r\n', b'\n')).hexdigest() == digest,
            'upstream source/interface changed: ' + name)
_hp('src_e')
sys.path.insert(0, str(root))
from hermes_cli._launchers import resolve_store_python
python = resolve_store_python(root, publication=True)
require(python is not None and python.is_file() and (home / 'tools').resolve() == home / 'tools' and
        python.resolve().is_relative_to(home / 'tools'), 'selected store Python is missing or foreign')
_hp('store')
same = os.path.normcase(os.path.abspath(python)) == os.path.normcase(os.path.abspath(sys.executable))
if not same:
    require(os.environ.get('CLAWPANEL_HERMES_LAUNCH_REEXEC') != PIN, 'selected store Python identity mismatch')
    os.environ['CLAWPANEL_HERMES_LAUNCH_REEXEC'] = PIN
    _hp('reexec')
    reexec_selected_python(python)

# 仅 bootstrap 阶段使用原 tail 身份，防止在 preflight 前隐式修复。
sys.argv = [str(root / 'hermes_cli/source_completion.py'), '--version']
_hp('imp_b')
import pm
from hermes_cli.venv_sync import completion_pending_path, _tree_matches_completed_stamp
_hp('imp_e')
_hp('cur_b')
require(pm.venv_is_current(project_root=root) is True, 'PM currency is false or unknown')
_hp('cur_e')
require(not completion_pending_path(root).exists(), 'source completion debt remains')
_hp('debt1_b')
validate_no_repair_debt(root)
_hp('debt1_e')
_hp('act_b')
from pm.environments import activate_dependencies
activate_dependencies(root)
_hp('act_e')
_hp('state1_b')
from hermes_cli.source_build import source_product_current
validate_runtime_state(root)
_hp('state1_e')
_hp('prof_b')
active = prepare_active_profile(root, home, argv)
selected_argv = sys.argv[1:]
from hermes_cli._parser import command_argv
words = command_argv(sys.argv[1:])
if sys.platform == 'win32':
    validate_windows_entrypoint(words)
_hp('prof_e')
_hp('boot_b')
record = private_boot(root)
_hp('boot_e')
_hp('state2_b')
validate_runtime_state(root)
_hp('state2_e')
_hp('debt2_b')
validate_no_repair_debt(root)
_hp('debt2_e')
print('CLAWPANEL_HERMES_PRIVATE_PREFLIGHT ' + json.dumps({'commit': PIN, 'current': True, 'same': True,
      'completed': True, 'activeHome': str(active), 'bootRecord': str(record), 'command': words[:2]}), file=sys.stderr, flush=True)
if mode.endswith('preflight'):
    _hp('preflight')
    raise SystemExit(0)
# 显式钉住已核验的 profile，避免 main 二次解析时 sticky 文件变化改向未维护的 HOME。
_hp('policy_b')
from hermes_cli.profiles import get_active_profile_name
sys.argv = ['hermes', '--profile', get_active_profile_name(), *selected_argv]
launch_script = sys.orig_argv[sys.orig_argv.index('-c') + 1]
restore_policy = install_private_runtime_policy(root, home, launch_script, mode.startswith('--portable'))
restore_profile_policy = None
_hp('policy_e')
try:
    restore_profile_policy = install_private_profile_task_policy(root, home)
    if python_json:
        # 只接收面板已编译的固定 helper；该通道没有暴露任意脚本 HTTP/IPC 接口。
        _hp('pyjson_b')
        exec(compile(snippet, '<clawpanel-hermes-python-json>', 'exec'), {'__name__': '__main__'})
        _hp('pyjson_e')
        raise SystemExit(0)
    _hp('main_b')
    runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)
finally:
    restore_policy()
    if restore_profile_policy is not None:
        restore_profile_policy()
    _hp('main_exit')
`

/** 安装先确认原生 AMD64；普通运行还会在共享 Python 内再次调用原生 OS API。 */
export function hermesManagedInstallPlatformError({ platform, processArch, nativeArch = '', emulatedNativeArch = '', reportedArch = '' }) {
  if (platform !== 'win32') return null
  const hints = [processArch, nativeArch, emulatedNativeArch, reportedArch].map(value => String(value || '').trim().toLowerCase())
  if (hints.some(value => value === 'arm64' || value === 'aarch64')) {
    return 'Windows ARM64 受管安装已阻断（含 x64 模拟进程）：固定上游可能引导系统 BuildTools/管理员安装，尚无可靠禁止系统 bootstrap 的开关。'
  }
  if (String(nativeArch).trim().toLowerCase() !== 'amd64' || !['x64', 'x86_64'].includes(String(processArch).toLowerCase()) ||
      [emulatedNativeArch, reportedArch].some(value => value && !['amd64', 'x64', 'x86_64'].includes(String(value).trim().toLowerCase()))) {
    return 'Windows 原生 AMD64 架构未确认或架构信息矛盾，Hermes 受管安装已阻断。'
  }
  return null
}

export function resolveHermesPmEnvironment(home, source) {
  if (!fs.existsSync(source)) return null
  let canonical = fs.realpathSync(source)
  if (process.platform === 'win32') canonical = canonical.startsWith('\\\\?\\UNC\\') ? '\\\\' + canonical.slice(8) : canonical.replace(/^\\\\\?\\/, '')
  const key = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  const state = path.join(home, 'installs', key), facts = path.join(state, 'facts.json')
  if (!fs.existsSync(facts)) return null
  try {
    const value = JSON.parse(fs.readFileSync(facts, 'utf8').replace(/^\uFEFF/, '')).packages?.venv?.environment
    if (value == null) return null
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('环境路径不是绝对路径')
    const selected = fs.realpathSync(value), root = fs.realpathSync(path.join(state, 'environments'))
    // 环境根目录本身也须位于该 checkout 的 HOME，拒绝链接将整个根目录移出边界。
    const ownedRoot = path.join(fs.realpathSync(home), 'installs', key, 'environments')
    if (root !== ownedRoot) throw new Error('环境根目录链接越界')
    const relative = path.relative(root, selected)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(path.join(selected, 'pyvenv.cfg')).isFile()) throw new Error('环境不属于当前安装')
    return selected
  } catch (e) { throw new Error(`Hermes PM 环境记录损坏或越界，请修复当前安装：${e.message}`) }
}
