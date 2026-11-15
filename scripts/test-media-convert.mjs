#!/usr/bin/env node
/**
 * scripts/test-media-convert.mjs —— 媒体格式转换能力专项回归。
 *
 * 用户需求（2026-11-15）：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、
 * 音频 MP3/AAC/WAV/FLAC；生成的图片视频音频可以指定或转换成上述格式；
 * 支持动图转视频；支持用户自己的媒体转换；这些功能也要支持 Agent 调用。
 *
 * 本测试守住五条硬边界：
 *   ① 格式表是唯一真相源，只含用户点名的 11 种；跨类转换明确拒绝；
 *   ② 参数构建是纯计算，所有数值过 clamp；动图转视频不带音频编码器；
 *   ③ 输入/输出双目录围栏，.. 穿越 / 越界 / 扩展名不符一律拒绝；
 *   ④ 没探测到 ffmpeg / 编码器失败 → ok:false + 明确原因 + 参数预览，绝不假装成功；
 *   ⑤ 单个功能完成 ≠ 最终完成：工具/端点/Agent 指引/端点目录/内嵌 UI/回归清单/孤儿扫描
 *      七处联动全部要有真实生产接线（用户亲订纪律）。
 *
 * 全离线：零联网、零出图、零子进程。runCommand / readFile 都是注入的假函数。
 *
 * ⚠ 本文件统一用 ok(name, cond) 顺序（与 test-gif.mjs 一致）；helper 内建写反自检。
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  FORMAT_GROUPS, FORMAT_TABLE, FORMAT_NAMES, FORMAT_ALIASES,
  MEDIA_FORMAT_VERSION, resolveFormat, sourceKindOf, planConversion,
  buildMediaFormatArgs, buildAnimatedVideoArgs, buildMediaConvertCommand,
  normalizeMediaOptions, listFormats, createFormatPrefs,
} from '../lib/media-formats.js'
import { createMediaExec } from '../lib/media-exec.js'
import {
  makeMediaConvertTool, MEDIA_TOOL_NAME, MEDIA_TOOL_TIMEOUT_MS,
  resolveMediaOutputPath, resolveMediaSourcePath, needsConversion, describeMediaFormats,
} from '../lib/media-convert-tool.js'
import {
  mediaRouteTable, MEDIA_CONVERT_PATH, MEDIA_FORMATS_PATH,
} from '../lib/media-convert-endpoints.js'
import {
  planPostConvert, runPostConvert, composeGenerationHook, attachGenerationPostConvert,
} from '../lib/media-postconvert.js'
import { withDeclaredOutput } from '../lib/tool-contracts.js'
import { createExtras, EXTRA_TOOL_NAMES } from '../lib/tool-registry.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'
import { TOOL_HINTS, AGENT_PLAYBOOKS, buildAgentGuide } from '../lib/agent-guide.js'
import { TOOL_SUMMARIES } from '../lib/tool-descriptions.js'
import { setGenerationLogHook, getGenerationLogHook } from '../lib/history-store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
const OUT = path.resolve(ROOT, '_media_out_probe')   // 纯路径计算，不创建目录

let pass = 0
let fail = 0
const fails = []
/** ⚠ 参数顺序：name 在前、cond 在后。写反（ok(true, true)）必须当场抛。 */
function ok(name, cond, extra = '') {
  if (typeof name !== 'string') throw new Error('ok() 参数顺序写反：必须是 (name, cond)')
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')) }
}

const FIELDS = ['ok', 'path', 'format', 'source_kind', 'from_ext', 'to_kind', 'command', 'reason', 'degraded']
const FIELDS_SORTED = FIELDS.slice().sort().join(',')

console.log('=== 1. 格式表：唯一真相源，只含用户点名的 11 种 ===')
{
  ok('图片恰好 JPG / PNG / WebP', FORMAT_GROUPS.image.join(',') === 'jpg,png,webp')
  ok('视频恰好 MP4 / MKV / MOV / WebM', FORMAT_GROUPS.video.join(',') === 'mp4,mkv,mov,webm')
  ok('音频恰好 MP3 / AAC / WAV / FLAC', FORMAT_GROUPS.audio.join(',') === 'mp3,aac,wav,flac')
  ok('★ 格式集合逐字等于 11 种（新增格式必须显式登记）',
    FORMAT_NAMES.join(',') === 'aac,flac,jpg,mkv,mov,mp3,mp4,png,wav,webm,webp', FORMAT_NAMES.join(','))
  ok('三组加起来就是全部格式，不多不少',
    [...FORMAT_GROUPS.image, ...FORMAT_GROUPS.video, ...FORMAT_GROUPS.audio].sort().join(',') === FORMAT_NAMES.join(','))
  ok('每个格式都有 kind / ext / codec / note', FORMAT_NAMES.every((f) => {
    const s = FORMAT_TABLE[f]
    return s.kind && s.ext === f && s.codec && typeof s.note === 'string' && s.note.length > 8
  }))
  ok('格式表冻结（外部改不动）', Object.isFrozen(FORMAT_TABLE) && Object.isFrozen(FORMAT_GROUPS))
  ok('jpeg 别名归一到 jpg', resolveFormat('JPEG').format === 'jpg' && resolveFormat('.jpg').format === 'jpg')
  ok('未知格式明确拒绝且列出可用项',
    resolveFormat('bmp').ok === false && resolveFormat('bmp').reason.includes('jpg'))
  ok('空格式明确拒绝', resolveFormat('').ok === false && resolveFormat().ok === false)
  ok('有损 / 透明通道标注真实（JPG 无 alpha、PNG 无损、WebP 有 alpha）',
    FORMAT_TABLE.jpg.alpha === false && FORMAT_TABLE.jpg.lossy === true
    && FORMAT_TABLE.png.alpha === true && FORMAT_TABLE.png.lossy === false
    && FORMAT_TABLE.webp.alpha === true)
  ok('WebM 明确写明 VP9 慢与编码器依赖', FORMAT_TABLE.webm.note.includes('VP9') && FORMAT_TABLE.webm.note.includes('libvpx-vp9'))
  ok('FLAC 明确写明有损源转出不能恢复细节', FORMAT_TABLE.flac.note.includes('不会恢复'))
  ok('listFormats 是纯数据且带 caveat', typeof listFormats().caveat === 'string'
    && listFormats().version === MEDIA_FORMAT_VERSION
    && Array.isArray(listFormats().conversion_rules))
  ok('caveat 如实说明编码器未逐一验证', listFormats().caveat.includes('是否编入需实际执行'))
  ok('FORMAT_ALIASES 只收 jpeg/jpe', Object.keys(FORMAT_ALIASES).sort().join(',') === 'jpe,jpeg')
  ok('describeMediaFormats 三组带 label/codec', describeMediaFormats().length === 3
    && describeMediaFormats().every((g) => g.formats.every((f) => f.label && f.codec)))
}

console.log('=== 2. 转换裁决：同类互转 + 动图→视频，其余跨类拒绝 ===')
{
  const same = [['image', 'png'], ['image', 'jpg'], ['image', 'webp'],
    ['video', 'mp4'], ['video', 'mkv'], ['video', 'mov'], ['video', 'webm'],
    ['audio', 'mp3'], ['audio', 'aac'], ['audio', 'wav'], ['audio', 'flac']]
  ok('★ 11 组同类互转全部放行', same.every(([k, f]) => planConversion({ sourceKind: k, format: f }).ok === true))
  ok('★ 动图 → 视频放行且标 crossKind/animated',
    planConversion({ sourceKind: 'animated', format: 'mp4' }).crossKind === true
    && planConversion({ sourceKind: 'animated', format: 'mp4' }).animated === true)
  ok('动图 → 视频四个容器都放行',
    FORMAT_GROUPS.video.every((f) => planConversion({ sourceKind: 'animated', format: f }).ok === true))
  ok('动图 → 静态图默认拒绝（必须 still:true）',
    planConversion({ sourceKind: 'animated', format: 'png' }).ok === false)
  ok('动图 → 静态图给 still:true 才放行',
    planConversion({ sourceKind: 'animated', format: 'png', still: true }).still === true)
  const cross = [['image', 'mp3'], ['image', 'mp4'], ['video', 'flac'], ['audio', 'webp'], ['audio', 'mov']]
  ok('★ 5 组跨类转换全部明确拒绝且说清原因', cross.every(([k, f]) => {
    const r = planConversion({ sourceKind: k, format: f })
    return r.ok === false && r.reason.includes('跨类') && r.reason.includes(k)
  }))
  ok('认不出输入类型时拒绝并要求显式声明',
    planConversion({ sourceKind: 'other', format: 'png' }).reason.includes('sourceKind'))
  ok('动图转视频说明循环次数不会自动保留',
    planConversion({ sourceKind: 'animated', format: 'mp4' }).note.includes('循环次数'))
  ok('按扩展名判定：gif/apng → animated', sourceKindOf('a.gif') === 'animated' && sourceKindOf('a.apng') === 'animated')
  ok('按扩展名判定：webp 默认 image，可显式声明 animated',
    sourceKindOf('a.webp') === 'image' && sourceKindOf('a.webp', 'animated') === 'animated')
  ok('按扩展名判定：视频 / 音频 / 未知',
    sourceKindOf('a.mkv') === 'video' && sourceKindOf('a.flac') === 'audio' && sourceKindOf('a.xyz') === 'other')
  ok('不认识的声明值不覆盖推断结果', sourceKindOf('a.mp3', 'nonsense') === 'audio')
}

console.log('=== 3. 参数构建：纯计算、clamp、动图转视频无音频编码器 ===')
{
  ok('11 种格式都能构建非空参数', FORMAT_NAMES.every((f) => buildMediaFormatArgs(f).length >= 2))
  ok('未知格式返回空数组', buildMediaFormatArgs('bmp').length === 0)
  ok('JPG / PNG / WebP 都只取一帧',
    ['jpg', 'png', 'webp'].every((f) => buildMediaFormatArgs(f).includes('-frames:v')))
  ok('MP4 带 +faststart', buildMediaFormatArgs('mp4').includes('+faststart'))
  ok('WebM 用 VP9 + libopus + b:v 0',
    buildMediaFormatArgs('webm').includes('libvpx-vp9') && buildMediaFormatArgs('webm').includes('libopus'))
  ok('AAC 显式 -f adts（裸流而非 m4a 容器）',
    buildMediaFormatArgs('aac').includes('adts') && buildMediaFormatArgs('aac').includes('-f'))
  ok('WAV / FLAC 编码器正确',
    buildMediaFormatArgs('wav').includes('pcm_s16le') && buildMediaFormatArgs('flac').includes('flac'))
  const o = normalizeMediaOptions({ quality: 9999, crf: -5, bitrate: 1, fps: 999, loop_count: 999, preset: 'evil' })
  ok('★ 所有数值都被 clamp 到边界（杜绝 argv 注入面）',
    o.quality === 100 && o.crf === 0 && o.bitrate === 32 && o.fps === 60 && o.loopCount === 20 && o.preset === 'medium')
  ok('非数值回落默认', normalizeMediaOptions({ crf: 'x' }).crf === 23)
  ok('buildAnimatedVideoArgs 不含 -stream_loop（单一来源）',
    !buildAnimatedVideoArgs({ loop_count: 3 }).includes('-stream_loop'))
  ok('buildAnimatedVideoArgs 含 fps / scale / format=yuv420p',
    buildAnimatedVideoArgs()[1].includes('fps=12') && buildAnimatedVideoArgs()[1].includes('format=yuv420p'))
  for (const f of FORMAT_GROUPS.video) {
    const r = buildMediaConvertCommand({ source: 'a.gif', out: 'o.' + f, format: f })
    ok('★ 动图→' + f + ' 显式 -an 且不含音频编码器',
      r.ok && r.command.includes('-an') && !r.command.includes('-c:a') && !r.command.includes('-b:a'))
  }
  const loop = buildMediaConvertCommand({ source: 'a.gif', out: 'o.mp4', format: 'mp4', options: { loop_count: 3, duration: 2 } })
  ok('loop_count 生成一次 -stream_loop 且在 -i 之前',
    loop.command.filter((x) => x === '-stream_loop').length === 1
    && loop.command.indexOf('-stream_loop') < loop.command.indexOf('-i'))
  ok('duration 生成一次 -t 且在 -i 之后',
    loop.command.filter((x) => x === '-t').length === 1
    && loop.command.indexOf('-t') > loop.command.indexOf('-i'))
  ok('默认动图转视频不重复、不截断',
    !buildMediaConvertCommand({ source: 'a.gif', out: 'o.mp4', format: 'mp4' }).command.includes('-stream_loop'))
  const still = buildMediaConvertCommand({ source: 'a.gif', out: 'o.png', format: 'png', still: true })
  ok('动图取首帧：-frames:v 1 只出现一次', still.command.filter((x) => x === '-frames:v').length === 1)
  const cmd = buildMediaConvertCommand({ source: 'a.mp3', out: 'o.flac', format: 'flac', sourceKind: 'audio' })
  ok('音频转换命令以 ffmpeg 开头、argv 是数组、-y + 输出结尾',
    cmd.ok && Array.isArray(cmd.command) && cmd.command[0] === 'ffmpeg'
    && cmd.command.includes('-y') && cmd.command[cmd.command.length - 1] === 'o.flac')
  ok('source/out 为空明确拒绝',
    buildMediaConvertCommand({ out: 'o.png', format: 'png' }).ok === false
    && buildMediaConvertCommand({ source: 'a.png', format: 'png' }).ok === false)
  ok('跨类请求在参数构建层也拒绝（不产生命令）',
    buildMediaConvertCommand({ source: 'a.png', out: 'o.mp3', format: 'mp3' }).command === undefined)
  ok('所有命令元素都是字符串（无注入对象）',
    FORMAT_NAMES.every((f) => {
      const c = buildMediaConvertCommand({ source: 'a.' + (FORMAT_TABLE[f].kind === 'image' ? 'png' : FORMAT_TABLE[f].kind === 'video' ? 'mp4' : 'wav'),
        out: 'o.' + f, format: f })
      return c.ok && c.command.every((x) => typeof x === 'string')
    }))
}

console.log('=== 4. 目录围栏（输入 + 输出） ===')
{
  ok('正常相对文件名通过', resolveMediaOutputPath({ target: 'o.webp', outputDir: OUT, format: 'webp' }).ok === true)
  ok('省略扩展名自动补 .format',
    resolveMediaOutputPath({ target: 'o', outputDir: OUT, format: 'png' }).path.endsWith('o.png'))
  ok('子目录文件名通过', resolveMediaOutputPath({ target: 'sub/o.mp4', outputDir: OUT, format: 'mp4' }).ok === true)
  ok('★ .. 穿越拒绝且理由含 ..',
    resolveMediaOutputPath({ target: '../evil.png', outputDir: OUT, format: 'png' }).reason.includes('..'))
  ok('★ 嵌套 .. 穿越拒绝',
    resolveMediaOutputPath({ target: 'sub/../../evil.png', outputDir: OUT, format: 'png' }).ok === false)
  ok('.. 只是文件名一部分不误杀',
    resolveMediaOutputPath({ target: 'foo..bar.png', outputDir: OUT, format: 'png' }).ok === true)
  ok('★ 扩展名与目标格式不符明确拒绝',
    resolveMediaOutputPath({ target: 'o.jpg', outputDir: OUT, format: 'png' }).reason.includes('不一致'))
  ok('jpeg 扩展名对 jpg 目标放行',
    resolveMediaOutputPath({ target: 'o.jpeg', outputDir: OUT, format: 'jpg' }).ok === true)
  ok('★ 围栏外绝对路径拒绝',
    resolveMediaOutputPath({ target: path.resolve(ROOT, '..', 'evil.png'), outputDir: OUT, format: 'png' }).ok === false)
  ok('Windows 盘符绝对路径拒绝',
    resolveMediaOutputPath({ target: 'C:\\Windows\\evil.png', outputDir: OUT, format: 'png' }).ok === false)
  ok('落在围栏内的绝对路径允许',
    resolveMediaOutputPath({ target: path.join(OUT, 'inner.png'), outputDir: OUT, format: 'png' }).ok === true)
  ok('空 target / 空 outputDir 都拒绝',
    resolveMediaOutputPath({ target: '', outputDir: OUT, format: 'png' }).ok === false
    && resolveMediaOutputPath({ target: 'o.png', outputDir: '', format: 'png' }).ok === false)
  ok('输出路径不能就是目录本身',
    resolveMediaOutputPath({ target: OUT, outputDir: OUT, format: 'png' }).ok === false)

  ok('输入：出图目录内相对文件名通过（不依赖进程 cwd）',
    resolveMediaSourcePath({ source: 'a.png', outputDir: OUT }).path === path.join(OUT, 'a.png'))
  ok('输入：出图目录内绝对路径通过',
    resolveMediaSourcePath({ source: path.join(OUT, 'a.png'), outputDir: OUT }).ok === true)
  ok('★ 输入：目录外路径拒绝且说明要放进公布目录',
    resolveMediaSourcePath({ source: path.resolve(ROOT, '..', 'secret.png'), outputDir: OUT }).reason.includes('允许'))
  ok('★ 输入：.. 穿越拒绝',
    resolveMediaSourcePath({ source: '../secret.png', outputDir: OUT }).reason.includes('..'))
  ok('输入：sourceDirs 白名单内路径通过',
    resolveMediaSourcePath({ source: path.join(ROOT, 'assets', 'a.png'), outputDir: OUT, sourceDirs: [path.join(ROOT, 'assets')] }).ok === true)
  ok('输入：root 本身（目录）不算文件',
    resolveMediaSourcePath({ source: OUT, outputDir: OUT }).ok === false)
  ok('输入：无 source / 无允许目录都拒绝',
    resolveMediaSourcePath({ source: '', outputDir: OUT }).ok === false
    && resolveMediaSourcePath({ source: 'a.png', outputDir: '' }).ok === false)
  ok('needsConversion：同格式不转、jpeg↔jpg 视为同格式',
    needsConversion('a.webp', 'webp') === false && needsConversion('a.jpeg', 'jpg') === false)
  ok('needsConversion：不同格式要转、未知格式不转',
    needsConversion('a.png', 'webp') === true && needsConversion('a.png', 'bmp') === false)
}

console.log('=== 5. 工具形状 + 离线降级 + 真执行（注入假执行器，零子进程） ===')
{
  const tool = makeMediaConvertTool({ outputDir: OUT, log: () => {} })
  ok('name === convert_media', tool.name === MEDIA_TOOL_NAME && MEDIA_TOOL_NAME === 'convert_media')
  ok('timeoutMs > 0', tool.timeoutMs > 0 && MEDIA_TOOL_TIMEOUT_MS > 0)
  ok('execute 是函数', typeof tool.execute === 'function')
  ok('parameters 关闭额外字段', tool.parameters.additionalProperties === false)
  ok('description 写明 Agent 何时用', /什么时候用/.test(tool.description))
  ok('description 点名 12 种格式关键词',
    ['JPG', 'PNG', 'WebP', 'MP4', 'MKV', 'MOV', 'WebM', 'MP3', 'AAC', 'WAV', 'FLAC', '动图']
      .every((k) => tool.description.includes(k)))
  ok('description 写明诚实边界（不假装已转换）', /绝不假装已转换/.test(tool.description))
  const props = tool.output.schema.properties
  ok('★ output.schema 列全 9 字段（漏写=返回空）',
    Object.keys(props).sort().join(',') === FIELDS_SORTED, Object.keys(props).sort().join(','))
  ok('9 个字段都有 type', FIELDS.every((k) => typeof props[k].type === 'string'))
  ok('output.schema.additionalProperties === false', tool.output.schema.additionalProperties === false)

  ok('未注入执行器 → ok:false + degraded:true + 明确理由（绝不真起进程）',
    await (async () => {
      const r = await tool.execute({ source: 'a.png', format: 'webp' })
      return r.ok === false && r.degraded === true && /离线降级/.test(r.reason) && r.command.length > 0
    })())
  ok('未知格式 → 明确拒绝且列出可用项',
    await (async () => {
      const r = await tool.execute({ source: 'a.png', format: 'bmp' })
      return r.ok === false && r.command.length === 0 && r.reason.includes('不支持')
    })())
  ok('跨类转换 → 明确拒绝，command 为空',
    await (async () => {
      const r = await tool.execute({ source: 'a.png', format: 'mp3' })
      return r.ok === false && r.command.length === 0 && r.reason.includes('跨类')
    })())
  ok('输出越界 → 拒绝',
    await (async () => (await tool.execute({ source: 'a.png', format: 'webp', target: '../evil.webp' })).ok === false)())
  ok('输入越界 → 拒绝',
    await (async () => (await tool.execute({ source: path.resolve(ROOT, '..', 'x.png'), format: 'webp' })).ok === false)())

  let calls = 0
  let lastCmd = null
  const mediaExec = {
    enabled: true,
    probe: async () => ({ available: true, ffmpeg: 'ffmpeg', source: 'PATH' }),
    runCommand: async (cmd) => { calls += 1; lastCmd = cmd; return { ok: true, reason: '已生成目标格式文件' } },
  }
  const live = makeMediaConvertTool({ outputDir: OUT, mediaExec, log: () => {} })
  ok('注入执行器 → ok:true 且 degraded:false',
    await (async () => {
      const r = await live.execute({ source: 'a.png', format: 'webp' })
      return r.ok === true && r.degraded === false && r.format === 'webp' && r.from_ext === 'png'
    })())
  ok('真执行每次恰好调一次执行器且收到 ffmpeg argv',
    await (async () => {
      const before = calls
      await live.execute({ source: 'a.png', format: 'webp' })
      return calls === before + 1 && lastCmd[0] === 'ffmpeg'
    })())
  ok('自动命名不会覆盖源文件',
    await (async () => {
      const r = await live.execute({ source: 'picture.png', format: 'png' })
      // 同格式仍需转（用户显式要求），但输出名带 _converted
      return r.path.endsWith('picture_converted.png') && r.path !== path.join(OUT, 'picture.png')
    })())
  ok('withDeclaredOutput 裁剪后 9 字段齐全',
    await (async () => {
      const r = await withDeclaredOutput(live).execute({ source: 'a.png', format: 'webp' })
      return Object.keys(r).sort().join(',') === FIELDS_SORTED
    })())
  const failing = makeMediaConvertTool({
    outputDir: OUT, log: () => {},
    mediaExec: { runCommand: async () => ({ ok: false, reason: 'ffmpeg 执行失败（详见插件日志）' }) },
  })
  ok('执行器返回失败 → ok:false + degraded:true，不谎称成功',
    await (async () => {
      const r = await failing.execute({ source: 'a.png', format: 'webp' })
      return r.ok === false && r.degraded === true && r.reason.includes('失败')
    })())
  const throwing = makeMediaConvertTool({
    outputDir: OUT, log: () => {},
    readFile: async () => { throw new Error('/root/private/SECRET.token EACCES') },
    mediaExec,
  })
  ok('★ 异常只回固定文案，不吐 error.message / 绝对路径',
    await (async () => {
      const r = await throwing.execute({ source: 'a.png', format: 'webp' })
      return r.ok === false && !r.reason.includes('SECRET') && !r.reason.includes('/root/')
    })())
}

console.log('=== 6. 执行器：探测如实、enabled 关闭、argv 替换 ===')
{
  let versionCalls = 0
  const fakeRun = async (cmd, args) => {
    if (args && args[0] === '-version') { versionCalls += 1; return { stdout: 'ffmpeg version n/a' } }
    return { stdout: '' }
  }
  const exec = createMediaExec({ run: fakeRun, now: () => 1000, log: () => {} })
  ok('探测到 ffmpeg → available:true + source',
    await (async () => { const p = await exec.probe(); return p.available === true && p.source === 'PATH' })())
  // 一次 probe 会各探测 ffmpeg 与 ffprobe 两条 -version（共 2 次），之后命中缓存不再增加。
  ok('探测结果有 10 分钟缓存（不重复起探测）',
    await (async () => { const before = versionCalls; await exec.probe(); await exec.probe(); return versionCalls === before })())
  ok('真执行把 command[0] 换成探测到的 ffmpeg，且只传 argv 数组',
    await (async () => {
      const r = await exec.runCommand(['ffmpeg', '-i', 'a.png', '-y', 'o.webp'])
      return r.ok === true && Array.isArray(r.command) && r.command[0] === 'ffmpeg'
    })())
  const noFfmpeg = createMediaExec({ run: async () => { throw new Error('not found') }, now: () => 2000 })
  ok('★ 探测不到 ffmpeg → 明确降级、只回参数预览',
    await (async () => {
      const r = await noFfmpeg.runCommand(['ffmpeg', '-i', 'a.png', '-y', 'o.webp'])
      return r.ok === false && r.probed === true && /未探测到/.test(r.reason) && r.command.length === 5
    })())
  const disabled = createMediaExec({ enabled: false, run: fakeRun, now: () => 3000 })
  ok('enabled:false 不执行', await (async () => (await disabled.runCommand(['ffmpeg', '-i', 'a'])).ok === false)())
  ok('非法 command 直接拒绝',
    await (async () => (await exec.runCommand(null)).ok === false && (await exec.runCommand(['ffmpeg'])).ok === false)())
}

console.log('=== 7. 端点：围栏 / 能力如实 / 预设读写 ===')
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
  const invoke = async (over, req, which, bodyOver = null) => {
    const deps = makeDeps(over)
    if (bodyOver !== null) deps.readJsonBody = async () => bodyOver
    const route = mediaRouteTable(deps).find((r) => r.path === which)
    await route.handler(req, {})
    return deps.sent
  }
  const table = mediaRouteTable(makeDeps())
  ok('mediaRouteTable 返回 2 条 {path,method,handler}',
    table.length === 2 && table.every((r) => typeof r.path === 'string' && typeof r.handler === 'function'))
  ok('路径与 method 正确',
    table.some((r) => r.path === MEDIA_CONVERT_PATH && r.method === 'POST')
    && table.some((r) => r.path === MEDIA_FORMATS_PATH && r.method === 'GET, POST'))
  ok('★ 两条新端点都登记进 INTEGRATION_ROUTES',
    [MEDIA_CONVERT_PATH, MEDIA_FORMATS_PATH].every((p) => INTEGRATION_ROUTES.some((r) => r.path === p)))

  let s = await invoke({}, { method: 'POST', local: false }, MEDIA_CONVERT_PATH)
  ok('POST 非本机 → 403 + 固定文案', s[0].status === 403 && s[0].body.reason === 'local requests only')
  s = await invoke({}, { method: 'GET' }, MEDIA_CONVERT_PATH)
  ok('POST 端点收到 GET → 405', s[0].status === 405 && s[0].body.reason === 'POST only')
  let guarded = 0
  s = await invoke({ guardWriteRequest: () => { guarded += 1; return true } }, { method: 'POST' }, MEDIA_CONVERT_PATH)
  ok('POST 走 guardWriteRequest 围栏', guarded === 1)
  ok('POST 正常 → 9 字段结果', Object.keys(s[0].body).sort().join(',') === FIELDS_SORTED)
  s = await invoke({ readJsonBody: async () => { throw new Error('/home/user/SECRET EACCES') } }, { method: 'POST' }, MEDIA_CONVERT_PATH)
  ok('POST 读体抛错 → 500 + 固定文案（不吐路径）',
    s[0].status === 500 && s[0].body.reason === '媒体格式转换暂不可用（详见插件日志）'
    && !JSON.stringify(s[0]).includes('SECRET'))
  s = await invoke({ mediaTool: { execute: async () => { throw new Error('/abs/secret/boom') } } }, { method: 'POST' }, MEDIA_CONVERT_PATH)
  ok('POST 工具抛错 → 500 + 固定文案',
    s[0].status === 500 && !JSON.stringify(s[0]).includes('secret'))

  s = await invoke({}, { method: 'GET' }, MEDIA_FORMATS_PATH)
  ok('GET 未注入执行器 → capability.ffmpeg:undetected / probed:false / canExecute:false',
    s[0].body.capability.ffmpeg === 'undetected' && s[0].body.capability.probed === false
    && s[0].body.capability.canExecute === false)
  ok('GET 返回 11 种格式与三组清单',
    s[0].body.available_formats.length === 11 && s[0].body.groups.length === 3)
  ok('GET 如实带 caveat（编码器未验证）', typeof s[0].body.caveat === 'string' && s[0].body.caveat.includes('未探测到'))
  const execOk = {
    enabled: true, probe: async () => ({ available: true, ffmpeg: 'ffmpeg', source: 'PATH' }),
    runCommand: async () => ({ ok: true }),
  }
  s = await invoke({ mediaExec: execOk }, { method: 'GET' }, MEDIA_FORMATS_PATH)
  ok('GET 探测到 ffmpeg → capability.available + canExecute:true',
    s[0].body.capability.ffmpeg === 'available' && s[0].body.capability.canExecute === true)
  s = await invoke({ mediaExec: { probe: async () => ({ available: false }) } }, { method: 'GET' }, MEDIA_FORMATS_PATH)
  ok('GET 探测到不可用 → unavailable（不假装可用）',
    s[0].body.capability.ffmpeg === 'unavailable' && s[0].body.capability.canExecute === false)

  const prefs = createFormatPrefs()
  s = await invoke({ formatPrefs: prefs }, { method: 'POST' }, MEDIA_FORMATS_PATH, { kind: 'image', format: 'webp' })
  ok('POST 设置 image→webp 预设成功', s[0].body.ok === true && s[0].body.presets.image === 'webp')
  s = await invoke({ formatPrefs: prefs }, { method: 'GET' }, MEDIA_FORMATS_PATH)
  ok('GET 回显刚设的预设（同一实例）', s[0].body.output_format_presets.image === 'webp')
  s = await invoke({ formatPrefs: prefs }, { method: 'POST' }, MEDIA_FORMATS_PATH, { kind: 'image', format: 'mp4' })
  ok('POST 跨类预设 → 400 明确拒绝并点名类别',
    s[0].status === 400 && s[0].body.reason.includes('不能设为') && s[0].body.reason.includes('video'))
  s = await invoke({ formatPrefs: prefs }, { method: 'POST' }, MEDIA_FORMATS_PATH, { kind: 'bogus', format: 'png' })
  ok('POST 非法 kind → 400', s[0].status === 400)
  s = await invoke({ formatPrefs: prefs }, { method: 'POST' }, MEDIA_FORMATS_PATH, { kind: 'image', clear: true })
  ok('POST clear:true 清除预设', s[0].body.cleared === true && !('image' in s[0].body.presets))
  s = await invoke({}, { method: 'POST' }, MEDIA_FORMATS_PATH, { kind: 'image', format: 'png' })
  ok('POST 未启用预设 → 503（不假装设置成功）', s[0].status === 503)
  s = await invoke({ mediaExec: { probe: async () => { throw new Error('/home/secret') } } }, { method: 'GET' }, MEDIA_FORMATS_PATH)
  ok('能力探测抛错 → 500 + 固定文案（不吐路径）',
    s[0].status === 500 && !JSON.stringify(s[0]).includes('secret'))
  s = await invoke({}, { method: 'PUT' }, MEDIA_FORMATS_PATH)
  ok('formats 端点收到 PUT → 405', s[0].status === 405)
  s = await invoke({}, { method: 'GET', local: false }, MEDIA_FORMATS_PATH)
  ok('formats 非本机 → 403', s[0].status === 403)
}

console.log('=== 8. 生成物自动后转码：组合钩子不覆盖日志、fire-and-forget、诚实降级 ===')
{
  const prefs = createFormatPrefs({ image: 'webp', video: 'mkv', audio: 'flac' })
  const plan = planPostConvert({ file_path: 'picture.png', kind: 'image' }, { prefs, outputDir: OUT })
  ok('有预设且格式不同 → 生成转换计划', plan.skip === false && plan.format === 'webp'
    && plan.out.endsWith('picture_converted.webp') && plan.command[0] === 'ffmpeg')
  ok('★ 原产物保留（输出名带 _converted，不覆盖）',
    plan.out !== plan.source && plan.out.includes('_converted'))
  ok('已是目标格式 → 跳过，避免无意义自转换',
    planPostConvert({ file_path: 'a.webp', kind: 'image' }, { prefs, outputDir: OUT }).skip === true)
  ok('无预设 → 零 I/O 跳过（不改变既有行为）',
    planPostConvert({ file_path: 'a.png', kind: 'image' }, { prefs: createFormatPrefs(), outputDir: OUT }).reason.includes('预设'))
  ok('类别与格式不匹配 → 跳过',
    planPostConvert({ file_path: 'a.mp4', kind: 'video' }, { prefs: createFormatPrefs({ video: 'mp3' }), outputDir: OUT }).skip === true)
  ok('单次 entry.output_format 优先于预设',
    planPostConvert({ file_path: 'a.png', kind: 'image', output_format: 'jpg' }, { prefs, outputDir: OUT }).format === 'jpg')
  ok('entry.extra.output_format 也生效',
    planPostConvert({ file_path: 'a.mp3', kind: 'audio', extra: { output_format: 'wav' } }, { prefs, outputDir: OUT }).format === 'wav')
  ok('无产物路径 → 跳过', planPostConvert({}, { prefs, outputDir: OUT }).skip === true)
  ok('other 类别 → 跳过',
    planPostConvert({ file_path: 'a.bin', kind: 'other' }, { prefs, outputDir: OUT }).skip === true)
  ok('围栏外产物 → 跳过（不把任意本机路径喂给 ffmpeg）',
    planPostConvert({ file_path: path.resolve(ROOT, '..', 'x.png'), kind: 'image' }, { prefs, outputDir: OUT }).skip === true)

  let logCalls = 0
  let convertCalls = 0
  const composed = composeGenerationHook(() => { logCalls += 1 }, async () => { convertCalls += 1 })
  composed({ file_path: 'a.png' })
  ok('★ 组合钩子不覆盖既有日志消费者', logCalls === 1)
  ok('★ 后转码 fire-and-forget（同步调用不 await）',
    composed.__dshqpMediaPostConvert === true && typeof composed === 'function')
  ok('原消费者抛错不影响后转码',
    (() => {
      let n = 0
      const c = composeGenerationHook(() => { throw new Error('boom') }, async () => { n += 1 })
      c({})
      return n === 1
    })())

  const events = []
  const eventLog = { append: (e) => { events.push(e); return { ok: true } } }
  const okExec = { probe: async () => ({ available: true }), runCommand: async () => ({ ok: true, reason: '已生成' }) }
  ok('真执行 → ok:true 且写一条脱敏 format_autoconvert 事件',
    await (async () => {
      const r = await runPostConvert(plan, { mediaExec: okExec, eventLog, log: () => {} })
      return r.ok === true && events.length === 1 && events[0].event === 'format_autoconvert'
        && events[0].degraded === false
    })())
  ok('★ 事件里没有文件路径 / prompt 全文',
    !JSON.stringify(events).includes('picture.png') && !JSON.stringify(events).includes('outputDir'))
  const noExec = await runPostConvert(plan, { mediaExec: null, eventLog, log: () => {} })
  ok('★ 无执行器 → 如实降级、原产物保留', noExec.ok === false && noExec.degraded === true)
  const noFfmpeg = await runPostConvert(plan, {
    mediaExec: { probe: async () => ({ available: false }), runCommand: async () => ({ ok: true }) },
    eventLog, log: () => {},
  })
  ok('★ 探测不到 ffmpeg → 如实降级，不假装转换', noFfmpeg.ok === false && /未探测到/.test(noFfmpeg.reason))
  const failExec = await runPostConvert(plan, {
    mediaExec: { probe: async () => ({ available: true }), runCommand: async () => ({ ok: false, reason: 'ffmpeg 执行失败' }) },
    eventLog, log: () => {},
  })
  ok('★ 转换失败 → degraded:true + 降级事件',
    failExec.degraded === true && events.some((e) => e.degraded === true))
  ok('异常路径也永远 resolve、不抛',
    await (async () => {
      const r = await runPostConvert(plan, {
        mediaExec: { probe: async () => { throw new Error('x') }, runCommand: async () => ({ ok: true }) },
        log: () => {},
      })
      return r.ok === false && r.degraded === true
    })())

  // 组合钩子真实挂到 history-store 的单实例上，再还原，避免污染其它套件。
  const savedHook = getGenerationLogHook()
  try {
    setGenerationLogHook(() => { logCalls += 1 })
    ok('attachGenerationPostConvert 挂上后钩子仍是函数',
      attachGenerationPostConvert({ prefs, outputDir: OUT, mediaExec: okExec, eventLog, log: () => {} }) === true
      && typeof getGenerationLogHook() === 'function')
    ok('重复 attach 不叠加多层（标记幂等）', (() => {
      const before = getGenerationLogHook()
      attachGenerationPostConvert({ prefs, outputDir: OUT, mediaExec: okExec })
      return getGenerationLogHook() === before
    })())
  } finally {
    setGenerationLogHook(savedHook)
  }
  ok('无原始钩子时返回 false（绝不擅自造钩子覆盖日志）',
    (() => {
      const saved = getGenerationLogHook()
      setGenerationLogHook(null)
      const r = attachGenerationPostConvert({})
      setGenerationLogHook(saved)
      return r === false
    })())
}

console.log('=== 9. ★ 全链路联动（单个功能完成 ≠ 最终完成） ===')
{
  const extras = createExtras({
    outputDir: OUT, log: () => {},
    isLocalRequest: () => true, respondJson: () => {}, readJsonBody: async () => ({}),
    mediaExec: { enabled: true, probe: async () => ({ available: true }), runCommand: async () => ({ ok: true }) },
  })
  ok('★ createExtras 真的注册了 convert_media 工具',
    extras.names.includes('convert_media') && extras.tools.some((t) => t.name === 'convert_media'))
  ok('★ EXTRA_TOOL_NAMES 含 convert_media', EXTRA_TOOL_NAMES.includes('convert_media'))
  ok('★ createExtras 真的挂了 /media/convert 与 /media/formats 两个端点',
    [MEDIA_CONVERT_PATH, MEDIA_FORMATS_PATH].every((p) => extras.routes.some((r) => r.path === p)))
  ok('★ createExtras 暴露 mediaExec / formatPrefs（端点与后转码共享同一实例）',
    Boolean(extras.mediaExec) && Boolean(extras.formatPrefs))
  ok('★ TOOL_SUMMARIES 有 convert_media（工具自述不漏）',
    typeof TOOL_SUMMARIES.convert_media === 'string' && TOOL_SUMMARIES.convert_media.includes('格式转换'))
  ok('★ TOOL_HINTS 有 convert_media 的 when/params/fallback（Agent 能直接用）',
    Boolean(TOOL_HINTS.convert_media) && TOOL_HINTS.convert_media.when && TOOL_HINTS.convert_media.params
    && TOOL_HINTS.convert_media.fallback.includes('ffmpeg'))
  ok('★ Agent playbook 有 format_output 编排',
    AGENT_PLAYBOOKS.some((p) => p.id === 'format_output' && p.steps.includes('convert_media')))
  ok('★ buildAgentGuide 对全部注册工具都没有 undocumented（新工具已写提示）',
    buildAgentGuide({ tools: EXTRA_TOOL_NAMES, routes: INTEGRATION_ROUTES }).undocumented.length === 0)
  ok('★ /agent-guide 的端点目录含两条新端点',
    buildAgentGuide({ tools: extras.names, routes: INTEGRATION_ROUTES }).endpoints
      .some((p) => p === MEDIA_CONVERT_PATH))
  const tr = read('lib/tool-registry.js')
  ok('★ 注册层真实 import 5 个新模块',
    ['media-formats.js', 'media-exec.js', 'media-convert-tool.js', 'media-convert-endpoints.js', 'media-postconvert.js']
      .every((f) => tr.includes(f)))
  ok('★ 注册层真的调用了 attachGenerationPostConvert（不是孤儿）',
    tr.includes('attachGenerationPostConvert({'))
  ok('★ index.js 零改动（体积贴线，接线全在外置层）',
    !read('lib/index.js').includes('media-convert-tool')
    && !read('lib/index.js').includes('convert_media'))
  const lab = read('assets/lab.js')
  // 只判真实代码特征：文件头注释里会提到旧形态 `.dshqp-lab-fab`，不能拿注释当实现。
  // 真实独立浮层会调 el() 造 fab/mask 并挂 body；这里必须只有 mountInto 插槽形态。
  ok('★ 内嵌功能区有格式转换 section，且不是独立实验室浮层',
    lab.includes('媒体格式转换') && lab.includes('mountInto')
    && !lab.includes("el('div', 'dshqp-lab-fab'") && !lab.includes('document.body.appendChild'))
  ok('★ 内嵌 UI 消费 media/formats 与 media/convert',
    lab.includes("request('media/formats'") && lab.includes("request('media/convert'"))
  ok('★ 端点目录两条都有 method / access / desc',
    [MEDIA_CONVERT_PATH, MEDIA_FORMATS_PATH].every((p) => {
      const r = INTEGRATION_ROUTES.find((x) => x.path === p)
      return r && r.method && r.access === 'local' && r.desc
    }))
  ok('★ selftest 的 EXPECTED_TOOLS 显式登记 convert_media',
    read('scripts/selftest.mjs').includes("'convert_media'"))
  ok('★ SUITES 登记了本专项（不在回归清单里 = 没写测试）',
    read('scripts/test-all.mjs').includes("'test-media-convert.mjs'"))
  ok('★ 两套孤儿扫描都把新模块列入 NEW_MODULES',
    ['test-accel-chain.mjs', 'test-capability-audit.mjs'].every((f) => read('scripts/' + f).includes("'media-postconvert'")))
  ok('★ test-gif.mjs 的端点白名单显式登记两条新入口',
    read('scripts/test-gif.mjs').includes("'media/formats'") && read('scripts/test-gif.mjs').includes("'media/convert'"))
  ok('★ 5 个新模块不含本机绝对路径 / 凭据',
    !['C:/Users/Administrator', 'K:/ai/', 'gho_', 'github_pat_', 'npm_']
      .some((x) => ['media-formats.js', 'media-exec.js', 'media-convert-tool.js',
        'media-convert-endpoints.js', 'media-postconvert.js'].some((f) => read('lib/' + f).includes(x))))
}

console.log('=== test-media-convert：' + pass + ' 项通过，' + fail + ' 项失败 ===')
if (fail > 0) { console.log(fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1) }
