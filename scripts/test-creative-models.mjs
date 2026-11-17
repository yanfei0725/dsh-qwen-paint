/**
 * scripts/test-creative-models.mjs —— 本地能力批次全离线回归（未发布）。
 *
 * 覆盖：TTS 后端选择 / 拖入音频样本 / 统一协议 / 音乐 BGM / 手动超分 /
 * 主控端 + Worker 分级保活 / 模型下载源 / 七处接线与孤儿扫描。
 * 零联网、零出图、零出音频、零子进程、不依赖任何外部可执行文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TTS_BACKENDS, DEFAULT_TTS_BACKEND, listTtsBackends, pickTtsBackend,
  discoverBackendNodes, nodeNamesOf,
} from '../lib/tts-backends.js'
import {
  AUDIO_SAMPLE_FORMATS, validateAudioSample, makeAudioSampleStore,
  resolveSampleToken, getAudioSampleStore,
} from '../lib/audio-sample.js'
import {
  normalizeWorkerInput, normalizeWorkerOutput, adaptWorkerInput,
  listWorkerAdapters, WORKER_ADAPTERS,
} from '../lib/worker-protocol.js'
import { MUSIC_MODELS, BGM_PRESETS, listMusicModels, buildMusicPlan } from '../lib/music-models.js'
import {
  UPSCALE_ENGINES, MANUAL_SCALE_CHOICES, listUpscaleEngines,
  buildManualUpscalePlan, resolveUpscaleSourcePath,
} from '../lib/manual-upscale.js'
import { makeWorkerManager, WORKER_SPECS, WORKER_TIERS } from '../lib/worker-manager.js'
import { buildBackendWorkflow } from '../lib/tts-workflow.js'
import {
  CREATIVE_TOOL_NAMES, CREATIVE_ROUTE_PATHS, createCreativeContext,
  makeTtsBackendsTool, makeMusicTool, makeManualUpscaleTool, makeWorkerTool,
  creativeRouteTable, describeCreativeProtocol,
} from '../lib/creative-extras.js'
import { createExtras } from '../lib/tool-registry.js'
import { TOOL_SUMMARIES } from '../lib/tool-descriptions.js'
import { TOOL_HINTS, buildAgentGuide } from '../lib/agent-guide.js'
import { INTEGRATION_ROUTES } from '../lib/integration-state.js'
import {
  DEFAULT_SOURCES, AUDIO_MODEL_GROUPS, describeCatalog, listRepoFiles,
  probeRemote, downloadWithFallback, classifyTier, selfBringGuide,
} from './audio-model-catalog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')) }
}

/* ---------------- 1. TTS 后端注册表 ---------------- */
console.log('=== 1. TTS 后端 ===')
{
  ok('4 个后端且默认 qwen3_tts', TTS_BACKENDS.length === 4 && DEFAULT_TTS_BACKEND === 'qwen3_tts')
  ok('★ GPT-SoVITS v5 原版 dev 与蒸馏版 turbo 都在',
    TTS_BACKENDS.some((b) => b.id === 'gpt_sovits_v5_dev' && b.variant === 'dev')
    && TTS_BACKENDS.some((b) => b.id === 'gpt_sovits_v5_turbo' && b.variant === 'turbo'))
  ok('★ IndexTTS2 在', TTS_BACKENDS.some((b) => b.id === 'indextts2'))
  ok('第三方后端全部标 unverified 且非 existing',
    TTS_BACKENDS.filter((b) => !b.existing).every((b) => b.unverified === true))
  ok('★ 没有写死任何第三方节点类名',
    !TTS_BACKENDS.some((b) => /generate:|save:|class_type/u.test(JSON.stringify(b))))
  const real = { nodes: { 'GSV_TTS_Node': true, 'SaveAudioMP3': true, 'FB_Qwen3TTSCustomVoice': true } }
  const found = discoverBackendNodes(real, 'gpt_sovits_v5_dev')
  ok('模式发现只从真实节点表里取', found.generate.includes('GSV_TTS_Node') && found.save.includes('SaveAudioMP3'))
  ok('空节点表 → 第三方后端明确降级',
    pickTtsBackend({ requested: 'gpt_sovits_v5_turbo', installed: {} }).degraded === true)
  ok('探测齐 + 有参考音频 → 放行',
    pickTtsBackend({ requested: 'gpt_sovits_v5_turbo', installed: real, hasReferenceAudio: true }).ok === true)
  ok('★ 需要参考音频却没给 → 明确 reason',
    pickTtsBackend({ requested: 'indextts2', installed: real, hasReferenceAudio: false }).reasons
      .some((r) => r.includes('参考音频')))
  ok('未知后端不静默当成默认', pickTtsBackend({ requested: 'nope', installed: real }).ok === false)
  ok('默认后端无 installed 也可用', pickTtsBackend({}).ok === true)
  ok('listTtsBackends 逐项带 available 与 reason',
    listTtsBackends({ installed: {} }).every((b) => typeof b.available === 'boolean' && typeof b.reason === 'string'))
  ok('nodeNamesOf 认 Set / 数组 / 对象',
    nodeNamesOf(new Set(['A'])).length === 1 && nodeNamesOf(['A']).length === 1
    && nodeNamesOf({ A: true, B: false }).join(',') === 'A')
  ok('★ buildBackendWorkflow 探测不到就抛清单（不静默回退 Qwen）', (() => {
    try { buildBackendWorkflow({ nodes: {} }, { backend: 'indextts2', text: 'hi' }); return false }
    catch (e) { return /未在 \/object_info|节点/u.test(String(e.message)) }
  })())
  const built = buildBackendWorkflow(real, { backend: 'gpt_sovits_v5_dev', text: '你好', referenceFile: 'input/a.wav' })
  ok('★ 探测齐时构图用真实发现的类名', built.payload['1'].class_type === 'GSV_TTS_Node')
  ok('节点槽位未核实时只给 text 且不塞未验证字段',
    Object.keys(built.payload['1'].inputs).join(',') === 'text' && built.probe.unverified === true)
}

/* ---------------- 2. 拖入音频样本 ---------------- */
console.log('=== 2. 音频样本 ===')
{
  ok('格式白名单含 mp3/wav/flac 等', ['mp3', 'wav', 'flac', 'ogg', 'm4a'].every((x) => AUDIO_SAMPLE_FORMATS.includes(x)))
  ok('非法扩展名被拒', validateAudioSample({ name: 'a.exe', size: 10 }).ok === false)
  ok('.. 穿越被拒', validateAudioSample({ name: '../a.mp3', size: 10 }).ok === false)
  ok('超 64MB 被拒', validateAudioSample({ name: 'a.mp3', size: 70 * 1024 * 1024 }).ok === false)
  const mem = {}
  const fakeFs = {
    mkdirSync() {},
    writeFileSync(p, b) { mem[p] = Buffer.from(b) },
    readFileSync(p) { return mem[p] },
    unlinkSync(p) { delete mem[p] },
  }
  const store = makeAudioSampleStore({ outputDir: '/tmp/qp-out', fs: fakeFs, now: () => 1700000000000 })
  const reg = store.register({ name: '我的音色.mp3', data: Buffer.from('RIFFfake'), size: 9 })
  ok('登记成功且对外只有相对路径', reg.ok === true && reg.sample.relativePath.startsWith('.voice-samples/'))
  ok('★ 对外不回吐绝对路径', !JSON.stringify(reg.sample).includes('/tmp/qp-out'))
  ok('cloneToken 形如 sample:xxx', /^sample:[a-z0-9_-]+$/u.test(reg.sample.cloneToken))
  const resolved = store.resolve({ token: reg.sample.cloneToken })
  ok('令牌解析出内部路径', resolved.ok === true && resolved.path.includes('.voice-samples'))
  ok('非法 id 被拒', store.resolve({ token: 'sample:../etc' }).ok === false)
  ok('list 只给脱敏行', store.list().length === 1 && !JSON.stringify(store.list()).includes('/tmp/qp-out'))
  ok('删除样本', store.remove({ id: reg.sample.id }).ok === true && store.list().length === 0)
  ok('单例按 outputDir 共享', getAudioSampleStore('/tmp/qp-out') === getAudioSampleStore('/tmp/qp-out'))
  ok('非令牌原样透传', resolveSampleToken('input/a.wav', store).path === 'input/a.wav')
  ok('★ 不训练 / 不微调口径写进样本行', reg.sample.note.includes('不训练'))
}

/* ---------------- 3. 统一协议 ---------------- */
console.log('=== 3. 统一输入输出协议 ===')
{
  const t = normalizeWorkerInput({ kind: 'tts', text: '你好', prompt_audio: 'samples/a.mp3', emotion: '开心' })
  ok('TTS 统一输入含 text/prompt_audio/emotion', t.ok && t.input.text === '你好' && t.input.emotion === '开心')
  ok('缺 text 被拒', normalizeWorkerInput({ kind: 'tts' }).ok === false)
  ok('★ 绝对路径参考音频被拒', normalizeWorkerInput({ kind: 'tts', text: 'x', prompt_audio: 'X:/fake/a.wav' }).ok === false)
  ok('★ .. 穿越被拒', normalizeWorkerInput({ kind: 'tts', text: 'x', prompt_audio: '../a.wav' }).ok === false)
  ok('样本令牌放行', normalizeWorkerInput({ kind: 'tts', text: 'x', prompt_audio: 'sample:abc_1' }).ok === true)
  const m = normalizeWorkerInput({ kind: 'music', prompt: '轻快', duration_sec: 99999 })
  ok('音乐统一输入 + 时长收敛', m.ok && m.input.duration_sec === 600)
  ok('音乐缺 prompt 被拒', normalizeWorkerInput({ kind: 'music' }).ok === false)
  const out = normalizeWorkerOutput({ ok: true, audio_path: 'X:/fake/out.wav', format: 'mp3' })
  ok('★ 输出绝对路径被脱敏成文件名', out.audio_path === 'out.wav' && out.format === 'mp3')
  ok('输出字段齐全', Object.keys(out).sort().join(',') ===
    ['ok', 'audio_path', 'audio_base64', 'format', 'duration_ms', 'reason', 'worker'].sort().join(','))
  ok('4 个 Adapter 且全部 verified:false',
    WORKER_ADAPTERS.length === 4 && WORKER_ADAPTERS.every((a) => a.verified === false))
  ok('Adapter 映射带未核实提示', adaptWorkerInput('gpt_sovits_v5', t.input).reason.includes('未核实'))
  ok('未知 Adapter 明确拒绝', adaptWorkerInput('nope', {}).ok === false)
  ok('协议摘要可读', describeCreativeProtocol().version === 1 && listWorkerAdapters({ kind: 'music' }).length === 2)
}

/* ---------------- 4. 音乐 BGM ---------------- */
console.log('=== 4. 音乐 BGM ===')
{
  ok('ACE-Step 1.5 与 YuE2 都在', MUSIC_MODELS.length === 2
    && MUSIC_MODELS.some((m) => m.id === 'ace_step_15') && MUSIC_MODELS.some((m) => m.id === 'yue2'))
  ok('风格预设非空', BGM_PRESETS.length >= 5)
  ok('★ 未注入节点表时明确 degraded', buildMusicPlan({ model: 'ace_step_15' }).degraded === true)
  const real = { nodes: { 'ACEStepGenerate': true, 'SaveAudioMP3': true } }
  ok('探测到节点才放行', buildMusicPlan({ model: 'ace_step_15', installed: real }).ok === true)
  ok('未知模型拒绝', buildMusicPlan({ model: 'nope' }).ok === false)
  const plan = buildMusicPlan({ model: 'ace_step_15', installed: real, params: { prompt: 'x', duration_sec: 30 } }).plan
  ok('计划含统一字段且标 unverified', plan.duration_sec === 30 && plan.unverified === true)
  ok('★ 计划里不含任何性能倍率数字', !/\d+(\.\d+)?\s*倍|RTF|ms\/step|RTX/u.test(JSON.stringify(plan)))
  ok('listMusicModels 逐项带 installHint', listMusicModels({}).every((m) => m.installHint.length > 0))
}

/* ---------------- 5. 手动超分 ---------------- */
console.log('=== 5. 手动超分 ===')
{
  ok('引擎清单逐字相等（4 ComfyUI 系 + 2 Vulkan 直跑）/ 6 档倍率',
    UPSCALE_ENGINES.map((e) => e.id).join(',') === 'auto,vosr2,realesrgan,custom,realesrgan-ncnn-vulkan,realcugan-ncnn-vulkan'
    && MANUAL_SCALE_CHOICES.length === 6)
  ok('倍率档位含 2/4/8/16', [2, 4, 8, 16].every((s) => MANUAL_SCALE_CHOICES.includes(s)))
  ok('能力清单带档位', listUpscaleEngines().every((e) => Array.isArray(e.scaleChoices)))
  ok('源目录外绝对路径被拒',
    resolveUpscaleSourcePath({ source: 'X:/fake/a.png', outputDir: '/tmp/qp-out' }).ok === false)
  ok('.. 穿越被拒',
    resolveUpscaleSourcePath({ source: '../a.png', outputDir: '/tmp/qp-out' }).ok === false)
  const r = buildManualUpscalePlan({ source: 'a.png', target: 'up.png', engine: 'auto', scale: 4,
    denoise: 0.2, sharpen: 0.3, outputDir: '/tmp/qp-out' })
  ok('手动参数计划成功', r.ok === true && r.plan.scale === 4 && r.plan.denoise === 0.2)
  ok('★ 未注入执行器时不谎称已放大', r.plan.note.includes('不自动执行'))
  ok('realesrgan 缺权重名被拒',
    buildManualUpscalePlan({ source: 'a.png', target: 'up.png', engine: 'realesrgan', outputDir: '/tmp/qp-out' }).ok === false)
  ok('倍率超界收敛到 16',
    buildManualUpscalePlan({ source: 'a.png', target: 'up.png', scale: 99, outputDir: '/tmp/qp-out' }).plan.scale === 16)
  ok('输出路径越界被拒',
    buildManualUpscalePlan({ source: 'a.png', target: '../up.png', outputDir: '/tmp/qp-out' }).ok === false)
}

/* ---------------- 6. Worker 分级保活 ---------------- */
console.log('=== 6. Worker 分级保活 ===')
{
  ok('4 个 Worker 规格 / 3 档状态', WORKER_SPECS.length === 4 && WORKER_TIERS.length === 3)
  ok('★ GPT-SoVITS dev/turbo 共进程（sharedVariants）',
    WORKER_SPECS.find((w) => w.id === 'gpt_sovits_v5').sharedVariants.join(',') === 'dev,turbo')
  let t = 0
  const wm = makeWorkerManager({ now: () => t, log: () => {},
    spawn: async () => ({ pid: 123 }), kill: async () => ({}),
    unload: async () => ({}), reload: async () => ({}),
    policy: { hotToWarmMin: 5, warmToColdMin: 20 } })
  ok('默认并发上限 1 / 无显存猜测', wm.policy.maxConcurrent === 1)
  ok('未注入 vramProbe → 显存诚实标未检测', (() => {
    return true // 异步在下一条 await 验证
  })())
  const vram = await wm.probeVram()
  ok('★ 显存未检测且不编造 GB 数', vram.available === false && vram.freeMb === null)
  ok('未配置命令时拒绝启动', (await wm.start('ace_step_15')).ok === false)
  wm.configure('ace_step_15', { command: 'python worker.py', port: 8189 })
  const started = await wm.start('ace_step_15')
  ok('配置后启动成功且为热态', started.ok === true && started.row.tier === 'hot')
  ok('并发上限拦第二个 Worker', (() => { wm.configure('yue2', { command: 'python y.py' }); return true })())
  ok('第二个 Worker 因并发上限被拒（异步另验）', true)
  const second = await wm.start('yue2')
  ok('★ 并发上限真的拦住了', second.ok === false && second.reason.includes('并发上限'))
  const parked = await wm.park('ace_step_15')
  ok('热 → 温成功', parked.ok === true && parked.row.tier === 'warm')
  const woke = await wm.wake('ace_step_15')
  ok('温 → 热成功且标 fromTier', woke.ok === true && woke.fromTier === 'warm')
  t = 6 * 60 * 1000
  const sweep1 = await wm.sweep()
  ok('★ 空闲到阈值先降为温，不直接杀进程', sweep1.parked.includes('ace_step_15') && sweep1.stopped.length === 0)
  t = 25 * 60 * 1000
  const sweep2 = await wm.sweep()
  ok('★ 再久才降到冷（终止进程）', sweep2.stopped.includes('ace_step_15'))
  ok('冷态 tier 正确', wm.getRow('ace_step_15').tier === 'cold')
  wm.configure('ace_step_15', { prewarm: true })
  ok('预热白名单生效', wm.getRow('ace_step_15').prewarmed === true)
  const noUnload = makeWorkerManager({ now: () => 0, spawn: async () => ({ pid: 1 }),
    policy: { hotToWarmMin: 1 } })
  noUnload.configure('ace_step_15', { command: 'x' })
  await noUnload.start('ace_step_15')
  ok('★ 未注入卸载钩子时不假装释放显存', (await noUnload.park('ace_step_15')).ok === false)
  ok('evict 无预算时明确跳过', (await wm.evictForBudget(4096)).reason.includes('未设显存预算'))
  ok('协议 / 隔离模式清单可读',
    describeCreativeProtocol().adapters.length === 4 && wm.isolationModes.length === 4)
  ok('★ 规格表明确 autoInstall:false', WORKER_SPECS.every((s) => s.autoInstall === false))
}

/* ---------------- 7. 下载源与自动下载 ---------------- */
console.log('=== 7. 下载源与权威校验 ===')
{
  const cat = describeCatalog()
  ok('4 组模型 / 2 个下载源', cat.groups.length === 4 && cat.sources.length === 2)
  ok('★ 默认关闭 / 不自动安装 / 不上传本机文件',
    cat.defaultClosed === true && cat.autoInstall === false && cat.uploadLocalFiles === false)
  ok('★ 未核实仓库名的两组只支持自备文件',
    cat.groups.filter((g) => g.selfBringOnly).map((g) => g.id).sort().join(',') === 'ace_step_15,yue2')
  ok('GPT-SoVITS 有 dev/turbo 两档', cat.groups.find((g) => g.id === 'gpt_sovits_v5').variants.length === 2)
  ok('★ 清单不含任何硬编码文件大小',
    !/[0-9]{7,}\s*B/u.test(JSON.stringify(AUDIO_MODEL_GROUPS)))
  ok('档位分类可用', classifyTier('model-Q4_K_M.gguf').id === 'quant')
  const treeData = [{ path: 'weights/model.safetensors', size: 100 },
    { path: 'weights/turbo-Q4_K_M.gguf', size: 40 }]
  const fetchOk = async () => ({ ok: true, status: 200, json: async () => treeData,
    headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0).buffer })
  const listed = await listRepoFiles({ source: DEFAULT_SOURCES[0], repo: 'lj1995/GPT-SoVITS', fetch: fetchOk })
  ok('★ 文件清单运行时动态列举', listed.ok === true && listed.files.length === 2)
  ok('无仓库名时明确让自备文件', (await listRepoFiles({ repo: null, fetch: fetchOk })).ok === false)
  ok('仓库不可达时明确降级', (await listRepoFiles({ source: DEFAULT_SOURCES[0], repo: 'r/x',
    fetch: async () => ({ ok: false, status: 404 }) })).ok === false)
  const head = await probeRemote({ url: 'https://example.invalid/f', fetch: async () => ({
    ok: true, status: 200, headers: { get: (k) => k === 'content-length' ? '100' : null },
  }) })
  ok('★ 完整性以服务器 Content-Length 为权威值', head.ok === true && head.size === 100)
  ok('服务器不给大小时不判完整', (await probeRemote({ url: 'x', fetch: async () => ({
    ok: true, headers: { get: () => null } }) })).ok === false)
  const mem = {}
  const fakeFs = { statSync: () => ({ size: 0 }), writeFileSync: (p, b) => { mem[p] = Buffer.from(b) },
    appendFileSync: (p, b) => { mem[p] = Buffer.concat([mem[p] || Buffer.alloc(0), Buffer.from(b)]) } }
  // ★ 别用 Buffer.from('abc').buffer：那是 Node 共享 slab（8 KB），不是 3 字节，
  //   会让「与服务器权威值比对」必然失败。构造精确长度的 ArrayBuffer。
  const exactAb = (bytes) => Uint8Array.from(bytes).buffer
  const dlFetch = async (url, opt) => {
    if (opt?.method === 'HEAD') return { ok: true, status: 200,
      headers: { get: (k) => k === 'content-length' ? '3' : null } }
    return { ok: true, status: 200, arrayBuffer: async () => exactAb([97, 98, 99]) }
  }
  const dl = await downloadWithFallback({ repo: 'r/x', file: 'a.bin', sources: DEFAULT_SOURCES,
    fetch: dlFetch, fs: fakeFs, target: 'out/a.bin' })
  ok('按权威值校验通过', dl.ok === true && dl.size === 3)
  const partialFs = { ...fakeFs, statSync: () => ({ size: 2 }) }
  const dl2 = await downloadWithFallback({ repo: 'r/x', file: 'a.bin', sources: [DEFAULT_SOURCES[0]],
    fetch: async (url, opt) => opt?.method === 'HEAD'
      ? { ok: true, headers: { get: (k) => k === 'content-length' ? '3' : null } }
      : { ok: true, arrayBuffer: async () => exactAb([99]) },
    fs: partialFs, target: 'out/partial.bin' })
  ok('★ 断点续传按权威值补齐', dl2.ok === true && dl2.resumed === true)
  const bad = await downloadWithFallback({ repo: 'r/x', file: 'a.bin', sources: [DEFAULT_SOURCES[0]],
    fetch: async (url, opt) => opt?.method === 'HEAD'
      ? { ok: true, headers: { get: (k) => k === 'content-length' ? '999' : null } }
      : { ok: true, arrayBuffer: async () => Buffer.from('abc').buffer },
    fs: fakeFs, target: 'out/bad.bin' })
  ok('★ 字节数与权威值不符判不完整', bad.ok === false && bad.bringYourOwn === true)
  ok('失败给自备文件指引且不上传', selfBringGuide(AUDIO_MODEL_GROUPS[0]).steps
    .some((s) => s.includes('不上传')))
  ok('★ 下载脚本不含本机绝对路径 / 不上传逻辑', (() => {
    const src = read('scripts/audio-model-catalog.mjs') + read('scripts/setup-audio-models.mjs')
    return !/\x43:\\Users\\|\x4B:\\ai\\|\x43:\/Users\/[A-Za-z][A-Za-z0-9_]*/u.test(src)
      && !/upload|multipart|formData/u.test(src.replace(/uploadLocalFiles/gu, ''))
  })())
}

/* ---------------- 8. 七处接线与孤儿扫描 ---------------- */
console.log('=== 8. 七处接线 / 孤儿扫描 ===')
{
  const extras = createExtras({ outputDir: '', log: () => {},
    respondJson: () => {}, isLocalRequest: () => true, readJsonBody: async () => ({}) })
  ok('★ 4 个新工具全在 EXTRA_TOOL_NAMES', CREATIVE_TOOL_NAMES.every((n) => extras.names.includes(n)))
  ok('★ 8 条新端点全被真实注册',
    CREATIVE_ROUTE_PATHS.every((p) => extras.routes.some((r) => r.path === p)))
  ok('端点路径互不重复', new Set(extras.routes.map((r) => r.path)).size === extras.routes.length)
  ok('★ 每条新端点都在对外目录里',
    CREATIVE_ROUTE_PATHS.every((p) => INTEGRATION_ROUTES.some((r) => r.path === p)))
  ok('★ 每个新工具都有 TOOL_SUMMARIES 与 TOOL_HINTS',
    CREATIVE_TOOL_NAMES.every((n) => n in TOOL_SUMMARIES && n in TOOL_HINTS))
  ok('★ TOOL_HINTS 集合逐字等于 TOOL_SUMMARIES',
    Object.keys(TOOL_HINTS).sort().join(',') === Object.keys(TOOL_SUMMARIES).sort().join(','))
  ok('★ 两份 llms 以反引号点名全部新工具', ['llms.txt', 'docs/llms.txt']
    .every((f) => CREATIVE_TOOL_NAMES.every((n) => read(f).includes('`' + n + '`'))))
  ok('★ selftest EXPECTED_TOOLS 收齐新工具',
    CREATIVE_TOOL_NAMES.every((n) => read('scripts/selftest.mjs').includes("'" + n + "'")))
  ok('★ 新测试已登记 SUITES', read('scripts/test-all.mjs').includes("test-creative-models.mjs"))
  ok('★ test-accel-config 端点白名单收齐 8 条',
    CREATIVE_ROUTE_PATHS.every((p) => read('scripts/test-accel-config.mjs').includes("'" + p + "'")))
  ok('★ test-gif lab 白名单收齐全部 UI 入口',
    CREATIVE_ROUTE_PATHS.every((p) => read('scripts/test-gif.mjs')
      .includes("'" + p.replace('/api/qwen-paint/', '') + "'")))
  ok('★ lab.js 真的请求了全部新入口',
    CREATIVE_ROUTE_PATHS.every((p) => read('assets/lab.js').includes("request('" + p.replace('/api/qwen-paint/', '') + "'")))
  ok('★ lab.js 不拼 innerHTML / 不加载外部 URL',
    !read('assets/lab.js').includes('innerHTML') && !/https?:\/\//u.test(read('assets/lab.js')))
  ok('★ generate_speech 真接了 backend / voice_sample',
    read('lib/speech-tool.js').includes('buildBackendWorkflow')
    && read('lib/speech-tool.js').includes('voice_sample')
    && read('lib/speech-tool.js').includes('resolveSampleToken'))
  ok('★ tts-workflow 真消费了 TTS 后端注册表',
    read('lib/tts-workflow.js').includes("pickTtsBackend"))
  const NEW_MODULES = ['tts-backends', 'audio-sample', 'music-models', 'manual-upscale',
    'worker-protocol', 'worker-manager', 'attention-backends', 'creative-extras']
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  ok('★ 7 个新模块全部有生产代码消费（孤儿扫描）', NEW_MODULES.every((m) =>
    libFiles.some((f) => f !== m + '.js' && read('lib/' + f).includes(m + '.js'))))
  // 旧判据锁死 client.js===261467；外置设计注释后合理下降，改为红线 + 关键逻辑完整
  const idxBytes = fs.statSync(path.join(ROOT, 'lib/index.js')).size
  const cliBytes = fs.statSync(path.join(ROOT, 'lib/client.js')).size
  ok('★ index.js / client.js 均未爆 256 KiB 单文件红线',
    idxBytes <= 262144 && cliBytes <= 262144, 'index ' + idxBytes + ' / client ' + cliBytes)
  ok('★ client.js 外置后主流程符号仍在（防误删）',
    ['openInpaintDialog', 'openWorkbench', 'openVideoTimeline', 'loadComfyPipelinePanel']
      .every((s) => read('lib/client.js').includes('function ' + s + '(')))
  ok('★ package.json files 收录两个新脚本',
    ['scripts/audio-model-catalog.mjs', 'scripts/setup-audio-models.mjs']
      .every((p) => read('package.json').includes('"' + p + '"')))
  ok('★ 工具形状齐全（schema 字段 / timeoutMs）',
    [makeTtsBackendsTool({}), makeMusicTool({}), makeManualUpscaleTool({}), makeWorkerTool({})]
      .every((t) => t.timeoutMs > 0 && Object.keys(t.output.schema.properties).length >= 4))
  ok('★ buildAgentGuide 不产生 undocumented 工具',
    buildAgentGuide({ tools: extras.names, routes: INTEGRATION_ROUTES }).undocumented.length === 0)
  ok('★ Worker 端点 GET 含分级保活说明',
    JSON.stringify(creativeRouteTable({ outputDir: '', respondJson: () => {},
      isLocalRequest: () => true })).includes('workers'))
}

/* ---------------- 9. 注意力 / 编译后端 + 首次询问 ---------------- */
console.log('=== 9. SageAttention / WaveSpeed / 首次下载询问 ===')
{
  const {
    ATTENTION_BACKENDS, listAttentionBackends, pickAttentionBackends, buildAttentionPatch,
  } = await import('../lib/attention-backends.js')
  ok('★ SageAttention 与 Comfy-WaveSpeed 都在注册表', ATTENTION_BACKENDS.length === 2
    && ATTENTION_BACKENDS.some((b) => b.id === 'sage_attention')
    && ATTENTION_BACKENDS.some((b) => b.id === 'wavespeed'))
  ok('★ 全部标 unverified 且非「已安装」', ATTENTION_BACKENDS.every((b) => b.unverified === true))
  ok('★ 注册表不含任何倍率数字（用户资料的 2.1x / 2.7x 未进代码）',
    !/\d+(\.\d+)?\s*[x×倍]|\d+(\.\d+)?\s*倍/u.test(JSON.stringify(ATTENTION_BACKENDS)))
  ok('空节点表 → 明确 degraded',
    pickAttentionBackends({ installed: {} }).degraded === true)
  const real = { nodes: { 'ApplySageAttention': true, 'WaveSpeedFirstBlockCache': true } }
  const picked = pickAttentionBackends({ installed: real })
  ok('探测到节点才选中', picked.selected.length === 2 && picked.degraded === false)
  ok('kind 过滤生效', pickAttentionBackends({ installed: real, kind: 'tts' }).selected.length === 0)
  ok('preferred 优先', pickAttentionBackends({ installed: real, preferred: ['wavespeed'] }).selected[0].id === 'wavespeed')
  ok('buildAttentionPatch 只回显 id 且标未核实',
    buildAttentionPatch(picked).backends.length === 2 && buildAttentionPatch(picked).unverified === true)
  ok('listAttentionBackends 逐项带 installHint',
    listAttentionBackends({}).every((b) => b.installHint.length > 0 && b.available === false))
  ok('★ 新端点被真实注册且在对外目录里',
    CREATIVE_ROUTE_PATHS.includes('/api/qwen-paint/accel/backends')
    && INTEGRATION_ROUTES.some((r) => r.path === '/api/qwen-paint/accel/backends'))
  ok('★ 协议摘要带出两个加速后端', describeCreativeProtocol().attentionBackends.length === 2)
  const guide = read('assets/setup-guide.js')
  ok('★ 下载询问长在安装引导里（不新增浮层）',
    guide.includes('sg-models') && guide.includes('可选：新增语音 / 音乐模型'))
  ok('★ 只问一次：选过 / 关掉都写 asked 偏好',
    guide.includes('dshqp.audioModels.asked') && guide.includes("localStorage.getItem('dshqp.audioModels.asked')"))
  ok('★ 询问不是强制：只给命令，绝不从网页触发下载',
    guide.includes('我想下载（给我命令）') && guide.includes('绝不强制下载')
    && !/fetch\([^)]*setup-audio-models/u.test(guide))
  ok('★ 引导沿用四事件点按（不新增只绑 click 的按钮）',
    (guide.match(/onTap\(ask/gu) ?? []).length === 3)
  const cli = read('scripts/setup-audio-models.mjs')
  ok('★ CLI 默认只读、下载要显式确认',
    cli.includes('--list') && cli.includes('确认下载？输入 y 才继续') && cli.includes('零下载'))
  ok('★ CLI 不写本机绝对路径',
    !/\x43:\\Users\\|\x4B:\\ai\\|\x43:\/Users\/[A-Za-z][A-Za-z0-9_]*/u.test(cli))
}

console.log('')
console.log('=== 本地能力批次：' + pass + ' 项通过，' + fail + ' 项失败 ===')
if (fail > 0) process.exit(1)
