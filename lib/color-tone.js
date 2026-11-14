/**
 * lib/color-tone.js —— F29 参考图风格迁移第一版：**只做色调提取**。
 *
 * ★★ 为什么第一版只承诺色调：
 *   构图 / 光影 / 材质这些要靠 IP-Adapter 或视觉模型，本插件不引额外权重、
 *   也不假装能从像素里"看懂"画面。色调是唯一**纯启发式、可解释、成本为零**的维度：
 *   取像素直方图找出主色与冷暖倾向，就能写出一句"整体偏暖的低饱和青绿"。
 *   这句描述对模型是有用的（颜色是最容易被提示词控制的因素），
 *   而"构图是三分法、光源在左上"这种就属于我不能保证的猜测了。
 *
 * ★★ 为什么算法在这里、取样在前端：
 *   Node 侧没有零依赖的图片解码器（引 sharp 会让安装变成编译噩梦）。
 *   所以实际链路是：浏览器 canvas 把参考图缩到 32×32 → 把 RGBA 数组交给本模块算。
 *   本模块只吃像素，不碰文件，因此可以逐条断言、也能被外部集成直接复用。
 */

/** 取样边长。32×32 = 1024 个像素，足够稳定又便宜。 */
export const SAMPLE_EDGE = 32

/**
 * 把一个 RGB 三元组转成 HSL，便于做"冷/暖""明/暗""饱和/灰"的判定。
 * @returns {{h:number,s:number,l:number}} h ∈ [0,360), s/l ∈ [0,1]
 */
export function rgbToHsl(r, g, b) {
  const R = Math.max(0, Math.min(255, Number(r) || 0)) / 255
  const G = Math.max(0, Math.min(255, Number(g) || 0)) / 255
  const B = Math.max(0, Math.min(255, Number(b)) || 0) / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l: Number(l.toFixed(4)) }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h: Number(h.toFixed(1)), s: Number(s.toFixed(4)), l: Number(l.toFixed(4)) }
}

/** 色相 → 中文色名。只到"能写进提示词"的精度，不追求色彩学严格。 */
export function hueName(h) {
  const x = ((Number(h) % 360) + 360) % 360
  if (x < 15 || x >= 345) return '红'
  if (x < 45) return '橙'
  if (x < 65) return '黄'
  if (x < 150) return '绿'
  if (x < 190) return '青'
  if (x < 255) return '蓝'
  if (x < 290) return '紫'
  if (x < 320) return '洋红'
  return '粉'
}

/**
 * 从 RGBA 像素数组提主色调。
 *
 * 做法（刻意简单、可解释）：
 *   1. 丢掉采样点里极亮（>0.95）与极暗（<0.06）的像素 —— 多半是纯白背景或纯黑留白，
 *      它们会把"主色"拉成灰色；
 *   2. 丢掉低饱和（s < 0.08）的像素 —— 同理，灰不构成色调倾向；
 *   3. 把剩下的像素按 30° 色相分桶，取**最大桶**的加权平均色相；
 *   4. 用全部（未被丢弃的）像素算平均饱和度与明度。
 *
 * ★ 全灰图（黑白摄影）会命中"没有可用彩色"分支，此时返回 `neutral:true` 并
 *   用明度给一个"黑白/灰调"的描述 —— 而不是硬报一个色相出来。
 *
 * @param {Uint8Array|number[]|{data:Uint8Array|number[]}} input RGBA，长度必须是 4 的倍数
 * @returns {{ok:boolean, reason:string, hue:number, hue_name:string, saturation:number,
 *   lightness:number, tone:'warm'|'cool'|'neutral', neutral:boolean,
 *   hex:string, phrase:string, sampled:number}}
 */
export function extractTone(input) {
  const raw = Array.isArray(input) ? input : (input && Array.isArray(input.data) ? input.data : null)
  const empty = {
    ok: false, reason: '', hue: 0, hue_name: '', saturation: 0, lightness: 0,
    tone: 'neutral', neutral: true, hex: '#808080', phrase: '', sampled: 0,
  }
  if (!raw) return { ...empty, reason: '需要 RGBA 像素数组（Uint8Array 或 number[]）' }
  if (raw.length < 4) return { ...empty, reason: '像素数据为空' }
  if (raw.length % 4 !== 0) return { ...empty, reason: `长度 ${raw.length} 不是 4 的倍数（RGBA 要求）` }

  const buckets = new Array(12).fill(0)
  let sumS = 0
  let sumL = 0
  let kept = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  const total = raw.length / 4

  for (let i = 0; i < raw.length; i += 4) {
    // alpha 近乎透明的点直接丢：它们的 RGB 通常是无意义的残留值。
    if (raw[i + 3] !== undefined && Number(raw[i + 3]) < 16) continue
    const r = Number(raw[i]) || 0
    const g = Number(raw[i + 1]) || 0
    const b = Number(raw[i + 2]) || 0
    const { h, s, l } = rgbToHsl(r, g, b)
    if (l > 0.95 || l < 0.06) continue
    if (s < 0.08) continue
    buckets[Math.floor(h / 30) % 12] += 1
    sumS += s
    sumL += l
    sumR += r; sumG += g; sumB += b
    kept += 1
  }

  if (kept === 0) {
    // 全灰 / 黑白：给明度判断，不硬造色相。
    let sumLAll = 0
    let n = 0
    for (let i = 0; i < raw.length; i += 4) {
      const l = rgbToHsl(Number(raw[i]) || 0, Number(raw[i + 1]) || 0, Number(raw[i + 2]) || 0).l
      sumLAll += l
      n += 1
    }
    const lAvg = n > 0 ? Number((sumLAll / n).toFixed(3)) : 0.5
    const kind = lAvg >= 0.7 ? '高调' : lAvg <= 0.3 ? '低调' : '中间调'
    return {
      ...empty,
      ok: true,
      lightness: lAvg,
      neutral: true,
      tone: 'neutral',
      phrase: `黑白色调，${kind}（几乎无可提取的色彩）`,
      sampled: total,
    }
  }

  const maxCount = Math.max(...buckets)
  // 有并列时取第一个 —— 结果必须确定性，测试才能断言。
  const topBucket = buckets.indexOf(maxCount)
  const hue = Number(((topBucket * 30) + 15).toFixed(1))
  const avgS = sumS / kept
  const avgL = sumL / kept
  const hex = `#${[sumR, sumG, sumB].map((v) => {
    const n = Math.round(v / kept)
    return n.toString(16).padStart(2, '0')
  }).join('')}`

  // 冷暖：红/橙/黄/绿（330°–360° 与 0°–150°）偏暖，青蓝紫（190°–330°）偏冷，150°–190° 的青绿算中性。
  // ★ 红必须算暖 —— 写成 `>= 30 && < 150` 会把纯红（色相 15）判成"冷暖中性"，那是明显的错。
  const tone = (hue >= 330 || hue < 150) ? 'warm' : (hue >= 190 && hue < 330) ? 'cool' : 'neutral'
  const toneText = tone === 'warm' ? '偏暖' : tone === 'cool' ? '偏冷' : '冷暖中性'
  const satText = avgS >= 0.55 ? '高饱和' : avgS <= 0.22 ? '低饱和' : '中等饱和'
  const lightText = avgL >= 0.68 ? '明亮' : avgL <= 0.3 ? '暗调' : '中间明度'
  // ★ 色名按**桶的左边界**取名，不用桶中心（15°）：
  //   纯红落在第 0 桶，中心 15° 会被叫成"橙调"，而用户看到的分明是一张红图。
  //   边界 0° 取名才是"红"。桶内仍用中心色相做数值精度，两者互不影响。
  const colorName = hueName(topBucket * 30)

  return {
    ok: true,
    reason: '',
    hue,
    hue_name: colorName,
    saturation: Number(avgS.toFixed(3)),
    lightness: Number(avgL.toFixed(3)),
    tone,
    neutral: false,
    hex,
    // phrase 就是拿来拼进提示词的那一句，措辞刻意保留模型的发挥空间。
    phrase: `${toneText}的${satText}${colorName}调，${lightText}`,
    sampled: total,
  }
}
