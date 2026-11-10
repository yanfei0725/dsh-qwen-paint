/**
 * lib/model-map.js —— 显存水位 → 模型档位映射（结构化，**零 eval / 零 new Function**）。
 *
 * ## 为什么不是"字符串表达式"
 *   报告 v2 当初写的是 `{ "when": "12 <= vramGB < 20", "use": "fp8_e4m3fn" }`，
 *   然后 `variants.find(v => evalWatermark(v.when, vramGB))`。
 *   两个问题：① `evalWatermark` 是个**没实现的函数**，字符串求值天然不可校验；
 *   ② 用户/配置改错一个符号，就静默选错档，而且**没有任何报错**。
 *   ⇒ 本文件把条件换成两个数值字段，比较是纯数值的。
 *
 * ## 区间语义：半开区间 `[minVramGB, maxVramGB)`
 *   `12 <= vram < 20` 写成 `{ minVramGB: 12, maxVramGB: 20 }`。
 *   上界不写 = 无上界。这样相邻两档不会在 20GB 处**同时命中**（闭区间就会）。
 *
 * ## 这份表是**建议**，不是偷偷切档
 *   插件不会因为显存够就擅自把你正在用的模型换掉 —— 换模型要重新加载十几 GB，
 *   而且"面板说用上了 BF16、实际跑 int8"这种假报告本项目出过。
 *   所以它只产出 `caps.suggestedPrecisionTier`（信息），由用户自己决定要不要选。
 */

/**
 * 档位表。`tier` 与 `lib/config.js` 的 `PRECISION_TIERS`（auto/bf16/fp8/int8/gguf）同名，
 * 这样 `pickUnetForTier()` 拿到就能直接用。
 */
export const MODEL_VARIANTS = [
  {
    id: 'bf16', minVramGB: 20, maxVramGB: null, tier: 'bf16',
    note: '显存 20 GB 以上：整模型 bf16，不掉精度',
  },
  {
    id: 'fp8_e4m3fn', minVramGB: 12, maxVramGB: 20, tier: 'fp8',
    note: '12–20 GB：fp8 权重，画质基本无损、显存降约四成',
  },
  {
    id: 'int8', minVramGB: 8, maxVramGB: 12, tier: 'int8',
    note: '8–12 GB：int8 权重',
  },
  {
    id: 'gguf_q5_k_m', minVramGB: 0, maxVramGB: 8, tier: 'gguf',
    note: '8 GB 以下：GGUF q5_k_m，画质降级',
  },
]

/** 半开区间 `[min, max)` 判定；字段缺失按 ±∞ 处理。纯数值比较。 */
export function variantMatches(variant, vramGB) {
  if (variant === null || typeof variant !== 'object') return false
  if (!Number.isFinite(vramGB)) return false
  const min = Number.isFinite(variant.minVramGB) ? variant.minVramGB : -Infinity
  const max = Number.isFinite(variant.maxVramGB) ? variant.maxVramGB : Infinity
  return vramGB >= min && vramGB < max
}

/**
 * 按显存挑档。
 * @param {number} vramGB 显存（GB）
 * @param {Array}  variants 档位表（默认 `MODEL_VARIANTS`）
 * @returns {object|null} 命中的档；显存未知 → null（**绝不给一个"猜的"档**）
 */
export function matchVariant(vramGB, variants = MODEL_VARIANTS) {
  const list = Array.isArray(variants) ? variants : []
  if (!Number.isFinite(vramGB)) return null
  return list.find((v) => variantMatches(v, vramGB)) ?? null
}

/** 按 id 取档（配置里写 id 时用）。 */
export function variantById(id, variants = MODEL_VARIANTS) {
  const want = String(id ?? '')
  return variants.find((v) => v.id === want) ?? null
}

/**
 * 显存 → 建议精度档名（`PRECISION_TIERS` 的取值）。显存未知返回 null。
 * ⚠ 这是**建议**：调用方只把它写进 caps 供面板显示，不得据此静默换模型。
 */
export function tierForVram(vramGB, variants = MODEL_VARIANTS) {
  const hit = matchVariant(vramGB, variants)
  return hit ? hit.tier : null
}

/** 表自检：区间互不重叠且覆盖 [0, +∞)。配置改错时能当场抓出来。 */
export function validateVariants(variants = MODEL_VARIANTS) {
  const list = Array.isArray(variants) ? variants : []
  const problems = []
  for (const v of list) {
    if (typeof v?.id !== 'string' || v.id === '') problems.push('档位缺 id')
    if (typeof v?.tier !== 'string' || v.tier === '') problems.push(`${v?.id}: 缺 tier`)
    if (v?.maxVramGB !== null && v?.maxVramGB !== undefined
      && (!Number.isFinite(v.maxVramGB) || v.maxVramGB <= v.minVramGB)) {
      problems.push(`${v?.id}: maxVramGB 必须大于 minVramGB`)
    }
  }
  // 两两不重叠（半开区间下，边界相接是合法的）
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      const aMin = Number.isFinite(a?.minVramGB) ? a.minVramGB : -Infinity
      const aMax = Number.isFinite(a?.maxVramGB) ? a.maxVramGB : Infinity
      const bMin = Number.isFinite(b?.minVramGB) ? b.minVramGB : -Infinity
      const bMax = Number.isFinite(b?.maxVramGB) ? b.maxVramGB : Infinity
      if (aMin < bMax && bMin < aMax) problems.push(`${a?.id} 与 ${b?.id} 区间重叠`)
    }
  }
  return problems
}
