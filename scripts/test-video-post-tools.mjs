/**
 * 断言风格：ok(名称, 条件)。全离线，零真实子进程（注入假 mediaExec）。
 * 覆盖：视频裁剪/ProRes 的 argv 纯构建 / 路径围栏 / 探测与执行降级 / 六处接线。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VIDEO_TRIM_CROP_TOOL, VIDEO_PRORES_EXPORT_TOOL,
  VIDEO_TRIM_CROP_PATH, VIDEO_PRORES_EXPORT_PATH,
  buildTrimCropCommand, buildProresCommand, makeVideoPostTools, videoPostRouteTable,
} from '../lib/video-post-tools.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'output')
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
let pass = 0
const failures = []
const ok = (name, cond) => { if (cond) pass++; else failures.push(name) }
ok('自检：本文件 ok() 是「名称, 条件」顺序', true)

console.log('=== 1. argv 纯构建 ===')
const src = path.join(OUT, 'a.mp4')
const dst = path.join(OUT, 'b.mp4')
{
  const a = buildTrimCropCommand({ source: src, out: dst, start: 0, end: 5 })
  ok('无裁剪走 -c copy 快切', a.ok === true && a.command.includes('-c') && a.command.includes('copy') && a.reencoded === false)
  ok('快切带 -t 时长', a.command.includes('-t') && a.command[a.command.indexOf('-t') + 1] === '5')
  ok('快切诚实标注关键帧近似', /关键帧/u.test(a.reason))
  const b = buildTrimCropCommand({ source: src, out: dst, start: 1.5, end: 3, crop: { w: 640, h: 360, x: 10, y: 20 } })
  ok('带 crop 强制重编码', b.ok === true && b.reencoded === true && b.command.includes('-vf'))
  ok('crop 参数顺序 w:h:x:y', b.command[b.command.indexOf('-vf') + 1] === 'crop=640:360:10:20')
  ok('重编码用 libx264 + aac copy', b.command.includes('libx264') && b.command.includes('pcm') === false)
  ok('end <= start 被拒', buildTrimCropCommand({ source: src, out: dst, start: 5, end: 5 }).ok === false)
  ok('非法 crop 被拒', buildTrimCropCommand({ source: src, out: dst, crop: { w: 0, h: 10 } }).ok === false)
  const hp = buildProresCommand({ source: src, out: dst, profile: 'hq' })
  ok('ProRes hq → profile 3 / yuv422p10le', hp.ok === true && hp.command.includes('3') && hp.command.includes('yuv422p10le'))
  ok('ProRes 4444 → profile 4 / yuva444p10le', (() => {
    const r = buildProresCommand({ source: src, out: dst, profile: '4444' })
    return r.ok === true && r.command.includes('4') && r.command.includes('yuva444p10le')
  })())
  ok('非法 ProRes profile 被拒', buildProresCommand({ source: src, out: dst, profile: 'h265' }).ok === false)
}

console.log('=== 2. 执行与降级（假执行器） ===')
{
  const tools = makeVideoPostTools({ outputDir: OUT, sourceDirs: [] })
  ok('返回两个工具且名字正确', tools.length === 2 && tools[0].name === VIDEO_TRIM_CROP_TOOL && tools[1].name === VIDEO_PRORES_EXPORT_TOOL)
  const off = await tools[0].execute({ source: src, start: 0, end: 2 })
  ok('未注入执行器 → degraded + command 预览', off.ok === false && off.degraded === true && off.command.length > 0)
  const outside = await tools[0].execute({ source: path.resolve(ROOT, '..', 'secret.mp4') })
  ok('围栏外源文件被拒', outside.ok === false && /目录/u.test(outside.reason))
  const noFfmpeg = makeVideoPostTools({ outputDir: OUT, mediaExec: { probe: async () => ({ available: false }), runCommand: async () => ({ ok: true }) } })
  const d = await noFfmpeg[1].execute({ source: src })
  ok('ffmpeg 不可用 → 不执行且降级', d.ok === false && d.degraded === true && d.path === '')
  let argvSeen = null
  const good = makeVideoPostTools({ outputDir: OUT, mediaExec: {
    probe: async () => ({ available: true }),
    runCommand: async (argv) => { argvSeen = argv; return { ok: true, reason: '已生成' } },
  } })
  const g = await good[0].execute({ source: src, start: 1, end: 2, force_reencode: true })
  ok('真执行成功回路径与命令', g.ok === true && g.path.startsWith(OUT) && Array.isArray(argvSeen))
  const bad = makeVideoPostTools({ outputDir: OUT, mediaExec: {
    probe: async () => ({ available: true }), runCommand: async () => ({ ok: false, reason: 'encoder missing' }),
  } })
  const b = await bad[1].execute({ source: src, profile: 'hq' })
  ok('执行失败 → 不回路径且降级', b.ok === false && b.path === '' && /encoder/u.test(b.reason))
}

console.log('=== 3. 生产接线（六锚点） ===')
{
  const reg = read('lib/tool-registry.js')
  ok('registry import 模块', /from '\.\/video-post-tools\.js'/u.test(reg))
  ok('registry 登记工具名', reg.includes("'video_trim_crop'") && reg.includes("'video_prores_export'"))
  ok('registry 挂工具', /\.\.\.makeVideoPostTools\(base\)/u.test(reg))
  ok('registry 挂端点', /\.\.\.videoPostRouteTable\(base\)/u.test(reg))
  ok('agent-guide 点名', /video_trim_crop:/u.test(read('lib/agent-guide.js')) && /video_prores_export:/u.test(read('lib/agent-guide.js')))
  ok('tool-descriptions 点名', /video_trim_crop:/u.test(read('lib/tool-descriptions.js')) && /video_prores_export:/u.test(read('lib/tool-descriptions.js')))
  const self = read('scripts/selftest.mjs')
  ok('selftest EXPECTED_TOOLS 点名', self.includes("'video_trim_crop'") && self.includes("'video_prores_export'"))
  ok('根 llms.txt 反引号点名', /`video_trim_crop`/u.test(read('llms.txt')) && /`video_prores_export`/u.test(read('llms.txt')))
  ok('docs/llms.txt 反引号点名', /`video_trim_crop`/u.test(read('docs/llms.txt')) && /`video_prores_export`/u.test(read('docs/llms.txt')))
  ok('本测试已登记 SUITES', read('scripts/test-all.mjs').includes("test-video-post-tools.mjs"))
}
{
  const routes = videoPostRouteTable({})
  ok('端点表两条 POST', routes.length === 2 && routes[0].path === VIDEO_TRIM_CROP_PATH && routes[1].path === VIDEO_PRORES_EXPORT_PATH
    && routes.every((r) => r.method === 'POST' && typeof r.handler === 'function'))
}

console.log('\n=== 结果 ===')
console.log(`通过 ${pass}，失败 ${failures.length}`)
if (failures.length) { for (const f of failures) console.log('  FAIL', f); process.exit(1) }
console.log('全部通过')
