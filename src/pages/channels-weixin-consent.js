import { t } from '../lib/i18n.js'

const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const labels = { channels: 'channels', providers: 'providers', tools: 'tools', contracts: 'contracts', hooks: 'hooks', mcpServers: 'mcp', cliCommands: 'commands', cliBackends: 'backends', skills: 'skills', dangerousConfigFlags: 'flags' }
const surface = value => Object.entries(value || {}).filter(([, items]) => Array.isArray(items) && items.length).map(([key, items]) => `${t('channels.weixinCapability_' + (labels[key] || key))}：${items.map(item => item === 'openclaw-weixin' ? t('channels.weixinName') : String(item)).join('、')}`)
const warning = text => {
  const match = String(text).match(/^(network-code|environment-access|process-execution): (\d+) files$/)
  return match ? t('channels.weixinFinding_' + match[1], { count: match[2] }) : String(text)
}

export function renderWeixinManualConsentHint() {
  return `<p data-weixin-manual-consent class="form-hint">${escape(t('channels.weixinManualConsent'))}</p>`
}

// 仅投影已核实的公开审查字段，不把整个 prepare 对象序列化进 DOM（含单次能力）。
export function renderWeixinConsentReview(prepared) {
  const a = prepared.artifact, r = prepared.review
  const operation = t(prepared.operation === 'upgrade' ? 'channels.weixinConsentUpgrade' : 'channels.weixinConsentInstall')
  const declared = surface(r.declared), added = surface(r.addedDeclared)
  const expiry = new Date(prepared.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const details = { packageName: a.packageName, version: a.version, sourceURL: a.url, SHA256: a.sha256, SRI: a.integrity, manifestHash: r.manifestSha256, reviewToken: r.reviewToken, declared: r.declared, previous: r.previousDeclared, added: r.addedDeclared, scan: r.scan }
  return `<div style="font-size:var(--font-size-sm);line-height:1.6;overflow-wrap:anywhere">
    <p style="font-size:var(--font-size-md);font-weight:600;margin:0 0 8px">${escape(operation)} · ${escape(a.version)}</p>
    <p style="color:var(--text-secondary);margin:0 0 12px">${escape(t('channels.weixinConsentHost', { host: prepared.hostVersion }))}<br>${escape(t('channels.weixinConsentSource', { source: new URL(a.url).hostname }))}</p>
    <p style="margin:0 0 8px">${declared.map(escape).join('<br>')}</p>
    <p style="margin:0 0 12px"><strong>${escape(t('channels.weixinConsentAdded'))}</strong><br>${added.length ? added.map(escape).join('<br>') : escape(t('channels.weixinConsentNoAdded'))}</p>
    <p style="color:var(--warning);margin:0 0 8px">${escape(t('channels.weixinConsentRisk'))}</p>
    <ul style="margin:0 0 12px;padding-left:20px">${(r.warnings || []).map(item => `<li>${escape(warning(item))}</li>`).join('')}</ul>
    ${prepared.capabilityMode === 'legacy-reviewed' ? `<p>${escape(t('channels.weixinConsentLegacy'))}</p>` : ''}
    <p style="color:var(--text-secondary);margin:0 0 12px">${escape(t('channels.weixinConsentExpires', { expires: expiry }))}</p>
    <details style="margin-bottom:16px"><summary style="cursor:pointer">${escape(t('channels.weixinConsentDetails'))}</summary><pre style="max-height:240px;overflow:auto;white-space:pre-wrap;font-size:var(--font-size-sm);line-height:1.5;padding:8px;background:var(--bg-secondary);border-radius:var(--radius-sm)">${escape(JSON.stringify(details, null, 2))}</pre></details>
    <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer"><input type="checkbox" data-weixin-consent-accept style="margin-top:5px;flex-shrink:0"><span>${escape(t('channels.weixinConsentAccept'))}</span></label>
  </div>`
}
