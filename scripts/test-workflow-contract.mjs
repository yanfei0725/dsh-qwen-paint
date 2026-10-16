/**
 * 工作流节点输入名「契约测试」（2026-10-16 新增）
 *
 * ## 为什么加这个测试
 *   真实用户反馈暴露了 3 个**致命** bug，全都是"节点输入名写错"：
 *     · `LoadImage` 写成 `upload`（正确是 `image`）      → 放大链必崩
 *     · `LoadImageMask` 漏了必需的 `channel`            → 局部重绘必崩
 *     · `ControlNetInpaintingAliMamaApply` 漏了
 *       `strength` / `start_percent` / `end_percent`    → 局部重绘必崩
 *
 *   当时已有的测试**全部通过** —— 因为它们只验"结构"，从不验"输入名"。
 *   ⇒ 本测试直接拿 **ComfyUI 源码解析出的真实契约**（`comfy-node-contract.json`）
 *     去比对代码里构建的工作流，让这类错**再也不可能溜过去**。
 *
 * ## 契约从哪来
 *   `scripts/extract_comfy_schema.py` 用 Python `ast` 解析本机 ComfyUI 的
 *   `nodes.py` / `comfy_extras/*.py`，提取每个节点 `INPUT_TYPES()` 的
 *   `required` / `optional` 键（新式 `io.ComfyNode.define_schema()` 也支持），
 *   并处理类继承（`LoadImageMask(LoadImage)` 就是靠继承拿到 `image` 的）。
 *
 * ## 纯 JS、不依赖环境
 *   契约已固化成 JSON ⇒ 本测试**不需要 ComfyUI 在跑、不需要联网、不派生任何子进程**
 *   （沙箱会间歇性禁止 spawn）。想更新契约时再跑那个 Python 脚本。
 *
 * 运行：node scripts/test-workflow-contract.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIB = path.join(ROOT, 'lib')

let pass = 0
let fail = 0
const fails = []

function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

/* ══════════════════════════════ 源码解析 ══════════════════════════════ */

/**
 * 从 `src[i]`（必须指向 `{`）开始，取出**第一层**的键名。
 * 正确处理：字符串（含转义）、行注释、块注释、嵌套对象/数组。
 */
function topLevelKeys(src, i) {
  const keys = []
  let depth = 0
  let buf = ''
  let quote = null
  let esc = false
  // ★ 标记"这一段里已经出现过冒号" ⇒ 之后再出现的标识符是**值**，不是键。
  //   第一版漏了这个，把 `image: reference` 的 `reference` 也当成了键。
  let seenColon = false
  const flush = (asShorthand) => {
    const k = buf.trim()
    if (asShorthand && !seenColon && /^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k)
    buf = ''
  }
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (quote !== null) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && src[i + 1] === '/') {           // 行注释
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {           // 块注释
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{' || c === '[') {
      depth += 1
      if (depth === 1) { buf = ''; seenColon = false; continue }
      continue
    }
    if (c === '}' || c === ']') {
      depth -= 1
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (c === ':') {
      const k = buf.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k)
      buf = ''
      seenColon = true
      continue
    }
    if (c === ',') {
      // ★ JS **简写属性**：`{ seed, steps: 4 }` 里的 `seed` 没有冒号。
      //   第一版漏了这个 ⇒ KSampler 的 `seed` / `denoise` 被误判成"缺失"，
      //   差点当成真 bug 去改代码。**解析器不认 ≠ 代码写错**，务必先判定再动手。
      flush(true)
      seenColon = false
      continue
    }
    buf += c
  }
  flush(true)   // 收尾：`{ ..., denoise }` 这种最后一个键
  return keys
}

/** 扫描一份源码，取出所有 `class_type: 'X'` 及其 `inputs` 的顶层键。 */
function extractNodes(src, file) {
  const out = []
  const re = /class_type:\s*'([A-Za-z0-9_]+)'/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const after = src.slice(m.index + m[0].length)
    const im = /inputs:\s*\{/.exec(after)
    if (im === null) continue
    const braceIdx = m.index + m[0].length + im.index + im[0].length - 1
    out.push({ name, keys: topLevelKeys(src, braceIdx), file })
  }
  return out
}

/* ══════════════════════════════ 主流程 ══════════════════════════════ */

const contract = JSON.parse(readFileSync(path.join(HERE, 'comfy-node-contract.json'), 'utf8'))
const NODES = contract.nodes ?? {}
console.log(`契约来源：${contract._sourceRoot}（扫描 ${contract._scannedFiles?.length ?? 0} 个 .py，${Object.keys(NODES).length} 个节点）`)

const files = readdirSync(LIB).filter((f) => f.endsWith('.js'))
const found = []
for (const f of files) {
  const src = readFileSync(path.join(LIB, f), 'utf8')
  found.push(...extractNodes(src, f))
}

console.log(`\n从 lib/ 提取到 ${found.length} 处工作流节点用法\n`)

console.log('[1] 每个节点都必须带齐 ComfyUI 要求的**必需输入**')
const unknown = new Set()
for (const node of found) {
  const c = NODES[node.name]
  if (c === undefined) { unknown.add(node.name); continue }
  const required = c.required ?? []
  const missing = required.filter((k) => !node.keys.includes(k))
  ok(missing.length === 0,
    `${node.name}（${node.file}）必需输入齐全${missing.length ? ` — 缺 ${missing.join(', ')}` : ''}`)
}

console.log('\n[2] 不得出现 ComfyUI 不认识的输入名（防笔误）')
for (const node of found) {
  const c = NODES[node.name]
  if (c === undefined) continue
  const allowed = new Set([...(c.required ?? []), ...(c.optional ?? []), ...(c.schemaInputs ?? [])])
  const bogus = node.keys.filter((k) => !allowed.has(k))
  ok(bogus.length === 0,
    `${node.name}（${node.file}）无未知输入${bogus.length ? ` — 多了 ${bogus.join(', ')}` : ''}`)
}

console.log('\n[3] 回归锁：历史上踩过的三个坑必须保持修好')
{
  const byName = (n) => found.filter((x) => x.name === n)
  const li = byName('LoadImage')
  ok(li.length > 0 && li.every((x) => x.keys.includes('image')), '所有 LoadImage 都用 `image`（不是 upload）')
  ok(li.every((x) => !x.keys.includes('upload')), '所有 LoadImage 都不含 `upload`')
  const lim = byName('LoadImageMask')
  ok(lim.length > 0 && lim.every((x) => x.keys.includes('channel')), '所有 LoadImageMask 都带 `channel`')
  const ali = byName('ControlNetInpaintingAliMamaApply')
  ok(ali.length > 0 && ali.every((x) => ['strength', 'start_percent', 'end_percent'].every((k) => x.keys.includes(k))),
    '所有 AliMamaApply 都带 strength/start_percent/end_percent')
}

if (unknown.size > 0) {
  console.log(`\nℹ 以下节点不在契约里（多为第三方节点，本机源码中无 INPUT_TYPES），已跳过严格检查：`)
  console.log('  ' + [...unknown].sort().join('、'))
  console.log('  → 若这些节点是第三方扩展，请在其安装后重跑 extract_comfy_schema.py 以纳入契约。')
}

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exit(1)
}
console.log('全部通过 ✓')
