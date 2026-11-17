/**
 * lib/av-stitch.js —— 轻量缝合：旁白时间轴 + BGM ducking + SRT（0.35.0 之后批次）。
 *
 * ## 能力（对应方案的三件事，全部纯 ffmpeg/CPU，显存 0）
 *   ① 旁白时间轴：条目（音频 + 可选文本）按顺序铺到时间轴（时长来自 ffprobe 探测或显式 duration_ms）；
 *   ② BGM ducking：ffmpeg sidechaincompress —— 旁白区间自动压低 BGM；
 *   ③ SRT：有文本的条目 + 实际时间码 → SRT（复用 subtitle-plan.js::cuesToSrt，规范差异不统一）。
 *
 * ## 诚实边界
 *   · ffmpeg / ffprobe 经 PATH 或 cfg.ffmpegPath / cfg.ffprobePath 解析；探测不到 → degraded 如实降级，
 *     绝不谎称已混音（video-post.js 旧声明「没有音频混流实现」随本模块更新为「ffmpeg 直跑混流已支持」）。
 *   · 输入沿用出图目录围栏（manual-upscale 同口径）；输出音频与 SRT 都必须落在出图目录内。
 *   · argv 数组不拼 shell；失败回固定文案，原始 stderr 只进本机日志。
 *   · 无文本的条目不进 SRT；文本时间码来自实际时间轴，不做二次对齐。
 */
import path from 'node:path'
import { writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolveUpscaleSourcePath, resolveUpscaleOutputPath } from './manual-upscale.js'
import { cuesToSrt } from './subtitle-plan.js'
// ★ BGM 优化②：ducking 缝合结果缓存（同输入+参数命中直接复用产物，跳过 ffmpeg 编码）
import { stitchFingerprint } from './bgm-opt.js'

export const STITCH_DEFAULTS = Object.freeze({
  gapMs: 300,
  duckThreshold: 0.03,
  duckRatio: 8,
  duckAttackMs: 5,
  duckReleaseMs: 300,
  startMs: 0,
})

export function listStitchDefaults() {
  return { ...STITCH_DEFAULTS }
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/** 纯函数：给定各条目时长（毫秒），按顺序 + 间隔铺时间轴。 */
export function buildNarrationTimeline({ items = [], durationsMs = [], startMs = STITCH_DEFAULTS.startMs, gapMs = STITCH_DEFAULTS.gapMs } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: false, reason: '没有旁白条目（items）', timeline: [], totalMs: 0 }
  const gap = clamp(gapMs, 0, 10 * 60 * 1000, STITCH_DEFAULTS.gapMs)
  let cursor = clamp(startMs, 0, 24 * 60 * 60 * 1000, 0)
  const timeline = []
  for (let i = 0; i < list.length; i += 1) {
    const it = list[i] ?? {}
    const d = Number(durationsMs[i])
    if (!Number.isFinite(d) || d <= 0) {
      return { ok: false, reason: `条目 ${i + 1} 缺少时长（ffprobe 探测失败或未提供 duration_ms）`, timeline: [], totalMs: 0 }
    }
    const dur = Math.max(1, Math.round(d))
    timeline.push({
      index: i + 1,
      file: String(it.file ?? ''),
      text: String(it.text ?? ''),
      startMs: cursor,
      endMs: cursor + dur,
      durationMs: dur,
    })
    cursor += dur + gap
  }
  return { ok: true, reason: '', timeline, totalMs: timeline.length > 0 ? timeline[timeline.length - 1].endMs : cursor }
}

/** 有文本的条目 → SRT 文本（时间码 = 实际时间轴，秒）。复用 subtitle-plan.js 的规范实现。 */
export function buildSrtFromTimeline(timeline = []) {
  const cues = (Array.isArray(timeline) ? timeline : [])
    .filter((t) => String(t.text ?? '').trim() !== '')
    // ★ subtitle-plan 的 cue 字段是 {from, to, text}（秒），不是 {start, end} —— 字段名错会全落到 00:00:00,000。
    .map((t) => ({ from: t.startMs / 1000, to: t.endMs / 1000, text: String(t.text).trim() }))
  if (cues.length === 0) return { ok: false, reason: '没有带文本的条目，不产出 SRT', srt: '' }
  return { ok: true, reason: '', srt: cuesToSrt(cues), cues: cues.length }
}

/** ffmpeg / ffprobe 解析：cfg.ffmpegPath / cfg.ffprobePath 优先，否则 PATH。 */
export function resolveStitchBinaries(cfg = {}) {
  return {
    ffmpeg: String(cfg?.ffmpegPath ?? '').trim() || 'ffmpeg',
    ffprobe: String(cfg?.ffprobePath ?? '').trim() || 'ffprobe',
  }
}

/** 单个音频时长（秒）：ffprobe -show_entries format=duration。失败如实返回。 */
export async function probeAudioDuration(file, { cfg = {}, timeoutMs = 30000, execFileFn = execFile } = {}) {
  const { ffprobe } = resolveStitchBinaries(cfg)
  let stdout = ''
  try {
    await new Promise((resolve, reject) => {
      const child = execFileFn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', String(file)],
        { timeout: Math.max(5000, timeoutMs), windowsHide: true, maxBuffer: 1024 * 1024 }, (err, so) => {
          if (err) reject(err); else { stdout = String(so ?? ''); resolve() }
        })
      child.on('error', reject)
    })
  } catch {
    return { ok: false, reason: 'ffprobe 探测失败：' + path.basename(String(file)) }
  }
  const sec = Number(String(stdout).trim())
  if (!Number.isFinite(sec) || sec <= 0) return { ok: false, reason: 'ffprobe 未返回有效时长（' + path.basename(String(file)) + '）' }
  return { ok: true, seconds: sec, file: String(file) }
}

/**
 * 构造 ffmpeg argv（纯函数）。输入顺序：[bgm?] + items；filter_complex：
 *   各条目 adelay 到时间轴 → amix(normalize=0) 成旁白轨 →
 *   （有 BGM 时）[bgm][nar]sidechaincompress 压低 → 与旁白 amix(normalize=0) 成输出。
 */
export function buildStitchArgs({ bgm = '', items = [], timeline = [], target, duck = {} } = {}) {
  if (!Array.isArray(timeline) || timeline.length === 0) return { ok: false, reason: '时间轴为空', argv: [] }
  const out = String(target ?? '').trim()
  if (!out) return { ok: false, reason: '输出路径缺失', argv: [] }
  const th = clamp(duck.threshold ?? STITCH_DEFAULTS.duckThreshold, 0.001, 1, STITCH_DEFAULTS.duckThreshold)
  const ratio = clamp(duck.ratio ?? STITCH_DEFAULTS.duckRatio, 1, 20, STITCH_DEFAULTS.duckRatio)
  const atk = clamp(duck.attackMs ?? STITCH_DEFAULTS.duckAttackMs, 1, 1000, STITCH_DEFAULTS.duckAttackMs)
  const rel = clamp(duck.releaseMs ?? STITCH_DEFAULTS.duckReleaseMs, 1, 5000, STITCH_DEFAULTS.duckReleaseMs)
  const argv = []
  let idx = 0
  if (bgm) { argv.push('-i', String(bgm)); idx = 1 }
  for (const t of timeline) argv.push('-i', String(t.file))
  const parts = []
  const delays = []
  for (let i = 0; i < timeline.length; i += 1) {
    const inputIdx = idx + i
    const label = `n${i}`
    parts.push(`[${inputIdx}:a]adelay=${timeline[i].startMs}:all=1[${label}]`)
    delays.push(`[${label}]`)
  }
  const narRef = timeline.length === 1 ? delays[0] : '[nar]'
  if (timeline.length > 1) parts.push(`${delays.join('')}amix=inputs=${timeline.length}:duration=longest:normalize=0[nar]`)
  if (bgm) {
    parts.push(`[0:a]${narRef}sidechaincompress=threshold=${th}:ratio=${ratio}:attack=${atk}:release=${rel}:makeup=1[bgd]`)
    parts.push(`[bgd][nar]amix=inputs=2:duration=longest:normalize=0[aout]`)
  } else {
    parts.push(`${narRef}anull[aout]`)
  }
  argv.push('-filter_complex', parts.join(';'), '-map', '[aout]', '-y', out)
  return { ok: true, argv, engine: 'ffmpeg', duck: { threshold: th, ratio, attackMs: atk, releaseMs: rel }, notes: [] }
}

/**
 * 真实执行：先 ffmpeg -version 能力探测（失败 → degraded），再逐条 ffprobe 探时长
 * （条目显式 duration_ms 可跳过探测），再跑混音；有 srtTarget 时写 SRT（围栏内）。
 */
export async function runAvStitch({
  cfg = {}, items = [], bgm = '', target, srtTarget = '',
  outputDir, sourceDirs = [], params = {}, timeoutMs = 600000,
  execFileFn = execFile, platform = process.platform, log = () => {},
  stitchCache = true,
} = {}) {
  const { ffmpeg, ffprobe } = resolveStitchBinaries(cfg)
  // 围栏：输入（BGM + 各条目）与输出
  const fencedItems = []
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return { ok: false, executed: false, degraded: true, reason: '没有旁白条目（items）', notes: [] }
  for (let i = 0; i < list.length; i += 1) {
    const s = resolveUpscaleSourcePath({ source: list[i]?.file, outputDir, sourceDirs })
    if (!s.ok) return { ok: false, executed: false, degraded: true, reason: `条目 ${i + 1}：` + s.reason, notes: [] }
    fencedItems.push({ file: s.path, text: String(list[i]?.text ?? ''), duration_ms: list[i]?.duration_ms })
  }
  let bgmPath = ''
  if (bgm) {
    const b = resolveUpscaleSourcePath({ source: bgm, outputDir, sourceDirs })
    if (!b.ok) return { ok: false, executed: false, degraded: true, reason: 'BGM：' + b.reason, notes: [] }
    bgmPath = b.path
  }
  const out = resolveUpscaleOutputPath({ target, outputDir })
  if (!out.ok) return { ok: false, executed: false, degraded: true, reason: '输出：' + out.reason, notes: [] }
  let srtPath = ''
  if (srtTarget) {
    const st = resolveUpscaleOutputPath({ target: srtTarget, outputDir })
    if (!st.ok) return { ok: false, executed: false, degraded: true, reason: 'SRT 输出：' + st.reason, notes: [] }
    srtPath = st.path
  }

  // 能力探测：ffmpeg -version（失败 → degraded，绝不谎称已混音）
  try {
    await new Promise((resolve, reject) => {
      const child = execFileFn(ffmpeg, ['-version'], { timeout: 10000, windowsHide: true }, (err) => { if (err) reject(err); else resolve() })
      child.on('error', reject)
    })
  } catch (err) {
    try { log('info', '[av-stitch] ffmpeg 不可用：' + (err?.message ?? String(err))) } catch { /* 忽略 */ }
    return { ok: false, executed: false, degraded: true, reason: 'ffmpeg 未探测到（PATH/FFMPEG_PATH）——缝合需要 ffmpeg（纯 CPU，显存 0）', notes: [] }
  }

  // 时长：显式 duration_ms 优先，否则逐条 ffprobe
  const durationsMs = []
  const notes = []
  for (let i = 0; i < fencedItems.length; i += 1) {
    const d = Number(fencedItems[i].duration_ms)
    if (Number.isFinite(d) && d > 0) { durationsMs.push(d); notes.push(`条目 ${i + 1} 时长用显式值 ${Math.round(d)} ms`); continue }
    const p = await probeAudioDuration(fencedItems[i].file, { cfg, execFileFn, platform })
    if (!p.ok) return { ok: false, executed: false, degraded: true, reason: p.reason + '（也可在条目里显式给 duration_ms 跳过探测）', notes }
    const sec = Number(p.seconds)
    if (!Number.isFinite(sec) || sec <= 0) return { ok: false, executed: false, degraded: true, reason: `条目 ${i + 1} 时长探测结果无效`, notes }
    durationsMs.push(sec * 1000)
  }
  const tl = buildNarrationTimeline({ items: fencedItems, durationsMs, startMs: params.startMs, gapMs: params.gapMs })
  if (!tl.ok) return { ok: false, executed: false, degraded: true, reason: tl.reason, notes }
  const built = buildStitchArgs({ bgm: bgmPath, items: fencedItems, timeline: tl.timeline, target: out.path, duck: params })
  if (!built.ok) return { ok: false, executed: false, degraded: true, reason: built.reason, notes }
  if (notes.length > 0) notes.push(...built.notes ?? [])

  // ★ BGM 优化②：ducking 缝合结果缓存。同输入文件身份 + duck 参数 + target 命中，
  //   且产物存在且与登记字节一致 → 直接复用，跳过 ffmpeg 编码（省一次完整混流）。
  //   deps.stitchCache === false 可关掉（验证真实 ffmpeg 链路用）。缓存坏/读写失败一律降级真跑。
  const useCache = stitchCache !== false && outputDir
  const fpFile = useCache ? out.path + '.dshqp-stitch-fp' : ''
  let cachedHit = false
  if (fpFile) {
    try {
      const key = stitchFingerprint(createHash, { bgm: bgmPath, items: fencedItems,
        startMs: params.startMs, gapMs: params.gapMs, duck: params, target: out.path }, { statSync }, path)
      const sidecar = JSON.parse(readFileSync(fpFile, 'utf8'))
      const st = statSync(out.path)
      if (key && sidecar?.key === key && st.size > 0 && st.size === Number(sidecar.bytes)) {
        cachedHit = true
      }
    } catch { cachedHit = false }
  }

  const started = Date.now()
  if (!cachedHit) {
  try {
    await new Promise((resolve, reject) => {
      const child = execFileFn(ffmpeg, built.argv, { timeout: Math.max(10000, timeoutMs), windowsHide: true }, (err) => { if (err) reject(err); else resolve() })
      child.on('error', reject)
    })
  } catch (err) {
    try { log('info', '[av-stitch] 执行失败：' + (err?.message ?? String(err))) } catch { /* 忽略 */ }
    const code = Number(err?.code ?? 0)
    return {
      ok: false, executed: false, degraded: false,
      reason: '执行失败（退出码 ' + (Number.isFinite(code) && code !== 0 ? code : '非零') + '；详情见本机日志，原始报错不回传）',
      notes, engine: 'ffmpeg', argv: built.argv,
    }
  }
  } // end if (!cachedHit) —— 命中时跳过 ffmpeg 执行

  // 真跑成功后写缓存指纹（命中时不重写）：写失败绝不致命
  if (!cachedHit && fpFile) {
    try {
      const key = stitchFingerprint(createHash, { bgm: bgmPath, items: fencedItems,
        startMs: params.startMs, gapMs: params.gapMs, duck: params, target: out.path }, { statSync }, path)
      writeFileSync(fpFile, JSON.stringify({ key, bytes: statSync(out.path).size, at: new Date().toISOString() }))
    } catch { /* 缓存写失败不影响已完成的缝合 */ }
  }

  let srtWritten = false
  if (srtPath) {
    const srt = buildSrtFromTimeline(tl.timeline)
    if (srt.ok) {
      writeFileSync(srtPath, srt.srt, 'utf8')
      srtWritten = true
    } else {
      notes.push('SRT 未产出：' + srt.reason)
    }
  }
  return {
    ok: true, executed: !cachedHit, degraded: false, reason: '',
    cached: cachedHit,
    path: out.path, srt_path: srtWritten ? srtPath : '', srt_written: srtWritten,
    engine: 'ffmpeg', ms: Date.now() - started, argv: built.argv,
    timeline: tl.timeline, totalMs: tl.totalMs, duck: built.duck, notes,
    note: (cachedHit ? '缝合缓存命中，复用已有产物' : '缝合完成：旁白时间轴 + BGM ducking')
      + (srtWritten ? ' + SRT（时间码来自实际时间轴）' : '') + '；纯 ffmpeg，显存 0。',
  }
}

/* ------------------------------ 工具与端点 ------------------------------ */

const BOOL = { type: 'boolean' }
const NUM = { type: 'number' }
const STR = { type: 'string' }
const ARR = { type: 'array', items: { type: 'object' } }
const OBJ = { type: 'object' }
const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const json = (res, body, status = 200) => {
  try { res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)) } catch { /* 忽略 */ }
}
const bodyOf = (req) => new Promise((resolve) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => { size += c.length; if (size > 2 * 1024 * 1024) { resolve(null); try { req.destroy() } catch { /* 忽略 */ } ; return } chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve(null) } })
  req.on('error', () => resolve(null))
})
const postOnly = (req, res) => {
  if (req.method !== 'POST') { json(res, { ok: false, reason: 'POST only' }, 405); return false }
  return true
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res) } catch { json(res, { ok: false, reason: '内部错误（详情见本机日志）' }, 500) }
}

export function makeMixNarrationTool(deps = {}) {
  const outputDir = String(deps.outputDir ?? '').trim()
  const sourceDirs = Array.isArray(deps.sourceDirs) ? deps.sourceDirs : []
  const cfg = deps.cfg || {}
  return {
    name: 'mix_narration',
    description: '轻量缝合（纯 ffmpeg，显存 0）：旁白条目按时间轴铺设 + BGM sidechaincompress 自动压低'
      + ' + 有文本条目直接产出 SRT（时间码来自实际时间轴，不做二次对齐）。'
      + '输入限出图目录（BGM 同），输出音频与 SRT 落出图目录内；ffmpeg/ffprobe 未探测到时如实降级。',
    parameters: schemaOf({
      items: ARR, bgm: STR, target: STR, srt_target: STR,
      gap_ms: NUM, start_ms: NUM, duck_threshold: NUM, duck_ratio: NUM,
    }),
    timeoutMs: 10 * 60 * 1000,
    output: { schema: schemaOf({
      ok: BOOL, executed: BOOL, output_path: STR, srt_path: STR, degraded: BOOL,
      reason: STR, run: OBJ, note: STR,
    }) },
    async execute(args = {}) {
      const run = await runAvStitch({
        cfg, outputDir, sourceDirs,
        stitchCache: deps.stitchCache,
        items: args?.items, bgm: args?.bgm, target: args?.target, srtTarget: args?.srt_target,
        params: { gapMs: args?.gap_ms, startMs: args?.start_ms,
          threshold: args?.duck_threshold, ratio: args?.duck_ratio },
        timeoutMs: 10 * 60 * 1000,
        log: (...a) => { try { deps.log?.('info', ...a) } catch { /* 忽略 */ } },
      })
      return {
        ok: run.ok, executed: Boolean(run.executed),
        output_path: String(run.path ?? ''), srt_path: String(run.srt_path ?? ''),
        degraded: run.degraded === true, reason: run.reason ?? '',
        run: { engine: run.engine ?? '', ms: run.ms ?? 0, totalMs: run.totalMs ?? 0,
          cached: run.cached === true, timeline: run.timeline ?? [], duck: run.duck ?? {}, notes: run.notes ?? [] },
        note: run.executed || run.cached ? run.note : '未执行：' + (run.reason ?? '') + '（绝不谎称已混音）',
      }
    },
  }
}

export const STITCH_ROUTE_PATHS = Object.freeze([
  '/api/qwen-paint/av/stitch/capabilities',
  '/api/qwen-paint/av/stitch',
])

export function stitchRouteTable(base = {}) {
  const cfg = base.cfg || {}
  const log = base.log
  // ★ 2026-11-16 审计 P0：两条路由都补本机围栏（POST 会写 outputDir，绝不能远程打）。
  const isLocalRequest = typeof base.isLocalRequest === 'function' ? base.isLocalRequest : null
  const localGate = (req, res) => {
    if (isLocalRequest && !isLocalRequest(req)) { json(res, { ok: false, reason: 'local requests only' }, 403); return false }
    return true
  }
  return [
    {
      path: STITCH_ROUTE_PATHS[0], method: 'GET',
      handler: wrap(async (req, res) => {
        if (!localGate(req, res)) return
        const bins = resolveStitchBinaries(cfg)
        json(res, { ok: true, defaults: listStitchDefaults(), binaries: bins,
          note: '轻量缝合：旁白时间轴 + BGM ducking（sidechaincompress）+ SRT；纯 ffmpeg/CPU，显存 0；ffmpeg 未探测到时如实降级。' })
      }),
    },
    {
      path: STITCH_ROUTE_PATHS[1], method: 'POST',
      handler: wrap(async (req, res) => {
        if (!localGate(req, res)) return
        if (!postOnly(req, res)) return
        const body = await bodyOf(req)
        const tool = makeMixNarrationTool({ outputDir: String(base.outputDir ?? ''), sourceDirs: Array.isArray(base.sourceDirs) ? base.sourceDirs : [], cfg, log })
        const r = await tool.execute(body ?? {})
        json(res, r)
      }),
    },
  ]
}
