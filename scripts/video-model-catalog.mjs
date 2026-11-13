/**
 * 视频模型清单 / 选型 / 多源下载（0.2.0）
 *
 * ## 设计红线
 *  1. **不写死官方文件清单**：所有候选都来自运行时拉取的官方仓库文件列表，
 *     文件名、大小、SHA256 全部以服务器返回值为准（见「判断文件完整性」铁律）。
 *     之前查不到 AMD Hummingbird 的公开权重仓库（模型平台返回 404），
 *     所以**不编造任何 Hummingbird 下载 URL**；本机已有就直接用，没有就走通用 Wan 2.2 路线。
 *  2. **默认不下载**：视频模型动辄 9–32 GB，必须由用户明确回答「要」才动。
 *     `--check` 一律不联网、不下载、不改任何东西。
 *  3. **只进不出**：本模块只有 GET 清单 + GET 文件（下载），
 *     没有任何 POST / PUT / multipart / 读取本机模型上传的路径。
 *  4. **显卡品牌只影响推荐，不替用户决定**：推荐项必须来自真实清单，
 *     拉不到清单就如实报错并给出「自备文件」这条路，绝不拿记忆里的名字兜底。
 *
 * ## 已实测（2026-11-12，本机代理环境）
 *  · `https://www.modelscope.cn/api/v1/models/<repo>/repo/files?Revision=master&Root=...`
 *      → HTTP 200，`{ Code:200, Data:{ Files:[{ Path, Size, Sha256, Type }] } }`，但只列一层目录。
 *  · `https://hf-mirror.com/api/models/<repo>/tree/main?recursive=true`
 *      → HTTP 200，`[{ path, size, lfs:{ oid_sha256 } }]`，可一次拿全 43 个权重文件。
 *  · `https://huggingface.co/api/models/...` 在当前代理下 CONNECT tunnel 502；
 *     保留为最后一个候选源（用户本机网络可能通），不作为默认。
 *  · ModelScope 的 `resolve/master/...` 返回 `X-Linked-Etag`（SHA256），可作交叉校验。
 */

/* ------------------------------------------------------------------ 数据源 ---- */

export const VIDEO_REPO = 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged'

/** 官方仓库页面（只在提示文字里出现，不含任何本机信息）。 */
export const VIDEO_REPO_PAGES = [
  `https://modelscope.cn/models/${VIDEO_REPO}`,
  `https://huggingface.co/${VIDEO_REPO}`,
]

/**
 * 候选源：清单 API + 文件下载前缀。顺序即轮询顺序。
 * `kind` 决定用哪个解析器（modelscope 的对象 / hf 的数组）。
 */
export const VIDEO_SOURCES = [
  {
    id: 'hf-mirror',
    kind: 'hf',
    label: 'hf-mirror（镜像站）',
    apiUrl: (repo) => `https://hf-mirror.com/api/models/${repo}/tree/main?recursive=true`,
    fileUrl: (repo, filePath) => `https://hf-mirror.com/${repo}/resolve/main/${filePath}`,
  },
  {
    id: 'modelscope',
    kind: 'modelscope',
    label: 'ModelScope（原站）',
    apiUrl: (repo, root = 'split_files/diffusion_models') =>
      `https://www.modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master&Root=${encodeURIComponent(root)}`,
    fileUrl: (repo, filePath) => `https://modelscope.cn/models/${repo}/resolve/master/${filePath}`,
  },
  {
    id: 'huggingface',
    kind: 'hf',
    label: 'HuggingFace（原站）',
    apiUrl: (repo) => `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`,
    fileUrl: (repo, filePath) => `https://huggingface.co/${repo}/resolve/main/${filePath}`,
  },
]

/* -------------------------------------------------- 厂商路线与配套优化（数据） ---- */

/**
 * ⚠ 这里的技术描述来自用户提供的资料，**未二次核实、未真机实测**，
 *    一律 `verified: false`，只作为「可选建议」展示，绝不写进 README 当结论，
 *    也绝不自动替用户安装第三方加速包。
 */
export const VIDEO_OPTIMIZATIONS = {
  nvidia: [
    { id: 'fp8', label: '优先 FP8 / NVFP4 量化权重', hint: '清单里的 fp8_scaled 文件比 bf16 小一半左右，省显存', verified: false },
    { id: 'trt', label: 'TensorRT / TensorRT-LLM 加速', hint: '需自行安装对应运行时，插件不代装', verified: false },
    { id: 'softmax', label: 'Skip Softmax / CUDA Graph', hint: '属于后端推理侧开关，需 ComfyUI 与驱动支持', verified: false },
    { id: 'steps', label: '合理步数而非盲目加步', hint: '配合 Turbo / DMD 类蒸馏权重，步数少反而更快', verified: false },
  ],
  intel: [
    { id: 'xpu-vae', label: 'XPU 上的 Wan VAE fastpath', hint: '需对应版本的 ComfyUI / IPEX，插件不代装', verified: false },
    { id: 'llm-scaler', label: 'llm-scaler / ray light 多卡', hint: '多机多卡才用得上，单核显机器可忽略', verified: false },
    { id: 'gguf-q4', label: 'GGUF Q4 量化（若官方清单里有）', hint: '只在清单真实存在该可选', verified: false },
    { id: 'shared-mem', label: '核显共享内存 + 低显存参数', hint: '由插件的 --lowvram 档位落实，见 lib/config.js', verified: true },
  ],
  amd: [
    { id: 'hummingbird', label: 'Hummingbird 家族（XT / XTX / I2V）', hint: '本机已有则直接用；插件不提供公开下载地址', verified: false },
    { id: 'quark', label: 'Quark 混合精度量化', hint: '需 AMD 工具链，插件不代装', verified: false },
    { id: 'fused', label: 'Fused-Softmax / Video Sparse Attention', hint: '属于模型侧算子优化，未在本机验证', verified: false },
  ],
  apple: [
    { id: 'small', label: '优先最小权重 + 低分辨率', hint: '统一内存吃紧，按最小体积档推荐', verified: true },
  ],
  unknown: [
    { id: 'small', label: '优先最小权重', hint: '认不出显卡时不猜，按体积最小推荐', verified: true },
  ],
}

/** 厂商 → 权重名偏好（越靠前越优先）；只是排序权重，不产生文件。 */
const VENDOR_PREFERENCE = {
  nvidia: ['fp8_scaled', 'int8_convrot', '5b', 'fp16', 'bf16'],
  intel: ['gguf', 'q4', '5b', 'fp8_scaled', 'fp16'],
  amd: ['5b', 'fp8_scaled', 'int8_convrot', 'fp16'],
  apple: ['gguf', 'q4', '5b', 'fp8_scaled'],
  unknown: ['gguf', 'q4', '5b', 'fp8_scaled'],
}

export const VENDOR_ROUTE_LABEL = {
  nvidia: 'NVIDIA → 优先 FP8 / NVFP4 量化权重（省显存、提速）',
  intel: 'Intel / 核显 → 优先最小体积（5B / GGUF Q4）+ 共享内存低显存档',
  amd: 'AMD → 本机已有 Hummingbird 系列则直接用；否则按 5B 通用路线',
  apple: 'Apple Silicon → 统一内存吃紧，按最小体积档推荐',
  unknown: '显卡认不出 → 不猜，按最小体积档推荐',
}

/* ------------------------------------------------------------------ 解析 ---- */

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * 把 HF / hf-mirror 的 tree API 结果解析成统一条目。
 * `lfs.oid_sha256` 是 LFS 文件的真实 SHA256；普通文件只有 git blob oid（不能当文件哈希）。
 */
export function parseHfTree(text) {
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('不是 HF tree 数组')
  return parsed
    .filter((f) => f && (f.type === 'file' || f.type === 'blob'))
    .map((f) => ({
      path: String(f.path ?? ''),
      size: num(f.size ?? f.lfs?.size),
      sha256: /^[a-f0-9]{64}$/iu.test(String(f.lfs?.oid_sha256 ?? ''))
        ? String(f.lfs.oid_sha256).toLowerCase() : '',
    }))
    .filter((f) => f.path !== '' && f.size > 0)
}

/** 把 ModelScope 的 repo/files 结果解析成统一条目。 */
export function parseModelScopeFiles(text) {
  const parsed = JSON.parse(text)
  if (Number(parsed?.Code) !== 200 || !Array.isArray(parsed?.Data?.Files)) {
    throw new Error('不是 ModelScope repo/files 成功响应')
  }
  return parsed.Data.Files
    .filter((f) => f && (f.Type === 'blob' || f.IsLFS === true))
    .map((f) => ({
      path: String(f.Path ?? f.Name ?? ''),
      size: num(f.Size),
      sha256: /^[a-f0-9]{64}$/iu.test(String(f.Sha256 ?? ''))
        ? String(f.Sha256).toLowerCase() : '',
    }))
    .filter((f) => f.path !== '' && f.size > 0)
}

export function parseCatalog(text, kind) {
  return kind === 'modelscope' ? parseModelScopeFiles(text) : parseHfTree(text)
}

/**
 * 拉官方清单：按 VIDEO_SOURCES 顺序试，成功一个就合并返回。
 * 全失败 → files=[]，上层必须如实告知「没拿到清单」并给自备路径，绝不兜底造假。
 * @param {{ fetchText:(url:string)=>Promise<string>|string, repo?:string, sources?:Array, log?:(s:string)=>void }} deps
 */
export async function fetchVideoCatalog(deps) {
  const { fetchText, repo = VIDEO_REPO, sources = VIDEO_SOURCES, log = () => {} } = deps
  const errors = []
  const byPath = new Map()
  for (const source of sources) {
    try {
      const text = await fetchText(source.apiUrl(repo))
      const entries = parseCatalog(text, source.kind)
      if (entries.length === 0) throw new Error('清单是空的')
      for (const e of entries) {
        // 已有条目若缺 sha256，遇到带 sha256 的同名条目就补齐（仍以服务器值为准）
        const old = byPath.get(e.path)
        if (!old || (!old.sha256 && e.sha256)) byPath.set(e.path, { ...e, via: source.id })
      }
      log(`  清单来源：${source.label}（${entries.length} 条）`)
      return { files: [...byPath.values()], via: source.id, errors }
    } catch (error) {
      errors.push(`${source.label}：${error?.message ?? error}`)
      log(`  ↻ ${source.label} 清单拉取失败，换下一个源`)
    }
  }
  return { files: [], via: null, errors }
}

/* ------------------------------------------------------------------ 筛选 ---- */

const WEIGHT_RE = /\.(safetensors|gguf|sft|bin|pt)$/iu

export function classifyQuant(name) {
  const s = String(name).toLowerCase()
  if (/\.gguf$|q[2-8]_k|q4|q8_0/iu.test(s)) return 'GGUF 量化'
  if (/fp8|e4m3|nvfp4|float8/iu.test(s)) return 'FP8 / 4-bit 量化'
  if (/int8|convrot/iu.test(s)) return 'INT8 量化'
  if (/bf16/iu.test(s)) return 'BF16'
  if (/fp16/iu.test(s)) return 'FP16'
  return '原版权重'
}

/** 只保留能直接喂给 ComfyUI 的视频权重，按体积从小到大排。 */
export function videoWeightFiles(files, { prefix = 'split_files/diffusion_models/' } = {}) {
  return files
    .filter((f) => WEIGHT_RE.test(f.path) && f.path.startsWith(prefix))
    .map((f) => ({ ...f, quant: classifyQuant(f.path), name: f.path.split('/').pop() }))
    .sort((a, b) => a.size - b.size || a.name.localeCompare(b.name))
}

/** 配套依赖（VAE / 文本编码器）也来自同一份真实清单，不写死文件名。 */
export function videoSupportFiles(files, { maxBytes = 7 * 1024 ** 3 } = {}) {
  return files
    .filter((f) => WEIGHT_RE.test(f.path)
      && /^split_files\/(vae|text_encoders)\//u.test(f.path)
      && f.size > 0 && f.size <= maxBytes)
    .map((f) => ({ ...f, quant: classifyQuant(f.path), name: f.path.split('/').pop() }))
    .sort((a, b) => a.size - b.size)
}

/**
 * 按显卡品牌给一个推荐排序，**所有候选必须来自真实清单**。
 * 返回 { ordered, reason }；ordered 是排好序的候选（可能为空）。
 */
export function recommendVideoPicks(files, vendor = 'unknown', opts = {}) {
  const { maxBytes = Infinity, prefix = 'split_files/diffusion_models/' } = opts
  const pool = videoWeightFiles(files, { prefix }).filter((f) => f.size <= maxBytes)
  const prefs = VENDOR_PREFERENCE[vendor] ?? VENDOR_PREFERENCE.unknown
  const score = (f) => {
    const s = f.name.toLowerCase()
    let rank = prefs.length
    for (const [i, kw] of prefs.entries()) {
      if (s.includes(kw)) { rank = i; break }
    }
    // 小体积永远有微弱权重：核显 / 8 GB 机器上这才是能跑的关键
    return rank * 1e12 + f.size
  }
  const ordered = [...pool].sort((a, b) => score(a) - score(b))
  return {
    ordered,
    reason: VENDOR_ROUTE_LABEL[vendor] ?? VENDOR_ROUTE_LABEL.unknown,
    optimizations: VIDEO_OPTIMIZATIONS[vendor] ?? VIDEO_OPTIMIZATIONS.unknown,
  }
}

/* ------------------------------------------------------------------ 落盘 ---- */

/** 官方 repackaged 目录 → ComfyUI models 子目录。认不出来就返回 null（不下到错地方）。 */
export function targetDirOf(filePath) {
  const p = String(filePath)
  const match = /^split_files\/(diffusion_models|vae|text_encoders|loras|audio_encoders)\//u.exec(p)
  return match ? match[1] : null
}

/** 一个文件的多源下载 URL（顺序 = 轮询顺序）。 */
export function downloadUrlsFor(filePath, { repo = VIDEO_REPO, sources = VIDEO_SOURCES } = {}) {
  return sources.map((s) => ({ id: s.id, label: s.label, url: s.fileUrl(repo, filePath) }))
}

/**
 * 完整性判定：**只认服务器 / 清单给的权威值**。
 * 没有 sha256 时只比大小，并在结果里如实说明「未做哈希校验」。
 */
export function verifyDownload({ actualSize, actualSha256, expected }) {
  if (!Number.isFinite(actualSize) || actualSize !== expected.size) {
    return { ok: false, why: `大小不符：实际 ${actualSize}，清单权威值 ${expected.size}` }
  }
  if (expected.sha256 && actualSha256 && actualSha256.toLowerCase() !== expected.sha256) {
    return { ok: false, why: 'SHA256 与官方清单不一致' }
  }
  return { ok: true, hashChecked: Boolean(expected.sha256 && actualSha256) }
}

/* -------------------------------------------------------------- 交互主流程 ---- */

/**
 * 「②d 视频模型（可选）」。
 *
 * 依赖全部注入，方便离线回归；本函数**不会**抛异常阻断主安装流程。
 * @returns {Promise<{ installed:Array, skipped:boolean, reason:string }>}
 */
export async function runVideoModelStep(deps) {
  const {
    vendor = 'unknown',
    checkOnly = false,
    want = null,            // 'yes' | 'no' | null（null = 需要问）
    isTTY = false,
    ask = async () => '',
    log = () => {},
    fetchText,
    download,              // async (url, dest) => { ok }
    statSize = () => 0,
    sha256Of = async () => '',
    resolveDest = () => null,
    removeFile = () => {},
    existsLocal = () => false,
    maxCandidates = 12,
  } = deps

  if (checkOnly) {
    log('  视频模型是**可选项**；--check 不联网、不下载。要装请单独跑 --video-models。')
    return { installed: [], skipped: true, reason: 'check-only' }
  }

  let decision = want
  if (decision === null) {
    if (!isTTY) {
      log('  视频模型默认不装（非交互）。需要时加 --video-models 单独跑。')
      return { installed: [], skipped: true, reason: 'non-interactive-default-no' }
    }
    const answer = String(await ask('  要不要现在装视频模型？（文件 9–32 GB，默认不装）(y/N) ')).trim().toLowerCase()
    decision = answer === 'y' || answer === 'yes' ? 'yes' : 'no'
  }
  if (decision !== 'yes') {
    log('  跳过视频模型（插件的文生图 / 图片编辑 / 语音都不受影响；以后可随时补装）。')
    return { installed: [], skipped: true, reason: 'user-declined' }
  }

  log(`\n  显卡路线：${VENDOR_ROUTE_LABEL[vendor] ?? VENDOR_ROUTE_LABEL.unknown}`)
  for (const opt of (VIDEO_OPTIMIZATIONS[vendor] ?? VIDEO_OPTIMIZATIONS.unknown)) {
    log(`    · ${opt.label}${opt.verified ? '' : '（资料未二次核实 / 未真机实测，仅作参考）'}`)
  }

  const catalog = await fetchVideoCatalog({ fetchText, log })
  if (catalog.files.length === 0) {
    log('  ✗ 官方文件清单没拉到（下面列出每个源的原因），**不猜文件名、不假装能下**。')
    for (const e of catalog.errors) log(`      · ${e}`)
    log('    可以自己把 ComfyUI 能用的视频权重放进模型目录的 diffusion_models 子目录，插件会自动认。')
    for (const page of VIDEO_REPO_PAGES) log(`    官方仓库页面：${page}`)
    return { installed: [], skipped: true, reason: 'catalog-unavailable' }
  }

  const { ordered } = recommendVideoPicks(catalog.files, vendor)
  const candidates = ordered.slice(0, maxCandidates)
  if (candidates.length === 0) {
    log('  ✗ 官方清单里没找到可下载的视频权重文件，跳过（可自备）。')
    return { installed: [], skipped: true, reason: 'no-candidates' }
  }

  // 本机已有的文件不重复下载（只在本机判断，不上传、不外发任何路径）
  const missing = candidates.filter((f) => !existsLocal(f))
  if (missing.length === 0) {
    log('  ✓ 本机已有推荐权重，无需下载。')
    return { installed: [], skipped: true, reason: 'already-present' }
  }

  log('\n  官方清单里的候选（大小 / 哈希均来自服务器返回值，不是估算）：')
  missing.forEach((f, i) => {
    log(`    ${String(i + 1).padStart(2)}) ${(f.size / 1024 ** 3).toFixed(2).padStart(6)} GB  [${f.quant}]  ${f.name}`)
  })
  if (!isTTY) {
    log('  非交互模式不自动替你选；请加 --video-pick <编号> 或自己下载后放进 diffusion_models。')
    return { installed: [], skipped: true, reason: 'needs-explicit-pick' }
  }
  const pick = String(await ask(`  选一个 [1-${missing.length}]（回车或 n = 不装）：`)).trim().toLowerCase()
  const idx = Number(pick) - 1
  if (!Number.isInteger(idx) || idx < 0 || idx >= missing.length) {
    log('  没选 / 输入无效 → 不装。')
    return { installed: [], skipped: true, reason: 'no-valid-pick' }
  }

  const chosen = missing[idx]
  const dest = resolveDest(chosen)
  if (!dest) {
    log('  ✗ 认不出该放到 ComfyUI 的哪个子目录，不下（避免放错地方）。')
    return { installed: [], skipped: true, reason: 'unknown-target' }
  }

  const installed = []
  const urls = downloadUrlsFor(chosen.path)
  let done = false
  for (const [i, source] of urls.entries()) {
    if (i > 0) log(`  ↻ 换源：${source.label}`)
    log(`  ↓ ${chosen.name}（${(chosen.size / 1024 ** 3).toFixed(2)} GB）← ${source.label}`)
    let got
    try { got = await download(source.url, dest) } catch (error) {
      log(`  ✗ 该源失败：${error?.message ?? error}`)
      continue
    }
    if (!got?.ok) { log('  ✗ 该源失败（断点续传后仍不完整），换下一个。'); continue }
    const verdict = verifyDownload({
      actualSize: statSize(dest),
      actualSha256: await sha256Of(dest),
      expected: chosen,
    })
    if (!verdict.ok) {
      log(`  ✗ 校验不过（${verdict.why}），删除该文件，绝不将就使用。`)
      removeFile(dest)
      continue
    }
    log(`  ✓ ${chosen.name} 校验通过${verdict.hashChecked ? '（SHA256 与官方清单一致）' : '（只比大小：清单未提供哈希）'}`)
    installed.push(chosen)
    done = true
    break
  }
  if (!done) {
    log('  ✗ 所有源都失败。可以重复跑（curl 会断点续传），也可以自备文件放进 diffusion_models。')
    log('    视频模型是可选功能，不影响前面已经装好的文生图 / 图片编辑 / 语音。')
  }
  return { installed, skipped: !done, reason: done ? 'installed' : 'download-failed' }
}
