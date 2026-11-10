#!/usr/bin/env node
/** 报告 v3 §10：混合模式 TTS 段契约（兜底链 / 缺件报告 / 可插拔探测）。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TTS_FALLBACK_CHAINS, probeTts, ttsMissingReport, buildTtsWorkflow,
} from '../lib/tts-workflow.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

console.log('tts-workflow 回归')

ok('TTS_FALLBACK_CHAINS 三条按优先级：主模型 → gguf → MiniMax', () => {
  assert.deepEqual(TTS_FALLBACK_CHAINS.map((c) => c.id), ['qwen3-tts', 'qwen3-tts-gguf', 'minimax-h3'])
  for (const c of TTS_FALLBACK_CHAINS) {
    assert.ok(c.nodes.includes('SaveAudio'))
    assert.ok(Array.isArray(c.models) && c.models.length > 0)
  }
})
ok('probeTts：空 caps ⇒ available=false + 明确 reason（不假装能出 wav）', () => {
  const p = probeTts({})
  assert.equal(p.available, false)
  assert.equal(p.tier, null)
  assert.ok(p.reason.includes('混合模式需要 TTS 段'))
})
ok('ttsMissingReport 列清目录、候选链、当前探测结果', () => {
  const r = ttsMissingReport({ nodes: {}, models: [] })
  assert.ok(r.includes('text_encoders'))
  assert.ok(r.includes('custom_nodes'))
  assert.ok(r.includes('候选链'))
  assert.ok(r.includes('装好 TTS 后本段自动放行'))
})
ok('probeTts：主模型节点 + 权重齐 ⇒ available=true / tier=qwen3-tts', () => {
  const p = probeTts({
    nodes: { FB_Qwen3TTS: true, SaveAudio: true },
    models: { tts: ['qwen3-tts-1.7B.safetensors'] },
  })
  assert.equal(p.available, true)
  assert.equal(p.tier, 'qwen3-tts')
  assert.equal(p.reason, undefined)
})
ok('probeTts：主模型缺、gguf 齐 ⇒ 自动降到第二档', () => {
  const p = probeTts({
    nodes: { FB_Qwen3TTSGGUF: true, SaveAudio: true },
    models: { checkpoints: ['qwen3-tts-gguf-0.6B-Q8_0.gguf'] },
  })
  assert.equal(p.available, true)
  assert.equal(p.tier, 'qwen3-tts-gguf')
})
ok('probeTts：只有节点没权重 ⇒ 仍不可用（缺件不静默降级）', () => {
  const p = probeTts({ nodes: { FB_Qwen3TTS: true, SaveAudio: true }, models: {} })
  assert.equal(p.available, false)
  assert.ok(p.reason.includes('models='))
})
ok('probeTts：error/未知字段按"没有"处理，不误判', () => {
  const p = probeTts({ nodes: { FB_Qwen3TTS: 'error' }, models: { tts: 'not-an-array' } })
  assert.equal(p.available, false)
})
ok('buildTtsWorkflow：缺后端抛带清单的明确错误（不吞异常）', () => {
  assert.throws(() => buildTtsWorkflow({}, { text: '你好' }), /混合模式需要 TTS 段/)
})
ok('buildTtsWorkflow：有后端但 text 为空 ⇒ 明确报错', () => {
  const caps = { nodes: { FB_Qwen3TTS: true, SaveAudio: true }, models: { tts: ['qwen3-tts.safetensors'] } }
  assert.throws(() => buildTtsWorkflow(caps, { text: '   ' }), /text 不能为空/)
})
ok('buildTtsWorkflow：有后端 ⇒ API 格式 FB_Qwen3TTS → SaveAudio', () => {
  const caps = { nodes: { FB_Qwen3TTS: true, SaveAudio: true }, models: { tts: ['qwen3-tts.safetensors'] } }
  const r = buildTtsWorkflow(caps, { text: '一段旁白', durationSec: 4, seed: 9, prefix: 'x/tts' })
  assert.equal(r.payload[1].class_type, 'FB_Qwen3TTS')
  assert.equal(r.payload[1].inputs.text, '一段旁白')
  assert.equal(r.payload[1].inputs.duration, 4)
  assert.equal(r.payload[2].class_type, 'SaveAudio')
  assert.deepEqual(r.payload[2].inputs.audio, ['1', 0])
  assert.equal(r.probe.tier, 'qwen3-tts')
  assert.equal(r.workflow.nodes.size, 2)
})
ok('★ index.js 的 modes 端点用 probeTts 决定 hybrid 可用性', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes("path: '/api/comfy-pipeline/modes'"))
  assert.ok(s.includes('probeTts(catalogForTts(objectInfo))'))
  assert.ok(s.includes("reason: probe.available ? '' : probe.reason"))
  assert.ok(s.includes('TTS_FALLBACK_CHAINS.map'))
})
ok('★ 面板 hybrid tab 由 /modes 动态决定，不是写死 disabled', () => {
  const p = src('assets/panel.js')
  assert.ok(p.includes("var MODES_PATH = 'api/comfy-pipeline/modes'"))
  assert.ok(p.includes('modeAvailability[m.id] !== false'))
  assert.ok(p.includes('loadModes()'))
  assert.ok(p.includes('modeReason[m.id]'))
})

console.log(`\n✓ 全部通过（${n} 项）`)
