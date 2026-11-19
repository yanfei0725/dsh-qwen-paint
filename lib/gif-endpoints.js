/**
 * lib/gif-endpoints.js —— GIF 转换的本机 HTTP 端点。
 *
 * · POST /api/qwen-paint/media/gif              把 body 交给 convert_to_gif 工具执行
 * · GET  /api/qwen-paint/media/gif/capabilities 如实报告 ffmpeg 能力
 *
 * ## 诚实边界（能力端点）
 *   ffmpeg 是否可用**只**来自宿主注入的 probeFfmpeg 探测结果：
 *   · 没注入探测 / 探测没给结论 → ffmpeg:"undetected"、probed:false，明说「未检测」；
 *   · 绝不把任何第三方节点包或 ffmpeg 硬编码成「已安装可用」。
 *   canExecute 还额外要求注入了 runCommand —— 探测说可用但没执行器，同样不算能跑。
 *
 * ## 安全边界（与 lib/asset-route.js / history-endpoints.js 同口径）
 *   isLocalRequest 回环校验 + 方法限制 + guardWriteRequest + 有界 readJsonBody；
 *   异常只写本机日志、回固定文案，**绝不回吐 error.message**（可能带本机绝对路径）。
 *
 * 端点样板已收敛到 lib/route-factory.js（优化接力节点②，2026-11-20）：本机门 / 方法门
 * （capabilities 收 GET+HEAD、文案钉回 'GET only'）/ 写守卫 / body 解析 / catch 收口
 * 由工厂收口；500 固定文案按路由 failText 逐字保留（test-gif 有逐字锁）。
 */
import { makeGifTool, GIF_TOOL_NAME } from './gif-tool.js'
import { makeRouteFactory } from './route-factory.js'

export const GIF_MEDIA_PATH = '/api/qwen-paint/media/gif'
export const GIF_CAPABILITIES_PATH = '/api/qwen-paint/media/gif/capabilities'

/** 如实公开的默认参数，便于前端 / 外部集成核对；不含任何本机信息。 */
export const GIF_DEFAULTS = Object.freeze({
  fps: 12, width: 480, height: -1, duration: 3, loop: 0, dither: 'sierra2_4a', maxColors: 128,
})

/**
 * @param {object} deps
 * @param {Function} deps.isLocalRequest
 * @param {Function} deps.respondJson
 * @param {Function} deps.readJsonBody
 * @param {Function} [deps.guardWriteRequest]
 * @param {Function} [deps.probeFfmpeg]  探测函数，返回 { available, reason } 或 null；未注入即「未检测」
 * @param {Function} [deps.runCommand]  真执行器（能力可用才注入）
 * @param {Function} [deps.readFile]
 * @param {Function} [deps.writeFile]
 * @param {string}   [deps.outputDir]
 * @param {Function} [deps.log]
 * @param {object}   [deps.gifTool]      可注入已构建的工具（便于测试）；不注入就按 deps 自建
 * @returns {Array<{path:string, method:string, handler:Function}>}
 */
export function gifRouteTable(deps = {}) {
  const {
    isLocalRequest, respondJson, readJsonBody, guardWriteRequest,
    probeFfmpeg, log, gifTool,
  } = deps
  const tool = (gifTool && typeof gifTool.execute === 'function') ? gifTool : makeGifTool(deps)
  const route = makeRouteFactory({ isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log })

  /** GET/HEAD：能力查询。探测结果如实回，绝不假装可用。 */
  const capabilitiesHandler = route({
    path: GIF_CAPABILITIES_PATH, method: 'GET, HEAD', onlyText: 'GET only',
    failText: '能力查询暂不可用（详见插件日志）',
    handler: async ({ res }) => {
      let probe = null
      if (typeof probeFfmpeg === 'function') probe = await probeFfmpeg()
      let ffmpeg = 'undetected'
      let probed = false
      let reason = '未探测：宿主未注入 ffmpeg 探测结果，能力未知，按未检测处理。'
      if (probe && typeof probe === 'object') {
        probed = true
        if (probe.available === true) {
          ffmpeg = 'available'
          reason = probe.reason ? String(probe.reason) : '探测到 ffmpeg 可用。'
        } else if (probe.available === false) {
          ffmpeg = 'unavailable'
          reason = probe.reason ? String(probe.reason) : '探测结果：ffmpeg 不可用。'
        } else {
          reason = '探测结果未给出 available 结论，按未检测处理。'
        }
      }
      respondJson(res, {
        ok: true,
        tool: GIF_TOOL_NAME,
        ffmpeg,
        probed,
        reason,
        canExecute: ffmpeg === 'available' && typeof deps.runCommand === 'function',
        defaults: { ...GIF_DEFAULTS },
        routes: [
          { path: GIF_MEDIA_PATH, method: 'POST' },
          { path: GIF_CAPABILITIES_PATH, method: 'GET' },
        ],
      })
    },
  }).handler

  /** POST：转 GIF。所有异常一律固定文案，不回吐 error.message。 */
  const gifHandler = route({
    path: GIF_MEDIA_PATH, method: 'POST', guard: true, parse: true,
    failText: 'GIF 转换暂不可用（详见插件日志）',
    handler: async ({ res, body }) => {
      const result = await tool.execute(body)
      respondJson(res, result)
    },
  }).handler

  return [
    { path: GIF_MEDIA_PATH, method: 'POST', handler: gifHandler },
    { path: GIF_CAPABILITIES_PATH, method: 'GET', handler: capabilitiesHandler },
  ]
}
