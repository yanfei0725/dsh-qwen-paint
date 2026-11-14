/**
 * scripts/test-audio-workflows.mjs —— D21（语音克隆）/ D22（音轨合成）专项回归。
 *
 * ## 为什么单独一套
 *   这两条链的节点全部来自 **custom_nodes**（VideoHelperSuite / ComfyUI-Qwen-TTS），
 *   `scripts/comfy-node-contract.json` 只解析官方 `comfy_extras`，覆盖不到它们。
 *   于是专门从真机 `/object_info`（ComfyUI 0.39.0，1686 节点）抽出
 *   `scripts/audio-node-contract.json` 作为契约，在这里逐键对账 ——
 *   节点名写错、槽位名写错、把可选槽当必填，全部会被抓出来。
 *
 * ## 断言风格（重要）
 *   **`ok(名称, 条件, 说明)` —— 名称在前。**
 *   本仓库两种风格并存（另有 `ok(cond, msg)` 的老文件），新文件必须一开始就选定并注明。
 *   写反的后果不是报错而是**整份套件假绿**：条件变成了非空字符串恒真（历史事故：140 项全假绿）。
 *   所以本文件末尾有专门的**自检**：断言名字里只要出现 "true"/"false"/非字符串就直接失败。
 *
 * ## 纪律
 *   不联网、不提交任务、不生成任何媒体。所有 I/O 走注入的假 deps。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VOICE_CLONE_CHAIN, probeVoiceClone, buildVoiceCloneWorkflow,
  TTS_FALLBACK_CHAINS, probeTts,
} from '../lib/tts-workflow.js'
import { makeSpeechRunner, makeSpeechTool } from '../lib/speech-tool.js'
import { uploadToComfy, toComfyInputPath } from '../lib/comfy-upload.js'
import {
  buildVideoWorkflow, buildVideoWorkflowFromManifest, AUDIO_TRACK_NODES,
} from '../lib/video-workflow.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
const fails = []
const badNames = []
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || name === 'true' || name === 'false' || name === '') {
    // 不 return：让这条也计入失败，避免「自检自己挂了却继续跑」
    badNames.push(String(name))
    fails.push(`断言名非法（疑似 ok(cond,name) 写反）：${String(name)}`)
    console.log(`  ✗ 断言名非法：${String(name)}`)
    return
  }
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    fails.push(name)
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`)
  }
}

const contract = JSON.parse(readFileSync(path.join(HERE, 'audio-node-contract.json'), 'utf8'))
const CNODES = contract.nodes ?? {}
// 用一个确定存在的真实文件喂 readFile（避免为测试造二进制资源）
const realFile = path.join(ROOT, 'package.json')

/* ═══════════════ 0. 契约文件本身 ═══════════════ */

console.log('\n[0] 真机契约文件：来源可追溯，且收录 D21/D22 的节点')
ok('契约标注了 ComfyUI 版本', String(contract._source?.comfyuiVersion ?? '') !== '',
  contract._source?.comfyuiVersion)
ok('契约标注了快照节点总数（可反查完整度）', Number(contract._source?.nodeCountInSnapshot ?? 0) > 1000,
  String(contract._source?.nodeCountInSnapshot ?? 0))
for (const n of ['VHS_LoadAudio', 'VHS_VideoCombine', 'FB_Qwen3TTSVoiceClone', 'SaveAudioMP3']) {
  ok(`契约收录 ${n}`, CNODES[n] !== undefined)
}

/* ═══════════════ 1. D21：槽位真机对账 ═══════════════ */

console.log('\n[1] D21 语音克隆：工作流里的每个键都在真机契约里')

const VCCaps = { nodes: new Set(VOICE_CLONE_CHAIN.nodes) }
const vcBuilt = buildVoiceCloneWorkflow(VCCaps, {
  text: '这是一段测试语音', referenceFile: 'dshqp-ref-audio-x.wav', seed: 7,
})

/**
 * 逐节点逐键比对：required 必须全覆盖，所有键必须在 required ∪ optional ∪ 动态白名单里。
 * 动态白名单用于 VHS 那种按 format 动态增减槽位的节点（静态快照拍不全）。
 *
 * @param {boolean} skipUnknown true = 契约里没收录的节点直接跳过。
 *   D21 传 false（工作流全是音频节点，必须全在契约里）；
 *   D22 传 true（视频链还有 CLIPLoader/KSampler 等，那些由 test-workflow-contract.mjs 管）。
 */
function auditWorkflow(payload, label, dynamicAllow = {}, skipUnknown = false) {
  for (const [nodeId, node] of Object.entries(payload)) {
    const c = CNODES[node.class_type]
    if (c === undefined) {
      if (skipUnknown) continue
      ok(`${label}：节点 ${nodeId}(${node.class_type}) 在契约里`, false, '契约未收录')
      continue
    }
    const allowed = new Set([
      ...(c.required ?? []), ...(c.optional ?? []), ...(dynamicAllow[node.class_type] ?? []),
    ])
    const given = Object.keys(node.inputs ?? {})
    const unknown = given.filter((k) => !allowed.has(k))
    ok(`${label}：节点 ${nodeId}(${node.class_type}) 没有契约外的键`, unknown.length === 0, unknown.join(','))
    const missing = (c.required ?? []).filter((k) => !given.includes(k))
    ok(`${label}：节点 ${nodeId}(${node.class_type}) 必填项全给了`, missing.length === 0, missing.join(','))
  }
}

auditWorkflow(vcBuilt.payload, 'D21')

ok('参考音频走 VHS_LoadAudio 加载', vcBuilt.payload['1'].class_type === 'VHS_LoadAudio')
ok('★★ audio_file 自动规范成 input/ 前缀（裸名会被真机拒）',
  vcBuilt.payload['1'].inputs.audio_file === 'input/dshqp-ref-audio-x.wav',
  vcBuilt.payload['1'].inputs.audio_file)
ok('已经带 input/ 时不重复加前缀',
  buildVoiceCloneWorkflow(VCCaps, { text: 'x', referenceFile: 'input/a.wav' })
    .payload['1'].inputs.audio_file === 'input/a.wav')
ok('带 subfolder 的路径也能正确前缀',
  buildVoiceCloneWorkflow(VCCaps, { text: 'x', referenceFile: 'sub/a.wav' })
    .payload['1'].inputs.audio_file === 'input/sub/a.wav')
ok('ref_audio 接到加载节点的输出 0', JSON.stringify(vcBuilt.payload['2'].inputs.ref_audio) === '["1",0]')
ok('生成节点是 FB_Qwen3TTSVoiceClone（不是裸名 VoiceClone）',
  vcBuilt.payload['2'].class_type === 'FB_Qwen3TTSVoiceClone')
ok('target_text 是待合成文本（不是 ref_text）', vcBuilt.payload['2'].inputs.target_text === '这是一段测试语音')
ok('★ 没给 ref_text 时 x_vector_only=true（只取说话人嵌入）',
  vcBuilt.payload['2'].inputs.x_vector_only === true)

const vcWithText = buildVoiceCloneWorkflow(VCCaps, {
  text: 'x', referenceFile: 'a.wav', referenceText: '参考音频原文',
})
ok('★ 给了 ref_text 时 x_vector_only=false（做完整对齐）',
  vcWithText.payload['2'].inputs.x_vector_only === false)
ok('ref_text 原样透传', vcWithText.payload['2'].inputs.ref_text === '参考音频原文')

/* ═══════════════ 2. D21：不能被自动兜底链误命中 ═══════════════ */

console.log('\n[2] D21：VoiceClone 必须在自动兜底链之外')

ok('★★ TTS_FALLBACK_CHAINS 里不含 VoiceClone（否则没给参考音频时会被误选）',
  !TTS_FALLBACK_CHAINS.some((c) => c.nodes.includes('FB_Qwen3TTSVoiceClone')))

const plainProbe = probeTts({ nodes: new Set(['FB_Qwen3TTSVoiceClone', 'VHS_LoadAudio', 'SaveAudioMP3']) })
ok('只有克隆节点、没有 CustomVoice 时，普通 TTS 探测如实报不可用', plainProbe.available === false)
ok('不可用时给「候选链」清单，不是一句"不可用"',
  typeof plainProbe.reason === 'string' && plainProbe.reason.includes('候选链'))

const onlyCloneCaps = { nodes: new Set(['FB_Qwen3TTSCustomVoice', 'SaveAudioMP3']) }
ok('缺 VHS_LoadAudio 时克隆探测如实报不可用', probeVoiceClone(onlyCloneCaps).available === false)
ok('缺件清单点出 VHS_LoadAudio', probeVoiceClone(onlyCloneCaps).missing.includes('VHS_LoadAudio'))
ok('缺件说明指出它来自哪个插件包（而不是让用户自己猜）',
  probeVoiceClone(onlyCloneCaps).reason.includes('VideoHelperSuite'))

let cloneErr = ''
try {
  buildVoiceCloneWorkflow({ nodes: new Set() }, { text: 'x', referenceFile: 'a.wav' })
} catch (e) { cloneErr = e.message }
ok('缺节点时构造直接抛错（不返回半成品）', cloneErr !== '')
ok('错误消息点名缺哪个节点', cloneErr.includes('FB_Qwen3TTSVoiceClone'))

let emptyRefErr = ''
try { buildVoiceCloneWorkflow(VCCaps, { text: 'x', referenceFile: '   ' }) } catch (e) { emptyRefErr = e.message }
ok('空参考音频文件名直接拒绝', emptyRefErr.includes('参考音频'))

/* ═══════════════ 3. D21：runner 层行为（假 deps，零联网） ═══════════════ */

console.log('\n[3] D21：runner 真的上传了参考音频、真的走了克隆链')

const PID = 'pid-fake-1'
const FAKE_AUDIO = { filename: 'out_00001_.mp3', subfolder: '', type: 'output' }

function makeFakeDeps({ uploadStatus = 200, uploadName = 'dshqp-ref-audio-zz.wav' } = {}) {
  const seen = { uploads: [], submitted: null, historyCalls: 0 }
  const deps = {
    cfg: { comfyUrl: 'http://127.0.0.1:8188', outputDir: 'C:/tmp/out', filePrefix: 't', pollIntervalMs: 1 },
    log: () => {},
    ensureComfyUp: async () => {},
    loadObjectInfoFor: async () => ({}),
    catalogForTts: () => ({ nodes: new Set([...VOICE_CLONE_CHAIN.nodes, 'FB_Qwen3TTSCustomVoice']) }),
    submitPrompt: async (_cfg, payload) => { seen.submitted = payload; return PID },
    fetchOutputBytes: async () => Buffer.from('fake-audio-bytes'),
    fetchWithTimeout: async (url, opts) => {
      if (url.includes('/history/')) {
        // ★ 必须和 /upload/image 分开返回：否则 waitForAudio 永远拿不到 outputs，
        //   会一直轮询到 10 分钟超时（第一版就踩了这个，测试直接挂死）。
        seen.historyCalls += 1
        return { ok: true, status: 200, json: async () => ({ [PID]: { outputs: { 3: { audio: [FAKE_AUDIO] } } } }) }
      }
      seen.uploads.push({ url, method: opts?.method, hasBody: opts?.body !== undefined, body: opts?.body })
      return {
        ok: uploadStatus === 200,
        status: uploadStatus,
        json: async () => (uploadStatus === 200 ? { name: uploadName, subfolder: '', type: 'input' } : {}),
      }
    },
    cancelReason: () => new Error('cancelled'),
    safeStem: (s) => String(s).slice(0, 20),
    uniquePath: async (_dir, name) => `C:/tmp/out/${name}`,
  }
  return { deps, seen }
}

{
  const { deps, seen } = makeFakeDeps()
  const run = makeSpeechRunner(deps)
  let out = null
  let err = ''
  try {
    out = await run({ text: '你好', caps: deps.catalogForTts(), referenceAudio: realFile })
  } catch (e) { err = e.message }
  ok('参考音频链路整体跑通（假 deps）', err === '', err)
  ok('★ 上传恰好一次', seen.uploads.length === 1, `实际 ${seen.uploads.length}`)
  ok('★ 上传走 /upload/image（音频与图片同一端点）',
    String(seen.uploads[0]?.url ?? '').endsWith('/upload/image'), seen.uploads[0]?.url)
  ok('上传用 POST', seen.uploads[0]?.method === 'POST')
  ok('上传带了 FormData body', seen.uploads[0]?.body instanceof FormData)
  ok('★ 表单字段名是 image（ComfyUI 端点约定）', seen.uploads[0]?.body?.get('image') !== null)
  ok('★ 提交的图用的是 VoiceClone 节点', seen.submitted?.['2']?.class_type === 'FB_Qwen3TTSVoiceClone')
  const audioFile = String(seen.submitted?.['1']?.inputs?.audio_file ?? '')
  ok('工作流里的 audio_file 是上传返回的名字 + input/ 前缀',
    audioFile === 'input/dshqp-ref-audio-zz.wav', audioFile)
  ok('★ 返回的 tier 是克隆链 id（不报成 custom-voice）', out?.tier === VOICE_CLONE_CHAIN.id, out?.tier)
  ok('产物落盘扩展名取 ComfyUI 返回的真实扩展名', out?.format === 'mp3', out?.format)
}

{
  const { deps, seen } = makeFakeDeps()
  const run = makeSpeechRunner(deps)
  await run({ text: '你好', caps: deps.catalogForTts() })
  ok('★ 没给参考音频时一次上传都不发（不发无用请求）', seen.uploads.length === 0)
  ok('没给参考音频时不挂音频加载节点', seen.submitted?.['1']?.class_type !== 'VHS_LoadAudio')
}

{
  const { deps } = makeFakeDeps({ uploadStatus: 500 })
  const run = makeSpeechRunner(deps)
  let msg = ''
  try { await run({ text: '你好', caps: deps.catalogForTts(), referenceAudio: realFile }) } catch (e) { msg = e.message }
  ok('上传失败时报 HTTP 状态，不吞异常', msg.includes('参考音频上传失败') && msg.includes('500'), msg.slice(0, 60))
}

{
  const { deps } = makeFakeDeps()
  const run = makeSpeechRunner(deps)
  let msg = ''
  try { await run({ text: '你好', caps: deps.catalogForTts(), referenceAudio: 'C:/definitely/not/here.wav' }) }
  catch (e) { msg = e.message }
  ok('文件不存在时报「读不到参考音频」而不是连接错误', msg.includes('读不到参考音频'), msg.slice(0, 60))
}

/* ═══════════════ 4. D21：工具 schema ═══════════════ */

console.log('\n[4] D21：工具 schema 暴露了 reference_audio，且默认行为不变')

{
  const { deps } = makeFakeDeps()
  const tool = makeSpeechTool(deps)
  ok('schema 有 reference_audio', tool.parameters.properties.reference_audio !== undefined)
  ok('schema 有 reference_text', tool.parameters.properties.reference_text !== undefined)
  ok('required 仍只有 text（参考音频是可选的）',
    JSON.stringify(tool.parameters.required) === '["text"]')
  ok('参数说明写清了「给了就走语音克隆」',
    tool.parameters.properties.reference_audio.description.includes('语音克隆'))
}

/* ═══════════════ 5. D22：槽位真机对账 ═══════════════ */

console.log('\n[5] D22 音轨：VHS_VideoCombine.audio 是真的可选槽')

// VHS 的 INPUT_TYPES 会按 format 动态增减（pix_fmt/crf/save_metadata 不在静态快照里），
// 用白名单显式承认这一点，而不是放宽整体判据。
const VHS_DYNAMIC = { VHS_VideoCombine: ['pix_fmt', 'crf', 'save_metadata'] }

const noTrack = buildVideoWorkflow({ nodes: {} }, { prompt: '海浪', seed: 3 })
const withTrack = buildVideoWorkflow({ nodes: {} }, { prompt: '海浪', seed: 3, audioTrack: 'bgm.mp3' })
auditWorkflow(noTrack.workflow, 'D22(无音轨)', VHS_DYNAMIC, true)
auditWorkflow(withTrack.workflow, 'D22(有音轨)', VHS_DYNAMIC, true)

// 契约外的视频节点（CLIPLoader 等）跳过审计，但音轨相关的两个必须在契约里 —— 单独钉死。
for (const n of ['CLIPLoader', 'UNETLoader', 'Wan22ImageToVideoLatent', 'KSampler', 'VAEDecodeTiled']) {
  ok(`（说明）${n} 不在音频契约里，由 test-workflow-contract.mjs 覆盖`, CNODES[n] === undefined)
}
ok('音轨节点 VHS_LoadAudio 确实在图里且被契约覆盖',
  withTrack.workflow[13]?.class_type === 'VHS_LoadAudio' && CNODES.VHS_LoadAudio !== undefined)

ok('★ 真机契约确认 VHS_VideoCombine 有 audio 可选槽',
  CNODES.VHS_VideoCombine.optional.includes('audio'))
ok('★ 真机契约确认 VHS_LoadAudio.audio_file 是必填',
  CNODES.VHS_LoadAudio.required.includes('audio_file'))

ok('有音轨时新增节点 13 = VHS_LoadAudio', withTrack.workflow[13]?.class_type === 'VHS_LoadAudio')
ok('★★ 音轨路径也自动加 input/ 前缀（真机只认这个格式）',
  withTrack.workflow[13]?.inputs?.audio_file === 'input/bgm.mp3',
  withTrack.workflow[13]?.inputs?.audio_file)
ok('audio 接线到节点 13 输出 0',
  JSON.stringify(withTrack.workflow[10].inputs.audio) === '["13",0]')
ok('没音轨时 VHS_VideoCombine **不带** audio 键', !('audio' in noTrack.workflow[10].inputs))
ok('plan 如实记录音轨（规范化后的真实路径）',
  withTrack.plan.audioTrack === 'input/bgm.mp3', withTrack.plan.audioTrack)

const manifestTrack = buildVideoWorkflowFromManifest(
  { nodes: {} }, { prompt: '海浪', seed: 3, audioTrack: 'bgm.mp3' },
)
ok('★ 清单路径与源码路径对音轨的处理逐字节一致',
  JSON.stringify(manifestTrack.workflow) === JSON.stringify(withTrack.workflow))

ok('AUDIO_TRACK_NODES 只含音轨专用节点', JSON.stringify(AUDIO_TRACK_NODES) === '["VHS_LoadAudio"]')
ok('★ 不用音轨时不报「缺 VHS_LoadAudio」（不做无关警报）',
  !noTrack.notes.some((n) => n.includes('VHS_LoadAudio')), noTrack.notes.join('|'))
const missAudio = buildVideoWorkflow({ nodes: { VHS_LoadAudio: false } }, { prompt: 'x', seed: 1, audioTrack: 'a.wav' })
ok('★ 用了音轨又真缺节点时才报警',
  missAudio.notes.some((n) => n.includes('音轨需要但缺节点')), missAudio.notes.join('|'))

/* ═══════════════ 6. D22：共用上传模块 ═══════════════ */

console.log('\n[6] D22：共用上传模块的行为')

console.log('  -- toComfyInputPath 的边界（这个函数写错会让整条音频链在真机被拒）')
ok('裸文件名 → input/ 前缀', toComfyInputPath('a.wav') === 'input/a.wav', toComfyInputPath('a.wav'))
ok('已带 input/ 不重复加', toComfyInputPath('input/a.wav') === 'input/a.wav')
ok('output/ 前缀原样保留', toComfyInputPath('output/a.wav') === 'output/a.wav')
ok('temp/ 前缀原样保留', toComfyInputPath('temp/a.wav') === 'temp/a.wav')
ok('反斜杠统一成正斜杠', toComfyInputPath('sub\\a.wav') === 'input/sub/a.wav', toComfyInputPath('sub\\a.wav'))
ok('空串 → 空串（不硬造一个 input/）', toComfyInputPath('   ') === '')
ok('绝对路径原样返回，交给上层报错（不瞎猜）',
  toComfyInputPath('C:/x/a.wav') === 'C:/x/a.wav', toComfyInputPath('C:/x/a.wav'))

{
  const calls = []
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: true, status: 200, json: async () => ({ name: 'x-track.wav', subfolder: 'sub', type: 'input' }) }
  }
  const out = await uploadToComfy({
    cfg: { comfyUrl: 'http://127.0.0.1:8188' }, filePath: realFile,
    fetchFn, namePrefix: 'pfx-', kind: '音轨',
  })
  ok('subfolder 非空时拼成 "input/sub/文件名"', out === 'input/sub/x-track.wav', out)
  ok('端点固定 /upload/image', calls[0].url === 'http://127.0.0.1:8188/upload/image')
  ok('POST', calls[0].opts.method === 'POST')
  ok('body 是 FormData', calls[0].opts.body instanceof FormData)
  ok('★ 字段名是 image（ComfyUI 的端点约定）', calls[0].opts.body.get('image') !== null)
  ok('上传名带了调用方给的前缀',
    String(calls[0].opts.body.get('image')?.name ?? '').startsWith('pfx-'),
    String(calls[0].opts.body.get('image')?.name ?? ''))
  ok('上传名保留了原文件名尾巴（便于在 ComfyUI 里辨认）',
    String(calls[0].opts.body.get('image')?.name ?? '').includes('package.json'),
    String(calls[0].opts.body.get('image')?.name ?? ''))
  ok('overwrite=true', calls[0].opts.body.get('overwrite') === 'true')
}

{
  const fetchFn = async () => ({ ok: false, status: 413, json: async () => ({}) })
  let msg = ''
  try {
    await uploadToComfy({ cfg: { comfyUrl: 'http://x' }, filePath: realFile, fetchFn, namePrefix: 'p-', kind: '音轨' })
  } catch (e) { msg = e.message }
  ok('HTTP 非 2xx 时带上状态码报错', msg.includes('音轨上传失败') && msg.includes('413'), msg)
}

{
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => ({}) })
  let msg = ''
  try {
    await uploadToComfy({ cfg: { comfyUrl: 'http://x' }, filePath: realFile, fetchFn, namePrefix: 'p-', kind: '音轨' })
  } catch (e) { msg = e.message }
  ok('返回体没有 name 时视为异常，不静默继续', msg.includes('上传返回异常'))
}

{
  let msg = ''
  try {
    await uploadToComfy({
      cfg: { comfyUrl: 'http://x' }, filePath: 'C:/nope/none.wav',
      fetchFn: async () => ({ ok: true, json: async () => ({ name: 'a' }) }), namePrefix: 'p-', kind: '音轨',
    })
  } catch (e) { msg = e.message }
  ok('文件不存在时消息用调用方给的称呼（音轨）', msg.includes('读不到音轨'), msg.slice(0, 50))
}

/* ═══════════════ 7. 发布物完整性 ═══════════════ */

console.log('\n[7] 发布物：新模块与新契约必须在包里，且体积安全')

{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('package.json files 含 lib/（comfy-upload 与 workflow-manifest 才能进包）',
    Array.isArray(pkg.files) && pkg.files.includes('lib'))
  ok('package.json files 含 workflows/（清单才能进包）',
    Array.isArray(pkg.files) && pkg.files.includes('workflows'))
  const size = readFileSync(path.join(ROOT, 'scripts', 'audio-node-contract.json')).length
  ok('★ audio-node-contract.json 在单文件闸门内', size < 262144, `${size} B`)
  ok('契约里注明全量快照未入库（防止有人误以为丢了）',
    String(contract._source?.note ?? '').includes('未入库'))
}

/* ═══════════════ 8. 自检 ═══════════════ */

console.log('\n[8] 自检：断言名合法（防 ok 实参写反导致整份假绿）')
console.log(badNames.length === 0
  ? '  ✓ 全程没有出现布尔型断言名'
  : `  ✗ 出现 ${badNames.length} 个非法断言名：${badNames.slice(0, 5).join(',')}`)

console.log(`\n${'='.repeat(52)}`)
if (fails.length === 0) {
  console.log(`结果：${pass} 通过 / 0 失败`)
  console.log('全部通过 ✓')
} else {
  console.log(`结果：${pass} 通过 / ${fails.length} 失败`)
  console.log('失败项：')
  for (const f of fails) console.log(`  · ${f}`)
  process.exitCode = 1
}
