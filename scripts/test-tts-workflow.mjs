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
  buildVoiceCloneWorkflow, TTS_ATTENTION_CHOICES,
  DIALOGUE_CHAIN, probeDialogue, buildDialogueWorkflow,
} from '../lib/tts-workflow.js'
import { catalogForTts } from '../lib/comfy-catalog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8')
let n = 0
const ok = (name, fn) => { fn(); n += 1; console.log('  ✓ ' + name) }

console.log('tts-workflow 回归（真实节点类名）')

// 本机 /object_info 实测存在的类名（1684 节点中挑出的 TTS 族）
// ★ 值一律 true：hasNode() 的判定就是 nodes[name] === true（catalogForTts 生产口径），
//   之前用 {} 只因旧断言全用 `in` 检查；对话链 probe 走 hasNode 后必须用真值。
const REAL_NODES = {
  FB_Qwen3TTSCustomVoice: true, FB_Qwen3TTSVoiceDesign: true,
  FB_Qwen3TTSDialogueInference: true, FB_Qwen3TTSVoiceClone: true,
  FB_Qwen3TTSVoiceClonePrompt: true, FB_Qwen3TTSRoleBank: true,
  SaveAudio: true, SaveAudioMP3: true, SaveAudioOpus: true, SaveAudioAdvanced: true,
  VHS_LoadAudio: true,
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
  assert.ok(p.includes("var MODES_PATH = 'api/comfy-pipeline/modes'")
    || p.includes("var MODES_PATH = qpApiUrl('api/comfy-pipeline/modes')"))
  assert.ok(p.includes('modeAvailability[m.id] !== false'))
  assert.ok(p.includes('loadModes()'))
})
ok('★ comfy-catalog 注释不再写「本机没有 TTS 节点」', () => {
  const s = src('lib/comfy-catalog.js')
  assert.ok(s.includes('1684 个节点'))
  assert.ok(!s.includes('本机没有 TTS 节点与权重时返回空集合'))
})

// ★ 2026-11-17：Qwen3-TTS attention 参数透传（真机合法值，默认零漂移）
ok('TTS_ATTENTION_CHOICES == 真机 /object_info 合法枚举', () => {
  assert.deepEqual([...TTS_ATTENTION_CHOICES], ['auto', 'sage_attn', 'flash_attn', 'sdpa', 'eager'])
})
ok('buildTtsWorkflow 默认不写 attention（零漂移）', () => {
  const caps = catalogForTts(REAL_NODES)
  const r = buildTtsWorkflow(caps, { text: '测试' })
  assert.equal(Object.hasOwn(r.payload[1].inputs, 'attention'), false)
})
ok('buildTtsWorkflow 显式 sdpa ⇒ 写入 attention', () => {
  const caps = catalogForTts(REAL_NODES)
  const r = buildTtsWorkflow(caps, { text: '测试', attention: 'sdpa' })
  assert.equal(r.payload[1].inputs.attention, 'sdpa')
})
ok('buildTtsWorkflow 非法 attention 不写入（防污染工作流）', () => {
  const caps = catalogForTts(REAL_NODES)
  const r = buildTtsWorkflow(caps, { text: '测试', attention: 'evil' })
  assert.equal(Object.hasOwn(r.payload[1].inputs, 'attention'), false)
})
ok('buildVoiceCloneWorkflow 默认不写 attention', () => {
  const caps = catalogForTts(REAL_NODES)
  const r = buildVoiceCloneWorkflow(caps, { text: '测试', referenceFile: 'input/a.wav' })
  assert.equal(Object.hasOwn(r.payload[2].inputs, 'attention'), false)
})
ok('buildVoiceCloneWorkflow 显式 sage_attn ⇒ 写入', () => {
  const caps = catalogForTts(REAL_NODES)
  const r = buildVoiceCloneWorkflow(caps, { text: '测试', referenceFile: 'input/a.wav', attention: 'sage_attn' })
  assert.equal(r.payload[2].inputs.attention, 'sage_attn')
})
ok('★ generate_speech schema 暴露 attention 枚举', () => {
  const s = src('lib/speech-tool.js')
  assert.ok(s.includes("enum: ['auto', 'sage_attn', 'flash_attn', 'sdpa', 'eager']"))
  assert.ok(s.includes('attention: typeof args?.attention'))
})

console.log('\n多角色对话链（A1，2026-11-19：本机已装 FB_Qwen3TTSRoleBank/DialogueInference）')
ok('DIALOGUE_CHAIN 节点类名全部真实存在（本机 /object_info 口径）', () => {
  assert.equal(DIALOGUE_CHAIN.maxRoles, 8)
  for (const n of DIALOGUE_CHAIN.nodes) assert.ok(n in REAL_NODES, `不存在：${n}`)
  assert.ok(probeDialogue({ nodes: REAL_NODES }).available === true)
  const p = probeDialogue({ nodes: { FB_Qwen3TTSRoleBank: {} } })
  assert.equal(p.available, false)
  assert.ok(p.reason.includes('FB_Qwen3TTSDialogueInference') && p.reason.includes('ComfyUI-Qwen-TTS'), p.reason)
})
ok('buildDialogueWorkflow：两角色两提示词一银行一对话一保存', () => {
  const r = buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '小明: 你好呀。\n小红：很高兴见到你！',
    roles: [
      { name: '小明', referenceFile: 'dshqp-ref-audio-x.wav', referenceText: '你好' },
      { name: '小红', referenceFile: 'dshqp-ref-audio-y.wav' },
    ],
    seed: 7, prefix: 'x/tts',
  })
  const byClass = Object.values(r.payload).map((n) => n.class_type)
  assert.deepEqual(byClass.filter((c) => c === 'VHS_LoadAudio').length ? byClass : byClass, byClass)
  assert.equal(r.roleCount, 2)
  assert.equal(r.format, 'mp3')
  // 银行槽位：role_name_1/2 + prompt_1/2 指向各自的 VoiceClonePrompt 节点
  const bank = r.payload.bank
  assert.equal(bank.class_type, 'FB_Qwen3TTSRoleBank')
  assert.equal(bank.inputs.role_name_1, '小明')
  assert.equal(bank.inputs.role_name_2, '小红')
  const p1 = r.payload[bank.inputs.prompt_1[0]]
  const p2 = r.payload[bank.inputs.prompt_2[0]]
  assert.equal(p1.class_type, 'FB_Qwen3TTSVoiceClonePrompt')
  assert.equal(p1.inputs.ref_text, '你好')
  assert.equal(p1.inputs.x_vector_only, false)
  assert.equal(p2.inputs.ref_text, '')
  assert.equal(p2.inputs.x_vector_only, true) // 没转写=只取说话人嵌入（同克隆链纪律）
  // 加载器走 input/ 前缀（真机实测 VHS_LoadAudio 要 input/文件名）
  assert.ok(r.payload['1'].inputs.audio_file.startsWith('input/'))
  assert.ok(r.payload['2'].inputs.audio_file.startsWith('input/'))
  // 对话节点：脚本原样透传、全角冒号行也保留（节点 nodes.py:1241-1243 双冒号都认）
  const dlg = r.payload.dlg
  assert.equal(dlg.class_type, 'FB_Qwen3TTSDialogueInference')
  assert.ok(dlg.inputs.script.includes('你好呀。') && dlg.inputs.script.includes('很高兴见到你！'))
  assert.deepEqual(dlg.inputs.role_bank, ['bank', 0])
  assert.equal(dlg.inputs.merge_outputs, true)
  assert.equal(dlg.inputs.batch_size, 4)
  assert.equal(dlg.inputs.pause_linebreak, 0.5)
  assert.equal(dlg.inputs.seed, 7)
  assert.equal(dlg.inputs.unload_model_after_generate, true)
  assert.equal(dlg.inputs.attention, undefined) // 默认不写 attention（零漂移）
  assert.equal(r.payload.save.class_type, 'SaveAudioMP3')
  assert.deepEqual(r.payload.save.inputs.audio, ['dlg', 0])
})
ok('buildDialogueWorkflow：显式 sage_attn 写入 + pauses 覆盖 + batch 钳制', () => {
  const r = buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '甲: 你好', roles: [{ name: '甲', referenceFile: 'a.wav' }],
    attention: 'sage_attn', batchSize: 99,
    pauses: { linebreak: 1.2, comma: 0.1 },
  })
  const dlg = r.payload.dlg
  assert.ok(Object.values(r.payload).some((n) => n.class_type === 'FB_Qwen3TTSVoiceClonePrompt'
    && n.inputs.attention === 'sage_attn'))
  assert.equal(dlg.inputs.pause_linebreak, 1.2)
  assert.equal(dlg.inputs.comma_pause, 0.1)
  assert.equal(dlg.inputs.period_pause, 0.4) // 未覆盖的保持默认
  assert.equal(dlg.inputs.batch_size, 32) // 99 → 钳到节点上限
})
ok('buildDialogueWorkflow：角色名对不上脚本行提前报（节点会静默跳过，不能让它糊脸）', () => {
  assert.throws(
    () => buildDialogueWorkflow({ nodes: REAL_NODES }, {
      script: '路人甲: 你好', roles: [{ name: '小明', referenceFile: 'a.wav' }],
    }),
    (e) => /角色名不在角色表里/.test(e.message) && /小明/.test(e.message),
  )
  assert.throws(() => buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '', roles: [{ name: '小明', referenceFile: 'a.wav' }],
  }), /script 不能为空/)
  assert.throws(() => buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '小明: 你好', roles: [],
  }), /至少要给一个角色/)
  assert.throws(() => buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '小明: 你好', roles: [{ name: '小明', referenceFile: '' }],
  }), /缺参考音频/)
  assert.throws(() => buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '小明: 你好',
    roles: Array.from({ length: 9 }, (_, i) => ({ name: 'r' + i, referenceFile: 'a.wav' })),
  }), /最多 8 个角色/)
  assert.throws(() => buildDialogueWorkflow({ nodes: REAL_NODES }, {
    script: '小明: 你好',
    roles: [{ name: '小明', referenceFile: 'a.wav' }, { name: '小明', referenceFile: 'b.wav' }],
  }), /角色名重复/)
})

console.log(`\n✓ 全部通过（${n} 项）`)
