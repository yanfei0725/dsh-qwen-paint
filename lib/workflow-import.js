// 设计说明已外置 → docs/added-modules-design-notes.md#workflow-import-note-001（原 L1-23）
import { LITERAL_SLOTS } from './workflow-ast.js'
import { SCHEMA_VERSION } from './workflow-manifest.js'

export const IMPORT_SCHEMA = 'dsh-qwen-paint/workflow-import@1'

/** 常见终点/输出节点：用来回答「这张图最后产出在哪」。不全时不影响导入，只是 outputs 少列。 */
export const OUTPUT_NODE_TYPES = Object.freeze([
  'SaveImage', 'SaveImageWebsocket', 'PreviewImage', 'SaveImageToBase64',
  'VHS_VideoCombine', 'SaveAnimatedWEBP', 'SaveAnimatedPNG', 'SaveAnimatedAVIF',
  'SaveAudio', 'SaveAudioMP3', 'SaveAudioOpus', 'SaveAudioWAV', 'SaveAudioFlac', 'SaveAudioOgg',
])

/** 模型加载槽位：这些字面量归 $asset.*，而不是 $param.*。 */
const ASSET_SLOTS = Object.freeze({
  unet_name: 'unet', ckpt_name: 'ckpt', clip_name: 'clip', vae_name: 'vae',
  lora_name: 'lora', control_net_name: 'controlnet',
})

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/** id 白名单：只当模板键用，不允许任何路径语义。 */
export function sanitizeImportId(id) {
  const s = String(id ?? '').trim()
  if (!/^[a-z][a-z0-9_-]{1,47}$/u.test(s)) {
    throw new Error(`模板 id 非法：只允许小写字母开头、a-z0-9_-，长度 2-48，实际 ${JSON.stringify(s)}`)
  }
  return s
}

/**
 * 结构校验 + 归一化。返回 { ok, errors, warnings, graph }。
 * ⚠ 不抛异常（除了 id），好让调用方把每条错误逐条回给 UI。
 */
export function inspectWorkflow(raw) {
  const errors = []
  const warnings = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['工作流 JSON 根必须是对象'], warnings, graph: {} }

  // UI 格式识别：nodes + links 数组是 ComfyUI 界面导出的标志，明确拒绝。
  if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
    return {
      ok: false,
      errors: ['这是 ComfyUI UI 格式（含 nodes/links 数组），本插件只接受 API 格式。请在 ComfyUI 里用「Export (API)」重新导出。'],
      warnings, graph: {},
    }
  }
  // 空对象 / 只有注释键都不算工作流。
  const keys = Object.keys(raw).filter((k) => k !== '_comment')
  if (keys.length === 0) return { ok: false, errors: ['工作流没有任何节点'], warnings, graph: {} }
  if (keys.length > 400) errors.push(`节点数 ${keys.length} 超过上限 400`)

  const graph = {}
  const classTypes = new Set()
  for (const id of keys) {
    const node = raw[id]
    if (!isPlainObject(node)) { errors.push(`节点 ${id} 必须是对象`); continue }
    if (!isNonEmptyString(node.class_type)) { errors.push(`节点 ${id} 缺 class_type`); continue }
    if (!isPlainObject(node.inputs)) { errors.push(`节点 ${id} 的 inputs 必须是对象`); continue }
    classTypes.add(node.class_type)
    graph[id] = {
      class_type: node.class_type,
      inputs: { ...node.inputs },
      ...(node._meta !== undefined ? { _meta: node._meta } : {}),
    }
    // 校验节点引用 ["<id>", <port>] 指向存在的节点。
    for (const [slot, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2
        && typeof value[0] === 'string' && Number.isInteger(value[1])
        && !(value[0] in raw)) {
        errors.push(`节点 ${id}.${slot} 指向不存在的节点 ${value[0]}`)
      }
    }
  }

  // 有加载/采样却没有任何输出节点 → 只是警告（有些工作流用 PreviewImage 之外的自定义终点）。
  const outputs = Object.entries(graph)
    .filter(([, n]) => OUTPUT_NODE_TYPES.includes(n.class_type))
    .map(([id, n]) => ({ id, classType: n.class_type }))
  if (outputs.length === 0) warnings.push('未识别到常见输出节点（SaveImage / VHS_VideoCombine 等）；能导入但插件无法判断产出位置。')

  const missingSeed = ![...classTypes].some((c) => /KSampler|SamplerCustom/u.test(c))
  if (missingSeed) warnings.push('图里没有 KSampler / SamplerCustom，seed 参数可能无处可绑。')

  return {
    ok: errors.length === 0,
    errors, warnings, graph,
    summary: {
      nodeCount: Object.keys(graph).length,
      classTypes: [...classTypes].sort(),
      outputs,
    },
  }
}

/**
 * 对照本机 /object_info 计算节点覆盖。objectInfo 为空时 checked=false，不猜测。
 */
export function nodeCoverage(graph, objectInfo) {
  const checked = isPlainObject(objectInfo) && Object.keys(objectInfo).length > 0
  const classes = [...new Set(Object.values(graph).map((n) => n.class_type))]
  if (!checked) {
    return { checked: false, total: classes.length, available: [], missing: [], note: '未提供本机 /object_info，未做节点覆盖核对' }
  }
  const available = classes.filter((c) => c in objectInfo)
  const missing = classes.filter((c) => !(c in objectInfo))
  return {
    checked: true,
    total: classes.length,
    available,
    missing,
    note: missing.length === 0
      ? `${available.length} 个节点都在本机 /object_info 里`
      : `${missing.length} 个节点本机未安装：${missing.join(', ')}`,
  }
}

/**
 * 扫描可绑定槽位：把 LITERAL_SLOTS / ASSET_SLOTS 里的**字面量**输入列出来，
 * 供 UI 决定哪些能换成参数。⚠ 只识别不改写 —— 自动改写会误伤 prompt 里的字面量。
 */
export function detectBindableSlots(graph) {
  const out = []
  for (const [id, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      // 节点引用（数组）不是可绑定字面量。
      if (Array.isArray(value) || value === null || typeof value === 'object') continue
      const scope = ASSET_SLOTS[input] ? 'asset' : LITERAL_SLOTS.includes(input) ? 'param' : null
      if (scope === null) continue
      const key = scope === 'asset' ? ASSET_SLOTS[input] : input
      out.push({ node: id, input, scope, key, current: value })
    }
  }
  return out
}

/**
 * 把外部图转成清单同构模板：命中的字面量换成 `$param.*` / `$asset.*` 整串占位符，
 * 生成 params/assets 声明。不落盘、不进 listManifests —— 由调用方持有。
 */
export function buildTemplate(graph, { id, label, kind = 'custom' } = {}) {
  const templateId = sanitizeImportId(id)
  const params = {}
  const assets = {}
  const out = {}
  for (const [nodeId, node] of Object.entries(graph)) {
    const inputs = {}
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(value) || value === null || typeof value === 'object') {
        inputs[input] = value
        continue
      }
      const scope = ASSET_SLOTS[input] ? 'asset' : LITERAL_SLOTS.includes(input) ? 'param' : null
      if (scope === null) { inputs[input] = value; continue }
      const key = scope === 'asset' ? ASSET_SLOTS[input] : input
      const bucket = scope === 'asset' ? assets : params
      // 同名槽位多节点共用：只在第一次记录默认值，避免后一个节点覆盖前一个。
      if (!(key in bucket)) bucket[key] = { type: typeof value === 'number' ? 'number' : 'string', default: value }
      inputs[input] = `$${scope}.${key}`
    }
    out[nodeId] = { class_type: node.class_type, inputs, ...(node._meta !== undefined ? { _meta: node._meta } : {}) }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: templateId,
    label: isNonEmptyString(label) ? label.slice(0, 80) : `导入模板 ${templateId}`,
    kind: isNonEmptyString(kind) ? kind.slice(0, 32) : 'custom',
    imported: true,
    source: 'external-api-json',
    requires: { nodes: [...new Set(Object.values(out).map((n) => n.class_type))].sort() },
    params, assets, consts: {},
    graph: out,
    patches: [],
  }
}

/**
 * 进程内模板注册表。只存内存：重启即失效（诚实写明），不做持久化、不写磁盘。
 */
export function createImportRegistry({ maxEntries = 20, now } = {}) {
  const entries = new Map()
  const clock = typeof now === 'function' ? now : () => Date.now()
  const cap = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.min(100, Math.trunc(Number(maxEntries)))) : 20
  return {
    put(template, meta = {}) {
      const id = sanitizeImportId(template?.id)
      if (!entries.has(id) && entries.size >= cap) {
        throw new Error(`导入模板已达上限 ${cap}，请先移除一个（重启插件也会清空）`)
      }
      const rec = {
        id,
        label: String(template.label ?? ''),
        kind: String(template.kind ?? ''),
        nodeCount: Object.keys(template.graph ?? {}).length,
        createdAt: clock(),
        note: String(meta.note ?? ''),
        template,
      }
      entries.set(id, rec)
      return rec
    },
    get(id) { return entries.get(String(id)) ?? null },
    list() {
      return [...entries.values()]
        .map(({ template, ...meta }) => meta)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    },
    remove(id) { return entries.delete(String(id)) },
    clear() { entries.clear() },
    size() { return entries.size },
  }
}
