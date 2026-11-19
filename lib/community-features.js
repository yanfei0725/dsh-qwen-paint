/** lib/community-features.js —— 社区 ⚠️ 功能的最小内置形态：发现 + 报告 + 指引。
 *  只查本机 object_info / 注入的模型文件名，不下载、不 patch 第三方节点、不装付费节点。
 *  没有证据就说没有证据；不把“社区有这个功能”说成“本插件已实现”。
 */
export const COMMUNITY_FEATURE_TOOL = 'probe_community_features'
export const COMMUNITY_FEATURE_PATH = '/api/qwen-paint/community/probe'
const FEATURES = Object.freeze(['vae_dtype', 'comfy_mcp', 'wan22_5b'])

const asNodes = (probeResult) => {
  if (!probeResult || probeResult.ok === false) return []
  const nodes = probeResult.nodes ?? probeResult.objectInfo ?? []
  if (Array.isArray(nodes)) return nodes.filter((n) => typeof n === 'string')
  if (nodes && typeof nodes === 'object') return Object.keys(nodes)
  return []
}

/** VAE dtype：只认 object_info 里真实出现的输入名；不猜、不强行 patch forward。 */
export function findVaeDtype(objectInfo) {
  const nodes = asNodes(objectInfo)
  const hits = []
  for (const name of nodes) {
    if (!/vae/iu.test(name)) continue
    const ins = objectInfo?.objectInfo && typeof objectInfo.objectInfo === 'object'
      ? Object.keys(objectInfo.objectInfo[name]?.input ?? {})
      : []
    const dtype = ins.filter((s) => /dtype|compute_dtype/u.test(s))
    if (dtype.length) hits.push({ node: name, inputs: dtype })
  }
  return {
    feature: 'vae_dtype', available: hits.length > 0, nodes: hits,
    reason: hits.length ? '节点确实暴露 dtype 输入' : '当前 VAE 节点未暴露 dtype/compute_dtype 输入，需实测节点实现',
    guide: '检测到 expose 才可设置；否则只能报告“未暴露”，不 patch 第三方节点。'
      + '运行时可先查 model_options.dtype 是否被内核采用，未证实不得声称生效。',
    fallback: { applied: false, dtype: 'fp32', reason: hits.length ? '' : 'node_input_missing' },
  }
}

/** Comfy MCP：仅发现原生 HTTP API 是否可达；不在插件内实现 Agent 调度循环。 */
export function findComfyMcp(objectInfo) {
  const reachable = Boolean(objectInfo && objectInfo.ok !== false && asNodes(objectInfo).length > 0)
  return {
    feature: 'comfy_mcp', available: reachable,
    endpoints: ['/prompt', '/queue', '/history', '/interrupt'],
    reason: reachable ? 'object_info 可达，ComfyUI 原生 API 可用' : '本机 /object_info 未就绪，无法确认原生 API 可用',
    guide: '若要做 MCP 驱动，只封装 ComfyUI 原生 HTTP/WebSocket；自定义节点输出不在 history[prompt_id].outputs 标准字段时由 Agent 侧后处理。'
      + '不实现 ToolCaller / AgentCore 调度循环，职责倒挂。',
    fallback: { status: 'unavailable', outputs: [] },
  }
}

/** Wan2.2 5B：只按节点名/注入模型文件名找证据，缺证据明确“需实测”。 */
export function findWan225B(objectInfo, modelFiles = []) {
  const nodes = asNodes(objectInfo).filter((n) => /wan/i.test(n) || /video/i.test(n))
  const models = (Array.isArray(modelFiles) ? modelFiles : []).filter((s) => /wan/i.test(s) && /5\s*b|5b/i.test(s))
  const available = nodes.some((n) => /wan/i.test(n)) || models.length > 0
  return {
    feature: 'wan22_5b', available, nodes: nodes.slice(0, 20), models: models.slice(0, 20),
    reason: available ? '发现可疑节点/模型名，仍需真机加载验证' : '未探到可确证的 Wan2.2 5B 节点或模型文件名，需实测',
    guide: '模型本身可另装；本插件不捆绑、不下载、不谎称已加载。确认节点名和权重许可证后再接入工作流。',
    fallback: { available: false, degraded: true, reason: 'not_discovered' },
  }
}

export function probeFeature(feature, objectInfo, modelFiles) {
  if (feature === 'vae_dtype') return findVaeDtype(objectInfo)
  if (feature === 'comfy_mcp') return findComfyMcp(objectInfo)
  if (feature === 'wan22_5b') return findWan225B(objectInfo, modelFiles)
  return { feature: String(feature ?? ''), available: false, reason: `feature 只能是 ${FEATURES.join('|')}`,
    guide: '', fallback: { available: false } }
}

export function makeCommunityFeatureTool(deps = {}) {
  return {
    name: COMMUNITY_FEATURE_TOOL,
    description: '只读发现三项社区能力：VAE dtype 输入、ComfyUI 原生 API（MCP 驱动前提）、Wan2.2 5B 轻量视频模型。'
      + '返回“发现到了什么 / 缺什么 / 怎么接 / 降级返回”，不下载模型、不装付费节点、不 patch 第三方节点。',
    timeoutMs: 20000,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { feature: { type: 'string', enum: [...FEATURES] } },
      required: ['feature'],
    },
    output: { schema: { type: 'object', additionalProperties: true,
      properties: {
        feature: { type: 'string' }, available: { type: 'boolean' }, reason: { type: 'string' },
        guide: { type: 'string' }, fallback: { type: 'object' },
      } } },
    async execute(args = {}) {
      try {
        const objectInfo = typeof deps.objectInfoProbe === 'function'
          ? await deps.objectInfoProbe()
          : { ok: false, nodes: [], reason: '未注入 object_info 探测器' }
        const modelFiles = typeof deps.listModelFiles === 'function' ? await deps.listModelFiles() : []
        return probeFeature(args.feature, objectInfo, modelFiles)
      } catch {
        return { feature: String(args?.feature ?? ''), available: false, reason: '社区能力探测失败（详见插件日志）',
          guide: '', fallback: { available: false } }
      }
    },
  }
}

/** 本机 POST 端点：回环校验 + 写守卫；只读探测，不执行任何社区节点。 */
export function communityFeatureRouteTable(deps = {}) {
  const { isLocalRequest, respondJson, readJsonBody, guardWriteRequest, log } = deps
  const tool = deps.tool || makeCommunityFeatureTool(deps)
  const handler = async (req, res) => {
    if (typeof isLocalRequest === 'function' && !isLocalRequest(req)) {
      respondJson(res, { ok: false, reason: 'local requests only' }, 403); return
    }
    if (String(req?.method ?? '').toUpperCase() !== 'POST') {
      respondJson(res, { ok: false, reason: 'POST only' }, 405); return
    }
    if (typeof guardWriteRequest === 'function' && !guardWriteRequest(req, res)) return
    try {
      const body = typeof readJsonBody === 'function' ? (await readJsonBody(req)) ?? {} : {}
      respondJson(res, await tool.execute(body))
    } catch (error) {
      try { log?.('warn', `社区能力探测端点失败：${error?.message ?? error}`) } catch { /* 忽略 */ }
      respondJson(res, { ok: false, reason: '社区能力探测暂不可用（详见插件日志）' }, 500)
    }
  }
  return [{ path: COMMUNITY_FEATURE_PATH, method: 'POST', handler }]
}
