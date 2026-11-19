#!/usr/bin/env node
/**
 * ws-preview createPreviewStore 直测（2026-11-20 零触及清单：ws-preview.js 全模块零断言）。
 *
 * 设计里就有测试缝（"注入 now 便于测试 TTL"）——本文件用它：假时钟驱动
 *   TTL 过期 / max 挤最老 / percent 夹紧 / dataUrl 快照脱敏（不吐 Buffer）。
 *
 * 纯离线。
 */
import { createPreviewStore } from '../lib/ws-preview.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log('— setProgress（percent 夹紧与坏值）')
{
  const s = createPreviewStore({ now: () => 1000 })
  s.setProgress('p1', 50, 100, 'KSampler')
  ok('★ 50/100 → percent=50 + node 透传', s.snapshot('p1').progress?.percent === 50 && s.snapshot('p1').progress?.node === 'KSampler')
  s.setProgress('p1', 200, 100)
  ok('★ 超上限 → 夹紧 100', s.snapshot('p1').progress?.percent === 100)
  s.setProgress('p1', -5, 100)
  ok('★ 负值 → 夹紧 0', s.snapshot('p1').progress?.percent === 0)
  s.setProgress('p1', 1, 0)
  ok('★ max=0 → progress 置 null（防除零）', s.snapshot('p1').progress === null)
  s.setProgress('', 50, 100)
  ok('空 promptId 忽略（size 不变）', s.size() === 1)
}

console.log('— setPreview / snapshot（脱敏）')
{
  const s = createPreviewStore({ now: () => 1000 })
  s.setPreview('p1', 'image/jpeg', Buffer.from([1, 2, 3]))
  const snap = s.snapshot('p1')
  ok('★ snapshot 给 dataUrl 形态（不吐 Buffer——端点 JSON 安全）',
    snap.found === true && typeof snap.preview.dataUrl === 'string'
    && snap.preview.dataUrl.startsWith('data:image/jpeg;base64,') && snap.preview.bytes === undefined,
    JSON.stringify(Object.keys(snap.preview ?? {})))
  ok('snapshot 未知 id → found:false + connected:true（不炸）',
    s.snapshot('nope').found === false && s.snapshot('nope').connected === true)
}

console.log('— TTL 与挤最老（假时钟）')
{
  let t = 1000
  const s = createPreviewStore({ now: () => t, ttlMs: 10 * 60 * 1000 })
  s.setProgress('old', 10, 100)
  t += 10 * 60 * 1000 + 1
  ok('★ 超过 TTL → snapshot found:false 且条目删除（不给过期预览冒充当前）',
    s.snapshot('old').found === false && s.size() === 0)
  t = 2000
  const s2 = createPreviewStore({ now: () => t, max: 2 })
  s2.setProgress('a', 1, 10)
  t += 10
  s2.setProgress('b', 2, 10)
  t += 10
  s2.setProgress('c', 3, 10)
  ok('★ max=2 塞 3 个 → 挤最老（a 出局，size=2）',
    s2.size() === 2 && s2.snapshot('a').found === false && s2.snapshot('b').found === true)
  t += 10
  s2.setProgress('b', 9, 10)
  // ⚠ 实现语义（2026-11-20 直测定性）：挤最老按 Map **插入序**（FIFO）取 keys().next()，
  //   setProgress 只更新 updatedAt 不重排 —— touch 不续命，先插入者先出局（非 LRU）。
  //   低危内部策略偏差（挤谁都是挤），不改实现；本断言锁真实契约防未来无意改变。
  s2.setProgress('d', 4, 10)
  ok('★ 挤最老=FIFO 插入序：touch 过的 b 仍先于 c 出局（非 LRU——真实语义锁）',
    s2.size() === 2 && s2.snapshot('b').found === false && s2.snapshot('c').found === true
    && s2.snapshot('d').found === true,
    JSON.stringify({ size: s2.size() }))
  s2.clear('d')
  ok('clear → found:false（任务收尾删快照）', s2.snapshot('d').found === false && s2.size() === 1)
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
