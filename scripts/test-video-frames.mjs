/**
 * 视频选帧 / 时间段截取 —— 离线回归（不联网、不调 ffmpeg、只在临时目录里写）
 *
 * 重点锁住：
 *  · 时间码 / 帧号互转：认得出、认不出就报错，绝不猜 0
 *  · 两种选法归一到同一份区间；越界 / 反序 / 超长都有明确处理
 *  · ffmpeg 参数是 **argv 数组**，不是拼出来的 shell 字符串（无注入面）
 *  · 只处理出图目录内的文件（不接受任意本机路径）
 *  · 没有 ffmpeg 时如实返回 needFfmpeg，不假装成功
 *  · `/frame-save` 是零依赖那条路：只收 PNG、只落盘
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_FPS, MAX_CLIP_SECONDS, MAX_PICK_FRAMES,
  parseTimecode, formatTimecode, frameToSec, secToFrame,
  resolveSelection, buildFrameArgs, buildClipArgs, parseProbe,
  makeFrameName, makeClipName,
} from '../lib/video-frames.js'
import { makeVideoFrameHandlers, registerVideoFrameRoutes } from '../lib/video-frames-endpoints.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
const ok = (cond, msg) => { if (cond) { passed += 1; console.log(`✓ ${msg}`) } else failures.push(msg) }
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

/* ---------- 1. 时间码 ---------- */
eq(parseTimecode('90'), 90, '纯秒数')
eq(parseTimecode('1:30'), 90, 'M:SS')
eq(parseTimecode('00:01:30.5'), 90.5, 'HH:MM:SS.s')
eq(parseTimecode('0:00.25'), 0.25, '小数秒')
eq(parseTimecode(''), null, '★★ 空串 → null（不猜 0）')
eq(parseTimecode('abc'), null, '★★ 认不出来 → null')
eq(parseTimecode('-5'), null, '负数 → null')
eq(parseTimecode('1:2:3:4'), null, '四段 → null')
eq(parseTimecode('1;30'), null, '分号不是合法分隔符')
eq(formatTimecode(90), '1:30.0', 'formatTimecode 90s')
eq(formatTimecode(3723.5), '1:02:03.5', 'formatTimecode 带小时')
eq(frameToSec(24, 24), 1, '帧 → 秒')
eq(secToFrame(1, 24), 24, '秒 → 帧')
eq(secToFrame(-1, 24), 0, '负秒 → 0 帧（不出现负帧号）')

/* ---------- 2. 归一选区 ---------- */
const f = resolveSelection({ mode: 'frames', fps: 24, totalFrames: 81, startFrame: 10, endFrame: 40 })
eq(f.ok, true, '按帧选：正常区间')
eq(f.count, 31, '含头含尾 → 31 帧')
eq(f.startSec, 0.416667, '起始秒按 fps 换算')
ok(f.endSec > f.startSec, '结束秒大于起始秒')

const fEvery = resolveSelection({ mode: 'frames', fps: 24, startFrame: 0, endFrame: 20, everyNth: 5, maxFrames: 3 })
eq(fEvery.pickedFrames.length, 3, '★★ maxFrames 生效（不会一次抽几百张）')
eq(fEvery.truncated, true, '被截断时如实标记')
ok(fEvery.warnings.length > 0, '截断要给出 warning')

const fClamp = resolveSelection({ mode: 'frames', fps: 24, totalFrames: 10, startFrame: 0, endFrame: 99 })
eq(fClamp.endFrame, 9, '结束帧越界 → 夹到最后一帧')

const fBad = resolveSelection({ mode: 'frames', fps: 24, startFrame: 5, endFrame: 3 })
eq(fBad.ok, false, '★★ 结束帧小于起始帧 → 明确报错')
ok(/必须不小于/u.test(fBad.reason), '报错说清为什么')

const fOver = resolveSelection({ mode: 'frames', fps: 24, totalFrames: 10, startFrame: 99, endFrame: 100 })
eq(fOver.ok, false, '起始帧超出总帧数 → 报错')

const t = resolveSelection({ mode: 'time', fps: 16, durationSec: 5.0625, startTime: '0:00.5', endTime: '0:02.0' })
eq(t.ok, true, '按时间选：正常区间')
eq(t.startFrame, 8, '0.5s @16fps → 第 8 帧')
eq(t.endFrame, 31, '2.0s @16fps → 第 31 帧（含头含尾）')

const tBad = resolveSelection({ mode: 'time', fps: 16, startTime: '0:02', endTime: '0:01' })
eq(tBad.ok, false, '★★ 结束早于起始 → 报错')
const tBad2 = resolveSelection({ mode: 'time', fps: 16, startTime: 'x', endTime: '0:01' })
eq(tBad2.ok, false, '时间码认不出来 → 报错（不猜）')
const tOver = resolveSelection({ mode: 'time', fps: 16, durationSec: 3, startTime: '0:02', endTime: '0:99' })
eq(tOver.ok, true, '结束超总长 → 夹紧而不是报错')
ok(tOver.warnings.some((w) => w.includes('夹')), '夹紧要说明')

const fpsBad = resolveSelection({ mode: 'frames', fps: 0, startFrame: 0, endFrame: 1 })
eq(fpsBad.fps, DEFAULT_FPS, '非法 fps → 回落默认值')
ok(fpsBad.warnings.some((w) => w.includes('帧率')), '回落要说明')

const longSel = resolveSelection({ mode: 'time', fps: 24, startTime: '0:00', endTime: '0:59:00' })
ok(longSel.endSec - longSel.startSec <= MAX_CLIP_SECONDS + 0.001, `★★ 超长区间被夹到 ${MAX_CLIP_SECONDS}s 上限`)
ok(MAX_PICK_FRAMES >= 12, '抽帧上限是合理正数')

/* ---------- 3. ffmpeg 参数（argv，不是 shell 串） ---------- */
const fa = buildFrameArgs({ input: '/v/a.mp4', output: '/v/f.png', atSec: 1.5 })
ok(Array.isArray(fa), '★ 参数是数组')
ok(fa.includes('/v/a.mp4') && fa.includes('/v/f.png'), '输入输出是独立 argv 元素')
ok(!fa.join(' ').includes(';'), '★ 没有用分号拼命令')
eq(fa[fa.indexOf('-ss') + 1], '1.5', '-ss 取的是秒数字符串')
ok(fa.indexOf('-ss') < fa.indexOf('-i'), '★ -ss 在 -i 之前（快速定位）')

const evil = buildFrameArgs({ input: '/v/a; rm -rf ~.mp4', output: '/v/f.png', atSec: 0 })
ok(evil.includes('/v/a; rm -rf ~.mp4'), '★ 恶意文件名原样作为**一个** argv 元素，不会被 shell 执行')
ok(evil.filter((x) => x === 'rm').length === 0, '★ 没有把文件名拆成命令')

const ca = buildClipArgs({ input: '/v/a.mp4', output: '/v/c.mp4', startSec: 0.5, durationSec: 1 })
ok(ca.includes('libx264'), '默认重编码（起点精确）')
const caFast = buildClipArgs({ input: '/v/a.mp4', output: '/v/c.mp4', startSec: 0.5, durationSec: 1, reencode: false })
ok(caFast.includes('copy'), 'reencode=false → -c copy（秒出）')
const caClamp = buildClipArgs({ input: '/v/a.mp4', output: '/v/c.mp4', startSec: 0, durationSec: 9999 })
eq(caClamp[caClamp.indexOf('-t') + 1], String(MAX_CLIP_SECONDS), '★★ 时长被夹到上限')

/* ---------- 4. ffprobe 解析 ---------- */
const probeOk = parseProbe(JSON.stringify({
  streams: [{ codec_type: 'video', avg_frame_rate: '16/1', width: 832, height: 480, duration: '5.0625' }],
  format: { duration: '5.0625' },
}))
eq(probeOk.fps, 16, 'fps 从 avg_frame_rate 解析')
eq(probeOk.durationSec, 5.063, '时长取三位小数')
eq(probeOk.width, 832, '宽')
const probeBad = parseProbe('not json')
eq(probeBad.fps, null, '★★ 解析失败 → null（不猜）')
eq(probeBad.durationSec, null, '解析失败时长也是 null')

/* ---------- 5. 文件名 ---------- */
ok(/^dshqp-frame-\d+-\d{4}\.png$/u.test(makeFrameName('dshqp-frame', 7, 1700000000000)),
  '抽帧文件名可预测、不含原视频名')
ok(/^dshqp-clip-\d+\.mp4$/u.test(makeClipName('dshqp-clip', 1700000000000)), '片段文件名同上')

/* ---------- 6. 端点行为（注入 run，不真跑 ffmpeg） ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshqp-vf-'))
const outside = path.join(os.tmpdir(), 'dshqp-outside.txt')
fs.writeFileSync(outside, 'x')
const fakeVideo = path.join(tmp, 'v.mp4')
fs.writeFileSync(fakeVideo, 'fake')

const calls = []
function mkHandlers(opts = {}) {
  const respond = []
  const run = opts.run ?? (async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '{}' } })
  const h = makeVideoFrameHandlers({
    isLocalRequest: () => opts.local !== false,
    guardWriteRequest: () => opts.guard !== false,
    respondJson: (res, body, status) => respond.push({ body, status: status ?? 200 }),
    readJsonBody: async () => opts.body ?? {},
    cfg: { outputDir: tmp },
    log: () => {},
    run,
  })
  return { h, respond }
}

const reqOf = (method, url = '/') => ({ method, url })

// 6.1 非本机请求一律 403
{
  const { h, respond } = mkHandlers({ local: false })
  await h.frameSaveHandler(reqOf('POST'), {})
  eq(respond[0].status, 403, '★★ 非本机请求 → 403（顶层围栏）')
}
// 6.2 frame-save 只收 PNG
{
  const { h, respond } = mkHandlers({ body: { png: 'data:image/jpeg;base64,AAA' } })
  await h.frameSaveHandler(reqOf('POST'), {})
  eq(respond[0].body.ok, false, '★ frame-save 拒绝非 PNG')
}
// 6.3 frame-save 正常落盘
{
  const png = 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64')
  const { h, respond } = mkHandlers({ body: { png, frame: 12 } })
  await h.frameSaveHandler(reqOf('POST'), {})
  eq(respond[0].body.ok, true, '★ frame-save 成功')
  ok(fs.existsSync(respond[0].body.path), '落盘文件真的存在')
  ok(respond[0].body.path.startsWith(tmp), '★ 只写出图目录内')
}
// 6.4 目录外路径一律拒
{
  const { h, respond } = mkHandlers({ body: { path: outside, mode: 'frames', startFrame: 0, endFrame: 0 } })
  await h.frameHandler(reqOf('POST'), {})
  eq(respond[0].body.ok, false, '★★ 出图目录外的路径被拒')
  ok(/出图目录/u.test(respond[0].body.reason), '理由说清是目录边界')
}
// 6.5 没有 ffmpeg → needFfmpeg
{
  const { h, respond } = mkHandlers({
    body: { path: fakeVideo, mode: 'frames', startFrame: 0, endFrame: 0 },
    run: async () => { throw new Error('ENOENT') },
  })
  await h.frameHandler(reqOf('POST'), {})
  eq(respond[0].body.needFfmpeg, true, '★★ 没 ffmpeg 时明确 needFfmpeg，不假装成功')
  eq(respond[0].body.ok, false, '没 ffmpeg 就不报成功')
}
// 6.6 有 ffmpeg → 真调用（注入的 run 只记录）
{
  calls.length = 0
  const { h, respond } = mkHandlers({
    body: { path: fakeVideo, mode: 'frames', fps: 24, startFrame: 24, endFrame: 24 },
  })
  await h.frameHandler(reqOf('POST'), {})
  eq(respond[0].body.ok, true, '有 ffmpeg → 抽帧成功')
  // 注意：探测工具时也会跑一次 `ffmpeg -version`，所以不能只按 c[0] 找
  const cmd = calls.find((c) => c[0] === 'ffmpeg' && c.includes('-i'))
  ok(cmd !== undefined, '确实调用了 ffmpeg（真正抽帧那次，不是 -version）')
  ok(cmd !== undefined && cmd.includes('-frames:v'), '用了 -frames:v 1')
  ok(respond[0].body.path.startsWith(tmp), '产物写出图目录内')
}
// 6.7 clip：参数错误时 400，不调 ffmpeg
{
  calls.length = 0
  const { h, respond } = mkHandlers({ body: { path: fakeVideo, mode: 'frames', startFrame: 9, endFrame: 1 } })
  await h.clipHandler(reqOf('POST'), {})
  eq(respond[0].status, 400, 'clip 参数非法 → 400')
  eq(calls.length, 0, '★ 参数没通过校验时一次 ffmpeg 都不调')
}
// 6.8 probe 无 ffprobe → 明确说缺什么
{
  const { h, respond } = mkHandlers({
    body: {},
    run: async (cmd) => { if (cmd === 'ffmpeg') return { stdout: '' }; throw new Error('ENOENT') },
  })
  await h.probeHandler(reqOf('GET', '/?path=' + encodeURIComponent(fakeVideo)), {})
  eq(respond[0].body.ok, false, 'probe：没有 ffprobe → 不报成功')
  ok(/ffprobe|ffmpeg/u.test(respond[0].body.reason), '如实说明缺哪个工具')
}
// 6.9 注册助手：五个端点都注册上（2026-11-13 + replace-frame，有意的行为变更）
{
  const registered = []
  const disposers = registerVideoFrameRoutes((r) => { registered.push(r.path); return () => {} }, {
    isLocalRequest: () => true,
    guardWriteRequest: () => true,
    respondJson: () => {},
    readJsonBody: async () => ({}),
    cfg: { outputDir: tmp },
    log: () => {},
    run: async () => ({ stdout: '{}' }),
  })
  eq(registered.length, 5, '★ 五个视频端点全部注册')
  ok(registered.every((p) => p.startsWith('/api/qwen-paint/video/')), '路径前缀一致')
  eq(disposers.length, 5, '返回同样数量的 disposer')

  // 7. 源码级红线
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'video-frames-endpoints.js'), 'utf8')
  ok(!/execSync|exec\(/u.test(src.replace(/execFile/gu, '')), '★ 不用 exec / execSync（只走 execFile）')
  ok(!/shell:\s*true/u.test(src), '★ 不开 shell')
  ok(!/https?:\/\/(?!127\.0\.0\.1)/u.test(src), '★ 模块内没有任何外网地址')
  ok(src.includes('isInside'), '★ 有目录包含检查')
  const idx = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  ok(idx.includes('/api/qwen-paint/video/probe') === false, '路由字面量已移出 index.js（体积红线）')
  ok(idx.includes('registerVideoFrameRoutes'), '★ index.js 用注册助手上挂')
}

fs.rmSync(tmp, { recursive: true, force: true })
try { fs.unlinkSync(outside) } catch { /* 无所谓 */ }

console.log(`\ntest-video-frames: ${passed} 项断言通过${failures.length ? `，${failures.length} 项失败` : ''}`)
for (const x of failures) console.error(`  ✗ ${x}`)
if (failures.length) process.exit(1)
