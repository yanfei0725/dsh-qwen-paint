// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-config-consistency
export const WRAPPER_POLICIES = Object.freeze(['auto', 'te', 'bc'])
export const VRAM_MODE_SET = Object.freeze(['auto', 'resident', 'standard', 'save', 'ram', 'cpu'])
export const VRAM_LADDER_SUBSET = Object.freeze(['auto', 'resident', 'save', 'cpu'])
export const RAM_SEMANTICS = Object.freeze({
  cache: 'gpu-resident-cache',
  vram: 'cpu-resident-weights',
})
export const TTS_PREFIX_CANONICAL = 'qwen-paint/tts'
export const TTS_PREFIX_LEGACY = Object.freeze(['comfy-pipeline/tts', 'comfy-paint/tts'])
export const PROGRESS_MODES = Object.freeze(['quiet', 'brief', 'detailed'])

const WRAPPER_TOKEN_THRESHOLD = 16384

/**
 * 与 config.js::pickWrapperSet **同口径**的裁决（不引入第二套规则）。
 * @returns {{policy:string, wrapper:string, tokens:number, reason:string, enabledFlags:string[]}}
 */
export function resolveWrapperChoice(cfg = {}, width = 1024, height = 1024, caps = null) {
  const tokens = Math.max(1, Math.round(Number(width || 0) / 8))
    * Math.max(1, Math.round(Number(height || 0) / 8))
  const policy = WRAPPER_POLICIES.includes(cfg.wrapperPolicy) ? cfg.wrapperPolicy : 'auto'
  const enabledFlags = []
  if (cfg.teSpeedEnabled !== false) enabledFlags.push('teSpeed')
  if (cfg.speedupEnabled !== false) enabledFlags.push('speedup')
  if (cfg.blockCacheEnabled !== false) enabledFlags.push('blockCache')
  const has = (key) => caps == null || caps?.nodes?.[key] === true
  const bcOk = has('blockCache') && cfg.blockCacheEnabled !== false
  const threshold = Number.isFinite(cfg.wrapperAutoTokensThreshold) && cfg.wrapperAutoTokensThreshold > 0
    ? cfg.wrapperAutoTokensThreshold : WRAPPER_TOKEN_THRESHOLD

  let wantBc
  let reason
  if (policy === 'bc') { wantBc = true; reason = '固定走 BlockCache（wrapperPolicy=bc）' }
  else if (policy === 'te') { wantBc = false; reason = '固定走 TE-Speed（wrapperPolicy=te）' }
  else {
    wantBc = tokens > threshold
    reason = '按尺寸自动裁决（tokens=' + tokens + '，阈值 ' + threshold + '）'
  }
  if (wantBc && !bcOk) {
    return { policy, wrapper: 'te', tokens, enabledFlags,
      reason: reason + '；BlockCache 不可用 → 退回 TE-Speed' }
  }
  return { policy, wrapper: wantBc ? 'bc' : 'te', tokens, enabledFlags, reason }
}

/** 人类可读的冲突 / 易误解清单。severity: info | warn。 */
export function detectConfigConflicts(cfg = {}) {
  const list = []
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const flags = ['teSpeedEnabled', 'speedupEnabled', 'blockCacheEnabled']
    .filter((k) => c[k] !== false)
  if (flags.length === 3) {
    list.push({ id: 'wrapper_flags', severity: 'info',
      detail: '三个加速开关默认全开，容易被误读为「三个同时生效」',
      resolution: '实际由 resolveWrapperChoice 按尺寸/策略只选一组；三者是候选允许位' })
  }
  if (c.wrapperPolicy && !WRAPPER_POLICIES.includes(c.wrapperPolicy)) {
    list.push({ id: 'wrapper_policy', severity: 'warn',
      detail: 'wrapperPolicy 不是 auto/te/bc', resolution: '按 auto 处理' })
  }
  if (c.vramMode && !VRAM_MODE_SET.includes(c.vramMode)) {
    list.push({ id: 'vram_mode', severity: 'warn',
      detail: 'vramMode 不在六档枚举内', resolution: '按 auto 处理' })
  }
  if (c.progressMode && !PROGRESS_MODES.includes(c.progressMode)) {
    list.push({ id: 'progress_mode', severity: 'warn',
      detail: 'progressMode 不在 quiet/brief/detailed 内', resolution: '按 brief 处理' })
  }
  if (c.ram !== undefined || c.cacheDevice === 'ram') {
    list.push({ id: 'ram_semantics', severity: 'info',
      detail: 'ram 在缓存档位与显存档位里语义相反',
      resolution: '缓存 ram=' + RAM_SEMANTICS.cache + '，显存 ram=' + RAM_SEMANTICS.vram })
  }
  if (Number.isFinite(c.steps) && c.steps > 8) {
    list.push({ id: 'steps_context', severity: 'info',
      detail: 'steps 大于 8 时可能是原生回退链（默认 25）而非蒸馏链（默认 8）',
      resolution: '两者语境不同，不是同一默认值冲突' })
  }
  return list
}

/** 不改原对象，返回归一后的副本 + 冲突清单 + 实际生效的加速裁决。 */
export function normalizeConfig(cfg = {}, width, height, caps) {
  const c = { ...(cfg || {}) }
  const conflicts = detectConfigConflicts(c)
  if (c.wrapperPolicy && !WRAPPER_POLICIES.includes(c.wrapperPolicy)) c.wrapperPolicy = 'auto'
  if (c.vramMode && !VRAM_MODE_SET.includes(c.vramMode)) c.vramMode = 'auto'
  if (c.progressMode && !PROGRESS_MODES.includes(c.progressMode)) c.progressMode = 'brief'
  return { cfg: c, conflicts, wrapper: resolveWrapperChoice(c, width, height, caps) }
}

/** 给 doctor 用：把冲突清单折成一行，不展开细节。 */
export function summarizeConflicts(cfg = {}) {
  const list = detectConfigConflicts(cfg)
  const warn = list.filter((x) => x.severity === 'warn').length
  return list.length === 0 ? '配置项无冲突'
    : list.length + ' 项说明（其中 ' + warn + ' 项需留意）'
}
