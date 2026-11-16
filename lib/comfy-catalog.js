/**
 * lib/comfy-catalog.js —— 报告 v3 §14，把 A/B 两线与 TTS 探测接到 host 的公共层。
 *
 * 三件事共用一份「ComfyUI 自报的家底」：
 *   ① `loadObjectInfo` 抓一次全量 `/object_info`（带 TTL 缓存、失败返回 null 不阻断）；
 *   ② B 线 `finalizeWorkflow` 拿它做**提交前校验**（`runAstPipeline` 的
 *      `validateAgainstObjectInfo` / `changes[]` / `rollback()` 在这里真正被 host 调用）；
 *   ③ A 线 `slotsForWorkflow` 把 `assets/slots.json`（derive-slots.py 产出）翻译成
 *      `SlotBindPass` 要的 `{ nodeId: { input: valueKey } }`；TTS 探测 `catalogForTts`
 *      把节点名/模型名整理成 `probeTts` 的形状。
 *
 * ## 硬规矩（开发笔记反复踩过的坑）
 * - **默认零漂移**：`finalizeWorkflow` 在 passes 没产生 changes 时**原样返回原 workflow**，
 *   不拿 emitWorkflow 的输出去提交 —— ComfyUI 端执行缓存键必须逐字节一致。
 * - **校验失败不阻断**：object_info 稀疏/节点改名/自定义节点缺 spec 时，
 *   ComfyUI 自己会判；插件只 warn + 回滚原样提交，绝不把"没测出来"变成"出图失败"。
 * - 全零外部依赖：`fetchFn` / `readFn` 由调用方注入，离线可测、不碰 net-guard 边界。
 */
import { runAstPipeline } from './workflow-ast.js'

// ── ① 全量 /object_info 惰性缓存 ─────────────────────────────────────────
let objectInfoCache = null // { at, url, info, failed }
// ★ 2026-11-16 P2：失败也必须留下时间戳，否则 ComfyUI 一忙就每轮重抓 30 秒。
//   失败冷却比成功 TTL 短得多（1 分钟），既能止血又能尽快恢复。
const OBJECT_INFO_FAILED_COOLDOWN_MS = 60000

/**
 * @param opts.url       ComfyUI 基址（本机回环）
 * @param opts.fetchFn   (url, {timeoutMs, signal}) => Response，由 host 注入 fetchWithTimeout
 * @param opts.signal    AbortSignal
 * @param opts.ttlMs     缓存时长，默认 10 分钟（与 probeCapabilities 同源）
 * @param opts.force     跳过缓存强制重抓
 * @returns {Promise<object|null>} 失败一律 null（调用方按"探测失败"处理，不阻断提交）
 */
export async function loadObjectInfo({ url, fetchFn, signal, ttlMs = 600000, force = false } = {}) {
  if (typeof fetchFn !== 'function' || typeof url !== 'string' || url === '') return null
  const failedCooldown = Math.min(ttlMs, OBJECT_INFO_FAILED_COOLDOWN_MS)
  const cacheLimit = objectInfoCache?.failed ? failedCooldown : ttlMs
  const age = objectInfoCache ? Date.now() - objectInfoCache.at : Infinity
  if (!force && objectInfoCache && objectInfoCache.url === url
      && age >= 0 && age < cacheLimit) return objectInfoCache.info
  // 失败也写时间戳：旧信息继续兜底，但冷却期内不再重复付 30 秒的等待。
  const markFailed = () => {
    objectInfoCache = { at: Date.now(), url, info: objectInfoCache?.info ?? null, failed: true }
    return objectInfoCache.info
  }
  try {
    // ★ 2026-11-16 审计 F3：3.4MB JSON 在 ComfyUI 忙时 20s 打不进 ⇒ 30s（失败仍走旧缓存兜底）。
    const res = await fetchFn(`${url}/object_info`, { timeoutMs: 30000, signal })
    if (!res.ok) return markFailed()
    const info = await res.json()
    if (info === null || typeof info !== 'object' || Array.isArray(info)) return markFailed()
    objectInfoCache = { at: Date.now(), url, info, failed: false }
    return info
  } catch {
    return markFailed()
  }
}

export function resetCatalogCache() { objectInfoCache = null }
export const __testObjectInfo = () => objectInfoCache
/** 只读诊断：给 check_acceleration / doctor 报告用，能看出"为什么这次没探到节点"。 */
export function objectInfoCacheStatus(now = Date.now()) {
  if (!objectInfoCache) return { present: false, failed: false, ageMs: null, info: null }
  return {
    present: true,
    failed: objectInfoCache.failed === true,
    ageMs: Math.max(0, now - objectInfoCache.at),
    info: objectInfoCache.info,
  }
}

/**
 * ★ 2026-11-16 性能：从**同一份**全量 /object_info 提取权重下拉候选，形状与
 * `probeCapabilities().files` 逐字等价 —— { unet, unetGguf, lora, controlnet }。
 *
 * 为什么需要：status.json 保存权重时旧代码调 probeCapabilities()，冷缓存会并发发
 * 24 个 `/object_info/{node}` + `/system_stats`；而这四个候选在已缓存的全量
 * objectInfo 里就有。复用它 ⇒ 省掉那串探测（"选模型卡一下"的服务端根因）。
 * 拿不到（离线/稀疏）一律返回 null，让调用方回退 probeCapabilities，**绝不放宽白名单**
 * —— 安全边界与原来逐字一致：候选空 = 拒绝该次选择。
 */
export function weightFilesFromObjectInfo(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const listOf = (nodeName, field) => {
    const spec = info?.[nodeName]?.input?.required?.[field] ?? info?.[nodeName]?.input?.optional?.[field]
    return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0].filter((x) => typeof x === 'string') : []
  }
  return {
    unet: listOf('UNETLoader', 'unet_name'),
    unetGguf: listOf('UnetLoaderGGUF', 'unet_name'),
    lora: listOf('LoraLoader', 'lora_name'),
    controlnet: listOf('ControlNetLoader', 'control_net_name'),
  }
}

// ── ② B 线：提交前管线 ──────────────────────────────────────────────────
/**
 * 跑 `runAstPipeline` 并决定最终提交体。
 * @returns {{workflow, validation, changes, chunkPlan, strict, error, rollback}}
 *   · `strict=true` 表示 passes 真改了东西，提交体用 payload；
 *   · 否则（默认）提交体 = 原 workflow，零漂移；
 *   · `error` 非空表示校验未通过，已按原样回滚，调用方只记日志不阻断。
 */
export function finalizeWorkflow(workflow, objectInfo, ctx = {}) {
  const base = {
    workflow, validation: null, changes: [], chunkPlan: null,
    strict: false, error: null, rollback: () => workflow,
  }
  if (!objectInfo || typeof objectInfo !== 'object') return base
  try {
    const r = runAstPipeline(workflow, objectInfo, ctx)
    const mutated = r.changes.length > 0
    return {
      workflow: mutated ? r.payload : workflow,
      validation: r.validation,
      changes: r.changes,
      chunkPlan: r.chunkPlan,
      strict: mutated,
      error: null,
      rollback: r.rollback,
    }
  } catch (error) {
    return { ...base, error: String(error?.message ?? error) }
  }
}

// ── ③ A 线：槽位声明文件 → SlotBindPass 上下文 ──────────────────────────
/**
 * 读 `assets/slots.json`（`scripts/derive-slots.py --out` 产出）。
 * readFn 注入便于离线测试；文件缺失/坏 JSON 一律返回空目录（不阻断）。
 */
export function readSlotsCatalog(readFn) {
  if (typeof readFn !== 'function') return { slots: {}, modelLoaders: {} }
  try {
    const j = JSON.parse(String(readFn()))
    return {
      slots: j && typeof j.slots === 'object' && j.slots !== null ? j.slots : {},
      modelLoaders: j && typeof j.modelLoaders === 'object' && j.modelLoaders !== null ? j.modelLoaders : {},
    }
  } catch {
    return { slots: {}, modelLoaders: {} }
  }
}

/**
 * A 线推导结果（class_type → 输入名列表）→ `SlotBindPass` 的 `slots`
 * （`{ nodeId: { input: valueKey } }`）。valueKey 与输入同名，配合 ctx.values 生效；
 * 默认 host 不传 values ⇒ 只声明槽位、不改提交体（见头注「默认零漂移」）。
 */
export function slotsForWorkflow(workflow, catalog) {
  const out = {}
  const byClass = catalog && typeof catalog.slots === 'object' ? catalog.slots : {}
  for (const [id, node] of Object.entries(workflow ?? {})) {
    if (node === null || typeof node !== 'object') continue
    const names = byClass[node.class_type]
    if (!Array.isArray(names)) continue
    const mapping = {}
    for (const input of names) mapping[input] = input
    out[String(id)] = mapping
  }
  return out
}

/** G2 模型加载器：class_type → 输入名列表（供 ModelMapPass / 缺件报告用）。 */
export function modelLoadersForWorkflow(workflow, catalog) {
  const out = {}
  const byClass = catalog && typeof catalog.modelLoaders === 'object' ? catalog.modelLoaders : {}
  for (const [id, node] of Object.entries(workflow ?? {})) {
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(byClass[node.class_type])) out[String(id)] = byClass[node.class_type]
  }
  return out
}

// ── TTS 探测：object_info → probeTts 的形状 ─────────────────────────────
/**
 * 从全量 object_info 提取 `probeTts(caps)` 需要的 `{ nodes, models }`：
 *   · nodes  = { [节点名]: true }（键是**节点类名**，不是 probeCapabilities 那套布尔标志）
 *   · models = 所有加载器下拉候选项（ComfyUI 的 `[[names...], {...}]` 第一项）
 * ⚠ 必须传**全量 /object_info**（不是 probeCapabilities 的能力标志集）：本机实测 1684 个节点里
 *     有 9 个 FB_Qwen3TTS* 与 SaveAudio* 一族。TTS 权重由节点包自行管理，不进下拉候选，
 *     所以 probeTts 只按**节点类名**判定，不拿 modelNames 当闸门。
 */
export function catalogForTts(info) {
  const nodes = {}
  const modelNames = []
  for (const [name, spec] of Object.entries(info ?? {})) {
    if (typeof name === 'string' && name !== '') nodes[name] = true
    const groups = spec?.input ?? {}
    for (const group of ['required', 'optional']) {
      for (const entry of Object.values(groups[group] ?? {})) {
        // ComfyUI 的 OPTIONS 形状： [ ["a.safetensors", "b.gguf"], { ... } ]
        if (Array.isArray(entry) && Array.isArray(entry[0])) {
          for (const m of entry[0]) if (typeof m === 'string') modelNames.push(m)
        }
      }
    }
  }
  return { nodes, models: { tts: [], checkpoints: modelNames, _count: modelNames.length } }
}

/**
 * ★ 2026-11-16 主模型候选（GET /api/comfy-pipeline/model-options 的提取层）：
 *   从全量 object_info 抓 UNETLoader 与 UnetLoaderGGUF 两个加载器的 `unet_name`
 *   OPTIONS 列表（形状同上：`[ ["a.safetensors", ...], {...} ]`），合并去重排序。
 *   两个加载器一个都没探到 → 返回**空数组**（如实，绝不编造候选）。
 *   纯函数：与 catalogForTts 一样只吃 object_info，可离线单测。
 */
export function unetOptionsFrom(info) {
  const names = new Set()
  for (const nodeName of ['UNETLoader', 'UnetLoaderGGUF']) {
    const entry = info?.[nodeName]?.input?.required?.unet_name
    if (Array.isArray(entry) && Array.isArray(entry[0])) {
      for (const m of entry[0]) if (typeof m === 'string' && m !== '') names.add(m)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
