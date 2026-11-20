// 设计说明已外置 → docs/tool-parameters-design-notes.md#history-admin-note-001（原 L1-14）
import path from 'node:path'
import { createRequire } from 'node:module'

export const ADMIN_COLUMNS = Object.freeze([
  ['accel_chain', 'TEXT'], ['degraded', 'INTEGER'], ['degrade_reasons', 'TEXT'],
  ['vram_budget_mb', 'INTEGER'], ['timings', 'TEXT'], ['duration_ms', 'INTEGER'],
  ['cold', 'INTEGER'],
])
export const UPDATE_WHITELIST = Object.freeze([
  'prompt', 'model', 'kind', 'steps', 'cfg', 'seed', 'accel_chain', 'degrade_reasons',
])
export const FILTER_KEYS = Object.freeze([
  'keyword', 'kind', 'date_from', 'date_to', 'width', 'height',
  'min_width', 'max_width', 'min_height', 'max_height',
  'accel_chain', 'degraded', 'cold', 'include_deleted', 'limit', 'offset',
])
const SAFE_LIMIT = 500

/** 纯函数：按已有列名算出需要执行的幂等迁移语句。 */
export function migrateStatements(existingCols = []) {
  const have = new Set(Array.isArray(existingCols) ? existingCols : [])
  return ADMIN_COLUMNS.filter(([name]) => !have.has(name))
    .map(([name, type]) => `ALTER TABLE images ADD COLUMN ${name} ${type}`)
}

/** 纯函数：参数化 WHERE 构造。返回值只有占位符 SQL 与 params，绝不拼用户输入。 */
export function buildAdvancedWhere(filters = {}) {
  const where = []
  const params = []
  const f = filters && typeof filters === 'object' ? filters : {}
  if (f.include_deleted !== true) where.push('deleted = 0')
  if (f.keyword) { where.push('prompt LIKE ?'); params.push('%' + String(f.keyword).slice(0, 120) + '%') }
  if (f.kind) { where.push('kind = ?'); params.push(String(f.kind).slice(0, 32)) }
  if (f.date_from) { where.push('created_at >= ?'); params.push(String(f.date_from).slice(0, 64)) }
  if (f.date_to) { where.push('created_at <= ?'); params.push(String(f.date_to).slice(0, 64)) }
  if (Number.isFinite(f.width)) { where.push('width = ?'); params.push(f.width) }
  if (Number.isFinite(f.height)) { where.push('height = ?'); params.push(f.height) }
  if (Number.isFinite(f.min_width)) { where.push('width >= ?'); params.push(f.min_width) }
  if (Number.isFinite(f.max_width)) { where.push('width <= ?'); params.push(f.max_width) }
  if (Number.isFinite(f.min_height)) { where.push('height >= ?'); params.push(f.min_height) }
  if (Number.isFinite(f.max_height)) { where.push('height <= ?'); params.push(f.max_height) }
  if (f.accel_chain) { where.push('accel_chain LIKE ?'); params.push('%' + String(f.accel_chain).slice(0, 64) + '%') }
  if (f.degraded === true || f.degraded === '1' || f.degraded === 1) {
    where.push('degraded = 1')
  } else if (f.degraded === false || f.degraded === '0' || f.degraded === 0) {
    where.push('(degraded = 0 OR degraded IS NULL)')
  }
  if (f.cold === true || f.cold === '1' || f.cold === 1) where.push('cold = 1')
  else if (f.cold === false || f.cold === '0' || f.cold === 0) where.push('(cold = 0 OR cold IS NULL)')
  return {
    clause: where.length > 0 ? 'WHERE ' + where.join(' AND ') : '',
    params,
    limit: Number.isFinite(f.limit) ? Math.max(1, Math.min(SAFE_LIMIT, Math.floor(f.limit))) : 50,
    offset: Number.isFinite(f.offset) ? Math.max(0, Math.floor(f.offset)) : 0,
  }
}

/** 导出用的脱敏投影：不含 file_path / prompt / 任何路径。 */
export function sanitizeExportRow(row = {}) {
  return {
    id: row.id ?? null, kind: row.kind ?? null, tool_name: row.tool_name ?? null,
    created_at: row.created_at ?? null, width: row.width ?? null, height: row.height ?? null,
    steps: row.steps ?? null, model: row.model ?? null,
    accel_chain: row.accel_chain ?? null, degraded: row.degraded === 1,
    vram_budget_mb: row.vram_budget_mb ?? null, duration_ms: row.duration_ms ?? null,
    cold: row.cold === 1,
  }
}

/**
 * @param {object} deps
 * @param {(sql:string,params:any[])=>any} deps.sqlRun
 * @param {(sql:string,params:any[])=>any[]} deps.sqlAll
 * @param {()=>number} [deps.now]
 * @param {(path:string)=>void} [deps.unlink] 只在显式 deleteFile 时调用
 * @param {(level:string,msg:string)=>void} [deps.log]
 */
export function makeHistoryAdmin({ sqlRun, sqlAll, now, unlink, log } = {}) {
  const ready = typeof sqlRun === 'function' && typeof sqlAll === 'function'
  const stamp = () => (typeof now === 'function' ? now() : Date.now())
  const unavailable = (reason) => ({ ok: false, reason, affected: 0 })

  const api = {
    available: ready,
    migrate() {
      if (!ready) return unavailable('历史库不可用')
      try {
        const cols = sqlAll('PRAGMA table_info(images)', []) || []
        const names = cols.map((c) => c?.name)
        const stmts = migrateStatements(names)
        for (const s of stmts) sqlRun(s, [])
        return { ok: true, added: stmts.map((s) => s.split(' ')[5]), affected: stmts.length }
      } catch (error) {
        log?.('warn', '历史库迁移失败：' + (error?.message ?? error))
        return unavailable('历史库迁移失败（详见插件日志）')
      }
    },
    query(filters = {}) {
      if (!ready) return { ok: false, rows: [], reason: '历史库不可用' }
      try {
        const w = buildAdvancedWhere(filters)
        const rows = sqlAll(
          'SELECT * FROM images ' + w.clause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?',
          [...w.params, w.limit, w.offset]) || []
        return { ok: true, rows, total: rows.length, reason: '' }
      } catch (error) {
        log?.('warn', '历史查询失败：' + (error?.message ?? error))
        return { ok: false, rows: [], reason: '查询失败（详见插件日志）' }
      }
    },
    update(id, patch = {}) {
      if (!ready) return unavailable('历史库不可用')
      const keys = Object.keys(patch).filter((k) => UPDATE_WHITELIST.includes(k))
      if (!String(id)) return unavailable('没给记录 id')
      if (keys.length === 0) return unavailable('没有可修改的字段')
      try {
        const sql = 'UPDATE images SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?'
        sqlRun(sql, [...keys.map((k) => patch[k]), id])
        return { ok: true, affected: 1, fields: keys, reason: '' }
      } catch (error) {
        log?.('warn', '历史更新失败：' + (error?.message ?? error))
        return unavailable('更新失败（详见插件日志）')
      }
    },
    restore(id) {
      if (!ready) return unavailable('历史库不可用')
      if (!String(id)) return unavailable('没给记录 id')
      sqlRun('UPDATE images SET deleted = 0 WHERE id = ?', [id])
      return { ok: true, affected: 1, reason: '' }
    },
    hardDelete(id, options = {}) {
      if (!ready) return unavailable('历史库不可用')
      if (!String(id)) return unavailable('没给记录 id')
      // 默认绝不删磁盘文件；要删必须调用方显式注入 unlink 且置 deleteFile。
      let fileRemoved = false
      if (options.deleteFile === true && typeof unlink === 'function' && options.filePath) {
        try { unlink(options.filePath); fileRemoved = true } catch { /* 文件不在就只删记录 */ }
      }
      sqlRun('DELETE FROM images WHERE id = ?', [id])
      return { ok: true, affected: 1, fileRemoved, reason: '' }
    },
    purge({ before, kind } = {}) {
      if (!ready) return unavailable('历史库不可用')
      const where = []
      const params = []
      if (before) { where.push('created_at < ?'); params.push(String(before).slice(0, 64)) }
      if (kind) { where.push('kind = ?'); params.push(String(kind).slice(0, 32)) }
      if (where.length === 0) return unavailable('清空需同时给 before 与/或 kind，避免误删全部')
      sqlRun('UPDATE images SET deleted = 1 ' + 'WHERE ' + where.join(' AND '), params)
      return { ok: true, reason: '已批量软删除，磁盘文件未动' }
    },
    archiveCold({ olderThanDays = 30 } = {}) {
      if (!ready) return unavailable('历史库不可用')
      const days = Number.isFinite(olderThanDays) ? Math.max(1, Math.floor(olderThanDays)) : 30
      const cutoff = new Date(stamp() - days * 86400000).toISOString()
      sqlRun('UPDATE images SET cold = 1 WHERE created_at < ? AND (cold = 0 OR cold IS NULL)', [cutoff])
      return { ok: true, cutoff, reason: '只标冷热，不搬动磁盘文件' }
    },
    exportRows(filters = {}) {
      const q = api.query(filters)
      if (!q.ok) return { ok: false, lines: [], reason: q.reason }
      return { ok: true, lines: q.rows.map((r) => JSON.stringify(sanitizeExportRow(r))), reason: '' }
    },
  }
  return api
}

// schemaOf：宿主投影要求 parameters 必须是无损 JSON（undefined 会让整轮 run 失败）。
const schemaOf = (properties) => ({ type: 'object', properties, additionalProperties: false })
const STR = { type: 'string' }
const INT = { type: 'integer' }
const BOOL = { type: 'boolean' }

/** Agent 用：标准化历史查询工具。 */
export function makeHistoryQueryTool(deps = {}) {
  const admin = deps.admin || makeHistoryAdmin(deps)
  return {
    name: 'query_history',
    description: '按结构化条件检索本机生成历史（图片 / 视频 / 语音统一一张索引表）。'
      + '可用过滤：时间范围 date_from/date_to、尺寸 width/height 或 min_width/max_width/min_height/max_height、'
      + '类型 kind(image/video/audio/other)、加速链 accel_chain、是否降级 degraded、冷热 cold、关键词 keyword、分页 limit/offset。'
      + '典型用法：先把「昨天那张 1024 宽且发生降级的图」找出来，再把它作为 references 传给 inpaint_image 或 draw_image。'
      + '返回脱敏字段，不含绝对路径与 prompt 全文。纯本地、只读。',
    parameters: schemaOf({
      date_from: STR, date_to: STR, width: INT, height: INT,
      min_width: INT, max_width: INT, min_height: INT, max_height: INT,
      kind: { type: 'string', enum: ['image', 'video', 'audio', 'other'] },
      accel_chain: STR, degraded: BOOL, cold: BOOL, keyword: STR,
      include_deleted: BOOL, limit: INT, offset: INT,
    }),
    timeoutMs: 30 * 1000,
    output: { schema: { type: 'object', properties: {
      ok: { type: 'boolean' }, rows: { type: 'array' }, total: { type: 'number' },
      summary: { type: 'string' }, reason: { type: 'string' },
    } } },
    async execute(args = {}) {
      const q = admin.query(args)
      return { ok: q.ok, rows: q.ok ? q.rows.map(sanitizeExportRow) : [], total: q.total || 0,
        summary: q.ok ? '匹配 ' + q.total + ' 条' : '查询不可用', reason: q.reason || '' }
    },
  }
}

/**
 * 自包含打开既有 SQLite 库（与 lib/history-store.js 同一个文件）。
 * Node 18 / 20 没有 node:sqlite 时**如实降级为不可用**，绝不假装历史能力可用。
 */
export function openHistoryAdmin({ outputDir, log } = {}) {
  if (!outputDir) return makeHistoryAdmin({ log })
  let DatabaseSync
  try {
    DatabaseSync = createRequire(import.meta.url)('node:sqlite')?.DatabaseSync
  } catch {
    return makeHistoryAdmin({ log })
  }
  if (typeof DatabaseSync !== 'function') return makeHistoryAdmin({ log })
  try {
    const db = new DatabaseSync(path.join(outputDir, '.qwen-paint-history.db'))
    const admin = makeHistoryAdmin({
      sqlRun: (sql, params = []) => db.prepare(sql).run(...params),
      sqlAll: (sql, params = []) => db.prepare(sql).all(...params),
      log,
    })
    admin.migrate()
    return admin
  } catch (error) {
    log?.('warn', '历史管理库打开失败：' + (error?.message ?? error))
    return makeHistoryAdmin({ log })
  }
}

/** 端点表：全部只放行本机；错误回固定文案，不回吐 error.message。 */
export function historyAdminRouteTable(deps = {}) {
  const { admin, respondJson, readJsonBody, isLocalRequest, log } = deps
  const send = (res, body, status) => respondJson(res, body, status)
  const guard = (req, res, method) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      send(res, { ok: false, reason: 'local requests only' }, 403); return false
    }
    if (req?.method && req.method !== method) {
      send(res, { ok: false, reason: 'method not allowed' }, 405); return false
    }
    // ★ 2026-11-17 审计：POST 补媒体类型闸 —— 旧浏览器跨站 simple request 只能发
    //   text/plain 或 form-urlencoded，现役浏览器另有 isTrustedRequest 兜底，这里堵住旧口子。
    //   不带 content-type 的无 body 请求照旧放行（update/restore/purge 都要求 id，空 body 本就无效）。
    if (method === 'POST') {
      const ct = String(req?.headers?.['content-type'] ?? '').toLowerCase()
      if (ct !== '' && !ct.startsWith('application/json')) {
        send(res, { ok: false, reason: 'content-type must be application/json' }, 415); return false
      }
    }
    return true
  }
  const wrap = (method, fn) => async (req, res) => {
    if (!guard(req, res, method)) return
    try {
      let body = {}
      if (method === 'POST' && typeof readJsonBody === 'function') {
        body = await readJsonBody(req) || {}
      } else if (method === 'GET') {
        body = req?.query || {}
      }
      send(res, await fn(body), 200)
    } catch (error) {
      log?.('warn', '历史管理端点异常：' + (error?.message ?? error))
      send(res, { ok: false, reason: '请求处理失败（详见插件日志）' }, 500)
    }
  }
  const m = deps.admin || makeHistoryAdmin(deps)
  return [
    { path: '/api/qwen-paint/history/query', method: 'GET',
      handler: wrap('GET', (q) => m.query(q)) },
    { path: '/api/qwen-paint/history/update', method: 'POST',
      handler: wrap('POST', (b) => m.update(b.id, b.patch || b)) },
    { path: '/api/qwen-paint/history/restore', method: 'POST',
      handler: wrap('POST', (b) => m.restore(b.id)) },
    { path: '/api/qwen-paint/history/purge', method: 'POST',
      handler: wrap('POST', (b) => m.purge(b)) },
    { path: '/api/qwen-paint/history/archive', method: 'POST',
      handler: wrap('POST', (b) => m.archiveCold(b)) },
    { path: '/api/qwen-paint/history/hard-delete', method: 'POST',
      // ★ 2026-11-17 审计：不转发整个 body —— options 里的 deleteFile/filePath 是
      // 「显式注入 unlink 的内部调用方」才有的能力（默认绝不删磁盘文件），HTTP 入口
      // 一律传空 options，防止未来有人注入 unlink 后 body 直接变成任意文件删除口。
      handler: wrap('POST', (b) => m.hardDelete(b.id, {})) },
    { path: '/api/qwen-paint/history/export.jsonl', method: 'GET',
      handler: wrap('GET', (q) => m.exportRows(q)) },
  ]
}
