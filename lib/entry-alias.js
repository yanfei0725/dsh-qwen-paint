/**
 * lib/entry-alias.js —— D24 入口别名（`style_card` 这类"口语入口"）。
 *
 * ★★ 为什么需要：
 *   模型/用户嘴里的入口名和真实工具名对不上。最典型的是「风格卡」：
 *   用户说"用这张风格卡出图"，它其实对应 `compose_prompt` + 模板，
 *   过去只能靠描述文字去猜，猜错了就变成"这个工具不存在"。
 *
 *   本模块把这类口语入口收敛成一张**显式别名表**：
 *   每个别名指向一个真实工具名 + 参数预置，并说明它到底做了什么。
 *
 * ★★ 三条硬约束（都有单测）：
 *   ① 别名**只能指向已注册的工具**，指错就是红 —— 不新增"影子工具"。
 *   ② 别名不改变工具语义，只做参数预置（prefill），用户仍能覆盖。
 *   ③ 别名表里不许出现"猜测性"描述。查不到就明说没有这个入口。
 */

/**
 * 别名表。
 * `tool` 必须是 `lib/index.js` 真实注册的工具名（selftest 里有逐字清单）。
 * `prefill` 只填参数默认值，调用方显式给的值优先。
 */
export const ENTRY_ALIASES = [
  {
    alias: 'style_card',
    tool: 'compose_prompt',
    prefill: {},
    note: '「风格卡」= 提示词模板。compose_prompt 用 template 指定卡（product/character/cover/scene/still-life/interior），'
      + '填槽位后返回可直接出图的完整提示词。',
  },
  {
    alias: '风格卡',
    tool: 'compose_prompt',
    prefill: {},
    note: '同 style_card。',
  },
  {
    alias: 'batch',
    tool: 'batch_draw',
    prefill: {},
    note: '「批量」= batch_draw，扫种子/尺寸，一次跑多张。',
  },
  {
    alias: '批量出图',
    tool: 'batch_draw',
    prefill: {},
    note: '同 batch。',
  },
  {
    alias: 'history',
    tool: 'list_generated_images',
    prefill: {},
    note: '「历史」= list_generated_images，可搜索、可翻页；返回带 #序号 便于续用。',
  },
  {
    alias: '历史',
    tool: 'list_generated_images',
    prefill: {},
    note: '同 history。',
  },
  {
    alias: 'tts',
    tool: 'generate_speech',
    prefill: {},
    note: '「配音/朗读」= generate_speech；有参考音频时走语音克隆路径。',
  },
  {
    alias: '配音',
    tool: 'generate_speech',
    prefill: {},
    note: '同 tts。',
  },
  {
    alias: 'clone_voice',
    tool: 'generate_speech',
    prefill: {},
    note: '语音克隆是 generate_speech 的一个分支（给 ref_audio），不是独立工具。',
  },
  {
    alias: 'video',
    tool: 'generate_video',
    prefill: {},
    note: '「视频」= generate_video；带 audioTrack 时同一张图里接音轨。',
  },
  {
    alias: '视频',
    tool: 'generate_video',
    prefill: {},
    note: '同 video。',
  },
  {
    alias: 'upscale',
    tool: 'upscale_image',
    prefill: {},
    note: '「放大」= upscale_image（两档，见工具描述）。',
  },
  {
    alias: 'models',
    tool: 'list_available_models',
    prefill: {},
    note: '「有哪些模型」= list_available_models（只读，不下载）。',
  },
]

const norm = (s) => String(s ?? '').trim().toLowerCase()

/**
 * 解析一个入口名。
 *
 * @param {string} name
 * @param {string[]} [toolNames] 已注册工具名；给了就校验别名指向是否真实存在
 * @returns {{ok:boolean, alias:string, tool:string, prefill:object, note:string, reason:string}}
 */
export function resolveAlias(name, toolNames) {
  const key = norm(name)
  const miss = (reason) => ({ ok: false, alias: String(name ?? ''), tool: '', prefill: {}, note: '', reason })
  if (key === '') return miss('入口名不能为空')
  const hit = ENTRY_ALIASES.find((a) => norm(a.alias) === key)
  if (!hit) return miss(`没有这个入口别名：${String(name).trim()}`)
  if (Array.isArray(toolNames) && !toolNames.includes(hit.tool)) {
    // ★ 别名指向一个不存在的工具时**必须报错**，不能悄悄放行 ——
    //   否则用户点进来会收到"工具未注册"，而错误现场已经离这里很远了。
    return miss(`别名 ${hit.alias} 指向的工具 ${hit.tool} 未注册（这是插件内部不一致，请报 issue）`)
  }
  return { ok: true, alias: hit.alias, tool: hit.tool, prefill: { ...hit.prefill }, note: hit.note, reason: '' }
}

/** 某个工具全部的口语别名，用于工具描述里回显"你也可以这么说"。 */
export function aliasesOf(tool) {
  const t = String(tool ?? '')
  return ENTRY_ALIASES.filter((a) => a.tool === t).map((a) => a.alias)
}

/** 全表体检：重名、空字段、指向不存在的工具。返回错误数组（空 = 通过）。 */
export function checkAliases(toolNames) {
  const errors = []
  const seen = new Set()
  for (const a of ENTRY_ALIASES) {
    if (String(a.alias ?? '').trim() === '') errors.push('存在空别名')
    if (String(a.tool ?? '').trim() === '') errors.push(`别名 ${a.alias} 没指向工具`)
    const k = norm(a.alias)
    if (seen.has(k)) errors.push(`别名重复：${a.alias}`)
    seen.add(k)
    if (Array.isArray(toolNames) && !toolNames.includes(a.tool)) {
      errors.push(`别名 ${a.alias} 指向未注册的工具 ${a.tool}`)
    }
  }
  return errors
}
