#!/usr/bin/env node
/** 报告 v3 §3/§9/§10：混合模式三段编排（纯编排器，离线可测）。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HYBRID_STAGES, stageProgress, planChunks, runHybrid } from '../lib/hybrid-runner.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }
const okAsync = async (name, fn) => { await fn(); n += 1; console.log('  ✓ ' + name) }

console.log('hybrid-runner 回归')

ok('HYBRID_STAGES：image → tts → video，权重 20/10/70 且和为 1', () => {
  assert.deepEqual(HYBRID_STAGES.map((s) => s.id), ['image', 'tts', 'video'])
  assert.deepEqual(HYBRID_STAGES.map((s) => s.weight), [0.2, 0.1, 0.7])
  assert.ok(Math.abs(HYBRID_STAGES.reduce((a, s) => a + s.weight, 0) - 1) < 1e-9)
})
ok('stageProgress：0.2 / 0.3 / 1.0 三段累计边界', () => {
  assert.equal(stageProgress(0, 0), 0)
  assert.equal(stageProgress(0, 1), 0.2)
  assert.equal(stageProgress(1, 0), 0.2)
  assert.ok(Math.abs(stageProgress(1, 1) - 0.3) < 1e-9)
  assert.ok(Math.abs(stageProgress(2, 0) - 0.3) < 1e-9)
  assert.equal(stageProgress(2, 1), 1)
})
ok('stageProgress：fraction clamp 到 [0,1]、越界 stage 不炸', () => {
  assert.equal(stageProgress(0, -1), 0)
  assert.equal(stageProgress(0, 5), 0.2)
  assert.equal(stageProgress(9, 1), 1)
})
ok('planChunks：81 帧 / 49 每块 / 8 重叠 → 2 段且不丢帧', () => {
  const p = planChunks({ frames: 81, framesPerChunk: 49, overlap: 8 })
  assert.equal(p.chunks, 2)
  assert.equal(p.segments[0].startFrame, 0)
  assert.equal(p.segments[0].frameCount, 49)
  assert.equal(p.segments[1].startFrame, 41)
  assert.equal(p.segments[1].frameCount, 40)
  assert.equal(49 + 40 - 8, 81)
})
ok('planChunks：短片段返回 null（不切块）', () => {
  assert.equal(planChunks({ frames: 25 }), null)
})
ok('planChunks 与 workflow-ast.ChunkPass 同算法（49+40-8=81）', () => {
  const p = planChunks({ frames: 81 })
  const covers = p.segments[p.segments.length - 1].startFrame + p.segments[p.segments.length - 1].frameCount
  assert.equal(covers, 81)
})

await okAsync('runHybrid：三段顺序、outputs 齐全、results 有序', async () => {
  const seen = []
  const r = await runHybrid({
    submitStage: async (stage, ctx) => { seen.push(stage.id); return { id: stage.id, prev: Object.keys(ctx.outputs) } },
  })
  assert.deepEqual(seen, ['image', 'tts', 'video'])
  assert.deepEqual(r.results.map((x) => x.stage), ['image', 'tts', 'video'])
  assert.equal(r.ok, true)
  assert.deepEqual(Object.keys(r.outputs), ['image', 'tts', 'video'])
  assert.deepEqual(r.outputs.video.prev, ['image', 'tts'])
})
await okAsync('runHybrid：onProgress 从 0 走到 1，且带段名', async () => {
  const notes = []
  const r = await runHybrid({
    submitStage: async () => 1,
    onProgress: (pct, note) => notes.push({ pct, note }),
  })
  assert.equal(notes[0].pct, 0)
  assert.equal(notes[notes.length - 1].pct, 1)
  assert.ok(notes.some((x) => x.note.includes('配音')))
  assert.equal(r.chunkPlan, null)
})
await okAsync('runHybrid：段间显式卸载 = 段数-1 次，最后一段不卸', async () => {
  const unloaded = []
  await runHybrid({ submitStage: async () => 1, unload: async (id) => { unloaded.push(id) } })
  assert.deepEqual(unloaded, ['image', 'tts'])
})
await okAsync('runHybrid：unload 失败只记不抛（不影响下一段）', async () => {
  const notes = []
  const r = await runHybrid({
    submitStage: async () => 1,
    unload: async () => { throw new Error('free 失败') },
    onProgress: (_p, note) => notes.push(note),
  })
  assert.equal(r.ok, true)
  assert.ok(notes.some((x) => x.includes('卸载未生效')))
})
await okAsync('runHybrid：缺 submitStage 直接抛', async () => {
  await assert.rejects(() => runHybrid({}), /缺少 submitStage/)
})
await okAsync('runHybrid：错误带段名，不吞异常', async () => {
  await assert.rejects(() => runHybrid({
    submitStage: async (stage) => { if (stage.id === 'tts') throw new Error('没权重'); return 1 },
  }), /混合模式 配音段失败：没权重/)
})
await okAsync('runHybrid：signal.aborted 在段边界取消', async () => {
  let calls = 0
  const controller = new AbortController()
  await assert.rejects(() => runHybrid({
    signal: controller.signal,
    submitStage: async (stage) => { calls += 1; if (stage.id === 'image') controller.abort(); return 1 },
  }), /已取消/)
  assert.equal(calls, 1)
})
await okAsync('runHybrid：chunkPlan 透传给 submitStage 的 ctx', async () => {
  let got = null
  await runHybrid({
    frames: 81, framesPerChunk: 49, overlap: 8,
    submitStage: async (_s, ctx) => { got = ctx.chunkPlan; return 1 },
  })
  assert.equal(got.chunks, 2)
})

ok('★ index.js 注册了 generate_hybrid 且真的调 runHybrid', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes("name: 'generate_hybrid'"))
  assert.ok(s.includes("step('register.generate_hybrid'"))
  assert.ok(s.includes('await runHybrid({'))
})
ok('★ index.js 混合模式的缺件闸门：probeTts 不 available 就抛 reason', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes('if (!probe.available) throw new Error(probe.reason)'))
  assert.ok(s.includes('buildTtsWorkflow(caps'))
  assert.ok(s.includes('waitForAudio('))
})
ok('★ index.js 段间卸载走 /free，且分段提交每段一个 prompt_id', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes('unload_models: true'))
  assert.ok(s.includes('submitVideoSegments'))
  assert.ok(s.includes('jobId: pid'))
})

console.log(`\n✓ 全部通过（${n} 项）`)
