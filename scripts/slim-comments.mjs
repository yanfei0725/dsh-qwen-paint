#!/usr/bin/env node
/**
 * slim-comments.mjs —— 把 lib/index.js 的**长设计注释**外置到 docs，
 * 源码只留一行锚点，根治“单文件 256 KiB 上限”被注释挤爆的问题。
 *
 * 为什么需要它：
 *   实测 index.js 4,886 行里 1,399 行（116 KB，45%）是注释。历史靠手工搬，
 *   搬完又写新注释，于是反复撞线。本脚本把“外置”变成可重复、可验证的动作：
 *     ① 字符串状态机精确识别“整行注释”，绝不把字符串里的 // 误判成注释；
 *     ② 保留含功能语义/测试依赖的注释（KEEP_PATTERNS），只搬纯设计论证；
 *     ③ 逐字零漂移自检——把锚点换回原文必须与改前完全一致，否则拒绝落盘。
 *
 * 用法：
 *   node scripts/slim-comments.mjs           # 只读报告（在 CI/npm test 里跑这个）
 *   node scripts/slim-comments.mjs --plan    # 预览将外置哪些块（输出行号与字节）
 *   node scripts/slim-comments.mjs --apply   # 真正外置（人工执行，不在测试里）
 *
 * ⚠ --apply 只在需减压时手工跑；跑完必须跟着跑全量回归。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDX = path.join(ROOT, 'lib/index.js')
const DOC = path.join(ROOT, 'docs/index-design-notes.md')
const LIMIT_FILE = 262144
const MIN_BYTES = 400

/** 含功能语义或被测试字面量依赖的注释——绝不外置。改这里必须同步 test-slim-comments.mjs。 */
export const KEEP_PATTERNS = Object.freeze([
  /index-design-notes\.md/u,   // 文件头索引说明
  /防横向溢出|横向溢出/u,
  /GUARD_MARK/u,
  /SPDX|Copyright|License/u,
  /eslint|@ts-/u,
  /__internal|__dshqp/u,
  /看不到用户消息/u,           // selftest.mjs 依赖此字面量
  /用这张图做参考画/u,         // selftest.mjs 依赖此字面量
])

/** 精确识别「整行都是注释」的行（0-based）：状态机排除字符串里的 // 与 /*。 */
export function commentOnlyLines(lines) {
  const out = new Set()
  let quote = ''
  let inBlock = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    let j = 0
    let sawCode = false
    let sawComment = false
    while (j < line.length) {
      const c = line[j]
      const next = line[j + 1]
      if (inBlock) {
        sawComment = true
        if (c === '*' && next === '/') { inBlock = false; j += 2; continue }
        j += 1; continue
      }
      if (quote !== '') {
        if (c === '\\') { j += 2; continue }
        if (c === quote) quote = ''
        sawCode = true
        j += 1; continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; sawCode = true; j += 1; continue }
      if (c === '/' && next === '/') { sawComment = true; break }
      if (c === '/' && next === '*') { inBlock = true; sawComment = true; j += 2; continue }
      if (!/\s/u.test(c)) sawCode = true
      j += 1
    }
    const trimmed = line.trim()
    const isContinuation = !inBlock && (trimmed.startsWith('*') || trimmed === '*/')
    if ((sawComment && !sawCode) || isContinuation) out.add(i)
  }
  return out
}

/** 连续注释块。 */
export function commentBlocks(lines) {
  const marks = commentOnlyLines(lines)
  const blocks = []
  let i = 0
  while (i < lines.length) {
    if (marks.has(i)) {
      const start = i
      while (i < lines.length && marks.has(i)) i += 1
      const text = lines.slice(start, i).join('\n')
      blocks.push({ start, end: i, text, bytes: Buffer.byteLength(text, 'utf8') + 1 })
    } else i += 1
  }
  return blocks
}

/** 生成外置计划：可被外置的块 + 替换后的全文 + 逐字可逆验证。 */
export function buildPlan(src, minBytes = MIN_BYTES) {
  const lines = src.split('\n')
  const blocks = commentBlocks(lines)
  const picked = blocks.filter((b) =>
    b.bytes >= minBytes && !KEEP_PATTERNS.some((re) => re.test(b.text)))
  let docText = '\n\n---\n\n<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->\n'
  const markers = []
  for (let k = 0; k < picked.length; k += 1) {
    const b = picked[k]
    const anchor = 'index-note-' + String(k + 1).padStart(3, '0')
    const originalLines = 'L' + (b.start + 1) + '-' + b.end
    docText += '\n### ' + anchor + '（原 lib/index.js ' + originalLines + '）\n\n```js\n' + b.text + '\n```\n'
    const marker = '// 设计说明已外置 → docs/index-design-notes.md#' + anchor + '（原 ' + originalLines + '）'
    markers.push({ ...b, anchor, marker })
  }
  const outLines = [...lines]
  for (const m of markers.slice().reverse()) outLines.splice(m.start, m.end - m.start, m.marker)
  const out = outLines.join('\n')
  let restored = out
  for (const m of markers) {
    if (!restored.includes(m.marker)) return { ok: false, reason: 'marker 缺失: ' + m.marker, blocks, picked, markers }
    restored = restored.replace(m.marker, m.text)
  }
  if (restored !== src) return { ok: false, reason: '逐字重组与原文不一致', blocks, picked, markers }
  return {
    ok: true, blocks, picked, markers, out, docText,
    savedBytes: Buffer.byteLength(src, 'utf8') - Buffer.byteLength(out, 'utf8'),
  }
}

function main() {
  const src = fs.readFileSync(IDX, 'utf8')
  const plan = buildPlan(src)
  const bytes = Buffer.byteLength(src, 'utf8')
  const free = LIMIT_FILE - bytes
  console.log('index.js = ' + bytes + ' B / 余量 ' + free + ' B')
  console.log('注释块 ' + plan.blocks.length + ' 个 / ' + plan.blocks.reduce((n, b) => n + b.bytes, 0) + ' B')
  console.log('可外置 ' + plan.picked.length + ' 块 / 可省 ' + plan.savedBytes + ' B')
  if (!plan.ok) { console.error('✗ 零漂移自检失败：' + plan.reason); process.exitCode = 1; return }
  console.log('✓ 零漂移自检通过（逐字可逆）')
  if (process.argv.includes('--plan')) {
    for (const m of plan.markers) console.log('  ' + m.marker)
  }
  if (process.argv.includes('--apply')) {
    fs.writeFileSync(IDX, Buffer.from(plan.out, 'utf8'))
    fs.appendFileSync(DOC, Buffer.from(plan.docText, 'utf8'))
    const now = fs.statSync(IDX).size
    console.log('✓ 已落盘：index.js ' + bytes + ' → ' + now + ' B；余量 ' + (LIMIT_FILE - now) + ' B')
    console.log('✓ 设计说明 → ' + fs.statSync(DOC).size + ' B；请立刻跑全量回归')
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
