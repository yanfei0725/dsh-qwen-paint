/**
 * lib/route-factory.js —— 端点公共工厂（优化接力节点②，2026-11-19）。
 *
 * 13 个 *-endpoints.js 里逐字重复的五段样板（本机门 → 方法门 → 写守卫 → body 解析 →
 * try-catch 收口）收敛成一个描述式 route()。行为逐字对齐原样板：
 *   · 本机门 403 'local requests only'（永远最前）
 *   · 方法门 405 '<METHOD> only'（spec.method 支持 'GET' / 'POST' / 'GET, POST'）
 *   · 写守卫 guardWriteRequest（spec.guard=true 才有，守卫自己响应失败即返回）
 *   · body 解析 readJsonBody ?? {}（spec.parse=true 才有）
 *   · catch 收口：细节只进日志，响应通用文案（项目私规：不回吐 error.message——
 *     顺带修齐 reference / ui-edit / video-frames 等文件的历史泄漏点）
 *
 * 契约约束：路径字面量必须留在各端点模块源码里（test-accel-config 的 49 条白名单与
 * test-product-round 的双向集合锁都按源码文本对账），本工厂不持有任何路径。
 *
 * @param {object} helpers 与各端点文件同一套注入：isLocalRequest / guardWriteRequest /
 *   readJsonBody / respondJson / log
 * @returns {(spec:{path:string, method?:string, guard?:boolean, parse?:boolean,
 *   handler:(ctx:{req:object,res:object,url:URL,body?:object})=>Promise<void>}) =>
 *   {kind:'exact', path:string, handler:Function}}
 */
export function makeRouteFactory(helpers) {
  const { isLocalRequest, guardWriteRequest, readJsonBody, respondJson, log } = helpers
  return function route(spec) {
    const { path, method = 'GET', guard = false, parse = false, handler } = spec
    const methods = String(method).split(',').map((s) => s.trim()).filter(Boolean)
    const wrapped = async (req, res) => {
      if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
      const m = String(req.method ?? '').toUpperCase()
      if (!methods.includes(m)) { respondJson(res, { ok: false, reason: methods.join(' / ') + ' only' }, 405); return }
      if (guard && !guardWriteRequest(req, res)) return
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const body = parse ? ((await readJsonBody(req)) ?? {}) : undefined
        await handler({ req, res, url, body })
      } catch (error) {
        log?.('error', `[route ${path}]`, String(error?.message ?? error))
        respondJson(res, { ok: false, reason: '处理失败（详见插件日志）' }, 500)
      }
    }
    return { kind: 'exact', path, handler: wrapped }
  }
}
