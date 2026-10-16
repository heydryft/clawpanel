import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as windows from '../scripts/hermes-windows-script-envelope.js'
test('已审旧21.5 Windows启动走真实私有venv和固定wrapper，非Windows/globalfallback保持',t=>{
 assert.equal(typeof windows.hermesLegacyWindowsSpec,'function','缺少真实old Web入口')
 const home=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'legacy-spec-'))),root=path.join(home,'hermes-agent'),python=path.join(root,'venv/Scripts/python.exe')
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'owned logical fixture not executed')
 const args=['--profile','n'.repeat(63),'gateway','run'],before=[...args]
 const s=windows.hermesLegacyWindowsSpec(args,{platform:'win32',home,root})
 assert.equal(s.program,python);assert.deepEqual(s.args.slice(0,3),['-I','-B','-c']);assert.deepEqual(s.args.slice(4),[root,home,'f97608f178d1ffeca59860195ab7da295f7c8e5f','console','--',...args]);assert.deepEqual(args,before)
 const d=windows.decodeHermesWindowsScript(s.args[3]);assert.equal(d.pin,'f97608f178d1ffeca59860195ab7da295f7c8e5f');assert.ok(d.script.includes('def install_windows_private_identity('));assert.ok(d.script.includes('def install_windows_cim_probe('));assert.ok(d.script.includes('gateway/status.py'))
 assert.equal(windows.hermesLegacyWindowsSpec(args,{platform:'linux',home,root}),null)
 assert.equal(windows.hermesLegacyWindowsSpec(args,{platform:'win32',home,root:path.join(home,'absent')}),null)
 const web=fs.readFileSync(new URL('../scripts/dev-api.js',import.meta.url),'utf8'),rust=fs.readFileSync(new URL('../src-tauri/src/commands/hermes.rs',import.meta.url),'utf8')
 assert.match(web,/hermesLegacyWindowsSpec\(args,/)
 assert.match(rust,/hermes_windows::legacy_spec\(&home, &root\)/)
})
