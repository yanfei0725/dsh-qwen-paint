/**
 * lib/anim-opt.js —— 动画三件套「四项纯 JS 优化层」。
 *
 * 来源：hyperframes-底层加速整合总清单 §13 可映射的 4 项（纯 JS、零外部依赖）：
 *   ① 静态帧去重：相邻同内容帧折叠为一帧 + concat 延长时长（不重复落盘）
 *   ② 分镜级缓存：以 {type,hint,尺寸} 为 key 的 sidecar 缓存，改一镜不重渲其它镜
 *   ③ 草稿/定稿档：fps / 分辨率显式分档（draft 低采样、final 原默认）
 *   ④ 时序校验前置：合成前比对字幕/配音时长与分镜时间轴，不齐如实告警
 *
 * 诚实边界：
 *   · 这不是 hyperframes 那套无头 Chrome 内核重构（本插件无 Chrome/GSAP/Lottie/WebGL 对象）。
 *   · 缓存只省重复渲染，改了 hint/尺寸/档位必然新 key，绝不拿旧结果糊弄人。
 *   · 时序校验只做「如实告警/可选拒绝」，不编造对齐后的时间戳（脚本字幕本就 aligned:false）。
 *   · 所有函数纯计算或受注入 fs/path 控制；缓存落盘失败只警告不致命。
 */
import { createHash } from 'node:crypto'

/* ============================ ③ 草稿/定稿档 ============================ */
/** final 保持动画三件套的历史默认（960×540 / 24fps），draft 降采样。 */
export const ANIM_QUALITY_PRESETS = Object.freeze({
  draft: Object.freeze({ fps: 12, width: 480, height: 270 }),
  final: Object.freeze({ fps: 24, width: 960, height: 540 }),
})
export const ANIM_QUALITY_NAMES = Object.freeze(['draft', 'final'])

/** 档位 → 参数；未知/空档返回 null（调用方保持原参数，不动默认）。 */
export function resolveAnimQuality(quality) {
  const name = String(quality ?? '').trim().toLowerCase()
  return ANIM_QUALITY_NAMES.includes(name) ? ANIM_QUALITY_PRESETS[name] : null
}

/* ============================ ①② 帧指纹 / 缓存 key ============================ */
/** SVG 内容指纹（sha256 前 16 位）。内容相同 ⇒ 同一帧，可去重。 */
export function frameFingerprint(svg) {
  return createHash('sha256').update(String(svg ?? '')).digest('hex').slice(0, 16)
}

/** 分镜缓存 key：type + hint + 尺寸任一变化都换 key（改一镜只重渲那一镜）。 */
export function storyboardKey({ type, hint, width, height } = {}) {
  const payload = JSON.stringify([
    String(type ?? ''), String(hint ?? ''), Number(width) || 0, Number(height) || 0,
  ])
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** ② 分镜级缓存（sidecar JSON 持久化，先内存后落盘，失败不致命）。 */
export const FRAME_CACHE_FILE = '.qwen-paint-frame-cache.json'
export const FRAME_CACHE_MAX = 64

export function createFrameCache({ outputDir, fs, path: pathMod }) {
  const dir = String(outputDir ?? '').trim()
  if (!dir) return null
  const file = pathMod.join(dir, FRAME_CACHE_FILE)
  let map = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed
  } catch { /* 没有或坏了都从空账本开始 */ }

  const flush = () => {
    try {
      fs.mkdirSync(pathMod.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(map))
      return true
    } catch { return false } // 缓存丢了顶多重渲一次
  }

  return {
    file,
    /** 命中且结构合法才返回 {svg, path, at}；否则 null（必须重渲）。 */
    lookup(key) {
      if (typeof key !== 'string' || key === '') return null
      const e = map[key]
      if (!e || typeof e.svg !== 'string' || e.svg === '') return null
      return { svg: e.svg, path: String(e.rel ?? ''), at: Number(e.at) || 0 }
    },
    /** 记一条；FIFO 淘汰到 FRAME_CACHE_MAX 条。 */
    remember(key, { svg, rel } = {}) {
      if (typeof key !== 'string' || key === '' || typeof svg !== 'string' || svg === '') return false
      map[key] = { svg, rel: String(rel ?? ''), at: Date.now() }
      const keys = Object.keys(map)
      for (const k of keys.slice(0, Math.max(0, keys.length - FRAME_CACHE_MAX))) delete map[k]
      return flush()
    },
    size() { return Object.keys(map).length },
  }
}

/* ============================ ① 静态帧去重 ============================ */
/**
 * 把「相邻同路径帧」折叠成 [{path, repeat}]（concat 有序，非相邻不能合并成一帧）。
 * 纯函数、不改入参。repeat ≥ 1。
 */
export function collapseRepeatedFrames(frames) {
  const out = []
  for (const raw of (Array.isArray(frames) ? frames : [])) {
    const f = String(raw ?? '').trim()
    if (f === '') continue
    const last = out[out.length - 1]
    if (last && last.path === f) last.repeat += 1
    else out.push({ path: f, repeat: 1 })
  }
  return out
}

/** 帧重复次数数组（与折叠后帧数等长），供 buildComposeCommand 延长每帧时长。 */
export function repeatsOf(collapsed) {
  return (Array.isArray(collapsed) ? collapsed : []).map((x) => Math.max(1, Number(x?.repeat) || 1))
}

/* ============================ ④ 时序校验前置 ============================ */
/**
 * 合成前比对字幕/配音时长与分镜时间轴。缺数据时跳过该项（不编造结论）。
 * @returns {ok, aligned, issues:[], checked, summary}
 */
export function checkTimelineAlignment({ storyboard = [], srtCues = [], audioSeconds = null, frames = 0, fps = 24 } = {}) {
  const issues = []
  const f = Number(frames) > 0 ? Number(frames) : 0
  const rate = Number(fps) > 0 ? Number(fps) : 24
  const videoSec = f > 0 ? f / rate : 0
  const shots = Array.isArray(storyboard) ? storyboard : []
  const cues = Array.isArray(srtCues) ? srtCues : []
  let checked = 0

  // 字幕条数 vs 分镜数
  if (shots.length > 0 && cues.length > 0) {
    checked += 1
    if (shots.length !== cues.length) issues.push(`字幕 ${cues.length} 条 ≠ 分镜 ${shots.length} 镜`)
  }
  // 字幕末端 vs 视频时长
  const lastCue = cues.length > 0 ? Number(cues[cues.length - 1]?.to) : NaN
  if (videoSec > 0 && Number.isFinite(lastCue)) {
    checked += 1
    if (lastCue > videoSec + 0.5) issues.push(`字幕末端 ${lastCue}s 超出视频 ${videoSec.toFixed(2)}s`)
  }
  // 分镜末端 vs 视频时长
  const lastShot = shots.length > 0 ? Number(shots[shots.length - 1]?.to) : NaN
  if (videoSec > 0 && Number.isFinite(lastShot)) {
    checked += 1
    if (Math.abs(lastShot - videoSec) > 0.5) issues.push(`分镜末端 ${lastShot}s 与视频 ${videoSec.toFixed(2)}s 不一致`)
  }
  // 配音时长 vs 视频时长（偏差 > max(1s, 15%) 视为不齐）
  const audio = Number(audioSeconds)
  if (videoSec > 0 && Number.isFinite(audio) && audio > 0) {
    checked += 1
    if (Math.abs(audio - videoSec) > Math.max(1, videoSec * 0.15)) {
      issues.push(`配音 ${audio.toFixed(2)}s 与视频 ${videoSec.toFixed(2)}s 偏差过大`)
    }
  }

  const aligned = issues.length === 0
  return {
    ok: aligned,
    aligned,
    issues,
    checked,
    summary: checked === 0
      ? '未给字幕/配音/分镜时间轴，跳过时序校验'
      : (aligned ? `时序校验通过（${checked} 项）` : `时序不齐：${issues.join('；')}`),
  }
}

/** 一次性暴露全部纯函数，便于回归与后续 UI 消费。 */
export const ANIM_OPT_EXPORTS = Object.freeze({
  ANIM_QUALITY_PRESETS, ANIM_QUALITY_NAMES, resolveAnimQuality,
  frameFingerprint, storyboardKey, FRAME_CACHE_FILE, FRAME_CACHE_MAX, createFrameCache,
  collapseRepeatedFrames, repeatsOf, checkTimelineAlignment,
})
