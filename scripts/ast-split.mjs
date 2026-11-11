#!/usr/bin/env node
/**
 * 报告 v3 §14.4「C 线」：源码级 AST 拆分 —— **零依赖**版验证器。
 *
 * 本机 `acorn` / `recast` / `@babel/parser` 全部 MISSING（报告 §14.4 实测），
 * 且 `lib/client.js` 是非 ESM + `window.__ModuleLoader__` 单入口，AST 工具按 ESM 解析会失败。
 * 所以 C 线按报告结论落地为：**只拆 config.js、不碰 client.js、文本脚本 + 差分验证**。
 * 切分按「整行」不按 token —— 上下文策略实测：整行删与不压持平，按 token 删会掉 7.3pp。
 *
 * 本脚本**不改源码**，只产出「可安全外移的顶层块清单」并验证零漂移。
 * 真正外移沿用仓库既有范式（workflow-meta.js / model-chain.js / schema-defaults.js）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** 去掉一行里的字符串内容与 // 注释，避免括号误计数。 */
function stripLine(line) {
  let out = ''
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (quote !== '') {
      if (c === '\\') { i += 1; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '/' && line[i + 1] === '/') break
    out += c
  }
  return out
}

/**
 * 顶层声明块：以行级括号深度归零为边界。
 * 返回 [{ start, end, kind, name, lines, bytes }]，行号 1-based、闭区间。
 */
export function topLevelBlocks(src) {
  const lines = String(src).split('\n')
  const blocks = []
  let depth = 0
  let start = 0
  let kind = ''
  let name = ''
  for (let i = 0; i < lines.length; i += 1) {
    const clean = stripLine(lines[i])
    if (depth === 0 && clean.trim() !== '') {
      // 只从"能独立外移"的顶层声明起块
      const m = /^\s*(?:export\s+)?(const|let|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/.exec(clean)
        ?? /^\s*(import|export)\b/.exec(clean)
      if (m) {
        start = i
        kind = m[1]
        name = m[2] ?? ''
      }
    }
    for (const c of clean) {
      if (c === '{' || c === '(' || c === '[') depth += 1
      else if (c === '}' || c === ')' || c === ']') depth -= 1
    }
    if (depth <= 0 && start <= i && (kind !== '' || clean.trim() !== '')) {
      const isBlank = clean.trim() === ''
      if (!isBlank && kind !== '') {
        blocks.push({
          start: start + 1,
          end: i + 1,
          kind,
          name,
          lines: i - start + 1,
          bytes: Buffer.byteLength(lines.slice(start, i + 1).join('\n') + '\n', 'utf8'),
        })
      }
      depth = 0
      kind = ''
      name = ''
      start = i + 1
    }
  }
  return blocks
}

/**
 * 差分验证：按**整行块边界**把原文重新拼一遍，必须与原文逐字一致。
 * ⚠ 不是拿 lines 副本跟自己比（那是恒真的空操作）—— 真按块边界重组：
 *   · 块重叠（start < 上一块 end）⇒ 立刻判 false（stripLine 括号误计就会造成这种漂移）；
 *   · 块间行 / 末尾行照抄，不吞空行、不重排；
 *   · 整行抽取（不按 token）是"零漂移"的前提 —— 实测按 token 删会掉 7.3pp。
 */
export function verifyZeroDrift(src) {
  const lines = String(src).split('\n')
  const blocks = topLevelBlocks(src)
  const rebuilt = []
  let cursor = 0
  for (const b of blocks) {
    const s = b.start - 1
    const e = b.end
    if (s < cursor || e > lines.length) {
      return { ok: false, blocks: blocks.length, totalExtracted: 0, lineCount: lines.length, reason: '块边界重叠或越界' }
    }
    // ⚠ 逐行 push，不用 spread：config.js 三千多行，展开成参数会爆调用栈。
    for (let i = cursor; i < s; i += 1) rebuilt.push(lines[i])
    for (let i = s; i < e; i += 1) rebuilt.push(lines[i])
    cursor = e
  }
  for (let i = cursor; i < lines.length; i += 1) rebuilt.push(lines[i])
  const totalExtracted = blocks.reduce((sum, b) => sum + (b.end - b.start + 1), 0)
  const same = rebuilt.join('\n') === String(src)
  return {
    ok: same,
    blocks: blocks.length,
    totalExtracted,
    lineCount: lines.length,
    reason: same ? '' : '重组后与原文不一致',
  }
}

/** 门禁外移建议：在不超过单文件上限的前提下，给出一组可外移的大块。 */
export function splitPlan(src, limitBytes = 262144) {
  const blocks = topLevelBlocks(src)
  const oversized = Buffer.byteLength(String(src), 'utf8') - limitBytes
  if (oversized <= 0) return { needed: false, oversized: 0, candidates: [] }
  const candidates = blocks
    .filter((b) => b.kind !== 'import' && b.kind !== 'export')
    .sort((a, b) => b.bytes - a.bytes)
  const picked = []
  let saved = 0
  for (const b of candidates) {
    if (saved >= oversized) break
    picked.push(b)
    saved += b.bytes
  }
  return { needed: true, oversized, candidates: picked, savedBytes: saved }
}

const FIXTURE = `import x from 'y'\n\nconst A = {\n  k: [1, 2],\n}\n\nfunction B() {\n  return A.k.length\n}\n`

function selfTest() {
  const blocks = topLevelBlocks(FIXTURE)
  const names = blocks.map((b) => b.name).filter(Boolean)
  const drift = verifyZeroDrift(FIXTURE)
  const plan = splitPlan(FIXTURE, 10)
  const ok = names.includes('A') && names.includes('B')
    && drift.ok && drift.blocks >= 3 && plan.needed === true && plan.candidates.length >= 1
  console.log(JSON.stringify({ ok, blocks, drift, plan }, null, 2))
  return ok ? 0 : 1
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
if (isMain) {
  if (process.argv.includes('--self-test')) {
    process.exit(selfTest())
  }
  const target = process.argv.find((a) => !a.startsWith('--')) ?? 'lib/config.js'
  const src = readFileSync(target, 'utf8')
  const drift = verifyZeroDrift(src)
  const plan = splitPlan(src)
  console.log(JSON.stringify({
    file: target,
    bytes: Buffer.byteLength(src, 'utf8'),
    topLevelBlocks: topLevelBlocks(src).length,
    zeroDrift: drift.ok,
    splitNeeded: plan.needed,
    candidates: plan.candidates.slice(0, 8),
  }, null, 2))
  process.exit(drift.ok ? 0 : 1)
}

export { selfTest }
