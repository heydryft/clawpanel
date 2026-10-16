import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

const pins = { '0.22.2': 'd923a5eb487a17c0a68801bba9ef0f56c81040a8', '0.21.5': 'f97608f178d1ffeca59860195ab7da295f7c8e5f' }
const cimSource = fs.readFileSync(new URL('./hermes-windows-cim-probe.py', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

// 无PM的受管旧venv只进入固定21.5准入；真正的global CLI保留原fallback。
export function hermesLegacyWindowsSpec(args, { platform = process.platform, home, root } = {}) {
  const python = path.join(root, 'venv', 'Scripts', 'python.exe')
  if (platform !== 'win32' || !fs.existsSync(python)) return null
  const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const body = read('./hermes-legacy-gateway-identity.py') + '\n' + read('./hermes-legacy-windows-launch.py')
  const pin = pins['0.21.5']
  return { program: python, args: ['-I', '-B', '-c', hermesWindowsScript(body, { platform, version: '0.21.5', pin }), root, home, pin, 'console', '--', ...args] }
}

export const HERMES_WINDOWS_CIM_INSTALL = String.raw`    if os.name=='nt':
        for _cp_file,_cp_sha in [('hermes_cli/gateway.py','a6ca31202bc461a145f9e6df3b80daed2ea435599cf176ac86e9b98f118ff899'),('hermes_cli/_subprocess_compat.py','4d036c56de8065099f4b82a50fde9095c43dab7e851e0e3a3fe4cd5c143a212e'),('hermes_cli/local_runtime/processes.py','763c450a9fe8b7eea5684576564b1fe8ffd58d6c16fc444dfd5e3b14986efb2b')]:
            require(hashlib.sha256((root/_cp_file).read_bytes()).hexdigest()==_cp_sha,'Windows CIM source contract changed')
        from hermes_cli import gateway as _cp_g, _subprocess_compat as _cp_c
        from hermes_cli.local_runtime.processes import spawn_server as _cp_s
        _cp_cim_restore=install_windows_cim_probe(_cp_g,_cp_c,_cp_s)
`

export const HERMES_WINDOWS_SCRIPT_ENVELOPE = String.raw`# CLAWPANEL_PRIVATE_SCRIPT_V1 __PIN__ __SHA__
import base64 as _cp_b, zlib as _cp_z, hashlib as _cp_h
_cp_d=_cp_z.decompressobj()
_CLAWPANEL_EXECUTED_SCRIPT_BYTES=_cp_d.decompress(_cp_b.b64decode('__DATA__',validate=True),131073)
if len(_CLAWPANEL_EXECUTED_SCRIPT_BYTES)>131072 or not _cp_d.eof or _cp_d.unused_data or _cp_h.sha256(_CLAWPANEL_EXECUTED_SCRIPT_BYTES).hexdigest()!='__SHA__':raise SystemExit('ClawPanel private script integrity failed')
exec(compile(_CLAWPANEL_EXECUTED_SCRIPT_BYTES,'<clawpanel-hermes-private>','exec'))
`

// 只是压缩本地已审静态模板以避免 Windows argv 上限；不接收下载/用户代码。
function envelope(payload, pin, sha) {
  return HERMES_WINDOWS_SCRIPT_ENVELOPE.replaceAll('__PIN__', pin).replaceAll('__SHA__', sha).replaceAll('__DATA__', payload)
}

export function hermesWindowsScript(base, { platform = process.platform, version, pin } = {}) {
  if (platform !== 'win32') return base
  if (pins[version] !== pin || typeof base !== 'string' || base.includes('\0')) throw Error('Hermes Windows script contract mismatch')
  let script = base.replaceAll('\r\n', '\n')
  if (version === '0.22.2') {
    const anchor = "    _hp('main_b')\n", final = '\nfinally:\n'
    if (!script.includes(pin) || script.split(anchor).length !== 2 || script.split(final).length !== 2) throw Error('Hermes Windows PM contract mismatch')
    const install = HERMES_WINDOWS_CIM_INSTALL
    script = script.replace(anchor, install + anchor).replace(final, "\nfinally:\n    if callable(globals().get('_cp_cim_restore')):_cp_cim_restore()\n")
  } else if (!script.includes(pin) || !script.includes('install_windows_cim_probe')) throw Error('Hermes Windows legacy contract mismatch')
  let decoder = ''
  if (version === '0.22.2' && script.includes('install_private_gateway_identity(') && !script.includes('def decode_clawpanel_private_script_bytes')) {
    const pm = fs.readFileSync(new URL('./hermes-pm-runtime.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    decoder = pm.split('export const HERMES_PRIVATE_SCRIPT_BYTES_DECODER = String.raw`')[1]?.split('`')[0]
    if (!decoder?.includes('def decode_clawpanel_private_script_bytes')) throw Error('Hermes private decoder contract missing')
  }
  const combined = cimSource + '\n' + decoder + script, raw = Buffer.from(combined, 'utf8')
  if (raw.length > 131072) throw Error('Hermes Windows source budget exceeded')
  const wire = envelope(deflateSync(raw, { level: 9 }).toString('base64'), pin, hash(raw))
  if (wire.length > 30000) throw Error('Hermes Windows command budget exceeded')
  return wire
}

/** 有界只读解包，供身份/诊断互操作验证；绝不 eval/执行候选 argv。 */
export function decodeHermesWindowsScript(wire) {
  if (typeof wire !== 'string' || wire.length > 30000) throw Error('Hermes envelope contract mismatch')
  const header = wire.match(/^# CLAWPANEL_PRIVATE_SCRIPT_V1 ([a-f0-9]{40}) ([a-f0-9]{64})\n/)
  const payload = wire.match(/_cp_b\.b64decode\('([A-Za-z0-9+/=]+)',validate=True\)/)?.[1]
  if (!header || !payload || !Object.values(pins).includes(header[1]) || wire !== envelope(payload, header[1], header[2])) throw Error('Hermes envelope contract mismatch')
  const bytes = Buffer.from(payload, 'base64')
  if (bytes.toString('base64') !== payload) throw Error('Hermes envelope encoding contract mismatch')
  const decoded = inflateSync(bytes, { maxOutputLength: 131072, info: true })
  if (decoded.engine.bytesWritten !== bytes.length || hash(decoded.buffer) !== header[2]) throw Error('Hermes envelope integrity mismatch')
  const script = decoded.buffer.toString('utf8')
  if (!Buffer.from(script).equals(decoded.buffer)) throw Error('Hermes envelope UTF8 contract mismatch')
  return { pin: header[1], sha256: header[2], script }
}
