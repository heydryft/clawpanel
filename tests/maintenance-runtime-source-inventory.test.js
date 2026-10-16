import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
const text=fs.readFileSync(new URL('../scripts/maintenance-runtime-smoke.mjs',import.meta.url),'utf8')
const body=text.match(/function collectCandidateSourceHashes\([^]*?\n\}/)?.[0]
const inventory=new Function('fs','path','crypto','assert',body+';return collectCandidateSourceHashes')(fs,path,crypto,assert)
const files=['scripts/hermes-windows-cim-probe.py','scripts/hermes-windows-script-envelope.js','scripts/hermes-legacy-windows-launch.py','scripts/hermes-legacy-gateway-identity.py','scripts/weixin-install-consent.js','scripts/weixin-install-consent-artifact.js']
test('真实运行时源快照包含新增生产依赖，不把旧分支文件缺失冒充新源码冻结',t=>{
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-source-inventory-')))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const required=[...body.matchAll(/['"]((?:scripts|src|\.github)\/[^'"]+|package\.json|package-lock\.json|openclaw-version-policy\.json|Dockerfile)['"]/g)].map(x=>x[1]).filter(x=>!files.includes(x))
 for(const name of required){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),'old-fixture:'+name)}
 const before=inventory(root)
 for(const name of files){fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true});fs.writeFileSync(path.join(root,name),'new-fixture:'+name)}
 const after=inventory(root)
 for(const name of files){assert.equal(after[name],crypto.createHash('sha256').update('new-fixture:'+name).digest('hex'),name);assert.equal(Object.hasOwn(before,name),false)}
 assert.equal(Object.keys(after).length,Object.keys(before).length+files.length)
})
