#!/usr/bin/env node
/**
 * 0.18 回归：官方 Turbo / 多图编辑 / 裁剪回贴 / 移除 / 扩图。
 *
 * 全部是纯函数干跑：不联网、不出图、不需要 ComfyUI 运行。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const plan = resolvePlan(cfg, caps)
  ok('选中官方 Turbo', plan.useOfficialTurbo === true)
  ok('不再挂 turbo8 LoRA', plan.useTurbo === false)
  ok('主模型 = 官方 Turbo', plan.models.unet === TURBO, plan.models.unet)
  ok('文生图 8 步', plan.steps === 8, String(plan.steps))
  ok('编辑 9 步', plan.officialEditSteps === 9, String(plan.officialEditSteps))
  ok('计划标签 official-turbo', plan.samplingProfile === 'official-turbo', plan.samplingProfile)
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
  ok('扩图不接蒙版', !find(out, 'LoadImageMask'))
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
  ok('draw_image 暴露 references[1..3]', refsSpec?.type === 'array' && refsSpec?.maxItems === 3)
  const wf = planWorkflow(cfg, { prompt: 'x', size: '1:1', references: ['r1.png', 'r2.png'] }, caps)
  ok('planWorkflow 接受 references', all(wf, 'LoadImage').length === 2, String(all(wf, 'LoadImage').length))
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 项失败`}（${pass} 项）`)
process.exit(fail === 0 ? 0 : 1)
