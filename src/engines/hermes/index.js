/**
 * Hermes Agent 引擎
 */
import { t } from '../../lib/i18n.js'
import { api, invalidate } from '../../lib/tauri-api.js'

// Hermes 状态
let _ready = false
let _running = false
let _installed = null
let _listeners = []
let _pollTimer = null
let _probeSequence = 0
let _bootGeneration = 0

// 仅广播独立、不可变的安装/服务primitive；不传播模型、路径、缓存对象或凭据。
export function projectHermesHealth(info) {
  const boolean = value => typeof value === 'boolean' ? value : null
  const installed = boolean(info?.installed)
  return Object.freeze({
    installed, configExists: boolean(info?.configExists), gatewayRunning: boolean(info?.gatewayRunning),
    version: installed === true && typeof info?.version === 'string' && info.version.length <= 128 && !/\bsk-[a-zA-Z0-9_-]+/.test(info.version) && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(info.version) ? info.version : null,
    detectionError: installed === null && info ? 'CLI_PROBE_FAILED' : null,
  })
}

export function healthObservationApplies(startedAt, scopeSince, lastApplied, disposed, observedGeneration, currentGeneration) {
  return !disposed && Number.isFinite(startedAt) && startedAt >= scopeSince && startedAt >= lastApplied && observedGeneration === currentGeneration
}

async function detectHermesStatus() {
  const sequence = ++_probeSequence, startedAt = performance.now()
  let info
  try {
    invalidate('check_hermes')
    info = await api.checkHermes()
    if (sequence !== _probeSequence) return _ready
    const health = projectHermesHealth(info)
    _installed = health.installed
    _ready = health.installed === true && health.configExists === true
    _running = health.gatewayRunning === true
  } catch (_) {
    if (sequence !== _probeSequence) return _ready
    info = { installed: null, detectionError: 'CLI_PROBE_FAILED' }
    _installed = null
    _ready = false
    _running = false
  }
  // 同步抛错与异步拒绝分别隔离；不等待消费者，不触发额外状态查询。
  _listeners.forEach(fn => { try { Promise.resolve(fn(Object.freeze({ ready: _ready, running: _running, startedAt, info: projectHermesHealth(info) }))).catch(() => {}) } catch (_) {} })
  return _ready
}

function startPoll() {
  if (_pollTimer) return
  _pollTimer = setInterval(detectHermesStatus, 15000)
}

function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

export default {
  id: 'hermes',
  name: 'Hermes Agent',
  description: 'Hermes AI Agent with tool-calling capabilities',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',

  async detect() {
    await detectHermesStatus()
    return { installed: _installed, ready: _ready }
  },

  async boot() {
    const generation = ++_bootGeneration
    await detectHermesStatus()
    // cleanup或更新boot已取消本次范围时，不重新安装旧轮询。
    if (generation !== _bootGeneration) return
    startPoll()
  },

  cleanup() {
    _bootGeneration++
    _probeSequence++
    stopPoll()
  },

  getNavItems() {
    // 未就绪时显示 Setup 菜单
    if (!_ready) {
      return [{
        section: '',
        items: [
          { route: '/h/setup', label: t('sidebar.setup'), icon: 'setup' },
          { route: '/assistant', label: t('sidebar.assistant'), icon: 'assistant' },
        ]
      }, {
        section: '',
        items: [
          { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
          { route: '/about', label: t('sidebar.about'), icon: 'about' },
        ]
      }]
    }
    // 就绪后显示完整菜单
    return [{
      section: t('sidebar.sectionMonitor'),
      items: [
        { route: '/h/dashboard', label: t('sidebar.dashboard'), icon: 'dashboard' },
        { route: '/h/chat', label: t('sidebar.chat'), icon: 'chat' },
        { route: '/h/group-chat', label: t('engine.hermesGroupChatTitle'), icon: 'agents' },
        { route: '/h/sessions', label: t('sidebar.sessions'), icon: 'inbox' },
        { route: '/h/logs', label: t('sidebar.logs'), icon: 'logs' },
        { route: '/h/usage', label: t('sidebar.usage'), icon: 'bar-chart' },
      ]
    }, {
      section: t('sidebar.sectionManage'),
      items: [
        { route: '/h/skills', label: t('sidebar.skills'), icon: 'skills' },
        { route: '/h/memory', label: t('sidebar.memory'), icon: 'memory' },
        { route: '/h/cron', label: t('sidebar.cron'), icon: 'clock' },
        { route: '/h/profiles', label: t('engine.hermesProfilesTitle'), icon: 'agents' },
        { route: '/h/gateways', label: t('engine.hermesGatewaysTitle'), icon: 'gateway' },
        { route: '/h/channels', label: t('engine.hermesChannelsTitle'), icon: 'channels' },
        { route: '/h/kanban', label: t('engine.hermesKanbanTitle'), icon: 'inbox' },
        { route: '/h/oauth', label: t('engine.hermesOAuthTitle'), icon: 'memory' },
        { route: '/h/files', label: t('engine.hermesFilesTitle'), icon: 'folder' },
        { route: '/h/lazy-deps', label: t('hermesLazyDeps.title'), icon: 'package' },
        { route: '/h/extensions', label: t('sidebar.extensions'), icon: 'package' },
      ]
    }, {
      section: '',
      items: [
        { route: '/assistant', label: t('sidebar.assistant'), icon: 'assistant' },
        { route: '/settings', label: t('sidebar.settings'), icon: 'settings' },
        { route: '/glossary', label: t('sidebar.glossary'), icon: 'about' },
        { route: '/about', label: t('sidebar.about'), icon: 'about' },
      ]
    }]
  },

  getRoutes() {
    return [
      // Hermes 专属页面（/h/ 前缀）
      { path: '/h/setup', loader: () => import('./pages/setup.js') },
      { path: '/h/dashboard', loader: () => import('./pages/dashboard.js') },
      { path: '/h/chat', loader: () => import('./pages/chat.js') },
      { path: '/h/group-chat', loader: () => import('./pages/group-chat.js') },
      { path: '/h/oauth', loader: () => import('./pages/oauth.js') },
      { path: '/h/files', loader: () => import('./pages/files.js') },
      { path: '/h/sessions', loader: () => import('./pages/sessions.js') },
      { path: '/h/logs', loader: () => import('./pages/logs.js') },
      { path: '/h/usage', loader: () => import('./pages/usage.js') },
      { path: '/h/skills', loader: () => import('./pages/skills.js') },
      { path: '/h/memory', loader: () => import('./pages/memory.js') },
      { path: '/h/cron', loader: () => import('./pages/cron.js') },
      { path: '/h/extensions', loader: () => import('./pages/extensions.js') },
      { path: '/h/gateways', loader: () => import('./pages/gateways.js') },
      { path: '/h/profiles', loader: () => import('./pages/profiles.js') },
      { path: '/h/kanban', loader: () => import('./pages/kanban.js') },
      { path: '/h/lazy-deps', loader: () => import('./pages/lazy-deps.js') },
      { path: '/h/services', loader: () => import('./pages/services.js') },
      { path: '/h/config', loader: () => import('./pages/config.js') },
      { path: '/h/channels', loader: () => import('./pages/channels.js') },
      { path: '/h/env', loader: () => import('./pages/env-editor.js') },
      // 共用页面（引擎无关）
      { path: '/assistant', loader: () => import('../../pages/assistant.js') },
      { path: '/settings', loader: () => import('../../pages/settings.js') },
      { path: '/about', loader: () => import('../../pages/about.js') },
      { path: '/glossary', loader: () => import('../../pages/glossary.js') },
    ]
  },

  getSetupRoute() { return '/h/setup' },
  getDefaultRoute() { return '/h/dashboard' },

  isReady() { return _ready },
  isGatewayRunning() { return _running },
  isGatewayForeign() { return false },

  onStateChange(fn) {
    _listeners.push(fn)
    return () => { _listeners = _listeners.filter(cb => cb !== fn) }
  },
  onReadyChange(fn) {
    _listeners.push(fn)
    return () => { _listeners = _listeners.filter(cb => cb !== fn) }
  },

  isFeatureAvailable() { return true },
}
