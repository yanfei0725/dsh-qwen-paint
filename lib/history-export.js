/**
 * lib/history-export.js —— 历史条目的三种「可带走」形态。
 *
 *   · buildAlt()            F30 结构化 alt：尺寸 / 类型 / prompt 前 80 字符 / 风格卡
 *   · buildMarkdown()       G32 复制为 Markdown 引用（贴笔记 / 文档 / 协作消息）
 *   · buildContinueHints()  G33 快捷继续编辑：按类型给出可直接粘贴的下一步指令
 *
 * 三条都是**纯函数**，输入就是 `store.query()` 返回的 item，不读磁盘、不碰网络。
 * 好处是能被回归测试逐字段断言，也方便外部集成直接复用同一套文案。
 *
 * ★ 刻意不做的两件事：
 *   ① 不生成自然语言描述（alt 里塞「一只猫在阳光下奔跑」这类）——
 *     没有视觉模型就看图说话那是编造；真接了视觉模型再谈。
 *   ② 不把绝对路径写进 Markdown / 指令文本 —— 那是把本机目录结构
 *     散到笔记与聊天记录里。用相对 outputDir 的路径，够定位、不泄漏。
 */
import path from 'node:path'

/** alt 里 prompt 的截断长度。80 是清单给的数，够检索又不会撑爆列表。 */
export const ALT_PROMPT_CHARS = 80

/** Markdown 里 prompt 原样保留的上限；再长就截断并标注省略。 */
export const MARKDOWN_PROMPT_CHARS = 600

const KIND_LABEL = {
  image: '图片', video: '视频', audio: '音频', other: '文件',
}

const trimTo = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

/** 只有真正存在的值才进 meta，避免出现 `尺寸：×`、`种子：null` 这种噪声。 */
const pushIf = (arr, label, value) => {
  if (value === null || value === undefined || value === '') return
  arr.push(`${label}：${value}`)
}

/**
 * F30 结构化 alt 元数据。
 *
 * 返回的是**可检索字段的集合**，不是一句描述。字段名固定，外部集成可以
 * 直接按 key 取值，不用解析自然语言。
 *
 * @param {object} item `store.query()` 的条目（含 extra）
 * @returns {{kind:string,label:string,width:number|null,height:number|null,
 *   size:string,prompt_excerpt:string,style_card:string,model:string,tool:string,
 *   seed:number|null,file_name:string,text:string}}
 */
export function buildAlt(item) {
  const it = item ?? {}
  const kind = KIND_LABEL[it.kind] ? String(it.kind) : 'other'
  const width = Number.isFinite(it.width) ? it.width : null
  const height = Number.isFinite(it.height) ? it.height : null
  const extra = it.extra && typeof it.extra === 'object' ? it.extra : {}

  // 风格卡可能来自 extra.style_card（新记录）或 extra.style（早期记录）。
  const styleCard = String(extra.style_card ?? extra.style ?? '').trim()
  const size = width && height ? `${width}×${height}` : ''
  const filePath = String(it.file_path ?? '')
  const fileName = filePath ? path.posix.basename(filePath.replace(/\\/g, '/')) : ''
  const excerpt = trimTo(it.prompt, ALT_PROMPT_CHARS)

  // text 是「一行能塞进 alt="" 属性」的紧凑形式，顺序按信息量排：
  // 类型 > 尺寸 > 提示词摘要 > 风格卡。模型/工具属于上下文，不进 alt。
  const parts = []
  if (KIND_LABEL[kind]) parts.push(KIND_LABEL[kind])
  if (size) parts.push(size)
  if (excerpt) parts.push(excerpt)
  if (styleCard) parts.push(`风格 ${styleCard}`)

  return {
    kind,
    label: KIND_LABEL[kind],
    width,
    height,
    size,
    prompt_excerpt: excerpt,
    style_card: styleCard,
    model: String(it.model ?? ''),
    tool: String(it.tool_name ?? ''),
    seed: Number.isFinite(it.seed) ? it.seed : null,
    file_name: fileName,
    text: parts.join(' · '),
  }
}

/**
 * G32 复制为 Markdown 引用。
 *
 * 图片用 `![]()`，其余类型用普通链接（视频/音频塞进 `![]()` 在多数渲染器里
 * 会变成一张空白破图，不如给链接）。路径用相对 outputDir 的形式，
 * 粘到笔记里读者看到的是文件名，不会暴露本机盘符。
 *
 * 提示词用 `> ` 引用块包住，多行 prompt 也不会破坏列表结构。
 */
/** Markdown 链接 / alt 里的特殊字符转义，防提示词里的 `](` 破坏导出结构。 */
function mdEscape(text) {
  return String(text ?? '').replace(/\\/g, '\\\\')
    .replace(/([\[\]()])/g, '\\$1')
}

export function buildMarkdown(item, opts = {}) {
  const it = item ?? {}
  const alt = buildAlt(it)
  const mdPromptChars = Number.isFinite(opts.promptChars) ? opts.promptChars : MARKDOWN_PROMPT_CHARS
  const rel = String(it.file_path ?? '').trim()
  const url = rel === '' ? '' : rel.replace(/\\/g, '/').replace(/^\/+/, '')
  const isImage = it.kind === 'image'

  const altText = mdEscape(alt.text || '生成结果')
  const link = url === ''
    ? (alt.file_name || '（无路径）')
    : (isImage ? `![${altText}](${url})`
      : `[${mdEscape(alt.file_name || alt.label || '生成结果')}](${url})`)

  const lines = [link, '']
  const meta = []
  pushIf(meta, '时间', String(it.created_at ?? '').trim())
  pushIf(meta, '工具', alt.tool)
  pushIf(meta, '模型', alt.model)
  pushIf(meta, '尺寸', alt.size)
  pushIf(meta, '步数', Number.isFinite(it.steps) ? it.steps : '')
  pushIf(meta, 'CFG', Number.isFinite(it.cfg) ? it.cfg : '')
  pushIf(meta, '种子', alt.seed === null ? '' : alt.seed)
  pushIf(meta, '风格卡', alt.style_card)
  for (const m of meta) lines.push(`- ${m}`)

  const prompt = String(it.prompt ?? '').trim()
  if (prompt !== '') {
    if (meta.length > 0) lines.push('')
    const shown = prompt.length <= mdPromptChars ? prompt : `${prompt.slice(0, mdPromptChars)}…`
    lines.push('> 提示词：')
    // 逐行加 `>`，保证多行 prompt 也是同一个引用块。
    for (const ln of shown.split(/\r?\n/)) lines.push(`> ${ln}`)
  }

  return lines.join('\n')
}

/**
 * G33 快捷继续编辑。
 *
 * ★ 这个插件的形态是「Agent 工具 + 浏览面板」，面板里**没有**下一条指令的输入框。
 *   所以「把路径写进下一轮输入」在这里的等价物是：**给出一段可以直接粘贴给 Agent
 *   的完整指令**，里面已经带好绝对路径与推荐参数。用户点一下复制、切回对话粘贴，
 *   少一次手抄路径 —— 这就是这个功能在本产品里的真实边界，不吹成"一键直达"。
 *
 * 返回按 kind 过滤后的候选，空数组表示这个类型没有合适的下一步。
 *
 * @param {object} item 需带 `path`（绝对路径）或 `file_path`
 * @returns {Array<{id:string,tool:string,label:string,text:string}>}
 */
export function buildContinueHints(item) {
  const it = item ?? {}
  const kind = String(it.kind ?? 'other')
  // 绝对路径优先（粘贴出去要能直接被工具用）；没有就退回相对路径并如实说明。
  const abs = String(it.path ?? '').trim()
  const rel = String(it.file_path ?? '').trim()
  const target = abs !== '' ? abs : rel
  if (target === '') return []
  const quoted = /[\s"'`$]/.test(target) ? `"${target}"` : target
  const missingAbs = abs === ''

  const hint = (id, tool, label, text) => ({
    id, tool, label, text: missingAbs
      ? `${text}\n（注意：这里只有相对输出目录的路径 ${rel}，请补上输出目录前缀）`
      : text,
  })

  const out = []
  if (kind === 'image') {
    out.push(hint('inpaint', 'inpaint_image', '局部重绘',
      `用 inpaint_image 继续编辑这张图：${quoted}\n告诉我你想改哪一块，我给圈选区域与重绘强度。`))
    out.push(hint('upscale', 'upscale_image', '高清放大',
      `用 upscale_image 放大这张图：${quoted}`))
    out.push(hint('i2v', 'generate_video', '图生视频',
      `用 generate_video 把这张图做成视频（startImage 传这个路径）：${quoted}\n提示词我想描述：`))
  } else if (kind === 'video') {
    out.push(hint('frames', 'extract_video_frames', '抽帧再编辑',
      `把这段视频抽帧后逐帧编辑：${quoted}\n先抽帧，我挑需要改的帧。`))
    out.push(hint('audio', 'generate_video', '换音轨',
      `把这段视频的音轨换成我指定的音频（audio_track）：${quoted}`))
  } else if (kind === 'audio') {
    out.push(hint('clone', 'generate_speech', '复刻这个音色',
      `用 generate_speech 复刻这个音色的参考音频（reference_audio）：${quoted}\n要合成的文字是：`))
    out.push(hint('track', 'generate_video', '作为音轨合成',
      `用这段音频作为视频音轨（audio_track）：${quoted}\n视频提示词是：`))
  }
  return out
}

/**
 * 一次算好三条，供 `/history` 列表直接带上，前端零逻辑。
 * 任何一条算错都不该拖垮整个列表 —— 逐条降级为安全默认值。
 *
 * ★ 连 `{ ...item }` 这一步都要包在 try 里：对象展开会触发 getter，
 *   而 getter 是会抛的（测试里就放了一个）。展开在 try 外面时，
 *   「逐条兜底」只是句口号，一条坏数据就能让整页 500。
 */
export function decorateHistoryItem(item) {
  let base = {}
  try {
    base = item && typeof item === 'object' ? { ...item } : {}
  } catch {
    // 展开失败就按白名单逐个取值，能抠出多少算多少 —— 至少 id/类型/路径要在，
    // 否则这一条在 UI 里连“哪条坏了”都指不出来。
    const safe = {}
    for (const k of ['id', 'kind', 'file_path', 'created_at', 'path', 'preview_url']) {
      try { safe[k] = item?.[k] } catch { /* 这个键也坏了，跳过 */ }
    }
    base = safe
  }
  try { base.alt = buildAlt(base) } catch { base.alt = null }
  try { base.markdown = buildMarkdown(base) } catch { base.markdown = '' }
  try { base.continue_hints = buildContinueHints(base) } catch { base.continue_hints = [] }
  return base
}
