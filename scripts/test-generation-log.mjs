/**
 * scripts/test-generation-log.mjs —— 2026-11-15：结构化日志「每次生成自动落盘」回归。
 *
 * 背景：lib/structured-log.js 的字段齐备，但 0.33.0 之前插件侧只会写一条
 * 「加速链快照」，每次真实生成的耗时分解要宿主手工 POST 上报 —— 等于没接主链路。
 * 本轮改为：lib/history-store.js::record()（所有生成路径的统一出口）加模块级钩子，
 * 由 tool-registry.js 在注册阶段注入 eventLog，自动生成 generation_complete。
 *
 * 本测试守四条硬边界：
 *   ① 真的会落盘（不是只在内存里 append）；
 *   ② file_path / prompt 全文 / 本机绝对路径绝不进日志；
 *   ③ 总耗时是本机实测，四个未打点的细分阶段必须是 null 而不是 0；
 *   ④ 钩子失败、重复 file_path 都不能影响出图主链路 / 不能重复记事件。
 *
 * ⚠ 本文件统一用 ok(cond, label) 顺序；helper 内建写反自检。
 *
 * 运行：node scripts/test-generation-log.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  createEventLog, generationEventFromHistory, attachGenerationLogging,
} from '../lib/event-log.js'
import {
  createHistoryStore, setGenerationLogHook, getGenerationLogHook,
} from '../lib/history-store.js'
import { normalizeEvent, PRIVATE_PATTERNS } from '../lib/structured-log.js'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const fails = []

/** ⚠ 参数顺序：cond 在前，label 在后。写反（ok(true, true)）必须当场抛。 */
function ok(cond, label) {
  if (typeof label !== 'string') throw new Error('ok() 参数顺序写反：必须是 (cond, label)')
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; fails.push(label); console.log(`  ✗ ${label}`) }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'dshqp-gen-log-'))
const dbPath = path.join(tmp, 'history.db')
const sqliteModule = require('node:sqlite')
const log = () => {}

function freshStore() {
  return createHistoryStore({ outputDir: tmp, log, dbPath, sqliteModule })
}

try {
  /* ═══════════ 1. 事件构造器：白名单字段 + 隐私 ═══════════ */
  console.log('=== 1. generationEventFromHistory 只挑白名单 ===')
  const absPath = path.join(tmp, 'secret-picture.png')
  const raw = {
    file_path: absPath,
    prompt: '绝不能落到日志里的提示词全文 SECRET-PROMPT-42',
    tool_name: 'draw_image', model: 'qwen-image-2.1',
    steps: 25, seed: 123, width: 720, height: 720, kind: 'image',
    extra: { negative: 'blurry', seconds: 12.5 },
  }
  const ev = generationEventFromHistory(raw)
  const norm = normalizeEvent(ev, 1700000000000)
  const line = JSON.stringify(norm)

  ok(ev.event === 'generation_complete', '事件名为 generation_complete')
  ok(ev.tool === 'draw_image' && ev.kind === 'image', '工具与链类型来自历史条目')
  ok(norm.width === 720 && norm.height === 720 && norm.steps === 25 && norm.seed === 123,
    '尺寸 / 步数 / 种子进入事件')
  ok(norm.timings.total_ms === 12500 && norm.duration_ms === 12500,
    '★ 本机实测总耗时 = seconds × 1000（12.5 s → 12500 ms）')
  ok(['queue_ms', 'load_ms', 'sample_ms', 'decode_ms'].every((k) => norm.timings[k] === null),
    '★ 四个未打点的细分阶段是 null（不是 0，不编造耗时）')
  ok(!line.includes('SECRET-PROMPT-42') && norm.prompt_hash.length === 12,
    '★ prompt 全文不进日志，只留 sha256 前 12 位')
  ok(!line.includes('secret-picture.png') && !line.includes(absPath),
    '★ file_path / 文件名 / 绝对路径都不进日志')
  ok(!PRIVATE_PATTERNS.some((re) => re.test(line)), '★ 落盘行不撞任何隐私正则')
  ok(generationEventFromHistory({ extra: {} }).timings.total_ms === null,
    '没有 seconds 时总耗时为 null（不猜、不写 0）')

  /* ═══════════ 2. 真落盘：record() → JSONL ═══════════ */
  console.log('=== 2. 生成完成钩子真的把事件写进 JSON Lines ===')
  const store = createEventLog({ outputDir: tmp, log })
  ok(store.enabled === true, 'eventLog 已启用（出图目录已给）')
  ok(attachGenerationLogging(store) === true, 'attachGenerationLogging 挂上钩子')
  ok(typeof getGenerationLogHook() === 'function', 'history-store 里钩子确实存在')

  const hs = freshStore()
  ok(hs.persistent === true, 'SQLite 历史库可用（不是降级路径）')
  ok(hs.record(raw) === true, 'record() 成功且不影响主链路')
  ok(existsSync(path.join(tmp, '.qwen-paint-events.jsonl')), '★ 事件文件真的落盘')
  const lines = store.readLines(10).filter(Boolean)
  ok(lines.length === 1, `★ 恰好一条生成事件（实际 ${lines.length}）`)
  const saved = JSON.parse(lines[0])
  ok(saved.event === 'generation_complete' && saved.ok === true, '落盘事件名与成功标记正确')
  ok(saved.timings.total_ms === 12500, '落盘事件含本机实测总耗时')
  ok(!lines[0].includes('SECRET-PROMPT-42') && !lines[0].includes('secret-picture.png'),
    '★ 落盘原文不夹带 prompt / 路径')

  /* ═══════════ 3. 重复与失败边界 ═══════════ */
  console.log('=== 3. 重复 file_path 不重记；钩子抛错不影响出图 ===')
  ok(hs.record(raw) === true, '重复 file_path 的 record() 仍返回 true')
  ok(store.readLines(10).filter(Boolean).length === 1,
    '★ INSERT OR IGNORE 没产生新行 ⇒ 不重复上报生成事件')
  setGenerationLogHook(() => { throw new Error('故意让钩子炸') })
  ok(hs.record({ ...raw, file_path: path.join(tmp, 'another.png') }) === true,
    '★ 钩子抛错时 record() 仍返回 true（出图不受影响）')
  setGenerationLogHook(null)
  ok(getGenerationLogHook() === null, '传 null 可解绑钩子（测试隔离）')

  /* ═══════════ 4. 生产接线 & 端点口径 ═══════════ */
  console.log('=== 4. 生产接线（不是只有测试 import） ===')
  const tr = read('lib/tool-registry.js')
  ok(tr.includes("import { eventLogRouteTable, createEventLog, attachGenerationLogging } from './event-log.js'"),
    '★ tool-registry.js 真实 import attachGenerationLogging')
  ok(/attachGenerationLogging\(eventLog\)/.test(tr), '★ createExtras 真的调用了挂载')
  const hss = read('lib/history-store.js')
  ok(hss.includes('export function setGenerationLogHook') && hss.includes('notifyGeneration(entry)'),
    '★ history-store.js 的 record() 真的触发钩子')
  const idx = read('lib/index.js')
  ok(!idx.includes('eventLog'), '★ index.js 零改动（体积贴线，接线全在外置模块）')
  const evlog = read('lib/event-log.js')
  ok(evlog.includes("note: '插件侧自动写入加速链快照 + 每次生成完成事件"),
    '★ /events 端点 note 改成「自动写入生成完成事件」口径')
  ok(evlog.includes('queue/load/sample/decode 四段细分耗时主链路未打点'),
    '★ 端点仍如实说明细分耗时尚未打点（不假装全自动）')
} finally {
  setGenerationLogHook(null)
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
}

console.log(`=== test-generation-log：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1) }
