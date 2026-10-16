import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 先保留R19原始600秒红灯；只移除未被本验收使用的headed下载，不更换浏览器或放宽门禁。
const source = fs.readFileSync(new URL('../scripts/test-hermes-windows-qualification.mjs', import.meta.url), 'utf8')

test('Windows Web使用固定Playwright默认headless shell，只安装实际使用的Chromium构建', () => {
  assert.match(source, /'playwright@1\.58\.2'/)
  assert.match(source, /\[path\.join\(home, 'browser-tools\/node_modules\/playwright\/cli\.js'\), 'install', '--only-shell', 'chromium'\], \{ timeout: 600000 \}/)
  assert.match(source, /browser = await chromium\.launch\(\{ headless: true \}\)/)
  assert.doesNotMatch(source, /chromium\.launch\([^\n]*(?:channel|executablePath)/)
  assert.match(source, /PLAYWRIGHT_BROWSERS_PATH: path\.join\(home,/)
  assert.match(source, /context\.tracing\.start\(\{ screenshots: true, snapshots: true, sources: true \}\)/)
})

test('浏览器安装优化保留双流、原退出码和600秒拒绝，不以下载100%或现成宿主浏览器代替验收', () => {
  assert.match(source, /child\.stdout\.on\('data'/)
  assert.match(source, /child\.stderr\.on\('data'/)
  assert.match(source, /child\.once\('close', code =>/)
  assert.match(source, /assert\.equal\(result\.code, 0,/)
  assert.match(source, /child\.kill\(\); reject\(new Error\(`命令超时:/)
  for (const stage of ['runtime-ui', 'update-stop', 'uninstall-reinstall-preserve']) assert.ok(source.includes(`await stage('${stage}'`))
  assert.match(source, /await stopRuntime\(\)/)
})
