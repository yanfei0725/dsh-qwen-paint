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
  video_trim_crop: { when: '按秒截取视频或裁掉画面边角', params: 'source, target, start, end, crop{w,h,x,y}, force_reencode',
    fallback: '无裁剪时 -c copy 按关键帧切、时间近似；带 crop 或 force_reencode 时重编码。未探测到 ffmpeg 只回参数预览。' },
  video_prores_export: { when: '把视频导出成 Apple ProRes 供剪辑软件使用', params: 'source, target, profile(proxy|lt|standard|hq|4444)',
    fallback: 'prores_ks 编码器缺失时 ok:false + 原因，不伪造 MOV 文件。' },
  probe_community_features: { when: '只读确认 VAE dtype / Comfy MCP 前提 / Wan2.2 5B 是否真的可用', params: 'feature(vae_dtype|comfy_mcp|wan22_5b)',
    fallback: '只查 object_info 与注入的模型文件名；没证据就写需实测，不下载模型、不装付费节点、不 patch 第三方节点。' },
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
  manual_upscale: { when: '用户明确指定超分引擎 / 倍率 / 降噪 / 锐化，要自己控参数', params: 'source, target, engine(comfy系|realesrgan-ncnn-vulkan|realcugan-ncnn-vulkan), scale, model, denoise, sharpen, tile_size, vae_tile_size, gpu_id, format',
    fallback: 'engine 选 Vulkan 直跑且 cfg.vulkanUpscalePath 已配置时真实执行（不经 ComfyUI）；否则只回工作流草案如实降级，绝不谎称已放大' },
  vectorize_image: { when: '用户要把位图（出图 / 自有素材）变成可编辑 SVG 矢量图', params: 'source, target, engine(vtracer|potrace), preset(bw|poster|photo), mode(pixel|polygon|spline), filter_speckle, color_precision, gradient_step, turdsize',
    fallback: '引擎未安装/未配置时如实降级；potrace 只吃 bmp/pbm/pgm/ppm 黑白位图，彩色图用 vtracer；SVG 落出图目录内' },
  mix_narration: { when: '用户要把多段旁白音频铺到时间轴、配 BGM 自动压低、并产出 SRT 字幕', params: 'items[{file, text?, duration_ms?}], bgm?, target, srt_target?, gap_ms?, duck_threshold?, duck_ratio?',
    fallback: 'ffmpeg/ffprobe 未探测到时如实降级；SRT 时间码来自实际时间轴；输入输出全部围栏在出图目录' },
  make_pptx: { when: '用户要快速生成大纲级 PPTX 草稿（标题 + 要点列表）', params: 'title, slides[{title, bullets[]}], target(.pptx)',
    fallback: '纯 JS 零依赖零 GPU，永远可执行；大纲级纯文本（无图片 / 主题美化），Office/WPS 兼容性 unverified' },
  manage_workers: { when: '启用 / 停止 / 温存 / 唤醒某模型的独立 Worker、按需驱逐释放显存、显存预检、环境隔离配置',
    params: 'action(list|preflight|start|stop|park|wake|evict|enable|disable|configure|sweep|protocol), id, command, env_path, port, isolation, idle_timeout_min',
    fallback: '插件不 pip install、不拉 Docker、不下载权重；未注入探针标未检测，未注入 spawn/kill 就不启动' },
  resolve_entry: { when: '用户说了个"像工具但不在清单里"的口语词（风格卡 / 批量出图 / 历史 / 配音 / 放大）',
    params: 'entry, action(list 列全表)',
    fallback: '别名只做参数预置不改语义；指向未注册工具会明确报错，不新增影子工具' },
  plan_timeline: { when: '文生视频要按秒安排画面，且**没有**配音锚点',
    params: 'seconds, step(默认 2), labels',
    fallback: '只是建议骨架不是硬约束；有配音时必须改用真实音频时长排轴，两者不可混用' },
  describe_resource_needs: { when: '提交前想知道这单重不重 / 要不要腾显存',
    params: 'kind(image|video|tts|upscale), width, height, frames, scale, steps, calibration',
    fallback: '只给相对档位与是否独占模型；没有本机同类实测就 est_seconds=null，绝不编秒数' },
  privacy_summary: { when: '用户问"有没有出网 / 花不花钱 / 数据去哪了"',
    params: 'comfy_url, request_urls, models, seconds, prompt_id',
    fallback: 'external_network 按真实 URL 清单算出来，不写死 false；给 /history 交叉核对入口' },
  resolve_produce_ref: { when: '用户说「刚才那张」「#2」「last」「那个 fox.png」要续用',
    params: 'ref(#1|last|first|文件名后缀), items(可选，缺省读历史最近 50 条), limit',
    fallback: '同名后缀多命中报歧义，绝不替用户挑一个；#1 恒为最新' },
  enhance_audio: { when: '生成音频后要做工程化处理：去静音 / 降噪 / EQ / 去齿音 / 压缩 / 响度归一化',
    params: 'source, target, preset(voice|music|podcast), trim_silence, denoise, eq, deess, compress, loudness, loudness_target, format(m4a|mp3|wav|flac|aac|ogg|opus)',
    fallback: '纯 ffmpeg 零模型；语音响度用 speechnorm、音乐用 loudnorm；未探测到 ffmpeg 时回参数预览，不谎称已处理' },
  cutout_image: { when: '纯色背景去背 / 配合画笔蒙版抠出主体，输出透明 PNG/WebP',
    params: 'source, target, key_color(white|black|green|blue|red), similarity, blend, mask(可选画笔蒙版), format(png|webp)',
    fallback: '只对纯色/近纯色背景有效；人物头发/半透明/复杂场景需 SAM 类模型，本工具做不到会如实说明；未探测到 ffmpeg 只回参数预览' },
  split_audio: { when: '把一段混音拆出近似人声与近似伴奏（中置相消）',
    params: 'source, vocals_target, music_target, format(m4a|mp3|wav|flac|aac|ogg|opus)',
    fallback: '纯 ffmpeg pan 中置相消、零模型；只对"人声严格居中"的立体声有效，不是 BS-RoFormer/Demucs 级分离，绝不夸大；未探测到 ffmpeg 只回参数预览' },
  transcribe_audio: { when: '把音频转成文字 / 要带时间戳的字幕（SRT/VTT）/ 给视频配旁白文案',
    params: 'audio(出图目录内路径), seconds(可选时长), format(json|srt|vtt)',
    fallback: '需用户先在 asrUrl 配好 OpenAI 兼容 /v1/audio/transcriptions（faster-whisper 等）——插件不内置/不代装 ASR；没配或连不上会返回缺件清单与自检步骤，不返回空文字冒充成功；key 不回显' },
  plan_storyboard: { when: '做科普/数学/算法动画，先把解说脚本拆成可编排的分镜',
    params: 'script(脚本文本), title, seconds(总时长), maxChars(字幕最大字数,默认18)',
    fallback: '纯 JS 零依赖；时间戳按时长均分、未与语音对齐，配音后按真实音频时长重排' },
  render_frame: { when: '分镜逐镜出画面帧：公式/流程/图表/简笔/示意走 SVG，真实画面走 draw_image',
    params: 'type(formula|flow|chart|stick|diagram|image), hint(画面提示), width, height, target(可选落盘名)',
    fallback: 'SVG 是示意图非 LaTeX 级排版；type=image 时如实提示改用 draw_image；未注入 writeFile 只回 svg 字符串不落盘' },
  compose_video: { when: '各镜帧都备好后合成最终 MP4，可烧字幕、混配音',
    params: 'frames(帧路径数组,≥2), target(输出MP4名), fps(默认24), srt(可选字幕), audio(可选配音), dedupe(静态帧去重), fpsMode(cfr|vfr)',
    fallback: '需宿主探测到 ffmpeg 才真出片；未注入执行器只回 argv 预览、明说未生成；字幕用 subtitle-plan、配音用 generate_speech' },
  layout_frame: { when: '要一页教学版式（标题页/要点/图文分栏/对比），不想手算坐标',
    params: 'kind(title|bullets|split|compare), title, subtitle, items, body, columns, ratio, width, height, target',
    fallback: '纯 JS flex 子集，不解析 CSS、按字符宽度估算换行（CJK 1em/其余 0.55em），只保证不溢出；要像素级排版走 draw_image' },
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
  { id: 'audio_finishing', title: '生成音频的工程化后处理 / 声源拆分',
    steps: ['generate_speech', 'enhance_audio', 'split_audio'],
    note: '先生成语音，再用 enhance_audio 做去静音+去齿音+语音响度归一化；要拆近似人声/伴奏时接 split_audio（中置相消，仅近似）。三者纯 ffmpeg 零模型，未探测到就如实降级。' },
  { id: 'audio_to_text', title: '音频转文字 / 生成字幕',
    steps: ['transcribe_audio'],
    note: 'transcribe_audio 传音频路径转文字与时间戳字幕（json/srt/vtt）。也可先 GET /api/qwen-paint/audio/transcribe/capabilities 看 asrUrl 配没配、服务在不在线；没配就按返回的 verify 步骤自配 OpenAI 兼容端点，插件不代装 ASR。' },
  { id: 'pure_color_cutout', title: '纯色背景抠图',
    steps: ['draw_image', 'cutout_image', 'convert_media'],
    note: '出图后若背景是纯色，用 cutout_image 键控去背出透明 PNG/WebP；复杂主体需 SAM，本工具会如实说明，不要用它硬抠头发。' },
  { id: 'voice_clone', title: '换语音模型 + 拖入样本做音色克隆',
    steps: ['manage_workers', 'list_tts_backends', 'generate_speech'],
    note: '先用 manage_workers 做 preflight（显存预检）并配置独立环境，再用 list_tts_backends 看哪个后端探测到了，最后 generate_speech 传 backend + 样本令牌。样本是零样本参考克隆，不训练权重。' },
  { id: 'bgm', title: '生成 BGM 配乐',
    steps: ['manage_workers', 'generate_music'],
    note: '音乐模型走独立 Worker；generate_music 默认只出参数计划，不真生成音频、不自动下载权重。' },
  { id: 'reuse_previous', title: '续用上一次的产出',
    steps: ['resolve_produce_ref', 'iterate_image'],
    note: '「刚才那张」先用 resolve_produce_ref 解析成具体一条（#1 恒为最新，同名后缀多命中会报歧义），再交给 iterate_image / inpaint_image。' },
  { id: 'video_timeline', title: '文生视频先排时间轴',
    steps: ['plan_timeline', 'describe_resource_needs', 'generate_video'],
    note: '没有配音锚点时用 plan_timeline 给建议骨架并把 prefix 拼进 prompt；提交前用 describe_resource_needs 看档位。有配音时改用真实音频时长排轴。' },
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
