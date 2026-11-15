#!/usr/bin/env node
/**
 * test-structured-log.mjs —— 结构化 JSONL 运行日志回归（全离线、零 I/O）。
 * 锁住：字段齐全 / 耗时分解五项 / 单行合法 JSON / 隐私消毒 / 禁用零开销 /
 *       appendLine 抛错不拖垮主链路 / 跨版本趋势聚合。
 */
import {
  normalizeEvent, makeStructuredLogger, recordGeneration, summarizeLog,
  promptHash, PRIVATE_PATTERNS, STRUCTURED_LOG_VERSION, TIMING_KEYS,
} from '../lib/structured-log.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓', name) }
  else { fail += 1; console.log('  ✗', name, extra ?? '') }
}

console.log('=== 1. prompt 只留指纹 ===')
{
  const h = promptHash('一只戴帽子的柴犬')
  ok('哈希 12 位十六进制', /^[0-9a-f]{12}$/u.test(h))
  ok('同文同哈希', h === promptHash('一只戴帽子的柴犬'))
  ok('异文异哈希', h !== promptHash('一只戴帽子的猫'))
  ok('空串返回空而非编造', promptHash('') === '' && promptHash() === '')
  ok('哈希不含原文', !h.includes('柴犬'))
}

console.log('=== 2. 事件归一 ===')
{
  const e = normalizeEvent({
    tool: 'draw_image', kind: 'image', model: 'qwen-image-2.1',
    width: 1024, height: 1024, steps: 8, seed: 42,
    accel_chain: ['kv_prefix', 'teacache'], degraded: true,
    degrade_reasons: ['未探测到节点'],
    timings: { queue_ms: 10, load_ms: 200, sample_ms: 3000, decode_ms: 150, total_ms: 3360 },
    vram_budget_mb: 8192, duration_ms: 3400, ok: true,
    prompt: '一只戴帽子的柴犬',
  }, 1700000000000)
  ok('版本号字段存在', e.v === STRUCTURED_LOG_VERSION)
  ok('时间戳用注入值', e.ts === 1700000000000)
  ok('尺寸 / 步数 / 种子保留', e.width === 1024 && e.height === 1024 && e.steps === 8 && e.seed === 42)
  ok('工具名不被消毒改写', e.tool === 'draw_image')
  ok('加速链保留', e.accel_chain.join(',') === 'kv_prefix,teacache')
  ok('降级标记与原因保留', e.degraded === true && e.degrade_reasons.length === 1)
  ok('耗时分解五项齐全', TIMING_KEYS.every((k) => Number.isFinite(e.timings[k])))
  ok('总耗时 = 3360', e.timings.total_ms === 3360)
  ok('显存上限记的是建议值', e.vram_budget_mb === 8192)
  ok('prompt_hash 12 位且无全文', /^[0-9a-f]{12}$/u.test(e.prompt_hash))
  const bad = normalizeEvent({ width: NaN, height: undefined, seed: 'x', timings: { queue_ms: NaN } })
  ok('NaN / undefined / 非数字归 null', bad.width === null && bad.height === null
    && bad.seed === null && bad.timings.queue_ms === null)
  const many = normalizeEvent({ accel_chain: Array.from({ length: 30 }, (_, i) => 'x' + i) })
  ok('数组有上限（防日志膨胀）', many.accel_chain.length <= 8)
  const line = JSON.stringify(e)
  ok('单行合法 JSON', !line.includes('\n') && JSON.parse(line).v === STRUCTURED_LOG_VERSION)
  ok('JSON 里没有 undefined / NaN', !line.includes('undefined') && !line.includes('NaN'))
}

console.log('=== 3. 隐私红线 ===')
{
  const dirty = normalizeEvent({
    tool: 'open K:\\ai\\secret\\model.gguf',
    model: 'C:/Users/TestUser/Desktop/x.safetensors',
    kind: '/home/alice/private',
    degrade_reasons: ['ENOENT /var/log/dsh/x'],
    prompt: 'C:/Users/TestUser/Desktop/私人笔记.txt 一只柴犬',
  }, 1)
  const line = JSON.stringify(dirty)
  const hits = PRIVATE_PATTERNS.filter((re) => re.test(line))
  ok('★ 本机路径 / 用户目录 / UNC / 凭据模式零命中', hits.length === 0,
    '命中 ' + hits.length)
  ok('★ 日志不含原始 prompt 全文', !line.includes('柴犬') && !line.includes('私人笔记'))
  ok('★ 消毒后仍保留诊断线索', line.includes('<本机路径>') || line.includes('ENOENT'))
  ok('prompt_hash 不因路径而暴露内容', /^[0-9a-f]{12}$/u.test(dirty.prompt_hash))
}

console.log('=== 4. logger 行为 ===')
{
  const off = makeStructuredLogger({ enabled: false })
  ok('禁用时 enabled=false', off.enabled === false)
  ok('禁用时 emit 返回 false 且不落盘', off.emit({ tool: 'draw_image' }) === false)

  const lines = []
  const logger = makeStructuredLogger({ appendLine: (s) => lines.push(s), now: () => 1234 })
  ok('启用时 enabled=true', logger.enabled === true)
  ok('recordGeneration 返回 true', recordGeneration(logger, { tool: 'draw_image', ok: true }) === true)
  ok('只写一行', lines.length === 1)
  ok('每行以换行结尾且是合法 JSON', lines[0].endsWith('\n') && JSON.parse(lines[0]).event === 'generation')
  ok('now 注入生效', JSON.parse(lines[0]).ts === 1234)

  let called = 0
  const broken = makeStructuredLogger({ appendLine: () => { called += 1; throw new Error('boom') } })
  ok('★ appendLine 抛错时 emit 不抛、返回 false', broken.emit({ tool: 'x' }) === false && called === 1)

  const noSink = makeStructuredLogger({})
  ok('没注入 appendLine 时如实降级', noSink.enabled === false && noSink.emit({}) === false)
}

console.log('=== 5. 跨版本趋势聚合 ===')
{
  const mk = (total, chain, degraded) => JSON.stringify(normalizeEvent({
    tool: 'draw_image', kind: 'image', timings: { total_ms: total },
    accel_chain: chain, degraded,
  }, 1))
  const lines = [mk(1000, ['kv_prefix'], false), mk(3000, ['kv_prefix'], true),
    mk(2000, [], false), 'BROKEN LINE', mk(9000, ['teacache'], false)]
  const s = summarizeLog(lines)
  ok('坏行跳过不算进样本', s.rows === 4)
  ok('均值正确', s.mean_ms === 3750)
  ok('p50 / p95 可计算', Number.isFinite(s.p50_ms) && Number.isFinite(s.p95_ms))
  ok('p95 不低于 p50', s.p95_ms >= s.p50_ms)
  ok('降级率 25%', s.degraded_rate === 25)
  ok('按加速链分组', s.by_chain['kv_prefix'] === 2 && s.by_chain['(none)'] === 1)
  ok('按类型分组', s.by_kind.image === 4)
  ok('版本号可用于跨版本对比', Array.isArray(s.versions) && s.versions.length === 1)
  ok('空输入不崩', summarizeLog([]).rows === 0 && summarizeLog([]).mean_ms === null)
}

console.log(`=== test-structured-log：${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) process.exit(1)
