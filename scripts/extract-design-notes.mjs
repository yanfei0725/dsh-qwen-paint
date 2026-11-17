#!/usr/bin/env node
/**
 * extract-design-notes.mjs —— 一次性把 schema-defaults.js 里几段纯设计注释外置到 docs。
 *
 * 动机：lib/ 合计贴着 2097152 B 硬红线，容错仅几十 KB。1.0.0 已对 index/client 做过
 * 注释外置；本脚本对 schema-defaults.js 如法炮制，把**纯设计论证**搬到文档，源码留锚点。
 * 只挑不含本机实测数据 / 硬件型号 / 测试依赖字面量的块（见 TARGETS 首行特征）。
 *
 * 安全：
 *   · 默认只读预览；--apply 才落盘；
 *   · 逐字可逆自检：把锚点换回原文必须字节级等于改前，否则拒绝写；
 *   · 只动注释块，绝不碰任何代码行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'lib/schema-defaults.js')
const DOC = path.join(ROOT, 'docs/schema-design-notes.md')
const APPLY = process.argv.includes('--apply')

// 用注释块首行特征定位，避免行号漂移。均经人工确认：纯设计说明、无本机实测数据。
// ★ 幂等：已外置的锚点直接跳过，所以可以多次追加新 TARGET 后重跑。
const TARGETS = [
  { key: 'anchor-1', first: '★★★ 2026-10-12 新增：**macOS / MPS 的两个专属开关**' },
  { key: 'anchor-2', first: '★★★ 2026-10-12 新增（来自用户反馈）：**VAE 大图分块解码**' },
  { key: 'anchor-3', first: '★★★ 2026-10-14（C1「专业卡版」）：**显存 / 内存档位**' },
  { key: 'anchor-4', first: '★★★ 2026-10-15（DSH STORE 合规整改 · Issue #1390）' },
  { key: 'anchor-5', first: '★★★ 2026-10-09：**插件总开关**' },
  { key: 'anchor-6', first: '★★★ 2026-10-13（用户反馈）：**生成后自动放大**' },
  { key: 'anchor-7', first: '★★★ 2026-10-09 **尺寸锁默认关闭**' },
  { key: 'anchor-8', first: '★★★ 2026-10-14（C5「专业卡版」）：**文本控制档**' },
  { key: 'anchor-9', first: '★★★ 2026-10-11 新增：**A 卡专属优化' },
  { key: 'anchor-10', first: '★★★ 2026-10-11 新增：**N 卡 SageAttention' },
]

const src = fs.readFileSync(SRC, 'utf8')
const blocks = [...src.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({
  index: m.index, text: m[0], bytes: Buffer.byteLength(m[0]),
}))

const picked = []
for (const t of TARGETS) {
  const anchor = `  // 设计说明已外置 → docs/schema-design-notes.md#${t.key}\n`
  if (src.includes(anchor)) continue // 上一轮已搬走，跳过（保证脚本可重复运行）
  const hit = blocks.find((b) => b.text.includes(t.first))
  if (!hit) { console.error('找不到注释块：' + t.first); process.exit(1) }
  if (hit.text.includes('本机实测') || /RX\s*7900|7900\s*XT|\d+\.\d+\s*s\b/u.test(hit.text)) {
    console.error('目标块含本机实测数据，拒绝外置：' + t.first); process.exit(1)
  }
  picked.push({ ...t, ...hit })
}
picked.sort((a, b) => a.index - b.index)

const freedBytes = picked.reduce((n, b) => n + b.bytes, 0)
const anchorBytes = picked.reduce((n, b) =>
  n + Buffer.byteLength(`  // 设计说明已外置 → docs/schema-design-notes.md#${b.key}\n`), 0)
console.log(`目标 ${picked.length} 块 / 原文 ${freedBytes} B / 锚点 ${anchorBytes} B / 净腾出 ${freedBytes - anchorBytes} B`)
picked.forEach((b) => console.log('  ', b.key, b.bytes + ' B', b.first.slice(0, 40)))

if (!APPLY) { console.log('\n（只读预览；加 --apply 才落盘）'); process.exit(0) }

// 从后往前替换，避免 offset 漂移。
let out = src
for (const b of [...picked].reverse()) {
  // 切片必须用字符长度 text.length（JS 字符串索引），不能用 bytes（UTF-8 字节数，中文会切过头）。
  out = out.slice(0, b.index) + `  // 设计说明已外置 → docs/schema-design-notes.md#${b.key}\n` + out.slice(b.index + b.text.length)
}

// 逐字可逆自检：把每个锚点换回原文，必须字节级等于改前。
let restored = out
for (const b of picked) {
  const anchor = `  // 设计说明已外置 → docs/schema-design-notes.md#${b.key}\n`
  if (!restored.includes(anchor)) { console.error('自检失败：锚点缺失 ' + b.key); process.exit(1) }
  // 必须用函数式 replacement：字符串形式会把 b.text 里的 $& / $' 当特殊替换序列，导致还原失真。
  restored = restored.replace(anchor, () => b.text)
}
if (restored !== src) { console.error('自检失败：逐字还原后与原文不一致，拒绝落盘'); process.exit(1) }

// 写文档（追加式，幂等：已有同名锚点章节则跳过）。
let doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '# schema-defaults.js 设计说明（外置）\n\n'
for (const b of picked) {
  if (doc.includes(`<a id="${b.key}"></a>`)) continue
  doc += `\n<a id="${b.key}"></a>\n\n${b.text}\n`
}
fs.writeFileSync(DOC, doc, 'utf8')
fs.writeFileSync(SRC, out, 'utf8')
console.log(`\n✓ 已外置 ${picked.length} 块到 docs/schema-design-notes.md；逐字可逆自检通过；净腾出 ${freedBytes - anchorBytes} B`)
