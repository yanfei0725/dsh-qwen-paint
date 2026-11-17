/**
 * lib/creative-extras.js —— 本批次 4 个工具 + 8 条端点的统一出口。
 *
 * 覆盖：TTS 后端选择（GPT-SoVITS v5 dev/turbo、IndexTTS2）、拖入音频样本、
 * 音乐 BGM（ACE-Step 1.5 / YuE2）、手动超分、主控端 + Worker 生命周期。
 *
 * ## 诚实边界
 *   所有第三方模型的节点 / 权重 / 依赖都**未被声明为已安装**；能力靠
 *   「模式发现 + 注入探针」，探测不到就 degraded + 明确理由。
 *   本文件不真提交 ComfyUI、不创建 venv / conda / Docker、不 pip install、不下载
 *   权重、不训练模型；唯一例外是 Vulkan 直跑超分引擎（lib/vulkan-upscale.js）——
 *   它按用户显式 engine 参数调用**本机已安装**的 ncnn-vulkan 可执行文件，
 *   未安装时如实降级，绝不自动下载、绝不谎称已放大。
 *
 * ## 安全
 *   仅本机请求、写操作要求 POST + guardWriteRequest、有界 readJsonBody；
 *   路径全部围栏；异常只写本机日志、回固定文案，绝不回吐 error.message。
 */
import { TTS_BACKENDS, DEFAULT_TTS_BACKEND, listTtsBackends, pickTtsBackend } from './tts-backends.js'
// ★ 外部 TTS 服务清单（GSV.CPP MIT / AnifLive 禁商用）：只做发现+引导，不捆绑代码/权重
import { listExternalTtsServices, probeExternalTts } from './tts-lowlatency.js'
import { getAudioSampleStore, AUDIO_SAMPLE_FORMATS, MAX_SAMPLE_BYTES } from './audio-sample.js'
import { MUSIC_MODELS, BGM_PRESETS, listMusicModels, buildMusicPlan } from './music-models.js'
// ★ BGM 优化：音乐计划缓存 + 装配计划（缓存命中省掉重复规划/探测；写失败吞掉降级）
import { MUSIC_PLAN_CACHE_DIR, musicPlanFingerprint, readPlanCache, writePlanCache, buildBgmAssemblyPlan } from './bgm-opt.js'
import fsp from 'node:fs/promises'
import nodePath from 'node:path'
import { createHash } from 'node:crypto'
import { listUpscaleEngines, buildManualUpscalePlan, MANUAL_SCALE_CHOICES } from './manual-upscale.js'
import { detectVulkanEngines, runVulkanUpscale, VULKAN_ENGINE_IDS } from './vulkan-upscale.js'
import { makeWorkerManager } from './worker-manager.js'
// ★ 通用注意力 / 编译加速后端：SageAttention（8-bit 注意力）、Comfy-WaveSpeed。
//   倍率数字一律 unverified，只从真实节点表模式发现，未探测到明确降级。
import { ATTENTION_BACKENDS, listAttentionBackends, pickAttentionBackends } from './attention-backends.js'
import { buildAttentionWorkflowPatch } from './attention-workflow.js'
import {
  WORKER_PROTOCOL_VERSION, listWorkerAdapters, normalizeWorkerInput,
  normalizeWorkerOutput, adaptWorkerInput,
} from './worker-protocol.js'

export const CREATIVE_TOOL_NAMES = Object.freeze([
  'list_tts_backends', 'generate_music', 'manual_upscale', 'manage_workers',
])

export const CREATIVE_ROUTE_PATHS = Object.freeze([
  '/api/qwen-paint/tts/backends',
  '/api/qwen-paint/audio/samples',
  '/api/qwen-paint/music/models',
  '/api/qwen-paint/music/generate',
  '/api/qwen-paint/upscale/manual/capabilities',
  '/api/qwen-paint/upscale/manual',
  '/api/qwen-paint/workers',
  '/api/qwen-paint/workers/vram',
  '/api/qwen-paint/accel/backends',
])

const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const STR = { type: 'string' }
const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const ARR = { type: 'array', items: { type: 'object' } }
const OBJ = { type: 'object' }

/** 共享上下文：样本库 / Worker 管理器都按 outputDir 做单例，端点与工具拿同一份。 */
export function createCreativeContext(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const samples = deps.audioSampleStore || getAudioSampleStore(outputDir)
  const workers = deps.workerManager || makeWorkerManager({
    spawn: deps.spawn, kill: deps.kill, fetch: deps.workerFetch,
    vramProbe: deps.vramProbe, now: deps.now, log: deps.log,
  })
  // ★ cfg 是宿主配置对象的引用：加速后端的「启用」只写进程内存（重启回默认），
  //   与面板里「参考策略」同口径；不落盘、不改 index.js、不动配置白名单。
  return { outputDir, samples, workers, installed: deps.installed || {},
    sourceDirs: deps.sourceDirs || [], cfg: deps.cfg || null }
}

/* ---------------------------------- 工具 ---------------------------------- */

export function makeTtsBackendsTool(deps = {}) {
  const ctx = deps.creativeContext || createCreativeContext(deps)
  return {
    name: 'list_tts_backends',
    description: '列出可选的 TTS 后端（Qwen3-TTS / GPT-SoVITS v5 原版 dev / 蒸馏版 turbo / IndexTTS2）'
      + '及每个后端在本机的真实探测状态；另列可外接的低延迟服务（GSV.CPP / AnifLive-TTS，'
      + '只给清单与引导、不捆绑代码与权重）。用户要换语音模型、或 generate_speech 想指定 backend 时先用它；'
      + '未检测到节点会明确标 available:false 并给安装提示，绝不假装可用。',
    parameters: schemaOf({
      installed: OBJ,
      requested: STR,
    }),
    timeoutMs: 30 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, backends: ARR, external_services: ARR, default_backend: STR, selected: OBJ,
      degraded: BOOL, reason: STR,
    }) },
    async execute(args = {}) {
      const installed = args?.installed && typeof args.installed === 'object' ? args.installed : ctx.installed
      const backends = listTtsBackends({ installed })
      const requested = String(args?.requested ?? '').trim()
      const pick = requested ? pickTtsBackend({ requested, installed, hasReferenceAudio: false }) : null
      return {
        ok: true,
        backends,
        external_services: listExternalTtsServices(),
        default_backend: DEFAULT_TTS_BACKEND,
        selected: pick ? { id: pick.selected?.id ?? '', ok: pick.ok, reasons: pick.reasons } : {},
        degraded: pick ? pick.degraded : false,
        reason: '',
      }
    },
  }
}

export function makeMusicTool(deps = {}) {
  const ctx = deps.creativeContext || createCreativeContext(deps)
  return {
    name: 'generate_music',
    description: '音乐 BGM 板块：选择 ACE-Step 1.5 或 YuE2，按统一输入（prompt / 时长 / 歌词 / 风格）'
      + '生成**可审阅的参数计划**。不真提交 ComfyUI、不真生成音频、不自动下载权重；'
      + '未探测到对应节点时 degraded=true 并给安装提示。要真出音频需自备 Worker 并在 manage_workers 里配置。',
    parameters: schemaOf({
      model: STR, prompt: STR, lyrics: STR, duration_sec: NUM, bpm: NUM,
      style: STR, vocal: BOOL, seed: NUM, preset: STR, variant: STR,
    }),
    timeoutMs: 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, model: STR, plan: OBJ, degraded: BOOL,
      reasons: { type: 'array', items: { type: 'string' } },
      reason: STR, unverified: BOOL,
    }) },
    async execute(args = {}) {
      // ★ BGM 优化①：音乐参数计划内容缓存。同 prompt/bpm/seed/时长/节点集合命中即复用，
      //   连 buildMusicPlan 的重复规划都省；缓存是增强，读写失败一律静默降级到真实规划。
      const useCache = deps.musicPlanCache !== false
      const detectedNodes = Array.isArray(ctx.installed?.nodes)
        ? ctx.installed.nodes.map(String)
        : (ctx.installed && typeof ctx.installed === 'object'
            ? Object.keys(ctx.installed).filter((k) => ctx.installed[k] !== false)
            : [])
      const key = useCache
        ? musicPlanFingerprint(createHash, { model: args?.model, prompt: args?.prompt, negPrompt: args?.neg_prompt,
            bpm: args?.bpm, seed: args?.seed, durationSec: args?.duration_sec,
            segmentId: args?.segment_id, loopAllowed: args?.loop_allowed, quality: args?.quality, nodes: detectedNodes })
        : ''
      const cacheFile = (key && ctx.outputDir)
        ? nodePath.join(String(ctx.outputDir), MUSIC_PLAN_CACHE_DIR, key + '.json') : ''
      const cached = await readPlanCache(fsp, nodePath, cacheFile)
      if (cached) return { ...cached, cached: true }
      const r = buildMusicPlan({ model: args?.model, installed: ctx.installed, params: args })
      const result = {
        ok: r.ok,
        model: r.plan?.model ?? '',
        plan: r.plan ?? {},
        degraded: r.degraded,
        reasons: r.reasons ?? [],
        reason: r.reasons?.join('；') ?? '',
        unverified: true,
      }
      if (cacheFile && r.ok) await writePlanCache(fsp, nodePath, cacheFile, key, result)
      return result
    },
  }
}

export function makeManualUpscaleTool(deps = {}) {
  const ctx = deps.creativeContext || createCreativeContext(deps)
  return {
    name: 'manual_upscale',
    description: '手动超分：用户显式指定引擎（auto / vosr2 / realesrgan / custom，或 Vulkan 直跑引擎 '
      + 'realesrgan-ncnn-vulkan / realcugan-ncnn-vulkan）、倍率、降噪 / 锐化 / 分块大小 / 自定义权重，'
      + '产出可审阅的工作流草案；Vulkan 引擎在已安装（cfg.vulkanUpscalePath）时真实执行（不经 ComfyUI），'
      + '未安装时只回参数预览并明确降级，绝不谎称已放大。',
    parameters: schemaOf({
      source: STR, target: STR, engine: STR, scale: NUM, model: STR,
      denoise: NUM, sharpen: NUM, tile_size: NUM, vae_tile_size: NUM, seed: NUM,
      gpu_id: NUM, format: STR,
    }),
    timeoutMs: 10 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, plan: OBJ, executed: BOOL, output_path: STR,
      degraded: BOOL, reason: STR, note: STR, run: OBJ,
    }) },
    async execute(args = {}) {
      const r = buildManualUpscalePlan({
        source: args?.source, target: args?.target, engine: args?.engine,
        scale: args?.scale, model: args?.model, denoise: args?.denoise,
        sharpen: args?.sharpen, tileSize: args?.tile_size,
        vaeTileSize: args?.vae_tile_size, seed: args?.seed,
        outputDir: ctx.outputDir, sourceDirs: ctx.sourceDirs, installed: ctx.installed,
      })
      // ★ Vulkan 直跑引擎是唯一真实执行路径：已安装 → 真跑；未安装 → 如实降级。
      const isVulkan = r.ok && VULKAN_ENGINE_IDS.includes(r.plan?.engine)
      const run = isVulkan
        ? await runVulkanUpscale({
            installDir: String(ctx.cfg?.vulkanUpscalePath ?? ''),
            engineId: r.plan.engine, sourcePath: r.sourcePath, outputPath: r.outputPath,
            params: { model: args?.model, scale: r.plan.scale, tileSize: r.plan.tile_size,
              gpuId: args?.gpu_id, format: args?.format, denoise: args?.denoise, sharpen: args?.sharpen },
            timeoutMs: 10 * 60 * 1000,
            log: (...a) => { try { deps.log?.('info', ...a) } catch { /* 忽略 */ } },
          })
        : null
      return {
        ok: run ? run.ok : r.ok,
        plan: r.plan ?? {},
        executed: Boolean(run?.executed),
        output_path: String(run?.path ?? ''),
        degraded: run ? (run.degraded === true || r.degraded === true) : r.degraded,
        reason: run ? (run.reason ?? r.reason ?? '') : (r.reason ?? ''),
        run: run ? { engine: run.engine ?? '', ms: run.ms ?? 0, notes: run.notes ?? [] } : {},
        note: run
          ? (run.executed ? 'Vulkan 直跑完成，产物已落盘（不经 ComfyUI）。' : 'Vulkan 执行未完成：' + (run.reason ?? ''))
          : '未注入真实执行器：只回参数预览，绝不谎称已放大或已落盘。',
      }
    },
  }
}

export function makeWorkerTool(deps = {}) {
  const ctx = deps.creativeContext || createCreativeContext(deps)
  const actions = ['list', 'preflight', 'start', 'stop', 'park', 'wake', 'evict',
    'enable', 'disable', 'configure', 'sweep', 'protocol']
  return {
    name: 'manage_workers',
    description: '主控端 + 独立 Worker 的生命周期管理：list / preflight（含显存预检）/ start / stop / '
      + 'enable / disable / configure / sweep / protocol。环境隔离（venv / conda / docker）只提供配置位，'
      + '插件绝不 pip install、不拉镜像、不下载权重；未注入 spawn / kill / vramProbe 时如实说未检测或未启动。'
      + '空闲超时自动终止释放显存，同一时刻默认只跑 1 个 Worker 防爆显存。',
    parameters: schemaOf({
      action: STR, id: STR, command: STR, env_path: STR, port: NUM,
      isolation: STR, idle_timeout_min: NUM, reason: STR,
      variant: STR, required_mb: NUM, hot_to_warm_min: NUM,
      warm_to_cold_min: NUM, prewarm: BOOL,
    }),
    timeoutMs: 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, action: STR, workers: ARR, worker: OBJ,
      preflight: OBJ, vram: OBJ, sweep: OBJ, reason: STR,
    }) },
    async execute(args = {}) {
      const action = String(args?.action ?? 'list').trim()
      if (!actions.includes(action)) {
        return { ok: false, action, workers: [], worker: {}, preflight: {}, vram: {}, sweep: {},
          reason: '未知 action：' + action + '；可选 ' + actions.join(' / ') }
      }
      const id = String(args?.id ?? '').trim()
      let result = null
      if (action === 'list') result = { ok: true, workers: ctx.workers.list() }
      else if (action === 'protocol') result = { ok: true, workers: listWorkerAdapters() }
      else if (action === 'preflight') result = { ok: true, preflight: await ctx.workers.preflight(id) }
      else if (action === 'start') result = await ctx.workers.start(id)
      else if (action === 'stop') result = await ctx.workers.stop(id, { reason: args?.reason })
      else if (action === 'park') result = await ctx.workers.park(id)
      else if (action === 'wake') result = await ctx.workers.wake(id)
      else if (action === 'evict') result = await ctx.workers.evictForBudget(args?.required_mb)
      else if (action === 'enable') result = ctx.workers.enable(id)
      else if (action === 'disable') result = ctx.workers.disable(id)
      else if (action === 'sweep') result = { ...(await ctx.workers.sweep()), workers: ctx.workers.list() }
      else if (action === 'configure') result = ctx.workers.configure(id, {
        command: args?.command, envPath: args?.env_path, port: args?.port,
        isolation: args?.isolation, idleTimeoutMin: args?.idle_timeout_min,
        variant: args?.variant, hotToWarmMin: args?.hot_to_warm_min,
        warmToColdMin: args?.warm_to_cold_min, prewarm: args?.prewarm,
      })
      return {
        ok: result?.ok === true,
        action,
        workers: Array.isArray(result?.workers) ? result.workers : [],
        worker: result?.row ?? {},
        preflight: result?.preflight ?? {},
        vram: result?.preflight?.vram ?? {},
        sweep: result?.stopped ? result : {},
        reason: String(result?.reason ?? ''),
      }
    },
  }
}

/* ---------------------------------- 端点 ---------------------------------- */

export function creativeRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, readJsonBody, guardWriteRequest, log } = deps
  const ctx = deps.creativeContext || createCreativeContext(deps)
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const json = (res, body, status) => respondJson(res, body, status ?? 200)

  const local = (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      json(res, { ok: false, reason: 'local requests only' }, 403)
      return false
    }
    return true
  }
  const postOnly = (req, res) => {
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      json(res, { ok: false, reason: 'POST only' }, 405); return false
    }
    if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return false
    return true
  }
  const bodyOf = async (req) => {
    if (typeof readJsonBody !== 'function') return {}
    return (await readJsonBody(req)) ?? {}
  }
  const wrap = (fn) => async (req, res) => {
    if (!local(req, res)) return
    try { await fn(req, res) } catch (error) {
      warn('能力端点异常：' + (error?.message ?? error))
      json(res, { ok: false, reason: '能力端点暂不可用（详见插件日志）' }, 500)
    }
  }

  const routes = [
    {
      path: CREATIVE_ROUTE_PATHS[0], method: 'GET',
      handler: wrap(async (req, res) => {
        // 外部低延迟服务：本机回环探活（失败只报 offline，不假装可用、不捆绑）
        const externals = []
        for (const s of listExternalTtsServices()) {
          const p = await probeExternalTts(s, { fetch: (...a) => fetch(...a) })
          externals.push({ id: s.id, label: s.label, license: s.license,
            guide: s.guide, online: p.online, reason: p.reason })
        }
        json(res, { ok: true, default_backend: DEFAULT_TTS_BACKEND,
          backends: listTtsBackends({ installed: ctx.installed }),
          external_services: externals,
          registry: TTS_BACKENDS.map((b) => ({ id: b.id, label: b.label, variant: b.variant,
            unverified: b.unverified, requiresReferenceAudio: b.requiresReferenceAudio })),
          unverified: true })
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[1], method: 'GET, POST',
      handler: wrap(async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method === 'GET') {
          json(res, { ok: true, samples: ctx.samples.list(), formats: AUDIO_SAMPLE_FORMATS.slice(),
            maxBytes: MAX_SAMPLE_BYTES,
            note: '零样本 / 参考音频音色克隆：不训练、不微调、不产出权重文件。' })
          return
        }
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const action = String(body?.action ?? 'register').trim()
        if (action === 'remove') {
          json(res, ctx.samples.remove({ id: body?.id }))
          return
        }
        const data = body?.data_base64 ?? body?.data
        json(res, ctx.samples.register({ name: body?.name, data, size: body?.size }))
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[2], method: 'GET',
      handler: wrap(async (req, res) => {
        json(res, { ok: true, models: listMusicModels({ installed: ctx.installed }),
          presets: BGM_PRESETS.map((p) => ({ ...p })),
          registry: MUSIC_MODELS.map((m) => ({ id: m.id, label: m.label, unverified: m.unverified })),
          // ★ BGM 优化③：hyperframes §7 可落地装配计划（缓存键/ducking/断点续推 + 模型项 blocked）
          assembly: buildBgmAssemblyPlan({ segments: [], completedSegmentIds: [] }),
          unverified: true })
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[3], method: 'POST',
      handler: wrap(async (req, res) => {
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const normalized = normalizeWorkerInput({ kind: 'music', ...body })
        if (!normalized.ok) { json(res, { ok: false, reason: normalized.reason }); return }
        const plan = buildMusicPlan({ model: body?.model, installed: ctx.installed, params: normalized.input })
        const adapted = adaptWorkerInput(plan.plan?.model === 'yue2' ? 'yue2' : 'ace_step_15', normalized.input)
        json(res, { ok: plan.ok, model: plan.plan?.model ?? '', plan: plan.plan ?? {},
          degraded: plan.degraded, reasons: plan.reasons,
          unified_input: normalized.input, adapter_payload: adapted.payload,
          adapter_verified: adapted.verified, unverified: true,
          reason: plan.reasons?.join('；') ?? '' })
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[4], method: 'GET',
      handler: wrap(async (req, res) => {
        json(res, { ok: true, engines: listUpscaleEngines(),
          scaleChoices: MANUAL_SCALE_CHOICES.slice(),
          vulkan: detectVulkanEngines(String(ctx.cfg?.vulkanUpscalePath ?? '')),
          note: '手动超分：参数由用户显式给出，不自动执行、不自动下载权重；Vulkan 直跑引擎在已安装（cfg.vulkanUpscalePath）时真实执行。',
          unverified: true })
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[5], method: 'POST',
      handler: wrap(async (req, res) => {
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const r = buildManualUpscalePlan({
          source: body?.source, target: body?.target, engine: body?.engine,
          scale: body?.scale, model: body?.model, denoise: body?.denoise,
          sharpen: body?.sharpen, tileSize: body?.tile_size,
          vaeTileSize: body?.vae_tile_size, seed: body?.seed,
          outputDir: ctx.outputDir, sourceDirs: ctx.sourceDirs, installed: ctx.installed,
        })
        // ★ Vulkan 直跑引擎：用户显式 engine + 引擎已安装（cfg.vulkanUpscalePath）时
        //   真实执行（不经 ComfyUI）；未安装时保持草案降级，绝不谎称已放大。
        const isVulkan = r.ok && VULKAN_ENGINE_IDS.includes(r.plan?.engine)
        const run = isVulkan
          ? await runVulkanUpscale({
              installDir: String(ctx.cfg?.vulkanUpscalePath ?? ''),
              engineId: r.plan.engine, sourcePath: r.sourcePath, outputPath: r.outputPath,
              params: { model: body?.model, scale: r.plan.scale, tileSize: r.plan.tile_size,
                gpuId: body?.gpu_id, format: body?.format, denoise: body?.denoise, sharpen: body?.sharpen },
              timeoutMs: 600000,
              log: (...a) => { try { deps.log?.('info', ...a) } catch { /* 忽略 */ } },
            })
          : null
        json(res, { ok: run ? run.ok : r.ok, plan: r.plan ?? {},
          degraded: run ? (run.degraded === true || r.degraded === true) : r.degraded,
          executed: Boolean(run?.executed),
          output_path: String(run?.path ?? ''),
          run: run ? { engine: run.engine ?? '', ms: run.ms ?? 0, notes: run.notes ?? [] } : null,
          reason: run ? (run.reason ?? r.reason ?? '') : (r.reason ?? ''),
          note: run
            ? (run.executed ? 'Vulkan 直跑完成，产物已落盘。' : 'Vulkan 执行未完成：' + (run.reason ?? ''))
            : '只回参数预览；该引擎未安装或未选择 Vulkan 时不会执行，绝不谎称已放大或已落盘。' })
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[6], method: 'GET, POST',
      handler: wrap(async (req, res) => {
        const method = String(req?.method ?? 'GET').toUpperCase()
        if (method === 'GET') {
          json(res, { ok: true, workers: ctx.workers.list(), policy: ctx.workers.policy,
            isolationModes: ctx.workers.isolationModes,
            protocolVersion: WORKER_PROTOCOL_VERSION,
            adapters: listWorkerAdapters(),
            note: '插件不创建 venv / conda / Docker，不 pip install，不下载权重；显存数字只来自注入探针。' })
          return
        }
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const tool = makeWorkerTool({ creativeContext: ctx })
        json(res, await tool.execute(body))
      }),
    },
    {
      path: CREATIVE_ROUTE_PATHS[7], method: 'GET',
      handler: wrap(async (req, res) => {
        const vram = await ctx.workers.probeVram()
        const id = String(req?.url ?? '').includes('id=')
          ? new URL(String(req.url), 'http://127.0.0.1').searchParams.get('id') : null
        const pre = id ? await ctx.workers.preflight(id) : null
        json(res, { ok: true, vram, preflight: pre,
          note: '显存数值只来自注入探针；未检测时绝不猜测，也不承诺「带得动」。' })
      }),
    },
    {
      // ★ 2026-11-15：GET 看清单与工作流补丁；POST 把选中的后端写进内存配置，
      //   由 config.js / turbo-workflow.js 在生成时真的接进模型链（默认不启用）。
      path: CREATIVE_ROUTE_PATHS[8], method: 'GET, POST',
      handler: wrap(async (req, res) => {
        // ★ ctx.installed 是内部能力名，不是 /object_info 节点类名；为空时补真实探测。
        let installed = ctx.installed
        let probeInfo = { source: 'injected', nodeCount: 0, reason: '' }
        const empty = !installed || (typeof installed === 'object' && !Array.isArray(installed)
          && Object.keys(installed).length === 0)
        if (empty && typeof deps.objectInfoProbe === 'function') {
          const probed = await deps.objectInfoProbe()
          if (probed?.ok && Array.isArray(probed.nodes) && probed.nodes.length > 0) {
            installed = probed.nodes
            probeInfo = { source: 'object_info', nodeCount: probed.nodes.length, reason: '' }
          } else {
            probeInfo = { source: 'unavailable', nodeCount: 0,
              reason: String(probed?.reason || '本机未返回节点表') }
          }
        }
        const kind = String(req?.url ?? '').includes('kind=video') ? 'video' : 'image'
        let enabled = String(ctx.cfg?.attentionBackend ?? '').trim()
        if (String(req?.method ?? '').toUpperCase() === 'POST') {
          if (!postOnly(req, res)) return
          const body = await bodyOf(req)
          const want = String(body?.enabled ?? '').trim()
          if (want !== '' && !ATTENTION_BACKENDS.some((b) => b.id === want)) {
            json(res, { ok: false, reason: '未知的加速后端 id' }, 400); return
          }
          if (!ctx.cfg || typeof ctx.cfg !== 'object') {
            json(res, { ok: false, reason: '本机配置不可用' }, 500); return
          }
          try { ctx.cfg.attentionBackend = want } catch {
            json(res, { ok: false, reason: '本机配置只读，无法切换加速后端' }, 500); return
          }
          enabled = want
        }
        const patch = buildAttentionWorkflowPatch({
          installed, kind, enabled,
          acceptedInputs: ctx.cfg?.attentionAcceptedInputs,
          extraInputs: ctx.cfg?.attentionInputs,
        })
        json(res, { ok: true, kind, enabled, probe: probeInfo,
          backends: listAttentionBackends({ installed, kind }),
          selection: pickAttentionBackends({ installed, kind }),
          workflow_patch: patch,
          note: 'SageAttention / Comfy-WaveSpeed 的节点与参数未经本机核实；'
            + '相对倍率一律标 unverified，不写入结论。插件不 pip install、不自动下载。'
            + 'POST 只改进程内存配置（重启回默认），默认不启用时生成链逐字节不变。',
          unverified: true })
      }),
    },
  ]
  return routes
}

/** 给 UI / 文档用的协议摘要（纯数据）。 */
export function describeCreativeProtocol() {
  return {
    version: WORKER_PROTOCOL_VERSION,
    ttsInput: ['text', 'prompt_audio', 'emotion', 'language', 'seed', 'reference_text'],
    musicInput: ['prompt', 'duration_sec', 'lyrics', 'style', 'bpm', 'vocal', 'seed', 'preset'],
    output: normalizeWorkerOutput({ ok: true, audio_path: 'out/audio.wav', format: 'wav' }),
    adapters: listWorkerAdapters(),
    attentionBackends: listAttentionBackends({}),
  }
}
