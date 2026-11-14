/**
 * A1 生图链 / TTS 链的**契约对账** + D26 的**提交前图裁剪**。
 *
 * ## 为什么不是"把生图链整图搬进清单"
 * 生图链按 caps 折 basic/full、按参考图/控制图/批量分裂十几条分支，
 * 节点 id 是硬编码 + `delete undefined` 的产物。整图清单化会变成半迁移：
 * 清单和代码两边都能跑、两边都会漂，且视频链那套 `requires.nodes` 双向相等校验
 * 对"分支图"根本不成立（basic 档的图里本来就没有 VAEDecodeTiled）。
 *
 * 所以这里换一种契约：**只锁"哪些角色必须在、参数必须流到哪"**。
 * 图怎么长出来不管，但长完必须满足契约。一旦不满足，报的是
 * `参数 steps 期望 25、实际 12` 这种**能直接定位**的差异 —— 这正是
 * 图结构指纹（workflow-fingerprint.js）答不出的那一半。
 *
 * 两者分工：
 *   · 指纹  —— 图变了没有（整图哈希，防悄悄漂移，答不出哪里变）
 *   · 契约  —— 该在的还在吗、值对不对（角色级，能定位到 slot）
 *
 * ## D26：ComfyUI 本来就是"按执行图懒加载"
 * 它只会执行 output 节点反向可达的那部分，可达不到的节点连模型都不会加载。
 * 所以"运行时跳过"不需要 ExecutionBlocker —— **项目侧的缺口是别把无关节点塞进提交载荷**。
 * `pruneGraph()` 就是从输出节点反向裁剪，把不可达的节点摘掉再提交。
 *
 * ⚠ 如实说明：裁剪的收益是**缩小 /prompt 的校验面与载荷**，不是"省显存"。
 *   ComfyUI 对不可达节点本来就不加载。别把这条吹成性能优化。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIT_SCHEMA_VERSION = 1

/** 触发实际产物落盘的类名。清单可用 `outputs` 覆盖。 */
export const DEFAULT_OUTPUT_CLASSES = Object.freeze([
  'SaveImage',
  'PreviewImage',
  'SaveAudio',
  'VHS_VideoCombine',
  'SaveAnimatedWEBP',
  'SaveAnimatedPNG',
  'SaveVideo',
])

/**
 * 一个 slot 的值是不是「节点连线」。
 * ComfyUI 的载荷里连线恒为 `["<nodeId>", <slotIndex>]`；字面量字符串/数字不是连线。
 */
export function isLink(v) {
  return Array.isArray(v) && v.length === 2
    && typeof v[0] === 'string' && v[0] !== ''
    && Number.isInteger(v[1]) && v[1] >= 0
}

/** 把图折成 { ids, byClass }。只认 `class_type` 是字符串的节点。 */
export function indexGraph(graph) {
  const ids = []
  const byClass = new Map()
  for (const id of Object.keys(graph ?? {})) {
    const node = graph[id]
    if (typeof node?.class_type !== 'string' || node.class_type === '') continue
    ids.push(id)
    const list = byClass.get(node.class_type)
    if (list === undefined) byClass.set(node.class_type, [id])
    else list.push(id)
  }
  return { ids, byClass }
}

/** 图里出现的全部类名（去重、稳定排序）。 */
export function classTypes(index) {
  return [...index.byClass.keys()].sort()
}

/** 输出节点 id（按类名白名单）。 */
export function outputNodeIds(graph, classes = DEFAULT_OUTPUT_CLASSES) {
  const want = new Set(classes)
  return Object.keys(graph ?? {}).filter((id) => want.has(graph[id]?.class_type))
}

/**
 * 从 `starts` 出发**反向**走连线，得到「为产出它而必须执行」的节点集合。
 * 反向是因为 ComfyUI 的执行方向就是 output → 上游。
 */
export function reachableFrom(graph, starts) {
  const seen = new Set()
  const stack = [...starts]
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    if (!Object.hasOwn(graph ?? {}, id)) continue
    seen.add(id)
    const inputs = graph[id]?.inputs
    if (inputs === null || typeof inputs !== 'object') continue
    for (const slot of Object.keys(inputs)) {
      const v = inputs[slot]
      if (isLink(v)) stack.push(v[0])
    }
  }
  return seen
}

/** 悬空连线：slot 指向了图里不存在的节点。这类图提交上去必被拒，但报错看不懂。 */
export function danglingLinks(graph) {
  const out = []
  for (const id of Object.keys(graph ?? {})) {
    const inputs = graph[id]?.inputs
    if (inputs === null || typeof inputs !== 'object') continue
    for (const slot of Object.keys(inputs)) {
      const v = inputs[slot]
      if (isLink(v) && !Object.hasOwn(graph, v[0])) {
        out.push({ node: id, slot, target: v[0] })
      }
    }
  }
  return out
}

/**
 * D26 / 提交前裁剪：摘掉从输出节点不可达的节点。
 *
 * @param {object} graph
 * @param {{ mutate?: boolean, outputs?: string[] }} [opts]
 * @returns {{ graph: object, removed: string[], kept: string[], outputs: string[], orphanedOutputs: boolean }}
 */
export function pruneGraph(graph, { mutate = false, outputs } = {}) {
  const src = graph ?? {}
  const outIds = outputNodeIds(src, outputs)
  // 没有输出节点的图不能裁 —— 裁完就空了，等于把用户的图删掉。
  if (outIds.length === 0) {
    return {
      graph: src,
      removed: [],
      kept: Object.keys(src),
      outputs: [],
      orphanedOutputs: false,
    }
  }
  const keep = reachableFrom(src, outIds)
  const removed = Object.keys(src).filter((id) => !keep.has(id))
  if (removed.length === 0) {
    return { graph: src, removed, kept: [...keep], outputs: outIds, orphanedOutputs: false }
  }
  const next = {}
  if (mutate) {
    for (const id of removed) delete src[id]
    return { graph: src, removed, kept: [...keep], outputs: outIds, orphanedOutputs: false }
  }
  for (const id of Object.keys(src)) {
    if (keep.has(id)) next[id] = src[id]
  }
  return { graph: next, removed, kept: [...keep], outputs: outIds, orphanedOutputs: false }
}

/**
 * 解析一个角色。
 * `classes` 是有序的候选类名（前面的优先，例如 GGUF 加载器优先于原生 UNETLoader）。
 * 同一个类命中多个时默认取第一个并标 `ambiguous` —— 只有 `multi:true` 的角色才允许。
 */
export function resolveRole(index, spec) {
  if (spec === null || typeof spec !== 'object') return null
  const classes = Array.isArray(spec.classes) ? spec.classes : []
  for (const cls of classes) {
    const ids = index.byClass.get(cls) ?? []
    if (ids.length === 0) continue
    const hit = { id: ids[0], class: cls, ids, ambiguous: ids.length > 1 }
    return hit
  }
  return null
}

/**
 * ⚠ 两种对齐**语义不同**，写错会让契约一路假红：
 *   · `r32()`（生图链）用 Math.round —— 就近取整，所以 830 → 832、816 → 832；
 *   · `alignTo()`（视频链 edge/frames）用 ceil —— 向上取整。
 * 只抄一个数字步长就当成同一种规则，是这里最容易犯的错。
 */
export function roundTo(value, step) {
  const n = Number(value)
  const s = Number(step)
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return value
  return Math.round(n / s) * s
}

/** 向上取整到 `step` 的整数倍。 */
export function alignTo(value, step) {
  const n = Number(value)
  const s = Number(step)
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return value
  return Math.ceil(n / s) * s
}

/** 按契约里声明的变换把入参折成「图里应该出现的值」。 */
export function applyTransform(value, transform) {
  if (transform === 'r32') return Math.max(32, roundTo(value, 32))
  if (transform === 'align8') return alignTo(value, 8)
  if (transform === 'align16') return alignTo(value, 16)
  if (transform === 'align64') return alignTo(value, 64)
  if (transform === 'int') return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : value
  return value
}

/** 按契约里的 min/max 夹取（对应源码里的 Math.max / Math.min 硬夹）。 */
export function clampTo(value, min, max) {
  let v = Number(value)
  if (!Number.isFinite(v)) return value
  if (Number.isFinite(min)) v = Math.max(min, v)
  if (Number.isFinite(max)) v = Math.min(max, v)
  return v
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验契约文件本身（不是校验图）。结构写错的契约会静默变成"永远通过"，必须先拦。
 */
export function validateContract(contract) {
  const errors = []
  if (!isPlainObject(contract)) return ['契约根必须是对象']
  if (contract.schemaVersion !== AUDIT_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${AUDIT_SCHEMA_VERSION}`)
  }
  if (typeof contract.id !== 'string' || contract.id === '') errors.push('id 必须是非空字符串')
  if (typeof contract.kind !== 'string' || contract.kind === '') errors.push('kind 必须是非空字符串')

  const roles = contract.roles
  if (!isPlainObject(roles) || Object.keys(roles).length === 0) {
    errors.push('roles 必须是非空对象')
    return errors
  }
  for (const name of Object.keys(roles)) {
    if (name.startsWith('_')) continue
    const r = roles[name]
    if (!isPlainObject(r)) { errors.push(`角色 ${name} 必须是对象`); continue }
    if (!Array.isArray(r.classes) || r.classes.length === 0
      || r.classes.some((c) => typeof c !== 'string' || c === '')) {
      errors.push(`角色 ${name}.classes 必须是非空字符串数组`)
    }
  }

  const params = isPlainObject(contract.params) ? contract.params : {}
  for (const key of Object.keys(params)) {
    if (key.startsWith('_')) continue
    const p = params[key]
    if (!isPlainObject(p)) { errors.push(`param ${key} 必须是对象`); continue }
    if (typeof p.role !== 'string' || p.role === '') {
      errors.push(`param ${key}.role 必须指向一个角色名`)
    } else if (!(p.role in roles)) {
      errors.push(`param ${key}.role 指向未声明的角色 ${p.role}`)
    }
    if (typeof p.slot !== 'string' || p.slot === '') errors.push(`param ${key}.slot 必须是非空字符串`)
  }

  // `forbid` 里写的东西必须真的能被判定 —— 空数组等于没写。
  // ⚠ `_` 开头的键是注释位（_note / _comment），跳过，不然每个契约都得被自己的注释判死。
  if (contract.forbid !== undefined) {
    if (!isPlainObject(contract.forbid)) errors.push('forbid 必须是对象')
    else {
      for (const key of Object.keys(contract.forbid)) {
        if (key.startsWith('_')) continue
        const list = contract.forbid[key]
        if (!Array.isArray(list) || list.some((c) => typeof c !== 'string' || c === '')) {
          errors.push(`forbid.${key} 必须是非空字符串数组`)
        }
      }
    }
  }
  return errors
}

/**
 * A1 核心：拿「这次真的构建出来的图」去核对契约。
 *
 * @param {object} graph    buildWorkflow / buildTtsWorkflow 的产物
 * @param {object} contract 契约（workflows/*.contract.json）
 * @param {object} [params] 本次构建用的入参（用于核对参数流向）
 * @returns {{ ok:boolean, id:string, diffs:Array, roles:object, stats:object }}
 *   diff.kind ∈ missing-role | ambiguous-role | unreachable | param-mismatch |
 *              dangling-edge | forbidden-present
 */
export function auditGraph(graph, contract, params = {}) {
  const diffs = []
  const notes = []
  const index = indexGraph(graph)
  const outIds = outputNodeIds(graph, contract?.outputs ?? DEFAULT_OUTPUT_CLASSES)
  const reach = outIds.length > 0 ? reachableFrom(graph, outIds) : null
  const roles = contract?.roles ?? {}

  // ① 角色存在性 + 从输出可达
  const resolved = {}
  for (const name of Object.keys(roles)) {
    if (name.startsWith('_')) continue
    const spec = roles[name]
    const hit = resolveRole(index, spec)
    resolved[name] = hit === null ? null : { id: hit.id, class: hit.class }
    if (hit === null) {
      if (spec.required !== false) {
        diffs.push({
          kind: 'missing-role',
          path: `role.${name}`,
          expected: spec.classes.join(' / '),
          actual: `全图 ${index.ids.length} 个节点里没有`,
        })
      }
      continue
    }
    if (hit.ambiguous === true && spec.multi !== true) {
      diffs.push({
        kind: 'ambiguous-role',
        path: `role.${name}`,
        expected: `唯一一个 ${hit.class}`,
        actual: `${hit.ids.length} 个（${hit.ids.slice(0, 4).join(',')}${hit.ids.length > 4 ? '…' : ''}）`,
      })
    }
    // 可达性只在"这张图确实有输出节点"时才有意义
    if (reach !== null && spec.mustReachOutput !== false && !reach.has(hit.id)) {
      diffs.push({
        kind: 'unreachable',
        path: `role.${name}`,
        expected: `从输出节点（${outIds.join(',')}）反向可达`,
        actual: `节点 ${hit.id}（${hit.class}）不可达，等于白放在图里`,
      })
    }
  }

  // ② 参数是否真的流到了声明的 slot
  const p = contract?.params ?? {}
  for (const key of Object.keys(p)) {
    if (key.startsWith('_')) continue
    const spec = p[key]
    // check:'non-empty' 的项走下面 ②b，不做等值比对（否则 prompt 被 trim 后必然假红）
    if (spec.check === 'non-empty') continue
    const want = params?.[key]
    // 没传这个参数时：可选项跳过核对，必填项由调用方自己的校验负责
    if (want === undefined || want === null) continue
    const role = resolved[spec.role]
    if (role === null || role === undefined) continue // 角色缺失已在①报过，不重复
    const node = graph[role.id]
    const actual = node?.inputs?.[spec.slot]
    // 先变换再夹取，顺序与源码一致（源码是先算 eff* 再 Math.max/min 夹）。
    const expected = clampTo(applyTransform(want, spec.transform), spec.min, spec.max)
    if (isLink(actual)) {
      // 该填值的地方接了根线 —— 参数被架空，是最隐蔽的一种错
      diffs.push({
        kind: 'param-mismatch',
        path: `${role.id}.${spec.slot}`,
        expected,
        actual: `连线 ${actual[0]}:${actual[1]}（参数没生效，被上游覆盖了）`,
      })
      continue
    }
    // 有条件成立的另一个合法值：例如 turbo8 蒸馏 LoRA 在时步数被强制钉成 8。
    // 这不是"用户参数没生效的 bug"，但也不能干脆不查 —— 条件是图里真的存在那个类。
    const alts = []
    for (const alt of Array.isArray(spec.alternates) ? spec.alternates : []) {
      if (typeof alt?.whenClass === 'string' && !index.byClass.has(alt.whenClass)) continue
      alts.push({ value: alt?.value, why: String(alt?.reason ?? '') })
    }
    const hitAlt = alts.find((a) => a.value === actual)
    if (actual === expected) continue
    if (hitAlt !== undefined) {
      notes.push({ path: `${role.id}.${spec.slot}`, actual, why: hitAlt.why })
      continue
    }
    diffs.push({
      kind: 'param-mismatch',
      path: `${role.id}.${spec.slot}`,
      expected: alts.length === 0
        ? expected
        : `${expected}（或 ${alts.map((a) => JSON.stringify(a.value)).join(' / ')}）`,
      actual,
    })
  }

  // ②b 只核对"有没有值"的项（prompt 会被 trimPrompt 改写、参考图会被加上 input/ 前缀，
  //     这类 slot 等值比对必然假红，又不能干脆不查 —— 查"非空"正好）。
  for (const key of Object.keys(p)) {
    if (key.startsWith('_')) continue
    const spec = p[key]
    if (spec.check !== 'non-empty') continue
    const want = params?.[key]
    if (want === undefined || want === null || String(want).trim() === '') continue
    const role = resolved[spec.role]
    if (role === null || role === undefined) continue
    const actual = graph[role.id]?.inputs?.[spec.slot]
    if (typeof actual !== 'string' || actual.trim() === '') {
      diffs.push({
        kind: 'param-mismatch',
        path: `${role.id}.${spec.slot}`,
        expected: '非空文本（实际内容会被源码二次加工，故只核对有值）',
        actual,
      })
    }
  }

  // ③ 悬空连线
  for (const bad of danglingLinks(graph)) {
    diffs.push({
      kind: 'dangling-edge',
      path: `${bad.node}.${bad.slot}`,
      expected: `指向图内节点`,
      actual: `指向不存在的 ${bad.target}`,
    })
  }

  // ④ 条件禁用：某参数为空时，某些类名不该出现（防"面板没开但节点还在"）
  for (const key of Object.keys(contract?.forbid ?? {})) {
    if (key.startsWith('_')) continue
    const value = params?.[key]
    const empty = value === undefined || value === null || String(value).trim() === ''
    if (!empty) continue
    for (const cls of contract.forbid[key]) {
      const ids = index.byClass.get(cls) ?? []
      if (ids.length > 0) {
        diffs.push({
          kind: 'forbidden-present',
          path: `forbid.${key}`,
          expected: `${key} 为空时不该有 ${cls}`,
          actual: `节点 ${ids.join(',')} 存在`,
        })
      }
    }
  }

  return {
    ok: diffs.length === 0,
    id: String(contract?.id ?? ''),
    diffs,
    notes,
    roles: resolved,
    stats: {
      nodes: index.ids.length,
      classes: index.byClass.size,
      outputs: outIds.length,
      reachable: reach === null ? null : reach.size,
    },
  }
}

/** 把 audit 结果压成一行人话，供工具返回值用。空 diff 返回空串。 */
export function briefAudit(result) {
  if (result === null || typeof result !== 'object') return ''
  if (result.ok === true) return ''
  const list = Array.isArray(result.diffs) ? result.diffs : []
  if (list.length === 0) return ''
  const head = list.slice(0, 4).map((d) => `${d.path}：期望 ${JSON.stringify(d.expected)}，实际 ${JSON.stringify(d.actual)}`)
  const more = list.length > 4 ? `……另有 ${list.length - 4} 处` : ''
  return `【${result.id || '图'} 与契约不一致】${head.join('；')}${more}。`
    + '图是代码按 caps 分支构建的，出现这条说明改代码时漏了同步，或某档位缺节点被静默降级。'
}

/* ---------------------------------------------------------- 契约文件读写 ---- */

/** 只留字母数字、下划线和短横：拒绝 `../` 之类的路径穿越。 */
export function sanitizeContractId(id) {
  return String(id ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '')
}

/** workflows/contracts/ 的绝对路径。单独放子目录是为了不被 listManifests() 扫成 manifest。 */
export function contractDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'contracts')
}

/** 读一个契约并校验。校验不过**直接抛**，不返回半成品。 */
export function loadContract(id, { dir } = {}) {
  const safe = sanitizeContractId(id)
  if (safe === '') throw new Error(`契约 id 不合法：${JSON.stringify(id)}`)
  const file = path.join(dir ?? contractDir(), `${safe}.contract.json`)
  const raw = readFileSync(file, 'utf8')
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) {
    throw new Error(`契约 ${safe} 不是合法 JSON：${e.message}`)
  }
  const errors = validateContract(parsed)
  if (errors.length > 0) throw new Error(`契约 ${safe} 校验失败：${errors.join('；')}`)
  return parsed
}

/** 列出全部契约 id（读不到目录返回空数组，不让一个坏文件拖垮整个端点）。 */
export function listContracts({ dir } = {}) {
  let names = []
  try { names = readdirSync(dir ?? contractDir()) } catch { return [] }
  return names
    .filter((f) => f.endsWith('.contract.json'))
    .map((f) => f.slice(0, -'.contract.json'.length))
    .sort()
}
