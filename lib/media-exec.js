// 设计说明已外置 → docs/tts-early-audio-design-notes.md#hdr-note-media-exec
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)
export const MEDIA_EXEC_TIMEOUT_MS = 180 * 1000
const PROBE_TTL_MS = 10 * 60 * 1000
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * @param {object} deps
 * @param {Function} [deps.run]  注入的命令执行器 (cmd, args) => Promise<{stdout}>
 *                               —— 离线测试注入假函数，绝不真起进程
 * @param {Function} [deps.log]  本机日志
 * @param {string}   [deps.ffmpegPath] 显式指定 ffmpeg（等价于 FFMPEG_PATH）
 * @param {boolean}  [deps.enabled] 显式关掉真执行（能力端点仍如实报告）
 * @param {Function} [deps.now]  注入时钟（测试用）
 */
export function createMediaExec(deps = {}) {
  // ★ 2026-11-18 审计修复：默认 runner 必须透传第三参 opts.timeoutMs —— 原实现整个丢弃，
  //   animation-kit(5min)/media-fx(30min) 的长任务被静默截断成 180s，超时即 SIGTERM
  //   → 误报"ffmpeg 执行失败"+半截产物；probe 的 5s 也同样失效。下限 1s 防呆。
  const run = typeof deps.run === 'function'
    ? deps.run
    : (cmd, args, opts = {}) => execFileAsync(cmd, args, {
        timeout: Math.max(1000, Number(opts?.timeoutMs) || MEDIA_EXEC_TIMEOUT_MS),
        maxBuffer: MAX_BUFFER,
      })
  const warn = (msg) => { try { deps.log?.('warn', msg) } catch { /* 忽略 */ } }
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const enabled = deps.enabled !== false
  let cache = null

  /** 探测结果：{ available, ffmpeg, ffprobe, source, reason } —— 未探测到一律 available:false。 */
  async function probe() {
    if (cache !== null && now() - cache.at < PROBE_TTL_MS) return cache.value
    const envPath = String(deps.ffmpegPath ?? process.env.FFMPEG_PATH ?? '').trim()
    const candidates = []
    if (envPath !== '') {
      const ext = path.extname(envPath)
      candidates.push({
        ffmpeg: envPath,
        ffprobe: path.join(path.dirname(envPath), 'ffprobe' + ext),
        source: 'FFMPEG_PATH',
      })
    }
    candidates.push({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'PATH' })
    let value = { available: false, ffmpeg: null, ffprobe: null, source: '', reason: '未探测到可用的 ffmpeg' }
    for (const c of candidates) {
      try {
        await run(c.ffmpeg, ['-version'], { timeoutMs: 5000 })
        value = { available: true, ffmpeg: c.ffmpeg, ffprobe: null, source: c.source, reason: '探测到 ffmpeg 可用' }
        try {
          await run(c.ffprobe, ['-version'], { timeoutMs: 5000 })
          value.ffprobe = c.ffprobe
        } catch { /* 没有 ffprobe 也能转，只是不给版本信息 */ }
        break
      } catch { /* 换下一个候选 */ }
    }
    cache = { at: now(), value }
    return value
  }

  /**
   * 真执行一条构建好的 ffmpeg argv。
   * @returns {Promise<{ok:boolean, reason:string, probed:boolean, command?:string[]}>}
   */
  async function runCommand(command, opts = {}) {
    if (!Array.isArray(command) || command.length < 2) {
      return { ok: false, reason: '命令参数不合法', probed: false }
    }
    if (!enabled) {
      return { ok: false, reason: '执行器已被宿主禁用（enabled:false）', probed: false }
    }
    const p = await probe()
    if (!p.available) {
      return {
        ok: false, probed: true, command: [...command],
        reason: '离线降级：未探测到可用的 ffmpeg（FFMPEG_PATH / PATH 都试过），仅返回参数预览，未生成文件。',
      }
    }
    const argv = [...command]
    argv[0] = p.ffmpeg
    try {
      await run(argv[0], argv.slice(1), { timeoutMs: Number(opts.timeoutMs) || MEDIA_EXEC_TIMEOUT_MS })
      return { ok: true, probed: true, reason: '已生成目标格式文件（ffmpeg 执行成功）', command: argv }
    } catch (error) {
      warn('媒体转换 ffmpeg 执行失败：' + (error?.message ?? error))
      return {
        ok: false, probed: true, command: argv,
        reason: 'ffmpeg 执行失败（详见插件日志）；可能缺少该编码器或源文件无法解码，未生成文件。',
      }
    }
  }

  return { probe, runCommand, enabled }
}
