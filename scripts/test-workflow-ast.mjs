#!/usr/bin/env node
/**
 * 报告 v3 §14.3「B 线」+ comfy-catalog 接线回归。
 * 离线可跑：全是纯函数 / 内存对象，不连 ComfyUI。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseWorkflow, emitWorkflow, validateAgainstObjectInfo, diffWorkflow,
  SlotBindPass, ModelMapPass, LoraPass, ChunkPass, AccelPass, PASSES, runAstPipeline,
  LITERAL_SLOTS,
} from '../lib/workflow-ast.js'
import {
  finalizeWorkflow, slotsForWorkflow, readSlotsCatalog, catalogForTts,
  loadObjectInfo, resetCatalogCache, modelLoadersForWorkflow,
} from '../lib/comfy-catalog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }
const okAsync = async (name, fn) => { await fn(); n += 1; console.log('  ✓ ' + name) }

const RAW = {
  1: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['0', 0] } },
  2: { class_type: 'KSampler', inputs: { seed: 7, steps: 8, cfg: 1.0, denoise: 1, model: ['0', 0] } },
}
const OBJECT_INFO = {
  CLIPTextEncode: { input: { required: { text: ['STRING', {}], clip: ['CLIP', {}] } } },
  KSampler: { input: { required: { seed: ['INT', {}], steps: ['INT', {}], cfg: ['FLOAT', {}], denoise: ['FLOAT', {}], model: ['MODEL', {}] } } },
}

console.log('workflow-ast / comfy-catalog 回归')

/* ---------- parse / emit ---------- */
ok('parseWorkflow 只收 class_type 为字符串的节点，忽略 null / 杂项', () => {
  const ast = parseWorkflow({ ...RAW, 3: null, 4: 'x', 5: { inputs: {} } })
  assert.equal(ast.nodes.size, 2)
  assert.deepEqual(ast.order, ['1', '2'])
})
ok('emitWorkflow 与原文 deep-equal（不归一化、不剔 client_id / filename_prefix）', () => {
  const raw = { 1: { class_type: 'SaveImage', inputs: { filename_prefix: 'p', images: ['2', 0] } } }
  assert.deepEqual(emitWorkflow(parseWorkflow(raw)), raw)
})
ok('emitWorkflow 保留 _meta（ComfyUI 缓存键相关字段不丢）', () => {
  const raw = { 1: { class_type: 'Note', inputs: {}, _meta: { title: 't' } } }
  assert.deepEqual(emitWorkflow(parseWorkflow(raw)), raw)
})

/* ---------- validate ---------- */
ok('validateAgainstObjectInfo 全齐 → ok', () => {
  assert.equal(validateAgainstObjectInfo(RAW, OBJECT_INFO).ok, true)
})
ok('校验能点名「没有的节点 / 缺必需输入 / 未知输入」', () => {
  const bad = {
    1: { class_type: 'GhostNode', inputs: {} },
    2: { class_type: 'KSampler', inputs: { seed: 1, bogus: 9 } },
  }
  const r = validateAgainstObjectInfo(bad, OBJECT_INFO)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('GhostNode')))
  assert.ok(r.errors.some((e) => e.includes('缺必需输入')))
  assert.ok(r.errors.some((e) => e.includes('未知输入 bogus')))
})

/* ---------- diff ---------- */
ok('diffWorkflow 报出输入值变化与新增节点', () => {
  const before = parseWorkflow(RAW)
  const after = parseWorkflow({ ...RAW, 2: { ...RAW[2], inputs: { ...RAW[2].inputs, seed: 9 } }, 3: { class_type: 'Note', inputs: {} } })
  const d = diffWorkflow(before, after)
  assert.ok(d.some((c) => c.node === '2' && c.input === 'seed' && c.after === 9))
  assert.ok(d.some((c) => c.node === '3' && c.kind === 'added'))
})

/* ---------- 五个 pass ---------- */
ok('SlotBindPass：显式 slots + values 才改值（values 空 ⇒ 零改动）', () => {
  const ast = parseWorkflow(RAW)
  const r0 = SlotBindPass(ast, { slots: { 2: { seed: 'seed' } }, values: {} })
  assert.equal(r0.changes.length, 0)
  const r1 = SlotBindPass(ast, { slots: { 2: { seed: 'seed' } }, values: { seed: 42 } })
  assert.equal(ast.nodes.get('2').inputs.seed, 42)
  assert.equal(r1.changes[0].pass, 'SlotBindPass')
})
ok('SlotBindPass：G1 字面量名自动绑定（LITERAL_SLOTS 同源）', () => {
  assert.ok(LITERAL_SLOTS.includes('steps'))
  const ast = parseWorkflow(RAW)
  SlotBindPass(ast, { values: { steps: 4 } })
  assert.equal(ast.nodes.get('2').inputs.steps, 4)
})
ok('ModelMapPass：缺映射目标时抛错，不塞不存在的模型', () => {
  const ast = parseWorkflow({ 1: { class_type: 'UNETLoader', inputs: { unet_name: 'old.safetensors' } } })
  assert.throws(() => ModelMapPass(ast, {
    modelMap: { 'old.safetensors': 'new.safetensors' }, available: new Set(),
  }), /缺模型/)
})
ok('ModelMapPass：有目标就改写并记 tier', () => {
  const ast = parseWorkflow({ 1: { class_type: 'UNETLoader', inputs: { unet_name: 'old' } } })
  const r = ModelMapPass(ast, { modelMap: { old: 'new' }, vramGB: 20, available: new Set(['new']) })
  assert.equal(ast.nodes.get('1').inputs.unet_name, 'new')
  assert.equal(r.changes[0].pass, 'ModelMapPass')
})
ok('LoraPass：未装抛错 / 已装改 lora_name / 空 lora 空跑', () => {
  const ast = parseWorkflow({ 1: { class_type: 'LoraLoader', inputs: { lora_name: 'x' } } })
  assert.throws(() => LoraPass(ast, { lora: 'y', installed: new Set() }), /未安装/)
  assert.equal(LoraPass(ast, { lora: '' }).changes.length, 0)
  LoraPass(ast, { lora: 'y', installed: new Set(['y']) })
  assert.equal(ast.nodes.get('1').inputs.lora_name, 'y')
})
ok('ChunkPass：81/49/8 → 2 段、不复制子图、length 写回首段', () => {
  const ast = parseWorkflow({ ...RAW, 3: { class_type: 'Wan22ImageToVideoLatent', inputs: { length: 81 } } })
  const r = ChunkPass(ast, { frames: 81, framesPerChunk: 49, overlap: 8 })
  const plan = ast.meta.chunkPlan
  assert.equal(plan.chunks, 2)
  assert.equal(plan.segments[0].frameCount, 49)
  assert.equal(plan.segments[1].startFrame, 41)
  assert.equal(plan.segments[1].frameCount, 40)
  assert.equal(plan.segments[0].frameCount + plan.segments[1].frameCount - plan.overlap, 81)
  assert.equal(ast.nodes.size, 3) // 没有复制 KSampler 子图
  assert.equal(ast.nodes.get('3').inputs.length, 49)
  assert.equal(r.changes[0].pass, 'ChunkPass')
})
ok('ChunkPass：短片段空跑 / overlap ≥ perChunk 抛错', () => {
  const ast = parseWorkflow(RAW)
  assert.equal(ChunkPass(ast, { frames: 25 }).changes.length, 0)
  assert.throws(() => ChunkPass(ast, { frames: 81, framesPerChunk: 8, overlap: 8 }), /必须大于/)
})
ok('AccelPass：profile=null 空跑；已有缓存节点禁止叠加', () => {
  const ast = parseWorkflow(RAW)
  assert.equal(AccelPass(ast, {}).changes.length, 0)
  assert.throws(() => AccelPass(parseWorkflow({ 1: { class_type: 'EasyCache', inputs: {} } }), { profile: 'easycache' }), /禁止叠加/)
})
ok('PASSES 五段顺序固定', () => {
  assert.deepEqual(PASSES.map((p) => p.name), ['SlotBindPass', 'ModelMapPass', 'LoraPass', 'ChunkPass', 'AccelPass'])
})

/* ---------- runAstPipeline / rollback ---------- */
ok('runAstPipeline 默认 ctx：0 改动、校验通过、rollback 与原文等价', () => {
  const r = runAstPipeline(RAW, OBJECT_INFO)
  assert.equal(r.changes.length, 0)
  assert.equal(r.validation.ok, true)
  assert.equal(r.chunkPlan, null)
  assert.deepEqual(r.payload, RAW)
  assert.deepEqual(r.rollback(), RAW)
})
ok('runAstPipeline 校验失败时抛错（不会静默提交坏图）', () => {
  assert.throws(() => runAstPipeline(RAW, {}), /提交前校验失败/)
})
ok('runAstPipeline 有 changes 时提交体真被改写', () => {
  const r = runAstPipeline(RAW, OBJECT_INFO, { values: { steps: 4 } })
  assert.ok(r.changes.length > 0)
  assert.equal(r.payload[2].inputs.steps, 4)
  assert.deepEqual(r.rollback(), RAW) // 快照未被 pass 污染
})

/* ---------- comfy-catalog ---------- */
ok('finalizeWorkflow：无 objectInfo 原样返回（引用都不换）', () => {
  const r = finalizeWorkflow(RAW, null)
  assert.equal(r.workflow, RAW)
  assert.equal(r.strict, false)
  assert.equal(r.error, null)
})
ok('finalizeWorkflow：0 改动 ⇒ 零漂移（提交体 === 原对象）', () => {
  const r = finalizeWorkflow(RAW, OBJECT_INFO, { slots: slotsForWorkflow(RAW, { slots: {} }) })
  assert.equal(r.workflow, RAW)
  assert.equal(r.strict, false)
  assert.equal(r.validation.ok, true)
})
ok('finalizeWorkflow：校验失败 ⇒ 原样回滚且 error 非空（不阻断）', () => {
  const r = finalizeWorkflow(RAW, { CLIPTextEncode: { input: { required: { text: [], clip: [], extra: [] } } } })
  assert.equal(r.workflow, RAW)
  assert.equal(r.error !== null, true)
  assert.equal(r.strict, false)
})
ok('finalizeWorkflow：passes 真改动 ⇒ strict=true 且提交体切换为管线产物', () => {
  const r = finalizeWorkflow(RAW, OBJECT_INFO, { values: { steps: 4 } })
  assert.equal(r.strict, true)
  assert.notEqual(r.workflow, RAW)
  assert.equal(r.workflow[2].inputs.steps, 4)
})
ok('slotsForWorkflow：A 线 class→inputs 翻成 nodeId→{input:valueKey}', () => {
  const s = slotsForWorkflow(RAW, { slots: { KSampler: ['seed', 'steps'], CLIPTextEncode: ['text'] } })
  assert.deepEqual(s['2'], { seed: 'seed', steps: 'steps' })
  assert.deepEqual(s['1'], { text: 'text' })
})
ok('modelLoadersForWorkflow：G2 按 class 命中节点 id', () => {
  const wf = { 9: { class_type: 'UNETLoader', inputs: { unet_name: 'x' } } }
  assert.deepEqual(modelLoadersForWorkflow(wf, { modelLoaders: { UNETLoader: ['unet_name'] } }), { 9: ['unet_name'] })
})
ok('readSlotsCatalog：坏 JSON / 空函数兜成空目录，不抛', () => {
  assert.deepEqual(readSlotsCatalog(() => '{bad'), { slots: {}, modelLoaders: {} })
  assert.deepEqual(readSlotsCatalog(null), { slots: {}, modelLoaders: {} })
})
ok('★ assets/slots.json 真文件含 Wan22ImageToVideoLatent 与 UNETLoader', () => {
  assert.equal(existsSync(path.join(ROOT, 'assets/slots.json')), true)
  const c = readSlotsCatalog(() => src('assets/slots.json'))
  assert.deepEqual(c.slots.Wan22ImageToVideoLatent, ['height', 'length', 'width'])
  assert.deepEqual(c.modelLoaders.UNETLoader, ['unet_name'])
})
ok('catalogForTts：节点名集合 + 加载器 OPTIONS 里的模型名', () => {
  const c = catalogForTts({
    FB_Qwen3TTS: { input: { required: {} } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'qwen3-tts-0.6B.gguf'], {}] } } },
  })
  assert.equal(c.nodes.FB_Qwen3TTS, true)
  assert.ok(c.models.checkpoints.includes('qwen3-tts-0.6B.gguf'))
})
await okAsync('loadObjectInfo：失败返回 null 且缓存命中不再请求', async () => {
  resetCatalogCache()
  let calls = 0
  const fetchFn = async () => { calls += 1; return { ok: true, json: async () => ({ A: {} }) } }
  const a = await loadObjectInfo({ url: 'http://127.0.0.1:1', fetchFn })
  const b = await loadObjectInfo({ url: 'http://127.0.0.1:1', fetchFn })
  assert.equal(a.A !== undefined, true)
  assert.equal(b, a)
  assert.equal(calls, 1)
  resetCatalogCache()
  assert.equal(await loadObjectInfo({ url: 'http://127.0.0.1:1', fetchFn: async () => { throw new Error('down') } }), null)
})

/* ---------- host 源码接线 ---------- */
ok('★ index.js 真的 import 了 comfy-catalog / tts-workflow / hybrid-runner', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes("from './comfy-catalog.js'"))
  assert.ok(s.includes("from './tts-workflow.js'"))
  assert.ok(s.includes("from './hybrid-runner.js'"))
})
ok('★ submitPrompt 真的跑 finalizeWorkflow（不是只 import 不用）', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes('finalizeWorkflow(workflow, objectInfo'))
  assert.ok(s.includes('slotsForWorkflow(workflow, getSlotsCatalog())'))
  assert.ok(s.includes('JSON.stringify({ prompt: submitBody'))
})
ok('★ 提交前管线失败不阻断（diag 后仍按原样提交）', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes('按原样提交'))
  assert.ok(s.includes('let submitBody = workflow'))
})

console.log(`\n✓ 全部通过（${n} 项）`)
