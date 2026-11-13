/**
 * lib/history-store.js —— 生成历史的**正式存储层**（SQLite）。
 *
 * ## 为什么是 SQLite
 *   提示词 / 参数 / 时间 / 工具名 / 文件路径要支持搜索、筛选、分页与血缘，
 *   单文件 JSONL 到几百条就难维护。这里用 Node 内置的 `node:sqlite`（零外部依赖），
 *   数据落在 `<outputDir>/.qwen-paint-history.db`，Agent 工具与界面共用同一份。
 *
 * ## 与既有 JSONL 的关系（重要）
 *   项目早有 `<outputDir>/.qwen-paint-memory.jsonl`（dsh-auto-memory 的联动通道）。
 *   它有外部消费者，**不删不改**；本模块是并列的新历史层。
 *   Node < 22.5 没有 `node:sqlite` ⇒ 不静默改成「再摊一个 JSON 文件」，而是
 *   `available:false` + 复用既有 JSONL 的读取做内存过滤分页，并如实标 `persistent:false`。
 *
 * ## 边界
 *   · file_path 只存**相对 outputDir** 的路径（绝对路径迁移后不会失效，也不入库绝对路径）；
 *   · 所有 SQL 参数化；所有失败只记日志、绝不抛给主流程；
 *   · 删除是软删除（deleted=1），**绝不删用户磁盘上的图片 / 视频文件**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const HISTORY_DB_NAME = '.qwen-paint-history.db'
export const HISTORY_NODE_MIN = '22.5.0'
export const HISTORY_KINDS = ['image', 'video', 'audio', 'other']

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/iu
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/iu
const AUDIO_EXT = /\.(mp3|flac|wav|ogg|m4a)$/iu

export function kindOf(file) {
  const f = String(file ?? '')
  if (IMAGE_EXT.test(f)) return 'image'
  if (VIDEO_EXT.test(f)) return 'video'
  if (AUDIO_EXT.test(f)) return 'audio'
  return 'other'
}

/** 绝对路径 → 相对 outputDir 的 POSIX 风格路径；落在目录外一律返回 ''（拒绝入库）。 */
export function toRelativePath(outputDir, file) {
  const abs = String(file ?? '').trim()
  const base = String(outputDir ?? '').trim()
  if (!abs || !base) return ''
  const rel = path.relative(path.resolve(base), path.resolve(abs))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return rel.split(path.sep).join('/')
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.trunc(n))) : dflt
}

function loadSqlite(injected) {
  if (injected !== undefined) return injected
  try { return require('node:sqlite') } catch { return null }
}

/**
 * @param {object} deps
 * @param {string} deps.outputDir 出图目录（DB 放在其中）
 * @param {(level:string,msg:string)=>void} [deps.log]
 * @param {(limit:number)=>Promise<object[]>} [deps.fallbackRecent] 无 SQLite 时读既有 JSONL
 * @param {object} [deps.sqliteModule] 测试注入
 * @param {string} [deps.dbPath] 测试注入（覆盖默认 DB 位置）
 */
export function createHistoryStore(deps = {}) {
  const { outputDir = '', log, fallbackRecent, sqliteModule, dbPath } = deps
  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 日志不可用也无所谓 */ } }
  const dbFile = dbPath || (outputDir ? path.join(outputDir, HISTORY_DB_NAME) : '')
  const mod = loadSqlite(sqliteModule)
  let db = null
  let available = false
  let reason = ''

  if (!dbFile) reason = 'outputDir 未配置'
  else if (!mod || typeof mod.DatabaseSync !== 'function') {
    reason = `node:sqlite 不可用（需要 Node >= ${HISTORY_NODE_MIN}）`
  } else {
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true })
      db = new mod.DatabaseSync(dbFile)
      db.exec(`CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        prompt TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        steps INTEGER, cfg REAL, seed INTEGER,
        width INTEGER, height INTEGER,
        kind TEXT NOT NULL DEFAULT 'image',
        created_at TEXT NOT NULL,
        parent_id INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0,
        extra TEXT NOT NULL DEFAULT '{}'
      )`)
      db.exec('CREATE INDEX IF NOT EXISTS idx_hist_created ON images(created_at DESC)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_hist_kind ON images(kind, deleted)')
      available = true
    } catch (error) {
      reason = `SQLite 初始化失败：${error?.message ?? error}`
      warn(`历史库初始化失败（不影响出图）：${error?.message ?? error}`)
      try { db?.close() } catch { /* 已经坏了 */ }
      db = null
    }
  }

  const asRow = (r, withAbs) => {
    const row = {
      id: r.id,
      file_path: r.file_path,
      prompt: r.prompt ?? '',
      tool_name: r.tool_name ?? '',
      model: r.model ?? '',
      steps: r.steps ?? null,
      cfg: r.cfg ?? null,
      seed: r.seed ?? null,
      width: r.width ?? null,
      height: r.height ?? null,
      kind: r.kind ?? 'other',
      created_at: r.created_at,
      parent_id: r.parent_id ?? null,
    }
    if (withAbs && outputDir) {
      row.path = path.join(outputDir, r.file_path)
      row.preview_url = 'api/qwen-paint/file?path=' + encodeURIComponent(row.path)
    }
    return row
  }

  /** 写入一条历史。重复 file_path 直接忽略（draw 详细版优先于钩子兜底版）。失败不抛。 */
  function record(entry = {}) {
    if (!available || !db) return false
    const rel = entry.file_path && !path.isAbsolute(String(entry.file_path))
      ? String(entry.file_path)
      : toRelativePath(outputDir, entry.file_path ?? entry.path)
    if (!rel) return false
    try {
      db.prepare(`INSERT OR IGNORE INTO images
        (file_path, prompt, tool_name, model, steps, cfg, seed, width, height, kind, created_at, parent_id, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          rel,
          String(entry.prompt ?? '').slice(0, 1000),
          String(entry.tool_name ?? '').slice(0, 64),
          String(entry.model ?? '').slice(0, 128),
          Number.isFinite(entry.steps) ? Math.trunc(entry.steps) : null,
          Number.isFinite(entry.cfg) ? Number(entry.cfg) : null,
          Number.isFinite(entry.seed) ? Math.trunc(entry.seed) : null,
          Number.isFinite(entry.width) ? Math.trunc(entry.width) : null,
          Number.isFinite(entry.height) ? Math.trunc(entry.height) : null,
          HISTORY_KINDS.includes(entry.kind) ? entry.kind : kindOf(rel),
          String(entry.created_at ?? new Date().toISOString()),
          Number.isInteger(entry.parent_id) ? entry.parent_id : null,
          JSON.stringify(entry.extra ?? {}).slice(0, 2000),
        )
      return true
    } catch (error) {
      warn(`历史写入失败（不影响出图）：${error?.message ?? error}`)
      return false
    }
  }

  const buildWhere = (o) => {
    const where = ['deleted = 0']
    const args = []
    if (HISTORY_KINDS.includes(o.kind)) { where.push('kind = ?'); args.push(o.kind) }
    if (o.keyword) {
      where.push('(prompt LIKE ? OR file_path LIKE ? OR tool_name LIKE ? OR model LIKE ?)')
      const k = `%${o.keyword}%`
      args.push(k, k, k, k)
    }
    if (o.from) { where.push('created_at >= ?'); args.push(o.from) }
    if (o.to) { where.push('created_at <= ?'); args.push(o.to) }
    return { sql: where.join(' AND '), args }
  }

  /** 搜索 / 筛选 / 分页。无 SQLite 时降级读既有 JSONL（persistent:false，如实标注）。 */
  async function query(opts = {}) {
    const o = {
      keyword: String(opts.keyword ?? '').trim().slice(0, 200),
      kind: String(opts.kind ?? '').trim(),
      from: String(opts.from ?? '').slice(0, 64),
      to: String(opts.to ?? '').slice(0, 64),
      limit: clampInt(opts.limit, 1, 50, 20),
      offset: clampInt(opts.offset, 0, 100000, 0),
    }
    const meta = { available, persistent: available, reason, db_file: dbFile }

    if (!available || !db) {
      let rows = []
      try { rows = fallbackRecent ? await fallbackRecent(100) : [] } catch { rows = [] }
      let items = rows.map((r, i) => asRow({
        id: -(i + 1),
        file_path: toRelativePath(outputDir, r?.path) || String(r?.path ?? ''),
        prompt: r?.prompt ?? '', tool_name: r?.tool_name ?? 'draw_image',
        model: r?.backend ?? '', steps: r?.steps ?? null, cfg: r?.cfg ?? null,
        seed: r?.seed ?? null, width: r?.width ?? null, height: r?.height ?? null,
        kind: kindOf(r?.path ?? ''), created_at: r?.ts ?? '',
      }, true))
      if (o.kind) items = items.filter((x) => x.kind === o.kind)
      if (o.keyword) {
        const k = o.keyword.toLowerCase()
        items = items.filter((x) => [x.prompt, x.file_path, x.tool_name, x.model]
          .some((t) => String(t).toLowerCase().includes(k)))
      }
      const total = items.length
      return { ok: true, items: items.slice(o.offset, o.offset + o.limit), total,
        limit: o.limit, offset: o.offset, ...meta }
    }

    try {
      const { sql, args } = buildWhere(o)
      const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM images WHERE ${sql}`).get(...args)?.n ?? 0)
      const rows = db.prepare(`SELECT * FROM images WHERE ${sql}
        ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, o.limit, o.offset)
      return { ok: true, items: rows.map((r) => asRow(r, true)), total,
        limit: o.limit, offset: o.offset, ...meta }
    } catch (error) {
      warn(`历史查询失败：${error?.message ?? error}`)
      return { ok: false, items: [], total: 0, limit: o.limit, offset: o.offset, ...meta,
        reason: '历史查询失败（详见插件日志）' }
    }
  }

  /** 软删除：只从历史里移除，绝不删除磁盘文件。 */
  function remove(id) {
    if (!available || !db || !Number.isInteger(Number(id))) return false
    try {
      const r = db.prepare('UPDATE images SET deleted = 1 WHERE id = ? AND deleted = 0').run(Number(id))
      return Number(r?.changes ?? 0) > 0
    } catch (error) {
      warn(`历史软删除失败：${error?.message ?? error}`)
      return false
    }
  }

  function stats() {
    if (!available || !db) return { ok: true, total: 0, by_kind: {}, ...meta() }
    function meta() { return { available, persistent: available, reason, db_file: dbFile } }
    try {
      const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM images WHERE deleted = 0 GROUP BY kind').all()
      const by_kind = {}
      for (const r of rows) by_kind[r.kind] = Number(r.n)
      return { ok: true, total: Object.values(by_kind).reduce((a, b) => a + b, 0), by_kind, ...meta() }
    } catch { return { ok: true, total: 0, by_kind: {}, ...meta() } }
  }

  function close() {
    try { db?.close() } catch { /* 已经关了 */ }
    db = null
    available = false
  }

  return { available, persistent: available, reason, db_file: dbFile,
    record, query, remove, stats, close }
}
