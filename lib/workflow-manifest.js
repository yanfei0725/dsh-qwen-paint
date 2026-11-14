/**
 * lib/workflow-manifest.js —— 工作流声明式清单（A1「工作流 JSON 化」第一步）。
 *
 * ## 为什么存在
 * 三条链（生图 / 视频 / TTS）的节点拓扑此前**硬编码在 JS 里**：换模型、节点改名、
 * 多加一条输出链都得改代码 —— 这正是「模型一升级就漂移」的根因。本模块把
 * **拓扑 + 输入槽绑定**搬到 `workflows/*.json`，插件退化为通用 runner。
 *
 * ## 分层：为什么 plan / 对齐不放进清单
 *   · 清单负责：节点拓扑、输入槽绑定、必需节点、条件补丁 —— 最容易漂移的部分。
 *   · JS 侧保留：参数**对齐**（帧数 4n+1、边长 16 倍数）、plan 元信息（秒数、i2v/t2v
 *     判定）、notes。这些是**派生计算**，塞进 JSON 会变成一门自定义小语言，
 *     可读性和可测性都会掉。**清单描述图，代码描述算。**
 *
 * ## 占位符
 *   整个输入值**恰好**写成 `$param.x` / `$asset.x` / `$const.x` 才替换，
 *   **不做内联插值**。理由：`prompt` 是用户输入，内联替换会把 prompt 里的 `$`
 *   也一起吃掉；整串匹配能彻底杜绝这类误伤。
 *   替换**保持原类型** —— `consts` 里的 `true` / `10.0` 不会变成字符串 `"true"`。
 *
 * ## 硬规矩
 *   · 纯函数、零外部依赖（除 `node:fs` 读自己包内的 json）。
 *   · 读路径用 `new URL('../workflows/', import.meta.url)`，与 `lib/asset-route.js` 同口径。
 *   · ⚠ 清单文件必须列进 `package.json` 的 `files` 白名单，否则 npm 包里没有它，
 *     装上就会崩。`scripts/test-workflow-manifest.mjs` 有专门断言锁这一条。
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 支持的最低 schemaVersion。改格式时**必须**同时改这里和迁移说明。 */
export const SCHEMA_VERSION = 1

/** 整串占位符：`$param.prompt` / `$asset.unet` / `$const.cfg`。 */
const PLACEHOLDER_RE = /^\$(param|asset|const)\.([A-Za-z0-9_]+)$/

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/** 清单目录（包内 `workflows/`）。 */
export function manifestDir() {
  return fileURLToPath(new URL('../workflows/', import.meta.url))
}

/**
 * 清单 id 只允许文件名安全字符。
 * ★ 防路径穿越：`path.join` 不会拦 `..`，`sanitizeRelPath` 那次的教训照搬过来。
 */
function sanitizeId(id) {
  const s = String(id ?? '').trim()
  if (s === '') throw new Error('工作流清单 id 不能为空')
  if (s === '.' || s === '..') throw new Error(`工作流清单 id 非法：${JSON.stringify(s)}`)
  if (s.includes('/') || s.includes('\\') || s.includes(':') || s.includes('..')) {
    throw new Error(`工作流清单 id 非法：${JSON.stringify(s)}`)
  }
  return s
}

/** 递归收集一个值里所有的占位符引用。 */
function collectRefs(value, out = []) {
  if (typeof value === 'string') {
    const m = PLACEHOLDER_RE.exec(value)
    if (m !== null) out.push({ scope: m[1], key: m[2] })
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out)
    return out
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) collectRefs(value[k], out)
  }
  return out
}

/**
 * 把一个输入值里的占位符替换成 ctx 里的实际值。
 * 非占位符字符串、数字、布尔、数组里的节点引用（`["1", 0]`）**原样返回**。
 */
export function bindValue(value, ctx) {
  if (typeof value === 'string') {
    const m = PLACEHOLDER_RE.exec(value)
    if (m === null) return value
    const scope = m[1]
    const key = m[2]
    const bucket = ctx?.[scope]
    if (!isPlainObject(bucket) || !(key in bucket)) {
      throw new Error(`占位符 ${value} 在 ctx.${scope} 里取不到 ${key}`)
    }
    return bucket[key]
  }
  if (Array.isArray(value)) return value.map((v) => bindValue(v, ctx))
  if (isPlainObject(value)) {
    const out = {}
    for (const k of Object.keys(value)) out[k] = bindValue(value[k], ctx)
    return out
  }
  return value
}

/** 条件补丁是否命中。目前只支持 `when.param` + `nonEmpty` / `equals`。 */
export function patchApplies(patch, ctx) {
  const when = patch?.when
  if (when === undefined) return true
  if (!isPlainObject(when)) return false
  const scope = isNonEmptyString(when.scope) ? when.scope : 'param'
  const v = ctx?.[scope]?.[when.param]
  if (when.nonEmpty === true) {
    // ⚠ 与 `??` 口径一致：空串算「没给」，因此不应用补丁。
    //   `writeWorkflow` 那边是 `if (startImage !== '')`，这里必须同口径。
    return v !== undefined && v !== null && String(v).trim() !== ''
  }
  if ('equals' in when) return v === when.equals
  return v !== undefined && v !== null
}

/**
 * 绑定整张图并应用条件补丁。
 *
 * 补丁支持两种动作，**先 add 后 set**：
 *   · `add`：条件新增节点（例：只有给了音轨才让 `VHS_LoadAudio` 存在 ——
 *     无条件挂一个空 `audio_file` 的加载节点会让整条链在运行时炸）
 *   · `set`：改已有节点的 inputs（含给新增节点接线，所以顺序不能反）
 *
 * @returns {{ workflow: object, appliedPatches: string[] }}
 */
export function bindGraph(manifest, ctx) {
  const graph = bindValue(manifest?.graph ?? {}, ctx)
  const appliedPatches = []
  for (const patch of manifest?.patches ?? []) {
    if (!patchApplies(patch, ctx)) continue
    const addAll = bindValue(patch.add ?? {}, ctx)
    for (const nodeId of Object.keys(addAll)) {
      // 覆盖已有节点等于让清单作者以为自己改的是主图，实际是补丁 —— 直接报错更省事。
      if (graph[nodeId] !== undefined) throw new Error(`补丁 ${patch.id} 要新增的节点 ${nodeId} 与主图重号`)
      graph[nodeId] = addAll[nodeId]
    }
    const setAll = bindValue(patch.set ?? {}, ctx)
    for (const nodeId of Object.keys(setAll)) {
      const node = graph[nodeId]
      if (!isPlainObject(node)) throw new Error(`补丁 ${patch.id} 指向不存在的节点 ${nodeId}`)
      node.inputs = { ...(node.inputs ?? {}), ...setAll[nodeId] }
    }
    appliedPatches.push(patch.id)
  }
  return { workflow: graph, appliedPatches }
}

/**
 * 清单结构校验。返回**错误数组**（空数组 = 通过），不抛异常 ——
 * 好让测试把每条错误逐条打出来，而不是只看第一条。
 */
export function validateManifest(manifest) {
  const errors = []
  if (!isPlainObject(manifest)) return ['清单根必须是对象']

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${SCHEMA_VERSION}，实际 ${JSON.stringify(manifest.schemaVersion)}`)
  }
  if (!isNonEmptyString(manifest.id)) errors.push('id 必须是非空字符串')
  if (!isNonEmptyString(manifest.label)) errors.push('label 必须是非空字符串')
  if (!isNonEmptyString(manifest.kind)) errors.push('kind 必须是非空字符串')

  const graph = manifest.graph
  if (!isPlainObject(graph) || Object.keys(graph).length === 0) {
    errors.push('graph 必须是非空对象')
    return errors
  }

  const params = isPlainObject(manifest.params) ? manifest.params : {}
  const assets = isPlainObject(manifest.assets) ? manifest.assets : {}
  const consts = isPlainObject(manifest.consts) ? manifest.consts : {}
  const bucketOf = (scope) => (scope === 'param' ? params : scope === 'asset' ? assets : consts)

  // ① 节点结构 + 占位符引用 + 节点间引用
  const classTypes = new Set()
  for (const id of Object.keys(graph)) {
    const node = graph[id]
    if (!isNonEmptyString(node?.class_type)) {
      errors.push(`节点 ${id} 缺 class_type`)
      continue
    }
    classTypes.add(node.class_type)
    if (!isPlainObject(node.inputs)) {
      errors.push(`节点 ${id} 的 inputs 必须是对象`)
      continue
    }
    for (const slot of Object.keys(node.inputs)) {
      const value = node.inputs[slot]
      for (const ref of collectRefs(value)) {
        if (!(ref.key in bucketOf(ref.scope))) {
          errors.push(`节点 ${id}.${slot} 引用了未声明的 $${ref.scope}.${ref.key}`)
        }
      }
      // 节点引用形如 ["1", 0]：第一个元素必须是图里存在的节点
      if (Array.isArray(value) && value.length === 2
        && typeof value[0] === 'string' && Number.isInteger(value[1])
        && !(value[0] in graph)) {
        errors.push(`节点 ${id}.${slot} 指向不存在的节点 ${value[0]}`)
      }
    }
  }

  // ② requires.nodes 必须与图里的 class_type **双向相等**（漏写/多写都算错）
  const declared = Array.isArray(manifest.requires?.nodes) ? manifest.requires.nodes : []
  const missingDecl = [...classTypes].filter((c) => !declared.includes(c))
  // patch.add 里的节点是**条件节点**：主图里没有它，所以：
  //   · 不计入 missingDecl（不要求写进 requires.nodes）；
  //   · 但写进 requires.nodes 也**不算多声明** —— 有的清单作者想把条件依赖也声明全。
  const conditionalClasses = new Set()
  for (const patch of manifest.patches ?? []) {
    for (const node of Object.values(patch?.add ?? {})) {
      if (isNonEmptyString(node?.class_type)) conditionalClasses.add(node.class_type)
    }
  }

  const extraDecl = declared.filter((c) => !classTypes.has(c) && !conditionalClasses.has(c))
  if (missingDecl.length > 0) errors.push(`requires.nodes 漏声明：${missingDecl.join(', ')}`)
  if (extraDecl.length > 0) errors.push(`requires.nodes 多声明（图里没有）：${extraDecl.join(', ')}`)

  // ③ 补丁
  const patchIds = new Set()
  for (const patch of manifest.patches ?? []) {
    if (!isNonEmptyString(patch?.id)) { errors.push('patch 缺 id'); continue }
    if (patchIds.has(patch.id)) errors.push(`patch id 重复：${patch.id}`)
    patchIds.add(patch.id)
    const hasSet = patch.set !== undefined
    const hasAdd = patch.add !== undefined
    if (!hasSet && !hasAdd) { errors.push(`patch ${patch.id} 至少要有 set 或 add`); continue }
    if (hasSet && !isPlainObject(patch.set)) { errors.push(`patch ${patch.id} 的 set 必须是对象`); continue }
    if (hasAdd && !isPlainObject(patch.add)) { errors.push(`patch ${patch.id} 的 add 必须是对象`); continue }
    for (const nodeId of Object.keys(patch.set ?? {})) {
      if (!(nodeId in graph)) errors.push(`patch ${patch.id} 指向不存在的节点 ${nodeId}`)
    }
    for (const nodeId of Object.keys(patch.add ?? {})) {
      if (nodeId in graph) errors.push(`patch ${patch.id} 新增的节点 ${nodeId} 与主图重号`)
      if (!isNonEmptyString(patch.add[nodeId]?.class_type)) errors.push(`patch ${patch.id} 新增的节点 ${nodeId} 缺 class_type`)
    }
    if (patch.when !== undefined && !isPlainObject(patch.when)) {
      errors.push(`patch ${patch.id} 的 when 必须是对象`)
    }
    if (patch.requiresNodes !== undefined
      && !(Array.isArray(patch.requiresNodes) && patch.requiresNodes.every(isNonEmptyString))) {
      errors.push(`patch ${patch.id} 的 requiresNodes 必须是非空字符串数组`)
    }
  }

  // ④ 必填参数不能同时有 default（否则「必填」名不副实）
  for (const k of Object.keys(params)) {
    if (params[k]?.required === true && 'default' in (params[k] ?? {})) {
      errors.push(`参数 ${k} 既是 required 又有 default，语义冲突`)
    }
  }

  return errors
}

/** 读并校验一个清单。校验不过直接抛，**不返回半成品**。 */
export function loadManifest(id, { dir } = {}) {
  const base = dir ?? manifestDir()
  const file = path.join(base, `${sanitizeId(id)}.json`)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`读不到工作流清单 ${id}（${file}）：${e?.message ?? e}`)
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (e) {
    throw new Error(`工作流清单 ${id} 不是合法 JSON：${e?.message ?? e}`)
  }
  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`工作流清单 ${id} 校验失败：\n  - ${errors.join('\n  - ')}`)
  }
  return manifest
}

/** 列出目录下所有清单 id。目录不存在时返回空数组（不抛）。 */
export function listManifests({ dir } = {}) {
  const base = dir ?? manifestDir()
  let names = []
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  return names.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
}

/**
 * 参数默认值填充：只对**没给**（undefined / null）的键填 default。
 * ⚠ 用 `??` 口径而不是 `||` —— 空串是**有效值**（例如 prefix 允许空串），
 *   `||` 会把空串也当没给，与源码 `String(o.prefix ?? '...')` 的行为不一致。
 */
export function applyDefaults(manifest, values) {
  const out = { ...(values ?? {}) }
  for (const k of Object.keys(manifest?.params ?? {})) {
    const spec = manifest.params[k]
    if (out[k] === undefined || out[k] === null) {
      if ('default' in spec) out[k] = spec.default
    }
  }
  return out
}
