/**
 * dsh-qwen-paint —— 网络边界守卫（2026-10-15 新增，DSH STORE 合规整改）
 *
 * ## 为什么有这个文件
 *   DSH STORE 自动审核（AI-Scarlett）在 Issue #1390 指出：
 *
 *   > 当前 README 仍将网络能力声明为"仅本机回环、不访问外部地址"，但
 *   > `lib/index.js` 直接合并 `rawConfig`，随后使用可配置的 `comfyUrl`
 *   > 发起请求，未证明回环约束及重定向边界。
 *
 *   也就是说 —— **文档说了"只用 127.0.0.1"，代码里却没有任何一处真的拦住
 *   别的地址**。`comfyUrl` 是个普通配置项，写 `http://192.168.1.100:8188`
 *   或者任何公网地址，插件都会照发请求。这是"声明与实现不符"，也是本轮
 *   被拒的唯一理由。
 *
 *   审核员同时明确了两点：
 *     · **不要删除功能**，也不要"把真实能力声明为 false"来蒙混；
 *     · 请正面解决：**要么落地限制并处理重定向，要么如实披露可配置的外部端点**。
 *
 *   本文件即"落地限制"那一支：把回环约束做成**代码层强制**，并**禁止重定向**，
 *   同时保留一个显式的 opt-in 开关 `allowRemoteComfy`，让确实需要连局域网
 *   ComfyUI 的用户能**主动、明确地**关掉这道闸（而不是靠改文档撒谎）。
 *
 * ## 设计原则
 *   · 默认拒绝：`allowRemoteComfy` 为 false（默认值）时，非回环地址一律抛错。
 *   · 校验在**启动时**做一次（apply() 里），fail-fast，不让配错的地址带着
 *     半边功能跑起来，到出图那一刻才莫名其妙地失败。
 *   · 每个请求发出去之前**再校验一次**（safeFetch），防住"启动后被改配置"或
 *     "URL 在别处被拼接"的漏网。
 *   · 重定向一律 `redirect: 'error'` —— 不跟。回环地址被 302 到公网是最典型的
 *     越界手法，直接让 fetch 抛错，比"跟过去再检查"可靠得多。
 *
 * ## 不放宽的东西
 *   · 不做 DNS 解析后的二次校验 —— 本插件只在**字面量 IP / localhost** 上工作，
 *     连"域名"都不接受（见 isLoopbackUrl）。这样就不存在 DNS rebinding 面：
 *     没有任何名字需要解析，也就没有"解析前是回环、解析后是外部"的窗口。
 */

/** 允许出现的主机名白名单（字面量，不做 DNS 解析）。 */
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  // 127.0.0.0/8 整个网段都是回环，常见写法只列最常用的几个
  '127.0.0.2',
  '0.0.0.0', // 绑定/连接语义上是"本机"，ComfyUI 默认监听它
])

/** 明确判为"非本机"的私有/外部网段提示（仅用于把错误信息说清楚）。 */
const PRIVATE_HINT = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/

/**
 * 判断一个 URL 是否指向**本机回环**。
 *
 * 只认字面量：`127.0.0.0/8`、`localhost`、`::1`、`0.0.0.0`。
 * **不接受任何域名**（包括想伪装成 localhost 的 `localhost.evil.com`）——
 * 域名会带来 DNS 解析环节，解析前后可能不一致（DNS rebinding），
 * 而我们根本不需要支持"远程域名"这个场景。少一个面，少一份风险。
 *
 * @param {string} raw 待检查的 URL
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function isLoopbackUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '地址为空或不是字符串' }
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `协议不受支持：${url.protocol}（只允许 http/https）` }
  }
  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) {
    const kind = PRIVATE_HINT.test(host) ? '局域网地址' : '外部地址'
    return { ok: false, reason: `解析到${kind}「${host}」，非本机回环` }
  }
  return { ok: true, url }
}

/**
 * 断言一个 URL 必须指向本机回环；否则抛错。
 *
 * @param {string} raw       待检查的 URL
 * @param {object} [opts]
 * @param {boolean} [opts.allowRemote=false] 显式放行非回环地址（用户主动 opt-in）
 * @param {string}  [opts.what='comfyUrl']   出错信息里显示的配置项名
 * @param {(level:string, msg:string)=>void} [opts.log] 可选日志
 * @returns {URL} 校验通过的 URL 对象
 */
export function assertLocalUrl(raw, { allowRemote = false, what = 'comfyUrl', log } = {}) {
  const r = isLoopbackUrl(raw)
  if (r.ok) return r.url

  if (allowRemote) {
    // 用户显式同意连外部端点 —— 如实放行，但要留痕，且仅限 http/https。
    let u
    try {
      u = new URL(raw)
    } catch {
      throw new Error(`[net-guard] 配置项 ${what} 不是合法 URL：${raw}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`[net-guard] 配置项 ${what} 协议不受支持：${u.protocol}（只允许 http/https）`)
    }
    log?.('warn', `${what} 指向非本机地址（${u.hostname}）—— 因为你显式设置了 allowRemoteComfy: true，已放行。`
      + '请注意：插件此时会向该地址发送提示词与图片数据，请自行确认这是你信任的机器。')
    return u
  }

  throw new Error(
    `[net-guard] 拒绝启动：配置项 ${what} 指向非本机回环地址。\n`
    + `  实际值：${raw}\n`
    + `  原因  ：${r.reason}\n`
    + '  本插件默认只允许连接本机（127.0.0.1 / localhost / ::1）的 ComfyUI。\n'
    + '  如果你**确实**要连局域网或远程的 ComfyUI，请在配置里显式设置\n'
    + '  `allowRemoteComfy: true`（这会如实告知插件市场：本插件可以访问外部地址）。\n'
    + '  若不需要外部端点，请把 comfyUrl 改回 http://127.0.0.1:8188。',
  )
}

/**
 * 带边界检查的 fetch。
 *
 * 与裸 `fetch` 的差别只有两点，但这两点就是审核要的：
 *   ① 发请求**之前**再校验一次目标是回环（除非显式 allowRemote）；
 *   ② 强制 `redirect: 'error'` —— 不跟随任何重定向，302 到外部会直接抛错。
 *
 * @param {string} url
 * @param {object} [init]  透传给 fetch 的 init（`redirect` 会被本函数覆盖）
 * @param {object} [opts]
 * @param {boolean} [opts.allowRemote=false]
 */
export async function guardedFetch(url, init = {}, { allowRemote = false } = {}) {
  assertLocalUrl(url, { allowRemote, what: 'request url' })
  return fetch(url, { ...init, redirect: 'error' })
}

/**
 * 子进程环境变量白名单化。
 *
 * 审核员说"spawn 未显式设置 env 会继承宿主环境"——并明确这**不构成拒绝理由**，
 * 但既然要做，就做对：不是"随便给个 env"，而是**过滤掉不该给子进程的东西**。
 *
 * 保留：系统运行必需（PATH / HOME / TMP / 盘符 / 语言等）；
 * 剔除：各类代理变量（会让子进程的网络走向与本插件声明不一致）、
 *       以及看起来像凭据的键（*TOKEN* / *KEY* / *SECRET* / *PASSWORD* / *CREDENTIAL*）。
 *
 * @param {object} [extra] 额外要注入的键值（默认无）
 * @returns {Record<string,string>} 过滤后的环境变量
 */
export function filteredEnv(extra = {}) {
  const src = process.env ?? {}
  /**
   * 必须保留的系统键。
   * ⚠ 用**小写**比对：Windows 上 process.env 的键名大小写并不统一
   *   （实测本机是 `SYSTEMROOT` / `WINDIR` / `PROGRAMFILES` 全大写，
   *    而有的写法是 `SystemRoot`），逐字面量比对会漏掉真实键 → 子进程缺
   *   系统变量直接起不来。所以统一 toLowerCase 后白名单匹配。
   */
  const KEEP_EXACT = new Set([
    'path', 'pathext', 'home', 'userprofile', 'homedrive', 'homepath',
    'temp', 'tmp', 'tmpdir', 'systemroot', 'systemdrive', 'windir',
    'comspec', 'lang', 'lc_all', 'lc_ctype', 'tz', 'number_of_processors',
    'processor_architecture', 'processor_identifier', 'os', 'shell', 'user', 'username', 'pwd',
    'programdata', 'programfiles', 'programfiles(x86)', 'programw6432',
    'commonprogramfiles', 'commonprogramfiles(x86)', 'appdata', 'localappdata',
    'systemroot', 'sessionname', 'logonserver', 'userdomain',
    // hipfire 自身的定位变量：是功能所必需，不是凭据
    'hipfire_exe', 'hipfire_home',
  ])
  /** 一律剔除：代理（改变网络去向）与凭据（不该外泄）。 */
  const DROP_RE = /(^|_)(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)($|_)/i
  const SECRET_RE = /(TOKEN|APIKEY|API_KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i

  const out = {}
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string') continue
    if (DROP_RE.test(k)) continue
    if (SECRET_RE.test(k)) continue
    if (KEEP_EXACT.has(k.toLowerCase())) { out[k] = v; continue }
    // 其余键默认不放行（白名单策略），但保留 DSH/ComfyUI 相关的非敏感前缀
    if (/^(DSH_|COMFY|QWEN_)/i.test(k) && !SECRET_RE.test(k)) out[k] = v
  }
  // 额外注入的键直接覆盖/追加（调用方明确要给子进程的）
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}
