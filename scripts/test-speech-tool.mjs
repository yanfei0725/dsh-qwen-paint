#!/usr/bin/env node
/**
 * test-speech-tool.mjs —— B3 剩余的离线回归（2026-11-13）
 *
 * 覆盖三件事：
 *   ① 工具描述集中层（共享套话 / 硬约束字面量 / aiPickBest 动态段）；
 *   ② 结果回包按 output.schema 声明字段收口（slimResult / withDeclaredOutput）；
 *   ③ 独立语音工具 generate_speech 与混合模式共用的 TTS 段。
 *
 * 全程注入假 deps：零真实 fetch、零真实 ComfyUI、不生成任何图片/视频/音频。
 * 唯一落盘是临时目录里的假字节文件（FAKE-AUDIO），跑完即删。
 */
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import {
  LOCAL_ONLY, TOOL_SUMMARIES,
  describeDrawTool, describeVideoTool, describeHybridTool,
  describeSpeechTool, describeAccelTool, describeUpscaleTool,
} from '../lib/tool-descriptions.js'
import {
  slimResult, withDeclaredOutput, makeDeclaredOutputSchema,
} from '../lib/tool-contracts.js'
import { makeSpeechTool, makeSpeechRunner, SPEECH_OUTPUT_SCHEMA } from '../lib/speech-tool.js'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

console.log('=== 1. 工具描述集中层 ===')
{
  ok('LOCAL_ONLY 写明纯本地 / 不出网 / 不花钱 / 无 API Key',
    LOCAL_ONLY.includes('纯本地') && LOCAL_ONLY.includes('不出网')
    && LOCAL_ONLY.includes('不花钱') && LOCAL_ONLY.includes('API Key'))
  const all = [
    ['draw', describeDrawTool({})], ['video', describeVideoTool()],
    ['hybrid', describeHybridTool()], ['speech', describeSpeechTool()],
    ['accel', describeAccelTool()], ['upscale', describeUpscaleTool()],
  ]
  for (const [name, d] of all) {
    ok(`${name} 描述复用同一句 LOCAL_ONLY`, d.includes(LOCAL_ONLY))
    ok(`${name} 描述非空且够长`, typeof d === 'string' && d.length > 60)
  }
  const draw = describeDrawTool({})
  const drawOn = describeDrawTool({ aiPickBest: 'on' })
  for (const lit of [
    '严禁自己写 Python/Matplotlib/PIL', '唯一途径', '可编辑的结构化图表',
    '数学/几何可视化', '拿不准就调本工具画一张',
  ]) ok(`draw 硬约束字面量保留：${lit}`, draw.includes(lit))
  ok('draw 描述不含「先与用户确认」劝退话', !draw.includes('先与用户确认'))
  ok('aiPickBest=off 不带 AI 挑图段', !draw.includes('逐张'))
  ok('aiPickBest=on 带 AI 挑图段', drawOn.includes('逐张') && drawOn.includes('绝不假装看过'))
  ok('video 描述不夸大（写明做不了 60 秒长片）', describeVideoTool().includes('做不了 60 秒长片'))
  ok('hybrid 描述写明音频与 mp4 不自动合流', describeHybridTool().includes('不自动合流'))
  ok('hybrid 描述指向独立 generate_speech', describeHybridTool().includes('generate_speech'))
  ok('speech 描述写明缺件给清单、不自动下载', describeSpeechTool().includes('不假装能出音频')
    && describeSpeechTool().includes('不会自动下载权重'))
  ok('speech 描述不承诺固定格式（写明由后端链决定）', describeSpeechTool().includes('格式由后端实际命中的兜底链决定'))
  ok('★ TOOL_SUMMARIES 覆盖全部 13 个工具（0.32.1 补齐 3 个新工具）',
    Object.keys(TOOL_SUMMARIES).length === 13)
  ok('TOOL_SUMMARIES 含 generate_speech', TOOL_SUMMARIES.generate_speech.includes('Qwen3-TTS'))
}

console.log('\n=== 2. 结果回包按声明收口 ===')
{
  const schema = makeDeclaredOutputSchema(
    { a: { type: 'string' }, b: { type: 'integer' } }, ['a'], '测试',
  )
  ok('makeDeclaredOutputSchema 是严格对象', schema.type === 'object' && schema.additionalProperties === false)
  ok('makeDeclaredOutputSchema 保留 required / description', schema.required[0] === 'a' && schema.description === '测试')
  const src = { a: 'x', b: 2, debug: 'BIG OBJECT', gone: undefined }
  const slim = slimResult(schema, src)
  ok('slimResult 丢掉未声明字段', !('debug' in slim) && !('gone' in slim))
  ok('slimResult 保留声明字段', slim.a === 'x' && slim.b === 2)
  ok('slimResult 返回新对象，不改原值', slim !== src && src.debug === 'BIG OBJECT')
  const dynamic = { whatever: 1 }
  ok('诊断类（无 properties）原样返回，绝不误删', slimResult({ type: 'object', additionalProperties: true }, dynamic) === dynamic)
  ok('非对象原样返回', slimResult(schema, 42) === 42 && slimResult(schema, null) === null)
  const fake = {
    name: 'fake', output: { schema, render: () => [] },
    planWorkflow: () => 'plan',
    async execute() { return { a: 'ok', b: 1, junk: { huge: true } } },
  }
  const wrapped = withDeclaredOutput(fake)
  const value = await wrapped.execute()
  ok('withDeclaredOutput 包装后仍声明 name / output', wrapped.name === 'fake' && wrapped.output === fake.output)
  ok('withDeclaredOutput 保留自测方法 planWorkflow', typeof wrapped.planWorkflow === 'function')
  ok('withDeclaredOutput 把回包收口到声明字段', value.a === 'ok' && !('junk' in value))
  ok('withDeclaredOutput 对无 execute 的对象原样返回', withDeclaredOutput({ name: 'x' }).name === 'x')
}

console.log('\n=== 3. 独立语音工具 / TTS 段 ===')
let tmpDir = ''
try {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-speech-'))
  const state = { pid: '', loaded: 0, audioName: 'tts_00001.mp3', error: false }
  const deps = {
    cfg: {
      comfyUrl: 'http://127.0.0.1:1', outputDir: tmpDir,
      pollIntervalMs: 1, timeoutMs: 1000, filePrefix: 'qwen',
    },
    log: () => {},
    ensureComfyUp: async () => {},
    loadObjectInfoFor: async () => { state.loaded += 1; return {} },
    catalogForTts: () => ({ nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } }),
    submitPrompt: async () => { state.pid = 'pid-1'; return state.pid },
    fetchOutputBytes: async () => Buffer.from('FAKE-AUDIO'),
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => ({
        [state.pid]: state.error
          ? { outputs: {}, status: { status_str: 'error', messages: ['boom'] } }
          : { outputs: { 2: { audio: [{ filename: state.audioName }] } } },
      }),
    }),
    cancelReason: () => new Error('cancelled'),
    safeStem: (s) => String(s).slice(0, 10),
    uniquePath: async (dir, name) => path.join(dir, name),
  }

  const tool = makeSpeechTool(deps)
  ok('工具名是 generate_speech', tool.name === 'generate_speech')
  ok('description 非空', typeof tool.description === 'string' && tool.description.length > 60)
  ok('parameters 必填 text', tool.parameters.required.includes('text')
    && tool.parameters.additionalProperties === false)
  ok('output.schema 是严格对象且声明 5 个字段', SPEECH_OUTPUT_SCHEMA.additionalProperties === false
    && Object.keys(SPEECH_OUTPUT_SCHEMA.properties).length === 5)
  ok('output.render 是函数且空值不崩', typeof tool.output.render === 'function'
    && Array.isArray(tool.output.render({}, {})))
  ok('presentationMeta 回 path / files', (() => {
    const m = tool.output.presentationMeta({}, { path: 'p', files: ['p'] })
    return m.path === 'p' && m.files[0] === 'p'
  })())
  ok('工具声明不可并发', tool.isConcurrencySafe() === false)
  let emptyThrew = false
  try { await tool.execute({ text: '   ' }, {}) } catch { emptyThrew = true }
  ok('空 text 明确拒绝', emptyThrew)

  const value = await tool.execute({ text: '你好，世界', seed: 7 }, {})
  ok('正常执行返回 path', typeof value.path === 'string' && value.path.length > 0)
  ok('落盘路径在 outputDir 内', path.resolve(value.path).startsWith(path.resolve(tmpDir)))
  ok('format 取真实扩展名 mp3', value.format === 'mp3')
  ok('files 恰好一张', Array.isArray(value.files) && value.files.length === 1)
  ok('tier 是命中的兜底链', value.tier === 'qwen3-tts-custom-mp3', value.tier)
  ok('seconds 是数字', typeof value.seconds === 'number')
  ok('假字节确实落盘', (await fsp.readFile(value.path)).toString() === 'FAKE-AUDIO')
  ok('未写死 .wav', !value.path.endsWith('.wav'))

  state.audioName = 'tts_00002.flac'
  const flac = await tool.execute({ text: '第二段' }, {})
  ok('SaveAudio(flac) 时按真实扩展名落盘', flac.format === 'flac' && flac.path.endsWith('.flac'))

  const before = state.loaded
  const runner = makeSpeechRunner(deps)
  await runner({ text: '复用 caps', caps: { nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } } })
  ok('传入 caps 时不再拉 /object_info', state.loaded === before, `${before} -> ${state.loaded}`)
  await runner({ text: '不传 caps' })
  ok('未传 caps 时才拉一次 /object_info', state.loaded === before + 1, state.loaded)

  const missing = makeSpeechRunner({
    ...deps, catalogForTts: () => ({ nodes: {} }),
  })
  let missingMsg = ''
  try { await missing({ text: '缺件' }) } catch (e) { missingMsg = String(e.message ?? e) }
  ok('缺件抛明确清单（不是一句不可用）', missingMsg.includes('custom_nodes/ComfyUI-Qwen-TTS')
    && missingMsg.includes('models/qwen-tts'), missingMsg.slice(0, 120))
  ok('缺件清单列出候选链', missingMsg.includes('SaveAudioMP3'))

  state.error = true
  let errMsg = ''
  try { await runner({ text: '后端报错' }) } catch (e) { errMsg = String(e.message ?? e) }
  ok('ComfyUI 报 error 时抛出而非无限等', errMsg.includes('TTS 段执行失败'), errMsg.slice(0, 100))
  state.error = false
} finally {
  if (tmpDir !== '') await fsp.rm(tmpDir, { recursive: true, force: true })
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}） ===`)
process.exit(fail === 0 ? 0 : 1)
