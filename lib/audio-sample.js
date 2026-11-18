/**
 * lib/audio-sample.js —— 拖入音频样本库（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   用户可直接拖入 MP3 / WAV / FLAC 等音频，作为「新音色」的参考样本。
 *
 * ## ★ 诚实边界
 *   这是**零样本 / 参考音频音色克隆**：把样本交给 TTS 节点做说话人嵌入，
 *   **不训练、不微调、不产出新的权重文件**。任何「训练新音色」的说法都是误导。
 *   样本只作为推理时的参考输入，插件不自动下载任何模型权重。
 *
 * ## 隐私与安全
 *   · 样本一律落在 outputDir 的 .voice-samples/ 子目录，拒绝 .. 穿越与任意本机路径；
 *   · 对外只暴露 id / 文件名 / 相对路径，绝不回吐本机绝对路径；
 *   · 文件名净化、大小上限、扩展名白名单；id 只允许 [a-z0-9_-]；
 *   · 用户可删除样本（连文件一起删），删除是显式动作。
 *
 * ## 为什么用模块级单例
 *   lib/speech-tool.js 在 index.js 里创建，端点却在 lib/tool-registry.js 里注册，
 *   两者不共享 deps。用 getAudioSampleStore(outputDir) 单例让两边拿到同一个库，
 *   **零 index.js 改动**（贴着 DSH Store 单文件上限）。
 */
import path from 'node:path'
import * as nodeFsSync from 'node:fs'

export const AUDIO_SAMPLE_DIR = '.voice-samples'
export const AUDIO_SAMPLE_FORMATS = Object.freeze([
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'webm', 'mp4', 'aiff', 'aif',
])
export const MAX_SAMPLE_BYTES = 64 * 1024 * 1024
export const CLONE_TOKEN_PREFIX = 'sample:'

/** 样本校验：扩展名白名单 + 大小 + 文件名净化。 */
export function validateAudioSample({ name, size } = {}) {
  const raw = String(name ?? '').trim()
  if (!raw) return { ok: false, reason: '没有文件名' }
  // ★ 必须在取 basename **之前**检查原始路径的 .. 段，否则 '../a.mp3' 会被
  //   split('/').pop() 洗成 'a.mp3' 而绕过围栏。
  if (raw.replace(/\\/g, '/').split('/').some((p) => p === '..')) {
    return { ok: false, reason: '文件名不允许 .. 穿越' }
  }
  const base = raw.replace(/\\/g, '/').split('/').pop() || ''
  const ext = path.extname(base).slice(1).toLowerCase()
  if (!AUDIO_SAMPLE_FORMATS.includes(ext)) {
    return { ok: false, reason: '不支持的音频格式 .' + (ext || '无') + '；支持 ' + AUDIO_SAMPLE_FORMATS.join(' / ') }
  }
  const n = Number(size)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: '音频内容为空' }
  if (n > MAX_SAMPLE_BYTES) return { ok: false, reason: '音频超过大小上限（64 MB）' }
  return { ok: true, format: ext, name: base }
}

/** 把用户给的文件名净化成可安全落盘的名字。 */
export function safeSampleName(name, ext) {
  const stem = String(name ?? '').replace(/\.[^.]+$/u, '')
    .replace(/[^A-Za-z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 48)
  return (stem || 'voice') + '.' + ext
}

/**
 * @param {object} opts
 * @param {string} opts.outputDir 出图目录（围栏根）
 * @param {object} [opts.fs] 可注入 {mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync}
 * @param {Function} [opts.now] 可注入时间源，便于确定性测试
 */
export function makeAudioSampleStore({ outputDir, fs: injectedFs, now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  const root = String(outputDir ?? '').trim()
  const dir = root ? path.resolve(root, AUDIO_SAMPLE_DIR) : ''
  const indexFile = dir ? path.join(dir, 'index.json') : ''
  const items = new Map()

  // 注入假 fs 时测试完全不碰磁盘；真机才落到内置 node:fs。
  function lazyFs() {
    return injectedFs || nodeFsSync
  }

  function ensureFs() {
    const f = lazyFs()
    if (!f) return { ok: false, reason: '文件写入能力未注入，样本无法落盘' }
    if (!dir) return { ok: false, reason: '出图目录未配置，无法做目录围栏' }
    return { ok: true, fs: f }
  }

  function publicRow(rec) {
    return {
      id: rec.id,
      name: rec.name,
      relativePath: AUDIO_SAMPLE_DIR + '/' + rec.file,
      format: rec.format,
      size: rec.size,
      createdAt: rec.createdAt,
      cloneToken: CLONE_TOKEN_PREFIX + rec.id,
      // ★ 2026-11-19 transcript：样本的参考转写（GSV.CPP v5 契约 prompt_text 源）；
      //   内置链只做说话人嵌入可空。缺省空串，不编造。
      transcript: String(rec.transcript ?? ''),
      note: '零样本参考音频克隆（不训练权重）',
    }
  }

  function persistIndex() {
    const f = lazyFs()
    if (!f || !indexFile) return
    try {
      f.mkdirSync(dir, { recursive: true })
      f.writeFileSync(indexFile, JSON.stringify([...items.values()], null, 2), 'utf8')
    } catch { /* 索引写失败不影响本次登记，日志由调用方决定 */ }
  }

  return {
    available: Boolean(dir),
    /** 登记一个拖入的音频。data 为 Uint8Array / Buffer / base64 字符串；
     *  transcript 可选（该样本的转写文字，供 GSV.CPP v5 契约的 prompt_text 消费）。 */
    register({ name, data, size, transcript } = {}) {
      const v = validateAudioSample({ name, size: size ?? (data?.length ?? 0) })
      if (!v.ok) return { ok: false, reason: v.reason }
      const ready = ensureFs()
      if (!ready.ok) return { ok: false, reason: ready.reason }
      let bytes = data
      if (typeof data === 'string') {
        try { bytes = Buffer.from(data, 'base64') } catch { return { ok: false, reason: '音频内容不是合法 base64' } }
      }
      if (!bytes || typeof bytes.length !== 'number') return { ok: false, reason: '音频内容为空' }
      if (bytes.length > MAX_SAMPLE_BYTES) return { ok: false, reason: '音频超过大小上限（64 MB）' }
      const id = 'vs-' + Math.trunc(clock()).toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      const file = safeSampleName(v.name, v.format)
      const full = path.resolve(dir, id + '-' + file)
      if (!full.startsWith(dir + path.sep)) return { ok: false, reason: '样本路径越出出图目录' }
      try {
        ready.fs.mkdirSync(dir, { recursive: true })
        ready.fs.writeFileSync(full, Buffer.from(bytes))
      } catch {
        return { ok: false, reason: '音频样本写入失败（详见插件日志）' }
      }
      const rec = { id, name: v.name, file: id + '-' + file, format: v.format,
        size: bytes.length, createdAt: Math.trunc(clock()),
      // 转写截 500 字：推理参考转写，不是文档存储。
      transcript: String(transcript ?? '').trim().slice(0, 500) }
      items.set(id, rec)
      persistIndex()
      return { ok: true, sample: publicRow(rec) }
    },
    /** sample:<id> → 本机绝对路径，仅供内部上传 ComfyUI 使用，绝不回给前端。 */
    resolve({ token } = {}) {
      const t = String(token ?? '').trim()
      if (!t.startsWith(CLONE_TOKEN_PREFIX)) return { ok: false, reason: '不是样本令牌' }
      const id = t.slice(CLONE_TOKEN_PREFIX.length)
      if (!/^[a-z0-9_-]+$/u.test(id)) return { ok: false, reason: '样本 id 非法' }
      const rec = items.get(id)
      if (!rec) return { ok: false, reason: '样本不存在或已被删除' }
      const full = path.resolve(dir, rec.file)
      if (!full.startsWith(dir + path.sep)) return { ok: false, reason: '样本路径越出出图目录' }
      return { ok: true, path: full, format: rec.format, transcript: String(rec.transcript ?? '') }
    },
    list() { return [...items.values()].map(publicRow) },
    remove({ id } = {}) {
      const key = String(id ?? '').trim()
      const rec = items.get(key)
      if (!rec) return { ok: false, reason: '样本不存在' }
      try { lazyFs()?.unlinkSync(path.resolve(dir, rec.file)) } catch { /* 文件已不在也允许清记录 */ }
      items.delete(key)
      persistIndex()
      return { ok: true, id: key }
    },
  }
}

/** 模块级单例：让端点与 speech-tool 共享同一个样本库，零 index.js 改动。 */
const STORES = new Map()
export function getAudioSampleStore(outputDir, opts = {}) {
  const key = String(outputDir ?? '').trim() || '(none)'
  if (!STORES.has(key)) STORES.set(key, makeAudioSampleStore({ ...opts, outputDir: key === '(none)' ? '' : key }))
  return STORES.get(key)
}

/** speech-tool 用：令牌 → 本地路径 + 登记时可选的转写；非令牌原样返回（保持旧 reference_audio 行为）。 */
export function resolveSampleToken(token, store) {
  const t = String(token ?? '').trim()
  if (!t.startsWith(CLONE_TOKEN_PREFIX)) return { ok: true, path: t, fromSample: false, transcript: '' }
  if (!store) return { ok: false, reason: '样本库未初始化' }
  const r = store.resolve({ token: t })
  return r.ok
    ? { ok: true, path: r.path, fromSample: true, transcript: String(r.transcript ?? '') }
    : { ok: false, reason: r.reason }
}
