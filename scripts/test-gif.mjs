#!/usr/bin/env node
/**
 * GIF 工具 / 端点 / 实验室前端回归。
 *
 * 全离线：零联网、零出图、零子进程。runCommand / readFile / writeFile 都是注入的假函数，
 * 只验证「参数构建 + 目录围栏 + 端点围栏 + 固定错误文案」，绝不真起 ffmpeg。
 *
 * 覆盖：
 *   · ffmpeg 参数构建（单图 / 序列 / 视频 / 自定义参数 / clamp / 自动推断）
 *   · resolveGifOutputPath 目录围栏（含 .. 穿越、盘符、越界、空值）
 *   · 工具形状（schema 8 字段齐全 / timeoutMs>0 / withDeclaredOutput 裁剪）
 *   · 端点围栏（回环 / 方法 / guardWriteRequest）与固定错误文案（不吐 error.message）
 *   · 能力端点如实报告 ffmpeg 是否可用（未探测就说未检测）
 *   · lab.js / lab.css 前端纪律（四事件 + 300ms、doctor 默认一行、无 innerHTML、无外部 URL）
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeGifTool, resolveGifOutputPath, GIF_TOOL_NAME, GIF_TOOL_TIMEOUT_MS } from '../lib/gif-tool.js'
import { gifRouteTable, GIF_MEDIA_PATH, GIF_CAPABILITIES_PATH } from '../lib/gif-endpoints.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
// 纯路径计算用，不创建任何目录、不写任何文件。
const OUT = path.resolve(ROOT, '_gif_out_probe')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

const FIELDS = ['ok', 'path', 'width', 'height', 'frames', 'fps', 'command', 'reason']
const FIELDS_SORTED = FIELDS.slice().sort().join(',')
const vfOf = (cmd) => (Array.isArray(cmd) && cmd.indexOf('-vf') >= 0) ? cmd[cmd.indexOf('-vf') + 1] : ''
const fcOf = (cmd) => (Array.isArray(cmd) && cmd.indexOf('-filter_complex') >= 0) ? cmd[cmd.indexOf('-filter_complex') + 1] : ''

console.log('=== 1. 工具形状（schema / timeoutMs / description） ===')
{
  const tool = makeGifTool({ outputDir: OUT, log: () => {} })
  ok('makeGifTool 返回工具对象', Boolean(tool) && typeof tool === 'object')
  ok("name === 'convert_to_gif'", tool.name === 'convert_to_gif' && GIF_TOOL_NAME === 'convert_to_gif')
  ok('execute 是函数（不是 stub）', typeof tool.execute === 'function')
  ok('timeoutMs > 0', tool.timeoutMs > 0 && GIF_TOOL_TIMEOUT_MS > 0, String(tool.timeoutMs))
  ok('parameters.type === object 且 additionalProperties=false',
    tool.parameters?.type === 'object' && tool.parameters?.additionalProperties === false)
  ok('description 写清 Agent 何时用', /什么时候用/.test(tool.description ?? ''))
  ok('description 写清参数怎么给',
    ['source', 'sources', 'target', 'fps', 'loop', 'maxColors'].every((k) => String(tool.description).includes(k)))
  const props = tool.output?.schema?.properties ?? {}
  ok('output.schema.properties 列全 8 字段（漏写=返回空）',
    FIELDS_SORTED === Object.keys(props).sort().join(','), Object.keys(props).sort().join(','))
  ok('output.schema.additionalProperties === false', tool.output?.schema?.additionalProperties === false)
  ok('8 个字段都有 type 声明', FIELDS.every((k) => typeof props[k]?.type === 'string'))
  ok('command 字段声明为 array + items', props.command?.type === 'array' && Boolean(props.command?.items))
}

console.log('=== 2. resolveGifOutputPath 目录围栏 ===')
{
  const good = resolveGifOutputPath({ target: 'out.gif', outputDir: OUT })
  ok('正常相对文件名 → ok:true 且落在 outputDir 内',
    good.ok === true && good.path.startsWith(OUT + path.sep), String(good.path))
  ok('子目录文件名 → ok:true', resolveGifOutputPath({ target: 'sub/a.gif', outputDir: OUT }).ok === true)
  const up = resolveGifOutputPath({ target: '../evil.gif', outputDir: OUT })
  ok('.. 穿越 → 拒绝且理由含 ..', up.ok === false && String(up.reason).includes('..'))
  ok('嵌套 .. 穿越 → 拒绝', resolveGifOutputPath({ target: 'sub/../../evil.gif', outputDir: OUT }).ok === false)
  ok('.. 只是文件名一部分不误杀', resolveGifOutputPath({ target: 'foo..bar.gif', outputDir: OUT }).ok === true)
  const outside = resolveGifOutputPath({ target: path.resolve(ROOT, '..', 'outside', 'evil.gif'), outputDir: OUT })
  ok('outputDir 外的绝对路径 → 拒绝', outside.ok === false && String(outside.reason).includes('目录'))
  const win = resolveGifOutputPath({ target: 'C:\\Windows\\evil.gif', outputDir: OUT })
  ok('Windows 盘符绝对路径 → 拒绝（不在围栏内）', win.ok === false)
  ok('绝对路径但落在 outputDir 内 → 允许',
    resolveGifOutputPath({ target: path.join(OUT, 'inner.gif'), outputDir: OUT }).ok === true)
  ok('空 target → 拒绝', resolveGifOutputPath({ target: '', outputDir: OUT }).ok === false)
  ok('空 outputDir → 拒绝（写操作没有围栏就拒绝）',
    resolveGifOutputPath({ target: 'a.gif', outputDir: '' }).ok === false)
  ok('无参数 → 拒绝', resolveGifOutputPath().ok === false)
}

console.log('=== 3. ffmpeg 参数构建（单图 / 序列 / 视频 / 自定义 / clamp） ===')
{
  const tool = makeGifTool({ outputDir: OUT, log: () => {} })

  const img = await tool.execute({ source: 'a.png', target: 'image.gif' })
  ok('单图离线降级：ok:false + 明确 reason（绝不真起进程）',
    img.ok === false && /降级|未探测/.test(img.reason) && Object.keys(img).sort().join(',') === FIELDS_SORTED,
    img.reason)
  ok('单图 command 是数组且以 ffmpeg 开头', Array.isArray(img.command) && img.command[0] === 'ffmpeg')
  ok('单图 command 含 -i 输入、-vf 滤镜、-y 输出',
    img.command.includes('-i') && img.command.includes('a.png') && img.command.includes('-vf') && img.command.includes('-y'))
  ok('单图 -loop 1（输入循环）', img.command.includes('1') && img.command.filter((x) => x === '-loop').length >= 2)
  ok('单图 frames === 1', img.frames === 1)
  ok('单图 path 是围栏后的绝对路径', img.path.startsWith(OUT + path.sep))
  ok('单图 width/height/frames/fps 都是数字',
    [img.width, img.height, img.frames, img.fps].every((n) => typeof n === 'number' && Number.isFinite(n)))

  const vf = vfOf(img.command)
  ok('默认参数进滤镜链（fps=12 / scale=480:-1 / max_colors=128 / dither=sierra2_4a）',
    vf.includes('fps=12') && vf.includes('scale=480:-1') && vf.includes('max_colors=128') && vf.includes('dither=sierra2_4a'), vf)
  ok('输出路径是 command 最后一项', img.command[img.command.length - 1] === img.path)

  const custom = await tool.execute({
    source: 'a.png', target: 'custom.gif',
    fps: 8, width: 320, height: 240, duration: 2, loop: 3, dither: 'bayer', maxColors: 64,
  })
  const cvf = vfOf(custom.command)
  ok('自定义 fps/width/height/maxColors/dither 全部进 ffmpeg 参数',
    cvf.includes('fps=8') && cvf.includes('scale=320:240') && cvf.includes('max_colors=64') && cvf.includes('dither=bayer'), cvf)
  ok('自定义 duration=2 与 loop=3 进参数',
    custom.command.includes('2') && custom.command.includes('-t') && custom.command.includes('3') && custom.command.includes('-loop'))
  ok('自定义 fps 回写结果字段', custom.fps === 8 && custom.width === 320 && custom.height === 240)

  const seq = await tool.execute({ sources: ['a.png', 'b.png', 'c.png'], target: 'seq.gif' })
  ok('图片序列走 concat（filter_complex 含 concat=n=3）', fcOf(seq.command).includes('concat=n=3'), fcOf(seq.command))
  ok('图片序列 3 个 -i 输入', seq.command.filter((x) => x === '-i').length === 3)
  ok('图片序列 frames === 3', seq.frames === 3)
  ok('序列滤镜链仍带 fps / scale / palette',
    fcOf(seq.command).includes('fps=') && fcOf(seq.command).includes('scale=') && fcOf(seq.command).includes('palettegen='))

  const vid = await tool.execute({ source: 'clip.mp4', target: 'clip.gif', duration: 4, fps: 12 })
  ok('视频参数含 -an 去音频 / -ss 0 起点', vid.command.includes('-an') && vid.command.includes('-ss') && vid.command.includes('0'))
  ok('视频 frames = round(duration×fps)=48（估算，未解码源）', vid.frames === 48, String(vid.frames))
  ok('视频 description 明说 frames 是估算', /估算/.test(tool.description))

  const autoVid = await tool.execute({ source: 'clip.mkv', target: 'auto.gif' })
  ok('不带 mode 时按扩展名自动推断为视频', autoVid.command.includes('-an'))
  const autoImg = await tool.execute({ source: 'a.webp', target: 'auto2.gif' })
  ok('不带 mode 时按扩展名自动推断为单图', !autoImg.command.includes('-an') && autoImg.command.includes('-vf'))
  const forced = await tool.execute({ source: 'raw.dat', mode: 'video', target: 'forced.gif' })
  ok('无法识别扩展名时可用 mode 显式指定', forced.command.includes('-an'))

  const noInput = await tool.execute({ target: 'x.gif' })
  ok('无 source / sources → ok:false + 明确理由', noInput.ok === false && /source/.test(noInput.reason))
  const escaped = await tool.execute({ source: 'a.png', target: '../evil.gif' })
  ok('target 越界 → ok:false 且 command 为空', escaped.ok === false && escaped.command.length === 0)
  const badDither = await tool.execute({ source: 'a.png', target: 'd.gif', dither: 'evil' })
  ok('非法 dither 回落默认 sierra2_4a', vfOf(badDither.command).includes('dither=sierra2_4a'))
  const clamped = await tool.execute({
    source: 'a.png', target: 'c.gif', fps: 999, width: 1, maxColors: 9999,
  })
  ok('fps/width/maxColors 越界被 clamp（60 / 16 / 256）',
    vfOf(clamped.command).includes('fps=60') && vfOf(clamped.command).includes('scale=16:-1') && vfOf(clamped.command).includes('max_colors=256'),
    vfOf(clamped.command))
}

console.log('=== 4. 真执行路径（注入假 runCommand，零子进程） + schema 裁剪 ===')
{
  let calls = 0
  let reads = 0
  let writes = 0
  let lastCmd = null
  const live = makeGifTool({
    outputDir: OUT,
    runCommand: async (cmd) => { calls += 1; lastCmd = cmd; return { ok: true } },
    readFile: async () => { reads += 1; return Buffer.from('x') },
    writeFile: async () => { writes += 1 },
    log: () => {},
  })
  const r = await live.execute({ source: 'a.png', target: 'real.gif' })
  ok('注入 runCommand 后真执行 → ok:true', r.ok === true)
  ok('runCommand 收到构建好的 ffmpeg 参数（只调一次）',
    calls === 1 && Array.isArray(lastCmd) && lastCmd.includes('ffmpeg'))
  ok('真执行路径校验输入可读（readFile 被调用）', reads >= 1)
  ok('真执行路径写参数留痕（writeFile 被调用）', writes >= 1)
  const wrapped = withDeclaredOutput(live)
  const rw = await wrapped.execute({ source: 'a.png', target: 'w.gif' })
  ok('withDeclaredOutput 裁剪后 8 字段齐全（证明没漏写）',
    Object.keys(rw).sort().join(',') === FIELDS_SORTED, Object.keys(rw).sort().join(','))
}

console.log('=== 5. 端点围栏与固定错误文案（全离线注入假 deps） ===')
{
  const makeDeps = (over = {}) => {
    const sent = []
    return {
      sent,
      isLocalRequest: (req) => req.local !== false,
      respondJson: (res, body, status) => { sent.push({ body, status }) },
      readJsonBody: async () => ({}),
      guardWriteRequest: () => true,
      log: () => {},
      ...over,
    }
  }
  const invoke = async (over, req, which) => {
    const deps = makeDeps(over)
    const route = gifRouteTable(deps).find((r) => r.path === which)
    await route.handler(req, {})
    return deps.sent
  }
  const table = gifRouteTable(makeDeps())
  ok('gifRouteTable 返回 [{path,method,handler}] 两项',
    Array.isArray(table) && table.length === 2
    && table.every((r) => typeof r.path === 'string' && typeof r.method === 'string' && typeof r.handler === 'function'))
  ok('路径与 method 正确（POST media/gif + GET capabilities）',
    table.some((r) => r.path === GIF_MEDIA_PATH && r.method === 'POST')
    && table.some((r) => r.path === GIF_CAPABILITIES_PATH && r.method === 'GET'))

  let s = await invoke({}, { method: 'POST', local: false }, GIF_MEDIA_PATH)
  ok('POST 非本机 → 403 + 固定文案', s[0].status === 403 && s[0].body.reason === 'local requests only')
  s = await invoke({}, { method: 'GET' }, GIF_MEDIA_PATH)
  ok('POST 端点收到 GET → 405 + POST only', s[0].status === 405 && s[0].body.reason === 'POST only')
  let guarded = 0
  s = await invoke({ guardWriteRequest: () => { guarded += 1; return true } }, { method: 'POST' }, GIF_MEDIA_PATH)
  ok('POST 走 guardWriteRequest 围栏', guarded === 1)
  ok('POST 本机正常 → 回 8 字段结果', Object.keys(s[0].body).sort().join(',') === FIELDS_SORTED,
    Object.keys(s[0].body).sort().join(','))

  s = await invoke({ readJsonBody: async () => { throw new Error('/root/private/token EACCES') } }, { method: 'POST' }, GIF_MEDIA_PATH)
  const bodyStr = JSON.stringify(s[0])
  ok('POST 读体抛错 → 500 + 固定文案（不吐 error.message / 绝对路径）',
    s[0].status === 500 && s[0].body.reason === 'GIF 转换暂不可用（详见插件日志）'
    && !bodyStr.includes('private') && !bodyStr.includes('EACCES'))
  s = await invoke({ gifTool: { execute: async () => { throw new Error('/abs/secret/boom') } } }, { method: 'POST' }, GIF_MEDIA_PATH)
  ok('POST 工具抛错 → 500 + 固定文案（不吐 error.message）',
    s[0].status === 500 && s[0].body.reason === 'GIF 转换暂不可用（详见插件日志）'
    && !JSON.stringify(s[0]).includes('secret'))

  s = await invoke({}, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('能力端点未探测 → ffmpeg:undetected + probed:false + canExecute:false',
    s[0].body.ffmpeg === 'undetected' && s[0].body.probed === false
    && s[0].body.canExecute === false && /未探测/.test(s[0].body.reason), JSON.stringify(s[0].body))
  s = await invoke({ probeFfmpeg: async () => ({ available: false, reason: 'not found' }) }, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('探测到不可用 → ffmpeg:unavailable（如实）', s[0].body.ffmpeg === 'unavailable' && s[0].body.canExecute === false)
  s = await invoke({ probeFfmpeg: async () => ({}) }, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('探测结论缺 available → 仍按 undetected（不假装可用）', s[0].body.ffmpeg === 'undetected')
  s = await invoke({ probeFfmpeg: async () => ({ available: true }) }, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('探测可用但没注入 runCommand → canExecute:false（可用才启用）',
    s[0].body.ffmpeg === 'available' && s[0].body.canExecute === false)
  s = await invoke({ probeFfmpeg: async () => ({ available: true }), runCommand: async () => ({ ok: true }) }, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('探测可用且注入 runCommand → canExecute:true', s[0].body.ffmpeg === 'available' && s[0].body.canExecute === true)
  ok('能力端点如实附带默认参数', s[0].body.defaults && s[0].body.defaults.fps === 12)
  s = await invoke({ probeFfmpeg: async () => { throw new Error('/home/user/secret') } }, { method: 'GET' }, GIF_CAPABILITIES_PATH)
  ok('能力探测抛错 → 500 + 固定文案（不吐 error.message）',
    s[0].status === 500 && s[0].body.reason === '能力查询暂不可用（详见插件日志）'
    && !JSON.stringify(s[0]).includes('secret'))
  s = await invoke({}, { method: 'GET', local: false }, GIF_CAPABILITIES_PATH)
  ok('能力端点非本机 → 403', s[0].status === 403 && s[0].body.reason === 'local requests only')
  s = await invoke({}, { method: 'POST' }, GIF_CAPABILITIES_PATH)
  ok('能力端点收到 POST → 405 + GET only', s[0].status === 405 && s[0].body.reason === 'GET only')
}

console.log('=== 6. 实验室前端纪律（源码断言，零 DOM / 零联网） ===')
{
  const LAB = read('assets/lab.js')
  const LAB_CSS = read('assets/lab.css')
  const PANEL = read('assets/panel.js')
  const CLIENT = read('lib/client.js')

  ok('lab.js 请求前缀固定为 api/qwen-paint/', LAB.includes("var API = 'api/qwen-paint/'"))
  ok('lab.js 四事件点按兜底（click/pointerup/mouseup/touchend）',
    ['click', 'pointerup', 'mouseup', 'touchend'].every((e) => LAB.includes("'" + e + "'")))
  ok('lab.js 300ms 冷却', /COOLDOWN_MS = 300/.test(LAB))
  ok('lab.js 不用 innerHTML 拼内容', !LAB.includes('innerHTML'))
  ok('lab.js 不加载任何外部 URL', !/https?:\/\//.test(LAB))
  const reqPaths = [...LAB.matchAll(/request\('([^']+)'/g)].map((m) => m[1])
  // ★ 2026-11-14 全面排查：实验室浮层新增 doctor 探针契约 / 显存预算 / 结构化日志 /
  //   配置矛盾四个入口，端点必须显式登记进白名单（集合逐字相等，漏一个就红）。
  // ★ 2026-11-15 媒体格式转换批次：新增 media/formats（GET 能力表 / POST 预设）与
  //   media/convert（POST 转换）两个入口，必须显式登记进白名单（集合逐字相等，漏一个就红）。
  // ★ 2026-11-15 本地能力批次：TTS 后端 / 拖入音频样本 / 音乐 BGM / 手动超分 / Worker
  //   五张新卡片共 8 个入口，必须显式登记（集合逐字相等，漏一个就红）。
  const ALLOWED = ['media/gif', 'media/gif/capabilities', 'media/formats', 'media/convert',
    'health', 'wizard', 'integration/state',
    'status.json', 'capabilities', 'workflows', 'accel/chain',
    'doctor?detail=1', 'vram-budget', 'events', 'config/conflicts',
    'contracts', 'contracts?build=1&id=image-qwen21', 'eta',
    'tts/backends', 'audio/samples', 'music/models', 'music/generate',
    'upscale/manual/capabilities', 'upscale/manual', 'workers', 'workers/vram',
    // ★ 2026-11-15 收尾：实验室新增「参考图色调」功能区，走本机取样端点。
    'tone/extract',
    'accel/backends']
  ok('lab.js 的 request 路径全是相对本机端点（无 / 或 http 开头）',
    reqPaths.length >= 18 && reqPaths.every((p) => !p.startsWith('/') && !p.startsWith('http')), reqPaths.join(','))
  ok('lab.js 端点全落在 /api/qwen-paint/ 白名单内',
    reqPaths.every((p) => ALLOWED.includes(p)), reqPaths.join(','))
  ok('★ 端点集合逐字等于白名单（新增入口必须显式登记，漏一个就红）',
    [...new Set(reqPaths)].sort().join(',') === [...ALLOWED].sort().join(','), reqPaths.join(','))
  ok('lab.js doctor 详情默认 hidden + doctorOpen=false（默认只一行简略）',
    LAB.includes('els.doctorDetail.hidden = true') && LAB.includes('var doctorOpen = false'))
  ok('lab.js 点开才展开详情且只拉一次',
    LAB.includes('els.doctorDetail.hidden = !doctorOpen') && LAB.includes('doctorLoaded'))
  ok('lab.js doctor 简略结论是独立一行元素', LAB.includes("'dshqp-lab-doctor-line'"))
  ok('lab.css 详情容器默认藏（观感硬要求）', LAB_CSS.includes('.dshqp-lab-doctor-detail[hidden]'))
  ok('panel.js 按 id 去重挂 head 懒加载 lab.js / lab.css',
    PANEL.includes('dshqp-lab-css') && PANEL.includes('dshqp-lab-js')
    && PANEL.includes('qwen-paint/lab.css') && PANEL.includes('qwen-paint/lab.js')
    && PANEL.includes('if (doc.getElementById(a.id)) continue') && PANEL.includes('head.appendChild(node)'))
  ok('panel.js mount() 里调用 loadLabAssets()', PANEL.includes('loadLabAssets()'))
  ok('未改冻结的 lib/client.js（没有 lab 登记）', !CLIENT.includes('dshqp-lab'))
}

console.log('=== test-gif：' + pass + ' 项通过，' + fail + ' 项失败 ===')
process.exit(fail === 0 ? 0 : 1)
