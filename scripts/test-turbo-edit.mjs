#!/usr/bin/env node
/**
 * 0.18 回归：官方 Turbo / 多图编辑 / 裁剪回贴 / 移除 / 扩图。
 *
 * 全部是纯函数干跑：不联网、不出图、不需要 ComfyUI 运行。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachWorkflowMeta, readWorkflowMeta } from '../lib/workflow-meta.js'
import {
  TASK_SPECS, buildTaskParameters, normalizeTaskInput, clipOutpaintPercent,
} from '../lib/task-specs.js'
import { runTask } from '../lib/task-runner.js'
import { normalizeReferencePaths, reconcileReferenceUploads } from '../lib/reference-inputs.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const idx = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const {
  DEFAULTS, buildWorkflow, buildTaskWorkflow, resolvePlan, planWorkflow,
  makeRemoveTool, makeOutpaintTool,
  OFFICIAL_TURBO_SIGMAS_8, OFFICIAL_EDIT_SIGMAS_9,
} = idx.__internal

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const types = (wf) => Object.entries(wf)
  .filter(([, v]) => v && typeof v === 'object' && typeof v.class_type === 'string')
  .map(([id, v]) => ({ id, type: v.class_type, inputs: v.inputs ?? {} }))
const find = (wf, type) => types(wf).find((n) => n.type === type)
const all = (wf, type) => types(wf).filter((n) => n.type === type)

const TURBO = 'qwen_image_2.1_turbo_int8_convrot.safetensors'
const CONSISTENCY = 'Qwen-功能2.1/Qwen2.1 一致性无偏移_GH_V1.0.safetensors'
const REMOVE = 'Qwen-功能2.1/Qwen2.1_万物移除Remove_GH.safetensors'
const OUTPAINT = 'Qwen-功能2.1/Qwen2.1_扩图_GH_3750.safetensors'
const caps = {
  level: 'full',
  probeFailed: false,
  nodes: {
    qwen21: true, prefixCache: true, teSpeed: true, speedup: true, blockCache: true,
    rdna3fa: true, loraOnly: true, editPlus: true, manualSigmas: true,
    samplerAdvanced: true, basicGuider: true, inpaintCrop: true, inpaintStitch: true,
    colorMatch: true, officialSampling: true,
  },
  models: {
    unet: 'qwen_image_2.1_int8_convrot.safetensors',
    officialTurbo: TURBO,
    clip: 'qwen3vl_8b_w4a8.safetensors',
    vae: 'qwen_image_2.1_vae_bf16.safetensors',
    turbo8Lora: 'turbo8_lora_step2500.safetensors',
    fast4Lora: null,
    consistencyLora: CONSISTENCY,
    removalLora: REMOVE,
    outpaintLora: OUTPAINT,
  },
  files: { unet: [TURBO], lora: [CONSISTENCY, REMOVE, OUTPAINT] },
  gpu: { name: 'AMD Radeon RX 7900 XT', vramGB: 20 },
  notes: [],
}
const cfg = { ...DEFAULTS, outputDir: path.join(ROOT, '.tmp-turbo-edit') }

console.log('\n[1] officialTurbo 计划')
{
  ok('冷启动超时 ≥ 10 分钟', DEFAULTS.timeoutMs >= 600000, String(DEFAULTS.timeoutMs))
  const plan = resolvePlan(cfg, caps)
  ok('选中官方 Turbo', plan.useOfficialTurbo === true)
  ok('不再挂 turbo8 LoRA', plan.useTurbo === false)
  ok('主模型 = 官方 Turbo', plan.models.unet === TURBO, plan.models.unet)
  ok('文生图 8 步', plan.steps === 8, String(plan.steps))
  ok('编辑 9 步', plan.officialEditSteps === 9, String(plan.officialEditSteps))
  ok('计划标签 official-turbo', plan.samplingProfile === 'official-turbo', plan.samplingProfile)
  const off = resolvePlan({ ...cfg, officialTurboEnabled: false }, caps)
  ok('officialTurboEnabled=false 会回退', off.useOfficialTurbo === false)
  const override = resolvePlan({ ...cfg, mainModelOverride: caps.models.unet }, caps)
  ok('显式主模型覆写优先', override.useOfficialTurbo === false)
  const noNodes = resolvePlan(cfg, { ...caps, nodes: { ...caps.nodes, officialSampling: false } })
  ok('缺官方采样节点会回退', noNodes.useOfficialTurbo === false)
  const noModel = resolvePlan(cfg, { ...caps, models: { ...caps.models, officialTurbo: null } })
  ok('无官方 Turbo 文件会回退', noModel.useOfficialTurbo === false)
}

console.log('\n[2] 官方 Turbo 文生图：8 步精确 sigma')
{
  const wf = buildWorkflow(cfg, { prompt: 'cat', width: 1024, height: 1024, seed: 7, count: 1 }, caps)
  const sampler = find(wf, 'SamplerCustomAdvanced')
  const sigmas = find(wf, 'ManualSigmas')
  ok('使用 SamplerCustomAdvanced', !!sampler)
  ok('KSampler 未出现（不走 simple scheduler）', !find(wf, 'KSampler'))
  ok('8 步 sigma 精确匹配', sigmas?.inputs?.sigmas === OFFICIAL_TURBO_SIGMAS_8, sigmas?.inputs?.sigmas)
  ok('计划步数 8', wf.__plan?.steps === 8, String(wf.__plan?.steps))
  ok('UNET = 官方 Turbo', find(wf, 'UNETLoader')?.inputs?.unet_name === TURBO)
  ok('无 turbo8 LoRA', !all(wf, 'LoraLoaderModelOnly').some((n) => /turbo8/iu.test(n.inputs.lora_name)))
  ok('文本编码 = TextEncodeQwenImage21', !!find(wf, 'TextEncodeQwenImage21'))
  ok('前缀缓存已接', !!find(wf, 'QwenImage21Cache'))
}

console.log('\n[3] 三参考图：EditPlus + 9 步 + 一致性 LoRA')
{
  const wf = buildWorkflow(cfg, {
    prompt: '把图二的头换到图一', width: 1024, height: 1024, seed: 8, count: 1,
    references: ['r1.png', 'r2.png', 'r3.png'],
  }, caps)
  const enc = find(wf, 'TextEncodeQwenImageEditPlus')
  const imgs = all(wf, 'LoadImage')
  const lora = find(wf, 'LoraLoaderModelOnly')
  const sig = find(wf, 'ManualSigmas')
  ok('使用 TextEncodeQwenImageEditPlus', !!enc)
  ok('载入 3 张参考图', imgs.length === 3, String(imgs.length))
  ok('image1/2/3 全部接线', !!enc?.inputs?.image1 && !!enc?.inputs?.image2 && !!enc?.inputs?.image3)
  ok('VAEEncode 生成编辑 latent', !!find(wf, 'VAEEncode'))
  ok('BasicGuider 走 CFG=1 编辑', !!find(wf, 'BasicGuider'))
  ok('9 步编辑 sigma 精确匹配', sig?.inputs?.sigmas === OFFICIAL_EDIT_SIGMAS_9, sig?.inputs?.sigmas)
  ok('计划步数 9', wf.__plan?.steps === 9, String(wf.__plan?.steps))
  ok('挂一致性 LoRA', lora?.inputs?.lora_name === CONSISTENCY, lora?.inputs?.lora_name)
}

console.log('\n[4] 局部重绘：Crop → Sample → Stitch')
{
  const wf = buildTaskWorkflow(cfg, {
    mode: 'inpaint', image: 'src.png', mask: 'mask.png', prompt: '把杯子换成红色', seed: 9,
  }, caps)
  const crop = find(wf, 'InpaintCropImproved')
  const stitch = find(wf, 'InpaintStitchImproved')
  ok('使用 InpaintCropImproved', !!crop)
  ok('使用 InpaintStitchImproved', !!stitch)
  ok('蒙版从 LoadImageMask 进入', !!find(wf, 'LoadImageMask'))
  ok('不再用整图 SetLatentNoiseMask', !find(wf, 'SetLatentNoiseMask'))
  ok('上下文扩展系数 1.3', crop?.inputs?.context_from_mask_extend_factor === 1.3)
  ok('任务 LoRA = 一致性', find(wf, 'LoraLoaderModelOnly')?.inputs?.lora_name === CONSISTENCY)
  ok('9 步 sigma', find(wf, 'ManualSigmas')?.inputs?.sigmas === OFFICIAL_EDIT_SIGMAS_9)
  ok('回贴前做 ColorMatch', !!find(wf, 'ColorMatch'))
}

console.log('\n[5] 元素移除 / 四向扩图')
{
  const remove = buildTaskWorkflow(cfg, {
    mode: 'remove', image: 'src.png', mask: 'mask.png', prompt: '移除物体', seed: 10,
  }, caps)
  ok('移除使用万物移除 LoRA', find(remove, 'LoraLoaderModelOnly')?.inputs?.lora_name === REMOVE)
  ok('移除同样走回贴', !!find(remove, 'InpaintStitchImproved'))

  const out = buildTaskWorkflow(cfg, {
    mode: 'outpaint', image: 'src.png', prompt: '自然延展', seed: 11, outRight: 50, outDown: 25,
  }, caps)
  const crop = find(out, 'InpaintCropImproved')
  ok('扩图开启 extend_for_outpainting', crop?.inputs?.extend_for_outpainting === true)
  ok('向右扩展 1.5x', crop?.inputs?.extend_right_factor === 1.5, String(crop?.inputs?.extend_right_factor))
  ok('向下扩展 1.25x', crop?.inputs?.extend_down_factor === 1.25, String(crop?.inputs?.extend_down_factor))
  ok('扩图不接蒙版（InpaintCropImproved 的 mask 是 optional，已真机验证）', !find(out, 'LoadImageMask'))
  ok('扩图使用扩图 LoRA', find(out, 'LoraLoaderModelOnly')?.inputs?.lora_name === OUTPAINT)
}

console.log('\n[6] 工具 schema 与多图参数')
{
  const p = cfg
  const outTool = makeOutpaintTool(p, () => {})
  const remTool = makeRemoveTool(p, () => {})
  ok('outpaint_image 只要求 image', JSON.stringify(outTool.parameters.required) === '["image"]')
  ok('outpaint_image 有 left/right/up/down', ['left', 'right', 'up', 'down'].every((k) => outTool.parameters.properties[k]))
  ok('remove_image 要求 image + mask', JSON.stringify(remTool.parameters.required) === '["image","mask"]')
  const drawTool = idx.__internal.makeDrawTool({ tools: { register: () => {} } }, cfg, () => {}, null, () => {})
  const refsSpec = drawTool.parameters.properties.references
  ok('draw_image 暴露 references[1..16]', refsSpec?.type === 'array' && refsSpec?.maxItems === 16, String(refsSpec?.maxItems))
  const wf = planWorkflow(cfg, { prompt: 'x', size: '1:1', references: ['r1.png', 'r2.png'] }, caps)
  ok('planWorkflow 接受 references', all(wf, 'LoadImage').length === 2, String(all(wf, 'LoadImage').length))
  const isColorErr = idx.__internal.isColorMatcherError
  ok('ColorMatch 依赖缺失可识别', isColorErr("Can't import color-matcher") === true)
  ok('普通错误不误判为 ColorMatch 缺失', isColorErr('prompt too long') === false)
  const rendered = remTool.output.render({}, { path: 'p', width: 1, height: 1, seed: 1, seconds: 1, lora: '' })
  ok('缺失任务 LoRA 时用户可见提示', String(rendered?.[0]?.text ?? '').includes('未使用任务 LoRA'))
}

console.log('\n[7] 元信息与任务配置表')
{
  const wf = attachWorkflowMeta({ 1: { class_type: 'UNETLoader', inputs: {} } }, {
    __plan: { profile: 'official-turbo' },
    __effective: { width: 64, height: 64 },
    __cnet: { applied: false },
  })
  const meta = readWorkflowMeta(wf)
  ok('元信息可读', meta.plan?.profile === 'official-turbo')
  ok('元信息不可枚举', !Object.keys(wf).includes('__plan'))
  ok('元信息不进 JSON 载荷', !JSON.stringify(wf).includes('__plan'))

  const out = TASK_SPECS.outpaint
  const normalized = normalizeTaskInput({ image: 'a.png' }, out)
  ok('扩图默认向右 50%', normalized.outRight === 50, String(normalized.outRight))
  ok('扩图默认 prompt 生效', normalized.prompt === out.promptDefault)
  ok('百分比负数夹到 0', clipOutpaintPercent(-5) === 0)
  ok('百分比超过 300 夹到 300', clipOutpaintPercent(999) === 300)
  const rem = TASK_SPECS.remove
  const remInput = normalizeTaskInput({ image: 'a.png', mask: 'm.png' }, rem)
  ok('移除默认 prompt 生效', remInput.prompt === rem.promptDefault)
  ok('任务配置表生成 schema', JSON.stringify(buildTaskParameters(rem).required) === '["image","mask"]')
}

console.log('\n[8] 任务执行器的 ColorMatch 回退')
{
  const retryCalls = []
  let submits = 0
  const fakeMeta = (profile = 'official-turbo') => attachWorkflowMeta({}, {
    __plan: { profile, steps: 9, taskLora: '' },
    __effective: { width: 64, height: 64 },
    __cnet: { applied: false },
  })
  const result = await runTask(
    { image: 'src.png', mask: 'mask.png' },
    TASK_SPECS.remove,
    { cfg, log: () => {}, signal: undefined },
    {
      ensureComfyUp: async () => {},
      probeCapabilities: async () => caps,
      uploadReference: async (_cfg, file) => `uploaded:${file}`,
      buildTaskWorkflow: (useCfg) => {
        retryCalls.push(useCfg.taskColorMatch)
        return fakeMeta()
      },
      submitAndSave: async () => {
        submits += 1
        if (submits === 1) throw new Error("Can't import color-matcher")
        return { path: 'out.png', width: 64, height: 64, seconds: 1, files: ['out.png'] }
      },
    },
  )
  ok('ColorMatch 失败会自动重跑一次', submits === 2, String(submits))
  ok('重跑时关闭 taskColorMatch', retryCalls[1] === false, String(retryCalls))
  ok('移除任务默认 prompt 进入结果', result.path === 'out.png')
}

console.log('\n[9] 参考图入参归一与部分上传')
{
  const paths = normalizeReferencePaths({ references: ['a.png', '', 'b.png', 'c.png', 'd.png'] })
  ok('过滤空项、不再截断到 3 张', paths.length === 4 && paths[0] === 'a.png', JSON.stringify(paths))
  const sixteen = Array.from({ length: 16 }, (_, i) => `r${i + 1}.png`)
  ok('恰好 16 张放行', normalizeReferencePaths({ references: sixteen }).length === 16)
  let overErr = ''
  try {
    normalizeReferencePaths({ references: [...sixteen, 'r17.png'] })
  } catch (error) { overErr = String(error?.message ?? error) }
  ok('17 张明确报错（不静默丢弃）',
    overErr.includes('最多 16 张') && overErr.includes('17 张'), overErr.slice(0, 90))
  const single = normalizeReferencePaths({ reference: 'one.png' })
  ok('旧 reference 兼容', single.length === 1 && single[0] === 'one.png')
  const partial = reconcileReferenceUploads(['a.png', 'b.png'], ['ua.png'])
  ok('部分上传保留成功项', partial.references.length === 1 && partial.warning.includes('只成功上传'))
  let threw = false
  try { reconcileReferenceUploads(['a.png'], []) } catch { threw = true }
  ok('全部上传失败直接报错', threw)
}

console.log('\n[10] 多参考图接线（issue #1：image_1 … image_16）')
{
  // ---- 官方 Turbo：1-3 张仍走 EditPlus（不为什么"统一"去换掉实测过的编辑链）----
  const wf3 = buildWorkflow({ ...cfg }, { prompt: 'p', width: 704, height: 704, seed: 1, references: ['a.png', 'b.png', 'c.png'] }, caps)
  const enc3 = find(wf3, 'TextEncodeQwenImageEditPlus')
  ok('3 张仍走 EditPlus', !!enc3 && !find(wf3, 'TextEncodeQwenImage21')?.inputs?.['images.image_1'])
  ok('3 张接到 image1..image3', ['image1', 'image2', 'image3'].every((k) => Array.isArray(enc3?.inputs?.[k])))

  // ---- 4 张：切到 2.1 原生编码器 ----
  const wf4 = buildWorkflow({ ...cfg }, { prompt: 'p', width: 704, height: 704, seed: 1, references: ['a.png', 'b.png', 'c.png', 'd.png'] }, caps)
  const enc4 = find(wf4, 'TextEncodeQwenImage21')
  ok('4 张切到 TextEncodeQwenImage21', !!enc4 && !find(wf4, 'TextEncodeQwenImageEditPlus'))
  ok('4 张接满 images.image_1..4',
    [1, 2, 3, 4].every((n) => Array.isArray(enc4?.inputs?.[`images.image_${n}`]))
    && enc4?.inputs?.['images.image_5'] === undefined)
  ok('4 张各一个 LoadImage', all(wf4, 'LoadImage').length === 4, String(all(wf4, 'LoadImage').length))
  ok('编码器拿到 clip/vae', Array.isArray(enc4?.inputs?.clip) && Array.isArray(enc4?.inputs?.vae))
  const sampler4 = find(wf4, 'SamplerCustomAdvanced')
  ok('latent 取编码节点第 3 个输出（不再 VAEEncode 第 1 张）',
    sampler4?.inputs?.latent_image?.[0] === '20' && sampler4?.inputs?.latent_image?.[1] === 2,
    JSON.stringify(sampler4?.inputs?.latent_image))
  ok('4 张仍用 9 步编辑 sigma', find(wf4, 'ManualSigmas')?.inputs?.sigmas === OFFICIAL_EDIT_SIGMAS_9
    || JSON.stringify(find(wf4, 'ManualSigmas')?.inputs?.sigmas) === JSON.stringify(OFFICIAL_EDIT_SIGMAS_9))
  ok('元信息记下编码器', readWorkflowMeta(wf4).plan?.referenceEncoder === 'qwen21-images',
    String(readWorkflowMeta(wf4).plan?.referenceEncoder))

  // ---- 16 张：槽位刚好用满 ----
  const refs16 = Array.from({ length: 16 }, (_, i) => `r${i + 1}.png`)
  const wf16 = buildWorkflow({ ...cfg }, { prompt: 'p', width: 704, height: 704, seed: 1, references: refs16 }, caps)
  const enc16 = find(wf16, 'TextEncodeQwenImage21')
  ok('16 张接满 image_1..image_16',
    Array.from({ length: 16 }, (_, i) => i + 1).every((n) => Array.isArray(enc16?.inputs?.[`images.image_${n}`])))
  ok('16 张没有多出 image_17', enc16?.inputs?.['images.image_17'] === undefined)
  ok('16 张各一个 LoadImage', all(wf16, 'LoadImage').length === 16, String(all(wf16, 'LoadImage').length))
  ok('节点号不撞车（手工数一遍）',
    new Set(types(wf16).map((n) => n.id)).size === types(wf16).length)
  let wfThrow = ''
  try {
    buildWorkflow({ ...cfg }, { prompt: 'p', references: [...refs16, 'r17.png'] }, caps)
  } catch (error) { wfThrow = String(error?.message ?? error) }
  ok('17 张在组装前就报错', wfThrow.includes('最多 16 张'), wfThrow.slice(0, 60))

  // ---- 旧链路（非官方 Turbo）也支持 16 槽位 ----
  const capsOld = { ...caps, models: { ...caps.models, officialTurbo: null } }
  const wfOld = buildWorkflow({ ...cfg }, { prompt: 'p', width: 704, height: 704, seed: 1, references: refs16.slice(0, 5) }, capsOld)
  const encOld = find(wfOld, 'TextEncodeQwenImage21')
  ok('旧链路 5 张接满 image_1..image_5',
    [1, 2, 3, 4, 5].every((n) => Array.isArray(encOld?.inputs?.[`images.image_${n}`])))
  ok('旧链路 5 张各一个 LoadImage', all(wfOld, 'LoadImage').length === 5, String(all(wfOld, 'LoadImage').length))

  // ---- 单图老写法：工作流与"只有 image_1"的旧形态一致 ----
  const wfSingle = buildWorkflow({ ...cfg }, { prompt: 'p', width: 704, height: 704, seed: 1, reference: 'one.png' }, capsOld)
  const encSingle = find(wfSingle, 'TextEncodeQwenImage21')
  ok('单图仍只接 image_1', Array.isArray(encSingle?.inputs?.['images.image_1'])
    && encSingle?.inputs?.['images.image_2'] === undefined)
  ok('单图只有一个 LoadImage', all(wfSingle, 'LoadImage').length === 1)
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
