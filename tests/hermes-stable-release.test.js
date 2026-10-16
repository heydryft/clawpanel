import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPECTED_VERSION = '0.22.2'
const EXPECTED_TAG = 'v0.22.2'
const EXPECTED_COMMIT = 'd923a5eb487a17c0a68801bba9ef0f56c81040a8'

function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('Web and Tauri installers pin the supported Hermes stable release and immutable installer', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, new RegExp(`HERMES_STABLE_VERSION = '${EXPECTED_VERSION}'`))
  assert.match(webSource, new RegExp(`HERMES_STABLE_TAG = '${EXPECTED_TAG.replaceAll('.', '\\.')}'`))
  assert.match(webSource, new RegExp(`HERMES_STABLE_COMMIT = '${EXPECTED_COMMIT}'`))
  assert.match(webSource, /raw\.githubusercontent\.com\/NousResearch\/hermes-agent\/\$\{HERMES_STABLE_COMMIT\}\/scripts/)
  assert.match(webSource, /d7045a813ac5bbaec09ea4b65e5f77e47603ef56ae493414f72a4b3ce01de048/)
  assert.match(webSource, /f4cdb0e20f1aca2c3871a76b962fd4db61510f549cf973759c753ac13349beb5/)

  assert.match(tauriSource, new RegExp(`HERMES_STABLE_VERSION: &str = "${EXPECTED_VERSION}"`))
  assert.match(tauriSource, new RegExp(`HERMES_STABLE_TAG: &str = "${EXPECTED_TAG.replaceAll('.', '\\.')}"`))
  assert.match(tauriSource, new RegExp(`HERMES_STABLE_COMMIT: &str = "${EXPECTED_COMMIT}"`))
  assert.match(tauriSource, new RegExp(`raw\\.githubusercontent\\.com/NousResearch/hermes-agent/${EXPECTED_COMMIT}/scripts`))
  assert.match(readSource('src/lib/feature-catalog.js'), /hermes:\s*\{\s*default: '0\.22\.2'/)
})

test('Web install and update paths share the supported source installer', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const installBody = webSource.match(/async install_hermes\([^]*?\n  \},\n\n  async configure_hermes/)?.[0]
  const updateBody = webSource.match(/async update_hermes\([^]*?\n  \},\n\n  async uninstall_hermes/)?.[0]
  const tauriInstallBody = tauriSource.match(/pub async fn install_hermes\([^]*?\n}\n\n/)?.[0]
  const tauriUpdateBody = tauriSource.match(/pub async fn update_hermes\([^]*?\n}\n\n/)?.[0]

  assert.ok(installBody, 'install_hermes handler must be present')
  assert.ok(updateBody, 'update_hermes handler must be present')
  assert.match(installBody, /await installHermesManagedSource\(readPanelConfig\(\)\)/)
  assert.match(updateBody, /await installHermesManagedSource\(readPanelConfig\(\)\)/)
  assert.match(tauriInstallBody, /install_hermes_managed_source\(&app\)\.await\?/)
  assert.match(tauriUpdateBody, /install_hermes_managed_source\(&app\)\.await\?/)
  assert.doesNotMatch(installBody, /uv tool install|uv pip install/)
  assert.doesNotMatch(updateBody, /uv tool install|uv pip install/)
})

test('Hermes version detection probes --version before the legacy subcommand', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, /function runHermesVersionSilent\(\)[^]*?\['--version'\][^]*?\['version'\]/)
  assert.match(tauriSource, /fn hermes_version_at_path\(path: &str\)[^]*?&\["--version"\][^]*?&\["version"\]/)
  assert.match(webSource, /const ver = await runHermesVersionSilent\(\)/)
  assert.match(tauriSource, /match hermes_version_at_path\(&enhanced\)/)
})

test('source installer uses upstream stage protocol without mutating user PATH', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')

  assert.match(webSource, /stages: \['repository', 'venv', 'python-deps', 'config', 'complete'\]/)
  // 新 PM 禁用强制提交；固定旧 wrapper 必须显式启用，禁止将旧分支参数混入新协议。
  const legacyWeb = webSource.match(/    if \(HERMES_STABLE_VERSION === '0\.21\.5'\) \{[^]*?\n    \}(?=\n    if \(HERMES_STABLE_VERSION !== '0\.22\.2')/)?.[0]
  assert.ok(legacyWeb, '缺少精确旧版分支')
  assert.match(legacyWeb, /HERMES_STABLE_COMMIT !== 'f97608f178d1ffeca59860195ab7da295f7c8e5f'/)
  assert.match(legacyWeb, /'-ForceCommit'/)
  assert.doesNotMatch(webSource.replace(legacyWeb, ''), /'-ForceCommit'|'--force-commit'/)
  assert.match(webSource, /'-Commit', HERMES_STABLE_COMMIT,/)
  assert.match(webSource, /'--commit', HERMES_STABLE_COMMIT,/)
  assert.match(webSource, /HERMES_STABLE_BRANCH = 'release\/0\.22\.2'/)
  assert.match(webSource, /'--branch', HERMES_STABLE_BRANCH,/)
  assert.match(webSource, /'-Branch', HERMES_STABLE_BRANCH,/)
  assert.match(tauriSource, /HERMES_STABLE_BRANCH: &str = "release\/0\.22\.2"/)
  const legacyRust = tauriSource.match(/        if HERMES_STABLE_VERSION == "0\.21\.5" \{[^]*?\n        \} else \{/)?.[0]
  assert.ok(legacyRust, '缺少精确原生旧版分支')
  assert.match(legacyRust, /"f97608f178d1ffeca59860195ab7da295f7c8e5f"/)
  assert.match(legacyRust, /\.arg\("-ForceCommit"\)/)
  assert.doesNotMatch(tauriSource.replace(legacyRust, ''), /\.arg\("-ForceCommit"\)|\.arg\("--force-commit"\)/)
  assert.match(tauriSource, /\[\s*"repository",\s*"venv",\s*"python-deps",\s*"config",\s*"complete",?\s*\]/)
  assert.doesNotMatch(tauriSource, /"config-templates",\s*"platform-sdks",\s*"bootstrap-marker"/)
  assert.match(tauriSource, /\.arg\("-Commit"\)\s*\.arg\(HERMES_STABLE_COMMIT\)/)
  assert.match(tauriSource, /\.arg\("--commit"\)\s*\.arg\(HERMES_STABLE_COMMIT\)/)
})

test('source venv is preferred and uninstall only removes ClawPanel-managed artifacts', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const webPathBody = webSource.match(/function hermesEnhancedPath\([^]*?\n}\n\nexport function buildHermesRuntimeEnv/)?.[0]
  const webUninstallBody = webSource.match(/async uninstall_hermes\([^]*?\n  \},\n\n  \/\/ =+/)?.[0]
  const tauriUninstallBody = tauriSource.match(/pub async fn uninstall_hermes\([^]*?\n}\n\n\/\//)?.[0]

  assert.match(webPathBody, /\[path\.join\(hermesSourceDir\(\), '\.hermes', 'bin'\), hermesSourceVenvBinDir\(\), path\.join\(hermesHome\(\), 'bin'\), uvBinDir\(\)\]/)
  assert.match(tauriSource, /extra\.push\([\s\S]*?hermes_source_venv_bin_dir\(\)/)
  assert.match(webUninstallBody, /uninstallHermesManagedSourceAt\(home, cleanConfig\)/)
  assert.match(webUninstallBody, /uv[^]*?tool[^]*?uninstall[^]*?hermes-agent/)
  assert.match(webSource, /export async function uninstallHermesManagedSourceAt/)
  assert.match(webSource, /path\.join\(home, 'bin', isWindows \? 'uv\.exe' : 'uv'\)/)
  assert.match(webSource, /path\.join\(home, '\.clawpanel-cache'\)/)
  assert.match(tauriUninstallBody, /kill_gateway_pid\(\)/)
  assert.match(tauriUninstallBody, /kill_dashboard_pid\(\)/)
  assert.match(tauriUninstallBody, /hermes_home\(\)\.join\("\.clawpanel-cache"\)/)
  assert.doesNotMatch(tauriUninstallBody, /\["uninstall", "--yes"\]/)
})

test('Hermes model sync preserves nested model keys from the 0.20.5 config template', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-hermes-model-sync-'))
  try {
    const { syncHermesProviderFilesAt, repairHermesCustomProviderRoutingAt } = await import('../scripts/dev-api.js')
    const YAML = await import('yaml')
    fs.writeFileSync(path.join(tempHome, 'config.yaml'), [
      'model:',
      '  default: old-model',
      '  provider: auto',
      'stt:',
      '  local:',
      '    model: whisper-large-v3',
      '    device: cpu',
      'platforms:',
      '  api_server:',
      '    enabled: true',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(tempHome, '.env'), '')

    syncHermesProviderFilesAt(tempHome, {
      provider: 'custom',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:19999/v1',
      model: 'smoke-model',
      setDefault: true,
    })
    repairHermesCustomProviderRoutingAt(tempHome)
    const saved = YAML.parse(fs.readFileSync(path.join(tempHome, 'config.yaml'), 'utf8'))

    assert.equal(saved.model.default, 'smoke-model')
    assert.equal(saved.model.provider, 'custom:clawpanel')
    assert.equal(saved.stt.local.model, 'whisper-large-v3')
    assert.equal(saved.stt.local.device, 'cpu')
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('ClawPanel provides a token-bootstrap Dashboard dist for the pinned Hermes release', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpanel-hermes-dashboard-'))
  try {
    const { ensureHermesDashboardFallbackDist } = await import('../scripts/dev-api.js')
    const dist = ensureHermesDashboardFallbackDist(tempHome)
    const indexPath = path.join(dist, 'index.html')

    assert.equal(dist, path.join(tempHome, 'clawpanel-dashboard-web-dist'))
    assert.equal(fs.statSync(path.join(dist, 'assets')).isDirectory(), true)
    assert.match(fs.readFileSync(indexPath, 'utf8'), /clawpanel-dashboard-spa-stub/)

    fs.writeFileSync(indexPath, 'preserve-existing-dashboard-index')
    ensureHermesDashboardFallbackDist(tempHome)
    assert.equal(fs.readFileSync(indexPath, 'utf8'), 'preserve-existing-dashboard-index')
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})

test('Web and Tauri Dashboard launchers use the managed dist without opening a browser', () => {
  const webSource = readSource('scripts/dev-api.js')
  const tauriSource = readSource('src-tauri/src/commands/hermes.rs')
  const webStartBody = webSource.match(/async hermes_dashboard_start\([^]*?\n  \},\n\n  async hermes_dashboard_stop/)?.[0]
  const tauriStartBody = tauriSource.match(/pub async fn hermes_dashboard_start\([^]*?\n}\n\n/)?.[0]

  assert.ok(webStartBody, 'Web hermes_dashboard_start handler must be present')
  assert.ok(tauriStartBody, 'Tauri hermes_dashboard_start command must be present')
  assert.match(webStartBody, /envVars\.HERMES_WEB_DIST = ensureHermesDashboardFallbackDist\(home\)/)
  assert.match(webStartBody, /spawnHermes\(\['dashboard', '--no-open', '--port', String\(port\)\]/)
  assert.match(webSource, /function spawnHermes[^]*?hermesLaunchSpec\(args\)/)
  assert.match(tauriStartBody, /ensure_hermes_dashboard_fallback_dist\(&home\)/)
  assert.match(tauriStartBody, /cmd\.args\(\["dashboard", "--no-open", "--port", &port\.to_string\(\)\]\)/)
  assert.match(tauriStartBody, /cmd\.env\("HERMES_WEB_DIST", dashboard_dist\)/)
})
