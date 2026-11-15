#!/usr/bin/env node
/**
 * test-history-admin.mjs —— 历史「可删改 / 冷热分离 / 参数化查询」回归。
 * 全离线：SQL 执行器是假的（只记录语句与参数），不真开数据库、不碰磁盘。
 * 锁住：幂等迁移 / 参数化 / 白名单更新 / 硬删不删文件 / 拒绝无条件清空 /
 *       导出脱敏 / 工具形状 / 端点围栏与固定错误文案。
 */
import {
  ADMIN_COLUMNS, UPDATE_WHITELIST, migrateStatements, buildAdvancedWhere,
  sanitizeExportRow, makeHistoryAdmin, makeHistoryQueryTool, historyAdminRouteTable,
} from '../lib/history-admin.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, extra ?? '') }
}
const fakeSql = () => {
  const calls = []
  return {
    calls,
    sqlRun: (sql, params = []) => { calls.push({ sql, params }); return { changes: 1 } },
    sqlAll: (sql, params = []) => {
      calls.push({ sql, params })
      if (sql.startsWith('PRAGMA')) return ADMIN_COLUMNS.map(([name]) => ({ name }))
      return [{ id: 'r1', file_path: 'out/a.png', prompt: '一只柴犬', kind: 'image',
        width: 1024, height: 1024, accel_chain: 'kv_prefix', degraded: 0,
        vram_budget_mb: 8192, duration_ms: 3000, cold: 0, tool_name: 'draw_image' }]
    },
  }
}

console.log('=== 1. 幂等迁移（旧库不能直接重建） ===')
{
  ok('补列清单 7 项', ADMIN_COLUMNS.length === 7)
  ok('已有全部列时零语句', migrateStatements(ADMIN_COLUMNS.map(([n]) => n)).length === 0)
  const some = migrateStatements(['id', 'file_path', 'accel_chain'])
  ok('只补缺的列', some.length === 6 && !some.some((s) => s.includes('accel_chain')))
  ok('全部是 ALTER TABLE ADD COLUMN', some.every((s) => /^ALTER TABLE images ADD COLUMN \w+ (TEXT|INTEGER)$/u.test(s)))
  const admin = makeHistoryAdmin(fakeSql())
  const m = admin.migrate()
  ok('已有列的库迁移 added=0', m.ok === true && m.affected === 0)
  const empty = makeHistoryAdmin({ ...fakeSql(), sqlAll: () => [] })
  const m2 = empty.migrate()
  ok('全新库会补 7 列', m2.ok === true && m2.affected === 7)
  ok('不可用执行器如实降级', makeHistoryAdmin({}).available === false)
  ok('不可用时 migrate 给明确理由', makeHistoryAdmin({}).migrate().ok === false)
}

console.log('=== 2. 参数化查询（注入不进 SQL） ===')
{
  const injection = "x' OR 1=1 --"
  const w = buildAdvancedWhere({
    keyword: injection, kind: 'video', date_from: '2026-11-01', date_to: '2026-11-14',
    width: 1024, min_height: 512, max_height: 2048,
    accel_chain: 'teacache', degraded: true, cold: false, limit: 99999, offset: -5,
  })
  ok('★ 注入串不在 SQL 里', !w.clause.includes('OR 1=1') && !w.clause.includes(injection))
  ok('★ 注入串只在 params 里', w.params.some((p) => String(p).includes('OR 1=1')))
  ok('默认排除软删除', w.clause.includes('deleted = 0'))
  ok('尺寸 / 加速链 / 降级 / 冷热都有占位符', w.clause.includes('width = ?')
    && w.clause.includes('accel_chain LIKE ?') && w.clause.includes('degraded = 1')
    && w.clause.includes('cold = 0'))
  ok('limit 被夹到上限 500', w.limit === 500)
  ok('负 offset 归零', w.offset === 0)
  ok('include_deleted 时不加 deleted 条件', !buildAdvancedWhere({ include_deleted: true }).clause.includes('deleted = 0'))
  ok('degraded=false 走 IS NULL 兼容旧行', buildAdvancedWhere({ degraded: false }).clause.includes('IS NULL'))
  ok('空过滤 clause 为空', buildAdvancedWhere({ include_deleted: true }).clause === '')
}

console.log('=== 3. 删改 / 冷热 / 导出 ===')
{
  const f = fakeSql()
  const admin = makeHistoryAdmin(f)
  ok('update 只认白名单', UPDATE_WHITELIST.includes('prompt') && !UPDATE_WHITELIST.includes('file_path'))
  const u = admin.update('r1', { prompt: '新描述', file_path: '../etc/passwd', id: 'hack' })
  ok('★ 越权字段没进 SET', u.ok === true && u.fields.join(',') === 'prompt')
  const setSql = f.calls.at(-1).sql.split(' WHERE ')[0]
  ok('★ SET 里没有 file_path / id（WHERE id = ? 是合法占位符）',
    !setSql.includes('file_path') && !setSql.includes('id ='))
  ok('白名单外字段全给时拒绝', admin.update('r1', { foo: 1 }).ok === false)
  ok('没给 id 时拒绝', admin.update('', { prompt: 'x' }).ok === false)

  ok('restore 清 deleted', admin.restore('r1').ok === true
    && f.calls.at(-1).sql.includes('deleted = 0'))
  const hd = admin.hardDelete('r1')
  ok('hardDelete 真删记录', hd.ok === true && f.calls.at(-1).sql.startsWith('DELETE FROM images'))
  ok('★ 默认绝不删磁盘文件', hd.fileRemoved === false)
  let unlinkCalled = 0
  const withUnlink = makeHistoryAdmin({ ...f, unlink: () => { unlinkCalled += 1 } })
  ok('★ 不显式 deleteFile 时 unlink 不被调用',
    withUnlink.hardDelete('r1', { filePath: 'out/a.png' }).fileRemoved === false && unlinkCalled === 0)
  ok('显式 deleteFile 才删文件',
    withUnlink.hardDelete('r1', { deleteFile: true, filePath: 'out/a.png' }).fileRemoved === true
    && unlinkCalled === 1)

  ok('★ 无条件清空被拒（防误删全部）', admin.purge({}).ok === false)
  ok('带 before 才允许批量软删', admin.purge({ before: '2026-01-01', kind: 'image' }).ok === true)
  ok('批量是软删不是 DELETE', f.calls.at(-1).sql.includes('SET deleted = 1'))
  const cold = admin.archiveCold({ olderThanDays: -3 })
  ok('冷热天数非法时夹到 1', cold.ok === true && Number.isFinite(Date.parse(cold.cutoff)))
  ok('★ 冷热只标记、不搬文件', cold.reason.includes('不搬动磁盘文件')
    && f.calls.at(-1).sql.includes('cold = 1'))

  const row = { id: 'r1', file_path: 'out/a.png', prompt: '一只柴犬', width: 1024,
    accel_chain: 'kv_prefix', duration_ms: 3000,
    absolutePath: 'C:/Users/TestUser/Desktop/a.png' }
  const safe = sanitizeExportRow(row)
  ok('★ 导出不含 file_path', !('file_path' in safe))
  ok('★ 导出不含 prompt 全文', !('prompt' in safe))
  ok('★ 导出不含绝对路径字段', !('absolutePath' in safe))
  ok('导出仍保留统计字段', safe.width === 1024 && 'accel_chain' in safe && 'duration_ms' in safe)
  const ex = admin.exportRows({ include_deleted: true })
  ok('exportRows 产出合法 JSON Lines', ex.ok === true && ex.lines.length === 1
    && JSON.parse(ex.lines[0]).kind === 'image')
  ok('★ 导出行不含真实路径 / prompt', !ex.lines[0].includes('a.png') && !ex.lines[0].includes('柴犬'))
}

console.log('=== 4. 查询工具形状与被裁剪后仍完整 ===')
{
  const admin = makeHistoryAdmin(fakeSql())
  const tool = makeHistoryQueryTool({ admin })
  ok('名字正确', tool.name === 'query_history')
  ok('timeoutMs > 0', Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)
  ok('description 够长且讲了过滤条件', tool.description.length > 60
    && tool.description.includes('accel_chain') && tool.description.includes('degraded'))
  const r = await tool.execute({ min_width: 1024, degraded: true, limit: 5 })
  ok('execute 回齐 5 个顶层字段', ['ok', 'rows', 'total', 'summary', 'reason'].every((k) => k in r))
  ok('★ 返回值字段全在 schema 声明内',
    Object.keys(r).every((k) => k in tool.output.schema.properties))
  const wrapped = withDeclaredOutput(tool)
  const slim = await wrapped.execute({ limit: 5 })
  ok('★ 经 withDeclaredOutput 裁剪后仍非空', slim.ok === true && Array.isArray(slim.rows))
  ok('★ 裁剪后行里没有 file_path', !('file_path' in slim.rows[0]))
  const down = makeHistoryQueryTool({ admin: makeHistoryAdmin({}) })
  const d = await down.execute({})
  ok('库不可用时如实降级', d.ok === false && d.reason.length > 0)
}

console.log('=== 5. 端点表与围栏 ===')
{
  const admin = makeHistoryAdmin(fakeSql())
  const routes = historyAdminRouteTable({
    admin, respondJson: (res, body, code) => { res.body = body; res.code = code },
    isLocalRequest: (req) => req.local !== false,
    readJsonBody: async () => ({ id: 'r1', patch: { prompt: 'x' } }),
    log: () => {},
  })
  ok('端点 7 条', routes.length === 7)
  ok('路径全部是 /api/qwen-paint/history/*', routes.every((r) => r.path.startsWith('/api/qwen-paint/history/')))
  ok('方法只有 GET / POST', routes.every((r) => r.method === 'GET' || r.method === 'POST'))
  ok('路径互不重复', new Set(routes.map((r) => r.path)).size === routes.length)
  const res = { body: null, code: null }
  await routes[1].handler({ local: false, method: 'POST' }, res)
  ok('★ 非本机请求 403', res.code === 403 && res.body.ok === false)
  await routes[0].handler({ local: true, method: 'POST' }, res)
  ok('★ 方法不符 405', res.code === 405)
  await routes[0].handler({ local: true, method: 'GET', query: { min_width: 1024 } }, res)
  ok('GET 查询返回 200', res.code === 200 && res.body.ok === true)

  const broken = historyAdminRouteTable({
    admin: null,
    respondJson: (r, body, code) => { r.body = body; r.code = code },
    isLocalRequest: () => true,
    readJsonBody: async () => { throw new Error('ENOENT C:/Users/TestUser/secret.txt') },
    log: () => {},
  })
  const r2 = { body: null, code: null }
  await broken[1].handler({ method: 'POST' }, r2)
  ok('★ 异常回固定文案、不回吐 error.message',
    r2.code === 500 && r2.body.reason.includes('详见插件日志')
    && !JSON.stringify(r2.body).includes('TestUser') && !JSON.stringify(r2.body).includes('ENOENT'))
}

console.log(`=== test-history-admin：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
