#!/usr/bin/env node
/**
 * test-slim-comments.mjs —— 注释外置减压工具的回归。
 * 全离线：只用内存夹具 + 只读真实文件，不写盘、不联网、不派生子进程。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KEEP_PATTERNS, commentOnlyLines, commentBlocks, buildPlan, targetOpts, nextAnchorNumber } from './slim-comments.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

console.log('slim-comments（源码注释外置减压）回归')

ok('commentOnlyLines 不把字符串里的 // 误判为注释', () => {
  const lines = [
    "const url = 'https://example.com/a'",
    '// 真注释',
    'const re = /\\/\\//u',
    '/* 块注释开始',
    ' * 续行',
    ' */',
    'const x = 1 // 行尾注释不是整行注释',
  ]
  const marks = commentOnlyLines(lines)
  assert.equal(marks.has(0), false)
  assert.equal(marks.has(1), true)
  assert.equal(marks.has(2), false)
  assert.equal(marks.has(3), true)
  assert.equal(marks.has(4), true)
  assert.equal(marks.has(5), true)
  assert.equal(marks.has(6), false)
})

ok('commentBlocks 把连续注释合成一块，行号闭区间', () => {
  const bs = commentBlocks(['// a', '// b', 'const x = 1', '', '// c'])
  assert.equal(bs.length, 2)
  assert.deepEqual([bs[0].start, bs[0].end], [0, 2])
  assert.deepEqual([bs[1].start, bs[1].end], [4, 5])
  assert.ok(bs[0].bytes > 0)
})

ok('buildPlan 对无长注释源码零改动、零漂移', () => {
  const s = 'const x = 1\n// 短注释\nconst y = 2\n'
  const p = buildPlan(s)
  assert.equal(p.ok, true)
  assert.equal(p.picked.length, 0)
  assert.equal(p.out, s)
  assert.equal(p.savedBytes, 0)
})

ok('buildPlan 外置长注释后逐字可逆（把锚点换回原文完全一致）', () => {
  const long = Array.from({ length: 20 }, (_, i) => ' * 设计论证第 ' + i + ' 行说明').join('\n')
  const s = 'export const x = 1\n\n/**\n' + long + '\n */\n\nconst y = 2\n'
  const p = buildPlan(s)
  assert.equal(p.ok, true)
  assert.ok(p.picked.length >= 1)
  assert.ok(p.savedBytes > 0)
  assert.ok(p.out.includes('设计说明已外置 → docs/index-design-notes.md#'))
  assert.ok(p.out.includes('export const x = 1'))
  assert.ok(p.out.includes('const y = 2'))
  assert.ok(p.docText.includes('index-note-001'))
})

ok('★ KEEP_PATTERNS 里的语义注释绝不外置', () => {
  const semantic = '// 客户端插件看不到用户消息，动画起点由模型决定'
  const filler = Array.from({ length: 20 }, (_, i) => '// 纯设计漫谈第 ' + i + ' 行').join('\n')
  const s = semantic + '\nconst separator = 0\n' + filler + '\nconst x = 1\n'
  const p = buildPlan(s)
  assert.equal(p.ok, true)
  assert.ok(p.picked.length >= 1)
  assert.equal(p.out.includes('看不到用户消息'), true)
  assert.equal(p.out.includes('纯设计漫谈'), false)
  assert.equal(KEEP_PATTERNS.some((re) => re.test(semantic)), true)
})

ok('★ 真实 index.js 已减压到红线内且锚点齐全', () => {
  const real = src('lib/index.js')
  const bytes = Buffer.byteLength(real, 'utf8')
  assert.ok(bytes <= 262144, 'index.js 超红线: ' + bytes)
  assert.ok(real.includes('设计说明已外置'), '应有外置锚点')
  const doc = src('docs/index-design-notes.md')
  const anchors = [...real.matchAll(/index-note-\d+/gu)].map((m) => m[0])
  assert.ok(anchors.length >= 50, '锚点数不足: ' + anchors.length)
  for (const a of new Set(anchors)) assert.ok(doc.includes('### ' + a), '文档缺少锚点 ' + a)
})

ok('★ 真实 index.js 再做 buildPlan 不应还有可外置块（幂等）', () => {
  const p = buildPlan(src('lib/index.js'))
  assert.equal(p.ok, true)
  assert.equal(p.picked.length, 0, '仍有可外置块，说明上次减压没做完')
})

ok('★ 语义注释仍在真实源码中（防止减压误删功能注释）', () => {
  const real = src('lib/index.js')
  for (const needle of ['看不到用户消息']) {
    assert.ok(real.includes(needle), '真实源码缺少语义注释: ' + needle)
  }
})

ok('★ --file 泛化：opts 指向 client.js 时锚点/文档路径同步切换', () => {
  const long = Array.from({ length: 20 }, (_, i) => ' * 纯设计论证第 ' + i + ' 行说明').join('\n')
  const s = 'export const a = 1\n\n/**\n' + long + '\n */\n\nconst b = 2\n'
  const p = buildPlan(s, 400, targetOpts('lib/client.js'))
  assert.equal(p.ok, true)
  assert.ok(p.savedBytes > 0)
  assert.ok(p.out.includes('设计说明已外置 → docs/client-design-notes.md#client-note-001'))
  assert.ok(p.docText.includes('client-note-001'))
  assert.ok(p.docText.includes('原 lib/client.js L'))
})

ok('★ 默认 opts 与历史行为逐字一致（index 锚点/文档路径不变）', () => {
  const long = Array.from({ length: 20 }, (_, i) => ' * 纯设计论证第 ' + i + ' 行说明').join('\n')
  const s = 'export const a = 1\n\n/**\n' + long + '\n */\n\nconst b = 2\n'
  const p = buildPlan(s)
  assert.ok(p.out.includes('设计说明已外置 → docs/index-design-notes.md#index-note-001'))
  assert.ok(p.docText.includes('index-note-001'))
})

ok('★ 锚点编号接续：真实 client.js 新块从已有最大号+1 开始（不重号）', () => {
  const next = nextAnchorNumber('lib/client.js')
  const doc = src('docs/client-design-notes.md')
  const used = [...doc.matchAll(/client-note-(\d{3,})/gu)].map((m) => Number(m[1]))
  assert.ok(used.length >= 20, '已有锚点应至少 20 个: ' + used.length)
  assert.equal(next, Math.max(...used) + 1, '接续号必须是文档最大号+1')
})

ok('★ 真实 client.js / config.js 已减压到无可外置块（幂等）', () => {
  for (const f of ['lib/client.js', 'lib/config.js']) {
    const p = buildPlan(src(f), 400, targetOpts(f))
    assert.equal(p.ok, true, f + ' 零漂移自检失败')
    assert.equal(p.picked.length, 0, f + ' 仍有可外置块，说明上次减压没做完')
  }
})

ok('★ 正则字面量不弄瞎状态机（config.js 事故复现）：/** 照常识别', () => {
  const s = "const re = /[\"']/\n/**\n * 设计论证一行又一行\n */\nconst x = 1\n"
  const marks = commentOnlyLines(s.split('\n'))
  assert.equal(marks.has(1), true, '/** 应识别为注释行（正则里的引号不得卡死状态机）')
  assert.equal(marks.has(2), true)
  assert.equal(marks.has(3), true)
  const p = buildPlan(s)
  assert.equal(p.ok, true)
  assert.equal(p.picked.length, 0, '短 JSDoc 不外置，更不许半块外置')
})

ok('★ 长 JSDoc 紧跟正则字面量：整块（含 /** 与 */）外置，不留孤立记号', () => {
  const long = Array.from({ length: 20 }, (_, i) => ' * 设计论证第 ' + i + ' 行说明').join('\n')
  const s = "const re = /[\"']/\n/**\n" + long + '\n */\nconst y = 2\n'
  const p = buildPlan(s)
  assert.equal(p.ok, true)
  assert.equal(p.picked.length, 1, '正则后的完整 JSDoc 应合成一块')
  assert.ok(p.picked[0].text.startsWith('/**'), '块必须以 /** 开头')
  assert.ok(p.picked[0].text.trimEnd().endsWith('*/'), '块必须以 */ 收尾')
})

console.log('\n全部通过 ✓ (' + n + ' 项)')
