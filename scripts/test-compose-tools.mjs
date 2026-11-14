/**
 * scripts/test-compose-tools.mjs —— 创作工具层（D19/D23/D24/D26/A2/A3）离线回归。
 *
 * 覆盖：
 *   · D19 字幕：脚本字幕能出 SRT/VTT；语音转写缺件时给「装什么」而不是假装可用
 *   · D23 参数可视化：每行都带来源（你指定/默认值/已对齐/链路固定/未填）
 *   · D24 入口别名：只能指向已注册工具；指错就是红
 *   · D26 懒加载盘点：ExecutionBlocker 不存在时如实说"做不到运行时跳过"
 *   · A2 视频后处理层：按依赖算可用/被挡，不把"生成时挂音轨"说成"给成片混流"
 *   · A3 预设绑定：预设不能套到别的链上
 *
 * ⚠ ok() 签名 (cond, name, extra)；写反当场抛。
 */
import {
  ASR_OPTIONS, subtitleCapability, splitScript, buildScriptCues, cuesToSrt, cuesToVtt, planSubtitles,
} from '../lib/subtitle-plan.js'
import { ORIGINS, applyAlign, describeParams } from '../lib/param-view.js'
import { LOADER_NODES, BLOCKER_NODE, auditLazyNodes } from '../lib/lazy-audit.js'
import { POST_STEPS, planPost } from '../lib/video-post.js'
import {
  PRESET_BINDINGS, presetsForManifest, applyPreset, checkPresetBindings,
} from '../lib/workflow-presets.js'
import {
  ENTRY_ALIASES, resolveAlias, aliasesOf, checkAliases,
} from '../lib/entry-alias.js'

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

/** 真实注册的工具名，与 scripts/selftest.mjs 的 EXPECTED_TOOLS 同源口径。 */
const TOOLS = [
  'batch_draw', 'check_acceleration', 'compose_prompt', 'draw_image', 'generate_hybrid',
  'generate_speech', 'generate_video', 'inpaint_image', 'list_available_models',
  'list_generated_images', 'outpaint_image', 'remove_image', 'upscale_image',
]

/* ============================================================ D19 ==== */
sec('D19 字幕：能力三态')

eq(ASR_OPTIONS.length, 3, '缺件清单给 3 条可选路径')
for (const o of ASR_OPTIONS) {
  ok(typeof o.install === 'string' && o.install.length > 0, `方案 ${o.id} 有 install 指令`)
  ok(typeof o.verify === 'string' && o.verify.length > 0, `方案 ${o.id} 有 verify 指令`)
}

const capNone = subtitleCapability({ nodes: [] })
eq(capNone.available, false, '★ 空节点清单 → available:false（明确不支持）')
ok(capNone.reason.includes('0 个'), '原因里带上节点总数')
eq(capNone.options.length, 3, '不支持时把缺件清单一起给出去')

const capUnknown = subtitleCapability({})
eq(capUnknown.available, null, '★★ 没拿到清单 → available:null（「不知道」不等于「不支持」）')
ok(capUnknown.reason.includes('无法判断'), '未知时说「无法判断」')

const capYes = subtitleCapability({ nodes: ['KSampler', 'WhisperTranscribe'] })
eq(capYes.available, true, '节点名命中 whisper → 可用')
eq(capYes.node, 'WhisperTranscribe', '报出命中的节点名')
eq(capYes.options.length, 0, '可用时不再给缺件清单（不啰嗦）')

eq(subtitleCapability({ nodes: new Set(['FasterWhisper']) }).available, true, 'Set 形式也支持')
eq(subtitleCapability({ nodes: ['SubtitleOverlay'] }).available, true, 'subtitle 关键词也认')

/* ---------------------------------------------------- 切句与时间格式 ---- */
eq(splitScript('你好。世界！').length, 2, '按句号/感叹号切两句')
eq(splitScript('你好。世界！')[1], '世界！', '标点保留在句尾')
eq(splitScript('第一行\n第二行').length, 2, '换行也切')
eq(splitScript('   ').length, 0, '纯空白 → 空数组')
eq(splitScript('').length, 0, '空串 → 空数组')
eq(splitScript('abcdefghij', { maxChars: 4 }).length, 3, '超长句按 maxChars 折行（4/4/2）')
eq(splitScript('abcdefghij', { maxChars: 4 })[2], 'ij', '折行后末段是余下的字符')
eq(splitScript('短句。').length, 1, '短句不折')

const cues = buildScriptCues({ text: '你好。世界。', seconds: 4 })
eq(cues.ok, true, '两句 / 4 秒 → 成功')
eq(cues.cues.length, 2, '切出 2 条 cue')
eq(cues.cues[0].from, 0, '第一条从 0 开始')
eq(cues.cues[0].to, 2, '第一条到 2 秒')
eq(cues.cues[1].to, 4, '最后一条到 4 秒')
eq(cues.aligned, false, '★★ aligned:false —— 均分不等于对齐')
ok(cues.note.includes('未与真实语音对齐'), 'note 明说未与语音对齐')

ok(buildScriptCues({ text: '', seconds: 4 }).ok === false, '空文案失败')
ok(buildScriptCues({ text: '你好。', seconds: 0 }).ok === false, '没有总时长失败')
ok(buildScriptCues({ text: '你好。', seconds: 0 }).reason.includes('正数'), '失败原因说明要正数')

const srtOne = cuesToSrt([{ index: 1, from: 0, to: 2, text: '你好' }])
eq(srtOne, '1\n00:00:00,000 --> 00:00:02,000\n你好\n', 'SRT 单条格式逐字正确（含末尾换行）')
ok(srtOne.endsWith('\n'), 'SRT 末尾有换行（否则某些播放器吞最后一句）')
eq(cuesToSrt([]), '', '空 cue → 空串（不产出空文件）')
eq(cuesToSrt([{ from: 0, to: 2, text: '   ' }]), '', '空白文本的 cue 被跳过')
eq(cuesToSrt([{ from: 0, to: 0, text: 'a' }]), '1\n00:00:00,000 --> 00:00:01,000\na\n', 'to <= from 时兜底成 +1 秒')

const srtMany = cuesToSrt([{ from: 0, to: 1, text: 'a' }, { from: 1, to: 2, text: 'b' }])
ok(srtMany.startsWith('1\n'), '多条的序号从 1 开始')
ok(srtMany.includes('\n\n2\n'), '★ 条目之间空一行，序号连续')
eq(srtMany.split('-->').length - 1, 2, '两条时间码')

const hms = cuesToSrt([{ from: 3725.5, to: 3726, text: 'x' }])
ok(hms.includes('01:02:05,500'), '★ 超过 1 小时的时码正确（01:02:05,500）')

const vtt = cuesToVtt([{ from: 0, to: 2, text: '你好' }])
ok(vtt.startsWith('WEBVTT\n\n'), 'VTT 以 WEBVTT 头开始')
ok(vtt.includes('00:00:00.000 --> 00:00:02.000'), '★ VTT 用点号而不是逗号（规范差异）')
ok(!vtt.includes(','), 'VTT 里没有逗号时码')
eq(cuesToVtt([]), '', '空 cue → 空 VTT')

/* ---------------------------------------------------------- 编排入口 ---- */
const planScript = planSubtitles({ text: '你好。世界。', seconds: 4 })
eq(planScript.ok, true, '脚本字幕编排成功')
eq(planScript.source, 'script', 'source 标 script')
eq(planScript.format, 'srt', '默认 srt')
eq(planScript.aligned, false, '脚本字幕 aligned:false')
ok(planScript.content.startsWith('1\n'), '内容就是可直接落盘的 SRT')

eq(planSubtitles({ text: '你好。', seconds: 1, format: 'vtt' }).format, 'vtt', 'format 透传')
eq(planSubtitles({ text: '你好。', seconds: 1, format: 'VTT' }).format, 'vtt', 'format 不区分大小写')
eq(planSubtitles({ text: '你好。', seconds: 1, format: 'ass' }).format, 'srt', '不支持的格式回落 srt（不假装支持 ass）')

const asrNoCap = planSubtitles({ source: 'asr', caps: { nodes: [] }, text: 'x', seconds: 3 })
eq(asrNoCap.ok, false, '★ 没有 ASR 能力时 asr 路径必须失败')
eq(asrNoCap.content, '', '失败时**不产出**空字幕文件')
eq(asrNoCap.missing.length, 3, '失败时给出缺件清单')
ok(asrNoCap.suggestion.includes('script'), '失败时给出可用替代（脚本字幕）')

const asrUnknown = planSubtitles({ source: 'asr', caps: {} })
ok(asrUnknown.ok === false && asrUnknown.reason.includes('无法确认'), '拿不到清单时说的是"无法确认"')

const asrOk = planSubtitles({
  source: 'asr', caps: { nodes: ['WhisperTranscribe'] },
  cues: [{ from: 0, to: 1.2, text: '第一句' }],
})
eq(asrOk.ok, true, '有 ASR 且有 cue → 成功')
eq(asrOk.aligned, true, '★ asr 路径 aligned:true（时间戳来自真实转写）')
ok(String(asrOk.note).includes('WhisperTranscribe'), 'note 注明时间戳来自哪个节点')

const asrNoCue = planSubtitles({ source: 'asr', caps: { nodes: ['WhisperTranscribe'] } })
ok(asrNoCue.ok === false && asrNoCue.reason.includes('cue'), '有 ASR 但没给 cue → 明确报缺 cue')

/* ============================================================ D23 ==== */
sec('D23 参数可视化')

eq(ORIGINS.length, 5, '五种来源标记')
eq(applyAlign(830, 'edge'), 832, '830 按 16 的倍数对齐 → 832')
eq(applyAlign(1024, 'edge'), 1024, '本来就对齐时不变')
eq(applyAlign(830, 'frames4n1'), 829, '830 按 4n+1 对齐 → 829')
eq(applyAlign(9, 'frames4n1'), 9, '9 本来就是 4n+1')
eq(applyAlign('abc', 'edge'), 'abc', '非数字原样返回（不变成 NaN）')
eq(applyAlign(830, undefined), 830, '没有 align 规则时不变')

const mf = {
  params: {
    prompt: { type: 'string', required: true },
    width: { type: 'int', align: 'edge', label: '宽度' },
    frames: { type: 'int', align: 'frames4n1' },
    steps: { type: 'int', default: 25 },
    seed: { type: 'int' },
  },
  consts: { cfg: 2.5, sampler: 'euler' },
}
const view = describeParams(mf, { prompt: '一只狐狸', width: 830, steps: 25 })
eq(view.ok, true, '参数表生成成功')
const rowOf = (k) => view.rows.find((r) => r.key === k) ?? {}

eq(rowOf('prompt').origin, 'user', 'prompt 来源 = 你指定')
eq(rowOf('prompt').display, '一只狐狸', 'prompt 值原样展示')
eq(rowOf('width').origin, 'aligned', '★ 830 被对齐 → 来源标「已对齐」')
eq(rowOf('width').value, 832, 'width 实际生效值是 832')
eq(rowOf('width').raw, 830, '同时保留你给的 830（不抹掉原始输入）')
ok(rowOf('width').note.includes('830') && rowOf('width').note.includes('832'), 'note 写明 830→832')
eq(rowOf('frames').origin, 'unset', '没默认值也没填 → 未填')
eq(rowOf('frames').note.includes('清单没给默认值'), true, '未填时说明原因')
eq(rowOf('steps').origin, 'user', '显式给了就等于你指定')
eq(rowOf('seed').origin, 'unset', '没给也没默认 → 未填')
eq(rowOf('cfg').origin, 'const', 'consts 里的键标「链路固定」')
eq(rowOf('cfg').display, '2.5', '常量值格式化正确')
ok(rowOf('cfg').note.includes('不可调'), '常量行说明不可调')

eq(view.changed.length, 1, '只有 width 算「被对齐调整过」')
eq(view.changed[0], 'width', 'changed 里是 width')
ok(view.summary.includes('你指定了 2 项'), '摘要统计你指定的项数')
ok(view.summary.includes('1 项被对齐规则调整过'), '摘要点出被调整的项数')
eq(view.counts.aligned, 1, 'counts 按来源分类计数')
eq(view.counts.const, 2, '两个常量')
ok(view.rows.every((r) => typeof r.origin_label === 'string' && r.origin_label !== ''), '每行都带中文来源标签')

// 用户给的值恰好等于默认值：算「你指定」，但不进 changed
const same = describeParams(mf, { prompt: 'x', steps: 25 })
ok(!same.changed.includes('steps'), '★ 给的值等于默认值时不算改动（不制造噪音）')
eq(same.rows.find((r) => r.key === 'steps').origin, 'user', '但仍然记录「你指定」')

// 没给 prompt
const noPrompt = describeParams(mf, {})
eq(noPrompt.rows.find((r) => r.key === 'prompt').origin, 'unset', '没给 prompt → 未填')
ok(noPrompt.summary.includes('全部参数走默认值'), '全默认时摘要这样说')

ok(describeParams({}, {}).ok === false, '没有参数清单时 ok:false')
ok(describeParams({}, {}).reason.includes('无法列出'), '并说明为什么列不出来')

/* ============================================================ D26 ==== */
sec('D26 懒加载盘点')

ok(LOADER_NODES.includes('UNETLoader'), 'UNETLoader 在加载器清单里')
ok(LOADER_NODES.includes('UnetLoaderGGUF'), 'GGUF 加载器也算')
ok(LOADER_NODES.includes('QwenImage21Cache'), '前缀缓存节点也算（它持有一份模型）')
eq(BLOCKER_NODE, 'ExecutionBlocker', '按条件跳过节点的真名是 ExecutionBlocker')

const lazyMf = {
  id: 'unit-test',
  graph: {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'a.gguf' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
  },
  patches: [
    { id: 'p-audio', when: { param: 'audioTrack', nonEmpty: true }, add: { 9: { class_type: 'VAELoader', inputs: {} } } },
    { id: 'p-plain', when: { param: 'x', equals: 1 }, set: { 2: { text: 'y' } } },
  ],
}
const audit = auditLazyNodes(lazyMf)
eq(audit.ok, true, '盘点成功')
eq(audit.always.length, 1, '主图只有 1 个加载器')
eq(audit.always[0].class_type, 'UNETLoader', '主图加载器是 UNETLoader')
eq(audit.conditional.length, 1, '只有 1 组补丁带加载器（纯 set 文本的补丁不算）')
eq(audit.conditional[0].patch, 'p-audio', '补丁 id 带出')
eq(audit.conditional[0].loaders.length, 1, '该补丁新增 1 个加载器')
eq(audit.blocker, 'unknown', '★ 没给节点清单 → blocker unknown（不是 absent）')
ok(audit.advice.some((a) => a.includes('无法确认')), 'unknown 时建议里说「无法确认」')
eq(audit.manifest_id, 'unit-test', '清单 id 带出')

eq(auditLazyNodes(lazyMf, { nodes: [] }).blocker, 'absent', '明确没有 ExecutionBlocker → absent')
ok(auditLazyNodes(lazyMf, { nodes: [] }).advice.some((a) => a.includes('无法') && a.includes('跳过')),
  '★★ absent 时明说做不到运行时跳过（这是本机的真实情况）')
eq(auditLazyNodes(lazyMf, { nodes: ['ExecutionBlocker'] }).blocker, 'available', '有该节点 → available')

const noPatch = auditLazyNodes({ id: 'x', graph: { 1: { class_type: 'VAELoader', inputs: {} } } })
eq(noPatch.conditional.length, 0, '没有补丁时 conditional 为空数组')
ok(noPatch.advice.some((a) => a.includes('每次执行都要加载')), '提醒主图加载器是每次都载')

ok(auditLazyNodes({}).ok === false, '没有 graph 时 ok:false')
ok(auditLazyNodes({ graph: {} }).ok === true, '空 graph 仍算盘点成功（没有加载器）')
ok(auditLazyNodes({ graph: {} }).advice.some((a) => a.includes('没有独立加载器')), '空 graph 给出对应说明')

/* ============================================================ A2 ==== */
sec('A2 视频后处理层')

eq(POST_STEPS.length, 7, '后处理共 7 步')
eq(POST_STEPS[0].id, 'probe', '第一步是探测（后面都要用帧率）')
const ids = POST_STEPS.map((s) => s.id)
ok(ids.indexOf('frame') < ids.indexOf('replace-frame'), '★ 抽帧排在改帧回贴之前（顺序即依赖）')
const attach = POST_STEPS.find((s) => s.id === 'attach-audio')
ok(String(attach.caveat).includes('生成时'), '★★ 换音轨明确写的是「生成时挂」，不是给成片混流')
ok(String(attach.route).includes('重新生成'), '换音轨的入口标注为重新生成')

const full = planPost({ ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', nodes: ['VHS_LoadAudio'] })
eq(full.ok, true, '工具齐备时 ok')
eq(full.blocked.length, 0, '工具齐备时没有被挡的步骤')
eq(full.available.length, 7, '7 步全部可用')
eq(full.plan.join(','), 'probe,frame-save,frame,clip,replace-frame,attach-audio,subtitle', 'plan 按固定顺序列出')

const noFfmpeg = planPost({ ffmpeg: null, ffprobe: null, nodes: [] })
eq(noFfmpeg.available.map((s) => s.id).join(','), 'frame-save,subtitle',
  '★ 没 ffmpeg 时只剩「存帧为图」与「字幕」（都不依赖 ffmpeg）')
ok(noFfmpeg.blocked.some((s) => s.id === 'frame' && s.missing.includes('ffmpeg')), '抽帧被挡且原因写明缺 ffmpeg')
ok(noFfmpeg.blocked.some((s) => s.id === 'attach-audio' && s.missing.includes('VHS_LoadAudio')),
  '缺 VHS_LoadAudio 时换音轨被挡')
ok(noFfmpeg.notes.some((n) => n.includes('没找到 ffmpeg')), 'notes 说明 ffmpeg 缺失')
ok(noFfmpeg.notes.some((n) => n.includes('零依赖')), 'notes 指出仍有零依赖通路')

const noProbe = planPost({ ffmpeg: 'ffmpeg', ffprobe: null })
ok(noProbe.blocked.some((s) => s.id === 'probe'), '只有 ffmpeg 没 ffprobe 时「探测」被挡')
ok(noProbe.available.some((s) => s.id === 'frame'), '但抽帧仍可用（ffmpeg 在）')
ok(noProbe.notes.some((n) => n.includes('ffprobe')), 'notes 说明缺 ffprobe 的影响')
// 节点清单没给时不能谎报缺件
ok(planPost({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }).available.some((s) => s.id === 'attach-audio'),
  '★ 节点清单未知时不把换音轨判成"缺件"')

ok(planPost({ ffmpeg: 'ffmpeg', hasVideo: false }).notes.some((n) => n.includes('还没有成片')), '没有成片时给出提示')
ok(planPost({}).notes.some((n) => n.includes('执行顺序')), 'notes 说明执行顺序')

/* ============================================================ A3 ==== */
sec('A3 预设绑定 manifest')

ok(PRESET_BINDINGS.length >= 4, '预设表至少 4 条')
eq(checkPresetBindings(['video-wan22', 'image-qwen21']).length, 0, '两条清单都在时全表通过')
eq(checkPresetBindings([]).length, 1, '★ 没有清单时报错（不能默默通过）')
// ★ 生图链的预设标了 pending：链还没清单化，绑定暂时无从校验。
//   这种情况**不算错误**（否则每次启动一堆假红），但要能单独列出来。
eq(checkPresetBindings(['video-wan22']).length, 0, 'pending 的预设不参与校验（不制造长期假红）')
ok(PRESET_BINDINGS.some((p) => p.pending === true), '预设置里确实有 pending 项')
ok(PRESET_BINDINGS.filter((p) => p.pending === true).every((p) => p.manifest === 'image-qwen21'),
  'pending 的都是还没清单化的生图链')

const vm = { params: { steps: { default: 4 }, frames: { default: 81 } }, consts: { shift: 10 } }
const pv = presetsForManifest('video-wan22', vm)
eq(pv.ok, true, '预设都能在清单里落地')
eq(pv.presets.length, 2, '视频链有 2 个预设')
ok(pv.presets.find((p) => p.id === 'video-dmd-4step').ok === true, '4 步档校验通过')

const bad = presetsForManifest('video-wan22', { params: { steps: {} } })
ok(bad.ok === false, '清单缺 frames 时校验失败')
ok(String(bad.presets.find((p) => p.id === 'video-standard').reason).includes('frames'), '失败原因点名缺哪个键')

ok(presetsForManifest('nope', null).ok === false, '清单不存在时 ok:false')

const applied = applyPreset('video-dmd-4step', 'video-wan22', vm, { prompt: '狐狸' })
eq(applied.ok, true, '套用成功')
eq(applied.values.steps, 4, 'steps 被设为 4')
eq(applied.values.prompt, '狐狸', '★ 原有参数不被吞掉')
eq(applied.applied.steps, 4, '回显实际应用了什么')

const wrongChain = applyPreset('video-dmd-4step', 'image-qwen21', { params: { steps: {} } }, {})
eq(wrongChain.ok, false, '★★ 把视频 4 步档套到生图链上必须被拒')
ok(wrongChain.reason.includes('不能套'), '拒绝原因说清是链不匹配')
eq(applyPreset('nope', 'video-wan22', vm, {}).ok, false, '不存在的预设置失败')
eq(applyPreset('', 'video-wan22', vm, {}).ok, false, '空预设 id 失败')

/* ============================================================ D24 ==== */
sec('D24 入口别名')

eq(checkAliases(TOOLS).length, 0, '★ 别名表全部指向已注册工具（漂移即红）')
ok(checkAliases([]).length > 0, '工具清单为空时必然报错')

const sc = resolveAlias('style_card', TOOLS)
eq(sc.ok, true, 'style_card 可解析')
eq(sc.tool, 'compose_prompt', '★ style_card 落到 compose_prompt（不是影子工具）')
ok(sc.note.includes('模板'), 'note 说清它就是提示词模板')

eq(resolveAlias('STYLE_CARD', TOOLS).ok, true, '别名不区分大小写')
eq(resolveAlias('  style_card  ', TOOLS).ok, true, '前后空白被忽略')
eq(resolveAlias('风格卡', TOOLS).tool, 'compose_prompt', '中文别名同样可用')
eq(resolveAlias('', TOOLS).ok, false, '空别名失败')
eq(resolveAlias('nope', TOOLS).ok, false, '未登记的别名失败')
ok(resolveAlias('nope', TOOLS).reason.includes('没有这个入口别名'), '失败原因说清')

const broken = resolveAlias('style_card', ['draw_image'])
eq(broken.ok, false, '★★ 别名指向未注册工具时必须失败（不能悄悄放行）')
ok(broken.reason.includes('未注册'), '失败原因点明未注册')

ok(aliasesOf('generate_speech').includes('tts'), 'generate_speech 有 tts 别名')
ok(aliasesOf('generate_speech').includes('clone_voice'), '★ 语音克隆登记为 generate_speech 的别名')
eq(aliasesOf('draw_image').length, 0, '没有别名的工具返回空数组')

const dup = ENTRY_ALIASES.filter((a) => a.alias === 'style_card')
eq(dup.length, 1, '别名表里没有重复项')

console.log(`\ntest-compose-tools: ${pass} 项断言通过${failures.length ? `，${failures.length} 项失败` : '，全绿'}`)
for (const f of failures) console.log('  ✗', f)
if (failures.length) process.exitCode = 1
