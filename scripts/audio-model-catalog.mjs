/**
 * scripts/audio-model-catalog.mjs —— 新增语音 / 音乐模型的下载源与权威校验层。
 *
 * ## 覆盖的需求
 *   GPT-SoVITS v5（dev / turbo）、IndexTTS2、ACE-Step 1.5、YuE2 在下载时
 *   就能选模型与档位；沿用生图 / 视频模型那套「交互式问档位 + 多源轮询 +
 *   断点续传 + 失败可自备文件」。
 *
 * ## ★ 诚实边界（比功能更重要）
 *   · 只核实到**候选仓库名**（来自公开资料），HF 上具体有哪些文件、多大、
 *     什么量化档位，**本机一个都没验证过** ⇒ 一律运行时通过 HF API 动态列举，
 *     绝不硬编码文件名 / 大小 / 哈希。仓库探测不到就明确说「未核实 / 不可达」。
 *   · 判断文件是否完整**只以服务器权威值**为准（Content-Length /
 *     X-Linked-Size / ETag / X-Linked-ETag），绝不拿记忆里的大小去判残缺。
 *   · **绝不上传本机模型文件**、脚本里**不写任何本机绝对路径**；
 *     目标目录由调用方以参数传入，日志只显示文件名。
 *   · 默认只读、默认不下载、默认不安装；下载由用户显式执行，装到哪、怎么装由用户决定。
 *   · 插件本体不 pip install、不创建 venv、不拉 Docker、不自动下载权重。
 */
export const CATALOG_VERSION = 1

/** 多源轮询表。verified:false = 未在本机验证可达，运行时探测再放行。 */
export const DEFAULT_SOURCES = Object.freeze([
  { id: 'hf', label: 'Hugging Face 官方', base: 'https://huggingface.co', verified: false },
  { id: 'hf-mirror', label: 'HF 镜像站', base: 'https://hf-mirror.com', verified: false },
])

/**
 * 候选仓库名只作为「去哪儿列文件」的线索，不是「这些文件一定存在」。
 * hfRepo 为 null 表示连仓库名都没核实到 ⇒ 只能走「自备文件」路径。
 */
export const AUDIO_MODEL_GROUPS = Object.freeze([
  {
    id: 'gpt_sovits_v5', label: 'GPT-SoVITS v5（语音克隆 / TTS）', kind: 'tts',
    variants: [
      { id: 'dev', label: '原版 dev（未蒸馏）' },
      { id: 'turbo', label: '蒸馏版 turbo（由 dev 蒸馏）' },
    ],
    hfRepo: 'lj1995/GPT-SoVITS',
    repoNote: '候选仓库名来自公开资料，HF 文件清单本机未核实；运行时动态列举。',
    installHint: '权重放到 GPT_SoVITS/pretrained_models 对应版本目录（由用户自行决定）。',
  },
  {
    id: 'indextts2', label: 'IndexTTS2（B 站开源）', kind: 'tts',
    variants: [{ id: 'default', label: '默认权重集' }],
    hfRepo: 'IndexTeam/IndexTTS-2',
    repoNote: '候选仓库名来自公开资料，HF 文件清单本机未核实。',
    installHint: '权重放到对应节点包的 checkpoints 目录（由用户自行决定）。',
  },
  {
    id: 'ace_step_15', label: 'ACE-Step 1.5（音乐 / BGM）', kind: 'music',
    variants: [{ id: 'default', label: '默认权重集' }],
    hfRepo: null,
    repoNote: 'GitHub 组织 ace-step/ACE-Step-1.5 已查到，但 HF 权重仓库名未核实 ⇒ 只支持自备文件。',
    installHint: '请按节点包文档把权重放到对应目录。',
  },
  {
    id: 'yue2', label: 'YuE2 / YuE 2.0（音乐 / BGM）', kind: 'music',
    variants: [{ id: 'default', label: '默认权重集' }],
    hfRepo: null,
    repoNote: '公开资料提到 Comfy-Org/Yue2 镜像，但 HF 仓库名未核实 ⇒ 只支持自备文件。',
    installHint: '请按节点包文档把权重放到对应目录。',
  },
])

export function listCatalogGroups() {
  return AUDIO_MODEL_GROUPS.map((g) => ({
    id: g.id, label: g.label, kind: g.kind, hfRepo: g.hfRepo,
    variants: g.variants.map((v) => ({ ...v })),
    repoNote: g.repoNote, installHint: g.installHint,
    selfBringOnly: g.hfRepo === null,
  }))
}

export function findGroup(id) {
  return AUDIO_MODEL_GROUPS.find((g) => g.id === String(id ?? '').trim()) || null
}

export function buildRepoTreeUrl(source, repo) {
  return String(source?.base ?? '').replace(/\/+$/u, '')
    + '/api/models/' + encodeURIComponent(String(repo ?? '')) + '/tree/main?recursive=true'
}

export function buildResolveUrl(source, repo, file) {
  return String(source?.base ?? '').replace(/\/+$/u, '')
    + '/' + String(repo ?? '') + '/resolve/main/' + String(file ?? '')
}

/** 档位分类：只按文件名的关键词归类，不承诺任何模型一定有这些档位。 */
export function classifyTier(fileName) {
  const n = String(fileName ?? '').toLowerCase()
  if (/q[2-8]_k|q4|q8|gguf|int[48]|fp8/u.test(n)) return { id: 'quant', label: '量化档' }
  if (/turbo|distill|lite|small/u.test(n)) return { id: 'turbo', label: '蒸馏 / 轻量档' }
  if (/fp16|bf16|half/u.test(n)) return { id: 'fp16', label: '半精度档' }
  if (/fp32|full|dev/u.test(n)) return { id: 'full', label: '完整 / 原版档' }
  if (/\.safetensors$|\.ckpt$|\.pth$|\.bin$|\.gguf$/u.test(n)) return { id: 'weight', label: '权重文件' }
  return { id: 'other', label: '其它文件' }
}

/** 运行时动态列文件：拿不到就明确说「未核实 / 不可达」，绝不编造清单。 */
export async function listRepoFiles({ source, repo, fetch: fetchFn } = {}) {
  if (!repo) return { ok: false, files: [], reason: '该模型未核实到 HF 仓库名，请自备文件' }
  if (typeof fetchFn !== 'function') return { ok: false, files: [], reason: '未注入 fetch，无法列举远端文件' }
  try {
    const res = await fetchFn(buildRepoTreeUrl(source, repo), { method: 'GET' })
    if (!res?.ok) return { ok: false, files: [], reason: '远端仓库不可达（HTTP ' + (res?.status ?? '?') + '），请自备文件或换源' }
    const data = await res.json()
    const rows = Array.isArray(data) ? data : []
    return {
      ok: true,
      files: rows.filter((x) => x && typeof x.path === 'string').map((x) => ({
        path: x.path,
        size: Number(x.size) || 0,
        tier: classifyTier(x.path),
      })),
      reason: '',
    }
  } catch {
    return { ok: false, files: [], reason: '列举远端文件失败（详见本机日志），请自备文件或换源' }
  }
}

/** 服务器权威值：判完整性的唯一依据。 */
export async function probeRemote({ url, fetch: fetchFn } = {}) {
  if (typeof fetchFn !== 'function') return { ok: false, reason: '未注入 fetch，无法取得服务器权威值' }
  try {
    const res = await fetchFn(String(url ?? ''), { method: 'HEAD' })
    const h = res?.headers ?? {}
    const get = (k) => (typeof h.get === 'function' ? h.get(k) : (h[k] ?? null))
    const sizeRaw = get('x-linked-size') ?? get('content-length')
    const size = Number(sizeRaw)
    return {
      ok: Number.isFinite(size) && size > 0,
      size: Number.isFinite(size) && size > 0 ? size : null,
      etag: get('x-linked-etag') ?? get('etag') ?? null,
      sha256: get('x-linked-etag') ?? null,
      status: res?.status ?? null,
      reason: Number.isFinite(size) && size > 0 ? '' : '服务器未给出权威大小，不能判定完整性',
    }
  } catch {
    return { ok: false, reason: '权威值探测失败（详见本机日志）' }
  }
}

/** 自备文件指引：失败兜底，绝不上传本机文件。 */
export function selfBringGuide(group) {
  return {
    ok: false,
    bringYourOwn: true,
    reason: '自动下载未成功；可自行下载权重后放到对应目录',
    steps: [
      '从你信任的来源自行下载该模型权重（插件不上传、不代传任何本机文件）',
      group?.installHint ?? '按节点包文档放置权重',
      '在插件里配置独立 Worker 的启动命令与环境路径，再用 manage_workers 做显存预检',
      '插件不创建 venv / conda / Docker，不 pip install，不自动安装依赖',
    ],
  }
}

/**
 * 多源轮询 + 断点续传 + 权威值校验。所有 I/O 注入，离线可测。
 * target 只用调用方给的相对名字，日志绝不打印本机绝对路径。
 */
export async function downloadWithFallback({
  repo, file, sources = DEFAULT_SOURCES, fetch: fetchFn, fs: fsApi,
  target, group, onProgress,
} = {}) {
  if (!repo || !file) return selfBringGuide(group)
  if (typeof fetchFn !== 'function' || !fsApi) return selfBringGuide(group)
  const attempts = []
  for (const source of sources) {
    const url = buildResolveUrl(source, repo, file)
    const probe = await probeRemote({ url, fetch: fetchFn })
    if (!probe.ok) { attempts.push({ source: source.id, reason: probe.reason }); continue }
    try {
      const current = typeof fsApi.statSync === 'function' && target
        ? (() => { try { return fsApi.statSync(target).size } catch { return 0 } })()
        : 0
      if (current > probe.size) {
        attempts.push({ source: source.id, reason: '本地文件比服务器权威值还大，拒绝续传（请自行核对后删除重下）' })
        continue
      }
      if (current === probe.size) {
        return { ok: true, complete: true, resumed: false, source: source.id,
          size: probe.size, etag: probe.etag, sha256: probe.sha256,
          reason: '已有文件与服务器权威大小一致，无需重下' }
      }
      const headers = current > 0 ? { Range: 'bytes=' + current + '-' } : {}
      const res = await fetchFn(url, { method: 'GET', headers })
      if (!res?.ok) { attempts.push({ source: source.id, reason: 'HTTP ' + (res?.status ?? '?') }); continue }
      const bytes = typeof res.arrayBuffer === 'function'
        ? Buffer.from(await res.arrayBuffer()) : Buffer.from(res.body ?? [])
      if (bytes.length === 0) { attempts.push({ source: source.id, reason: '源返回空内容' }); continue }
      const finalSize = current + bytes.length
      if (finalSize !== probe.size) {
        attempts.push({ source: source.id, reason: '下载字节数与服务器权威大小不一致，判为不完整' })
        continue
      }
      if (target) {
        if (current > 0 && typeof fsApi.appendFileSync === 'function') fsApi.appendFileSync(target, bytes)
        else if (typeof fsApi.writeFileSync === 'function') fsApi.writeFileSync(target, bytes)
      }
      try { onProgress?.({ source: source.id, size: finalSize }) } catch { /* 忽略 */ }
      return { ok: true, complete: true, resumed: current > 0, source: source.id,
        size: finalSize, etag: probe.etag, sha256: probe.sha256,
        reason: '已按服务器权威值校验完整（不声称哈希已验证，除非调用方另行比对 ETag）' }
    } catch {
      attempts.push({ source: source.id, reason: '下载过程异常（详见本机日志）' })
    }
  }
  return { ...selfBringGuide(group), attempts }
}

/** 给 CLI 的只读摘要：不联网、不下载、不安装。 */
export function describeCatalog() {
  return {
    version: CATALOG_VERSION,
    defaultClosed: true,
    autoInstall: false,
    uploadLocalFiles: false,
    sources: DEFAULT_SOURCES.map((s) => ({ ...s })),
    groups: listCatalogGroups(),
    rules: [
      '默认只读；下载必须显式执行，安装由用户自己完成。',
      '文件清单运行时动态列举，未核实到仓库名的模型只支持自备文件。',
      '完整性只以服务器 Content-Length / X-Linked-Size / ETag 权威值判定。',
      '绝不上传本机模型文件；脚本不写任何本机绝对路径。',
    ],
  }
}
