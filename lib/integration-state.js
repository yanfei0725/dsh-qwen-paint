/**
 * lib/integration-state.js —— 给外部集成看的**内部状态聚合**（纯函数，零联网零副作用）。
 *
 * ## 用户诉求
 *   「暴露更多内部状态供外部集成」。既有 `/status.json` 是给 UI 状态点用的，
 *   字段偏 UI、而且硬底线是**不含本机路径 / 模型名**。外部集成需要的是另一套：
 *   版本、工具清单、能力档位、端点目录、开关状态、任务计数、健康度。
 *
 * ## 脱敏红线（与既有审计口径一致）
 *   · **绝不**输出本机绝对路径、真实用户名、凭据、对话内容、内部状态文件；
 *   · 只输出白名单字段；调用方塞进来的任意对象一律不整体透传；
 *   · 路径类字段只留文件名（连文件名都可能带私人信息时，直接不输出）。
 *
 * ## 为什么单独一个文件
 *   lib/index.js 贴着 DSH Store 单文件上限；新端点一律外置。
 */

export const INTEGRATION_SCHEMA = 'dsh-qwen-paint/integration@1'

/**
 * 对外公开的端点目录。
 *
 * ★ 2026-11-13 审计（第一轮）：此前只登记了 21 条，而 `lib/` 里实际注册 36 条 ——
 *   少了 `/history` 三条、`/cpu-*` 两条，以及 library / skills / reference 四件套、
 *   `file`、`memory/*`、`recent-images`、`repair` 十条。外部集成照着目录调用会漏掉一半功能。
 *   现在改为**与真实注册逐条对齐**，并加双向断言（目录 ⊆ 注册 且 注册 ⊆ 目录），
 *   以后加端点忘了同步这里，回归会直接红。
 *
 * `method` 写的是**推荐调用方式**（都实测可用），不是穷举服务端接受的全部方法。
 */
export const INTEGRATION_ROUTES = Object.freeze([
  // —— 状态 / 集成 / 引导 ——
  { path: '/api/qwen-paint/status.json', method: 'GET, POST', access: 'local', desc: 'UI 状态点 / 写配置（POST 需 JSON）' },
  { path: '/api/qwen-paint/health', method: 'GET', access: 'local', desc: '健康检查' },
  { path: '/api/qwen-paint/capabilities', method: 'GET', access: 'local', desc: '探测到的节点 / 模型能力' },
  { path: '/api/qwen-paint/presets', method: 'GET', access: 'local', desc: '出图风格预设' },
  { path: '/api/qwen-paint/wizard', method: 'GET', access: 'local', desc: '就绪清单（文本向导数据源）' },
  { path: '/api/qwen-paint/repair', method: 'POST', access: 'local', desc: '一键修复（需 JSON body 且 confirm:true）' },
  { path: '/api/qwen-paint/integration/state', method: 'GET', access: 'local', desc: '本端点：聚合状态快照（脱敏）' },
  { path: '/api/qwen-paint/integration/routes', method: 'GET', access: 'local', desc: '端点目录（机器可读）' },
  { path: '/api/qwen-paint/setup-guide', method: 'GET', access: 'local', desc: '图形化安装引导的步骤与真实状态' },

  // —— 工作流 / 控制 ——
  { path: '/api/comfy-pipeline/schema', method: 'GET', access: 'local', desc: '工作流契约快照' },
  { path: '/api/comfy-pipeline/controls', method: 'GET, POST', access: 'local', desc: '控制项读取 / 修改' },
  { path: '/api/comfy-pipeline/progress', method: 'GET', access: 'local', desc: '当前任务进度' },
  { path: '/api/comfy-pipeline/modes', method: 'GET', access: 'local', desc: '可用模式（含混合模式缺件说明）' },

  // —— 素材库 / 技能 / 角色参考 ——
  { path: '/api/comfy-pipeline/library', method: 'GET, POST', access: 'local', desc: '素材库与风格（出图前的输入，不是图片库）' },
  { path: '/api/comfy-pipeline/skills', method: 'GET', access: 'local', desc: '本机可装载的 skill 清单（只读）' },
  { path: '/api/comfy-pipeline/reference', method: 'GET', access: 'local', desc: '角色参考策略协商结果' },
  { path: '/api/comfy-pipeline/reference/prefer', method: 'POST', access: 'local', desc: '记录参考策略偏好' },
  { path: '/api/comfy-pipeline/reference/search', method: 'POST', access: 'local', desc: '参考图检索（联网，默认拒绝，须逐次同意）' },
  { path: '/api/comfy-pipeline/reference/adapt', method: 'POST', access: 'local', desc: '参考图策略变换（不下载字节）' },

  // —— 生图 / 编辑 ——
  { path: '/api/qwen-paint/inpaint', method: 'POST', access: 'local', desc: '蒙版局部重绘' },
  { path: '/api/qwen-paint/quick-edit', method: 'POST', access: 'local', desc: '移除 / 扩图 / 放大' },
  { path: '/api/qwen-paint/recent-images', method: 'GET', access: 'local', desc: '最近生成的图（图片编辑台的候选）' },
  { path: '/api/qwen-paint/file', method: 'GET', access: 'local', desc: '媒体字节读取（只服务出图目录内的文件）' },
  { path: '/api/qwen-paint/mask-fx', method: 'GET, POST', access: 'local', desc: '蒙版增强参数 / 卸载内存模式' },

  // —— 生成历史 ——
  { path: '/api/qwen-paint/history', method: 'GET', access: 'local', desc: '生成历史：搜索 / 筛选 / 分页（软删除，不删磁盘文件）' },
  { path: '/api/qwen-paint/history/stats', method: 'GET', access: 'local', desc: '生成历史：各类型条数汇总' },
  { path: '/api/qwen-paint/history/delete', method: 'POST', access: 'local', desc: '生成历史：软删除一条（只改标记）' },

  // —— 记忆联动（dsh-auto-memory） ——
  { path: '/api/qwen-paint/memory/recent', method: 'GET', access: 'local', desc: '最近出图记忆（供外部记忆插件拉取）' },
  { path: '/api/qwen-paint/memory/preference', method: 'GET, POST', access: 'local', desc: '记忆偏好：GET 读 / POST 写' },

  // —— CPU 加速档 ——
  { path: '/api/qwen-paint/cpu-profile', method: 'GET', access: 'local', desc: 'CPU 画像 + 五档加速各档在本机的真实参数' },
  { path: '/api/qwen-paint/cpu-accel', method: 'POST', access: 'local', desc: '选择 CPU 加速档（重启 ComfyUI 后生效）' },

  // —— 视频 ——
  { path: '/api/qwen-paint/video/probe', method: 'POST', access: 'local', desc: '视频探测' },
  { path: '/api/qwen-paint/video/frame', method: 'POST', access: 'local', desc: '抽帧' },
  { path: '/api/qwen-paint/video/frame-save', method: 'POST', access: 'local', desc: '保存画布帧（零 ffmpeg）' },
  { path: '/api/qwen-paint/video/clip', method: 'POST', access: 'local', desc: '截取时间段' },
  { path: '/api/qwen-paint/video/replace-frame', method: 'POST', access: 'local', desc: '改好的帧贴回视频' },
])

/** 主推的三大能力，简介/文档/状态端点共用同一份口径。 */
export const HEADLINE_CAPABILITIES = Object.freeze([
  { id: 'video', label: '视频', detail: '文生视频 / 图生视频 / 图→音→视频混合模式；视频模型可选自动下载包' },
  { id: 'image', label: '生图与编辑', detail: '文生图 / 多参考图编辑 / 圈选重绘 / 元素移除 / 四向扩图 / 高清放大' },
  { id: 'tts', label: '语音合成', detail: 'Qwen3-TTS 独立工具 generate_speech；缺件给明确清单、不自动下载权重' },
])

function safeCount(v) {
  return Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0
}

/**
 * 生成脱敏状态快照。所有输入都按白名单取值，未知字段不进入输出。
 * @param {object} [snap] { version, online, tools, tier, meetsAcceptableBar,
 *   speedTargetSec, unverified, memoryMode, unloadCount, tasks, queue,
 *   capabilities, maskFx, videoPack, setupGuideReady, enabled, imageBackend,
 *   comfyLocalOnly } —— 后者由 host 按 cfg.allowRemoteComfy 现算，缺省仍为 true
 */
export function buildIntegrationState(snap = {}) {
  const s = (snap && typeof snap === 'object' && !Array.isArray(snap)) ? snap : {}
  const tools = Array.isArray(s.tools)
    ? s.tools.filter((t) => typeof t === 'string' && /^[a-z][a-z0-9_]{1,48}$/u.test(t)).slice(0, 64)
    : []
  const caps = Array.isArray(s.capabilities)
    ? s.capabilities.filter((c) => c && typeof c === 'object')
      .slice(0, 16)
      .map((c) => ({ id: String(c.id ?? '').slice(0, 32), label: String(c.label ?? '').slice(0, 64) }))
    : HEADLINE_CAPABILITIES.map((c) => ({ id: c.id, label: c.label }))
  return {
    ok: true,
    schema: INTEGRATION_SCHEMA,
    version: String(s.version ?? '').slice(0, 32),
    headline: '视频 / 生图 / TTS 全能 · 本机运行',
    capabilities: caps,
    service: {
      enabled: s.enabled !== false,
      online: s.online === true,
      imageBackend: ['comfyui', 'hipfire'].includes(s.imageBackend) ? s.imageBackend : 'comfyui',
      // ★ 2026-11-13 审计修复：不再是写死的 true。用户显式开启 allowRemoteComfy 时，
      //   插件确实可以连非回环 ComfyUI —— 快照必须如实反映当前配置，不能靠声明蒙混。
      comfyLocalOnly: s.comfyLocalOnly !== false,
    },
    tools: { registered: tools, count: tools.length },
    routes: { count: INTEGRATION_ROUTES.length, localOnly: true },
    performance: {
      tier: String(s.tier ?? '').slice(0, 32),
      meetsAcceptableBar: s.meetsAcceptableBar === true,
      speedTargetSec: Number.isFinite(Number(s.speedTargetSec)) ? Number(s.speedTargetSec) : null,
      unverified: s.unverified !== false,
    },
    memory: {
      mode: ['off', 'auto', 'manual'].includes(s.memoryMode) ? s.memoryMode : 'off',
      unloadCount: safeCount(s.unloadCount),
      lastUnloadOk: s.lastUnloadOk === true,
    },
    tasks: {
      active: safeCount(s.active),
      completed: safeCount(s.completed),
      failed: safeCount(s.failed),
      queueRunning: safeCount(s.queueRunning),
      queuePending: safeCount(s.queuePending),
    },
    maskFx: {
      feather: safeCount(s.maskFx?.feather),
      edgeBlend: safeCount(s.maskFx?.edgeBlend),
      grow: safeCount(s.maskFx?.grow),
      invert: s.maskFx?.invert === true,
      unloadMemory: s.maskFx?.unloadMemory === true,
    },
    packs: {
      videoModels: { available: true, autoDownload: 'opt-in', flag: '--video-models' },
      igpuModels: { available: true, autoDownload: 'opt-in', flag: '--igpu-download' },
      audioModels: { available: false, autoDownload: 'manual', note: '缺件给清单，不自动下载权重' },
    },
    setupGuide: { available: true, ready: s.setupGuideReady === true },
    privacy: {
      sanitized: true,
      note: '本快照不含本机绝对路径、真实用户名、凭据、对话内容或内部状态文件。',
    },
  }
}

/** 端点目录（机器可读），供外部集成自行发现，不依赖抓网页。 */
export function buildRouteCatalog() {
  return {
    ok: true,
    schema: `${INTEGRATION_SCHEMA}/routes`,
    count: INTEGRATION_ROUTES.length,
    localOnly: true,
    routes: INTEGRATION_ROUTES.map((r) => ({ ...r })),
  }
}
