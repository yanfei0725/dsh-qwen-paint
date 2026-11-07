/**
 * 官方 Qwen-Image 2.1 Turbo 的单一判定入口。
 *
 * 面板、计划、日志都必须消费同一结果；以前条件散在 resolvePlan / tierLabelOf /
 * 探测提示里，任一处漏判就会出现“面板说没用、实际用了”的假报告。
 */

/**
 * @param {object} cfg
 * @param {object|null|undefined} caps
 * @returns {{available:boolean, active:boolean, model:string, reason:string}}
 */
export function resolveOfficialTurbo(cfg, caps) {
  const model = typeof caps?.models?.officialTurbo === 'string' ? caps.models.officialTurbo : ''
  const available = model !== '' && caps?.nodes?.officialSampling === true
  if (!available) {
    return {
      available: false,
      active: false,
      model,
      reason: model === '' ? '未发现官方 Turbo 主模型' : '缺少 ManualSigmas / SamplerCustomAdvanced',
    }
  }
  if (cfg?.officialTurboEnabled === false) {
    return { available, active: false, model, reason: 'officialTurboEnabled=false' }
  }
  if (String(cfg?.mainModelOverride ?? '').trim() !== '') {
    return { available, active: false, model, reason: '用户显式覆写主模型' }
  }
  if (cfg?.fast4Enabled === true) {
    return { available, active: false, model, reason: '4 步档优先' }
  }
  if (String(cfg?.textControl ?? 'auto').toLowerCase() === 'native') {
    return { available, active: false, model, reason: 'native 文本控制档优先' }
  }
  return { available, active: true, model, reason: '官方 Turbo 已启用' }
}
