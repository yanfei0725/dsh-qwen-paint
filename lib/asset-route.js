/**
 * lib/asset-route.js —— 插件自带静态资源（assets/）的字节路由。
 *
 * ## 为什么需要它（历史踩坑，别再试一遍）
 *   · 内核 `/api/file?path=…` 只服务「**被登记过的**」文件：draw_image 的交付物能显示，
 *     而「正在生成」动图 / 面板脚本没登记 → 一律「图片无法预览」
 *     （GIF / WebP / 静态 PNG 三种都试过，与格式、文件名无关）。
 *   · 往消息树里插 DOM 会把界面搞成整片空白（React 管理那棵树）；改 app.asar 会被升级覆盖。
 *   ✓ 正解：插件自己开路由直接吐字节；属于插件本身，DSH 升级也不会丢。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 贴着 DSH Store 的 262144 B 单文件上限。这段自包含（只需
 *   isLocalRequest / respondJson / log），外置零风险，还能把十份重复的注册样板收敛成一张表。
 *
 * ## 安全边界
 *   · 只服务本机请求；文件名来自**本文件里的常量表**，不接受任何请求参数；
 *   · `x-content-type-options: nosniff` + CSP，避免脚本/样式被按嗅探类型执行；
 *   · 异常只写本机日志，**回给调用方的文案固定** —— error.message 可能带本机绝对路径。
 */
import fsp from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const JS = 'application/javascript; charset=utf-8'
const CSS = 'text/css; charset=utf-8'

/**
 * [对外路径, assets 文件名, MIME]。注册期遍历一次，不是热路径。
 * ⚠ 文件名只在这里出现，绝不由 req 拼出来 —— 这样就没有路径穿越面。
 */
export const ASSET_ROUTES = [
  ['/qwen-paint/loading.webp', 'loading.webp', 'image/webp'],
  ['/qwen-paint/loading.gif', 'loading.gif', 'image/gif'],
  ['/comfy-pipeline/panel.js', 'panel.js', JS],
  ['/comfy-pipeline/panel.css', 'panel.css', CSS],
  ['/qwen-paint/setup-guide.js', 'setup-guide.js', JS],
  ['/qwen-paint/setup-guide.css', 'setup-guide.css', CSS],
  ['/qwen-paint/mask-fx.js', 'mask-fx.js', JS],
  ['/qwen-paint/mask-fx.css', 'mask-fx.css', CSS],
  ['/qwen-paint/cpu-accel.js', 'cpu-accel.js', JS],
  ['/qwen-paint/cpu-accel.css', 'cpu-accel.css', CSS],
  ['/qwen-paint/history.js', 'history.js', JS],
  ['/qwen-paint/history.css', 'history.css', CSS],
  ['/qwen-paint/draft.js', 'draft.js', JS],
  ['/qwen-paint/draft.css', 'draft.css', CSS],
]

/** 与 lib/file-route.js 一致的静态资源响应头。 */
const HEADERS = {
  'cache-control': 'public, max-age=3600',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'",
}

/**
 * @param {object} deps
 * @param {(req:object)=>boolean} deps.isLocalRequest
 * @param {(res:object, body:object, status?:number)=>void} deps.respondJson
 * @param {(level:string, msg:string)=>void} [deps.log]
 * @returns {(name:string, mime:string)=>(req:object,res:object)=>Promise<void>}
 */
export function makeAssetRoute({ isLocalRequest, respondJson, log } = {}) {
  return (name, mime) => async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        respondJson(res, { ok: false, reason: 'local requests only' }, 403)
        return
      }
      const bytes = await fsp.readFile(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)))
      res.writeHead(200, {
        'content-type': mime,
        'content-length': bytes.length,
        ...HEADERS,
        // ★ 2026-11-13 二轮：UI 脚本 / 样式改完必须立刻生效。
        //   旧值 max-age=3600 让浏览器一直拿一小时前的缓存脚本 —— 用户看到的
        //   「× 只把面板关了、悬浮窗还在」「选项还是点不动」正是旧脚本的行为。
        //   no-cache 不够（旧缓存条目本身就带 max-age，过期前根本不会来协商），
        //   ⇒ 文本类直接 no-store，彻底不留缓存；图片类保留长缓存，不浪费带宽。
        'cache-control': (mime === JS || mime === CSS) ? 'no-store' : HEADERS['cache-control'],
      })
      res.end(bytes)
    } catch (error) {
      // ★ 2026-11-13 审计收口：只记本机日志，绝不把 error.message 回吐给调用方
      //   （message 里常带本机绝对路径，属于项目硬规矩里的「不得出门」内容）。
      log?.('warn', `静态资源 ${name} 读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '资源暂不可用（详见插件日志）' }, 500)
    }
  }
}

/** 一次性注册全部静态资源路由，返回 disposer 数组（交还 host 的 effect 统一回收）。 */
export function registerAssetRoutes(webServer, deps) {
  const route = makeAssetRoute(deps)
  return ASSET_ROUTES.map(([path, name, mime]) =>
    webServer.register({ kind: 'exact', path, handler: route(name, mime) }))
}
