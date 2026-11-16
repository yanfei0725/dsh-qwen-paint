#!/usr/bin/env node
/**
 * 主模型候选层回归（纯干跑：不联网、不需要 ComfyUI）。
 *  ① unetOptionsFrom：OPTIONS 形状提取 / 双加载器去重排序 / 缺节点返回空数组
 *  ② makeModelOptionsHandler：本机围栏 403 / 非 GET 405 / 探测失败诚实分支 / 在线形状
 *  ③ persistVideoModelChoice：动态白名单采纳 / 拒绝 / 清除 + uiState.unetVideo 落盘
 *  ④ activeVideoUnet：界面选择优先、缺省回落 WAN_ASSETS.unet
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unetOptionsFrom, weightFilesFromObjectInfo } from '../lib/comfy-catalog.js'
import { makeModelOptionsHandler, persistVideoModelChoice, modelChoicesFrom, isKnownTtsBackend, persistTtsChoice } from '../lib/model-options.js'
import { DEFAULT_TTS_BACKEND, TTS_BACKENDS, listTtsBackends, nodeNamesOf } from '../lib/tts-backends.js'
import { WAN_ASSETS, activeVideoUnet } from '../lib/video-workflow.js'

let pass = 0; let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const OPTS = (names) => ({ UNETLoader: { input: { required: { unet_name: [names, {}] } } } })

// ---- ① unetOptionsFrom ----
console.log('unetOptionsFrom：候选提取')
ok('单加载器候选原样提出',
  JSON.stringify(unetOptionsFrom(OPTS(['a.safetensors', 'b.gguf']))) === JSON.stringify(['a.safetensors', 'b.gguf']))
ok('两个加载器合并去重 + 排序',
  JSON.stringify(unetOptionsFrom({
    ...OPTS(['b.gguf']),
    UnetLoaderGGUF: { input: { required: { unet_name: [['a.safetensors', 'b.gguf'], {}] } } },
  })) === JSON.stringify(['a.safetensors', 'b.gguf']))
ok('空 object_info / 缺两个加载器 → 空数组（不编造）',
  unetOptionsFrom(null).length === 0 && unetOptionsFrom({}).length === 0)
ok('非字符串项被剔除',
  JSON.stringify(unetOptionsFrom(OPTS(['a.safetensors', 42, null]))) === JSON.stringify(['a.safetensors']))

// ---- ①b weightFilesFromObjectInfo（2026-11-16 缓存复用，形状须与 probeCapabilities().files 等价）----
console.log('weightFilesFromObjectInfo：status 权重校验复用全量 object_info')
{
  const info = {
    UNETLoader: { input: { required: { unet_name: [['base.safetensors', 'turbo.safetensors'], {}] } } },
    UnetLoaderGGUF: { input: { required: { unet_name: [['q4.gguf'], {}] } } },
    LoraLoader: { input: { required: { lora_name: [['l1.safetensors'], {}] } } },
    ControlNetLoader: { input: { required: { control_net_name: [['c1.safetensors'], {}] } } },
  }
  const wf = weightFilesFromObjectInfo(info)
  ok('四段形状齐全且字段等价 nodeFileList',
    wf && JSON.stringify(wf.unet) === JSON.stringify(['base.safetensors', 'turbo.safetensors'])
    && JSON.stringify(wf.unetGguf) === JSON.stringify(['q4.gguf'])
    && JSON.stringify(wf.lora) === JSON.stringify(['l1.safetensors'])
    && JSON.stringify(wf.controlnet) === JSON.stringify(['c1.safetensors']))
  ok('缺节点 → 该段为空数组，不抛错（与 probe 缺件口径一致）',
    JSON.stringify(weightFilesFromObjectInfo({})) === JSON.stringify({ unet: [], unetGguf: [], lora: [], controlnet: [] }))
  const optionalEntry = [['x.safetensors'], {}]
  const optionalInfo = { UNETLoader: { input: { optional: { unet_name: optionalEntry } } } }
  const optionalWf = weightFilesFromObjectInfo(optionalInfo)
  ok('optional 字段也认（ComfyUI 有时把候选放 optional）',
    JSON.stringify(optionalWf.unet) === JSON.stringify(['x.safetensors']))
  ok('非对象 / 数组入参 → null（触发回退 probeCapabilities，不放宽白名单）',
    weightFilesFromObjectInfo(null) === null && weightFilesFromObjectInfo([]) === null && weightFilesFromObjectInfo('x') === null)
  const dirtyWf = weightFilesFromObjectInfo(OPTS(['a.safetensors', 42, null]))
  ok('非字符串候选被剔除',
    JSON.stringify(dirtyWf.unet) === JSON.stringify(['a.safetensors']))
}

// ---- ② handler ----
console.log('model-options 端点：围栏与诚实分支')
const last = {}
const respondJson = (res, body, status = 200) => { last.body = body; last.status = status }
const failBody = (error) => ({ ok: false, reason: String(error?.message ?? error) })
const mkHandler = (objectInfo) => makeModelOptionsHandler({
  isLocalRequest: (req) => req.local !== false,
  respondJson, failBody,
  cfg: {},
  loadObjectInfoFor: async () => objectInfo,
})
const h = await mkHandler({ ...OPTS(['m1.safetensors']) })

await h({ local: false, method: 'GET' }, {})
ok('非本机请求 403 + local requests only', last.status === 403 && last.body.reason === 'local requests only')

await h({ local: true, method: 'POST' }, {})
ok('非 GET 405', last.status === 405)

await h({ local: true, method: 'GET' }, {})
ok('在线：候选 + 当前选择形状',
  last.status === 200 && last.body.ok === true && last.body.online === true
  && JSON.stringify(last.body.unet) === JSON.stringify(['m1.safetensors'])
  && typeof last.body.selected.image === 'string' && typeof last.body.selected.video === 'string')

await mkHandler(null)({ local: true, method: 'GET' }, {})
ok('探测失败：ok:true + online:false + 空清单 + 原因（≠ 没装模型）',
  last.status === 200 && last.body.ok === true && last.body.online === false
  && Array.isArray(last.body.unet) && last.body.unet.length === 0 && last.body.reason.includes('不代表'))

// ---- ③ persistVideoModelChoice（真 uiState 文件，DSH_HOME 指到临时目录）----
console.log('persistVideoModelChoice：动态白名单 + 落盘')
const home = mkdtempSync(path.join('K:/ai/tmp', 'dsh-mo-'))
process.env.DSH_HOME = home
// 重新 import 触发 config.js 按新 DSH_HOME 算路径？config.js 每次调用 uiStatePath() 现算 → 改 env 即生效。
const logs = []
const log = (lvl, msg) => logs.push(`${lvl}:${msg}`)
const wf = { unet: ['Hummingbird-XT-5B.safetensors', 'wan2.2-alt.safetensors'], unetGguf: ['wan.gguf'] }

ok('在清单里 → 采纳', persistVideoModelChoice({ val: 'wan2.2-alt.safetensors', wf, log }) === true)
ok('落盘 uiState.unetVideo', JSON.parse(await import('node:fs').then((m) => m.readFileSync(path.join(home, 'qwen-paint-ui.json'), 'utf8'))).unetVideo === 'wan2.2-alt.safetensors')
ok('activeVideoUnet 读到界面选择', activeVideoUnet() === 'wan2.2-alt.safetensors')

ok('不在清单 → 拒绝（不落盘）', persistVideoModelChoice({ val: '../evil.safetensors', wf, log }) === false)
ok('拒绝后 uiState.unetVideo 不变', activeVideoUnet() === 'wan2.2-alt.safetensors')

ok('空串 → 清除（回到已验默认）', persistVideoModelChoice({ val: '', wf, log }) === true)
ok('清除后 activeVideoUnet 回落 WAN_ASSETS.unet', activeVideoUnet() === WAN_ASSETS.unet)
ok('探测失败（wf=null）→ 拒绝非空值', persistVideoModelChoice({ val: 'wan2.2-alt.safetensors', wf: null, log }) === false)

// ---- ⑤ 三段选中态映射（报障核心：hybrid 不再恒空）----
console.log('modelChoicesFrom：三段各自选中态')
const choices = modelChoicesFrom(
  { mainModelOverride: 'qwen-image.safetensors' },
  { unet: 'from-ui.safetensors', unetVideo: 'wan.safetensors', ttsBackend: 'gpt_sovits_v5_turbo', ttsVoiceSample: 'sample:v1' })
ok('image 段取 uiState.unet（与 mainmodel 镜像一致）', choices.image === 'from-ui.safetensors')
ok('video 段取 uiState.unetVideo', choices.video === 'wan.safetensors')
ok('hybrid 段回显 mainModelOverride（旧代码这里恒空）', choices.hybrid === 'qwen-image.safetensors')
ok('tts_backend 段取落盘后端', choices.tts_backend === 'gpt_sovits_v5_turbo')
ok('tts_voice_sample 段取落盘音色', choices.tts_voice_sample === 'sample:v1')
const emptyChoices = modelChoicesFrom({}, {})
ok('无配置时 tts_backend 回落默认后端', emptyChoices.tts_backend === DEFAULT_TTS_BACKEND)
ok('无配置时 tts_voice_sample 为空串', emptyChoices.tts_voice_sample === '')

// ---- ⑥ TTS 后端白名单 + 落盘（安全：拒未知后端 / 拒路径形态音色）----
console.log('persistTtsChoice：白名单 + 音色令牌校验')
ok('已知后端全部放行', TTS_BACKENDS.every((b) => isKnownTtsBackend(b.id)))
ok('空后端放行（= 回默认）', isKnownTtsBackend(''))
ok('未知后端拒绝', isKnownTtsBackend('evil_backend') === false)
const ttsHome = mkdtempSync(path.join('K:/ai/tmp', 'dsh-tts-'))
process.env.DSH_HOME = ttsHome
const tlogs = []
const tlog = (lvl, msg) => tlogs.push(`${lvl}:${msg}`)
// 同步读，避免顶层 await 嵌套
const { readFileSync } = await import('node:fs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readUiSync = () => JSON.parse(readFileSync(path.join(ttsHome, 'qwen-paint-ui.json'), 'utf8'))

ok('合法后端+音色落盘', persistTtsChoice({ backend: 'gpt_sovits_v5_dev', voiceSample: 'sample:v1', log: tlog }).ok === true)
ok('落盘 backend', readUiSync().ttsBackend === 'gpt_sovits_v5_dev')
ok('落盘 ttsVoiceSample', readUiSync().ttsVoiceSample === 'sample:v1')
ok('未知后端拒绝 + 不改盘', persistTtsChoice({ backend: 'evil', voiceSample: '', log: tlog }).ok === false
  && readUiSync().ttsBackend === 'gpt_sovits_v5_dev')
ok('路径形态音色拒绝（防手拼 URL 塞路径）', persistTtsChoice({ backend: 'qwen3_tts', voiceSample: '../x.wav', log: tlog }).ok === false)
ok('空后端+空音色 → 清除两键', persistTtsChoice({ backend: '', voiceSample: '', log: tlog }).ok === true
  && readUiSync().ttsBackend === undefined && readUiSync().ttsVoiceSample === undefined)

// ---- ⑦ 端点在线形状补 TTS 候选 ----
console.log('model-options 端点：TTS 候选随 /object_info 真机清单')
const richInfo = {
  ...OPTS(['m1.safetensors']),
  FB_Qwen3TTSVoiceClone: { input: { required: {} } },
  SaveAudioMP3: { input: { required: {} } },
}
await mkHandler(richInfo)({ local: true, method: 'GET' }, {})
ok('端点返回 selected 三段键（含 hybrid）',
  ['image', 'video', 'hybrid', 'tts_backend', 'tts_voice_sample'].every((k) => typeof last.body.selected[k] === 'string'))
ok('端点返回 tts_backends 清单（数组，含 available 字段）',
  Array.isArray(last.body.tts_backends) && last.body.tts_backends.length === TTS_BACKENDS.length
  && typeof last.body.tts_backends[0].available === 'boolean')
ok('端点返回 tts_voices 清单（数组）', Array.isArray(last.body.tts_voices))
ok('nodeNamesOf 从 object_info 节点名提取（用于后端探测）',
  nodeNamesOf(richInfo).includes('FB_Qwen3TTSVoiceClone'))
ok('listTtsBackends 认出 qwen3_tts 内置可用', listTtsBackends({ installed: nodeNamesOf(richInfo) }).find((b) => b.id === 'qwen3_tts').available === true)

// ---- ⑧ 源码接线：status 权重校验优先复用全量缓存，拿不到才回退 probeCapabilities ----
console.log('status 权重校验：缓存复用接线（防孤儿）')
{
  const idxSrc = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  ok('index.js import weightFilesFromObjectInfo',
    /weightFilesFromObjectInfo,?\s*\} from '\.\/comfy-catalog\.js'/u.test(idxSrc))
  ok('status handler 先取全量 objectInfo 缓存再 weightFilesFromObjectInfo',
    /loadObjectInfoFor\(cfg, null\)[\s\S]{0,120}weightFilesFromObjectInfo\(info\)/u.test(idxSrc))
  ok('拿不到（wf === null）才回退 probeCapabilities（白名单不松）',
    /if \(wf === null\) \{\s*const caps = await probeCapabilities\(cfg, log, null\)/u.test(idxSrc))
  ok('comfy-catalog 零漂移：仍导出全量缓存入口 loadObjectInfo',
    /export async function loadObjectInfo\(/u.test(readFileSync(path.join(ROOT, 'lib', 'comfy-catalog.js'), 'utf8')))
}

rmSync(ttsHome, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
