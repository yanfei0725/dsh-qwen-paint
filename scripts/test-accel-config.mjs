#!/usr/bin/env node
/**
 * test-accel-config.mjs —— 加速后端 / TTS 适配 / 配置矛盾 / Agent 指引 / 外置接线回归。
 * 全离线。锁住「诚实边界」：未探测到就不启用、MRFOW 永不自动启用、
 * 用户资料的性能倍率不写进代码结论、换语言不执行、体积红线与清单逐项对齐。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CACHE_BACKENDS, TERM_CANDIDATES, pickCacheBackends, buildCachePatch, buildAssemblyPlan } from '../lib/cache-backends.js'
import { TTS_ACCEL_BACKENDS, pickTtsAccel, ttsAccelToWorkflowPatch } from '../lib/tts-accel.js'
import {
  VRAM_MODE_SET, VRAM_LADDER_SUBSET, RAM_SEMANTICS, WRAPPER_POLICIES,
  resolveWrapperChoice, detectConfigConflicts, normalizeConfig, summarizeConflicts,
} from '../lib/config-consistency.js'
import { TOOL_HINTS, AGENT_PLAYBOOKS, buildAgentGuide } from '../lib/agent-guide.js'
import { EXTRA_TOOL_NAMES, createExtras } from '../lib/tool-registry.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'
import { ASSET_ROUTES } from '../lib/asset-route.js'
import { TOOL_SUMMARIES } from '../lib/tool-descriptions.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, extra ?? '') }
}
const NUMBERS = /\d+(\.\d+)?\s*(倍|%|ms|RTF)|2\.67|5\.6|7\.1|355|248/u

console.log('=== 1. 缓存后端：探测才启用，MRFOW 永不自动启用 ===')
{
  ok('注册表含 6 项', CACHE_BACKENDS.length === 6)
  ok('kv_prefix 标已有实现', CACHE_BACKENDS.find((b) => b.id === 'kv_prefix').available === 'existing')
  const mrfow = CACHE_BACKENDS.find((b) => b.id === 'mrfow')
  ok('★ mrfow 明写术语未核实', mrfow.label.includes('未核实') && mrfow.unverified === true)
  ok('★ mrfow 默认禁用', mrfow.enabled === false)
  // ★ 2026-11-15：公开检索只命中 MrFlow（多分辨率流匹配，arXiv 2607.01642），
  //   语境吻合但**未经用户确认** —— 固化成可核查的候选来源，仍永不自动启用。
  ok('★ mrfow 已给出可核查候选来源（MrFlow / arXiv 2607.01642）',
    TERM_CANDIDATES.mrfow.candidate.includes('MrFlow')
    && TERM_CANDIDATES.mrfow.paper.includes('2607.01642'))
  ok('★ 候选仍标用户未确认，并逐条列明还缺什么',
    TERM_CANDIDATES.mrfow.confirmedByUser === false
    && TERM_CANDIDATES.mrfow.missing.length >= 4)
  ok('★ 注册表与候选来源都不夹带社区倍率数字',
    !NUMBERS.test(JSON.stringify(CACHE_BACKENDS))
    && !NUMBERS.test(JSON.stringify(TERM_CANDIDATES)))
  ok('★ 装配计划把候选来源带出来（能查到「还差什么」）',
    buildAssemblyPlan({}).steps.find((s) => s.id === 'mrfow').candidate !== null)
  ok('TeaCache / FBCache / MagCache 都标 unverified',
    ['teacache', 'fbcache', 'magcache'].every((id) => CACHE_BACKENDS.find((b) => b.id === id).unverified === true))

  const none = pickCacheBackends({ installed: [] })
  ok('★ 零探测时降级且 selected 空', none.degraded === true && none.selected.length === 0)
  ok('★ 降级理由是固定文案、不含倍率', !NUMBERS.test(none.fallbackReason || ''))
  const one = pickCacheBackends({ installed: ['QwenImage21Cache'], kind: 'image', steps: 8 })
  ok('探测到 KV 前缀缓存才启用', one.selected.some((b) => b.id === 'kv_prefix'))
  ok('未探测到的 TeaCache 不启用', !one.selected.some((b) => b.id === 'teacache'))
  const video = pickCacheBackends({ installed: ['TeaCache', 'QwenImage21Cache'], kind: 'video', steps: 20 })
  ok('★ image-only 的 kv_prefix 不会进视频链', !video.selected.some((b) => b.id === 'kv_prefix'))
  const low = pickCacheBackends({ installed: ['TeaCache'], kind: 'video', steps: 4 })
  ok('★ 步数低于阈值不启用跳步缓存', low.selected.length === 0 && low.degraded === true)
  const pref = pickCacheBackends({ installed: ['TeaCache', 'FirstBlockCache'], kind: 'video',
    steps: 30, preferred: ['FirstBlockCache'] })
  ok('preferred 优先', pref.selected[0].id === 'fbcache')
  ok('★ 同组互斥（不会同时上 TeaCache 与 FBCache）',
    !(pref.selected.some((b) => b.id === 'fbcache') && pref.selected.some((b) => b.id === 'teacache')))
  const forced = pickCacheBackends({ installed: ['mrfow'], preferred: ['mrfow'], steps: 50 })
  ok('★ 即使显式指定，mrfow 也不启用', !forced.selected.some((b) => b.id === 'mrfow'))
  const patch = buildCachePatch(pref)
  ok('patch 是纯数据且含加速链名', patch.accel_chain.includes('fbcache'))
  ok('★ patch 不含任何倍率数字', !NUMBERS.test(JSON.stringify(patch)))
}

console.log('=== 2. TTS 加速：非 N 卡兜底、不承诺倍率 ===')
{
  ok('5 个后端全部标 unverified', TTS_ACCEL_BACKENDS.length === 5
    && TTS_ACCEL_BACKENDS.every((b) => b.unverified === true))
  ok('源码不含用户提供的倍率数字', !NUMBERS.test(read('lib/tts-accel.js')))
  const none = pickTtsAccel({ installed: [] })
  ok('★ 零探测时降级', none.degraded === true && none.selected.length === 0)
  const amd = pickTtsAccel({ installed: ['tts_gguf', 'vocoder_fp16'], gpuVendor: 'AMD' })
  ok('★ 非 N 卡走 GGUF 兜底', amd.selected.includes('gguf'))
  ok('★ 非 N 卡不启用 CUDA Graph', !amd.selected.includes('cuda_graph'))
  const nv = pickTtsAccel({ installed: ['tts_cuda_graph', 'tts_triton'], gpuVendor: 'NVIDIA', vramMb: 16384 })
  ok('N 卡可叠加为 hybrid', nv.hybrid === true && nv.selected.includes('cuda_graph'))
  const lowVram = pickTtsAccel({ installed: ['tts_cuda_graph'], gpuVendor: 'NVIDIA', vramMb: 1024 })
  ok('★ 显存预算不足时降级 CUDA Graph', !lowVram.selected.includes('cuda_graph'))
  const stream = pickTtsAccel({ installed: ['tts_streaming'], wantStreaming: true })
  ok('wantStreaming 才启用流式', stream.selected.includes('streaming'))
  ok('未请求流式时不启用', !pickTtsAccel({ installed: ['tts_streaming'] }).selected.includes('streaming'))
  const long = pickTtsAccel({ installed: ['tts_cuda_graph'], gpuVendor: 'NVIDIA', textLength: 4000 })
  ok('长文本给 maxSeqLenHint 提示', Number.isFinite(long.maxSeqLenHint))
  const patch = ttsAccelToWorkflowPatch({ ...nv, selected: [...nv.selected, 'vocoder_fp16', 'streaming'] })
  ok('声码器 fp16 是可配置字段', patch.config.vocoder_mel_dtype === 'float16')
  ok('★ patch 不含任何倍率数字', !NUMBERS.test(JSON.stringify(patch)))
}

console.log('=== 3. 配置矛盾统一裁决 ===')
{
  ok('显存完整枚举六档', VRAM_MODE_SET.length === 6
    && ['standard', 'cpu'].every((m) => VRAM_MODE_SET.includes(m)))
  ok('降级阶梯是四档子集', VRAM_LADDER_SUBSET.length === 4
    && VRAM_LADDER_SUBSET.every((m) => VRAM_MODE_SET.includes(m)))
  ok('★ 同名 ram 两种语义被显式区分',
    RAM_SEMANTICS.cache === 'gpu-resident-cache' && RAM_SEMANTICS.vram === 'cpu-resident-weights')
  ok('策略枚举三种', WRAPPER_POLICIES.join(',') === 'auto,te,bc')
  const small = resolveWrapperChoice({ teSpeedEnabled: true, speedupEnabled: true,
    blockCacheEnabled: true }, 512, 512)
  ok('小尺寸自动选 TE', small.wrapper === 'te' && small.enabledFlags.length === 3)
  const big = resolveWrapperChoice({}, 2048, 2048)
  ok('大尺寸选 BlockCache', big.wrapper === 'bc')
  const forcedBc = resolveWrapperChoice({ wrapperPolicy: 'bc', blockCacheEnabled: false }, 512, 512)
  ok('★ 想用 BC 但被关掉时明确退回 TE', forcedBc.wrapper === 'te' && forcedBc.reason.includes('退回'))
  const conflicts = detectConfigConflicts({ teSpeedEnabled: true, speedupEnabled: true,
    blockCacheEnabled: true, vramMode: 'nope', wrapperPolicy: 'bad' })
  ok('★ 三开关全开被识别为「易误解」而非 bug',
    conflicts.some((c) => c.id === 'wrapper_flags' && c.severity === 'info'))
  ok('★ 非法 vramMode / wrapperPolicy 被标 warn', conflicts.filter((c) => c.severity === 'warn').length === 2)
  const norm = normalizeConfig({ vramMode: 'nope', wrapperPolicy: 'bad', progressMode: 'loud' })
  ok('归一后回到合法值', norm.cfg.vramMode === 'auto' && norm.cfg.wrapperPolicy === 'auto'
    && norm.cfg.progressMode === 'brief')
  ok('归一不改原对象', conflicts.length > 0)
  ok('摘要是一行', typeof summarizeConflicts({}) === 'string')
}

console.log('=== 4. Agent 能力指引 ===')
{
  // ★ 判据升级：硬编码「19 个工具 / 5 条剧本」在新增 convert_media 后必然过期。
  //   改成集合逐字相等 + 新能力必须有编排剧本：新增工具漏接线会红，数量变化不再误报。
  ok('提示键集合逐字等于 TOOL_SUMMARIES（新增工具漏写提示就红）',
    Object.keys(TOOL_HINTS).slice().sort().join(',')
      === Object.keys(TOOL_SUMMARIES).slice().sort().join(','))
  ok('每个提示都有 when/params/fallback',
    Object.values(TOOL_HINTS).every((h) => h.when && h.params && h.fallback))
  ok('剧本步骤全为真实工具名，且新能力 convert_media 有编排剧本',
    AGENT_PLAYBOOKS.length >= 5
    && AGENT_PLAYBOOKS.every((p) => p.steps.length > 0 && p.steps.every((s) => s in TOOL_HINTS))
    && AGENT_PLAYBOOKS.some((p) => p.steps.includes('convert_media')))
  const guide = buildAgentGuide({ tools: Object.keys(TOOL_HINTS), routes: INTEGRATION_ROUTES })
  ok('全部工具都有提示（undocumented 为空）', guide.undocumented.length === 0)
  ok('端点目录被带出', guide.endpoints.length === INTEGRATION_ROUTES.length)
  ok('规则里写明「探测不到就降级」与隐私', guide.rules.some((r) => r.includes('降级'))
    && guide.rules.some((r) => r.includes('绝对路径')))
}

console.log('=== 5. 外置接线与体积红线 ===')
{
  const extras = createExtras({ log: () => {} })
  ok('★ 外置工具全部构造成功（数量由 EXTRA_TOOL_NAMES 推导）',
    extras.tools.length === EXTRA_TOOL_NAMES.length && extras.tools.length > 0)
  ok('工具名与 EXTRA_TOOL_NAMES 逐字一致',
    extras.names.slice().sort().join(',') === [...EXTRA_TOOL_NAMES].slice().sort().join(','))
  ok('每个工具形状齐全（description / schema / execute / timeoutMs）',
    extras.tools.every((t) => typeof t.description === 'string' && t.description.length > 30
      && t.output?.schema?.properties && Object.keys(t.output.schema.properties).length >= 4
      && typeof t.execute === 'function' && Number.isFinite(t.timeoutMs) && t.timeoutMs > 0))
  ok('★ 工具名都在 TOOL_SUMMARIES 里', extras.names.every((n) => n in TOOL_SUMMARIES))
  // ★ 白名单显式登记：11 → 12（加速链）→ 15（结构化日志 / 显存预算 / 配置矛盾）
  //   → 17（媒体格式转换 convert / formats）。判据始终是「集合逐字相等」，
  //   数量与标题都不写死；新增端点必须显式写进这份清单，漏一条就红。
  const NEW_ROUTE_PATHS = [
    '/api/qwen-paint/media/gif', '/api/qwen-paint/media/gif/capabilities',
    '/api/qwen-paint/media/convert', '/api/qwen-paint/media/formats',
    '/api/qwen-paint/history/query', '/api/qwen-paint/history/update',
    '/api/qwen-paint/history/restore', '/api/qwen-paint/history/purge',
    '/api/qwen-paint/history/archive', '/api/qwen-paint/history/hard-delete',
    '/api/qwen-paint/history/export.jsonl', '/api/qwen-paint/doctor',
    '/api/qwen-paint/agent-guide', '/api/qwen-paint/accel/chain',
    '/api/qwen-paint/events', '/api/qwen-paint/vram-budget',
    '/api/qwen-paint/config/conflicts',
    // ★ 2026-11-15 本地能力批次（未发布）：TTS 后端 / 音频样本 / 音乐 BGM / 手动超分 / Worker
    '/api/qwen-paint/tts/backends', '/api/qwen-paint/audio/samples',
    '/api/qwen-paint/music/models', '/api/qwen-paint/music/generate',
    '/api/qwen-paint/upscale/manual/capabilities', '/api/qwen-paint/upscale/manual',
    '/api/qwen-paint/vectorize', '/api/qwen-paint/vectorize/capabilities',
    '/api/qwen-paint/asr/status',
    '/api/qwen-paint/av/stitch', '/api/qwen-paint/av/stitch/capabilities',
    '/api/qwen-paint/pptx',
    '/api/qwen-paint/workers', '/api/qwen-paint/workers/vram',
    '/api/qwen-paint/accel/backends',
    // ★ 2026-11-15 收尾：三个孤儿模块接线后的端点（口语入口 / 参考图色调 / 资源需求声明）
    '/api/qwen-paint/entry/aliases', '/api/qwen-paint/tone/extract',
    '/api/qwen-paint/run/resources',
    // ★ 2026-11-16 内置最小实现：媒体后处理四端点（能力探测 + 三执行）
    '/api/qwen-paint/media-fx/capabilities', '/api/qwen-paint/enhance/audio',
    '/api/qwen-paint/cutout/image', '/api/qwen-paint/split/audio',
    // ★ 2026-11-16：音频转文字 2 端点。
    '/api/qwen-paint/audio/transcribe/capabilities', '/api/qwen-paint/audio/transcribe',
    // ★ 2026-11-18 未发布批次：人物替换 3 端点（能力发现 / 素材登记 / CPU 预演合成）。
    '/api/qwen-paint/portrait/capabilities', '/api/qwen-paint/portrait/register',
    '/api/qwen-paint/portrait/compose',
    // ★ 2026-11-19 未发布批次：视频后处理 + 社区能力只读发现。
    '/api/qwen-paint/video/trim-crop', '/api/qwen-paint/video/prores-export',
    '/api/qwen-paint/community/probe',
  ]
  ok('★ 端点集合逐字等于白名单（新增端点必须显式登记）',
    extras.routes.map((r) => r.path).sort().join(',') === [...NEW_ROUTE_PATHS].sort().join(','),
    extras.routes.map((r) => r.path).sort().join(','))
  ok('端点路径互不重复', new Set(extras.routes.map((r) => r.path)).size === extras.routes.length)
  const dirPaths = new Set(INTEGRATION_ROUTES.map((r) => r.path))
  ok('★ 每条新端点都在对外目录里（漏一条 product-round 会红）',
    extras.routes.every((r) => dirPaths.has(r.path)))
  ok('★ 白名单里每条端点都有真实注册',
    NEW_ROUTE_PATHS.every((p) => extras.routes.some((r) => r.path === p)))
  ok('静态资源表含 lab.js / lab.css',
    ASSET_ROUTES.some(([, f]) => f === 'lab.js') && ASSET_ROUTES.some(([, f]) => f === 'lab.css'))

  const sizeIndex = Buffer.byteLength(read('lib/index.js'), 'utf8')
  const sizeClient = Buffer.byteLength(read('lib/client.js'), 'utf8')
  ok('★ index.js 未爆单文件红线（262144）', sizeIndex <= 262144, '实际 ' + sizeIndex)
  ok('★ index.js 比接线前更小（拆分真的减压了）', sizeIndex < 262125, '实际 ' + sizeIndex)
  ok('★ client.js 未爆单文件红线（262144）', sizeClient <= 262144, '实际 ' + sizeClient)
  // 旧判据锁死 ===261467；外置设计注释后合理下降，改为语义护栏：关键功能符号仍在 + 外置锚点可追溯
  const clientSrc = read('lib/client.js')
  ok('★ client.js 外置注释后关键功能符号仍在（防误删代码）',
    ['openInpaintDialog', 'openWorkbench', 'openVideoTimeline', 'loadComfyPipelinePanel']
      .every((s) => clientSrc.includes('function ' + s + '('))
    && clientSrc.includes('PANEL_JS_ID') && clientSrc.includes('makeFlowNode'))
  const anchors = clientSrc.match(/client-note-\d{3}/gu) ?? []
  const docNotes = read('docs/client-design-notes.md')
  ok('★ client.js 外置锚点逐个可追溯到文档（防注释丢失/路径错）',
    anchors.length > 0 && anchors.every((a) => docNotes.includes('### ' + a)),
    '锚点 ' + anchors.length + ' 个')
  const libTotal = fs.readdirSync(path.join(ROOT, 'lib'))
    .filter((f) => f.endsWith('.js'))
    .reduce((n, f) => n + fs.statSync(path.join(ROOT, 'lib', f)).size, 0)
  ok('★ lib/ 合计未爆 2 MB 红线', libTotal <= 2097152, '实际 ' + libTotal)
  ok('prepack 体积守卫存在', fs.existsSync(path.join(ROOT, 'scripts/check-size.mjs')))

  const selftest = read('scripts/selftest.mjs')
  ok('★ selftest 已登记全部外置工具', extras.names.every((n) => selftest.includes("'" + n + "'")))
  ok('index.js 只留一行外置接线', (read('lib/index.js').match(/registerExtras\(/gu) || []).length === 1)
  ok('index.js 没有逐个 import 新工具',
    !read('lib/index.js').includes("from './gif-tool.js'"))
  ok('★ 设计要点注释确实搬到外置注册表（没丢）',
    read('lib/tool-registry.js').includes('空闲自动关停 ComfyUI'))
}

// ★ 2026-11-18（社区调研 A 类）：doctor 探针真注入回归。
// 诚实口径：能真检测的接上，检测不了的保持 undetected，绝不假装 pass。
{
  const extras = createExtras({
    log: () => {},
    cfg: { comfyUrl: 'http://127.0.0.1:8188' },
    outputDir: '',
    objectInfoProbe: async () => ({
      ok: true, reason: '',
      nodes: ['QwenImage21Cache', 'TESpeedQwenImage21', 'SageAttention', 'TextEncodeQwenImage21'],
    }),
    probes: { ffmpeg: async () => ({ ok: true, detail: 'ffmpeg 可用（测试注入）' }) },
  })
  ok('★ doctor 注入了 6 个探针（原 2 + 新 4）',
    ['comfyOnline', 'accelPacks', 'attentionBackend', 'ffmpeg', 'historyDb', 'outputDir']
      .every((k) => typeof extras.probes[k] === 'function'),
    Object.keys(extras.probes).join(','))
  const doctor = extras.tools.find((t) => t.name === 'doctor')
  ok('doctor 工具已注册', Boolean(doctor))
  if (doctor) {
    const r = await doctor.execute({ detail: true })
    const report = r.summary ? r : (r.output ?? {})
    const details = report.details ?? []
    const byId = new Map(details.map((d) => [d.id, d]))
    ok('comfy_online 真检测为 pass', byId.get('comfy_online')?.status === 'pass',
      JSON.stringify(byId.get('comfy_online')))
    ok('accel_packs 真检测为 pass 且报出节点名',
      byId.get('accel_packs')?.status === 'pass'
      && String(byId.get('accel_packs')?.detail).includes('QwenImage21Cache'))
    ok('ffmpeg 真检测为 pass', byId.get('ffmpeg')?.status === 'pass')
    ok('★ attention_backend 只报未检测（没验证显卡匹配就不假装 pass）',
      byId.get('attention_backend')?.status === 'undetected'
      && String(byId.get('attention_backend')?.detail).includes('未验证'),
      JSON.stringify(byId.get('attention_backend')))
    ok('★ model_integrity / tts_backend 仍老实标未检测',
      byId.get('model_integrity')?.status === 'undetected'
      && byId.get('tts_backend')?.status === 'undetected')
    ok('无外部能力时报告不谎称 pass（undetected 诚实保留）',
      report.checked === 8
      && details.filter((d) => d.status === 'undetected').length >= 2
      && /项待检查/u.test(String(report.summary)))
    ok('★ doctor 报告带 probe_contract（每项 needs / injected 状态可见）',
      Array.isArray(report.probe_contract) && report.probe_contract.length === 8
      && report.probe_contract.every((p) => typeof p.injected === 'boolean'))
  }
}

console.log(`=== test-accel-config：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
