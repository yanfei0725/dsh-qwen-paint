#!/usr/bin/env node
/**
 * test-video-replace.mjs —— 时间轴增强（缩略图轨道 + 改完的帧回贴）离线回归
 *
 * 全程注入假 deps + 临时目录：零真实 ffmpeg 调用、零真实 ComfyUI、
 * 不生成任何图片/视频/音频（临时文件里只有字符串占位字节）。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import {
  resolveReplaceFrame, buildReplaceFrameArgs, MAX_REPLACE_FRAME,
} from '../lib/video-frames.js'
import {
  makeVideoFrameHandlers, registerVideoFrameRoutes,
} from '../lib/video-frames-endpoints.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, '$1')), '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

console.log('=== 1. 帧号 → 时间区间（纯逻辑） ===')
{
  const a = resolveReplaceFrame({ frame: 48, fps: 24 })
  ok('合法输入返回 ok', a.ok === true)
  ok('24fps 第 48 帧 = 2.000000 s', a.startSec === 2, a.startSec)
  ok('单帧时长 = 1/24 s', a.durationSec === Number((1 / 24).toFixed(6)))
  ok('半开区间 endSec = start + duration', a.endSec === Number((2 + 1 / 24).toFixed(6)))
  const b = resolveReplaceFrame({ frame: 0, fps: 24 })
  ok('第 0 帧从 0 开始（不猜错起点）', b.startSec === 0 && b.frame === 0)
  ok('负帧号明确拒绝', resolveReplaceFrame({ frame: -1, fps: 24 }).ok === false)
  ok('非数字帧号明确拒绝', resolveReplaceFrame({ frame: 'abc', fps: 24 }).ok === false)
  ok('帧率低于下限拒绝', resolveReplaceFrame({ frame: 1, fps: 1 }).ok === false)
  ok('帧率高于上限拒绝', resolveReplaceFrame({ frame: 1, fps: 999 }).ok === false)
  ok('缺帧率不猜默认值', resolveReplaceFrame({ frame: 1 }).ok === false)
  const c = resolveReplaceFrame({ frame: 1e9, fps: 24 })
  ok('超大帧号夹到 MAX_REPLACE_FRAME', c.ok === true && c.frame === MAX_REPLACE_FRAME)
}

console.log('\n=== 2. ffmpeg 参数（argv 数组，不拼 shell） ===')
{
  const evilInput = 'my video;rm -rf .mp4'
  const evilImage = 'edited & frame.png'
  const args = buildReplaceFrameArgs({
    input: evilInput, image: evilImage, output: 'out.mp4',
    startSec: 2, durationSec: 1 / 24,
  })
  ok('是数组', Array.isArray(args))
  ok('输入视频作为单个 argv 元素（不被拆成命令）', args.includes(evilInput))
  ok('改好的图作为单个 argv 元素', args.includes(evilImage))
  ok('输出作为单个 argv 元素', args.includes('out.mp4'))
  ok('没有把文件名拼进 filter', !args.some((a) => a.includes('rm -rf') && a.includes('overlay')))
  // 文件名本身含 ; 是合法的（单个 argv 元素无注入面），要防的是被拆成额外命令。
  ok('命令行没有被拆出额外命令（无独立 rm / -rf / && 元素）',
    !args.some((a) => a === 'rm' || a === '-rf' || a === '&&' || a === '|'))
  ok('用 filter_complex overlay', args.includes('-filter_complex') && args.some((a) => a.includes('overlay=')))
  ok('只在目标帧时间生效（半开区间 gte*lt）', args.some((a) => a.includes("enable='gte(t,2)*lt(t,2.041667)'")), args.find((a) => a.includes('enable')))
  ok('保留原音轨且没有音轨也不报错', args.includes('0:a?'))
  ok('输出统一 H.264 / yuv420p', args.includes('libx264') && args.includes('yuv420p'))
  ok('两个 -i 输入', args.filter((a) => a === '-i').length === 2)
  ok('异常 duration 被夹住（不覆盖整段）', (() => {
    const x = buildReplaceFrameArgs({ input: 'a', image: 'b', output: 'c', startSec: 0, durationSec: 999 })
    return x.some((a) => a.includes('lt(t,1)'))
  })())
}

console.log('\n=== 3. 端点行为（注入假 deps） ===')
let tmp = ''
try {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-replace-'))
  const fakeVideo = path.join(tmp, 'clip.mp4')
  const fakeImage = path.join(tmp, 'edited.png')
  await fsp.writeFile(fakeVideo, 'FAKE-VIDEO')
  await fsp.writeFile(fakeImage, 'FAKE-IMAGE')
  const outside = path.join(os.tmpdir(), 'dshqp-outside-frame.png')
  await fsp.writeFile(outside, 'OUTSIDE')

  const calls = []
  const makeEnv = (body, opts = {}) => {
    const replies = []
    const run = async (cmd, args) => {
      if (args[0] === '-version') {
        if (opts.noFfmpeg) throw new Error('no ffmpeg')
        return { stdout: 'ffmpeg version test' }
      }
      const out = args[args.lastIndexOf('-y') + 1]
      if (!opts.noOutput) await fsp.writeFile(out, 'FAKE-MP4')
      calls.push({ cmd, args })
      return { stdout: '' }
    }
    const h = makeVideoFrameHandlers({
      isLocalRequest: () => opts.local !== false,
      guardWriteRequest: () => opts.guard !== false,
      respondJson: (_res, value, status) => replies.push({ value, status }),
      readJsonBody: async () => body,
      cfg: { outputDir: tmp },
      log: () => {},
      run,
    })
    return { h, replies, req: (method = 'POST') => ({ method, url: '/' }) }
  }
  const invoke = async (body, opts = {}) => {
    const env = makeEnv(body, opts)
    await env.h.replaceFrameHandler(env.req(opts.method), {})
    return env.replies[0] ?? {}
  }

  let r = await invoke({ path: fakeVideo, image: fakeImage, frame: 12, fps: 24 }, { local: false })
  ok('非本机请求 403（顶层围栏在最前）', r.status === 403 && r.value.ok === false)
  r = await invoke({ path: fakeVideo, image: fakeImage, frame: 12, fps: 24 }, { method: 'GET' })
  ok('非 POST 405', r.status === 405)
  r = await invoke({ path: fakeVideo, frame: 12, fps: 24 })
  ok('缺 image 400', r.status === 400 && String(r.value.reason).includes('image'))
  r = await invoke({ path: fakeVideo, image: outside, frame: 12, fps: 24 })
  ok('outputDir 外的图片 400', r.status === 400)
  r = await invoke({ path: fakeVideo, image: path.join(tmp, 'missing.png'), frame: 12, fps: 24 })
  ok('图片不存在 404', r.status === 404)
  r = await invoke({ path: fakeVideo, image: fakeImage, frame: 'abc', fps: 24 })
  ok('非法帧号 400', r.status === 400)
  r = await invoke({ path: fakeVideo, image: fakeImage, frame: 12, fps: 24 }, { noFfmpeg: true })
  ok('没 ffmpeg → needFfmpeg + 503（不假装成功）', r.status === 503 && r.value.needFfmpeg === true)
  r = await invoke({ path: fakeVideo, image: fakeImage, frame: 12, fps: 24 }, { noOutput: true })
  ok('ffmpeg 没产出文件 → 500，不谎报成功', r.status === 500)

  calls.length = 0
  r = await invoke({ path: fakeVideo, image: fakeImage, frame: 48, fps: 24 })
  ok('成功返回 ok:true + path', r.value.ok === true && typeof r.value.path === 'string')
  ok('返回帧号 / 起点 / 时长 / fps', r.value.frame === 48 && r.value.startSec === 2 && r.value.fps === 24)
  ok('产物写在 outputDir 内', r.value.path.startsWith(tmp))
  ok('真的调用了一次 ffmpeg（argv 数组）', calls.length === 1 && Array.isArray(calls[0].args))
  ok('调用参数用的是构造出来的 overlay argv', calls[0].args.some((a) => a.includes('overlay=')))

  const routes = []
  const disposers = registerVideoFrameRoutes((route) => { routes.push(route.path); return () => {} }, {
    isLocalRequest: () => true, guardWriteRequest: () => true,
    respondJson: () => {}, readJsonBody: async () => ({}),
    cfg: { outputDir: tmp }, log: () => {}, run: async () => ({ stdout: '{}' }),
  })
  ok('共注册 5 个视频端点', routes.length === 5 && disposers.length === 5)
  ok('新端点路径正确', routes.includes('/api/qwen-paint/video/replace-frame'))
  ok('路由字面量仍在端点模块（不塞回 index.js）', readSrc('lib/video-frames-endpoints.js').includes("'/api/qwen-paint/video/replace-frame'"))

  await fsp.unlink(outside).catch(() => {})
} finally {
  if (tmp !== '') await fsp.rm(tmp, { recursive: true, force: true })
}

console.log('\n=== 4. 前端接线（源码级） ===')
{
  const client = readSrc('lib/client.js')
  ok('有缩略图轨道元素', client.includes("'dshqp-vid-track'"))
  ok('用隐藏 video + canvas 取帧（零依赖）', client.includes('thumbVideo') && client.includes('toDataURL'))
  ok('缩略图可点击跳转', client.includes("addEventListener('click'") && client.includes('video.currentTime = at'))
  ok('有「贴回这一帧」入口', client.includes('把改好的图贴回这一帧'))
  ok('贴回走新端点', client.includes('api/qwen-paint/video/replace-frame'))
  ok('缺 ffmpeg 时如实提示', client.includes('需要 ffmpeg 才能贴回'))
  ok('缩略图样式沿用主题变量', client.includes('var(--qp-line-strong)'))
  ok('client.js 单文件未超 262144 B', Buffer.byteLength(client, 'utf8') <= 262144, Buffer.byteLength(client, 'utf8'))
  const eps = readSrc('lib/video-frames-endpoints.js')
  ok('端点层只用 execFile（不开 shell）', !/execSync|shell:\s*true/u.test(eps))
  ok('端点层没有外网地址', !/https?:\/\/(?!127\.0\.0\.1)/u.test(eps))
}

console.log(`\n=== 结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}（通过 ${pass}） ===`)
process.exit(fail === 0 ? 0 : 1)
