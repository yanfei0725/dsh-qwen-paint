/**
 * lib/doctor.js —— 运行期快速自诊断（不出图、不联网、不下载）。
 *
 * 与安装期的 scripts/setup.mjs 分工：setup 负责「装」，doctor 负责「现在能不能跑」。
 * 两层输出：默认只给一行 summary（`?detail=1` 或工具参数 detail:true 才展开 details[]），
 * 这样界面上默认简略、用户点开才看详情。
 *
 * 诚实边界：
 *   · 每个检查都是通过 deps.probes 注入的；**没注入就等于没检测**，
 *     一律标 undetected，绝不假装通过；
 *   · 模型完整性只接受调用方传入的「服务器权威 size / ETag」做比对，
 *     拿不到权威值就标未检测 —— 绝不用记忆里的大小判定文件残缺；
 *   · 异常细节只进本机日志，回给调用方固定文案（error.message 可能带本机路径）。
 */
export const DOCTOR_CHECKS = Object.freeze([
  { id: 'comfy_online', label: 'ComfyUI 连通性', probeKey: 'comfyOnline' },
  { id: 'model_integrity', label: '模型文件完整性', probeKey: 'modelIntegrity' },
  { id: 'accel_packs', label: '加速组件是否就位', probeKey: 'accelPacks' },
  { id: 'attention_backend', label: '显卡匹配的注意力后端', probeKey: 'attentionBackend' },
  { id: 'output_dir_writable', label: '出图目录可写', probeKey: 'outputDir' },
  { id: 'ffmpeg', label: 'ffmpeg / ffprobe 可用性', probeKey: 'ffmpeg' },
  { id: 'tts_backend', label: 'TTS 后端可用性', probeKey: 'ttsBackend' },
  { id: 'history_db', label: '生成历史索引可用', probeKey: 'historyDb' },
])

/**
 * ★ 2026-11-14 全面排查补齐：探针契约。
 * 8 项检查里当前只有 outputDir / historyDb 由 tool-registry 注入，
 * 其余全是 undetected —— 用户点开详情只看到一片「未检测」，不知道还差什么。
 * 这里把「每项需要宿主注入什么探针」写清楚，注入状态如实标 injected/missing，
 * 绝不因为写了契约就假装已经检测过。
 */
export const PROBE_CONTRACT = Object.freeze([
  { id: 'comfy_online', probeKey: 'comfyOnline', needs: '探测 127.0.0.1 ComfyUI 是否在线（/system_stats）' },
  { id: 'model_integrity', probeKey: 'modelIntegrity', needs: '用服务器权威 size / ETag 比对本机模型文件；拿不到权威值一律标未检测' },
  { id: 'accel_packs', probeKey: 'accelPacks', needs: '/object_info 里加速节点是否就位（QwenImage21Cache / TeaCache / Triton 等）' },
  { id: 'attention_backend', probeKey: 'attentionBackend', needs: '当前显卡匹配的注意力内核（sage / flash / ck / pytorch）是否可用' },
  { id: 'output_dir_writable', probeKey: 'outputDir', needs: '出图目录可写检查' },
  { id: 'ffmpeg', probeKey: 'ffmpeg', needs: 'ffmpeg / ffprobe 可用性' },
  { id: 'tts_backend', probeKey: 'ttsBackend', needs: 'TTS 生成节点与音频权重是否就位（权重不自动下载）' },
  { id: 'history_db', probeKey: 'historyDb', needs: '生成历史索引（node:sqlite）可用性' },
])

export function buildProbeContract(probes = {}) {
  return PROBE_CONTRACT.map((p) => {
    const injected = typeof probes?.[p.probeKey] === 'function'
    return { id: p.id, needs: p.needs, injected, status: injected ? 'injected' : 'missing' }
  })
}

const FIXED_ERROR = '该项检查执行异常（详见插件日志）'
const UNDETECTED = '未检测（未提供该探针）'

function normalizeResult(row) {
  if (!row) return { status: 'undetected', detail: UNDETECTED }
  if (typeof row === 'boolean') {
    return { status: row ? 'pass' : 'fail', detail: row ? '正常' : '异常' }
  }
  const status = ['pass', 'fail', 'undetected'].includes(row.status)
    ? row.status : (row.ok === true ? 'pass' : (row.ok === false ? 'fail' : 'undetected'))
  return { status, detail: String(row.detail ?? (status === 'pass' ? '正常' : UNDETECTED)).slice(0, 240) }
}

/** 纯函数：把逐项结果聚成一行摘要 + 明细。 */
export function buildDoctorReport(results = []) {
  const details = []
  const byId = new Map(Array.isArray(results) ? results.map((r) => [r?.id, r]) : [])
  for (const c of DOCTOR_CHECKS) {
    const n = normalizeResult(byId.get(c.id))
    details.push({ id: c.id, label: c.label, status: n.status, detail: n.detail })
  }
  const passed = details.filter((d) => d.status === 'pass').length
  const pending = details.filter((d) => d.status === 'undetected').length
  const failed = details.filter((d) => d.status === 'fail').length
  // ★ 一项都没真检测过时绝不能报 ok:true —— 那等于假装环境就绪。
  return {
    ok: failed === 0 && passed > 0,
    checked: details.length,
    passed, pending, failed,
    summary: passed + ' 项通过 / ' + pending + ' 项待检查 / ' + failed + ' 项异常',
    details,
    reason: failed > 0 ? '有检查项异常，展开详情看具体项'
      : (passed === 0 ? '没有可用探针，无法判定环境是否就绪' : ''),
  }
}

/** 真跑探针：probes 里没给的项保持 undetected，绝不猜。 */
export async function collectDoctorResults(probes = {}, log) {
  const rows = []
  for (const c of DOCTOR_CHECKS) {
    const fn = probes?.[c.probeKey]
    if (typeof fn !== 'function') {
      rows.push({ id: c.id, status: 'undetected', detail: UNDETECTED })
      continue
    }
    try {
      rows.push({ id: c.id, ...normalizeResult(await fn()) })
    } catch (error) {
      log?.('warn', '自诊断 ' + c.id + ' 异常：' + (error?.message ?? error))
      rows.push({ id: c.id, status: 'fail', detail: FIXED_ERROR })
    }
  }
  return rows
}

export function makeDoctorTool(deps = {}) {
  return {
    name: 'doctor',
    description: '排障第一步：不出图、不联网，逐项检查本机 ComfyUI 连通性、模型文件完整性、'
      + '加速组件、显卡匹配的注意力后端、出图目录、ffmpeg、TTS 后端与历史索引。'
      + '默认只回一行人类可读摘要（summary）；要看逐项明细请传 detail:true。'
      + '未提供的探针一律标「未检测」，绝不假装通过；模型完整性只按服务器权威大小比对。'
      + '参数：detail(布尔)、probes 由插件接线注入。纯本地只读。',
    timeoutMs: 30 * 1000,
    output: { schema: { type: 'object', properties: {
      ok: { type: 'boolean' }, summary: { type: 'string' }, details: { type: 'array' },
      checked: { type: 'number' }, reason: { type: 'string' },
      probe_contract: { type: 'array' },
    } } },
    async execute(args = {}) {
      const rows = await collectDoctorResults(deps.probes, deps.log)
      const report = buildDoctorReport(rows)
      const wantDetail = args.detail === true || args.detail === 1
      return {
        ok: report.ok, summary: report.summary,
        details: wantDetail ? report.details : [],
        probe_contract: wantDetail ? buildProbeContract(deps.probes) : [],
        checked: report.checked, reason: report.reason,
      }
    },
  }
}

/** GET /api/qwen-paint/doctor：默认简略，?detail=1 才展开。 */
export function doctorRouteTable(deps = {}) {
  const { respondJson, isLocalRequest, log } = deps
  return [{
    path: '/api/qwen-paint/doctor',
    method: 'GET',
    handler: async (req, res) => {
      if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
        respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
      }
      try {
        const rows = await collectDoctorResults(deps.probes, log)
        const report = buildDoctorReport(rows)
        const q = req?.query || {}
        const detail = q.detail === '1' || q.detail === 1 || q.detail === true
        respondJson(res, {
          ok: report.ok, summary: report.summary, checked: report.checked,
          passed: report.passed, pending: report.pending, failed: report.failed,
          details: detail ? report.details : [],
          probe_contract: detail ? buildProbeContract(deps.probes) : [],
          reason: report.reason,
        }, 200)
      } catch (error) {
        log?.('warn', '自诊断端点异常：' + (error?.message ?? error))
        respondJson(res, { ok: false, reason: '自诊断暂不可用（详见插件日志）' }, 500)
      }
    },
  }]
}
