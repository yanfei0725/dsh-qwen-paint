// TTS 低延迟编排：只实现通用工程思路（语义分块 / 外部服务适配 / 诚实引导），
// 不复制 AnifLive-TTS( PolyForm NC ) 或 GSV.CPP( MIT ) 的任何代码与二进制。
// 权威事实见 docs/tts-lowlatency-design-notes.md。
export const TTS_LOWLATENCY_VERSION = 1

export const EXTERNAL_TTS_SERVICES = Object.freeze([
  { id: 'gsv_cpp', label: 'GSV.CPP（MIT · Vulkan/CPU · GPT-SoVITS v5）',
    defaultPort: 9880, healthPath: '/health', synthPath: '/tts', apiStyle: 'gsv',
    guide: '从 huggingface.co/KakaruHayate/GSV.CPP 取一键包；目录内 Start GAG.bat 或 gsv_server.exe --device vulkan --port 9880；文本 sidecar --port 9882。模型/大包须自行下载，插件不代下。',
    license: 'MIT（第三方组件见其 THIRD_PARTY_NOTICES）' },
  { id: 'aniflive', label: 'AnifLive-TTS（PolyForm NC · 仅非商用 · N 卡/TensorRT）',
    defaultPort: 9880, healthPath: '/health', synthPath: '/v1/audio/speech', apiStyle: 'openai',
    guide: '非商用可从 github.com/Hiruynk/AnifLive-TTS 自装；商用须作者书面授权，本插件不捆绑其代码。',
    license: 'PolyForm Noncommercial 1.0.0（禁止商用）' },
])

const CHUNK_RE = /[。！？!?；;\n]+/u

/** 语义分块：按句末标点切，长句兜底按长度切。首块尽量短 → 更早出首音。 */
export function planLowLatencyTts(text = '', { maxChars = 60, firstChars = 24 } = {}) {
  const src = String(text ?? '').trim()
  if (!src) return { ok: false, chunks: [], reason: '文本为空' }
  const parts = []
  for (const seg of src.split(CHUNK_RE)) {
    const clean = String(seg ?? '').trim()
    if (!clean) continue
    if (clean.length <= maxChars) { parts.push(clean); continue }
    let rest = clean
    while (rest.length > maxChars) {
      parts.push(rest.slice(0, maxChars))
      rest = rest.slice(maxChars)
    }
    if (rest) parts.push(rest)
  }
  if (parts.length === 0) return { ok: false, chunks: [], reason: '切分后无有效文本' }
  let first = parts[0]
  if (first.length > firstChars && src.length > firstChars) {
    const cut = first.slice(0, firstChars)
    parts.splice(0, 1, cut, first.slice(firstChars))
    first = cut
  }
  return { ok: true, chunks: parts, count: parts.length, firstChunk: first,
    note: '首块缩短以降低首音延迟；分块仅规划，不声称倍率' }
}

/** 拼服务基址：只接受本机回环，绝不拼外部 URL。 */
export function serviceBase(service, { host = '127.0.0.1', port } = {}) {
  const h = String(host ?? '').toLowerCase()
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') return ''
  const p = Number(port) || Number(service?.defaultPort) || 0
  if (p < 1 || p > 65535) return ''
  return 'http://' + h + ':' + p
}

/** 构造统一合成请求：gsv=/tts 平铺；openai=/v1/audio/speech 嵌套。 */
export function buildSynthRequest(service, { text, voice = '', language = 'zh', stream = false } = {}) {
  const style = service?.apiStyle
  const body = style === 'openai'
    ? { model: voice || 'default', input: String(text ?? ''), voice: voice || 'default',
        language, stream: stream === true }
    : { text: String(text ?? ''), refer_wav_path: '', prompt_text: '', language, stream: stream === true }
  return { method: 'POST', path: service?.synthPath || '/tts',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** 服务健康探测：fetch 必须注入；任何失败都返回结构化降级，不抛。 */
export async function probeExternalTts(service, opts = {}) {
  const base = serviceBase(service, opts)
  const fetchFn = opts.fetch
  if (!base) return { ok: false, online: false, reason: '仅允许本机回环地址' }
  if (typeof fetchFn !== 'function') return { ok: false, online: false, reason: '未提供 fetch，无法探测' }
  try {
    const r = await fetchFn(base + (service.healthPath || '/health'), { signal: opts.signal })
    const online = !!(r && r.ok)
    return { ok: true, online, status: r?.status ?? 0, base,
      reason: online ? '' : '服务返回异常（HTTP ' + (r?.status ?? '?') + '）' }
  } catch (e) {
    return { ok: true, online: false, base,
      reason: '连不上 ' + (service?.id || '外部 TTS') + '：' + String(e?.message || e).slice(0, 120) }
  }
}

/** 顺序拼接多段音频的 ffmpeg argv（concat demuxer + 重编码统一格式）。纯函数，执行器注入。 */
export function buildAudioConcatArgv({ files = [], listFile = '', out = '', ffmpeg = 'ffmpeg' } = {}) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f) : []
  if (list.length < 2 || !listFile || !out) return { ok: false, reason: '拼接至少需要 2 段音频 + 清单文件 + 输出路径' }
  return { ok: true, argv: [ffmpeg, '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', 'aac', '-b:a', '128k', '-y', out],
    listContent: list.map((f) => "file '" + String(f).replace(/'/g, "'\\''") + "'").join('\n') + '\n',
    note: 'concat 顺序拼接；不声称首音倍率，块间语气可能不连贯、总耗时可能增加' }
}

/** 给 UI/Agent 的服务清单：带许可证与引导，绝不假装已装。 */
export function listExternalTtsServices() {
  return EXTERNAL_TTS_SERVICES.map((s) => ({ ...s }))
}

export const TTS_LOWLATENCY_EXPORTS = Object.freeze({
  TTS_LOWLATENCY_VERSION, EXTERNAL_TTS_SERVICES,
  planLowLatencyTts, serviceBase, buildSynthRequest, probeExternalTts, buildAudioConcatArgv,
  listExternalTtsServices,
})
