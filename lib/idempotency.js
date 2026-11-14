/**
 * lib/idempotency.js —— C16 幂等保护。
 *
 * ★★ 要解决的真问题：
 *   出图是一次十几秒到几分钟的昂贵操作。用户（或 Agent 重试逻辑）
 *   连点两次「批量出 8 张」，过去就是**真跑两遍 16 张** —— 白烧时间与电。
 *   同理，网络抖动导致的工具重试会把同一批任务重复提交。
 *
 *   本模块给一个进程内的短期去重账本：
 *     · 同一个 key 在 TTL 内再来 → 直接返回上次结果，不重跑
 *     · 同 key 正在跑 → 挂到同一个 promise 上，**并发也只跑一次**
 *     · 失败不记账（下次重试照常跑，不能被一次报错永久封死）
 *
 * ★★ 三条诚实边界：
 *   ① 只在本进程内有效。插件重启后账本清空 —— 这是对的，重启意味着状态不可信。
 *   ② 只在 TTL 内有效。用户**故意**想要一张一样的图（同 seed 重跑）时，
 *      过了 TTL 就能再跑；TTL 内想强制重跑请换 seed 或加个 `nonce`。
 *   ③ 不做跨进程/跨机器锁。真需要请上文件锁或数据库，本模块不假装能做到。
 */

/** 默认 2 分钟：足够覆盖"手滑连点"与"网络层重试"，又不至于拦掉正常重跑。 */
export const DEFAULT_TTL_MS = 120_000

/** 账本容量上限。超过就丢最老的，避免长跑进程里无限涨。 */
export const DEFAULT_MAX_ENTRIES = 32

/**
 * 稳定序列化：键排序、忽略 undefined，保证同一份参数得到同一个字符串。
 * ★ 不能用 `JSON.stringify` 直接来 —— 键顺序不同就会算出两个 key，
 *   那去重就彻底失效了（而它失效时是静默的，最难查）。
 */
export function stableStringify(value, depth = 0) {
  if (depth > 6) return '"[deep]"'
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'undefined') return '"[undefined]"'
  if (t === 'number') return Number.isFinite(value) ? String(value) : '"[nan]"'
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(value)
  if (t === 'function') return '"[fn]"'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, depth + 1)).join(',')}]`
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(String(value))
}

/** FNV-1a 32 位。够短够稳，不需要加密强度。 */
export function shortHash(text) {
  let h = 0x811c9dc5
  const s = String(text)
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 参数 → 去重键。前缀用来区分不同动作，避免"批量"和"单张"撞 key。 */
export function hashArgs(prefix, args) {
  return `${String(prefix ?? 'op')}:${shortHash(stableStringify(args ?? {}))}`
}

/**
 * 建一个去重账本。
 *
 * @param {object} [opts]
 * @param {number} [opts.ttlMs]
 * @param {number} [opts.max]
 * @param {() => number} [opts.now]
 */
export function makeIdempotency({ ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX_ENTRIES, now } = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS
  const cap = Number.isFinite(max) && max > 0 ? Math.trunc(max) : DEFAULT_MAX_ENTRIES
  const clock = typeof now === 'function' ? now : () => Date.now()
  /** @type {Map<string, {value:any, at:number}>} */
  const done = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map()
  let hits = 0
  let runs = 0

  const prune = () => {
    const t = clock()
    for (const [k, v] of done) {
      if (t - v.at >= ttl) done.delete(k)
    }
    // 超容量：Map 保持插入顺序，从最老的开始删。
    while (done.size > cap) {
      const oldest = done.keys().next().value
      done.delete(oldest)
    }
  }

  return {
    /** 只查不跑。过期即视为未命中，并顺手清掉。 */
    peek(key) {
      prune()
      const v = done.get(key)
      if (!v) return { hit: false, value: undefined }
      return { hit: true, value: v.value, age_ms: clock() - v.at }
    },

    /** 手工记账（一般用不到，`run` 会自己记）。 */
    put(key, value) {
      prune()
      done.delete(key)
      done.set(key, { value, at: clock() })
      return value
    },

    /**
     * 幂等执行。
     * @returns {Promise<{hit:boolean, value:any, key:string, coalesced?:boolean}>}
     */
    async run(key, fn) {
      const k = String(key ?? '')
      if (k === '') throw new Error('幂等键不能为空')
      const cached = this.peek(k)
      if (cached.hit) { hits += 1; return { hit: true, value: cached.value, key: k } }

      // ★ 并发去重：同一 key 正在跑时挂到同一个 promise，绝不并行跑两遍。
      const pending = inflight.get(k)
      if (pending !== undefined) {
        hits += 1
        return { hit: true, value: await pending, key: k, coalesced: true }
      }

      runs += 1
      const p = (async () => fn())()
      inflight.set(k, p)
      try {
        const value = await p
        inflight.delete(k)
        // ★ 失败不记账：异常走 catch，什么都不存。
        this.put(k, value)
        return { hit: false, value, key: k }
      } catch (e) {
        inflight.delete(k)
        throw e
      }
    },

    size() { prune(); return done.size },
    clear() { done.clear(); inflight.clear(); hits = 0; runs = 0 },
    stats() { prune(); return { size: done.size, inflight: inflight.size, hits, runs, ttl_ms: ttl, max: cap } },
  }
}
