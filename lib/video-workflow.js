/**
 * lib/video-workflow.js —— 视频链（Wan 2.2 / Hummingbird-XT-5B DMD）工作流构造。
 *
 * ## 这张图不是猜的
 *   节点拓扑与参数取自本机**已跑通**的图（`xt_4step_test.py` 提交的那份）：
 *     1 CLIPLoader(umt5_xxl_fp8, type=wan) → 4/5 CLIPTextEncode(正/负)
 *     2 UNETLoader(Hummingbird-XT-5B) → 6 ModelSamplingSD3(shift=10) → 8 KSampler
 *     3 VAELoader(Hummingbird-Wan2.2-VAE) → 7 Wan22ImageToVideoLatent → 8
 *     8 → 12 VAEDecodeTiled → 10 VHS_VideoCombine(h264-mp4)
 *   实测基线（开发笔记 2026-11-09 记录）：832×480/25 帧/4 步 = 18.12 s；
 *   1280×720/25 帧 = 85.48 s；81 帧 16 fps = 78.69 s（热机，非黑已验）。
 *
 * ## ⚠ 两条与生图侧一致的语义
 *   ① **速度% 不改蒸馏步数**。XT-5B 是 DMD 蒸馏模型，实测 3/4/5/6 步耗时几乎一样
 *      （每步约 +1 s），步数不是"快慢旋钮"而是"工作点"。所以 steps 固定 4，
 *      速度% 只压 **帧数 / 帧率 / 高度**。`SPEED_MAP.video[*].steps` 列因此**不生效**。
 *   ② `length` 必须是 **4n+1**（Wan latent 的时间维按 4 压缩，+1 才对得齐），
 *      `width/height` 必须是 **16 的倍数**。这两个不合法 ComfyUI 会直接拒收或出黑帧，
 *      所以在这里就对齐并**如实记录改了什么**（不静默改完当没事）。
 *
 * ## 2026-11-14：A1 工作流 JSON 化的样板（双轨并存）
 *   `workflows/video-wan22.json` 是下面这张图的**声明式同构版本**，
 *   `buildVideoWorkflowFromManifest()` 用 `bindGraph()` 从清单造图。
 *   两条路径**共用 `resolveVideoParams()`**（参数归一化只有一份实现），
 *   因此「换清单」不会带来行为差异；`scripts/test-workflow-manifest.mjs`
 *   逐字节比对两者产物，防漂移。**迁移期先并存，验证稳定后再择一切换。**
 */
import { bindGraph, loadManifest } from './workflow-manifest.js'
import { toComfyInputPath } from './comfy-upload.js'
import { sessionResidency, RESIDENCY_KEYS } from './model-residency.js'

/** 本机已验的三件权重（`/object_info` 实测存在）。 */
export const WAN_ASSETS = Object.freeze({
  unet: 'Hummingbird-XT-5B.safetensors',
  clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  clipType: 'wan',
  vae: 'Hummingbird-Wan2.2-VAE.pth',
})

/** DMD 蒸馏的工作点：固定 4 步（实测 3~6 步耗时几乎相同，4 步是已验档）。 */
export const DMD_STEPS = 4
/** ModelSamplingSD3 位移（本机已验 10.0）。 */
export const DMD_SHIFT = 10.0
/** 默认负向词（本机已验那组）。 */
export const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, watermark'

/** 这条链**必需**的节点（缺一个就明确报缺哪个，而不是提交后被 ComfyUI 拒）。 */
export const REQUIRED_NODES = [
  'CLIPLoader', 'UNETLoader', 'VAELoader', 'CLIPTextEncode',
  'ModelSamplingSD3', 'Wan22ImageToVideoLatent', 'KSampler',
  'VAEDecodeTiled', 'VHS_VideoCombine',
]

/**
 * 只有给了音轨才需要的节点（D22）。
 *
 * 刻意与 `REQUIRED_NODES` 分开：
 *   · 不分开 ⇒ 从不用音轨的用户会一直看到「缺 VHS_LoadAudio」这种无关警报；
 *   · 完全不列 ⇒ 真缺时给了音轨也不报，直接炸在运行时。
 * `VHS_LoadAudio` 与 `VHS_VideoCombine` 同属 VideoHelperSuite，实际几乎不会单独缺，
 * 但判据写清楚比依赖「大概不会」强。
 */
export const AUDIO_TRACK_NODES = ['VHS_LoadAudio']

export const FRAME_MIN = 9
export const FRAME_MAX = 161
export const FRAME_STEP = 8

/** 对齐到 4n+1（Wan latent 时间压缩）。返回 { value, adjusted }。 */
export function alignFrames(frames) {
  const n = Number(frames)
  if (!Number.isFinite(n) || n <= 0) return { value: 25, adjusted: true, reason: '帧数缺失，按 25' }
  const want = Math.round((Math.min(FRAME_MAX, Math.max(FRAME_MIN, n)) - 1) / 4) * 4 + 1
  return { value: want, adjusted: want !== n, reason: want !== n ? `帧数对齐到 4n+1：${n} → ${want}` : '' }
}

/** 对齐到 16 的倍数（VAE 下采样 8 × patch 2）。 */
export function alignEdge(v, fallback = 480) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return { value: fallback, adjusted: true, reason: `尺寸缺失，按 ${fallback}` }
  const want = Math.max(256, Math.round(n / 16) * 16)
  return { value: want, adjusted: want !== n, reason: want !== n ? `边长对齐到 16：${n} → ${want}` : '' }
}

/**
 * 视频参数归一化 —— **全链唯一实现**。
 *
 * 硬编码构建（`buildVideoWorkflow`）与清单构建（`buildVideoWorkflowFromManifest`）
 * 都必须走这里。两条路各自写一遍归一化是漂移的头号来源，所以刻意合并成一份。
 *
 * ⚠ 三个容易写错的默认值口径，逐条说明：
 *   · `negative` 用 **`||`** 而不是 `??`：空串要回落成默认负向词（源码历史行为）。
 *   · `prefix` 用 **`??`** 而不是 `||`：空串是**合法值**（表示不要前缀路径）。
 *   · `notes` 只在调用方**真给了值且被调整**时才记 —— 没给用默认值是正常路径。
 *
 * @returns {{ prompt, seed, frames, width, height, fps, steps, negative, startImage, audioTrack, prefix, notes }}
 */
/* --------------------------------------------------- B10：视频种子继承 ---- */

/**
 * 上一段视频用过的种子。
 *
 * ★ 为什么要有它：连续分镜（同一个人物、同一个场景接着拍）如果每段都用全新随机种子，
 *   画面风格、光照、细节倾向会明显跳变，剪在一起像两个片场。做法是让下一段在上一段
 *   种子上做**小幅偏移**，既保持连贯又不会完全一样（完全一样会得到近似的构图）。
 *
 * ★ 为什么放在模块级而不是 cfg 里：这里只需要记住"最近一次"，不需要跨进程持久化；
 *   写进 cfg 反而会让「同一次会话里不同会话对象」的行为变得难以预测。
 */
let lastVideoSeed = null

/** 偏移范围（含两端）。10–40 是清单给的经验区间：够小保连贯，够大不重复。 */
export const VIDEO_SEED_OFFSET_MIN = 10
export const VIDEO_SEED_OFFSET_MAX = 40

/** 仅供测试与诊断：读当前基准种子（没跑过视频时是 null）。 */
export function getLastVideoSeed() { return lastVideoSeed }

/** 仅供测试：清掉继承基准，让下一次回到纯随机。 */
export function resetVideoSeed() { lastVideoSeed = null }

/**
 * 算出本次该用的种子。
 * · 没有基准（第一次跑 / 刚 reset）→ 纯随机
 * · 有基准 → 基准 + [10,40] 的随机偏移
 *
 * 偏移上限取 2^31 以内，避免累加越过 ComfyUI 的 seed 上限（它按 32 位有符号处理）。
 */
function nextVideoSeed() {
  if (lastVideoSeed === null) return Math.floor(Math.random() * 2 ** 31)
  const span = VIDEO_SEED_OFFSET_MAX - VIDEO_SEED_OFFSET_MIN + 1
  const off = VIDEO_SEED_OFFSET_MIN + Math.floor(Math.random() * span)
  return Math.min(2 ** 31 - 1, lastVideoSeed + off)
}

export function resolveVideoParams(opts) {
  const o = opts ?? {}
  const prompt = String(o.prompt ?? '').trim()
  if (prompt === '') throw new Error('视频提示词不能为空')
  // ★ B10：显式给 seed 就用它（并记为下次的基准）；没给就沿用基准做小幅偏移。
  //   想强制换全新种子，显式传一个新 seed 即可 —— 比再加一个 freshSeed 开关省事：
  //   Agent 判断"场景变了"时本来就会给新种子，加开关只会多一个能被填错的字段。
  const explicitSeed = Number.isFinite(o.seed) ? Math.trunc(o.seed) : null
  const seed = explicitSeed !== null ? explicitSeed : nextVideoSeed()
  lastVideoSeed = seed
  const frames = alignFrames(o.frames)
  const width = alignEdge(o.width, 832)
  const height = alignEdge(o.height, 480)
  const fps = Math.min(30, Math.max(8, Math.trunc(Number.isFinite(o.fps) ? o.fps : 24)))
  const steps = Number.isFinite(o.steps) && o.steps > 0 ? Math.trunc(o.steps) : DMD_STEPS
  const negative = String(o.negative ?? '').trim() || DEFAULT_NEGATIVE
  const startImage = typeof o.startImage === 'string' ? o.startImage.trim() : ''
  // D22：音轨。这里存的是**已经在 ComfyUI input 目录里的路径**（上传由调用方完成）——
  // 本地绝对路径进工作流等于要求 ComfyUI 能看见调用方的盘符，跨机必炸。
  //
  // ★★ 规范化必须放在这里（参数归一化的唯一实现），不能放进 buildVideoWorkflow：
  //   清单路径是 `$param.audioTrack` 直接绑定的，它没有「构造工作流」那一步可以插兜底。
  //   放在这里两条路径拿到的是同一个值 —— 双轨一致性测试就是靠这个立项的。
  //   真机事实：VHS_LoadAudio 只认 `input/...`，传裸名会被 custom_validation_failed 拒。
  const audioTrack = toComfyInputPath(o.audioTrack)
  const prefix = String(o.prefix ?? 'qwen-paint/video')

  const notes = []
  if (Number.isFinite(o.frames) && frames.adjusted) notes.push(frames.reason)
  if (Number.isFinite(o.width) && width.adjusted) notes.push(width.reason)
  if (Number.isFinite(o.height) && height.adjusted) notes.push(height.reason)

  return { prompt, seed, frames, width, height, fps, steps, negative, startImage, audioTrack, prefix, notes }
}

/**
 * 构造视频工作流。
 *
 * @param {object} caps 能力探测结果（用 `caps.nodes` 判断节点是否齐）
 * @param {object} opts { prompt, negative, width, height, frames, fps, steps?, seed, startImage?, prefix? }
 * @returns {{ workflow: object, plan: object, notes: string[] }}
 */
export function buildVideoWorkflow(caps, opts) {
  // B5：视频链会把千问主模型从显存卸下换自己的权重。这里记一笔，
  // 让后续的 batch_draw 能提前告诉用户"首张会重新加载主模型、会慢一些"。
  // ★ 记账失败绝不影响建图本身（这是纯记账，不是前置条件）。
  try { sessionResidency.touch(RESIDENCY_KEYS.video) } catch { /* 忽略 */ }
  const r = resolveVideoParams(opts)
  // caps.nodes 的语义：只有**明确 false** 才算"确认缺"。undefined = 没探测到，不当缺
  // （把"没测出来"当"没有"会把整条视频链误判为不可用）。真缺时 ComfyUI 提交会点名。
  const nodeMap = (caps && caps.nodes) || {}
  const missing = REQUIRED_NODES.filter((n) => nodeMap[n] === false)
  const { prompt, seed, frames, width, height, fps, steps, negative, startImage, audioTrack, notes } = r
  if (missing.length > 0) notes.push(`缺节点：${missing.join('、')}`)
  // 音轨节点单独判：不给音轨时缺它不影响出片，报了只是噪音。
  const missingAudio = audioTrack !== '' ? AUDIO_TRACK_NODES.filter((n) => nodeMap[n] === false) : []
  if (missingAudio.length > 0) notes.push(`音轨需要但缺节点：${missingAudio.join('、')}`)

  // ⚠ inputs **一律写字面量**（不抽成变量、不 spread）：
  //   `scripts/test-workflow-contract.mjs` 是按**源码文本**提取每个节点的
  //   input 键与 `comfy-node-contract.json` 对账的。写成 `inputs: latent` 会让提取器
  //   把**下一个节点**的槽位归到本节点头上（实测把 KSampler 的 10 个槽
  //   算成了 Wan22ImageToVideoLatent) ⇒ 假报「多了 model/positive/...」。
  // 有首帧走 I2V 的可选槽在图构建完之后补上（start_image）。

  const workflow = {
    1: { class_type: 'CLIPLoader', inputs: { clip_name: WAN_ASSETS.clip, type: WAN_ASSETS.clipType } },
    2: { class_type: 'UNETLoader', inputs: { unet_name: WAN_ASSETS.unet, weight_dtype: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: WAN_ASSETS.vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0], text: prompt } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 0], text: negative } },
    6: { class_type: 'ModelSamplingSD3', inputs: { model: ['2', 0], shift: DMD_SHIFT } },
    7: {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: {
        vae: ['3', 0],
        width: width.value,
        height: height.value,
        length: frames.value,
        batch_size: 1,
      },
    },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: ['6', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['7', 0],
        seed,
        steps,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    12: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['8', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    10: {
      class_type: 'VHS_VideoCombine',
      inputs: {
        frame_rate: fps,
        loop_count: 0,
        filename_prefix: r.prefix,
        format: 'video/h264-mp4',
        pix_fmt: 'yuv420p',
        crf: 20,
        save_metadata: true,
        pingpong: false,
        save_output: true,
        images: ['12', 0],
      },
    },
  }

  // I2V：同一个节点的可选槽。**没首帧就不写** —— 写空串 KSampler 会拿到不存在的图。
  if (startImage !== '') workflow[7].inputs.start_image = startImage
  // D22：音轨。**没音轨就完全不挂加载节点** —— 一个 audio_file 为空的 VHS_LoadAudio
  //   不会报"没给音频"，而是运行时直接炸在读取那一步。所以节点本身也要条件新增。
  if (audioTrack !== '') {
    // audioTrack 已由 resolveVideoParams 规范成 `input/...`，这里直接接线。
    workflow[13] = { class_type: 'VHS_LoadAudio', inputs: { audio_file: audioTrack } }
    workflow[10].inputs.audio = ['13', 0]
  }

  return {
    workflow,
    notes,
    plan: videoPlan(r, WAN_ASSETS.unet),
  }
}

/** plan 元信息（派生值，不进清单 —— 见 workflow-manifest.js 的分层说明）。 */
function videoPlan(r, model) {
  return {
    kind: 'video',
    model,
    width: r.width.value,
    height: r.height.value,
    frames: r.frames.value,
    fps: r.fps,
    seconds: Number((r.frames.value / r.fps).toFixed(3)),
    steps: r.steps,
    cfg: 1.0,
    shift: DMD_SHIFT,
    seed: r.seed,
    mode: r.startImage !== '' ? 'i2v' : 't2v',
    startImage: r.startImage,
    audioTrack: r.audioTrack,
    accel: null,
  }
}

/**
 * 从声明式清单构造视频工作流（A1「工作流 JSON 化」的样板实现）。
 *
 * 与 `buildVideoWorkflow()` 的唯一差别是**图从哪来**：这里读 `workflows/video-wan22.json`，
 * 参数归一化与 plan 完全共用 `resolveVideoParams()` / `videoPlan()`。
 * 缺节点判定改用清单自述的 `requires.nodes`，不再依赖硬编码的 `REQUIRED_NODES`
 * —— 将来换一份清单（比如换成别的视频模型）连节点清单都跟着清单走。
 *
 * @param {object} caps 能力探测（`caps.nodes`）
 * @param {object} opts 同 buildVideoWorkflow
 * @param {object} [manifest] 已加载的清单；不传则从 `workflows/video-wan22.json` 读
 * @returns {{ workflow, plan, notes, appliedPatches }}
 */
export function buildVideoWorkflowFromManifest(caps, opts, manifest) {
  const r = resolveVideoParams(opts)
  const m = manifest ?? loadManifest('video-wan22')
  const nodeMap = (caps && caps.nodes) || {}
  const required = Array.isArray(m?.requires?.nodes) ? m.requires.nodes : REQUIRED_NODES
  const missing = required.filter((n) => nodeMap[n] === false)
  const { prompt, seed, frames, width, height, fps, steps, negative, startImage, audioTrack, notes } = r
  if (missing.length > 0) notes.push(`缺节点：${missing.join('、')}`)
  const missingAudio = audioTrack !== '' ? AUDIO_TRACK_NODES.filter((n) => nodeMap[n] === false) : []
  if (missingAudio.length > 0) notes.push(`音轨需要但缺节点：${missingAudio.join('、')}`)

  const bound = bindGraph(m, {
    param: {
      prompt,
      negative,
      width: width.value,
      height: height.value,
      frames: frames.value,
      fps,
      seed,
      steps,
      startImage,
      audioTrack,
      prefix: r.prefix,
    },
    asset: m.assets ?? {},
    const: m.consts ?? {},
  })

  return {
    workflow: bound.workflow,
    notes,
    plan: videoPlan(r, m?.assets?.unet ?? WAN_ASSETS.unet),
    appliedPatches: bound.appliedPatches,
  }
}

/**
 * 生产入口：**清单优先，清单不可用时回落硬编码构建**。
 *
 * ## 为什么必须留回落
 *   清单是随包发布的外部 JSON。用户可能只装了一部分文件、手工改坏了 JSON，
 *   或者某个打包步骤把 `workflows/` 漏掉了。这些情况下最差的结果是「视频直接出不来」，
 *   而硬编码路径是已经真机跑通的老路 —— 回落到它顶多丢掉「换清单即换模型」的便利。
 *
 * ## 为什么能缓存清单
 *   `bindGraph` 内部走 `bindValue`，后者对对象和数组都是**递归新建**，
 *   补丁改的是新建出来的那份，原 manifest 对象不会被污染。
 *   所以缓存同一个 manifest 反复构建是安全的（已由 test-workflow-manifest.mjs 的
 *   「同一份清单连建两次产物相同」间接锁定）。
 *
 * @param {object} caps 能力探测
 * @param {object} opts 同 buildVideoWorkflow
 * @returns {{ workflow, plan, notes, appliedPatches? }}
 */
let preferredManifest = null
export function buildVideoWorkflowPreferred(caps, opts) {
  try {
    if (preferredManifest === null) preferredManifest = loadManifest('video-wan22')
    return buildVideoWorkflowFromManifest(caps, opts, preferredManifest)
  } catch {
    return buildVideoWorkflow(caps, opts)
  }
}

/**
 * 速度% → 视频参数（帧数/帧率/高度）。**steps 不在这里**（DMD 工作点固定）。
 * 取的是 `mode-schema.js` 的 `SPEED_MAP.video`，先按 25/50/75/100 吸附。
 */
export function videoParamsForSpeed(speedPercent, speedMap, tiers) {
  const list = Array.isArray(tiers) && tiers.length > 0 ? tiers : [25, 50, 75, 100]
  const v = Number.isFinite(Number(speedPercent)) ? Number(speedPercent) : 100
  const tier = list.reduce((best, t) => (Math.abs(t - v) < Math.abs(best - v) ? t : best), list[0])
  const slot = speedMap && speedMap.video ? speedMap.video[tier] : null
  const out = { tier, frames: 25, fps: 24, height: 480 }
  if (slot && typeof slot === 'object') {
    if (Number.isFinite(slot.frames)) out.frames = slot.frames
    if (Number.isFinite(slot.fps)) out.fps = slot.fps
    if (Number.isFinite(slot.height)) out.height = slot.height
  }
  return out
}

/** 按画幅比例 + 高度反推宽（16 对齐）。与生图侧 `calcSize` 同思路，只是以高度为基准。 */
export function widthForAspect(aspectKey, height) {
  const table = {
    '1:1': [1, 1], '3:4': [3, 4], '4:3': [4, 3], '2:3': [2, 3],
    '3:2': [3, 2], '16:9': [16, 9], '9:16': [9, 16],
  }
  const [aw, ah] = table[aspectKey] ?? [16, 9]
  return alignEdge(Math.round((height * aw) / ah), 832).value
}
