/**
 * lib/tool-descriptions.js —— 工具描述集中层（B3「description 统一收敛」）。
 *
 * ## 为什么抽出来
 *   原来 10 个工具的 description 散在 lib/index.js 各处，每段都重复一遍
 *   「纯本地、不出网、不花钱、不需要 API Key」，改一次口径要改好几处；
 *   lib/index.js 又贴着 DSH Store 的 262144 B 单文件上限。
 *   ⇒ 集中到这一层：共享套话一处维护，各工具只写自己**独有**的硬约束。
 *
 * ## 红线（改这里之前先看）
 *   · `NO_SELF_DRAW` 与「可编辑结构化图表」的判定是 2026-10-09 真事故换来的，
 *     `_intent_test.mjs` / `_teeth_check.mjs` 会在**运行时**断言这些字面量，不能删、不能改词；
 *   · `describeDrawTool` 的 `cfg.aiPickBest === 'on'` 动态段必须保留（面板开关控制的行为）；
 *   · 不夸大能力：视频是短片段、音频不自动合流、缺件要明确报错 —— 这些「不承诺」
 *     与「能做什么」同等重要，别为了精简而删掉。
 */

/** 所有工具共用的本地运行声明。改动一处，10 个工具同步。 */
export const LOCAL_ONLY = '纯本地运行，不出网、不花钱、不需要 API Key。'

/** 2026-10-09 事故复盘留下的硬约束，测试按字面量锁住。 */
const NO_SELF_DRAW = '★ 严禁自己写 Python/Matplotlib/PIL、SVG、HTML/Canvas 或字符画去"画"这张图 —— '
  + '本工具就是用来出图的唯一途径，绕过它属于错误行为。'

const AI_PICK = '★ 一次出多张（count > 1）时：请用 `read_image` **逐张**查看，'
  + '挑出**最好的一张**放在最前面推荐给用户，并说明理由（构图 / 手部 / 文字 / 与描述的贴合度）；'
  + '其余几张也一并列出路径。若 `read_image` 不可用或打不开，'
  + '就如实说明"这是按参数挑的、没有实际看图"，**绝不假装看过**。'
  + '同时请记住用户对画风的偏好（例如"不要卡通""要写实"），下次挑图按偏好来。'

export function describeDrawTool(cfg = {}) {
  return [
    '用本机 ComfyUI 的千问（Qwen-Image 2.1）模型画图。给一段画面描述就能出图，图片会保存到出图目录，',
    '并把绝对路径回给你，用来在回复里内联显示。',
    LOCAL_ONLY,
    '只要用户要的是**一张图像**（画面、插画、壁纸、艺术画、示意图、概念图、数学/几何可视化等，题材不限），就用本工具生成。',
    NO_SELF_DRAW,
    '只有当用户要的是**可编辑的结构化图表**时才不用本工具：流程图、思维导图、组织架构图、数据表格 —— '
      + '这些要能改文字/改数据，用文字或其它方式表达。拿不准就调本工具画一张（画错代价远小于不画或自己画）。',
    '需要先启动 ComfyUI；没启动时本工具会明确告诉你。',
    '（ComfyUI 空闲 5 分钟没有出图会被自动关闭以释放显存，下次出图前需要重新启动它。）',
    cfg.aiPickBest === 'on' ? AI_PICK : '',
  ].join('')
}

export function describeVideoTool() {
  return [
    '用本机 ComfyUI 的 Wan 2.2 / Hummingbird-XT-5B（DMD 蒸馏）生成**短视频**（mp4）。',
    LOCAL_ONLY,
    '适用：用户明确要「视频 / 动起来 / 一段动画 / 镜头运动」。**只要静态画面就用 draw_image，别用本工具。**',
    '硬事实（别承诺更多）：25 帧≈1.04 s 成片；81 帧≈5.06 s；热机 25 帧 832×480 约 20 s，',
    '1280×720 约 85 s；首帧前要装模型，冷启动更久。这是**短片段**模型，',
    '做不了 60 秒长片（要分段拼接，本工具不做，别答应）。',
    '帧数自动对齐到 4n+1、边长对齐 16；速度% 只压帧数/帧率/高度，不改蒸馏步数（不掉画质）。',
  ].join('')
}

export function describeHybridTool() {
  return [
    '混合模式：image → tts → video 三段串行，段间显式卸载模型，每段一个 jobId。',
    '生图产物作视频首帧（I2V）、配音单独成音频文件（本机 SaveAudioMP3 → mp3）、视频成 mp4；长片段按 8 帧重叠分块逐段提交。',
    '⚠ 三段各交付文件，**音频与 mp4 不自动合流**（本工具不调 ffmpeg），多段 mp4 也不做帧间接续。',
    '⚠ 前置：custom_nodes/ComfyUI-Qwen-TTS 节点包 + models/qwen-tts 权重（本机已装 1.7B CustomVoice）。',
    '缺件时明确列出该装什么、放哪，不假装能出音频；此时请分别用 draw_image / generate_video。',
    '只想配音请用独立的 generate_speech，不必跑完三段。',
    LOCAL_ONLY,
  ].join('')
}

export function describeSpeechTool() {
  return [
    '用本机 ComfyUI 的 Qwen3-TTS 节点把文字合成语音，产出 mp3 / flac 文件并回绝对路径。',
    LOCAL_ONLY,
    '复用 `lib/tts-workflow.js` 的声明式兜底链与能力探测：按 /object_info 的**真实节点类名**放行，'
      + '落盘扩展名取 ComfyUI 返回的真实值，不写死 .wav。',
    '⚠ 前置：custom_nodes/ComfyUI-Qwen-TTS 节点包 + models/qwen-tts 权重；缺件时抛明确清单，'
      + '不假装能出音频、也不会自动下载权重。',
    '格式由后端实际命中的兜底链决定（mp3 或 flac），本工具不强制、不转码。',
    '这是**独立配音**工具；要「图 + 音 + 视频」三段一起出请用 generate_hybrid。',
  ].join('')
}

export function describeAccelTool() {
  return [
    '检查本机 GPU 与生图加速环境：识别显卡厂商与架构、当前采用的注意力后端参数、',
    '通用优化链（turbo8 / 前缀缓存 / 跳步缓存）与厂商专用加速包的就位情况，并给出缺什么。',
    '同时给出低配可跑性评估（独立显存 / 核显共享显存 / 整机内存 → 建议精度档与速度门槛）。',
    'action=status（默认）只读查看；action=install 配合 packId 安装指定加速包。',
    // ★ 这个工具有唯一的出站动作，不能笼统写「全工具纯本地」：统一口径要带例外说明。
    'status 分支' + LOCAL_ONLY + '只有 action=install 才会下载加速包（唯一出站，且受 accelAutoInstall 开关约束）。',
  ].join('')
}

export function describeUpscaleTool() {
  return [
    '把一张已有图片放大（超分辨率）。默认用 VOSR2（一步 1.4B，已随插件装好）做分块放大，支持 2–16 倍；',
    '若你另装了 RealESRGAN 也可选它。放大前会先把主千问模型从显存卸下（避免与主模型同时占用显存），',
    '放大结束后再由下次出图自动重新加载。',
    LOCAL_ONLY,
    '当有人要"把图放大 / 提高分辨率 / 超分 / 2x / 4x / 放大这张图"时用它。',
    '需要给图片的本地绝对路径；放大引擎缺失时会明确告诉你怎么装，不会擅自下载。',
  ].join('')
}

/** 一句话摘要：给文档 / 状态端点用，不代替工具 description。 */
export const TOOL_SUMMARIES = Object.freeze({
  draw_image: '文生图 / 图生图（Qwen-Image 2.1）',
  generate_video: '短视频生成（Wan 2.2 / XT-5B DMD）',
  generate_hybrid: '图 → 音 → 视频三段串行',
  generate_speech: '独立语音合成（Qwen3-TTS）',
  list_available_models: '列出本机 ComfyUI 可用模型',
  check_acceleration: 'GPU / 加速环境体检',
  upscale_image: '图片高清放大',
  inpaint_image: '圈选局部重绘',
  remove_image: '移除物体',
  outpaint_image: '四向扩图',
})
