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
  { path: '/qwen-paint/status.json', method: 'GET', access: 'local', desc: '状态点根路径回退别名（与 /api/ 前缀同内容）' },
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
  { path: '/api/qwen-paint/history/thumb', method: 'POST', access: 'local', desc: '生成历史：回写浏览器生成的缩略图（webp/jpeg/png，≤128 KB）' },
  { path: '/api/qwen-paint/config/options', method: 'GET', access: 'local', desc: '显存 / 缓存 / 进度档位清单与当前值（只读，档位由 DSH 插件配置决定）' },
  { path: '/api/qwen-paint/preferences/reset', method: 'POST', access: 'local', desc: '清空偏好覆盖项回内置默认（原文件改名 .bak 保留，不删）' },
  { path: '/api/qwen-paint/cache-report', method: 'GET', access: 'local', desc: '指定 prompt_id 的缓存命中与耗时（ComfyUI 节点级口径）' },
  { path: '/api/qwen-paint/draft', method: 'POST', access: 'local', desc: '草图台落盘：data_url 三道闸后写进 qwen-paint-drafts（不进历史库）' },
  { path: '/api/qwen-paint/workflows', method: 'GET', access: 'local', desc: '工作流清单总览：节点数 / 必载加载器 / 可绑预设 / 校验结果' },
  { path: '/api/qwen-paint/params', method: 'GET', access: 'local', desc: '某条链的参数表，逐行标注来源（你指定 / 默认 / 已对齐 / 链路固定）' },
  { path: '/api/qwen-paint/subtitle', method: 'GET', access: 'local', desc: '字幕编排：脚本文案 → SRT/VTT；语音转写缺件时给安装清单' },
  { path: '/api/qwen-paint/video/post', method: 'GET', access: 'local', desc: '视频后处理计划（按声明的 ffmpeg / 节点现状算哪几步能跑）' },
  { path: '/api/qwen-paint/vram-advice', method: 'GET', access: 'local', desc: '显存档位建议（读 /system_stats；只建议不改配置）' },
  { path: '/api/qwen-paint/contracts', method: 'GET', access: 'local', desc: '生图/TTS 链契约对账（A1）：角色与参数约束；build=1 真构图核对' },
  { path: '/api/qwen-paint/eta', method: 'GET', access: 'local', desc: '本机实测秒数（E27）：/history 时间戳分组中位数；没样本就是 null' },

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

  // —— 媒体转换 / 实验室（0.33 新增）——
  { path: '/api/qwen-paint/media/gif', method: 'POST', access: 'local', desc: '图片序列 / 视频转 GIF（未探测到 ffmpeg 时只回参数预览与原因）' },
  { path: '/api/qwen-paint/media/gif/capabilities', method: 'GET', access: 'local', desc: 'GIF 转换能力探测（ffmpeg 未注入则如实标未检测）' },
  { path: '/api/qwen-paint/media/convert', method: 'POST', access: 'local', desc: '媒体格式转换：图片 JPG/PNG/WebP、视频 MP4/MKV/MOV/WebM、音频 MP3/AAC/WAV/FLAC；支持动图转视频与用户自有素材（未探测到 ffmpeg 时如实降级）' },
  { path: '/api/qwen-paint/media/formats', method: 'GET, POST', access: 'local', desc: '格式清单 + ffmpeg 能力探测 + 生成物输出格式预设（GET 读 / POST 设置或清除，预设只存进程内存）' },

  // —— 历史管理：可删改 / 冷热分离 / 参数化查询 ——
  { path: '/api/qwen-paint/history/query', method: 'GET', access: 'local', desc: '标准化历史查询：时间 / 尺寸 / 加速链 / 降级 / 冷热过滤' },
  { path: '/api/qwen-paint/history/update', method: 'POST', access: 'local', desc: '改历史记录白名单字段（prompt / model / kind 等）' },
  { path: '/api/qwen-paint/history/restore', method: 'POST', access: 'local', desc: '恢复被软删除的记录' },
  { path: '/api/qwen-paint/history/purge', method: 'POST', access: 'local', desc: '按时间 / 类型批量软删除（磁盘文件不动）' },
  { path: '/api/qwen-paint/history/archive', method: 'POST', access: 'local', desc: '冷热分离：把老记录标 cold（不搬动磁盘文件）' },
  { path: '/api/qwen-paint/history/hard-delete', method: 'POST', access: 'local', desc: '真删数据库记录（默认绝不删磁盘文件）' },
  { path: '/api/qwen-paint/history/export.jsonl', method: 'GET', access: 'local', desc: '导出脱敏统计字段（JSON Lines，不含路径 / prompt 全文）' },

  // —— 自诊断 / Agent 能力指引 ——
  { path: '/api/qwen-paint/doctor', method: 'GET', access: 'local', desc: '运行期自诊断：默认一行摘要，?detail=1 才展开逐项详情' },
  { path: '/api/qwen-paint/agent-guide', method: 'GET', access: 'local', desc: 'Agent 能力指引：工具用途 / 参数 / 失败退路 / 编排剧本' },
  { path: '/api/qwen-paint/accel/chain', method: 'GET', access: 'local', desc: '加速链全景：生图/视频缓存后端 + TTS 加速 + 注意力/编译后端（SageAttention / Comfy-WaveSpeed）+ 显存预算 + 配置裁决 + 结构化日志；未传 installed 时自动读本机 /object_info 全量节点表并在 probe 里写明来源，失败如实降级（未实测不写倍率）' },
  { path: '/api/qwen-paint/events', method: 'GET, POST', access: 'local', desc: '结构化事件日志（JSON Lines）：GET 统计摘要 + 最近事件 / POST 上报一次生成事件（尺寸 / 加速链 / 降级原因 / 耗时分解，脱敏）' },
  { path: '/api/qwen-paint/vram-budget', method: 'GET, POST', access: 'local', desc: '按子任务设显存上限（0/2/4/8/12/16/24 GB 或无上限）；预算建议，非精确配额' },
  { path: '/api/qwen-paint/config/conflicts', method: 'GET', access: 'local', desc: '配置项矛盾只读报告 + 裁决建议（只报告，不自动改用户配置）' },

  // —— 语音 / 音乐 / 手动超分 / Worker（0.33 之后本地批次，未发布）——
  { path: '/api/qwen-paint/tts/backends', method: 'GET', access: 'local', desc: 'TTS 后端清单：Qwen3-TTS / GPT-SoVITS v5 dev / turbo / IndexTTS2，含真实探测状态（未检测到明确标不可用）' },
  { path: '/api/qwen-paint/audio/samples', method: 'GET, POST', access: 'local', desc: '拖入音频样本：登记 / 列出 / 删除；零样本参考音色克隆，不训练权重、不回吐绝对路径' },
  { path: '/api/qwen-paint/music/models', method: 'GET', access: 'local', desc: '音乐 BGM 模型清单：ACE-Step 1.5 / YuE2 + 风格预设 + 探测状态' },
  { path: '/api/qwen-paint/music/generate', method: 'POST', access: 'local', desc: '音乐 BGM 统一输入 → 参数计划 + Adapter 候选映射（不真提交、不真生成音频）' },
  { path: '/api/qwen-paint/upscale/manual/capabilities', method: 'GET', access: 'local', desc: '手动超分能力：引擎 / 倍率档位 / 参数说明' },
  { path: '/api/qwen-paint/upscale/manual', method: 'POST', access: 'local', desc: '手动超分：用户显式参数 → 工作流草案（未注入执行器时只回参数预览与降级理由）' },
  { path: '/api/qwen-paint/workers', method: 'GET, POST', access: 'local', desc: '主控端 + 独立 Worker：清单 / 显存预检 / 启停 / 配置 / 空闲回收 / 统一协议（不 pip install、不拉镜像、不下载权重）' },
  { path: '/api/qwen-paint/workers/vram', method: 'GET', access: 'local', desc: '显存预检：数值只来自注入探针，未注入时如实标未检测，不猜测 GB 数' },
  { path: '/api/qwen-paint/accel/backends', method: 'GET, POST', access: 'local', desc: '注意力 / 编译加速后端：SageAttention（8-bit）、Comfy-WaveSpeed（First Block Cache + torch.compile）已并入加速链；GET 看清单与工作流补丁，POST 只写进程内存启用项（重启回默认），生成时按真实 /object_info 类名接进模型链；倍率标 unverified，节点槽位未核实' },

  { path: '/api/qwen-paint/vectorize/capabilities', method: 'GET', access: 'local', desc: '矢量化能力：vtracer（彩色，MIT，官方 Release 单源下载、默认不装）/ potrace（黑白线稿，GPL-2.0+，用户自备 exe）；输入限出图目录' },
  { path: '/api/qwen-paint/vectorize', method: 'POST', access: 'local', desc: '位图 → SVG 矢量化：vtracer 彩色 / potrace 黑白线稿；SVG 落出图目录内；引擎未安装时如实降级' },

  // —— 口语入口 / 参考图色调 / 资源需求声明（0.34.0 之后接线批次）——
  { path: '/api/qwen-paint/entry/aliases', method: 'GET', access: 'local', desc: '口语入口别名全表（「风格卡」「批量出图」「历史」「配音」等）+ 体检：别名只能指向已注册工具，指错会进 errors，不新增影子工具' },
  { path: '/api/qwen-paint/tone/extract', method: 'POST', access: 'local', desc: '参考图主色调提取：接收浏览器 canvas 采样后的 RGBA 像素数组（32×32，上限 4096 个值）→ 主色名 / 冷暖 / 饱和度 / 明度 / 可写进提示词的一句话；只做色调，不猜构图与光影，Node 侧不解码图片' },
  { path: '/api/qwen-paint/run/resources', method: 'GET', access: 'local', desc: '提交前资源需求声明：按输出像素数给相对档位（轻量/中等/偏重）、是否独占模型；?live_eta=1 时读本机 ComfyUI /history 拿实测 ETA，没有样本就是 null，绝不编秒数' },
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
