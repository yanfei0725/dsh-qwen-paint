/**
 * lib/history-endpoints.js —— 生成历史的本机只读 / 软删除端点。
 *
 * · GET  /api/qwen-paint/history         搜索 / 筛选 / 分页（keyword、kind、from、to、limit、offset）
 * · GET  /api/qwen-paint/history/stats   顶栏汇总（总数 / 各类型）
 * · POST /api/qwen-paint/history/delete 软删除一条（只改 deleted=1，绝不删磁盘文件）
 *
 * 安全边界：全部 isLocalRequest；写操作 POST only + guardWriteRequest；
 * 异常只写本机日志、回固定文案（不回吐 error.message）。
 */
export function makeHistoryHandlers(deps) {
  const {
    isLocalRequest, guardWriteRequest, respondJson, readJsonBody, store, log,
  } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }

  const localGet = (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return false }
    const m = String(req.method ?? 'GET').toUpperCase()
    if (m !== 'GET' && m !== 'HEAD') { respondJson(res, { ok: false, reason: 'GET only' }, 405); return false }
    return true
  }

  /** GET：历史列表。参数全部在 store 里 clamp，端点不重复造校验。 */
  const historyHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try {
      const u = new URL(req.url, 'http://127.0.0.1')
      const p = u.searchParams
      const result = await store.query({
        keyword: p.get('q') ?? p.get('keyword') ?? '',
        kind: p.get('kind') ?? '',
        from: p.get('from') ?? p.get('date_from') ?? '',
        to: p.get('to') ?? p.get('date_to') ?? '',
        limit: p.get('limit') ?? 20,
        offset: p.get('offset') ?? 0,
      })
      respondJson(res, result)
    } catch (error) {
      warn(`历史列表读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '历史暂不可用（详见插件日志）',
        items: [], total: 0, available: false, persistent: false }, 500)
    }
  }

  /** GET：汇总。 */
  const historyStatsHandler = async (req, res) => {
    if (!localGet(req, res)) return
    try { respondJson(res, store.stats()) } catch (error) {
      warn(`历史汇总读取失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '历史暂不可用（详见插件日志）' }, 500)
    }
  }

  /** POST：软删除。id 不存在时如实回 removed:false，不假装成功。 */
  const historyDeleteHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    if (String(req.method ?? '').toUpperCase() !== 'POST') {
      respondJson(res, { ok: false, reason: 'POST only' }, 405); return
    }
    if (!guardWriteRequest(req, res)) return
    try {
      const body = (await readJsonBody(req)) ?? {}
      const id = Number(body.id)
      if (!Number.isInteger(id) || id <= 0) {
        respondJson(res, { ok: false, reason: 'id 必填且须为正整数' }, 400); return
      }
      const removed = store.remove(id)
      respondJson(res, { ok: true, removed, note: removed
        ? '已从历史列表移除；磁盘文件保留'
        : '记录不存在或已被移除' })
    } catch (error) {
      warn(`历史软删除失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '删除失败（详见插件日志）' }, 500)
    }
  }

  return { historyHandler, historyStatsHandler, historyDeleteHandler }
}

/** 挂到 host 的 reg() 上；返回路径 → handler 的清单，便于测试核对。 */
export function historyRouteTable(handlers) {
  return [
    ['/api/qwen-paint/history', handlers.historyHandler],
    ['/api/qwen-paint/history/stats', handlers.historyStatsHandler],
    ['/api/qwen-paint/history/delete', handlers.historyDeleteHandler],
  ]
}
