import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import * as pm from '../scripts/hermes-pm-runtime.js'
import { HERMES_WINDOWS_SCRIPT_ENVELOPE, hermesWindowsScript, decodeHermesWindowsScript } from '../scripts/hermes-windows-script-envelope.js'

const pin = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'
const python = process.env.HERMES_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
// 固定V1线协议夹具；只产生样本，既不解包也不执行候选内容。
function frame(payload, sha, sourcePin = pin) {
  return `# CLAWPANEL_PRIVATE_SCRIPT_V1 ${sourcePin} ${sha}
import base64 as _cp_b, zlib as _cp_z, hashlib as _cp_h
_cp_d=_cp_z.decompressobj()
_CLAWPANEL_EXECUTED_SCRIPT_BYTES=_cp_d.decompress(_cp_b.b64decode('${payload}',validate=True),131073)
if len(_CLAWPANEL_EXECUTED_SCRIPT_BYTES)>131072 or not _cp_d.eof or _cp_d.unused_data or _cp_h.sha256(_CLAWPANEL_EXECUTED_SCRIPT_BYTES).hexdigest()!='${sha}':raise SystemExit('ClawPanel private script integrity failed')
exec(compile(_CLAWPANEL_EXECUTED_SCRIPT_BYTES,'<clawpanel-hermes-private>','exec'))
`
}
const wire = (bytes, level = 9) => frame(deflateSync(bytes, { level }).toString('base64'), hash(bytes))
const raw = Buffer.from("# 完整原文\nraise RuntimeError('DECODER_MUST_NOT_EXECUTE')\n")

function decode(cases) {
  const code = String.raw`
import ast,base64,builtins,hashlib,json,re,sys,zlib
d=json.loads(sys.stdin.buffer.read().decode('utf-8'));ns={}
if d['decoder']:
    tree=ast.parse(d['decoder'])
    assert not any(isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id in {'exec','eval','compile'} for n in ast.walk(tree))
    exec(compile(tree,'<fixed-readonly-decoder>','exec'),ns)
    fn=ns['decode_clawpanel_private_script_bytes']
else:
    fn=lambda source,pin:source.encode('utf-8')
rows=[]
original=builtins.exec
def forbidden(*a,**kw):raise AssertionError('decoder executed source')
builtins.exec=forbidden
try:
 for case in d['cases']:
    try:
        result=fn(case['wire'],case['pin'])
        rows.append(dict(ok=True,sha256=hashlib.sha256(result).hexdigest(),size=len(result)))
    except (ValueError,TypeError,UnicodeError) as error:
        rows.append(dict(ok=False,error=str(error)))
finally:builtins.exec=original
print(json.dumps(rows))
`
  const r = spawnSync(python, ['-I', '-B', '-c', code], { input: JSON.stringify({ decoder: pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER || '', cases }), encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  return JSON.parse(r.stdout)
}

test('严格V1解包：不同合法zlib payload得到相同完整字节，不执行任何payload', () => {
  const a = wire(raw, 0), b = wire(raw, 9)
  assert.notEqual(a, b)
  const rows = decode([a, b, raw.toString()].map(wire => ({ wire, pin })))
  assert.ok(rows.every(r => r.ok && r.sha256 === hash(raw) && r.size === raw.length), JSON.stringify(rows))
})

test('fixture frame逐字节等于真实JS共享模板，不以两个mock彼此对齐', () => {
  const payload = deflateSync(raw).toString('base64'), sha = hash(raw)
  assert.equal(frame(payload, sha), HERMES_WINDOWS_SCRIPT_ENVELOPE.replaceAll('__PIN__', pin).replaceAll('__SHA__', sha).replaceAll('__DATA__', payload))
})

test('完整schema/PIN/SHA/base64/无尾料，不凭header或generic zlib判定可信', () => {
  const bytes = deflateSync(raw), payload = bytes.toString('base64'), valid = frame(payload, hash(raw))
  const bad = [
    valid + '\nprint(1)', valid.replaceAll('\n', '\r\n'), valid.replace(' as _cp_z', ' as _evil'),
    frame(payload, '0'.repeat(64)), frame(payload, hash(raw), 'f97608f178d1ffeca59860195ab7da295f7c8e5f'),
    frame(Buffer.concat([bytes, Buffer.from('tail')]).toString('base64'), hash(raw)),
    frame(Buffer.concat([bytes, bytes]).toString('base64'), hash(raw)),
    frame(payload + '=', hash(raw)), frame(payload.slice(1), hash(raw)),
    '# CLAWPANEL_PRIVATE_SCRIPT_V1 malformed\n',
  ]
  const rows = decode(bad.map(wire => ({ wire, pin })))
  assert.ok(rows.every(r => !r.ok), JSON.stringify(rows))
  const generic = "import zlib; exec(zlib.decompress(b'generic'))"
  assert.notEqual(decode([{ wire: generic, pin }])[0].sha256, hash(raw), '通用压缩程序不能伪装成解包后的可信源码')
})

test('128KiB decoded边界、30000 wire上限、非UTF8/NUL与未知pin均fail-closed', () => {
  const exact = Buffer.alloc(131072, 65), over = Buffer.alloc(131073, 65)
  const rows = decode([
    { wire: wire(exact), pin }, { wire: wire(over), pin },
    { wire: wire(Buffer.from([0xff])), pin }, { wire: wire(Buffer.from([0])), pin },
    { wire: frame('A'.repeat(30000), '0'.repeat(64)), pin }, { wire: 'raw', pin: '0'.repeat(40) },
  ])
  assert.deepEqual(rows.map(r => r.ok), [true, false, false, false, false, false])
  assert.equal(rows[0].size, 131072)
})

test('真实identity函数接口：outer字节不同但decoded完全相同，globals/raw/精确PID门禁保持', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-pm-stop-upstream.json', import.meta.url), 'utf8'))
  const source = Buffer.from(pm.HERMES_PRIVATE_LAUNCH_SCRIPT)
  const r = spawnSync(python, ['-I', '-B', new URL('./fixtures/hermes-pm-stop-identity.py', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), 'envelope'], {
    input: JSON.stringify({ fixture, script: pm.HERMES_PRIVATE_LAUNCH_SCRIPT, identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT, decoder: pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER || '', envelopes: [wire(source, 1), wire(source, 9)] }),
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  if (process.env.HERMES_ENVELOPE_TEST_EVIDENCE) {
    fs.mkdirSync(process.env.HERMES_ENVELOPE_TEST_EVIDENCE, { recursive: true })
    fs.writeFileSync(path.join(process.env.HERMES_ENVELOPE_TEST_EVIDENCE, 'identity-envelope.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }, null, 2))
  }
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  assert.ok(JSON.parse(r.stdout).passed >= 8)
})

test('真实Node生成Windows wire进入实际STOP checker：完整CIM+PM body、不同压缩流、无执行', () => {
  const decoder = pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER || ''
  assert.ok(decoder, '必须显式提供可信decoder，不能因未知格式退回宽松匹配')
  const actualWire = hermesWindowsScript(decoder + pm.HERMES_PRIVATE_LAUNCH_SCRIPT, { platform: 'win32', version: '0.22.2', pin })
  const decoded = decodeHermesWindowsScript(actualWire)
  const alternate = wire(Buffer.from(decoded.script), 1)
  assert.notEqual(actualWire, alternate)
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-pm-stop-upstream.json', import.meta.url), 'utf8'))
  const r = spawnSync(python, ['-I', '-B', new URL('./fixtures/hermes-pm-stop-identity.py', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), 'envelope'], {
    input: JSON.stringify({ fixture, script: decoded.script, identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT, decoder, envelopes: [actualWire, alternate] }),
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
  if (process.env.HERMES_ENVELOPE_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_ENVELOPE_TEST_EVIDENCE, 'real-node-wire.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, wireSha256: hash(actualWire), decodedSha256: decoded.sha256, wireLength: actualWire.length, alternateLength: alternate.length, decodedLength: Buffer.byteLength(decoded.script) }, null, 2))
  assert.equal(r.status, 0, r.stderr || r.error?.message)
  assert.ok(JSON.parse(r.stdout).passed >= 8)
})

test('生产adapter只接收显式可信decoder，未知格式不回退native matcher', () => {
  assert.match(pm.HERMES_PRIVATE_LAUNCH_SCRIPT, /install_private_gateway_identity\(root, home, launch_script, mode\.startswith\('--portable'\), script_bytes=globals\(\)\.get\('decode_clawpanel_private_script_bytes'\)\)/)
})

// 显式只读输入：可复验main留存的真实composer样本，不读取/执行Hermes源码或宿主HOME。
if (process.env.HERMES_REAL_NODE_WIRE_EVIDENCE) {
  test('独立composer保存的wire.py/argv.json进入当前原身份checker，named63保持精确边界', () => {
    const root = process.env.HERMES_REAL_NODE_WIRE_EVIDENCE
    const actualWire = fs.readFileSync(path.join(root, 'wire.py'), 'utf8')
    const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'))
    assert.equal(actualWire, argv[4], '文件必须与真实argv中的完整-c完全相同')
    assert.deepEqual(argv.slice(9), ['--profile', 'n'.repeat(63), 'gateway', 'run'])
    const decoded = decodeHermesWindowsScript(actualWire)
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/hermes-pm-stop-upstream.json', import.meta.url), 'utf8'))
    const r = spawnSync(python, ['-I', '-B', new URL('./fixtures/hermes-pm-stop-identity.py', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''), 'envelope'], {
      input: JSON.stringify({ fixture, script: decoded.script, launcher: pm.HERMES_PRIVATE_LAUNCH_SCRIPT, identity: pm.HERMES_PRIVATE_GATEWAY_IDENTITY_SCRIPT, decoder: pm.HERMES_PRIVATE_SCRIPT_BYTES_DECODER, profile: argv[10], envelopes: [actualWire, wire(Buffer.from(decoded.script), 1)] }),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    })
    if (process.env.HERMES_ENVELOPE_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.HERMES_ENVELOPE_TEST_EVIDENCE, 'main-composer-wire.json'), JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, wireSha256: hash(actualWire), decodedSha256: decoded.sha256, scope: 'fixed-helper-readonly-not-Hermes-execution-or-Windows-qualification' }, null, 2))
    assert.equal(r.status, 0, r.stderr || r.error?.message)
  })
}
