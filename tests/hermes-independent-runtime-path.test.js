import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const apiPath = new URL('../scripts/dev-api.js', import.meta.url).href

test('通用引擎 PATH 不依赖损坏 Hermes PM，Hermes 自身继续 fail-closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-engine-scope-'))
  try {
    const code = `import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
      const h=process.env.HERMES_HOME,s=path.join(h,'hermes-agent');fs.mkdirSync(s,{recursive:true});
      const k=crypto.createHash('sha256').update(fs.realpathSync(s)).digest('hex').slice(0,16),state=path.join(h,'installs',k);fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'facts.json'),'{broken');
      const m=await import(${JSON.stringify(apiPath)});assert.equal(typeof m.independentRuntimePath,'function');
      const p=m.independentRuntimePath();assert.equal(p.split(path.delimiter)[0],path.dirname(process.execPath));assert.ok(!p.includes(h));
      assert.throws(()=>m.buildHermesRuntimeEnv(),/Hermes PM/);console.log('PASS');`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: home, USERPROFILE: home, OPENCLAW_CONFIG_DIR: path.join(home,'.openclaw'), HERMES_HOME: path.join(home,'.hermes') },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /PASS/)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('DSH/OpenCode 五个宿主调用点只使用独立 PATH', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../scripts/dev-api.js', import.meta.url)), 'utf8')
  for (const name of ['commandAvailable','runCaptured','spawnDshWeb','findGlobalOpenCodeCommand','openCodeRuntimeEnv']) {
    const body = source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n}'))?.[0]
    assert.ok(body, name)
    assert.match(body, /independentRuntimePath\(\)/, name)
    assert.doesNotMatch(body, /hermesEnhancedPath\(\)/, name)
  }
})
