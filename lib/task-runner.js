/**
 * 任务工具的编排层：校验入参、上传、构建工作流、提交，并在 ColorMatch
 * 依赖缺失时摘掉该节点重跑一次。工具工厂只负责注册，不再承载执行细节。
 */
import { readWorkflowMeta } from './workflow-meta.js'
import { normalizeTaskInput } from './task-specs.js'
import { workflowOverridesForMaskFx } from './mask-fx.js'
import { OFFICIAL_EDIT_SIGMAS_9 } from './turbo-workflow.js'

/** ColorMatch 节点存在但 Python 依赖缺失时，ComfyUI 的报错特征。 */
export function isColorMatcherError(err) {
  return /color.?matcher|ColorMatch/iu.test(String(err?.message ?? err ?? ''))
}

export async function runTask(args, spec, ctx, deps) {
  const { cfg, log, signal } = ctx
  const input = normalizeTaskInput(args, spec)

  await deps.ensureComfyUp(cfg, log, signal)
  const caps = await deps.probeCapabilities(cfg, log, signal)
  const missing = []
  if (caps?.nodes?.editPlus !== true) missing.push('TextEncodeQwenImageEditPlus')
  if (caps?.nodes?.inpaintCrop !== true) missing.push('InpaintCropImproved')
  if (caps?.nodes?.inpaintStitch !== true) missing.push('InpaintStitchImproved')
  if (caps?.nodes?.officialSampling !== true) missing.push('ManualSigmas + SamplerCustomAdvanced')
  if (caps?.nodes?.basicGuider !== true) missing.push('BasicGuider')
  if (missing.length > 0) {
    throw new Error(`缺少裁剪回贴/官方采样节点：${missing.join('、')}。`
      + '请更新 ComfyUI 或安装 ComfyUI-Inpaint-CropAndStitch 后重启 ComfyUI。')
  }

  const [imageRef, maskRef] = await Promise.all([
    deps.uploadReference(cfg, input.image, signal),
    spec.requiresMask ? deps.uploadReference(cfg, input.mask, signal) : Promise.resolve(''),
  ])
  const taskArgs = {
    mode: spec.mode,
    image: imageRef,
    mask: maskRef,
    prompt: input.prompt,
    seed: input.seed,
    outLeft: input.outLeft,
    outRight: input.outRight,
    outUp: input.outUp,
    outDown: input.outDown,
  }
  // ★ 2026-11-13：蒙版精修参数在这里真正落到工作流节点上。
  //   没带 maskFx 时 workflowOverridesForMaskFx 原样返回 cfg（同一个引用），默认零漂移。
  const sigmaText = typeof cfg.officialEditSigmas === 'string' && cfg.officialEditSigmas.trim() !== ''
    ? cfg.officialEditSigmas : OFFICIAL_EDIT_SIGMAS_9
  const workflowCfg = workflowOverridesForMaskFx(args?.maskFx, cfg, sigmaText)
  let workflow = deps.buildTaskWorkflow(workflowCfg, taskArgs, caps)
  const taskLora = readWorkflowMeta(workflow).plan?.taskLora ?? ''
  const plan = readWorkflowMeta(workflow).plan
  log('info', `${spec.label}：官方Turbo=${plan?.profile === 'official-turbo'} `
    + `steps=${plan?.steps} lora=${taskLora || '(无)'} seed=${input.seed}`)
  let value
  try {
    value = await deps.submitAndSave(cfg, log, signal, workflow, { prefix: spec.prefix })
  } catch (error) {
    const msg = String(error?.message ?? error)
    // ColorMatch 节点在、但 Python 依赖 color-matcher 没装时，节点会运行期报错。
    // 摘掉颜色匹配重跑，保证主任务能出图，并如实说明。
    if (cfg.taskColorMatch !== false && isColorMatcherError(msg)) {
      log('warn', `颜色匹配不可用（${msg.slice(0, 160)}）→ 摘掉 ColorMatch 重跑，原图区域仍走回贴`)
      workflow = deps.buildTaskWorkflow({ ...workflowCfg, taskColorMatch: false }, taskArgs, caps)
      value = await deps.submitAndSave(cfg, log, signal, workflow, { prefix: spec.prefix })
    } else {
      throw error
    }
  }
  return { ...value, seed: input.seed, lora: taskLora, taskLoraUsed: taskLora !== '', taskLora: taskLora || null }
}
