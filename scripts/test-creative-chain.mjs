/**
 * scripts/test-creative-chain.mjs —— 创作编排层与风格迁移的纯函数回归。
 *
 * 覆盖：
 *   · D18 产出短引用（#1 最新 / last / first / 文件名后缀 / 歧义不替用户挑）
 *   · D20 时间轴骨架（切段 / 末段夹到总时长 / 超上限拒绝 / 自定义标签）
 *   · E27 资源需求（三档阈值 / **不给预计秒数** / 缺尺寸如实 ok:false）
 *   · F31 数据流摘要（回环判定 / external 是算出来的不是写死的）
 *   · F29 色调提取（HSL / 色名 / 全灰图不硬造色相 / 非 RGBA 长度拒绝）
 *
 * ⚠ 本文件 ok() 签名是 (cond, name, extra)，与 test-history-export.mjs 一致；
 *   helper 内建写反自检，参数顺序错了当场抛。
 */
import {
  buildProduceRefs, resolveProduceRef, buildTimeline, timelineToPrefix,
  TIMELINE_MAX_SEGMENTS, describeResourceNeeds, isLoopbackUrl, buildPrivacySummary,
} from '../lib/creative-chain.js'
import { rgbToHsl, hueName, extractTone, SAMPLE_EDGE } from '../lib/color-tone.js'

let pass = 0
const failures = []

const ok = (cond, name, extra) => {
  if (typeof name !== 'string' || name.trim() === '' || name === 'true' || name === 'false') {
    throw new Error(`ok() 参数顺序可能写反（name=${JSON.stringify(name)}）；签名是 (cond, name, extra)`)
  }
  if (cond) { pass += 1; console.log('  OK  ', name) } else { failures.push(name); console.log('  FAIL', name, extra ?? '') }
}
const eq = (a, b, name) => ok(Object.is(a, b), `${name}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)
const sec = (t) => console.log(`\n── ${t} ──`)

/* ============================================================ D18 ==== */
sec('D18 产出短引用')

const items = [
  { id: 3, path: 'K:/out/qwen-paint/fox.png', kind: 'image' },
  { id: 2, path: 'K:/out/qwen-paint/cat.png', kind: 'image' },
  { id: 1, path: 'K:/out/qwen-paint/dog.png', kind: 'image' },
]
const refs = buildProduceRefs(items)
eq(refs.length, 3, '#1 列表长度不变')
eq(refs[0].ref, '#1', '第一条（最新）是 #1')
eq(refs[2].ref, '#3', '最后一条（最老）是 #3')
eq(refs[0].id, 3, '原始字段保留（id）')
eq(refs[0].path, 'K:/out/qwen-paint/fox.png', '原始字段保留（path）')
eq(buildProduceRefs(null).length, 0, '非数组入参返回空数组而不是抛错')
eq(items[0].ref, undefined, '★ 不修改入参数组（纯函数）')

eq(resolveProduceRef('last', refs).item.id, 3, 'last = 最新')
eq(resolveProduceRef('latest', refs).item.id, 3, 'latest = 最新')
eq(resolveProduceRef('#1', refs).item.id, 3, '#1 = 最新')
eq(resolveProduceRef('1', refs).item.id, 3, '裸数字 1 = 最新')
eq(resolveProduceRef('first', refs).item.id, 1, 'first = 最老')
eq(resolveProduceRef('oldest', refs).item.id, 1, 'oldest = 最老')
eq(resolveProduceRef('#3', refs).item.id, 1, '#3 = 第三条')
eq(resolveProduceRef('#2', refs).index, 1, '#2 的下标是 1')
eq(resolveProduceRef('fox.png', refs).item.id, 3, '文件名后缀命中')
eq(resolveProduceRef('FOX.PNG', refs).item.id, 3, '后缀匹配不区分大小写')
eq(resolveProduceRef('qwen-paint/fox.png', refs).item.id, 3, '路径后缀命中')

const empty = resolveProduceRef('', refs)
ok(empty.ok === false && empty.item === null, '空 ref 必须失败且 item 为 null')
eq(resolveProduceRef('', refs).index, -1, '失败时 index = -1（不是 0，避免调用方误取第一条）')
ok(resolveProduceRef('last', []).ok === false, '没有产出时 last 也失败')
ok(resolveProduceRef('#9', refs).ok === false, '越界序号失败')
ok(String(resolveProduceRef('#9', refs).reason).includes('只有 3 条'), '越界报「只有 N 条」')
ok(resolveProduceRef('#0', refs).ok === false, '#0 失败（序号从 1 开始）')
ok(String(resolveProduceRef('nope.png', refs).reason).includes('没有哪条'), '完全没命中时报清楚')

// 歧义：两条都以 cat 结尾
const amb = buildProduceRefs([
  { id: 2, path: 'K:/a/cat.png' }, { id: 1, path: 'K:/b/cat.png' },
])
const ambR = resolveProduceRef('cat.png', amb)
ok(ambR.ok === false && String(ambR.reason).includes('匹配到 2 条'), '★ 歧义时报错，绝不替用户挑一条')

// 反斜杠路径也能匹配（Windows 真实路径）
const win = buildProduceRefs([{ id: 1, path: 'K:\\out\\qwen-paint\\fox.png' }])
eq(resolveProduceRef('fox.png', win).item.id, 1, '反斜杠路径同样能匹配后缀')

/* ============================================================ D20 ==== */
sec('D20 时间轴骨架')

const t6 = buildTimeline({ seconds: 6 })
ok(t6.ok === true, '6 秒 / 2 秒一段 → 成功')
eq(t6.segments.length, 3, '6 秒切 3 段')
eq(t6.segments[0].from, 0, '第一段从 0 开始')
eq(t6.segments[0].to, 2, '第一段到 2')
eq(t6.segments[1].from, 2, '第二段从 2 开始（与上一段首尾相接）')
eq(t6.segments[2].to, 6, '最后一段到 6')
eq(t6.segments[0].label, '开场 · 交代环境', '默认标签按顺序给')
eq(t6.segments[1].index, 2, 'index 从 1 开始计')

const t7 = buildTimeline({ seconds: 7 })
eq(t7.segments.length, 4, '7 秒切 4 段（ceil）')
eq(t7.segments[3].to, 7, '★ 末段夹到总时长（不越界到 8）')
ok(t7.segments[3].from < t7.segments[3].to, '末段 from < to（不会出现 6-7 之外的空段）')

eq(buildTimeline({ seconds: 6, step: 3 }).segments.length, 2, '步长 3 秒 → 2 段')
eq(buildTimeline({ seconds: 6, step: 3 }).step, 3, 'step 原样回显')
ok(buildTimeline({ seconds: 0 }).ok === false, '0 秒失败')
ok(buildTimeline({ seconds: -3 }).ok === false, '负数失败')
ok(buildTimeline({ seconds: 'abc' }).ok === false, '非数字失败')
ok(String(buildTimeline({ seconds: 0 }).reason).includes('正数'), '失败原因说明是「必须是正数」')
ok(buildTimeline({ seconds: 6, step: 0 }).step === 2, 'step 非法时回落默认 2')

const tooLong = buildTimeline({ seconds: 60 })
ok(tooLong.ok === false, `★ 60 秒按 2 秒切 = 30 段，超过上限 ${TIMELINE_MAX_SEGMENTS} 必须拒绝`)
ok(String(tooLong.reason).includes(String(TIMELINE_MAX_SEGMENTS)), '拒绝原因里写明上限')
eq(buildTimeline({ seconds: 24 }).segments.length, 12, '刚好 12 段是允许的（边界）')
ok(buildTimeline({ seconds: 26 }).ok === false, '13 段被拒（边界外一格）')

const custom = buildTimeline({ seconds: 4, labels: ['甲', '  ', '丙'] })
eq(custom.segments[0].label, '甲', '自定义标签优先')
eq(custom.segments[1].label, '展开 · 主体动作', '空白标签回落到默认（不产出空标签）')

const prefix = timelineToPrefix(t6)
ok(prefix.startsWith('0-2 秒：开场 · 交代环境；'), '前缀以第一段开头')
ok(prefix.includes('4-6 秒：推进 · 细节或情绪'), '前缀包含末段')
ok(prefix.endsWith('不要跳步。'), '前缀以约束句结尾')
eq(timelineToPrefix({ segments: [] }), '', '空时间轴 → 空前缀（不产出半句话）')
eq(timelineToPrefix(null), '', 'null → 空前缀')

/* ============================================================ E27 ==== */
sec('E27 资源需求声明')

const small = describeResourceNeeds({ kind: 'image', width: 512, height: 512 })
eq(small.tier, 'low', '512² = 262144 → 轻量档')
eq(small.ok, true, '有尺寸 → ok:true')
eq(small.exclusive_model, false, '生图不独占模型')

const mid = describeResourceNeeds({ kind: 'image', width: 1024, height: 1024 })
eq(mid.tier, 'medium', '1024² = 1048576 → 中等档（刚过 1e6）')
eq(describeResourceNeeds({ kind: 'image', width: 1000, height: 1000 }).tier, 'low', '正好 1e6 仍是轻量档（<= 边界）')

const big = describeResourceNeeds({ kind: 'image', width: 2048, height: 2048 })
eq(big.tier, 'high', '2048² → 偏重档')

const vid = describeResourceNeeds({ kind: 'video', width: 1024, height: 1024, frames: 81 })
eq(vid.tier, 'high', '视频按帧累计 → 偏重档')
eq(vid.exclusive_model, true, '★ 视频会先把主模型卸下（独占）')
eq(vid.pixel_estimate, 1048576 * 81, '像素估算 = 单帧 × 帧数')
ok(vid.notes.some((n) => n.includes('81 帧')), '备注里写明按 81 帧累计')

eq(describeResourceNeeds({ kind: 'video', width: 512, height: 512, frames: 9 }).tier, 'medium',
  '小视频（512² × 9 帧 = 2359296 像素）落在中等档')

eq(describeResourceNeeds({ kind: 'upscale', width: 512, height: 512, scale: 2 }).tier, 'medium',
  '放大 2x 按面积平方算（512²×4 = 1048576）')
eq(describeResourceNeeds({ kind: 'upscale', width: 512, height: 512 }).exclusive_model, true, '超分也独占模型')

const tts = describeResourceNeeds({ kind: 'tts' })
eq(tts.ok, true, 'tts 不需要尺寸也算 ok')
eq(tts.pixel_estimate, null, 'tts 的像素估算是 null（不编数字）')

const noSize = describeResourceNeeds({ kind: 'image' })
eq(noSize.ok, false, '缺尺寸 → ok:false（返回壳子但明确不成功）')
eq(noSize.pixel_estimate, null, '缺尺寸时像素是 null')
ok(noSize.notes.some((n) => n.includes('没给尺寸')), '缺尺寸时备注说明原因')

ok(describeResourceNeeds({}).ok === false, '完全不给 kind → ok:false')
eq(describeResourceNeeds({}).kind, '', 'kind 原样回显空串')

// ★ 核心承诺：绝不编秒数
for (const r of [small, mid, big, vid, tts]) {
  ok(r.est_seconds === null, `★★ ${r.kind || '(无)'}/${r.tier} 的 est_seconds 必须是 null（不编预计秒数）`)
  ok(r.eta_basis === 'unverified', `★★ ${r.kind || '(无)'}/${r.tier} 的 eta_basis 标 unverified`)
}
ok(vid.notes.some((n) => n.includes('不提供预计秒数')), '备注里明说不提供预计秒数')

/* ============================================================ F31 ==== */
sec('F31 数据流摘要')

ok(isLoopbackUrl('http://127.0.0.1:8188') === true, '127.0.0.1 是回环')
ok(isLoopbackUrl('http://localhost:8188/prompt') === true, 'localhost 是回环')
ok(isLoopbackUrl('https://[::1]:8188') === true, 'IPv6 回环 [::1] 是回环')
ok(isLoopbackUrl('http://127.0.0.1.evil.com:8188') === false, '★ 127.0.0.1.evil.com 不是回环（前缀骗术）')
ok(isLoopbackUrl('https://huggingface.co/x') === false, '外部域名不是回环')
ok(isLoopbackUrl('file:///etc/passwd') === false, 'file: 协议不算回环 HTTP')
ok(isLoopbackUrl('') === false, '空串不是回环')
ok(isLoopbackUrl(null) === false, 'null 不抛错')

const local = buildPrivacySummary({
  comfyUrl: 'http://127.0.0.1:8188',
  requestUrls: ['http://127.0.0.1:8188/prompt', 'http://127.0.0.1:8188/history/abc'],
  models: ['qwen-image-2.1-UC-Q4_K_M.gguf'],
  seconds: 42,
  promptId: 'abc',
})
eq(local.external_network, false, '★ 全回环 → external_network:false（这是算出来的）')
eq(local.request_count, 3, '请求数含 comfyUrl 本身')
eq(local.endpoints.length, 1, '端点去重后只有 1 个 host')
eq(local.models.length, 1, '模型清单原样带出')
eq(local.seconds, 42, '耗时原样带出')
eq(local.prompt_id, 'abc', 'prompt_id 原样带出')
ok(local.summary.includes('未访问任何外部网络'), '摘要里明说没出网')
ok(local.cross_check.includes('/history/'), '给出可自查的路径')

const outbound = buildPrivacySummary({
  comfyUrl: 'http://127.0.0.1:8188',
  requestUrls: ['https://huggingface.co/api', 'http://127.0.0.1:8188/prompt'],
})
eq(outbound.external_network, true, '★★ 有一条出网就必须标 true（写死 false 是自欺欺人）')
eq(outbound.external_urls.length, 1, 'external_urls 只列真正出网的那条')
ok(outbound.summary.includes('外部'), '摘要里写明有请求发往外部')

const blank = buildPrivacySummary({})
eq(blank.request_count, 0, '什么都不传 → 请求数 0')
eq(blank.external_network, false, '没有请求当然没有出网')
eq(blank.seconds, null, '没给耗时就是 null（不填 0 假装算过）')
eq(blank.models.length, 0, '模型清单为空数组')
ok(buildPrivacySummary({ requestUrls: ['', '  ', null] }).request_count === 0, '空白 URL 被过滤掉')

/* ============================================================ F29 ==== */
sec('F29 色调提取')

eq(SAMPLE_EDGE, 32, '取样边长 32（1024 个像素，够稳又便宜）')

const red = rgbToHsl(255, 0, 0)
eq(red.h, 0, '纯红色相 0')
eq(red.s, 1, '纯红饱和度 1')
eq(red.l, 0.5, '纯红明度 0.5')
eq(rgbToHsl(0, 255, 0).h, 120, '纯绿色相 120')
eq(rgbToHsl(0, 0, 255).h, 240, '纯蓝色相 240')
eq(rgbToHsl(255, 255, 255).s, 0, '白色饱和度为 0')
eq(rgbToHsl(0, 0, 0).l, 0, '黑色明度为 0')
eq(rgbToHsl(-50, 999, 0).h, 120, '★ 越界输入被 clamp：-50→0、999→255，于是得到纯绿 120°')

eq(hueName(0), '红', '0° → 红')
eq(hueName(14), '红', '14° → 红')
eq(hueName(15), '橙', '15° → 橙（边界）')
eq(hueName(60), '黄', '60° → 黄')
eq(hueName(120), '绿', '120° → 绿')
eq(hueName(180), '青', '180° → 青')
eq(hueName(240), '蓝', '240° → 蓝')
eq(hueName(280), '紫', '280° → 紫')
eq(hueName(300), '洋红', '300° → 洋红')
eq(hueName(340), '粉', '340° → 粉')
eq(hueName(360), '红', '360° 折回红（不越界）')
eq(hueName(-10), '红', '-10° 折 350° → 红（>=345 就是红）')

// 4 个纯红像素
const redPx = [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]
const rt = extractTone(redPx)
ok(rt.ok === true, '纯红图提取成功')
eq(rt.neutral, false, '不是中性')
eq(rt.sampled, 4, 'sampled = 像素数')
eq(rt.hex, '#ff0000', '加权平均色 = #ff0000')
eq(rt.tone, 'warm', '★ 红算偏暖（不能判成冷暖中性）')
ok(rt.phrase.includes('红'), '★ 纯红图的色名是「红」，不是「橙」（色名按桶左边界取）')
ok(rt.phrase.includes('偏暖'), '描述里带冷暖')
ok(rt.phrase.includes('高饱和'), '纯红是高饱和')

// 纯蓝
const bluePx = [0, 0, 255, 255, 0, 0, 255, 255]
const bt = extractTone(bluePx)
eq(bt.tone, 'cool', '蓝算偏冷')
eq(bt.hue_name, '蓝', '蓝色名')

// 全灰（黑白摄影）→ 不硬造色相
const grayPx = [128, 128, 128, 255, 130, 130, 130, 255, 125, 125, 125, 255, 128, 128, 128, 255]
const gt = extractTone(grayPx)
ok(gt.ok === true, '全灰图仍然 ok（不是失败）')
eq(gt.neutral, true, '★ 全灰 → neutral:true')
eq(gt.hue_name, '', '全灰不给色名（不硬造）')
ok(gt.phrase.includes('黑白'), '描述里写黑白色调')
ok(gt.phrase.includes('中间调'), '描述里带明度档')
ok(gt.saturation === 0, '全灰的饱和度是 0')

// 纯白图 → 明度极高，仍应走"无彩色"分支
const whitePx = [255, 255, 255, 255, 255, 255, 255, 255]
const wt = extractTone(whitePx)
eq(wt.neutral, true, '纯白图 → neutral')
ok(wt.phrase.includes('高调'), '纯白是「高调」')

// 透明像素被丢弃
const transparent = [255, 0, 0, 0, 255, 0, 0, 0]
eq(extractTone(transparent).neutral, true, '★ alpha=0 的像素被丢弃（否则会误判成红图）')

// 入参校验
ok(extractTone(null).ok === false, 'null 入参失败')
ok(String(extractTone(null).reason).includes('RGBA'), '失败原因提到需要 RGBA')
ok(extractTone([]).ok === false, '空数组失败')
ok(extractTone([1, 2, 3]).ok === false, '不足 4 个分量失败')
ok(extractTone([1, 2, 3, 4, 5, 6]).ok === false, '长度不是 4 的倍数失败')
ok(String(extractTone([1, 2, 3, 4, 5, 6]).reason).includes('不是 4 的倍数'), '失败原因说明长度问题')
eq(extractTone([1, 2, 3]).hex, '#808080', '失败时 hex 是中性灰占位（不是空串）')

// 支持 {data: [...]}（ImageData 形状）
const asImageData = extractTone({ data: redPx })
ok(asImageData.ok === true && asImageData.hex === '#ff0000', '支持直接传 ImageData（{data}）')

console.log(`\ntest-creative-chain: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
