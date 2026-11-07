/**
 * 局部重绘 / 元素移除 / 四向扩图的唯一配置表。
 *
 * 工具的 schema、默认 prompt、是否需要 mask、LoRA 键、扩图默认方向都从这里生成；
 * `makeTaskTool` 只保留注册与执行编排，不再写三套分支。
 */

export const TASK_SPECS = {
  inpaint: {
    mode: 'inpaint',
    name: 'inpaint_image',
    label: '局部重绘',
    prefix: 'inpaint',
    requiresMask: true,
    requiresPrompt: true,
    outpaint: false,
    promptDefault: '',
    promptDescription: '编辑指令，描述蒙版区域要变成什么。',
    loraKey: 'consistencyLora',
    strengthKey: 'consistencyStrength',
    description: '局部重绘 / 图片编辑：给一张图 + 一句编辑指令 + 一张蒙版（白=要改、黑=保留），'
      + '只重绘蒙版区域，其余区域由原图回贴。使用官方 Turbo 9 步 + 裁剪上下文 + 一致性 LoRA（若已安装），'
      + '不再整图 VAE 往返，也不需要任何额外 Inpainting 权重。纯本地、不出网。',
  },
  remove: {
    mode: 'remove',
    name: 'remove_image',
    label: '元素移除',
    prefix: 'remove',
    requiresMask: true,
    requiresPrompt: false,
    outpaint: false,
    promptDefault: '移除蒙版选中的物体，并无缝补全背景、光影和纹理。',
    promptDescription: '可选补充说明；留空自动使用「移除选中区域并无缝补全背景」。',
    loraKey: 'removalLora',
    strengthKey: 'removalStrength',
    description: '元素移除：给一张图 + 蒙版（白=要移除的区域），自动移除选中物体并补全背景。'
      + '使用官方 Turbo 9 步 + 万物移除 LoRA（若已安装），蒙版外由原图回贴。',
  },
  outpaint: {
    mode: 'outpaint',
    name: 'outpaint_image',
    label: '图像扩展',
    prefix: 'outpaint',
    requiresMask: false,
    requiresPrompt: false,
    outpaint: true,
    promptDefault: '自然延展画面，保持主体、光影、材质和透视一致，不添加无关元素。',
    promptDescription: '扩展区域的内容描述；留空使用通用无缝延展提示词。',
    loraKey: 'outpaintLora',
    strengthKey: 'outpaintStrength',
    description: '四向扩图：把画布向左/右/上/下扩展指定百分比，生成缺失区域并回贴原图。'
      + '使用官方 Turbo 9 步 + 扩图 LoRA（若已安装）；未指定方向时默认向右扩 50%。',
  },
}

export const TASK_TOOL_NAMES = Object.values(TASK_SPECS).map((spec) => spec.name)

export function clipOutpaintPercent(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(300, Math.round(n)))
}

export function taskDirections(args, spec) {
  return {
    outLeft: clipOutpaintPercent(args?.left),
    outRight: clipOutpaintPercent(args?.right, spec.outpaint ? 50 : 0),
    outUp: clipOutpaintPercent(args?.up),
    outDown: clipOutpaintPercent(args?.down),
  }
}

export function buildTaskParameters(spec) {
  const properties = spec.outpaint
    ? {
      image: { type: 'string', description: '要扩展的图片本地绝对路径。' },
      prompt: { type: 'string', description: spec.promptDescription },
      seed: { type: 'integer', description: '随机种子，不填随机。' },
      left: { type: 'number', description: '向左扩展百分比，0-300，默认 0。' },
      right: { type: 'number', description: '向右扩展百分比，0-300，默认 50。' },
      up: { type: 'number', description: '向上扩展百分比，0-300，默认 0。' },
      down: { type: 'number', description: '向下扩展百分比，0-300，默认 0。' },
    }
    : {
      image: { type: 'string', description: '要编辑/移除的图片本地绝对路径。' },
      mask: { type: 'string', description: '蒙版图片本地绝对路径：白色=要改/要移除，黑色=保留。' },
      prompt: { type: 'string', description: spec.promptDescription },
      seed: { type: 'integer', description: '随机种子，不填随机。' },
    }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: spec.requiresMask ? ['image', 'mask'] : ['image'],
  }
}

export function normalizeTaskInput(args, spec) {
  const image = String(args?.image ?? '').trim()
  const mask = String(args?.mask ?? '').trim()
  if (image === '') throw new Error('image 不能为空：请给要处理的图片本地路径。')
  if (spec.requiresMask && mask === '') throw new Error('mask 不能为空：白=要修改的区域，黑=保留。')
  const prompt = String(args?.prompt ?? '').trim() || spec.promptDefault
  if (spec.requiresPrompt && prompt === '') throw new Error('prompt 不能为空：请描述希望蒙版区域变成什么。')
  const seed = Number.isFinite(args?.seed) ? Math.trunc(args.seed) : Math.floor(Math.random() * 2 ** 31)
  return { image, mask, prompt, seed, ...taskDirections(args, spec) }
}
