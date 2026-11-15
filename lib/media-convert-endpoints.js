/**
 * lib/media-convert-endpoints.js —— 媒体格式转换的本机 HTTP 端点。
 *
 *   POST /api/qwen-paint/media/convert  执行转换（body 交给 convert_media 工具）
 *   GET  /api/qwen-paint/media/formats  格式清单 + ffmpeg 能力 + 当前输出格式预设
 *   POST /api/qwen-paint/media/formats  设置 / 清除某类生成物的默认输出格式
 *
 * ## 诚实边界
 *   · ffmpeg 是否可用只来自 lib/media-exec.js 的探测结果；没探测到就
 *     available:false / canExecute:false 并说明原因，绝不把编码器名写成「已验证可用」。
 *   · 能力端点不执行任何转换、不派生子进程；只有探测 `ffmpeg -version` 这一条只读命令。
 *   · 预设只存进程内存，不写配置文件、不改 cfg 对象，重启即清空。
 *
 * ## 安全边界（与 lib/gif-endpoints.js / video-frames-endpoints.js 同口径）
 *   isLocalRequest 回环校验 + 方法限制 + guardWriteRequest + 有界 readJsonBody；
 *   异常只写本机日志、回固定文案，绝不回吐 error.message（可能夹带本机绝对路径）。
 */
import { makeMediaConvertTool, describeMediaFormats } from './media-convert-tool.js'
import { listFormats, FORMAT_NAMES, resolveFormat } from './media-formats.js'

export const MEDIA_CONVERT_PATH = '/api/qwen-paint/media/convert'
export const MEDIA_FORMATS_PATH = '/api/qwen-paint/media/formats'

/**
 * @param {object} deps
 * @param {Function} deps.isLocalRequest
 * @param {Function} deps.respondJson
 * @param {Function} deps.readJsonBody
 * @param {Function} [deps.guardWriteRequest]
 * @param {object}   [deps.mediaExec]     lib/media-exec.js 执行器
 * @param {object}   [deps.formatPrefs]   lib/media-formats.js 的输出格式预设（共享同一实例）
 * @param {string}   [deps.outputDir]
 * @param {string[]} [deps.sourceDirs]
 * @param {Function} [deps.log]
 * @param {object}   [deps.mediaTool]     可注入已构建的工具（测试用）
 */
export function mediaRouteTable(deps = {}) {
  const {
    isLocalRequest, respondJson, readJsonBody, guardWriteRequest,
    mediaExec, formatPrefs, log,
  } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const tool = (deps.mediaTool && typeof deps.mediaTool.execute === 'function')
    ? deps.mediaTool
    : makeMediaConvertTool(deps)
  const prefs = formatPrefs || null

  const localOnly = (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      respondJson(res, { ok: false, reason: 'local requests only' }, 403)
      return false
    }
    return true
  }

  /** POST：转换。所有异常一律固定文案，不回吐 error.message。 */
  const convertHandler = async (req, res) => {
    if (!localOnly(req, res)) return
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      respondJson(res, { ok: false, reason: 'POST only' }, 405)
      return
    }
    if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return
    try {
      const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) ?? {} : {}
      const result = await tool.execute(body)
      respondJson(res, result)
    } catch (error) {
      warn(`媒体转换端点失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '媒体格式转换暂不可用（详见插件日志）' }, 500)
    }
  }

  /** GET/POST：格式清单 / 输出格式预设。 */
  const formatsHandler = async (req, res) => {
    if (!localOnly(req, res)) return
    const method = String(req?.method ?? 'GET').toUpperCase()
    try {
      let probe = null
      if (mediaExec && typeof mediaExec.probe === 'function') probe = await mediaExec.probe()
      const available = probe?.available === true
      const capability = {
        ffmpeg: available ? 'available' : (probe ? 'unavailable' : 'undetected'),
        probed: Boolean(probe),
        source: probe?.source ?? '',
        ffprobe: probe?.ffprobe ?? null,
        reason: probe?.reason ?? '未探测：宿主未注入媒体执行器，能力未知，按未检测处理。',
        canExecute: available && mediaExec?.enabled !== false
          && typeof mediaExec?.runCommand === 'function',
      }

      if (method === 'POST') {
        const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) ?? {} : {}
        if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return
        if (!prefs) {
          respondJson(res, { ok: false, reason: '输出格式预设未启用（详见插件日志）' }, 503)
          return
        }
        const kind = String(body.kind ?? '').trim().toLowerCase()
        if (!['image', 'video', 'audio'].includes(kind)) {
          respondJson(res, { ok: false, reason: 'kind 只能是 image / video / audio' }, 400)
          return
        }
        if (body.clear === true || body.format === null || body.format === '') {
          const r = prefs.clear(kind)
          respondJson(res, { ok: r.ok, cleared: r.cleared, kind, presets: prefs.snapshot() })
          return
        }
        const r = prefs.set(kind, body.format)
        if (!r.ok) { respondJson(res, { ok: false, reason: r.reason }, 400); return }
        respondJson(res, {
          ok: true, kind, format: r.format, presets: prefs.snapshot(),
          note: '预设只在本进程内生效，重启即清空；生成完成后按该类预设自动后转码一次（不改变原始产物）。',
        })
        return
      }
      if (method !== 'GET' && method !== 'HEAD') {
        respondJson(res, { ok: false, reason: 'GET or POST only' }, 405)
        return
      }
      respondJson(res, {
        ok: true,
        tool: 'convert_media',
        ...listFormats(),
        available_formats: [...FORMAT_NAMES],
        groups: describeMediaFormats(),
        capability,
        output_format_presets: prefs ? prefs.snapshot() : {},
        note: '设置某类输出格式预设后，该类生成物在落盘完成钩子中自动转成目标格式；'
          + '也可直接调用 convert_media 对任意生成物或自有素材单独转换。',
        routes: [
          { path: MEDIA_CONVERT_PATH, method: 'POST' },
          { path: MEDIA_FORMATS_PATH, method: 'GET, POST' },
        ],
      }, 200)
    } catch (error) {
      warn(`媒体格式能力查询失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '格式能力查询暂不可用（详见插件日志）' }, 500)
    }
  }

  return [
    { path: MEDIA_CONVERT_PATH, method: 'POST', handler: convertHandler },
    { path: MEDIA_FORMATS_PATH, method: 'GET, POST', handler: formatsHandler },
  ]
}
