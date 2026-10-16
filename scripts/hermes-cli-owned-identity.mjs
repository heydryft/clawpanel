// 合成CLI验收专用：保留原raw结果，只按前置时间证明排除旧创建身份；不控制产品进程。
export const FIXTURE_IDENTITY_LIMITS = Object.freeze({ materialBytes: 8 * 1024 * 1024, rawSweeps: 2048, rawProbes: 16384, nativeRows: 32768, starts: 128, outputBytes: 24576 })
const epoch = 116444736000000000n
const fail = code => { const error = new Error(`Fixture identity evidence: ${code}`); error.code = code; throw error }
const integer = n => Number.isSafeInteger(n) && n >= 0
const ticks = hex => { if (!/^[0-9a-f]{16}$/i.test(hex || '')) fail('NATIVE_IDENTITY'); return BigInt('0x' + hex) }
const lowerTick = ms => epoch + BigInt(ms) * 10000n
const startKey = s => `${s.pid}/${s.name}/${s.at}/${s.monotonicMs}`
const pickNative = r => ({ status: r.status, sampledAtMs: r.sampledAtMs, creationTimeFileTimeHex: r.creationTimeFileTimeHex ?? null, createdAtMs: r.createdAtMs ?? null, exitAtMs: r.exitAtMs ?? null, belongsToFixture: r.belongsToFixture ?? null, waitResult: r.waitResult, nativeError: r.nativeError, imageQueryError: r.imageQueryError ?? null })

export function qualifyFixtureIdentityHistory(material, { nativeIdentityAvailable = true } = {}) {
  let size
  try { size = Buffer.byteLength(JSON.stringify(material)) } catch { fail('MATERIAL_SCHEMA') }
  if (size > FIXTURE_IDENTITY_LIMITS.materialBytes || material.materialOverflow) fail('MATERIAL_BUDGET')
  const { events, rawSweeps, nativeRows, observerErrors } = material
  if (![events, rawSweeps, nativeRows, observerErrors].every(Array.isArray)) fail('MATERIAL_SCHEMA')
  if (observerErrors.length) fail('OBSERVATION_FAILED')
  if (!rawSweeps.length || rawSweeps.length > FIXTURE_IDENTITY_LIMITS.rawSweeps || nativeRows.length > FIXTURE_IDENTITY_LIMITS.nativeRows) fail('MATERIAL_BUDGET')
  const starts = events.filter(e => e.event === 'start'), byPid = new Map(), rowsByPid = new Map()
  if (!starts.length || starts.length > FIXTURE_IDENTITY_LIMITS.starts) fail('START_MATERIAL_BUDGET')
  for (const [id, s] of starts.entries()) {
    if (!Number.isSafeInteger(s.pid) || s.pid <= 0 || !integer(s.at) || !integer(s.monotonicMs) || !/^(?:burst-\d{1,3}|fail|recovery)$/.test(s.name || '')) fail('START_SCHEMA')
    if (byPid.has(s.pid)) fail('START_PID_REUSED_OR_DUPLICATED')
    byPid.set(s.pid, { id, start: s })
  }
  for (const row of nativeRows) {
    if (!byPid.has(row.pid) || !integer(row.sampledAtMs)) fail('NATIVE_SCHEMA')
    if (['createdAtMs', 'exitAtMs', 'waitResult', 'nativeError', 'imageQueryError'].some(key => row[key] != null && !integer(row[key])) || (row.belongsToFixture != null && typeof row.belongsToFixture !== 'boolean')) fail('NATIVE_SCHEMA')
    if (row.status === 'missing') {
      if (row.nativeError !== 87 || row.creationTimeFileTimeHex) fail('NATIVE_UNKNOWN_ABSENCE')
    } else if (row.status === 'running' || row.status === 'exited') {
      const creation = ticks(row.creationTimeFileTimeHex), createdMs = Number((creation - epoch) / 10000n)
      if (!integer(row.createdAtMs) || Math.abs(createdMs - row.createdAtMs) > 1 || creation > lowerTick(row.sampledAtMs + 1)) fail('NATIVE_TIME_CONFLICT')
      if (typeof row.belongsToFixture !== 'boolean' || row.nativeError !== 0) fail('NATIVE_IDENTITY_UNKNOWN')
      if (row.status === 'running' && (row.waitResult !== 258 || row.imageQueryError !== 0)) fail('NATIVE_RUNNING_UNKNOWN')
      if (row.status === 'exited' && (row.waitResult !== 0 || !integer(row.exitAtMs) || row.exitAtMs <= row.createdAtMs || row.exitAtMs > row.sampledAtMs + 1)) fail('NATIVE_EXIT_UNKNOWN')
    } else fail('NATIVE_OBSERVATION_UNKNOWN')
    if (!rowsByPid.has(row.pid)) rowsByPid.set(row.pid, [])
    rowsByPid.get(row.pid).push(row)
  }
  const baseline = new Map()
  for (const [pid, info] of byPid) {
    const rows = (rowsByPid.get(pid) || []).sort((a, b) => a.sampledAtMs - b.sampledAtMs)
    const candidates = rows.filter(r => r.status === 'running' && r.belongsToFixture && ticks(r.creationTimeFileTimeHex) < lowerTick(info.start.at))
    const births = new Set(candidates.map(r => r.creationTimeFileTimeHex))
    if (births.size > 1) fail('BASELINE_AMBIGUOUS')
    if (!candidates.length) {
      if (nativeIdentityAvailable) fail('BASELINE_MISSING')
      continue
    }
    const first = candidates[0]
    const replacements = rows.filter(r => r.status !== 'missing' && r.creationTimeFileTimeHex !== first.creationTimeFileTimeHex)
    for (const next of replacements) {
      if (ticks(next.creationTimeFileTimeHex) <= lowerTick(info.start.at + 1)) fail('START_IDENTITY_CONFLICT')
      if (rows.some(r => r.status === 'running' && r.creationTimeFileTimeHex === first.creationTimeFileTimeHex && r.sampledAtMs > next.createdAtMs + 1)) fail('NATIVE_IDENTITY_CONFLICT')
    }
    for (const gone of rows) {
      const goneAt = gone.status === 'missing' && gone.sampledAtMs > first.sampledAtMs + 1 ? gone.sampledAtMs
        : gone.status === 'exited' && gone.creationTimeFileTimeHex === first.creationTimeFileTimeHex ? gone.exitAtMs : null
      if (goneAt !== null && rows.some(r => r.status === 'running' && r.creationTimeFileTimeHex === first.creationTimeFileTimeHex && r.sampledAtMs > goneAt + 1)) fail('NATIVE_ABSENCE_CONFLICT')
    }
    baseline.set(pid, { first, rows, replacements })
  }
  let rawUnqualifiedPeak = 0, ownedPeak = 0, rawProbeCount = 0, rawPeakWitness = null, ownedPeakWitness = null, lastSweepAt = -1
  const proofs = [], proofIds = new Map(), exclusions = [], historical = new Set()
  let previousProbeEndNs = -1n
  for (const [sweepIndex, sweep] of rawSweeps.entries()) {
    if (!integer(sweep.startedAtMs) || !integer(sweep.completedAtMs) || sweep.completedAtMs < sweep.startedAtMs || sweep.startedAtMs < lastSweepAt || !Array.isArray(sweep.starts) || !Array.isArray(sweep.probes)) fail('RAW_SCHEMA')
    lastSweepAt = sweep.startedAtMs
    const seen = new Map()
    for (const s of sweep.starts) {
      const known = byPid.get(s.pid)?.start
      if (!known || startKey(s) !== startKey(known) || known.birthId !== s.birthId || seen.has(s.pid) || s.at > sweep.startedAtMs) fail('RAW_START_IDENTITY_CONFLICT')
      seen.set(s.pid, s)
    }
    if ([...historical].some(pid => !seen.has(pid))) fail('RAW_HISTORY_MISSING')
    if (starts.some(s => s.at + 1 < sweep.startedAtMs && !seen.has(s.pid))) fail('RAW_START_MISSING')
    for (const pid of seen.keys()) historical.add(pid)
    if (sweep.probeCount !== sweep.probes.length || seen.size !== sweep.probes.length) fail('RAW_PROBE_MISSING')
    rawProbeCount += sweep.probes.length
    if (rawProbeCount > FIXTURE_IDENTITY_LIMITS.rawProbes) fail('MATERIAL_BUDGET')
    const visited = new Set(), witness = []
    let rawCount = 0, ownedCount = 0
    for (const [probeIndex, probe] of sweep.probes.entries()) {
      if (!seen.has(probe.pid) || visited.has(probe.pid) || typeof probe.alive !== 'boolean' || !integer(probe.startedAtMs) || !integer(probe.completedAtMs) || probe.startedAtMs < sweep.startedAtMs || probe.completedAtMs > sweep.completedAtMs || probe.completedAtMs < probe.startedAtMs || !/^\d{1,24}$/.test(probe.startedAtNs || '') || !/^\d{1,24}$/.test(probe.completedAtNs || '') || BigInt(probe.completedAtNs) < BigInt(probe.startedAtNs)) fail('RAW_PROBE_UNKNOWN')
      if (BigInt(probe.startedAtNs) < previousProbeEndNs) fail('RAW_PROBE_ORDER')
      previousProbeEndNs = BigInt(probe.completedAtNs)
      visited.add(probe.pid)
      if ((!probe.alive && probe.errorCode !== 'ESRCH') || (probe.alive && probe.errorCode != null)) fail('RAW_ERROR_UNKNOWN')
      const point = { pid: probe.pid, alive: probe.alive, errorCode: probe.alive ? null : probe.errorCode, startedAtMs: probe.startedAtMs, completedAtMs: probe.completedAtMs, startedAtNs: probe.startedAtNs, completedAtNs: probe.completedAtNs }
      if (!probe.alive) { witness.push(point); continue }
      rawCount++
      const base = baseline.get(probe.pid), start = byPid.get(probe.pid)
      // 非Windows保持原raw保守门禁，绝不在缺原生观察时推断排除。
      if (!nativeIdentityAvailable) { ownedCount++; witness.push({ ...point, startId: start.id, classification: 'unqualified-no-exclusions' }); continue }
      if (!base) fail('BASELINE_MISSING')
      // 新出生必须严格早于raw毫秒下界；仅“在raw之后看见了新PID”不是证明。
      let row = base.replacements.find(r => ticks(r.creationTimeFileTimeHex) < lowerTick(probe.startedAtMs)), kind
      if (row) kind = 'replacement-born-before-probe'
      if (!row) {
        row = base.rows.find(r => r.status === 'exited' && r.creationTimeFileTimeHex === base.first.creationTimeFileTimeHex && r.exitAtMs + 1 < probe.startedAtMs)
        if (row) kind = 'same-creation-os-exit-before-probe'
      }
      if (!row) {
        row = base.rows.find(r => r.status === 'missing' && r.sampledAtMs > base.first.sampledAtMs + 1 && r.sampledAtMs + 1 < probe.startedAtMs)
        if (row) kind = 'known-native-absence-before-probe'
      }
      if (!row) { ownedCount++; witness.push({ ...point, startId: start.id, expectedCreation: base.first.creationTimeFileTimeHex, classification: 'conservatively-owned' }); continue }
      const key = `${start.id}/${kind}/${row.creationTimeFileTimeHex || ''}/${row.sampledAtMs}`
      let proofId = proofIds.get(key)
      if (proofId === undefined) {
        proofId = proofs.length; proofIds.set(key, proofId)
        proofs.push({ id: proofId, pid: probe.pid, startId: start.id, kind, expectedCreation: base.first.creationTimeFileTimeHex, baseline: pickNative(base.first), witness: pickNative(row) })
      }
      exclusions.push([sweepIndex, probeIndex, proofId, probe.startedAtMs, probe.completedAtMs])
      witness.push({ ...point, startId: start.id, expectedCreation: base.first.creationTimeFileTimeHex, classification: 'proved-not-old-start', proofId })
    }
    if (sweep.count !== undefined && sweep.count !== rawCount) fail('RAW_COUNT_CONFLICT')
    const snapshot = { sweepIndex, startedAtMs: sweep.startedAtMs, completedAtMs: sweep.completedAtMs, rawCount, ownedCount, probes: witness }
    if (rawCount > rawUnqualifiedPeak) { rawUnqualifiedPeak = rawCount; rawPeakWitness = snapshot }
    if (ownedCount > ownedPeak) { ownedPeak = ownedCount; ownedPeakWitness = snapshot }
  }
  if (historical.size !== byPid.size) fail('RAW_START_MISSING')
  return { event: 'hermes-bounds-identity', schema: 1, samplingNotAtomic: true, nativeQualification: nativeIdentityAvailable ? 'creation-identity' : 'unavailable-no-exclusions', ownedPeakSemantics: 'conservative upper bound over original sequential raw probes', rawUnqualifiedPeak, ownedPeak, rawSweepCount: rawSweeps.length, rawProbeCount,
    starts: starts.map((s, id) => ({ id, pid: s.pid, name: s.name, at: s.at, monotonicMs: s.monotonicMs })), proofs, exclusions, rawPeakWitness, ownedPeakWitness }
}

// 使用原侧车已取得的材料，不增加查询/重试；Windows缺材料不得降级为raw通过。
export function evaluateFixtureBoundsGate(report, nativeIdentityAvailable) {
  return qualifyFixtureIdentityHistory({ events: report.events, rawSweeps: report.rawSweeps,
    nativeRows: report.observations.flatMap(o => o.processes), observerErrors: report.observerErrors,
    materialOverflow: report.materialOverflow }, { nativeIdentityAvailable })
}

// 独立stdout JSON行绕开TAP错误消息的inspect截断；超预算必须失败，绝不slice/pop材料。
export function encodeFixtureIdentityEvidence(result) {
  const line = JSON.stringify(result)
  if (Buffer.byteLength(line) > FIXTURE_IDENTITY_LIMITS.outputBytes) fail('OUTPUT_BUDGET')
  return line
}
