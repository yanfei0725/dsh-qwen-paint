/**
 * lib/reference-web.js —— 联网参考图 provider + 硬同意门。
 *
 * ## 需求约束（用户明确要求）
 *   "可以开一点点网搜参考图什么的但是必须要用户同意"。
 *   所以联网能力 = **默认拒绝 + 每次请求显式同意 + 端点由用户配置（占位符）**。
 *   一次同意只管一次请求，绝非"开着就一直可联网"。
 *
 * ## 三条硬闸（缺一不可，顺序即防线）
 *   ① consent：调用方必须显式传 `consent: true`。没有任何全局开关、环境推断或
 *      "默认允许"。缺 consent 直接抛 ConsentRequired，连 URL 都不解析。
 *   ② endpoint：必须是用户配置的合法**外部 https** 地址。回环 / 内网 / 云元数据
 *      地址一律拒绝（防止把查询打到本机服务或 169.254.169.254 造成 SSRF）。
 *      占位符 `<API_ENDPOINT>` 未替换时也拒绝 —— 不臆造真实搜索 API 地址。
 *   ③ payload：只发**查询词**与条数上限。重新构造白名单对象，而不是从调用方
 *      大对象里删黑名册字段 —— 结构上不可能带上 prompt / seed / 本机路径 / 凭据。
 *
 * ## 只返回 URL，不下载字节
 *   本模块只产出候选参考图的 URL 清单。图片下载 / 上传给 ComfyUI 由调用方在
 *   用户**选定**之后走既有本地流程（uploadReference）。插件不自动抓取远程字节，
 *   不把远程内容直接喂进工作流。
 *
 * ## 可注入 fetch
 *   `fetchReferenceCandidates(query, opts, { fetchFn })` 接受注入的 fetch，便于
 *   离线回归验证"没同意绝不发请求 / 载荷只含查询词 / 响应只取 URL"，不真联网。
 *   本模块不 import net-guard 的全局 allowRemote 开关 —— 那是 ComfyUI 回环约束，
 *   与联网检索是两回事，不复用、不互相放行。
 */

/** 端点占位符：必须由用户在配置里替换成真实地址，否则拒绝出站。 */
export const WEB_ENDPOINT_PLACEHOLDER = '<API_ENDPOINT>'

/** 同意缺失时抛出的错误码（供端点映射成 403，供测试判定）。 */
export const CONSENT_REQUIRED = 'CONSENT_REQUIRED'
export const ENDPOINT_REQUIRED = 'ENDPOINT_REQUIRED'
export const ENDPOINT_UNSAFE = 'ENDPOINT_UNSAFE'
export const QUERY_REQUIRED = 'QUERY_REQUIRED'

const PRIVATE_HOST = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|0\.|\[?::1\]?$|localhost$|metadata\.google\.internal$)/i
const LOOPBACK_LITERALS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '169.254.169.254'])

/**
 * 统一主机判定（端点校验 + 候选 URL 过滤共用，避免两处口径漂移）。
 *
 * ★ 2026-11-12 回归补的两处真缺口：
 *   ① `localhost.`（FQDN 尾点）会解析到 127.0.0.1，但它既不等于字符串 'localhost'，
 *      也不匹配 PRIVATE_HOST 里的 `localhost$` —— 旧判定会放行，查询词打到本机端口，
 *      是**真 SSRF**。同理 `LOCALHOST.`（URL 已小写）。
 *   ② `localhost.evil.com` 这类前缀伪装域名，与 net-guard 既有口径
 *      （`localhost.evil.com` 必须拒绝）相反，一并收拢。
 *   ③ IPv6 形态整块缺失：旧判定只认 `::1`，实测 `[fd00::1]`（ULA）、
 *      `[fe80::1]`（链路本地）、`[fec0::1]`（站点本地）、`[::ffff:7f00:1]`
 *      （IPv4-mapped 回环）、`[::]`（未指定）全部被放行。
 *   WHATWG URL 会把纯数字 / 八进制 / 十六进制 IPv4（2130706433、0177.0.0.1、
 *   0x7f000001、127.1）规范化成 `127.0.0.1`，这类变体由 LOOPBACK_LITERALS 兜住。
 */
function isUnsafeHost(raw) {
  const host = String(raw ?? '').toLowerCase()
  if (LOOPBACK_LITERALS.has(host) || PRIVATE_HOST.test(host)) return true
  // localhost / localhost. / localhost.anything —— 前缀伪装与尾点 FQDN 一律拒绝
  if (/^localhost(?:\.|$)/.test(host)) return true
  // IPv6：WHATWG URL 的 hostname 带方括号。公网全球单播只有 2000::/3，
  // 即首组以 2 或 3 开头；其余（:: 回环/mapped、fc00::/7 ULA、fe80::/10
  // 链路本地、fec0::/10 站点本地、ff00::/8 组播）一律不允许出站。
  // 这样既堵住 IPv4-mapped 绕过，也不会误伤 2001:db8::1 之类的公网地址。
  if (host.startsWith('[') && !/^\[[23]/.test(host)) return true
  return false
}

/**
 * 校验端点是不是"可安全出站的外部地址"。
 * @returns {{ ok: true, url: URL } | { ok: false, code: string, reason: string }}
 */
export function checkSearchEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw === WEB_ENDPOINT_PLACEHOLDER) {
    return { ok: false, code: ENDPOINT_REQUIRED, reason: '未配置联网检索端点（占位符 <API_ENDPOINT> 需替换成真实地址）' }
  }
  let url
  try { url = new URL(raw) } catch { return { ok: false, code: ENDPOINT_UNSAFE, reason: '端点不是合法 URL' } }
  if (url.protocol !== 'https:') {
    return { ok: false, code: ENDPOINT_UNSAFE, reason: `端点必须使用 https（收到 ${url.protocol}）` }
  }
  // 拒绝 https://user:pass@host/ 形态：凭据会随 fetch 外泄，也会落进日志。
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: ENDPOINT_UNSAFE, reason: '端点 URL 不允许内嵌用户名/密码（避免凭据随请求外泄）' }
  }
  if (isUnsafeHost(url.hostname)) {
    return { ok: false, code: ENDPOINT_UNSAFE, reason: '端点不能指向回环 / 内网 / 云元数据地址（SSRF 防护）' }
  }
  return { ok: true, url }
}

/**
 * 硬同意门：所有前置条件一次判完。**默认拒绝**。
 * @param {object} opts { consent, endpoint, query }
 * @returns {{ ok: true, endpoint: URL, query: string } | { ok: false, code, reason }}
 */
export function assertWebConsent(opts = {}) {
  // ① 同意在最前：不同意时连端点都不解析，绝不产生任何副作用。
  if (opts.consent !== true) {
    return { ok: false, code: CONSENT_REQUIRED, reason: '联网检索需要用户每次显式同意（consent: true）；默认拒绝' }
  }
  // ② 端点
  const ep = checkSearchEndpoint(opts.endpoint)
  if (!ep.ok) return ep
  // ③ 查询词
  const query = typeof opts.query === 'string' ? opts.query.trim().slice(0, 200) : ''
  if (query === '') return { ok: false, code: QUERY_REQUIRED, reason: '查询词不能为空' }
  return { ok: true, endpoint: ep.url, query }
}

/**
 * 构造出站载荷：**白名单重新构造**，只含查询词与条数。
 * 绝不从调用方对象 spread —— 结构上杜绝夹带 prompt / seed / 路径 / 凭据。
 */
export function buildSearchPayload(query, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(16, Math.trunc(opts.limit))) : 6
  return {
    query: String(query ?? '').trim().slice(0, 200),
    limit,
    // 明确只要图片候选，避免端点返回其它媒体类型
    media: 'image',
  }
}

/** 出站请求描述（不含任何凭据；认证头由调用方按端点要求另配，不落在本模块）。 */
export function buildSearchRequest(query, opts = {}) {
  // ★ 首参 query 必须真正进同意门。/reference/search 端点是
  //   fetchReferenceCandidates(body.query, { consent, endpoint, limit }) 这么调的，
  //   opts 里没有 query —— 旧写法 assertWebConsent(opts) 会一律判 QUERY_REQUIRED，
  //   联网检索永远发不出去（功能看似存在，实则死路）。
  //   opts.query 显式给出时优先（便于测试与显式覆盖），否则取首参。
  const gate = assertWebConsent({ ...opts, query: opts.query ?? query })
  if (!gate.ok) return gate
  return {
    ok: true,
    url: gate.endpoint.toString(),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSearchPayload(gate.query, opts)),
      redirect: 'error', // 不跟随重定向（302 到内网 = 越界，直接失败）
    },
    query: gate.query,
  }
}

/** 从端点响应的各种形状里提取候选 URL，过滤掉非 http(s) / 内网地址。 */
export function normalizeCandidates(payload) {
  const out = []
  const seen = new Set()
  const push = (raw, title, source) => {
    if (typeof raw !== 'string' || raw.trim() === '') return
    let u
    try { u = new URL(raw.trim()) } catch { return }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    if (u.username !== '' || u.password !== '') return
    if (isUnsafeHost(u.hostname)) return
    if (seen.has(u.toString())) return
    seen.add(u.toString())
    out.push({ url: u.toString(), title: typeof title === 'string' ? title.slice(0, 120) : '', source: typeof source === 'string' ? source.slice(0, 80) : '' })
  }
  const walk = (v) => {
    if (!v) return
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (typeof v === 'string') { push(v); return }
    if (typeof v === 'object') {
      if (typeof v.url === 'string') push(v.url, v.title, v.source)
      else if (typeof v.image === 'string') push(v.image, v.title, v.source)
      else if (typeof v.link === 'string') push(v.link, v.title, v.source)
      for (const key of ['results', 'items', 'images', 'data', 'candidates']) {
        if (v[key] !== undefined) walk(v[key])
      }
    }
  }
  walk(payload)
  return out
}

/**
 * 联网检索候选参考图。**默认拒绝**，只有 assertWebConsent 全过才发请求。
 * @param {string} query 查询词
 * @param {object} opts { consent, endpoint, limit }
 * @param {object} deps { fetchFn, signal }
 * @returns {Promise<{ ok, candidates, reason?, code?, count }>}
 */
export async function fetchReferenceCandidates(query, opts = {}, deps = {}) {
  const req = buildSearchRequest(query, opts)
  if (!req.ok) return { ok: false, code: req.code, reason: req.reason, candidates: [], count: 0 }
  const fetchFn = deps.fetchFn ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
  if (typeof fetchFn !== 'function') return { ok: false, code: 'NO_FETCH', reason: '没有可用的 fetch 实现', candidates: [], count: 0 }
  try {
    const init = { ...req.init }
    if (deps.signal) init.signal = deps.signal
    const res = await fetchFn(req.url, init)
    if (!res || res.ok === false) {
      const status = res && typeof res.status === 'number' ? res.status : 0
      return { ok: false, code: 'HTTP_ERROR', reason: `检索端点返回 HTTP ${status}`, candidates: [], count: 0 }
    }
    let payload
    if (typeof res.json === 'function') payload = await res.json()
    else if (typeof res.text === 'function') payload = JSON.parse(await res.text())
    else payload = res
    const candidates = normalizeCandidates(payload)
    return { ok: true, candidates, count: candidates.length, query: req.query }
  } catch (error) {
    return { ok: false, code: 'FETCH_FAILED', reason: String(error?.message ?? error), candidates: [], count: 0 }
  }
}

/** 给端点/面板用的人话说明（如实披露联网能力与同意要求）。 */
export function describeWebReference() {
  return {
    endpointPlaceholder: WEB_ENDPOINT_PLACEHOLDER,
    consent: 'per-request-explicit',
    defaultAction: 'deny',
    outboundFields: ['query', 'limit', 'media'],
    note: '联网检索默认拒绝；仅在用户每次显式同意且已配置 https 端点时，把查询词发往该端点；只返回候选 URL，不自动下载图片字节。',
  }
}
