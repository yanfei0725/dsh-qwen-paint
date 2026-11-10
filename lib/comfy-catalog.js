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
 * ## 硬规矩（报告 13.4 ② / ACTIVE.md 反复踩过的坑）
 * - **默认零漂移**：`finalizeWorkflow` 在 passes 没产生 changes 时**原样返回原 workflow**，
 *   不拿 emitWorkflow 的输出去提交 —— ComfyUI 端执行缓存键必须逐字节一致。
 * - **校验失败不阻断**：object_info 稀疏/节点改名/自定义节点缺 spec 时，
 *   ComfyUI 自己会判；插件只 warn + 回滚原样提交，绝不把"没测出来"变成"出图失败"。
 * - 全零外部依赖：`fetchFn` / `readFn` 由调用方注入，离线可测、不碰 net-guard 边界。
 */
import { runAstPipeline } from './workflow-ast.js'

// ── ① 全量 /object_info 惰性缓存 ─────────────────────────────────────────
let objectInfoCache = null // { at, url, info }

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
  if (!force && objectInfoCache && objectInfoCache.url === url
      && Date.now() - objectInfoCache.at < ttlMs) return objectInfoCache.info
  try {
    const res = await fetchFn(`${url}/object_info`, { timeoutMs: 20000, signal })
    if (!res.ok) return objectInfoCache?.info ?? null
    const info = await res.json()
    if (info === null || typeof info !== 'object' || Array.isArray(info)) return objectInfoCache?.info ?? null
    objectInfoCache = { at: Date.now(), url, info }
    return info
  } catch {
    return objectInfoCache?.info ?? null
  }
}

export function resetCatalogCache() { objectInfoCache = null }

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
