/**
 * lib/media-exec.js —— 媒体转换的 ffmpeg 探测 + 真执行器。
 *
 * 为什么单独一层：
 *   既有 `convert_to_gif` 是「未注入 runCommand 就只回参数预览」的纯计算工具，
 *   那是诚实，但也意味着宿主默认没接执行器时功能不可用。这次用户要的是
 *   「真的能把文件转成指定格式」，所以补一层可注入、可探测、可降级的执行器：
 *     · 探测到 ffmpeg → 真跑（execFile + argv 数组，绝不拼 shell 字符串）；
 *     · 探测不到 / 执行器被禁用 → 明确返回原因，绝不假装生成了文件。
 *
 * 探测范式沿用 lib/video-frames-endpoints.js::detectTools()（本机已验证）：
 *   先 FFMPEG_PATH 环境变量，再 PATH 里的 `ffmpeg -version`，带 10 分钟缓存。
 *   这里额外提供 ffprobe（可选，用于能力端点的版本信息）；拿不到不影响转换。
 *
 * 安全边界：
 *   · command 必须是数组；首元素固定为 'ffmpeg'，由本层替换成探测到的可执行文件；
 *   · 调用方传进来的任何字符串都只作为 argv 元素，不进 shell；
 *   · 超时 / maxBuffer 有界；异常只写本机日志，回固定文案，不回吐 error.message
 *     （可能夹带本机绝对路径）。
 */
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
  const run = typeof deps.run === 'function'
    ? deps.run
    : (cmd, args) => execFileAsync(cmd, args, { timeout: MEDIA_EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER })
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
