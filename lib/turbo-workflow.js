/**
 * 官方 Qwen-Image 2.1 Turbo 与裁剪回贴任务工作流。
 *
 * 单独成文件有两个原因：
 *   ① config.js 已接近 DSH Store 262144 B 的单文件上限；
 *   ② 官方 8/9 步 sigma 与任务链需要独立回归，不与旧 turbo8 图混在一起。
 *
 * 本模块通过依赖注入拿 resolvePlan / pickWrapperSet / trimPrompt，
 * 避免与 config.js 形成循环 import。
 */
import { attachWorkflowMeta } from './workflow-meta.js'
import {
  loraNode, fluxShiftNode, prefixCacheNode, teSpeedNode, speedupNode, blockCacheNode, rdna3FaNode,
} from './model-chain.js'

/**
 * Sigma 出处：本机已跑通的
 * `ComfyUI-Local-Infinite-Canvas/comfyui-gateway/workflows/image-qwen21v2-{t2i,edit,remove,outpaint}.json`。
 * 8 步用于文生图；9 步是在同一个 0.414568 与终值 0 之间补 `0.150000`。
 * 不要把逗号串与 steps 分开改：两者必须成对。
 */
const OFFICIAL_TURBO_STEPS = 8
const OFFICIAL_EDIT_STEPS = 9
const OFFICIAL_TURBO_SIGMAS_8 = '1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0'
const OFFICIAL_EDIT_SIGMAS_9 = '1.0, 0.978453, 0.954180, 0.926626, 0.895080, 0.845148, 0.704534, 0.414568, 0.150000, 0'

export {
  OFFICIAL_TURBO_STEPS,
  OFFICIAL_EDIT_STEPS,
  OFFICIAL_TURBO_SIGMAS_8,
  OFFICIAL_EDIT_SIGMAS_9,
}

export function createTurboWorkflowBuilders({ resolvePlan, pickWrapperSet, trimPrompt }) {
/**
 * 0.18：通用蒸馏模型链。
 *
 * 官方 Turbo 只挂任务 LoRA；旧 turbo8 仍按 legacy 方式挂 LoRA + Flux 位移。
 * 之后统一接前缀缓存、互斥 wrapper 与 RDNA3 FlashAttention。
 *
 * @returns {{nodes:object, modelRef:string}}
 */
function buildDistilledModelChain(cfg, plan, { width, height, taskLora = '', taskStrength = 1, caps } = {}) {
  const nodes = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: plan.models.unet, weight_dtype: 'default' } },
  }
  const wrap = pickWrapperSet(cfg, plan, width, height, caps)
  let modelRef = '1'

  if (!plan.useOfficialTurbo && plan.useTurbo && plan.models.turbo8Lora) {
    nodes[31] = loraNode(modelRef, plan.models.turbo8Lora, cfg.turbo8Strength)
    modelRef = '31'
    nodes[32] = fluxShiftNode(plan, modelRef, width, height)
    modelRef = '32'
  }

  if (taskLora !== '' && taskLora !== plan.models.turbo8Lora) {
    nodes[33] = loraNode(modelRef, taskLora, taskStrength)
    modelRef = '33'
  }

  if (wrap.blockCache) {
    nodes[16] = blockCacheNode(cfg, modelRef)
    modelRef = '16'
  }

  if (plan.usePrefix) {
    nodes[7] = prefixCacheNode(cfg, modelRef)
    modelRef = '7'
  }
  if (wrap.te) {
    nodes[13] = teSpeedNode(cfg, modelRef)
    modelRef = '13'
  }
  if (wrap.speedup) {
    nodes[14] = speedupNode(cfg, modelRef)
    modelRef = '14'
  }
  if (plan.useRdna3Fa) {
    nodes[17] = rdna3FaNode(modelRef)
    modelRef = '17'
  }
  return { nodes, modelRef }
}

/**
 * 0.18：官方 Turbo 文生图 / 多图编辑工作流。
 *
 * · 无参考图：TextEncodeQwenImage21 + EmptyLatentImage，官方 8 步 sigma。
 * · 有参考图：TextEncodeQwenImageEditPlus(image1..3) + VAEEncode，9 步 sigma。
 * · CFG 固定 1.0；采样走 SamplerCustomAdvanced + ManualSigmas，不靠 scheduler 猜。
 */
function buildOfficialTurboWorkflow(cfg, plan, { prompt, negative, width, height, seed, count, references }, caps) {
  const refs = Array.isArray(references) ? references.filter((r) => typeof r === 'string' && r !== '').slice(0, 3) : []
  const withEdit = refs.length > 0
  const taskLora = withEdit ? String(plan.models.consistencyLora ?? '') : ''
  const { nodes, modelRef } = buildDistilledModelChain(cfg, plan, {
    width,
    height,
    taskLora,
    taskStrength: cfg.consistencyStrength,
    caps,
  })
  nodes[2] = { class_type: 'CLIPLoader', inputs: { clip_name: plan.models.clip, type: 'qwen_image', device: 'default' } }
  nodes[3] = { class_type: 'VAELoader', inputs: { vae_name: plan.models.vae } }

  if (withEdit) {
    const ids = [10, 18, 19]
    refs.forEach((file, i) => {
      nodes[ids[i]] = { class_type: 'LoadImage', inputs: { image: file } }
    })
    nodes[20] = {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: {
        clip: ['2', 0],
        prompt: trimPrompt(prompt, cfg),
        vae: ['3', 0],
        image1: ['10', 0],
        ...(refs[1] ? { image2: ['18', 0] } : {}),
        ...(refs[2] ? { image3: ['19', 0] } : {}),
      },
    }
    nodes[21] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } }
    nodes[22] = { class_type: 'BasicGuider', inputs: { model: [modelRef, 0], conditioning: ['20', 0] } }
  } else {
    nodes[20] = {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0],
        prompt: trimPrompt(prompt, cfg),
        negative_prompt: negative ?? '',
        resolution: Math.max(64, Math.round(Math.sqrt(width * height))),
      },
    }
    nodes[21] = {
      class_type: 'EmptyLatentImage',
      inputs: { width, height, batch_size: Math.max(1, Math.min(4, count || 1)) },
    }
    nodes[22] = {
      class_type: 'CFGGuider',
      inputs: { model: [modelRef, 0], positive: ['20', 0], negative: ['20', 1], cfg: 1 },
    }
  }

  nodes[23] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  nodes[24] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
  nodes[25] = {
    class_type: 'ManualSigmas',
    inputs: { sigmas: withEdit ? plan.officialEditSigmas : plan.officialSigmas },
  }
  nodes[26] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['23', 0],
      guider: ['22', 0],
      sampler: ['24', 0],
      sigmas: ['25', 0],
      latent_image: ['21', 0],
    },
  }
  nodes[27] = { class_type: 'VAEDecode', inputs: { samples: ['26', 0], vae: ['3', 0] } }
  nodes[28] = {
    class_type: 'SaveImage',
    inputs: { images: ['27', 0], filename_prefix: `QwenTurbo_${cfg.filePrefix}_` },
  }

  return attachWorkflowMeta(nodes, {
    __effective: { width, height, locked: false },
    __plan: {
      profile: 'official-turbo',
      steps: withEdit ? plan.officialEditSteps : plan.officialSteps,
      cfg: 1,
      taskLora,
      references: refs.length,
    },
    __cnet: { applied: false, name: '', reason: '' },
  })
}

/**
 * 0.18：裁剪 → 采样 → 回贴任务工作流。
 *
 * `mode`:
 *   · `inpaint`  —— 蒙版局部重绘，9 步 + 一致性 LoRA
 *   · `remove`   —— 蒙版元素移除，9 步 + 万物移除 LoRA
 *   · `outpaint` —— 四向扩图，9 步 + 扩图 LoRA
 *
 * 原图未修改区域由 InpaintStitchImproved 回贴，不再经过整图 VAE 解码。
 */
function buildTaskWorkflow(cfg, {
  mode = 'inpaint', image = '', mask = '', prompt = '', seed = 0,
  width = 1024, height = 1024, outLeft = 0, outRight = 0, outUp = 0, outDown = 0,
} = {}, caps) {
  if (!['inpaint', 'remove', 'outpaint'].includes(mode)) throw new Error(`未知任务模式：${mode}`)
  if (image === '') throw new Error('image 不能为空')
  if (mode !== 'outpaint' && mask === '') throw new Error(`${mode} 需要 mask`)
  const plan = resolvePlan(cfg, caps)
  const taskInfo = mode === 'remove'
    ? { lora: plan.models.removalLora, strength: Number(cfg.removalStrength ?? 1), label: '元素移除' }
    : mode === 'outpaint'
      ? { lora: plan.models.outpaintLora, strength: Number(cfg.outpaintStrength ?? 0.7), label: '图像扩展' }
      : { lora: plan.models.consistencyLora, strength: Number(cfg.consistencyStrength ?? 0.48), label: '局部重绘' }
  if (mode === 'outpaint'
    && ![outLeft, outRight, outUp, outDown].some((v) => Number(v) > 0)) {
    outRight = 50
  }
  const { nodes, modelRef } = buildDistilledModelChain(cfg, plan, {
    width,
    height,
    taskLora: taskInfo.lora,
    taskStrength: taskInfo.strength,
    caps,
  })
  nodes[2] = { class_type: 'CLIPLoader', inputs: { clip_name: plan.models.clip, type: 'qwen_image', device: 'default' } }
  nodes[3] = { class_type: 'VAELoader', inputs: { vae_name: plan.models.vae } }
  nodes[10] = { class_type: 'LoadImage', inputs: { image } }
  if (mode !== 'outpaint') {
    nodes[11] = { class_type: 'LoadImageMask', inputs: { image: mask, channel: 'red' } }
  }
  const maxEdge = Number.isFinite(cfg.taskMaxCanvasEdge) && cfg.taskMaxCanvasEdge > 0
    ? Math.trunc(cfg.taskMaxCanvasEdge) : 2048
  const ctxFactor = Number.isFinite(cfg.inpaintContextFactor) && cfg.inpaintContextFactor >= 1
    ? cfg.inpaintContextFactor : 1.3
  nodes[12] = {
    class_type: 'InpaintCropImproved',
    inputs: {
      image: ['10', 0],
      ...(mode !== 'outpaint' ? { mask: ['11', 0] } : {}),
      downscale_algorithm: 'bilinear',
      upscale_algorithm: 'bicubic',
      preresize: true,
      preresize_mode: 'ensure maximum resolution',
      preresize_min_width: 0,
      preresize_min_height: 0,
      preresize_max_width: maxEdge,
      preresize_max_height: maxEdge,
      mask_fill_holes: true,
      mask_expand_pixels: Number.isFinite(cfg.inpaintMaskGrow) ? Math.max(0, Math.trunc(cfg.inpaintMaskGrow)) : 8,
      mask_invert: false,
      mask_blend_pixels: Number.isFinite(cfg.inpaintMaskBlend) ? Math.max(0, Math.min(256, Math.trunc(cfg.inpaintMaskBlend))) : 32,
      mask_hipass_filter: 0.1,
      extend_for_outpainting: mode === 'outpaint',
      extend_up_factor: mode === 'outpaint' ? 1 + Math.max(0, Number(outUp) || 0) / 100 : 1,
      extend_down_factor: mode === 'outpaint' ? 1 + Math.max(0, Number(outDown) || 0) / 100 : 1,
      extend_left_factor: mode === 'outpaint' ? 1 + Math.max(0, Number(outLeft) || 0) / 100 : 1,
      extend_right_factor: mode === 'outpaint' ? 1 + Math.max(0, Number(outRight) || 0) / 100 : 1,
      context_from_mask_extend_factor: mode === 'outpaint' ? 1 : ctxFactor,
      output_resize_to_target_size: false,
      output_target_width: 512,
      output_target_height: 512,
      output_padding: '32',
      device_mode: 'cpu (compatible)',
    },
  }
  nodes[41] = {
    class_type: 'TextEncodeQwenImageEditPlus',
    inputs: {
      clip: ['2', 0],
      prompt,
      vae: ['3', 0],
      image1: ['12', 1],
    },
  }
  nodes[42] = { class_type: 'VAEEncode', inputs: { pixels: ['12', 1], vae: ['3', 0] } }
  nodes[43] = { class_type: 'BasicGuider', inputs: { model: [modelRef, 0], conditioning: ['41', 0] } }
  nodes[44] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  nodes[45] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
  nodes[46] = {
    class_type: 'ManualSigmas',
    inputs: { sigmas: plan.officialEditSigmas },
  }
  nodes[47] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['44', 0],
      guider: ['43', 0],
      sampler: ['45', 0],
      sigmas: ['46', 0],
      latent_image: ['42', 0],
    },
  }
  nodes[48] = { class_type: 'VAEDecode', inputs: { samples: ['47', 0], vae: ['3', 0] } }
  // 先对“生成出来的裁剪图”做颜色匹配，再回贴原图：
  // 这样只校正生成区，原图未修改区域仍由 stitcher 保持原始像素。
  let generatedImage = ['48', 0]
  const useColorMatch = cfg.taskColorMatch !== false
    && (caps === undefined || caps === null || caps.nodes?.colorMatch === true)
  if (useColorMatch) {
    nodes[49] = {
      class_type: 'ColorMatch',
      inputs: {
        image_ref: ['12', 1],
        image_target: ['48', 0],
        method: typeof cfg.taskColorMatchMethod === 'string' && cfg.taskColorMatchMethod !== ''
          ? cfg.taskColorMatchMethod : 'hm-mkl-hm',
        strength: Number.isFinite(cfg.taskColorMatchStrength) ? cfg.taskColorMatchStrength : 0.85,
        multithread: true,
      },
    }
    generatedImage = ['49', 0]
  }
  nodes[50] = {
    class_type: 'InpaintStitchImproved',
    inputs: { stitcher: ['12', 0], inpainted_image: generatedImage },
  }
  nodes[51] = {
    class_type: 'SaveImage',
    inputs: { images: ['50', 0], filename_prefix: `Qwen${taskInfo.label}_${cfg.filePrefix}_` },
  }

  return attachWorkflowMeta(nodes, {
    __effective: { width, height, locked: false },
    __plan: {
      profile: plan.useOfficialTurbo ? 'official-turbo' : plan.samplingProfile,
      steps: plan.useOfficialTurbo ? plan.officialEditSteps : OFFICIAL_EDIT_STEPS,
      sigmasSource: plan.useOfficialTurbo ? 'official-turbo' : 'compat-9step',
      cfg: 1,
      mode,
      taskLora: taskInfo.lora,
      taskStrength: taskInfo.strength,
      cropped: true,
    },
    __cnet: { applied: false, name: '', reason: '' },
  })
}


  return { buildOfficialTurboWorkflow, buildTaskWorkflow, buildDistilledModelChain }
}
