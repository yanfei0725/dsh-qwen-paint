/**
 * lib/subtitle-plan.js —— D19 字幕：能做的做到底，做不了的把缺件说清楚。
 *
 * ★★ 本机实测事实（2026-11-14，ComfyUI 0.39.0 / 1686 个节点）：
 *   把 `/object_info` 全量快照按 whisper|asr|transcri|subtitle|caption 关键词扫了一遍，
 *   **零命中**。也就是说这台机器上没有任何现成的语音转写能力。
 *
 *   所以本模块严格分两条路，绝不混淆：
 *
 *   ① `source: 'script'` —— **脚本字幕**。把分镜/文案按句切好、按总时长均分，
 *      直接产出 SRT/VTT。这条**现在就能用**，不需要任何额外组件。
 *      ★ 但它**没有和真实语音对齐**：语音说到哪一句、每句实际多长，它并不知道。
 *      返回里 `aligned: false` 就是这个意思，UI 与文案都必须如实带出来。
 *
 *   ② `source: 'asr'` —— **语音转写字幕**。需要外部能力。没装就返回
 *      `ok:false` + 一份「要装什么」的清单，**不假装成功、不产出空字幕文件**。
 *
 * ★ 为什么不做"自动对齐"糊弄过去：把均分时间戳标成"已对齐"，
 *   用户拿去压片会发现字幕和口型错开半秒以上 —— 那时候返工成本比现在说清楚高得多。
 */

/** 转写能力的关键词。任一命中即认为机器上有可用 ASR。 */
const ASR_NODE_RE = /(whisper|whisperx|asr|transcri|subtitle|caption)/iu

/**
 * 缺件清单：明确写出「装什么、在哪装、装完怎么确认」。
 * ★ 这些**不是**本插件的依赖，也不该由插件自动下载 —— 用户要自己决定。
 */
export const ASR_OPTIONS = [
  {
    id: 'faster-whisper',
    label: 'faster-whisper（本地命令行，最省事）',
    install: 'pip install faster-whisper',
    verify: 'python -c "import faster_whisper; print(faster_whisper.__version__)"',
    note: '装完仍需在插件外自行转写；本插件只负责把文本排成字幕，不负责跑模型。',
  },
  {
    id: 'whisper.cpp',
    label: 'whisper.cpp（无需 Python，带可执行文件）',
    install: '从 ggerganov/whisper.cpp 的 releases 取对应平台包，下载 ggml 模型',
    verify: './main -h',
    note: '产出带时间戳的 SRT，可直接与本模块的格式化结果互校。',
  },
  {
    id: 'comfy-whisper-node',
    label: 'ComfyUI 侧的 whisper 自定义节点',
    install: '在 ComfyUI/custom_nodes 里装任一 whisper 节点包并重启 ComfyUI',
    verify: 'GET /object_info 里能搜到该节点名',
    note: '本模块探测的就是这条路：节点出现即视为可用（是否真能跑仍需你跑一次确认）。',
  },
]

/**
 * 探测转写能力。三态，不是布尔：
 *   `available: true`  → 有节点，可以试
 *   `available: false` → 明确没有（探到了节点清单且零命中）
 *   `available: null`  → 没拿到节点清单（离线/未启动），**不知道**
 *
 * ★ 「不知道」和「不支持」必须分开：把 null 压成 false 会让离线时显示
 *   "本机不支持语音转写"，而实际上只是没连上 ComfyUI。
 *
 * @param {{nodes?: string[]|Set<string>}} caps
 */
export function subtitleCapability(caps) {
  const raw = caps?.nodes
  if (raw === undefined || raw === null) {
    return {
      available: null,
      node: '',
      reason: '没拿到 ComfyUI 的节点清单，无法判断是否支持语音转写',
      options: ASR_OPTIONS,
    }
  }
  const list = Array.isArray(raw) ? raw : [...raw]
  const hit = list.find((n) => typeof n === 'string' && ASR_NODE_RE.test(n))
  if (hit) {
    return {
      available: true,
      node: hit,
      reason: `探测到 ${hit}，可以尝试语音转写（实际效果需你跑一次确认）`,
      options: [],
    }
  }
  return {
    available: false,
    node: '',
    reason: `本机 ${list.length} 个 ComfyUI 节点里没有语音转写节点，只能做脚本字幕`,
    options: ASR_OPTIONS,
  }
}

/** SRT 用逗号，VTT 用点。这是规范差异，不能统一。 */
function fmtTime(sec, sep) {
  const x = Math.max(0, Number(sec) || 0)
  const hh = Math.floor(x / 3600)
  const mm = Math.floor((x % 3600) / 60)
  const ss = Math.floor(x % 60)
  const ms = Math.round((x - Math.floor(x)) * 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(hh)}:${p(mm)}:${p(ss)}${sep}${p(ms, 3)}`
}

/**
 * 按句切分文案。
 *
 * 中文按 。！？；  和换行切，英文按 .!? 切；再按 `maxChars` 折行。
 * ★ 只在**标点处**切，不从词中间劈开 —— 半句字幕比长句更糟。
 */
export function splitScript(text, { maxChars = 18 } = {}) {
  const body = String(text ?? '').replace(/\r\n?/gu, '\n').trim()
  if (body === '') return []
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 18
  const out = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    // 保留标点在句尾：用 lookbehind 会在老 Node 上炸，所以手动走一遍。
    const pieces = []
    let buf = ''
    for (const ch of t) {
      buf += ch
      if ('。！？；!?;'.includes(ch)) { pieces.push(buf); buf = '' }
    }
    if (buf.trim() !== '') pieces.push(buf)
    for (const raw of pieces) {
      const s = raw.trim()
      if (s === '') continue
      if (s.length <= limit) { out.push(s); continue }
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit))
    }
  }
  return out
}

/**
 * 把切好的句子按总时长均分，生成 cue 列表。
 *
 * 均分是**最不坏的默认**：没有音频锚点时，任何"更聪明"的分配都是猜。
 * 返回值带 `aligned:false`，且 `note` 会明确写"时间戳为均分，未与语音对齐"。
 */
export function buildScriptCues({ text, seconds, maxChars = 18 } = {}) {
  const lines = splitScript(text, { maxChars })
  const total = Number(seconds)
  if (lines.length === 0) {
    return { ok: false, reason: '文案为空，没有可排成字幕的句子', cues: [], aligned: false }
  }
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: 'seconds 必须是正数（字幕需要总时长才能均分）', cues: [], aligned: false }
  }
  const per = total / lines.length
  const cues = lines.map((textLine, i) => ({
    index: i + 1,
    from: Number((i * per).toFixed(3)),
    to: Number(((i + 1) * per).toFixed(3)),
    text: textLine,
  }))
  return {
    ok: true,
    reason: '',
    cues,
    aligned: false,
    note: `共 ${lines.length} 句，按 ${total}s 均分（每句约 ${per.toFixed(2)}s）；`
      + '时间戳未与真实语音对齐，压片前请人工校一遍。',
  }
}

/** cue 列表 → SRT 文本。非法 cue 直接跳过，不产出空块。 */
export function cuesToSrt(cues) {
  const list = Array.isArray(cues) ? cues : []
  const blocks = []
  let n = 0
  for (const c of list) {
    const textLine = String(c?.text ?? '').replace(/\r?\n/gu, ' ').trim()
    if (textLine === '') continue
    n += 1
    const to = Number.isFinite(Number(c.to)) && Number(c.to) > Number(c.from) ? Number(c.to) : Number(c.from) + 1
    blocks.push(`${n}\n${fmtTime(c.from, ',')} --> ${fmtTime(to, ',')}\n${textLine}`)
  }
  if (blocks.length === 0) return ''
  // SRT 末条也要有空行收尾 —— 少了它有些播放器会把最后一句吞掉。
  return `${blocks.join('\n\n')}\n`
}

/** cue 列表 → WebVTT 文本。 */
export function cuesToVtt(cues) {
  const list = Array.isArray(cues) ? cues : []
  const blocks = []
  for (const c of list) {
    const textLine = String(c?.text ?? '').replace(/\r?\n/gu, ' ').trim()
    if (textLine === '') continue
    const to = Number.isFinite(Number(c.to)) && Number(c.to) > Number(c.from) ? Number(c.to) : Number(c.from) + 1
    blocks.push(`${fmtTime(c.from, '.')} --> ${fmtTime(to, '.')}\n${textLine}`)
  }
  if (blocks.length === 0) return ''
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`
}

/**
 * 一站式编排：给定文案或已有 cue，产出可落盘的字幕文本。
 *
 * @param {object} o
 * @param {string} [o.text]       脚本文案（source:'script' 时必填）
 * @param {number} [o.seconds]    总时长
 * @param {'srt'|'vtt'} [o.format]
 * @param {string} [o.source]     'script' | 'asr'
 * @param {Array}  [o.cues]       source:'asr' 时由调用方传入带真实时间戳的 cue
 * @param {object} [o.caps]       用于探测 ASR 能力
 */
export function planSubtitles({ text, seconds, format = 'srt', source = 'script', cues, caps } = {}) {
  const fmt = String(format).toLowerCase() === 'vtt' ? 'vtt' : 'srt'
  const cap = subtitleCapability(caps)

  if (source === 'asr') {
    if (cap.available !== true) {
      return {
        ok: false,
        source: 'asr',
        format: fmt,
        reason: cap.available === null
          ? '拿不到 ComfyUI 节点清单，无法确认语音转写是否可用'
          : '本机没有语音转写能力，无法从音频生成字幕',
        // ★ 关键：把「装什么」直接交出去，而不是只说一句"不支持"。
        missing: cap.options,
        suggestion: '可以先用 source:"script" 按脚本文案出字幕（无需任何额外组件，但时间戳是均分的）。',
        content: '',
        aligned: false,
        cues: [],
      }
    }
    const list = Array.isArray(cues) ? cues : []
    if (list.length === 0) {
      return {
        ok: false, source: 'asr', format: fmt, aligned: true,
        reason: `已探测到 ${cap.node}，但没有传入带时间戳的 cue 列表`,
        missing: [], suggestion: '把转写结果按 {from,to,text} 传进来，本模块负责格式化。',
        content: '', cues: [],
      }
    }
    const content = fmt === 'vtt' ? cuesToVtt(list) : cuesToSrt(list)
    return {
      ok: content !== '', source: 'asr', format: fmt, aligned: true,
      reason: content === '' ? '传入的 cue 全是空文本' : '',
      missing: [], suggestion: '', content, cues: list,
      note: `时间戳由 ${cap.node} 的转写结果提供。`,
    }
  }

  const built = buildScriptCues({ text, seconds })
  if (!built.ok) {
    return {
      ok: false, source: 'script', format: fmt, aligned: false,
      reason: built.reason, missing: [], suggestion: '', content: '', cues: [],
    }
  }
  const content = fmt === 'vtt' ? cuesToVtt(built.cues) : cuesToSrt(built.cues)
  return {
    ok: true, source: 'script', format: fmt, aligned: false,
    reason: '', missing: [], suggestion: '',
    content, cues: built.cues, note: built.note,
  }
}
