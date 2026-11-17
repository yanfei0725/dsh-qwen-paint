#!/usr/bin/env node
/**
 * slim-comments.mjs —— 把 lib 大文件的**长设计注释**外置到 docs，
 * 源码只留一行锚点，根治“单文件 256 KiB 上限 / lib 合计 2 MiB 红线”被注释挤爆的问题。
 *
 * 为什么需要它：
 *   实测 index.js 4,886 行里 1,399 行（116 KB，45%）是注释。历史靠手工搬，
 *   搬完又写新注释，于是反复撞线。本脚本把“外置”变成可重复、可验证的动作：
 *     ① 字符串状态机精确识别“整行注释”，绝不把字符串里的 // 误判成注释；
 *     ② 保留含功能语义/测试依赖的注释（KEEP_PATTERNS），只搬纯设计论证；
 *     ③ 逐字零漂移自检——把锚点换回原文必须与改前完全一致，否则拒绝落盘。
 *
 * 用法：
 *   node scripts/slim-comments.mjs                        # 只读报告 lib/index.js（CI/npm test 里跑这个）
 *   node scripts/slim-comments.mjs --file=lib/client.js   # 只读报告其他目标（可重复传多个 --file）
 *   node scripts/slim-comments.mjs --plan                 # 预览将外置哪些块（输出行号与字节）
 *   node scripts/slim-comments.mjs --apply                # 真正外置（人工执行，不在测试里）
 *
 * ⚠ --apply 只在需减压时手工跑；跑完必须跟着跑全量回归。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TARGET = 'lib/index.js'
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
  /stable-diffusion\.cpp|general\.architecture/u, // ★ _review_fixes_test.mjs 依赖（删档位理由，2026-11-17 外置误伤教训）
  /绝不改动上面的门槛判定/u,     // ★ test-igpu-profiles.mjs 依赖（同上教训）
  /2026-11-17 审计/u,            // ★ 审计留痕注释不外置：行为边界/信任边界说明必须就地可见
])

/** 精确识别「整行都是注释」的行（0-based）：状态机排除字符串/正则里的注释记号。
 * 2026-11-17 修复：不识别正则字面量会让 quote 卡死（正则里的引号被当字符串开头），
 * 之后整个文件的块注释记号全被误判成代码——在 config.js 上真实炸过：JSDoc 的开块行
 * 被排除在注释块外、闭块行却靠 isContinuation 进了块，外置后留下孤立开块记号直接语法错误。
 */
export function commentOnlyLines(lines) {
  const out = new Set()
  let quote = ''
  let inBlock = false
  // 正则字面量识别：/ 前一个有效字符是标识符/数字/)/] 之外 → 正则开始。
  // return/typeof/case 等关键字后也是正则（prevWord 兜住）。
  const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '%', '~', '^', '(', '\n'])
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'do', 'else', 'void', 'delete', 'new', 'yield', 'await'])
  const isWordChar = (c) => /[A-Za-z0-9_$]/u.test(c)
  let prevSig = '\n'          // 上一行最后一个有意义的字符（跨行维护）
  let prevWord = ''           // 行内累积的词（行尾清断：被非词字符打断）
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    let j = 0
    let sawCode = false
    let sawComment = false
    let inClass = false       // 正则字符类 [...] 里
    let inRegex = false
    while (j < line.length) {
      const c = line[j]
      const next = line[j + 1]
      if (inBlock) {
        sawComment = true
        if (c === '*' && next === '/') { inBlock = false; j += 2; prevSig = '/'; prevWord = ''; continue }
        j += 1; continue
      }
      if (inRegex) {
        sawCode = true
        if (c === '\\') { j += 2; continue }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) { inRegex = false; j += 1; prevSig = '/'; prevWord = ''; continue }
        j += 1; continue
      }
      if (quote !== '') {
        if (c === '\\') { j += 2; continue }
        if (c === quote) quote = ''
        sawCode = true
        j += 1; continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; sawCode = true; prevSig = c; prevWord = ''; j += 1; continue }
      if (c === '/' && next === '/') { sawComment = true; break }
      if (c === '/' && next === '*') { inBlock = true; sawComment = true; j += 2; continue }
      if (c === '/') {
        const regexStart = REGEX_PRECEDERS.has(prevSig) || REGEX_KEYWORDS.has(prevWord) || prevWord === ''
        if (regexStart) { inRegex = true; sawCode = true; j += 1; continue }
        sawCode = true; prevSig = '/'; prevWord = ''; j += 1; continue
      }
      if (!/\s/u.test(c)) { sawCode = true; prevSig = c; prevWord = isWordChar(c) ? prevWord + c : '' }
      j += 1
    }
    if (inRegex) { inRegex = false; prevSig = '/'; prevWord = '' }  // 正则不允许跨行；行尾未闭合按保守收尾
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

/** 目标文件 → 锚点前缀 / 外置文档路径。默认 lib/index.js，行为与历史版本逐字一致。 */
export function targetOpts(file = DEFAULT_TARGET) {
  const name = path.basename(file, '.js')
  return {
    fileLabel: file,
    anchorPrefix: name + '-note',
    docPath: 'docs/' + name + '-design-notes.md',
  }
}

/** 生成外置计划：可被外置的块 + 替换后的全文 + 逐字可逆验证。 */
export function buildPlan(src, minBytes = MIN_BYTES, opts = targetOpts()) {
  const { fileLabel, anchorPrefix, docPath, startNumber = 1 } = opts
  const lines = src.split('\n')
  const blocks = commentBlocks(lines)
  const picked = blocks.filter((b) =>
    b.bytes >= minBytes && !KEEP_PATTERNS.some((re) => re.test(b.text))
    // JSDoc 边界不变式：块注释必须整块进出——半开的 /*/** 或半闭的 */ 都说明状态机
    // 切在了块注释中间，外置会留下孤立记号直接语法错误。两种半块都绝不外置。
    && !(/\/\*\*?$/u.test(b.text.split('\n')[0]) ? !b.text.trimEnd().endsWith('*/')
         : b.text.trimEnd().endsWith('*/') && !/^\s*(\/\*\*?|\/\/)/u.test(b.text.split('\n')[0])))
  let docText = '\n\n---\n\n<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->\n'
  const markers = []
  for (let k = 0; k < picked.length; k += 1) {
    const b = picked[k]
    const anchor = anchorPrefix + '-' + String(startNumber + k).padStart(3, '0')
    const originalLines = 'L' + (b.start + 1) + '-' + b.end
    docText += '\n### ' + anchor + '（原 ' + fileLabel + ' ' + originalLines + '）\n\n```js\n' + b.text + '\n```\n'
    const marker = '// 设计说明已外置 → ' + docPath + '#' + anchor + '（原 ' + originalLines + '）'
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

/** 目标文件已用掉的最大锚点编号（源码 + 外置文档里都数）——新一轮必须接续，绝不能重号。 */
export function nextAnchorNumber(file, opts = targetOpts(file)) {
  const abs = path.join(ROOT, file)
  const docAbs = path.join(ROOT, opts.docPath)
  const re = new RegExp(opts.anchorPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d{3,})', 'gu')
  let max = 0
  for (const text of [fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '',
                      fs.existsSync(docAbs) ? fs.readFileSync(docAbs, 'utf8') : '']) {
    for (const m of text.matchAll(re)) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** 语法硬闸：替换后的全文必须先过 node --check 才允许落盘（第 0 行 import os/spawnSync 已加）。
 *  防御目标：状态机任何残余误判，在写盘前被 node 自己抓住——语法坏了宁可不出手。
 */
function syntaxGate(absPath, outText) {
  const tmp = path.join(os.tmpdir(), 'slim-gate-' + path.basename(absPath) + '.mjs')
  fs.writeFileSync(tmp, Buffer.from(outText, 'utf8'))
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
    if (r.status !== 0) return r.stderr || 'node --check 非零退出'
    return null
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响结论 */ }
  }
}

function processTarget(file, { apply }) {
  const abs = path.join(ROOT, file)
  const opts = targetOpts(file)
  const src = fs.readFileSync(abs, 'utf8')
  const plan = buildPlan(src, MIN_BYTES, { ...opts, startNumber: nextAnchorNumber(file, opts) })
  const bytes = Buffer.byteLength(src, 'utf8')
  const free = LIMIT_FILE - bytes
  console.log(file + ' = ' + bytes + ' B / 单文件余量 ' + free + ' B')
  console.log('注释块 ' + plan.blocks.length + ' 个 / ' + plan.blocks.reduce((n, b) => n + b.bytes, 0) + ' B')
  console.log('可外置 ' + plan.picked.length + ' 块 / 可省 ' + plan.savedBytes + ' B')
  if (!plan.ok) { console.error('✗ 零漂移自检失败：' + plan.reason); process.exitCode = 1; return }
  console.log('✓ 零漂移自检通过（逐字可逆）')
  if (plan.picked.length === 0) { console.log('（无可外置块，跳过落盘）'); return }
  if (process.argv.includes('--plan')) {
    for (const m of plan.markers) console.log('  ' + m.marker)
  }
  if (apply) {
    const gateErr = syntaxGate(abs, plan.out)
    if (gateErr) {
      console.error('✗ 语法硬闸拦截（外置后 node --check 不通过），未落盘：' + file)
      console.error(String(gateErr).split('\n').slice(0, 6).join('\n'))
      process.exitCode = 1
      return
    }
    const docAbs = path.join(ROOT, opts.docPath)
    let docHeader = ''
    if (!fs.existsSync(docAbs)) {
      docHeader = '# ' + file + ' 设计说明（长注释外置自源码）\n\n> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。\n'
    }
    fs.writeFileSync(abs, Buffer.from(plan.out, 'utf8'))
    fs.appendFileSync(docAbs, Buffer.from(docHeader + plan.docText, 'utf8'))
    const now = fs.statSync(abs).size
    console.log('✓ 已落盘：' + file + ' ' + bytes + ' → ' + now + ' B')
    console.log('✓ 设计说明 → ' + opts.docPath + '（' + fs.statSync(docAbs).size + ' B）；请立刻跑全量回归')
  }
}

function main() {
  const apply = process.argv.includes('--apply')
  const files = process.argv.filter((a) => a.startsWith('--file=')).map((a) => a.slice('--file='.length))
  if (files.length === 0) files.push(DEFAULT_TARGET)
  for (const f of files) {
    if (!apply) console.log('')
    processTarget(f, { apply })
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
