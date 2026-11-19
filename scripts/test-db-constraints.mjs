#!/usr/bin/env node
/**
 * db-constraints 约束层测试（全离线，用 C 盘临时库，不碰真实交接库）
 * ok() 风格：ok(cond, msg)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createConstraints, WriterQueue, writerQueue } from '../lib/db-constraints.js'

let pass = 0, fail = 0
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg) }
  else { fail++; console.log('  ✗', msg) }
}

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-constraints-'))
const dbPath = path.join(dir, 'test.db')

// 建与真实库同构的最小 schema（含镜像表）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')
const boot = new DatabaseSync(dbPath)
boot.exec(`
  CREATE TABLE resource_locks (
    resource TEXT PRIMARY KEY, is_locked INTEGER DEFAULT 0,
    owner_agent TEXT, worktree TEXT, locked_at DATETIME,
    lease_until DATETIME, released_at DATETIME);
  CREATE TABLE regression_lock (id INTEGER PRIMARY KEY CHECK(id=1), is_locked INTEGER DEFAULT 0,
    owner_agent TEXT, locked_at DATETIME, released_at DATETIME);
  INSERT INTO regression_lock(id,is_locked) VALUES(1,0);
  CREATE TABLE work_items (
    topic TEXT PRIMARY KEY, topic_raw TEXT, owner_agent TEXT, worktree TEXT,
    status TEXT DEFAULT 'claimed', claimed_at DATETIME, lease_until DATETIME,
    released_at DATETIME, note TEXT);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, action TEXT,
    resource TEXT, before_hash TEXT, after_hash TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE test_records (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT, test_type TEXT,
    status TEXT, fail_reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`)
boot.close()

const c = createConstraints(dbPath)

console.log('— 资源锁 —')
ok(c.acquireLock('regression', 'agent-a', 'wt-a') === true, '首次抢锁成功')
ok(c.acquireLock('regression', 'agent-b', 'wt-b') === false, '他人再抢同资源失败（原子互斥）')
let lock = c.getLock('regression')
ok(lock.owner_agent === 'agent-a' && lock.is_locked === 1, '持锁者是 agent-a')
let legacy = c.db.prepare('SELECT * FROM regression_lock WHERE id=1').get()
ok(legacy.is_locked === 1 && legacy.owner_agent === 'agent-a', 'legacy regression_lock 镜像已同步')

console.log('— 释放与续约 —')
ok(c.releaseLock('regression', 'agent-b') === false, '非持有者释放失败')
ok(c.releaseLock('regression', 'agent-a') === true, '持有者释放成功')
ok(c.getLock('regression').is_locked === 0, '释放后 is_locked=0')
ok(c.acquireLock('regression', 'agent-c', 'wt-c') === true, '释放后他人可接管')

console.log('— 租约过期接管 —')
const c2 = createConstraints(dbPath)
// 人为把租约改到过去
c.db.prepare("UPDATE resource_locks SET lease_until='2020-01-01 00:00:00' WHERE resource='regression'").run()
c.db.prepare("UPDATE regression_lock SET owner_agent='agent-c' WHERE id=1").run()
ok(c2.acquireLock('regression', 'agent-d', 'wt-d') === true, '租约过期后他人可接管')

console.log('— 工作项撞题防护 —')
const topic = 'fix::a2a-bug'
ok(c.claimWorkItem(topic, 'fix a2a bug', 'agent-a', 'wt-a') === true, '首次认领问题成功')
ok(c.claimWorkItem(topic, 'fix a2a bug', 'agent-b', 'wt-b') === false, '他人认领同一问题被拒（防撞题）')
ok(c.releaseWorkItem(topic, 'agent-a') === true, '认领者释放成功')
ok(c.claimWorkItem(topic, 'fix a2a bug', 'agent-b', 'wt-b') === true, '释放后他人可认领')
ok(c.getWorkItem(topic).owner_agent === 'agent-b', '认领者已切换为 agent-b')

console.log('— 审计与记录 —')
ok(c.appendAuditLog('agent-a', 'test', 'regression') === true, '审计追加成功')
ok(c.appendTestRecord('1.2.3', 'offline', 'PASS') === true, '测试记录追加成功')

console.log('— 时间格式兼容性 —')
const fmt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
ok(fmt.test(c.nowUtc()), 'nowUtc 格式与 Python dsh-db.py 一致（无 T/Z）')

console.log('— WriterQueue 串行 —')
const q = new WriterQueue()
const order = []
await Promise.all([
  q.enqueue(async () => { order.push(1); return 1 }),
  q.enqueue(async () => { order.push(2); return 2 }),
  q.enqueue(async () => { order.push(3); return 3 }),
])
ok(order.join(',') === '1,2,3', 'WriterQueue 严格串行执行')
ok(writerQueue instanceof WriterQueue, '默认 writerQueue 单例导出正常')

c.close()
c2.close()
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
