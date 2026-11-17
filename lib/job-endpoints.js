// 设计说明已外置 → docs/added-modules-design-notes.md#job-endpoints-note-001（原 L1-22）
export function makeJobHandlers(deps) {
  const { isLocalRequest, guardWriteRequest, respondJson, readJsonBody, queue, log } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 日志不可用也无所谓 */ } }

  const jobsHandler = async (req, res) => {
    if (!isLocalRequest(req)) { respondJson(res, { ok: false, reason: 'local requests only' }, 403); return }
    const method = String(req.method ?? 'GET').toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      try {
        respondJson(res, { ok: true, jobs: queue.list(), stats: queue.stats() })
      } catch (error) {
        warn(`队列列表读取失败：${error?.message ?? error}`)
        respondJson(res, { ok: false, reason: '队列状态读取失败（详见插件日志）' }, 500)
      }
      return
    }
    if (method !== 'POST') { respondJson(res, { ok: false, reason: 'GET / POST only' }, 405); return }
    if (!guardWriteRequest(req, res)) return

    try {
      const body = (await readJsonBody(req)) ?? {}
      const action = String(body?.action ?? '').trim()
      if (action === 'pause') {
        const r = queue.pause()
        respondJson(res, { ok: true, action, paused: r.paused === true })
        return
      }
      if (action === 'resume') {
        const r = queue.resume()
        respondJson(res, { ok: true, action, paused: r.paused === true })
        return
      }
      if (action === 'cancel') {
        const r = queue.cancel(body?.id)
        // 不 ok 时把队列的真实原因带回（not found / already finished），不假装取消成功。
        respondJson(res, { ok: r.ok === true, action, id: r.id, reason: r.reason ?? '', job: r.job ?? {} })
        return
      }
      respondJson(res, { ok: false, reason: "action 必须是 'cancel' / 'pause' / 'resume'" }, 400)
    } catch (error) {
      warn(`队列操作失败：${error?.message ?? error}`)
      respondJson(res, { ok: false, reason: '队列操作失败（详见插件日志）' }, 500)
    }
  }

  return { jobsHandler }
}

/** 挂到 host 的 reg() 上；返回路径 → handler 的清单，便于测试核对。 */
export function jobRouteTable(handlers) {
  return [['/api/qwen-paint/jobs', handlers.jobsHandler]]
}
