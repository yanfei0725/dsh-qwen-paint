/**
 * lib/agent-guide.js —— 给 Agent（以及外部集成）看的「这个插件现在能干什么」。
 *
 * 目的：让 Agent 不必靠猜就知道该调哪个工具、参数怎么给、失败了该退到哪，
 * 而不是把所有工具 description 塞进一段提示词。清单由**实际注册的工具名**
 * 与**实际端点目录**合并生成，注册了却没写提示的工具会被明确标出来。
 */
export const AGENT_GUIDE_VERSION = 1

/** 每个工具的「什么时候用 / 参数要点 / 失败退路」。键名必须与注册名逐字一致。 */
export const TOOL_HINTS = Object.freeze({
  draw_image: { when: '用户要一张图（画面/插画/壁纸/示意图）', params: 'prompt, count, width, height, seed, references',
    fallback: '先看 doctor；缺模型按 list_available_models 给清单' },
  generate_video: { when: '文生视频或图生视频短片段', params: 'prompt, image, frames, fps',
    fallback: '缺视频模型走可选下载包，绝不自动下载' },
  generate_hybrid: { when: '图→音→视频混合成片', params: 'prompt, text, audio, attach_audio',
    fallback: '查 doctor 的 tts_backend / ffmpeg' },
  generate_speech: { when: '文字转语音、音色克隆', params: 'text, instruct, seed, reference_audio, reference_text',
    fallback: '音频权重不自动下载，缺件给明确清单' },
  list_available_models: { when: '确认本机到底有哪些模型', params: '无', fallback: '不需要参数' },
  check_acceleration: { when: '确认加速链与显卡档位', params: '无', fallback: '探测不到就如实降级' },
  list_generated_images: { when: '按关键词粗略找历史产物', params: 'keyword, kind, date_from, date_to, limit, offset',
    fallback: '需要按尺寸/加速链/降级过滤时改用 query_history' },
  compose_prompt: { when: '按模板组装提示词', params: 'template, vars', fallback: '模板不存在会列名' },
  batch_draw: { when: '种子×尺寸扫描，批量出图', params: 'count, seeds, sizes, prompt',
    fallback: '单张失败不中断整批；要排队控制用 manage_jobs' },
  upscale_image: { when: '高清放大', params: 'image_path, scale', fallback: '需 outputDir 内文件' },
  inpaint_image: { when: '圈选重绘 / 局部修改', params: 'image_path, mask, prompt, denoise', fallback: '草图台可生成蒙版' },
  remove_image: { when: '移除画面元素', params: 'image_path, mask', fallback: '需 outputDir 内文件' },
  outpaint_image: { when: '四向扩图', params: 'image_path, left, right, top, bottom', fallback: '需 outputDir 内文件' },
  convert_to_gif: { when: '图片序列或视频转动图', params: 'sources, fps, width, loop, duration',
    fallback: '未探测到 ffmpeg 时返回参数预览与明确原因，不假装已生成' },
  convert_media: { when: '把图片/视频/音频换成另一种格式，或动图转视频',
    params: 'source, target, format(jpg|png|webp|mp4|mkv|mov|webm|mp3|aac|wav|flac), source_kind, still, quality, crf, bitrate, fps, width, duration, loop_count',
    fallback: '跨类转换会被明确拒绝；未探测到 ffmpeg 或编码器缺失时 ok:false + 原因 + command 参数预览，原产物保留、绝不假装已转换。'
      + '想让生成物默认出某格式，先 POST /api/qwen-paint/media/formats 设 {kind,format} 预设。' },
  manage_jobs: { when: '批量任务排队 / 优先级 / 取消 / 重试 / 并发配置', params: 'action(submit|list|cancel|retry|pause|resume|config), id, priority',
    fallback: '未注入真实作业体时只记账不出图，会明确说明' },
  iterate_image: { when: '对单张图做多轮迭代优化', params: 'image_path, rounds, strategy, feedback',
    fallback: '未注入出图执行器时降级，不真出图' },
  query_history: { when: '按时间/尺寸/加速链/是否降级/冷热检索历史', params: 'date_from, date_to, min_width, accel_chain, degraded, cold, kind, limit',
    fallback: '返回脱敏字段，不含绝对路径与 prompt 全文' },
  doctor: { when: '排障第一步，不出图检查环境', params: 'detail(布尔，默认 false)',
    fallback: '未提供的探针标未检测，绝不假装通过' },
  run_dag: { when: '出图前先看链路计划 / 自适应编排', params: 'goal, available, constraints, dry_run',
    fallback: '默认 dry_run=true 只出计划；缺能力在 reasons 里写明降级' },
  list_tts_backends: { when: '用户要换语音模型 / generate_speech 想指定 backend', params: 'requested, installed',
    fallback: '未检测到节点会明确标 available:false 并给安装提示，绝不假装可用' },
  generate_music: { when: '用户要背景音乐 / BGM / 配乐', params: 'model(ace_step_15|yue2), prompt, duration_sec, lyrics, style, bpm, preset',
    fallback: '只回参数计划，不真生成音频；缺节点 degraded=true；真要出音频须自备 Worker' },
  manual_upscale: { when: '用户明确指定超分引擎 / 倍率 / 降噪 / 锐化，要自己控参数', params: 'source, target, engine, scale, model, denoise, sharpen, tile_size, vae_tile_size',
    fallback: '只回工作流草案，未注入执行器时如实降级，绝不谎称已放大' },
  manage_workers: { when: '启用 / 停止某模型的独立 Worker、显存预检、环境隔离配置',
    params: 'action(list|preflight|start|stop|enable|disable|configure|sweep|protocol), id, command, env_path, port, isolation, idle_timeout_min',
    fallback: '插件不 pip install、不拉 Docker、不下载权重；未注入探针标未检测，未注入 spawn/kill 就不启动' },
})

export const AGENT_PLAYBOOKS = Object.freeze([
  { id: 'first_draw', title: '第一次出图', steps: ['doctor', 'list_available_models', 'draw_image'] },
  { id: 'find_and_edit', title: '找回旧图再改', steps: ['query_history', 'inpaint_image'] },
  { id: 'batch_safe', title: '批量且可控', steps: ['doctor', 'manage_jobs', 'batch_draw'] },
  { id: 'iterate', title: '单图迭代', steps: ['query_history', 'iterate_image', 'draw_image'] },
  { id: 'av', title: '音画成片', steps: ['doctor', 'run_dag', 'generate_speech', 'generate_hybrid'] },
  { id: 'format_output', title: '生成物指定格式 / 格式转换',
    steps: ['draw_image', 'convert_media'],
    note: '先出图，再把产物路径作为 source 交给 convert_media；也可先 POST /media/formats 设预设，让后续生成自动后转码。' },
  { id: 'voice_clone', title: '换语音模型 + 拖入样本做音色克隆',
    steps: ['manage_workers', 'list_tts_backends', 'generate_speech'],
    note: '先用 manage_workers 做 preflight（显存预检）并配置独立环境，再用 list_tts_backends 看哪个后端探测到了，最后 generate_speech 传 backend + 样本令牌。样本是零样本参考克隆，不训练权重。' },
  { id: 'bgm', title: '生成 BGM 配乐',
    steps: ['manage_workers', 'generate_music'],
    note: '音乐模型走独立 Worker；generate_music 默认只出参数计划，不真生成音频、不自动下载权重。' },
])

/** 与实际注册清单合并；没写提示的工具会进 undocumented，方便回归抓漏。 */
export function buildAgentGuide({ tools = [], routes = [] } = {}) {
  const names = Array.isArray(tools) ? tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : []
  const hints = {}
  for (const n of names) if (TOOL_HINTS[n]) hints[n] = TOOL_HINTS[n]
  const undocumented = names.filter((n) => !TOOL_HINTS[n])
  return {
    version: AGENT_GUIDE_VERSION,
    tools: names.slice().sort(),
    hints,
    undocumented,
    playbooks: AGENT_PLAYBOOKS,
    endpoints: Array.isArray(routes) ? routes.map((r) => r.path) : [],
    rules: [
      '所有生成只在本机 ComfyUI 上进行，数据仅走 127.0.0.1 回环。',
      '探测不到的能力一律降级并给理由，绝不假装可用。',
      '未实测的性能数字不写进结论；加速链只记启用了哪条，不记倍率。',
      '错误响应已统一消毒，不含本机绝对路径 / 用户名 / 凭据。',
      '需要联网参考图检索必须逐次取得用户同意。',
    ],
  }
}

export function agentGuideRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, tools, routes, log } = deps
  return [{
    path: '/api/qwen-paint/agent-guide',
    method: 'GET',
    handler: async (req, res) => {
      if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
        respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
      }
      try {
        respondJson(res, { ok: true, ...buildAgentGuide({ tools, routes }) }, 200)
      } catch (error) {
        log?.('warn', '能力指引端点异常：' + (error?.message ?? error))
        respondJson(res, { ok: false, reason: '能力指引暂不可用（详见插件日志）' }, 500)
      }
    },
  }]
}
