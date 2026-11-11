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
 */

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
 * 构造视频工作流。
 *
 * @param {object} caps 能力探测结果（用 `caps.nodes` 判断节点是否齐）
 * @param {object} opts { prompt, negative, width, height, frames, fps, steps?, seed, startImage?, prefix? }
 * @returns {{ workflow: object, plan: object, notes: string[] }}
 */
export function buildVideoWorkflow(caps, opts) {
  const o = opts ?? {}
  // caps.nodes 的语义：只有**明确 false** 才算"确认缺"。undefined = 没探测到，不当缺
  // （把"没测出来"当"没有"会把整条视频链误判为不可用）。真缺时 ComfyUI 提交会点名。
  const nodeMap = (caps && caps.nodes) || {}
  const missing = REQUIRED_NODES.filter((n) => nodeMap[n] === false)
  const prompt = String(o.prompt ?? '').trim()
  if (prompt === '') throw new Error('视频提示词不能为空')
  const seed = Number.isFinite(o.seed) ? Math.trunc(o.seed) : Math.floor(Math.random() * 2 ** 31)
  const frames = alignFrames(o.frames)
  const width = alignEdge(o.width, 832)
  const height = alignEdge(o.height, 480)
  const fps = Math.min(30, Math.max(8, Math.trunc(Number.isFinite(o.fps) ? o.fps : 24)))
  const steps = Number.isFinite(o.steps) && o.steps > 0 ? Math.trunc(o.steps) : DMD_STEPS
  const negative = String(o.negative ?? '').trim() || DEFAULT_NEGATIVE
  const startImage = typeof o.startImage === 'string' ? o.startImage.trim() : ''

  // 只在调用方**真给了值且被调整**时才啃嗦 —— 没给用默认值是正常路径，
  // 拿它当异常报一句只会把日志刷满。
  const notes = []
  if (Number.isFinite(o.frames) && frames.adjusted) notes.push(frames.reason)
  if (Number.isFinite(o.width) && width.adjusted) notes.push(width.reason)
  if (Number.isFinite(o.height) && height.adjusted) notes.push(height.reason)
  if (missing.length > 0) notes.push(`缺节点：${missing.join('、')}`)

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
        filename_prefix: String(o.prefix ?? 'qwen-paint/video'),
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

  return {
    workflow,
    notes,
    plan: {
      kind: 'video',
      model: WAN_ASSETS.unet,
      width: width.value,
      height: height.value,
      frames: frames.value,
      fps,
      seconds: Number((frames.value / fps).toFixed(3)),
      steps,
      cfg: 1.0,
      shift: DMD_SHIFT,
      seed,
      mode: startImage !== '' ? 'i2v' : 't2v',
      startImage,
      accel: null,
    },
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
