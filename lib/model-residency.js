/**
 * lib/model-residency.js —— B5 会话级模型驻留。
 *
 * ★★ 要解决的真问题：
 *   连续做"生图 → 生图 → 生图"时，如果每次都把主模型卸下再载入，
 *   每次白等一次加载。反过来，做完视频再做生图时又必须卸 ——
 *   双载会直接 OOM。所以需要记住「上一轮载的是谁」。
 *
 * ★ 本模块只做**账本**：记最近用过哪些模型、下一步要不要换。
 *   真正的卸载动作在 `model-chain.js` / `hybrid-runner.js` 里 ——
 *   这里不碰网络、不发请求，因此可以纯离线逐条断言。
 *
 * ★★ 一条诚实边界：进程重启后账本就没了。
 *   这不是缺陷，而是对的 —— 重启意味着 ComfyUI 那边也重来了，
 *   沿用旧的"已驻留"判断只会得出错误结论。
 */

/** 默认只记最近一个：核显/小显存机器上并存两个模型就是 OOM。 */
export const DEFAULT_RESIDENCY_LIMIT = 1

/**
 * 记账用的键名。用「任务类型」而不是具体权重文件名：
 * 同一类任务用的模型由 cfg 决定，改配置后文件名会变，而"要不要换模型"这件事不变。
 */
export const RESIDENCY_KEYS = Object.freeze({
  image: 'image-model',
  video: 'video-model',
  tts: 'tts-model',
  upscale: 'upscale-model',
})

/**
 * 会话级单例。
 *
 * ★★ 覆盖范围（2026-11-14 全量接入）：四类任务的构建入口都在记账 ——
 *   生图（config.js buildWorkflow）、视频（video-workflow.js）、
 *   TTS（tts-workflow.js 两条链）、超分（index.js runUpscaleFile）。
 *   批量工具（batch-tool.js）会读这本账来决定「首张要不要提示重载」。
 *   ⚠ 账本只在插件进程内存里，插件重启即清零 —— 这是会话级语义，不是持久状态。
 */
export const sessionResidency = createResidency()

/**
 * 建一个驻留账本。
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多同时驻留几个模型（默认 1）
 * @param {number} [opts.ttlMs] 多久没用到就认为已被别的东西挤掉（默认 10 分钟）
 * @param {() => number} [opts.now]
 */
export function createResidency({ limit = DEFAULT_RESIDENCY_LIMIT, ttlMs = 10 * 60 * 1000, now } = {}) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : DEFAULT_RESIDENCY_LIMIT
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** @type {Array<{key:string, at:number}>} 最新在前 */
  let held = []
  let hits = 0
  let misses = 0

  const alive = () => {
    const t = clock()
    held = held.filter((h) => t - h.at < ttlMs)
    return held
  }

  return {
    /** 当前驻留的模型 key（最新在前）。 */
    current() { return alive().map((h) => h.key) },

    /**
     * 下一步要用 `key` 时，需不需要换。
     * @returns {{hit:boolean, keep:boolean, unload:string[], load:boolean, reason:string}}
     */
    plan(key) {
      const k = String(key ?? '').trim()
      const list = alive()
      if (k === '') return { hit: false, keep: false, unload: [], load: false, reason: '没给模型名，跳过驻留判断' }
      // 只要还在显存里就不用重载 —— 不管它排第几（顺序只影响"接下来先挤谁"）。
      if (list.some((h) => h.key === k)) {
        hits += 1
        return { hit: true, keep: true, unload: [], load: false, reason: `${k} 已在显存里，本轮不用重新加载` }
      }
      misses += 1
      // 要腾地方：cap 个位子留 cap-1 个给现役（新来的占最后一个）。
      const room = Math.max(0, cap - 1)
      const unload = list.slice(room).map((h) => h.key)
      return {
        hit: false,
        keep: false,
        unload,
        load: true,
        reason: unload.length === 0
          ? `显存里还有空位，直接载入 ${k}`
          : `要载入 ${k}，先卸下 ${unload.join('、')}（小显存机器不允许双载）`,
      }
    },

    /** 记一次成功载入。重复 key 会提到最前，不会重复计数。 */
    touch(key) {
      const k = String(key ?? '').trim()
      if (k === '') return []
      const list = alive().filter((h) => h.key !== k)
      list.unshift({ key: k, at: clock() })
      // 超出容量的直接丢出账本（现实中它们已被挤掉）。
      held = list.slice(0, cap)
      return held.map((h) => h.key)
    },

    /** 外部明确卸载（例如视频链把主模型卸了）。 */
    evict(key) {
      const k = String(key ?? '').trim()
      held = alive().filter((h) => h.key !== k)
      return held.map((h) => h.key)
    },

    reset() { held = []; hits = 0; misses = 0 },

    stats() {
      const list = alive()
      return {
        limit: cap,
        held: list.map((h) => h.key),
        hits,
        misses,
        hit_rate: hits + misses === 0 ? null : Number((hits / (hits + misses)).toFixed(3)),
      }
    },
  }
}

/**
 * B5：plan + touch 一步完成，返回可直接挂到工具回包上的驻留摘要。
 * ★ 专为 index.js 这类余量只剩一两百字节的入口准备：那边一行调用就够了。
 * ⚠ 记账失败返回保守默认值，绝不打断正常流程。
 */
export function touchResidency(key) {
  try {
    const plan = sessionResidency.plan(key)
    sessionResidency.touch(key)
    return {
      key,
      switch_from: Array.isArray(plan?.unload) ? plan.unload : [],
      reload: plan?.load === true && Array.isArray(plan?.unload) && plan.unload.length > 0,
    }
  } catch {
    return { key, switch_from: [], reload: false }
  }
}
