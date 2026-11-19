/**
 * 多层并发约束层 for dsh_state.db
 *
 * 与外部 dsh-db.py 交接库完全互操作：
 *  - 时间格式统一为 UTC 'YYYY-MM-DD HH:mm:ss'（非 ISO T/Z）
 *  - resource_locks 与遗留 regression_lock 表镜像同步
 *  - 无 version/updated_at 列依赖（真实库没有这两列）
 *  - 不强制 WAL（沿用库既有 journal_mode；短命 CLI 抢 -shm 会拿只读连接）
 *
 * 零依赖：用 Node 22 内置 node:sqlite（DatabaseSync），替代未安装的 better-sqlite3。
 *
 * 用法：
 *   import { createConstraints } from './db-constraints.js'
 *   const c = createConstraints('/path/to/dsh_state.db')
 *   const ok = c.acquireLock('regression', 'agent-a', 'wt-a')
 *   c.close()
 *
 * 不写死任何本机路径 —— 路径必须由调用方显式传入（测试传临时库）。
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** UTC 秒级时间戳，格式与 Python dsh-db.py 的 now_utc() 一致 */
function nowUtc(offsetSeconds = 0) {
  const d = new Date(Date.now() + offsetSeconds * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** 把 lease 秒数换算为 UTC 时间戳（dsh-db.py 用 timedelta(hours=...) ，这里统一秒） */
function leaseUtc(leaseSeconds) {
  return nowUtc(leaseSeconds)
}

/**
 * 创建一套绑定到具体 DB 文件的约束实例。
 * @param {string} dbPath  交接库绝对路径（调用方负责存在性）
 * @param {{busyTimeoutMs?:number}} [opts]
 */
export function createConstraints(dbPath, opts = {}) {
  if (!dbPath) throw new Error('[db-constraints] dbPath 必填，禁止写死本机路径')
  const db = new DatabaseSync(dbPath)
  const busyMs = opts.busyTimeoutMs ?? 10000
  // 遵循库既有 journal_mode，不强制 WAL；只设 busy_timeout + 瞬态重试
  try { db.exec(`PRAGMA busy_timeout = ${busyMs}`) } catch {}

  /** 瞬态写错误（locked/busy/readonly）重试，对齐 Python 侧策略 */
  function withRetry(fn, attempts = 5) {
    let last
    for (let i = 0; i < attempts; i++) {
      try { return fn() } catch (e) {
        const msg = String(e && e.message || e).toLowerCase()
        const transient = /locked|busy|readonly|database is locked/.test(msg)
        if (!transient || i === attempts - 1) throw e
        last = e
      }
    }
    throw last
  }

  /** BEGIN IMMEDIATE 事务包装（node:sqlite 无 db.transaction()） */
  function txImmediate(fn) {
    return withRetry(() => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        throw e
      }
    })
  }

  function txReadOnly(fn) {
    return withRetry(() => {
      db.exec('BEGIN DEFERRED')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        try { db.exec('ROLLBACK') } catch {}
        throw e
      }
    })
  }

  /** 镜像 legacy regression_lock（与 Python _mirror_legacy_lock 同语义） */
  function mirrorLegacyLock(resource, isLocked, owner, lockedAt, releasedAt) {
    if (resource !== 'regression') return
    db.prepare(`UPDATE regression_lock SET is_locked=?, owner_agent=?, locked_at=?, released_at=? WHERE id=1`)
      .run(isLocked, owner, lockedAt, releasedAt)
  }

  /** 原子抢锁：仅当空闲或租约过期时接管，返回是否抢到 */
  function acquireLock(resource, ownerAgent, worktree = null, leaseSeconds = 300) {
    const ts = nowUtc()
    const until = leaseUtc(leaseSeconds)
    const changed = txImmediate(() => {
      const r = db.prepare(`
        INSERT INTO resource_locks (resource, is_locked, owner_agent, worktree, locked_at, lease_until, released_at)
        VALUES (?, 1, ?, ?, ?, ?, NULL)
        ON CONFLICT(resource) DO UPDATE SET
          is_locked = 1,
          owner_agent = excluded.owner_agent,
          worktree = excluded.worktree,
          locked_at = excluded.locked_at,
          lease_until = excluded.lease_until,
          released_at = NULL
        WHERE resource_locks.is_locked = 0
           OR resource_locks.lease_until IS NULL
           OR resource_locks.lease_until <= ?
      `).run(resource, ownerAgent, worktree, ts, until, nowUtc())
      return r.changes > 0
    })
    if (changed) mirrorLegacyLock(resource, 1, ownerAgent, ts, null)
    return changed
  }

  /** 释放锁：仅持有者可释放（owner 校验），失败返回 false */
  function releaseLock(resource, ownerAgent) {
    const ts = nowUtc()
    const changed = txImmediate(() => {
      const row = db.prepare('SELECT owner_agent FROM resource_locks WHERE resource=?').get(resource)
      if (!row || row.owner_agent !== ownerAgent) return false
      const r = db.prepare(`
        UPDATE resource_locks SET is_locked=0, lease_until=NULL, released_at=?
        WHERE resource=? AND owner_agent=?
      `).run(ts, resource, ownerAgent)
      return r.changes > 0
    })
    if (changed) mirrorLegacyLock(resource, 0, ownerAgent, null, ts)
    return changed
  }

  /** 续约：仅持有者可续 */
  function renewLock(resource, ownerAgent, leaseSeconds = 300) {
    const until = leaseUtc(leaseSeconds)
    return txImmediate(() => db.prepare(`
      UPDATE resource_locks SET lease_until=?
      WHERE resource=? AND owner_agent=? AND is_locked=1
    `).run(until, resource, ownerAgent).changes > 0)
  }

  function getLock(resource) {
    return txReadOnly(() => db.prepare('SELECT * FROM resource_locks WHERE resource=?').get(resource) ?? null)
  }

  /** 全局资源便捷封装（regression / release） */
  function acquireRegressionLock(agent) {
    return acquireLock('regression', agent, null, 600) // 10min
  }
  function releaseRegressionLock(agent) {
    return releaseLock('regression', agent)
  }

  /** 工作项原子认领（撞题防护），仅当 released 或租约过期 */
  function claimWorkItem(topic, topicRaw, ownerAgent, worktree = null, leaseSeconds = 1800) {
    const ts = nowUtc()
    const until = leaseUtc(leaseSeconds)
    return txImmediate(() => db.prepare(`
      INSERT INTO work_items (topic, topic_raw, owner_agent, worktree, status, claimed_at, lease_until, released_at, note)
      VALUES (?, ?, ?, ?, 'claimed', ?, ?, NULL, NULL)
      ON CONFLICT(topic) DO UPDATE SET
        status = 'claimed',
        owner_agent = excluded.owner_agent,
        worktree = excluded.worktree,
        claimed_at = excluded.claimed_at,
        lease_until = excluded.lease_until,
        released_at = NULL,
        note = NULL
      WHERE work_items.status = 'released'
         OR work_items.lease_until IS NULL
         OR work_items.lease_until <= ?
    `).run(topic, topicRaw, ownerAgent, worktree, ts, until, nowUtc()).changes > 0)
  }

  function releaseWorkItem(topic, ownerAgent) {
    const ts = nowUtc()
    return txImmediate(() => db.prepare(`
      UPDATE work_items SET status='released', released_at=?
      WHERE topic=? AND owner_agent=? AND status='claimed'
    `).run(ts, topic, ownerAgent).changes > 0)
  }

  function getWorkItem(topic) {
    return txReadOnly(() => db.prepare('SELECT * FROM work_items WHERE topic=?').get(topic) ?? null)
  }

  /** 审计/测试记录（纯 INSERT，无冲突） */
  function appendAuditLog(agentId, action, resource, beforeHash = '', afterHash = '') {
    return db.prepare(`INSERT INTO audit_logs (agent_id, action, resource, before_hash, after_hash)
      VALUES (?, ?, ?, ?, ?)`).run(agentId, action, resource, beforeHash, afterHash).changes > 0
  }
  function appendTestRecord(version, testType, status, failReason = '') {
    return db.prepare(`INSERT INTO test_records (version, test_type, status, fail_reason)
      VALUES (?, ?, ?, ?)`).run(version, testType, status, failReason).changes > 0
  }

  function close() { db.close() }

  return {
    db, txImmediate, txReadOnly,
    acquireLock, releaseLock, renewLock, getLock,
    acquireRegressionLock, releaseRegressionLock,
    claimWorkItem, releaseWorkItem, getWorkItem,
    appendAuditLog, appendTestRecord, close,
    nowUtc,
  }
}

/** 单 Writer 队列（高并发写串行化，纯内存，不依赖 DB） */
export class WriterQueue {
  constructor() { this.queue = []; this.running = false }
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      void this._process()
    })
  }
  async _process() {
    if (this.running || this.queue.length === 0) return
    this.running = true
    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift()
      try { resolve(await fn()) } catch (e) { reject(e) }
    }
    this.running = false
  }
  get size() { return this.queue.length }
}

export const writerQueue = new WriterQueue()

export default { createConstraints, WriterQueue, writerQueue }
