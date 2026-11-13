#!/usr/bin/env node
/**
 * 报告 v3 §10：混合模式 TTS 段契约（兜底链 / 缺件报告 / 可插拔探测）。
 *
 * ★ 2026-11-10 重写：上一版断言的是**猜出来的节点名**（FB_Qwen3TTS / MiniMaxH3TTS）
 *   与「models 里必须有 qwen3-tts 文件名」，两者在本机都不成立 —— 于是把已装的
 *   ComfyUI-Qwen-TTS 判成「没有 TTS 节点」。现在按 /object_info 真实类名回归。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TTS_FALLBACK_CHAINS, TTS_WEIGHT_NOTE, probeTts, ttsMissingReport, buildTtsWorkflow,
} from '../lib/tts-workflow.js'
import { catalogForTts } from '../lib/comfy-catalog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

console.log('tts-workflow 回归（真实节点类名）')

// 本机 /object_info 实测存在的类名（1684 节点中挑出的 TTS 族）
const REAL_NODES = {
  FB_Qwen3TTSCustomVoice: {}, FB_Qwen3TTSVoiceDesign: {},
  FB_Qwen3TTSDialogueInference: {}, FB_Qwen3TTSVoiceClone: {},
  SaveAudio: {}, SaveAudioMP3: {}, SaveAudioOpus: {}, SaveAudioAdvanced: {},
}

ok('★ 兜底链全部用 /object_info 里真实存在的类名（不再是猜名）', () => {
  assert.equal(TTS_FALLBACK_CHAINS.length, 3)
  for (const c of TTS_FALLBACK_CHAINS) {
    assert.ok(c.generate in REAL_NODES, `generate 不存在：${c.generate}`)
    assert.ok(c.save in REAL_NODES, `save 不存在：${c.save}`)
    assert.deepEqual(c.nodes, [c.generate, c.save])
    assert.ok(['mp3', 'flac'].includes(c.format))
  }
  assert.equal(TTS_FALLBACK_CHAINS[0].generate, 'FB_Qwen3TTSCustomVoice')
  assert.equal(TTS_FALLBACK_CHAINS[0].save, 'SaveAudioMP3')
})
ok('★ 权重说明写明「不进 object_info 下拉」，杜绝再拿文件名当闸门', () => {
  assert.ok(TTS_WEIGHT_NOTE.includes('models/qwen-tts'))
  assert.ok(TTS_WEIGHT_NOTE.includes('不出现在'))
})
ok('probeTts：空 caps ⇒ available=false + 明确 reason', () => {
  const p = probeTts({})
  assert.equal(p.available, false)
  assert.equal(p.tier, null)
  assert.ok(p.reason.includes('混合模式需要 TTS 段'))
})
ok('ttsMissingReport 列清节点包目录、权重目录、候选链、当前探测', () => {
  const r = ttsMissingReport({ nodeCount: 0, nodeNames: [] })
  assert.ok(r.includes('ComfyUI-Qwen-TTS'))
  assert.ok(r.includes('models/qwen-tts'))
  assert.ok(r.includes('候选链'))
  assert.ok(r.includes('自动放行'))
})
ok('★★ catalogForTts(真实 object_info 子集) → probeTts 放行（生产路径端到端）', () => {
  const p = probeTts(catalogForTts(REAL_NODES))
  assert.equal(p.available, true)
  assert.equal(p.tier, 'qwen3-tts-custom-mp3')
  assert.equal(p.format, 'mp3')
  assert.ok(p.nodeCount >= 8)
})
ok('★★ 只有节点、models 空 ⇒ 仍然放行（上一版 bug 的精确回归）', () => {
  const p = probeTts({ nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true }, models: {} })
  assert.equal(p.available, true, '权重由节点包管理，不该要求 models 里有文件名')
})
ok('probeTts：节点表用 Set / 数组也认', () => {
  const set = new Set(['FB_Qwen3TTSCustomVoice', 'SaveAudioMP3'])
  assert.equal(probeTts({ nodes: set }).available, true)
  assert.equal(probeTts({ nodes: ['FB_Qwen3TTSCustomVoice', 'SaveAudioMP3'] }).available, true)
})
ok('★ 误传 probeCapabilities 能力标志集 ⇒ 明确提示改用 catalogForTts', () => {
  const p = probeTts({ nodes: { qwen21: true, loraOnly: true, teSpeed: true } })
  assert.equal(p.available, false)
  assert.ok(p.reason.includes('catalogForTts'))
})
ok('probeTts：主链缺 SaveAudioMP3 → 自动降到 FLAC 链', () => {
  const p = probeTts({ nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudio: true }, models: {} })
  assert.equal(p.available, true)
  assert.equal(p.tier, 'qwen3-tts-custom-flac')
  assert.equal(p.format, 'flac')
})
ok('probeTts：前三链全缺、只有 VoiceDesign → 降到第三链', () => {
  const p = probeTts({ nodes: { FB_Qwen3TTSVoiceDesign: true, SaveAudioMP3: true }, models: {} })
  assert.equal(p.available, true)
  assert.equal(p.tier, 'qwen3-tts-design')
})
ok('probeTts：云 API 节点（ElevenLabs/FishAudio）不算本地离线兜底', () => {
  const p = probeTts({ nodes: { ElevenLabsTextToSpeech: true, SaveAudio: true }, models: {} })
  assert.equal(p.available, false)
})
ok('buildTtsWorkflow：缺后端抛带清单的明确错误（不吞异常）', () => {
  assert.throws(() => buildTtsWorkflow({}, { text: '你好' }), /混合模式需要 TTS 段/)
})
ok('buildTtsWorkflow：有后端但 text 为空 ⇒ 明确报错', () => {
  const caps = catalogForTts(REAL_NODES)
  assert.throws(() => buildTtsWorkflow(caps, { text: '   ' }), /text 不能为空/)
})
ok('★★ buildTtsWorkflow 主链：真实类名 + 真实 required 输入', () => {
  const r = buildTtsWorkflow(catalogForTts(REAL_NODES), {
    text: '一段旁白', seed: 9, prefix: 'x/tts',
  })
  const gen = r.payload[1]
  assert.equal(gen.class_type, 'FB_Qwen3TTSCustomVoice')
  assert.equal(gen.inputs.text, '一段旁白')
  assert.equal(gen.inputs.speaker, 'Serena')
  assert.equal(gen.inputs.model_choice, '1.7B')
  assert.equal(gen.inputs.device, 'auto')
  assert.equal(gen.inputs.precision, 'bf16')
  assert.equal(gen.inputs.language, 'Auto')
  assert.equal(gen.inputs.seed, 9)
  assert.equal(gen.inputs.unload_model_after_generate, true)
  const save = r.payload[2]
  assert.equal(save.class_type, 'SaveAudioMP3')
  assert.deepEqual(save.inputs.audio, ['1', 0])
  assert.equal(save.inputs.filename_prefix, 'x/tts')
  assert.equal(save.inputs.quality, '128k')
  assert.equal(r.format, 'mp3')
  assert.equal(r.workflow.nodes.size, 2)
  assert.equal(r.probe.tier, 'qwen3-tts-custom-mp3')
})
ok('buildTtsWorkflow：FLAC 链不带 quality（SaveAudio 没这个输入）', () => {
  const caps = { nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudio: true }, models: {} }
  const r = buildTtsWorkflow(caps, { text: '测试' })
  assert.equal(r.payload[2].class_type, 'SaveAudio')
  assert.equal(r.payload[2].inputs.quality, undefined)
  assert.equal(r.format, 'flac')
})
ok('buildTtsWorkflow：VoiceDesign 链带 instruct', () => {
  const caps = { nodes: { FB_Qwen3TTSVoiceDesign: true, SaveAudioMP3: true }, models: {} }
  const r = buildTtsWorkflow(caps, { text: '测试', instruct: '低沉男声' })
  assert.equal(r.payload[1].class_type, 'FB_Qwen3TTSVoiceDesign')
  assert.equal(r.payload[1].inputs.instruct, '低沉男声')
})
ok('★ index.js 的 modes 端点用真实 /object_info 决定 hybrid 可用性', () => {
  const s = src('lib/index.js')
  assert.ok(s.includes("reg('/api/comfy-pipeline/modes'"))
  assert.ok(s.includes('probeTts(catalogForTts(objectInfo))'))
  assert.ok(s.includes('TTS_FALLBACK_CHAINS.map'))
})
ok('★★ 语音段落盘不写死 .wav，且 index.js 不再有第二份 TTS 实现', () => {
  // ★ 2026-11-13：TTS 段外置到 lib/speech-tool.js（混合模式与 generate_speech 共用）。
  //   断言改读新文件，不是删掉或放宽；同时锁住「index.js 里没有第二份」。
  const s = src('lib/speech-tool.js')
  assert.ok(s.includes('exec(String(first?.filename'))
  assert.ok(s.includes('toLowerCase()'))
  assert.ok(!s.includes('_tts.wav'))
  const idx = src('lib/index.js')
  assert.ok(!idx.includes('waitForAudio(cfg'))
  assert.ok(idx.includes('speechRunner('))
})
ok('★ generate_hybrid 描述不再谎称「本机必须装 TTS 才行」', () => {
  const s = src('lib/tool-descriptions.js')
  assert.ok(s.includes('ComfyUI-Qwen-TTS'))
  assert.ok(!s.includes('qwen3-tts-gguf / MiniMax-H3'))
})
ok('★ 面板 hybrid tab 由 /modes 动态决定，不是写死 disabled', () => {
  const p = src('assets/panel.js')
  assert.ok(p.includes("var MODES_PATH = 'api/comfy-pipeline/modes'"))
  assert.ok(p.includes('modeAvailability[m.id] !== false'))
  assert.ok(p.includes('loadModes()'))
})
ok('★ comfy-catalog 注释不再写「本机没有 TTS 节点」', () => {
  const s = src('lib/comfy-catalog.js')
  assert.ok(s.includes('1684 个节点'))
  assert.ok(!s.includes('本机没有 TTS 节点与权重时返回空集合'))
})

console.log(`\n✓ 全部通过（${n} 项）`)
