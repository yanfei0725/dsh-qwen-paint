#!/usr/bin/env node
/**
 * graph-audit pruneGraph 直测（2026-11-20 零触及复扫·价值最高项：可达性裁剪，
 *   lib 内零接线孤儿导出——test-contract-asr-eta 只覆盖同文件其它函数）。
 *
 * 切片：无输出守护 / 孤儿剔除 / mutate:false 不改原图 / mutate:true 原地删 /
 *   outputs 白名单透传 / 连线可达性（反向走 isLink）。
 *
 * 纯离线。
 */
import { pruneGraph } from '../lib/graph-audit.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const mkGraph = () => ({
  '1': { class_type: 'CheckpointLoader', inputs: {} },
  '2': { class_type: 'UNETLoader', inputs: {} },
  '3': { class_type: 'KSampler', inputs: { model: ['1', 0], latent: ['5', 0] } },
  '4': { class_type: 'LoraLoader', inputs: { model: ['2', 0] } },
  '5': { class_type: 'EmptyLatent', inputs: {} },
  '6': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
})

console.log('— 无输出守护')
{
  const g = mkGraph()
  delete g['6']
  const r = pruneGraph(g)
  ok('★ 无输出节点 → 原图原样返回（裁完就空=删用户的图，绝不干）',
    r.graph === g && r.removed.length === 0 && r.kept.length === 5 && r.outputs.length === 0,
    JSON.stringify({ removed: r.removed.length, kept: r.kept.length }))
}

console.log('— 孤儿剔除（mutate:false）')
{
  const g = mkGraph()
  const r = pruneGraph(g)
  ok('★ 孤儿 2/4（输出反向不可达）被剔除，1/3/5/6 保留',
    eq(r.removed, ['2', '4']) && r.kept.length === 4
    && r.graph['1'] && r.graph['3'] && r.graph['5'] && r.graph['6']
    && !r.graph['2'] && !r.graph['4'],
    JSON.stringify({ removed: r.removed, kept: r.kept }))
  ok('★ mutate:false 不改原图（原图 2/4 还在）', g['2'] !== undefined && g['4'] !== undefined)
  ok('★ orphanedOutputs:false（输出链完整）', r.orphanedOutputs === false)
}

console.log('— mutate:true 原地删')
{
  const g = mkGraph()
  const r = pruneGraph(g, { mutate: true })
  ok('★ mutate:true → 原图被就地删掉孤儿（返回 graph===原图）',
    r.graph === g && g['2'] === undefined && g['4'] === undefined && g['6'] !== undefined,
    JSON.stringify(Object.keys(g)))
}

console.log('— outputs 白名单透传')
{
  const g = mkGraph()
  const r = pruneGraph(g, { outputs: ['LoraLoader'] })
  ok("★ outputs 覆盖白名单 → 以 4 为输出反向可达（2/4 保留，1/3/5/6 成孤儿）",
    r.removed.length === 4 && r.graph['2'] && r.graph['4'] && !r.graph['6'],
    JSON.stringify({ removed: r.removed }))
  ok('字面量字符串/数字 slot 不是连线（isLink 语义）——不被当上游走',
    (() => { const g2 = { '9': { class_type: 'SaveImage', inputs: { note: '["1",0]字面量串' } } }
      const r2 = pruneGraph(g2)
      return r2.removed.length === 0 && r2.kept.length === 1 })())
}

function eq(a, e) { return JSON.stringify(a) === JSON.stringify(e) }
console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
