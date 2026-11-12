/**
 * lib/pipeline-controls.js —— 通用 Comfy 控制层的**控制项持久化 + 生效映射**（host 侧 ESM）。
 *
 * ## 它解决什么
 *   `lib/mode-schema.js` 是契约（有哪些模式、哪些滑块、取值范围）；本文件是**落地层**：
 *   把用户在前端面板拨的滑块值安全地落盘、并在出图时变成**真的会生效**的参数。
 *
 * ## 三层优先级（继承既有铁律，别改）
 *   **显式工具入参 > 面板控制项 > 记忆偏好 > cfg.preset > 内置默认**
 *   —— 面板是"用户自己拨的"，可以盖住记忆；但模型当场显式传的 args 永远赢。
 *   实现走 `resolveDrawParams(args, cfg, pref)` 既有的 pref 通道（见 index.js 的
 *   `controlsToPref()` 调用点），**不改那边的判据**，只多喂一层兜底。
 *
 * ## 为什么"速度%"只动尺寸、不动步数
 *   Qwen-Image 2.1 的官方 Turbo 链是**步蒸馏**模型：8 步 / 9 步是训练时固定的工作点，
 *   换个步数不是"快一点"，是**掉画质**（sigmas 与蒸馏对齐被破坏）。
 *   用户的硬约束是"不掉质量" ⇒ 速度% 只能压缩**画幅像素预算**（1024→896→768→640）
 *   与参考图张数，绝不改进蒸馏步数。
 *   4 步极速档（fast4）是**另一条带自己 LoRA/shift 的链**，由 `fast4Enabled` 决定，
 *   不在本文件的滑块语义里 —— 别把两者混成一个"速度"。
 *
 * ## 落盘位置
 *   `<outputDir>/.comfy-pipeline-controls.json`（与 `.qwen-paint-memory.jsonl` 同目录）。
 *   写失败**一律吞掉**：控制项存不下顶多下次回到默认值，绝不该把出图拖成失败。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { CONTROLS, MODES, SPEED_MAP, SPEED_TIERS, quantizeSpeedPercent } from './mode-schema.js'

/** 控制项文件名（藏在 outputDir 里，与既有记忆/偏好文件同风格：点号前缀）。 */
export const CONTROL_FILE = '.comfy-pipeline-controls.json'

/**
 * 画幅比例的**滑块刻度表**：与 `lib/config.js` 的 `ASPECTS` 键**逐一对应**。
 * ⚠ 两边必须同源。config.js 那份是出图用的真表，这份是给滑块用的顺序；
 *   有新增比例就两边一起加，`test-pipeline-controls.mjs` 会比对两边键集合。
 */
export const ASPECT_TICKS = ['1:1', '3:4', '4:3', '2:3', '3:2', '16:9', '9:16']

/**
 * 速度% → 画幅长边（像素）。
 * 只在这四档上取，中间值先经 `quantizeSpeedPercent` 吸附 —— 与 `SPEED_MAP.image` 同口径。
 * ⚠ 这里的数字是**边长**，不是 `SPEED_MAP` 里的 `size` 字段直接照抄：
 *   `SPEED_MAP` 的 `steps` 列在本插件里**不生效**（见文件头"为什么不动步数"），
 *   只有 `size` 列被采纳，且以边长解释。
 */
export const SPEED_EDGE = { 100: 1024, 75: 896, 50: 768, 25: 640 }

/**
 * 速度% → 该档的参考图**预算**（契约 SPEED_MAP.image[档].refs）。
 * ⚠ 这是**信息**不是硬闸：插件不因此拒绝用户显式给的参考图
 *   （真正的硬上限仍是 `MAX_REFERENCE_IMAGES`，见 lib/reference-inputs.js）。
 */
export const SPEED_REFS = { 100: 16, 75: 8, 50: 4, 25: 1 }

/** 面板还没被拨过时的取值。数值与 `mode-schema.js` 的 `CONTROLS.*.default` 必须一致。 */
export const DEFAULT_CONTROLS = Object.freeze({
  mode: 'image',
  aspect: 0,
  speedPercent: 100,
  negative: '',
  seed: -1,
  steps: 8,
  cfg: 1,
  count: 1,
  frames: 49,
  fps: 24,
  denoise: 0.85,
  tileSize: 512,
  chunkOverlap: 8,
})

/** `CONTROLS` 三组定义摊平成 `key → def`，供校验时按定义 clamp。 */
function defsByKey() {
  const out = new Map()
  for (const group of Object.values(CONTROLS)) {
    for (const def of group) if (def && typeof def.key === 'string') out.set(def.key, def)
  }
  return out
}

const MODE_IDS = new Set(MODES.map((m) => m.id))

/** 按定义把单值 clamp 到 [min,max] 并对齐 step；非数返回 `fallback`。 */
function clampByDef(def, value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const min = Number.isFinite(def?.min) ? def.min : -Infinity
  const max = Number.isFinite(def?.max) ? def.max : Infinity
  const step = Number.isFinite(def?.step) && def.step > 0 ? def.step : 0
  let v = Math.min(max, Math.max(min, value))
  if (step > 0) {
    // 对齐到 min + n*step（不是对齐到 0）—— 否则 25..100 step5 会错位
    const steps = Math.round((v - (Number.isFinite(def.min) ? def.min : 0)) / step)
    v = (Number.isFinite(def.min) ? def.min : 0) + steps * step
    v = Math.min(max, Math.max(min, v))
    // 浮点消除：0.1+0.05 这类档位别落成 0.15000000000000002
    v = Number(v.toFixed(4))
  }
  if (def?.type === 'number' || def?.type === 'integer') v = Math.trunc(v)
  return v
}

/**
 * 把任意外来对象洗成**干净的控制项**：未知键丢弃、模式校验、数值 clamp+对齐。
 * 这是唯一的入口校验点 —— 面板 POST 上来的东西一律过这里，不允许透传到 cfg。
 */
export function sanitizeControls(raw) {
  const defs = defsByKey()
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULT_CONTROLS }
  for (const [key, fallback] of Object.entries(DEFAULT_CONTROLS)) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (key === 'mode') {
      out.mode = typeof value === 'string' && MODE_IDS.has(value) ? value : fallback
      continue
    }
    const def = defs.get(key)
    // ★ 0.19.2：自由文本控制项（负面提示词）按字符截断，不参与数字 clamp。
    if (def && def.type === 'text') {
      const raw = typeof value === 'string' ? value : String(value ?? '')
      out[key] = def.max && def.max > 0 ? raw.slice(0, def.max) : raw
      continue
    }
    out[key] = clampByDef(def, typeof value === 'number' ? value : Number(value), fallback)
  }
  return out
}

/** 控制项文件绝对路径。 */
export function controlsPath(outputDir) {
  const dir = typeof outputDir === 'string' && outputDir.trim() !== '' ? outputDir.trim() : '.'
  return path.join(dir, CONTROL_FILE)
}

/**
 * 读控制项。**任何失败都退回默认值**（文件不存在 / JSON 坏 / 权限不够）。
 * @param {string} outputDir 成品目录（`cfg.outputDir`）
 */
export function readControls(outputDir) {
  const file = controlsPath(outputDir)
  try {
    if (!existsSync(file)) return { ...DEFAULT_CONTROLS }
    return sanitizeControls(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_CONTROLS }
  }
}

/**
 * 合并写入控制项（先读旧值，再盖 patch，再落盘）。返回**落盘后的完整控制项**，
 * 即便写盘失败也返回合并结果 —— 面板要立刻回显，不能让 IO 失败把 UI 卡住。
 * @returns {{ controls: object, saved: boolean, reason: string }}
 */
export function writeControls(outputDir, patch) {
  const merged = sanitizeControls({ ...readControls(outputDir), ...(patch ?? {}) })
  const file = controlsPath(outputDir)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return { controls: merged, saved: true, reason: '' }
  } catch (error) {
    // 临时文件残留要清掉（写失败时它可能已经建出来了）
    try { unlinkSync(`${file}.${process.pid}.tmp`) } catch { /* 没有就算了 */ }
    return { controls: merged, saved: false, reason: String(error?.message ?? error) }
  }
}

/** 速度% → 画幅长边像素（先吸附四档）。 */
export function speedEdge(speedPercent) {
  return SPEED_EDGE[quantizeSpeedPercent(speedPercent)] ?? SPEED_EDGE[100]
}

/** 速度% → 总像素（百万）。calcSize 按 aspect 分配宽高，这里只给面积预算。 */
export function speedTomp(speedPercent) {
  const edge = speedEdge(speedPercent)
  return Number(((edge / 1024) ** 2).toFixed(4))
}

/** 速度% → 参考图张数上限（超出的参考图会被如实拒绝，不是静默截断）。 */
export function speedMaxRefs(speedPercent) {
  return SPEED_REFS[quantizeSpeedPercent(speedPercent)] ?? SPEED_REFS[100]
}

/**
 * 控制项 → `resolveDrawParams` 认识的 **pref 形状**（兜底层）。
 *
 * ⚠ 只输出**本插件真能生效**的键：
 *   · `size`   → 画幅比例（对应 ASPECTS 键）
 *   · `megapixels` → 速度% 换算的像素预算
 *   · `steps`  → 仅在原生链路（textControl=native）真正按它采样；Turbo 链会忽略
 *                （`PARAMETERS.steps` 的说明里已如实写明，不在这里重复说谎）
 *   · `count`  → 每轮张数
 *   `seed` **不在这里**：它由 runDraw 单独取值（`seed >= 0` 才采纳，-1 = 每次随机）。
 */
export function controlsToPref(controls) {
  const c = sanitizeControls(controls)
  const idx = Math.min(ASPECT_TICKS.length - 1, Math.max(0, Math.trunc(c.aspect)))
  const out = {}
  // ★★ 只输出**用户真的动过**的键 —— 这一条是语义要害，别"顺手全给"：
  //   面板从没被拨过时（文件里就是默认值），若把所有键都塞进 pref，就会把
  //   **记忆偏好和 cfg.preset 一起压掉**（用户上次记下的 3:4 会被默认的 1:1 盖掉，
  //   原生链路的 baseSteps 也会被强制成 8）—— 那就成了"装个面板，旧行为全变"。
  //   ⇒ 默认值一律**不输出**，等于"面板对这项没有意见"。
  if (c.aspect !== DEFAULT_CONTROLS.aspect) out.size = ASPECT_TICKS[idx]
  if (c.speedPercent !== DEFAULT_CONTROLS.speedPercent) out.megapixels = speedTomp(c.speedPercent)
  if (c.steps !== DEFAULT_CONTROLS.steps) out.steps = c.steps
  if (c.count !== DEFAULT_CONTROLS.count) out.count = c.count
  // ★ 0.19.2：CFG 与负面提示词升为可调。
  //   · cfg：蒸馏链（Turbo8 / 官方 Turbo）必须 1.0，buildWorkflow 会强制回 1，这里只透传用户意图；
  //     原生链默认 2.5，用户拨了才覆盖。
  //   · negative：非空才输出，空字符串 = "没意见"，不压掉风格包里可能带的 negative。
  if (c.cfg !== DEFAULT_CONTROLS.cfg) out.cfg = c.cfg
  const neg = String(c.negative ?? '').trim()
  if (neg !== '') out.negative = neg
  return out
}

/**
 * 供面板/日志用的人话摘要。**如实标「估算」**，不把外部实测当自己的承诺。
 */
export function describeControls(controls) {
  const c = sanitizeControls(controls)
  const idx = Math.min(ASPECT_TICKS.length - 1, Math.max(0, Math.trunc(c.aspect)))
  const tier = quantizeSpeedPercent(c.speedPercent)
  const mode = MODES.find((m) => m.id === c.mode)
  // ★★ 2026-11-10：摘要必须**按模式说人话**。以前视频模式也写「长边 1024 / 参考图预算 16」
  //   —— 那是 SPEED_MAP.image 的档，视频链根本不看它（看 frames/fps/height）。面板与日志
  //   拿这行去解释当前档位，等于把图链的参数安到视频链头上，属于假报告。
  const head = `${mode?.label ?? c.mode} · ${ASPECT_TICKS[idx]} · 速度 ${c.speedPercent}%（吸附 ${tier} 档`
  if (c.mode === 'video' || c.mode === 'hybrid') {
    const slot = SPEED_MAP.video?.[tier]
    const tail = slot
      ? ` → ${slot.frames} 帧 / ${slot.fps} fps / 高 ${slot.height}`
      : ' → 该档未定义'
    return head + tail + '）'
      + (c.mode === 'hybrid' ? ' · 混合链含 Qwen3-TTS 语音段（音频与 mp4 不自动合流）' : '')
  }
  return head
    + `，长边 ${speedEdge(c.speedPercent)}，该档参考图预算 ${speedMaxRefs(c.speedPercent)}）`
}

/** 是否该采纳面板 seed（-1 表示"交给随机"）。 */
export function resolveSeed(controls, argsSeed) {
  if (Number.isFinite(argsSeed)) return Math.trunc(argsSeed)
  const c = sanitizeControls(controls)
  return c.seed >= 0 ? Math.trunc(c.seed) : null
}

/** 速度档清单（面板要画刻度，前端不重复硬编码）。 */
export const speedTiers = SPEED_TIERS
