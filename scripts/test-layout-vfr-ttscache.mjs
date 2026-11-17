#!/usr/bin/env node
/**
 * test-layout-vfr-ttscache.mjs —— 三件新功能的离线回归（2026-11-17）
 *
 *   ① 纯 JS flex 子集布局器（layout-lite）：字符宽度估算 / 换行 / 四类版式 / 围栏 / 光栅降级；
 *   ② compose_video 的 VFR 帧模式：不补帧 + setpts 归零，默认 CFR 行为零变化；
 *   ③ TTS 旁白内容缓存：指纹稳定性 / 往返 / 坏文件不命中 / 命中不探活。
 *
 * ok() 采用 (name, cond, extra) 风格；全程离线：假 fs 桩 + 假执行器，零真实 ffmpeg / ComfyUI。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAYOUT_KINDS, charWidthEm, measureTextEm, wrapText, layoutPage, renderLayoutSvg, makeLayoutFrameTool,
} from '../lib/layout-lite.js'
import { buildComposeCommand, buildConcatList, makeComposeVideoTool } from '../lib/animation-kit.js'
import {
  narrationCacheKey, readNarrationCache, writeNarrationCache, makeSpeechRunner,
} from '../lib/speech-tool.js'
import { EXTRA_TOOL_NAMES } from '../lib/tool-registry.js'
import { TOOL_HINTS } from '../lib/agent-guide.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUTDIR = path.join(os.tmpdir(), 'dshqp-layout-out')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) } else { fail++; console.log('  FAIL', name, extra ?? '') }
}
const section = (t) => console.log('\n=== ' + t + ' ===')

section('① 布局器：字符宽度估算 + 换行')
{
  ok('四类版式常量', LAYOUT_KINDS.length === 4 && LAYOUT_KINDS.includes('title')
    && LAYOUT_KINDS.includes('bullets') && LAYOUT_KINDS.includes('split') && LAYOUT_KINDS.includes('compare'))
  ok('CJK 记 1em', charWidthEm('中') === 1 && charWidthEm('，') === 1)
  ok('ASCII 记 0.55em', Math.abs(charWidthEm('a') - 0.55) < 1e-9)
  ok('measureTextEm 累加（中文ab = 2 + 1.1）', Math.abs(measureTextEm('中文ab') - 3.1) < 1e-9)

  const lines = wrapText('这是一段需要换行的中文文本，用来验证按宽度断行', 120, 20)
  const widths = lines.map((l) => measureTextEm(l) * 20)
  ok('换行后每行不超宽（容差 1 字符）', widths.every((w) => w <= 120 + 20), JSON.stringify(widths))
  ok('换行不丢字', lines.join('') === '这是一段需要换行的中文文本，用来验证按宽度断行')
  ok('显式 \\n 强制断行', wrapText('第一行\n第二行', 999, 20).length === 2)
  ok('空文本仍给一行空串（不炸）', wrapText('', 100, 20).length === 1)
}

section('② 布局器：四类版式几何')
{
  const t = layoutPage({ kind: 'title', title: '把复杂问题讲清楚', subtitle: '三步拆解法' })
  ok('title ok 且有图元', t.ok === true && t.boxes.length >= 3)
  ok('title 用居中锚点', t.boxes.some((b) => b.kind === 'text' && b.anchor === 'middle'))
  ok('title 输出完整 SVG', t.svg.startsWith('<svg ') && t.svg.includes('</svg>') && t.svg.includes('width="960"'))
  ok('title 无告警', t.warnings.length === 0)

  const b = layoutPage({ kind: 'bullets', title: '三个要点', items: ['先拆分', '再对齐', '最后合并'] })
  const circles = b.boxes.filter((x) => x.kind === 'circle')
  const texts = b.boxes.filter((x) => x.kind === 'text')
  ok('bullets 每个要点一个圆点', circles.length === 3)
  ok('bullets 标题 + 三条文本', texts.length === 4)
  ok('bullets 文本起点在圆点右侧', texts.slice(1).every((x) => x.x > circles[0].x + circles[0].r))
  ok('bullets 无告警', b.warnings.length === 0)

  const many = layoutPage({ kind: 'bullets', title: '塞满', items: Array.from({ length: 14 }, (_, i) => '第' + (i + 1) + '条要点内容足够长需要换行处理') })
  ok('bullets 内容过高时给明确告警（不静默丢字）', many.warnings.some((w) => w.includes('超出')))
  const emptyItems = layoutPage({ kind: 'bullets', title: '空', items: [] })
  ok('bullets items 为空时给告警', emptyItems.warnings.some((w) => w.includes('items 为空')))

  const sp = layoutPage({ kind: 'split', title: '分栏讲', body: '左边是讲解文字，右边是图片位置。', ratio: 0.55 })
  const panel = sp.boxes.filter((x) => x.kind === 'rect').pop()
  const bodyText = sp.boxes.filter((x) => x.kind === 'text')[1]
  ok('split 右栏是面板矩形', !!panel && panel.w > 0 && panel.h > 0)
  ok('split 左右不重叠（正文右缘 ≤ 面板左缘）', bodyText.x + measureTextEm(bodyText.lines[0]) * bodyText.size <= panel.x + 1)
  const wide = layoutPage({ kind: 'split', title: 'x', body: 'y', ratio: 0.95 })
  ok('split ratio 被夹到 0.7 以内（不把右栏挤没）', wide.ok === true && wide.boxes.filter((x) => x.kind === 'rect').pop().w > 0)

  const cp = layoutPage({ kind: 'compare', title: 'A 还是 B', columns: [
    { header: '方案 A', items: ['快'] }, { header: '方案 B', items: ['稳'] }] })
  ok('compare 两栏面板', cp.boxes.filter((x) => x.kind === 'rect').length === 2)
  ok('compare 两栏不重叠', (() => {
    const rs = cp.boxes.filter((x) => x.kind === 'rect')
    return rs[0].x + rs[0].w <= rs[1].x
  })())
  const oneCol = layoutPage({ kind: 'compare', title: 'x', columns: [{ header: 'only', items: ['a'] }] })
  ok('compare 少于一栏给告警', oneCol.warnings.some((w) => w.includes('columns')))

  ok('未知版式明确拒绝', layoutPage({ kind: 'nope' }).ok === false)
  ok('width 被夹到下限 320', layoutPage({ kind: 'title', title: 'x', width: 100 }).width === 320)
  const esc = layoutPage({ kind: 'title', title: '<b>&"' })
  ok('文本做了 XML 转义', esc.svg.includes('&lt;b&gt;') && esc.svg.includes('&amp;') && !esc.svg.includes('<b>'))
  ok('renderLayoutSvg 可直接调用', renderLayoutSvg([], 320, 180).startsWith('<svg '))
}

section('③ 布局工具：落盘围栏 + 光栅降级 + 生产接线')
{
  const tool = makeLayoutFrameTool({})
  ok('工具名 layout_frame', tool.name === 'layout_frame')
  ok('参数必填 kind 且 additionalProperties:false',
    tool.parameters.required.includes('kind') && tool.parameters.additionalProperties === false)

  const noDir = await tool.execute({ kind: 'title', title: 'x', target: 'a.svg' })
  ok('无输出目录时明确拒绝落盘（不假装写了）', noDir.ok === false && noDir.reason.includes('不能落盘'))

  const probe = makeLayoutFrameTool({ outputDir: OUTDIR })
  ok('target 含 .. 被拒', (await probe.execute({ kind: 'title', title: 'x', target: '../evil.svg' })).ok === false)
  ok('target 绝对盘符被拒', (await probe.execute({ kind: 'title', title: 'x', target: 'C:/evil.svg' })).ok === false)

  const writes = []
  const withIo = makeLayoutFrameTool({
    outputDir: OUTDIR, writeFile: async (p, s) => { writes.push([p, s.length]) },
    rasterBackend: async () => ({ ok: true, backend: 'resvg', path: OUTDIR + '/a.png' }),
  })
  const w = await withIo.execute({ kind: 'title', title: '落盘', target: 'a.svg' })
  ok('落盘走 writeFile 且路径在目录内', w.ok === true && writes.length === 1 && w.path === path.resolve(OUTDIR, 'a.svg'))
  ok('光栅成功回传 backend:path', w.raster === 'resvg:' + OUTDIR + '/a.png')

  const rasterFail = makeLayoutFrameTool({
    outputDir: OUTDIR, writeFile: async () => {},
    rasterBackend: async () => ({ ok: false, reason: '未探测到 resvg' }),
  })
  const rf = await rasterFail.execute({ kind: 'title', title: 'x', target: 'b.svg' })
  ok('光栅失败仍 ok:true 且保留 SVG（不谎称已光栅）', rf.ok === true && rf.raster === '' && rf.svg.includes('<svg'))

  const noWrite = makeLayoutFrameTool({ outputDir: OUTDIR })
  const nw = await noWrite.execute({ kind: 'title', title: 'x', target: 'c.svg' })
  ok('未注入 writeFile 时明说未落盘', nw.ok === false && nw.reason.includes('未落盘'))

  const reg = fs.readFileSync(path.join(ROOT, 'lib/tool-registry.js'), 'utf8')
  ok('★ 生产接线：tool-registry 注册 layout_frame', /makeLayoutFrameTool\(animDeps\)/u.test(reg))
  ok('★ EXTRA_TOOL_NAMES 含 layout_frame', EXTRA_TOOL_NAMES.includes('layout_frame'))
  ok('★ agent-guide 有 layout_frame 提示（无 undocumented）', !!TOOL_HINTS.layout_frame && TOOL_HINTS.layout_frame.when.length > 6)
}

section('④ VFR / PTS')
{
  const base = { frames: ['a.png', 'b.png', 'c.png'], out: 'o.mp4', fps: 24 }
  const cfr = buildComposeCommand(base)
  ok('默认仍 CFR：带 -r 24', cfr.includes('-r') && cfr[cfr.indexOf('-r') + 1] === '24')
  ok('默认不含 -fps_mode（旧调用零变化）', !cfr.includes('-fps_mode'))
  ok('默认 filter 不含 setpts', !cfr.join(' ').includes('setpts'))

  const noList = buildComposeCommand({ ...base, fpsMode: 'vfr' })
  ok('vfr 无清单时老实退回 CFR（不假装 VFR）', noList.includes('-r') && !noList.includes('-fps_mode'))
  const vfr = buildComposeCommand({ ...base, fpsMode: 'vfr', concatList: 'list.txt' })
  ok('vfr 走 concat 分离器（精确 duration）', vfr.includes('-f') && vfr[vfr.indexOf('-f') + 1] === 'concat' && vfr.includes('list.txt'))
  ok('vfr 带 -fps_mode vfr', vfr.includes('-fps_mode') && vfr[vfr.indexOf('-fps_mode') + 1] === 'vfr')
  ok('vfr 不再给 -r（不补帧回恒定帧率）', !vfr.includes('-r'))
  const listText = buildConcatList({ frames: ['a.png', 'b.png'], repeats: [3, 1], fps: 12 })
  ok('清单按 repeat/fps 写 duration', listText.includes('duration 0.2500') && listText.includes('duration 0.0833'))
  ok('清单末帧再列一次（兑现最后一段时长）', listText.trim().split('\n').pop() === "file 'b.png'")
  ok('清单路径做了单引号转义', buildConcatList({ frames: ["a'b.png"], repeats: [1], fps: 12 }).includes("a'\\''b.png"))

  const rep = buildComposeCommand({ ...base, repeats: [3, 1, 2] })
  const ts = (cmd) => cmd.reduce((acc, x, i) => (x === '-t' ? [...acc, Number(cmd[i + 1])] : acc), [])
  const cfrTs = ts(rep)
  ok('CFR 各段时长仍由 repeat/fps 决定', cfrTs.length === 3 && Math.abs(cfrTs[0] - 0.125) < 1e-6
    && Math.abs(cfrTs[1] - 1 / 24) < 1e-6 && Math.abs(cfrTs[2] - 2 / 24) < 1e-6, JSON.stringify(cfrTs))
  ok('VFR 清单与 CFR 段时长同源（同一 rep 计算）', (() => {
    const t = buildConcatList({ frames: base.frames, repeats: [3, 1, 2], fps: 24 })
    return t.includes('duration 0.1250') && t.includes('duration 0.0417') && t.includes('duration 0.0833')
  })())

  const tool = makeComposeVideoTool({ outputDir: OUTDIR })
  ok('compose_video 暴露 fpsMode 枚举', JSON.stringify(tool.parameters.properties.fpsMode.enum) === '["cfr","vfr"]')
  const run = await tool.execute({ frames: ['a.png', 'b.png'], target: 'o.mp4', fpsMode: 'vfr' })
  ok('工具默认离线降级但仍回 argv', run.ok === false && Array.isArray(run.command))
  ok('无 writeFile 时 vfr 如实退回 CFR（不假装）', run.fpsMode === 'cfr' && run.reason.includes('退回 CFR'))

  const lists = []
  const tool2 = makeComposeVideoTool({ outputDir: OUTDIR, writeFile: async (p, s) => { lists.push([p, s]) } })
  const run2 = await tool2.execute({ frames: ['a.png', 'b.png'], target: 'o.mp4', fpsMode: 'vfr' })
  ok('有 writeFile 时先写 concat 清单', lists.length === 1 && lists[0][0].endsWith('.concat.txt') && lists[0][1].includes('duration'))
  ok('随后 argv 走 VFR 且回传 fpsMode=vfr', run2.fpsMode === 'vfr' && run2.command.includes('-fps_mode'))
  ok('降级文案说明帧模式', run2.reason.includes('VFR'))
}

section('⑤ TTS 旁白内容缓存')
{
  const k1 = await narrationCacheKey({ text: '你好世界', seed: 0, backend: 'qwen3' })
  const k2 = await narrationCacheKey({ text: '你好世界', seed: 0, backend: 'qwen3' })
  ok('同参指纹稳定', k1 === k2 && k1.length === 24)
  ok('文本变则指纹变', k1 !== await narrationCacheKey({ text: '你好世界!', seed: 0, backend: 'qwen3' }))
  ok('seed 变则指纹变', k1 !== await narrationCacheKey({ text: '你好世界', seed: 1, backend: 'qwen3' }))
  ok('后端变则指纹变', k1 !== await narrationCacheKey({ text: '你好世界', seed: 0, backend: 'gpt-sovits' }))

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-tts-'))
  const src = path.join(tmp, 'src.mp3')
  await fsp.writeFile(src, Buffer.from('FAKE-AUDIO'))
  const key = await narrationCacheKey({ text: '缓存往返' })
  const wrote = await writeNarrationCache({ key, out: { path: src, format: 'mp3', tier: 'qwen3-tts' }, outputDir: tmp })
  ok('写入缓存成功', wrote === true)
  const hit = await readNarrationCache({ key, outputDir: tmp })
  ok('读回命中且带 cached 语义字段', !!hit && hit.format === 'mp3' && hit.tier === 'qwen3-tts' && hit.seconds === 0)
  ok('缓存产物字节与源一致', (await fsp.readFile(hit.path)).toString() === 'FAKE-AUDIO')
  ok('无 key / 无目录时安全返 null', (await readNarrationCache({})) === null)

  const tampered = path.join(tmp, '.dshqp-tts-cache', key + '.mp3')
  await fsp.appendFile(tampered, Buffer.from('X'))
  ok('产物被篡改（字节数不符）不命中', (await readNarrationCache({ key, outputDir: tmp })) === null)
  await fsp.rm(tampered)
  ok('产物被删不命中', (await readNarrationCache({ key, outputDir: tmp })) === null)
  await fsp.writeFile(path.join(tmp, '.dshqp-tts-cache', key + '.json'), '{not json')
  ok('元数据损坏不命中（不抛）', (await readNarrationCache({ key, outputDir: tmp })) === null)

  // 命中路径：预置缓存后，ensureComfyUp 不应被调用
  const tmp2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshqp-tts2-'))
  const cfg = { outputDir: tmp2, filePrefix: 'p', comfyUrl: 'http://127.0.0.1:1', pollIntervalMs: 1 }
  let ensured = 0
  const seedFile = path.join(tmp2, 'n.mp3')
  await fsp.writeFile(seedFile, Buffer.from('NARRATION'))
  const ckey = await narrationCacheKey({ text: '缓存命中不探活' })
  await writeNarrationCache({ key: ckey, out: { path: seedFile, format: 'mp3', tier: 'qwen3-tts' }, outputDir: tmp2 })
  const reachable = makeSpeechRunner({
    cfg, log: () => {}, ensureComfyUp: async () => { ensured += 1 },
    loadObjectInfoFor: async () => ({}), catalogForTts: () => ({ nodes: {} }),
    submitPrompt: async () => { throw new Error('不该提交') },
    fetchOutputBytes: async () => Buffer.alloc(0), fetchWithTimeout: async () => ({ ok: false }),
    cancelReason: () => new Error('cancel'), safeStem: (s) => String(s).slice(0, 8),
    uniquePath: async (dir, name) => path.join(dir, name),
  })
  const cached = await reachable({ text: '缓存命中不探活' })
  ok('★ 命中缓存时零探活零提交', ensured === 0 && cached.cached === true && cached.seconds === 0)
  ok('命中回的是缓存目录里的文件', cached.path.includes('.dshqp-tts-cache'))

  // 未命中路径：走完整假链 → 写缓存 → 第二次命中
  const state = { pid: 'pid-1', loaded: 0 }
  const deps = {
    cfg, log: () => {}, ensureComfyUp: async () => { ensured += 1 },
    loadObjectInfoFor: async () => { state.loaded += 1; return {} },
    catalogForTts: () => ({ nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } }),
    submitPrompt: async () => state.pid,
    fetchOutputBytes: async () => Buffer.from('REAL-AUDIO'),
    fetchWithTimeout: async () => ({
      ok: true,
      json: async () => ({ [state.pid]: { outputs: { 2: { audio: [{ filename: 'tts_1.mp3' }] } } } }),
    }),
    cancelReason: () => new Error('cancel'), safeStem: (s) => String(s).slice(0, 8),
    uniquePath: async (dir, name) => path.join(dir, name),
  }
  const runner = makeSpeechRunner(deps)
  const first = await runner({ text: '第一次合成', caps: { nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } } })
  ok('未命中时真跑（落盘真实字节）', first.cached === undefined && (await fsp.readFile(first.path)).toString() === 'REAL-AUDIO')
  const ensuredAfterFirst = ensured
  const second = await runner({ text: '第一次合成', caps: { nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } } })
  ok('★ 同参第二次命中缓存且不再探活', second.cached === true && ensured === ensuredAfterFirst)

  const offRunner = makeSpeechRunner({ ...deps, narrationCache: false })
  const off = await offRunner({ text: '第一次合成', caps: { nodes: { FB_Qwen3TTSCustomVoice: true, SaveAudioMP3: true } } })
  ok('narrationCache:false 可整体绕过缓存（验证真实链路的场景要用）', off.cached === undefined && ensured > ensuredAfterFirst)

  const srcText = fs.readFileSync(path.join(ROOT, 'lib/speech-tool.js'), 'utf8')
  ok('★ 缓存查询在 ensureComfyUp 之前', srcText.indexOf('readNarrationCache({ key: cacheKey') < srcText.indexOf('await ensureComfyUp(cfg, log, signal)'))
  ok('★ 三个创建点共用同一 runner（含缓存）', srcText.includes('export function makeSpeechRunner(deps)'))
  ok('源码里缓存写失败不影响返回', /writeNarrationCache\(\{ key: cacheKey, out, outputDir: cfg\.outputDir \}\)[\s\S]{0,40}return out/u.test(srcText))

  await fsp.rm(tmp, { recursive: true, force: true })
  await fsp.rm(tmp2, { recursive: true, force: true })
}

section('⑥ 体积红线')
{
  const files = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const total = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, 'lib', f)).size, 0)
  ok('lib 合计未爆 2 MB 红线', total <= 2097152, '实际 ' + total)
  ok('新模块在 lib 内且非空', ['layout-lite.js'].every((f) => fs.statSync(path.join(ROOT, 'lib', f)).size > 500))
}

console.log(`\n=== test-layout-vfr-ttscache：结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 项通过，${fail} 项失败） ===`)
process.exit(fail === 0 ? 0 : 1)
