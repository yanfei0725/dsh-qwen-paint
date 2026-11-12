/**
 * lib/mode-schema.js —— 通用 Comfy 控制层的唯一真相源（host 侧 ESM）。
 *
 * 前端是 <script defer> / window.__ModuleLoader__ 非 ESM 单入口，不能 import ESM，
 * 且 lib/ 不经 web 暴露。host 侧 import 本模块后，经
 * GET /api/comfy-pipeline/schema 把 buildSchemaSnapshot() 的 JSON 快照下发；
 * 前端 fetch 一次挂到 window.ComfyPipelineSchema，UI 只读这份快照。
 *
 * 来源：桌面《dsh-comfy-pipeline-通用Comfy优化控制-操作流程报告》v3
 *   §6    :219-258  MODES / CONTROLS / SPEED_MAP / SPEED_TIERS / quantizeSpeedPercent
 *   §9    :354      ETA 公式；:359 修订 #1（方向正比于实际计算量）
 *   §15.4 :942      第 1 步（ETA 方向 + 16→4 档量化）；:944 第 3 步（schema 桥接）
 *
 * 本文件不 import 任何模块，纯数据 + 纯函数，避免与 index.js / config.js 循环依赖。
 */
export const MODES = [
  { id:'image',  label:'生图模式', backends:['qwen21','sdxl'],           deliver:'png' },
  { id:'video',  label:'视频模式', backends:['wan22','ltxv','framepack'], deliver:'mp4' },
  { id:'hybrid', label:'混合模式', chain:['image','tts','video'],        deliver:'mp4+audio' },
]
export const CONTROLS = {
  common: [
    // ⚠ ticks 必须与 lib/config.js 的 ASPECTS 键**同源同序**（7 项），否则滑块拨到
    //   「2:3」会被算成「16:9」——同一份画幅表两处各写一份，迟早跑偏。
    { key:'aspect',       type:'slider', min:0,max:6,step:1,  ticks:['1:1','3:4','4:3','2:3','3:2','16:9','9:16'], default:0 },
    { key:'speedPercent', type:'slider', min:25,max:100,step:5,default:100, hint:'画质/尺寸换时间；16 档经 quantizeSpeedPercent 吸附到 4 档' },
    // ★ 0.19.2：负面提示词升为一级可调控制项（之前只藏在风格包的 negative 里）。
    //   自由文本，不进画幅/速度那套数字 clamp；长度上限与 style-library 的 stylePrefix 一致（300）。
    { key:'negative', type:'text', default:'', max:300, label:'负面提示词', hint:'不想出现的东西：blurry、多余文字、畸变等。留空用模型默认。' },
  ],
  video: [
    { key:'motion',   type:'slider', min:0,max:100,step:5,   default:50 },
    { key:'duration', type:'slider', min:1,max:10,step:0.5,  default:4  },
    { key:'frames',   type:'slider', min:9,max:161,step:8,   default:49 },
  ],
  advanced: [   // 全部藏进 <details>「高级设置」
    // ⚠ min 必须是 -1：面板用 **-1 = 每次随机**（与 draw_image 的 seed 缺省语义一致）。
    //   若把下界写成 0，用户选「随机」会被 clamp 成 seed=0 —— 每次都出同一张图。
    { key:'seed',    type:'number', min:-1,max:2**32-1, default:-1 },
    { key:'count',   type:'number', min:1,max:4,step:1, default:1 },
    { key:'fps',     type:'slider', min:8,max:30,step:1, default:24 },
    { key:'denoise', type:'slider', min:0.1,max:1,step:0.05, default:0.85 },
    { key:'steps',   type:'slider', min:4,max:40,step:1,  default:8 },
    { key:'cfg',     type:'slider', min:1,max:8,step:0.5, default:1 },
    { key:'tileSize',type:'slider', min:256,max:1024,step:128, default:512 },
    { key:'chunkOverlap', type:'slider', min:0,max:16,step:2, default:8 },
  ],
}
export const SPEED_MAP = {
  image: { 100:{size:1024,steps:8,refs:16}, 75:{size:896,steps:8,refs:8},
           50:{size:768,steps:4,refs:4},   25:{size:640,steps:4,refs:1} },
  video: { 100:{frames:81,fps:24,steps:30,height:720}, 75:{frames:49,fps:20,steps:20,height:540},
           50:{frames:25,fps:12,steps:12,height:480}, 25:{frames:17,fps:8,steps:8,height:360} },
}
// v3 修订 #2：slider 16 档（25..100 step 5）与 SPEED_MAP 4 档对齐，吸附到最近档
export const SPEED_TIERS = [25, 50, 75, 100]
export function quantizeSpeedPercent(v) {
  return SPEED_TIERS.reduce((best, t) =>
    Math.abs(t - v) < Math.abs(best - v) ? t : best, SPEED_TIERS[0])
}

/**
 * 估算 ETA（毫秒）。v3 修订 #1：ETA 正比于实际计算量。
 *   ETA = baseMs(mode) × (speed/100) × (frames/49) × (h/720)²
 * speed 先经 quantizeSpeedPercent 落到 25/50/75/100 四档之一；值越小 = 降画质/尺寸换时间 = 越快。
 * baseMs 必须由调用方给（实测基准）；本模块绝不内置编造的数字，一律标「估算」。
 */
export function estimateEtaMs({ baseMs, speed, frames = 49, height = 720 } = {}) {
  if (!Number.isFinite(baseMs) || baseMs < 0) return 0
  const tier = quantizeSpeedPercent(speed)
  const f = Number.isFinite(frames) && frames > 0 ? frames : 49
  const h = Number.isFinite(height) && height > 0 ? height : 720
  return Math.round(baseMs * (tier / 100) * (f / 49) * (h / 720) ** 2)
}

/** host 侧序列化后经 GET /api/comfy-pipeline/schema 下发；纯数据，可 JSON.stringify。 */
export function buildSchemaSnapshot() {
  return {
    version: 1,
    modes: MODES,
    controls: CONTROLS,
    speedMap: SPEED_MAP,
    speedTiers: SPEED_TIERS,
    eta: {
      formula: 'baseMs(mode) × (speed/100) × (frames/49) × (h/720)²',
      label: '估算',
    },
  }
}
