/** worker-manager —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#ttsll2-space-worker-manager */
export const WORKER_MANAGER_VERSION = 1

export const ISOLATION_MODES = Object.freeze([
  { id: 'venv', label: 'Python venv（用户自备）' },
  { id: 'conda', label: 'Conda 环境（用户自备）' },
  { id: 'docker', label: 'Docker 容器（用户自备镜像）' },
  { id: 'external', label: '外部已运行的 Worker' },
])

/** Worker 规格表。command/port/env 都是「占位配置」，真值由用户填。 */
export const WORKER_SPECS = Object.freeze([
  { id: 'gpt_sovits_v5', label: 'GPT-SoVITS v5（dev / turbo）', kind: 'tts',
    adapter: 'gpt_sovits_v5', defaultPort: 0, idleTimeoutMin: 10,
    minVramMb: 0, isolation: 'venv', autoInstall: false,
    // ★ 同族共进程：dev / turbo 只切权重变体，不起第二个进程，避免重复加载底座。
    sharedVariants: ['dev', 'turbo'],
    installHint: '独立 venv 内装好对应 torch / ffmpeg 与节点包，再在配置里填启动命令。' },
  { id: 'indextts2', label: 'IndexTTS2', kind: 'tts',
    adapter: 'indextts2', defaultPort: 0, idleTimeoutMin: 10,
    minVramMb: 0, isolation: 'venv', autoInstall: false,
    installHint: '独立 venv，避免与 GPT-SoVITS 的 torch 版本互相打架。' },
  { id: 'ace_step_15', label: 'ACE-Step 1.5', kind: 'music',
    adapter: 'ace_step_15', defaultPort: 0, idleTimeoutMin: 10,
    minVramMb: 0, isolation: 'venv', autoInstall: false,
    installHint: '独立 venv；插件不自动下载模型权重。' },
  { id: 'yue2', label: 'YuE2', kind: 'music',
    adapter: 'yue2', defaultPort: 0, idleTimeoutMin: 10,
    minVramMb: 0, isolation: 'venv', autoInstall: false,
    installHint: '独立 venv；与其它音乐模型分开，避免显存叠加。' },
])

export const DEFAULT_WORKER_POLICY = Object.freeze({
  maxConcurrent: 1,
  maxVramMb: 0, // 0 = 不设上限（预算建议，不是精确配额）
  idleTimeoutMin: 10,
  // ★ 分级保活：热 → 温 → 冷，而不是空闲就一刀切 kill。
  //   温态保留进程 / torch / CUDA context，只把权重卸载到 CPU，显存≈0，
  //   再次调用省掉最贵的解释器与上下文初始化（冷启动具体秒数本机未实测，不承诺）。
  hotToWarmMin: 5,
  warmToColdMin: 20,
  prewarmIds: [], // 用户勾选「常用」的 Worker：只降到温态，不进冷态
  gracefulTermMs: 5000,
  loopbackOnly: true,
})

export const WORKER_TIERS = Object.freeze([
  { id: 'hot', label: '热（权重在显存，直接推理）' },
  { id: 'warm', label: '温（进程存活、权重卸载，显存近零）' },
  { id: 'cold', label: '冷（进程已终止，全部释放）' },
])

const clockNow = (now) => (typeof now === 'function' ? now() : Date.now())

/**
 * @param {object} deps 全部 I/O 注入：spawn / kill / fetch / vramProbe / now / log
 */
export function makeWorkerManager(deps = {}) {
  const {
    spawn, kill, fetch: injectedFetch, vramProbe, log,
  } = deps
  const now = () => clockNow(deps.now)
  const policy = { ...DEFAULT_WORKER_POLICY, ...(deps.policy || {}) }
  const state = new Map()

  for (const spec of WORKER_SPECS) {
    state.set(spec.id, {
      id: spec.id, label: spec.label, kind: spec.kind, adapter: spec.adapter,
      enabled: false, status: 'stopped', isolation: spec.isolation,
      command: '', envPath: '', port: spec.defaultPort,
      idleTimeoutMin: spec.idleTimeoutMin, minVramMb: spec.minVramMb,
      startedAt: null, lastUsedAt: null, pid: null, reason: '',
      health: 'undetected', autoInstall: false,
      tier: 'cold', variant: '', lastParkedAt: null,
    })
  }

  const warn = (msg) => { try { log?.('warn', msg) } catch { /* 忽略 */ } }
  const get = (id) => state.get(String(id ?? '').trim())
  const runningCount = () => [...state.values()].filter((s) => s.status === 'running').length

  function publicRow(s) {
    const spec = WORKER_SPECS.find((x) => x.id === s.id)
    return {
      id: s.id, label: s.label, kind: s.kind, adapter: s.adapter,
      enabled: s.enabled, status: s.status, isolation: s.isolation,
      envPath: s.envPath, port: s.port, commandConfigured: Boolean(s.command),
      idleTimeoutMin: s.idleTimeoutMin, minVramMb: s.minVramMb,
      startedAt: s.startedAt, lastUsedAt: s.lastUsedAt,
      health: s.health, reason: s.reason,
      tier: s.tier, variant: s.variant,
      prewarmed: (Array.isArray(policy.prewarmIds) ? policy.prewarmIds : []).includes(s.id),
      installHint: spec.installHint, autoInstall: false,
      loopbackOnly: policy.loopbackOnly,
      sharedVariants: spec.sharedVariants ? spec.sharedVariants.slice() : [],
    }
  }

  /** 显存预检：数字只能来自注入探针；没注入就如实说未检测。 */
  async function probeVram() {
    if (typeof vramProbe !== 'function') {
      return { available: false, totalMb: null, freeMb: null,
        reason: '未注入显存探针（例如宿主调用 nvidia-smi），不猜测显存数字' }
    }
    try {
      const r = await vramProbe()
      const freeMb = Number(r?.freeMb)
      const totalMb = Number(r?.totalMb)
      if (!Number.isFinite(freeMb) || freeMb < 0) {
        return { available: false, totalMb: null, freeMb: null, reason: '显存探针返回了无效数值' }
      }
      return { available: true, freeMb, totalMb: Number.isFinite(totalMb) ? totalMb : null,
        reason: '' }
    } catch {
      return { available: false, totalMb: null, freeMb: null, reason: '显存探测失败（详见插件日志）' }
    }
  }

  /** 选择模型前的人类可读预检结论；绝不把「未检测」说成「符合要求」。 */
  async function preflight(id) {
    const s = get(id)
    if (!s) return { ok: false, summary: '未知 Worker：' + id, details: [] }
    const vram = await probeVram()
    const details = []
    if (!vram.available) details.push('显存：' + vram.reason)
    else {
      details.push('显存：剩余 ' + vram.freeMb + ' MB' + (vram.totalMb ? ' / 共 ' + vram.totalMb + ' MB' : ''))
      if (s.minVramMb > 0 && vram.freeMb < s.minVramMb) {
        details.push('该 Worker 标注的最低显存为 ' + s.minVramMb + ' MB，当前可能不足（数值来自探针，非保证）')
      }
    }
    details.push('环境：' + s.isolation + (s.envPath ? '（已填路径）' : '（未填路径，插件不会创建）'))
    details.push('启动命令：' + (s.command ? '已配置' : '未配置，插件不会代填或 pip install'))
    details.push('并发策略：同时最多 ' + policy.maxConcurrent + ' 个 Worker；空闲 '
      + s.idleTimeoutMin + ' 分钟自动终止释放显存')
    const blocked = !s.command || (vram.available && s.minVramMb > 0 && vram.freeMb < s.minVramMb)
    return {
      ok: !blocked,
      summary: blocked ? '暂不建议加载：' + (s.command ? '显存可能不足' : '启动命令未配置')
        : (vram.available ? '可以显式启动（显存数字来自探针，不构成保证）' : '可以显式启动，但显存未检测'),
      details,
      vram,
      unverified: true,
    }
  }

  async function healthCheck(s) {
    if (typeof injectedFetch !== 'function' || !s.port) {
      s.health = 'undetected'
      return s.health
    }
    try {
      const res = await injectedFetch('http://127.0.0.1:' + s.port + '/health', { timeoutMs: 3000 })
      s.health = res?.ok ? 'ok' : 'error'
    } catch {
      s.health = 'error'
    }
    if (s.health === 'error') s.reason = '健康检查失败（详见插件日志）'
    return s.health
  }

  async function start(id) {
    const s = get(id)
    if (!s) return { ok: false, reason: '未知 Worker：' + id }
    if (s.status === 'running') return { ok: true, already: true, row: publicRow(s) }
    if (runningCount() >= policy.maxConcurrent) {
      return { ok: false, reason: '已达并发上限（' + policy.maxConcurrent + '）：先停掉其它 Worker 再启动，避免显存叠加' }
    }
    if (!s.command) {
      return { ok: false, reason: '未配置启动命令；插件不自动创建环境、不 pip install、不下载权重' }
    }
    if (typeof spawn !== 'function') {
      return { ok: false, reason: '未注入进程执行器，Worker 未启动（不假装已启动）' }
    }
    const pre = await preflight(id)
    if (!pre.ok) return { ok: false, reason: pre.summary, preflight: pre }
    s.status = 'starting'
    try {
      const proc = await spawn({ id: s.id, command: s.command, envPath: s.envPath,
        isolation: s.isolation, port: s.port, loopbackOnly: policy.loopbackOnly })
      s.pid = Number(proc?.pid) || null
      s.status = 'running'
      s.tier = 'hot'
      s.startedAt = now()
      s.lastUsedAt = now()
      s.reason = ''
      await healthCheck(s)
      return { ok: true, row: publicRow(s), preflight: pre }
    } catch (error) {
      warn('Worker 启动失败：' + (error?.message ?? error))
      s.status = 'error'
      s.reason = '启动失败（详见插件日志）'
      return { ok: false, reason: s.reason }
    }
  }

  /** 优雅终止：先 TERM，超时才 KILL；没注入 kill 就明确说明。 */
  async function stop(id, { reason = '用户停止' } = {}) {
    const s = get(id)
    if (!s) return { ok: false, reason: '未知 Worker：' + id }
    if (s.status === 'stopped') return { ok: true, already: true, row: publicRow(s) }
    if (typeof kill !== 'function') {
      return { ok: false, reason: '未注入进程终止器，无法安全终止 Worker' }
    }
    s.status = 'stopping'
    try {
      await kill({ id: s.id, pid: s.pid, signal: 'SIGTERM', graceMs: policy.gracefulTermMs })
    } catch (error) {
      warn('Worker 优雅终止失败：' + (error?.message ?? error))
    }
    s.status = 'stopped'
    s.tier = 'cold'
    s.pid = null
    s.startedAt = null
    s.lastParkedAt = null
    s.health = 'undetected'
    s.reason = reason
    return { ok: true, row: publicRow(s), reason }
  }

  /**
   * 热 → 温：只卸载权重到 CPU，保留进程 / torch / CUDA context。
   * 没注入 unload 钩子就明确拒绝，绝不假装已经释放了显存。
   */
  async function park(id, { reason = '释放显存（保留进程）' } = {}) {
    const s = get(id)
    if (!s) return { ok: false, reason: '未知 Worker：' + id }
    if (s.tier !== 'hot') return { ok: true, already: true, row: publicRow(s) }
    if (typeof deps.unload !== 'function') {
      return { ok: false, reason: '未注入权重卸载钩子，无法安全降到温态（不假装已释放显存）' }
    }
    try {
      await deps.unload({ id: s.id, pid: s.pid })
    } catch (error) {
      warn('权重卸载失败：' + (error?.message ?? error))
      return { ok: false, reason: '权重卸载失败（详见插件日志）' }
    }
    s.tier = 'warm'
    s.lastParkedAt = now()
    s.reason = reason
    return { ok: true, row: publicRow(s), reason }
  }

  /** 温 → 热 / 冷 → 启动：调用方拿 Worker 前走这里，避免每次冷启动。 */
  async function wake(id) {
    const s = get(id)
    if (!s) return { ok: false, reason: '未知 Worker：' + id }
    if (s.tier === 'cold') return start(id)
    if (typeof deps.reload !== 'function') {
      return { ok: false, reason: '未注入权重回载钩子，温态无法恢复为热态' }
    }
    try { await deps.reload({ id: s.id, pid: s.pid }) } catch (error) {
      warn('权重回载失败：' + (error?.message ?? error))
      return { ok: false, reason: '权重回载失败（详见插件日志）' }
    }
    s.tier = 'hot'
    s.status = 'running'
    s.lastUsedAt = now()
    return { ok: true, row: publicRow(s), fromTier: 'warm' }
  }

  /** 预算准入：显存不够时按 LRU 把最久没用的热进程停车，而不是硬起导致 OOM。 */
  async function evictForBudget(requiredMb = 0) {
    const need = Number(requiredMb) || 0
    const budget = Number(policy.maxVramMb) || 0
    if (budget <= 0 || need <= 0) return { ok: true, evicted: [], reason: '未设显存预算，跳过准入驱逐' }
    const hot = [...state.values()].filter((s) => s.tier === 'hot')
      .sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))
    const evicted = []
    let freed = 0
    for (const s of hot) {
      if (freed >= need) break
      const r = await park(s.id, { reason: '显存预算准入：LRU 停车' })
      if (r.ok) { evicted.push(s.id); freed += Number(s.minVramMb) || 0 }
    }
    return { ok: true, evicted, freedMb: freed,
      reason: evicted.length ? '已按 LRU 停车释放显存' : '没有可停车的热进程' }
  }

  /**
   * 分级空闲回收：热 → 温 → 冷，而不是空闲就杀进程。
   * 只用注入的 now 计算，离线测试不真等；预热白名单停在温态不进冷态。
   */
  async function sweep() {
    const t = now()
    const parked = []
    const stopped = []
    const prewarm = Array.isArray(policy.prewarmIds) ? policy.prewarmIds : []
    for (const s of state.values()) {
      // ★ 用 == null 而不是 !s.lastUsedAt：注入的时间源可能就是 0，
      //   falsy 判断会把「刚用过」误当成「从没用过」而跳过整条回收链。
      if (s.status === 'stopped' || s.lastUsedAt === null || s.lastUsedAt === undefined) continue
      const idleMin = (t - s.lastUsedAt) / 60000
      if (s.tier === 'hot' && idleMin >= policy.hotToWarmMin) {
        const r = await park(s.id, { reason: '空闲达到热→温阈值' })
        if (r.ok) parked.push(s.id)
      } else if (s.tier === 'warm' && idleMin >= policy.warmToColdMin && !prewarm.includes(s.id)) {
        const r = await stop(s.id, { reason: '空闲达到温→冷阈值，释放全部资源' })
        if (r.ok) stopped.push(s.id)
      }
    }
    return { ok: true, parked, stopped, running: runningCount(),
      tiers: [...state.values()].map((s) => ({ id: s.id, tier: s.tier })) }
  }

  return {
    policy: { ...policy },
    list() { return [...state.values()].map(publicRow) },
    getRow(id) { const s = get(id); return s ? publicRow(s) : null },
    enable(id) { const s = get(id); if (!s) return { ok: false, reason: '未知 Worker' }; s.enabled = true; return { ok: true, row: publicRow(s) } },
    disable(id) { const s = get(id); if (!s) return { ok: false, reason: '未知 Worker' }; s.enabled = false; return { ok: true, row: publicRow(s) } },
    /** 配置位：命令 / 环境路径 / 端口 / 隔离方式 / 空闲分钟。绝不自动创建环境。 */
    configure(id, patch = {}) {
      const s = get(id)
      if (!s) return { ok: false, reason: '未知 Worker：' + id }
      if (typeof patch.command === 'string') s.command = patch.command.slice(0, 800)
      if (typeof patch.envPath === 'string') s.envPath = patch.envPath.slice(0, 400)
      if (Number.isFinite(Number(patch.port))) s.port = Math.trunc(Math.min(65535, Math.max(0, Number(patch.port))))
      if (ISOLATION_MODES.some((m) => m.id === patch.isolation)) s.isolation = patch.isolation
      if (Number.isFinite(Number(patch.idleTimeoutMin))) {
        s.idleTimeoutMin = Math.trunc(Math.min(240, Math.max(1, Number(patch.idleTimeoutMin))))
      }
      if (typeof patch.variant === 'string') s.variant = patch.variant.slice(0, 40)
      if (typeof patch.hotToWarmMin === 'number') {
        policy.hotToWarmMin = Math.trunc(Math.min(240, Math.max(1, patch.hotToWarmMin)))
      }
      if (typeof patch.warmToColdMin === 'number') {
        policy.warmToColdMin = Math.trunc(Math.min(1440, Math.max(1, patch.warmToColdMin)))
      }
      if (typeof patch.prewarm === 'boolean') {
        const list = (Array.isArray(policy.prewarmIds) ? policy.prewarmIds : []).filter((x) => x !== s.id)
        if (patch.prewarm) list.push(s.id)
        policy.prewarmIds = list
      }
      return { ok: true, row: publicRow(s),
        note: '配置只保存于进程内存；插件不会创建 venv / conda / Docker，也不会安装依赖。'
          + '分级保活：热 → 温（卸载权重、保留进程）→ 冷（终止进程）。' }
    },
    touch(id) { const s = get(id); if (s) s.lastUsedAt = now(); return Boolean(s) },
    probeVram, preflight, start, stop, park, wake, evictForBudget, sweep, healthCheck,
    tiers: WORKER_TIERS.map((t) => ({ ...t })),
    isolationModes: ISOLATION_MODES.map((m) => ({ ...m })),
    specs: WORKER_SPECS.map((x) => ({ ...x })),
  }
}
