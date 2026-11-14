/**
 * lib/perf-presets.js —— B7 / B8：把「显存档位」与「前缀缓存档位」翻译成人话。
 *
 * 这个模块只做**语义翻译与选择校验**，不直接改 cfg：
 *   · 真正的启动参数折算仍在 `config.js::resolveVramArgs()`（唯一实现，别第二处）；
 *   · 真正的缓存节点装配仍在 `model-chain.js::prefixCacheNode()`。
 * 这里给的是「用户能看懂的选项 + 每个选项的代价」，让面板不必硬编一堆字符串。
 *
 * ★★ 两类旋钮的生效时机完全不同，文案里必须说清楚，否则用户改完没反应会以为坏了：
 *   · 显存档位（vramMode）→ **ComfyUI 启动参数** → 改完必须重启 ComfyUI
 *   · 缓存档位（cacheMode）→ **工作流里的节点属性** → 下次出图即生效，无需重启
 */

/**
 * 显存档位。顺序即面板展示顺序：从「最省心」到「最激进」。
 *
 * `restart: true` 的全部是启动参数；`auto` 是默认值（按显存自动判断）。
 */
export const VRAM_CHOICES = [
  {
    id: 'auto', label: '自动（推荐）', restart: true,
    summary: '按显存容量自动选参数，16 GB 以下不强加驻留参数。',
    cost: '无额外代价',
  },
  {
    id: 'save', label: '省显存', restart: true,
    summary: '--lowvram：部分权重按需换入系统内存。',
    cost: '显存占用明显下降，出图慢一些',
  },
  {
    id: 'ram', label: '最省显存（权重放内存）', restart: true,
    summary: '--novram：权重常驻系统内存、按需换入显存。',
    cost: '显存占用最低，速度最慢；内存要够大（≥ 16 GB 更稳）',
  },
  {
    id: 'resident', label: '全驻留（最快）', restart: true,
    summary: '--highvram：模型全留显存，不换入换出。',
    cost: '最快，但显存装不下会 OOM',
  },
  {
    id: 'standard', label: '交给 ComfyUI 调度', restart: true,
    summary: '不加任何驻留参数。',
    cost: '效果取决于 ComfyUI 自己的判断',
  },
  {
    id: 'cpu', label: '纯 CPU', restart: true,
    summary: '--cpu：完全不用显卡。',
    cost: '很慢，仅在无可用 GPU 时使用',
  },
]

/**
 * 前缀缓存（QwenImage21Cache）档位。语义来自节点 tooltip 的真机原文：
 *   device: auto 用闲置显存、其次内存；cpu 在计算背后预取、速度损失很小；
 *           off 每步重算前缀（最慢，唯一能把缓存排除干净的办法）
 *   dtype:  存储精度；int8 更省空间
 */
export const CACHE_CHOICES = [
  {
    id: 'save', label: '省显存', restart: false,
    device: 'cpu', dtype: 'int8',
    summary: '前缀缓存放系统内存 + int8 压缩。显存占用最低。',
    cost: '速度损失很小（节点在计算背后预取），内存要多留一点',
  },
  {
    id: 'balanced', label: '均衡（默认）', restart: false,
    device: 'auto', dtype: 'int8',
    summary: '有闲置显存就放显存，否则退回内存；int8 存储。',
    cost: '无，这就是默认工作点',
  },
  {
    id: 'ram', label: '省内存', restart: false,
    device: 'gpu', dtype: 'default',
    summary: '前缀缓存固定放显存 + 全精度存储，不占系统内存。',
    cost: '显存占用更高；内存紧张但显存充裕时选这个',
  },
  {
    id: 'off', label: '关闭缓存', restart: false,
    device: 'off', dtype: 'default',
    summary: '每一步都重算前缀。',
    cost: '明显变慢；只在怀疑缓存导致画面异常时用来排除',
  },
]

const findById = (list, id) => list.find((x) => x.id === String(id ?? '').trim()) ?? null

export function getVramChoice(id) { return findById(VRAM_CHOICES, id) }
export function getCacheChoice(id) { return findById(CACHE_CHOICES, id) }

/**
 * 校验并折算成最小改动集。
 *
 * @param {object} o
 * @param {string} [o.vramMode]  显存档位 id（不传表示不改）
 * @param {string} [o.cacheMode] 缓存档位 id（不传表示不改）
 * @returns {{ok:boolean, reason:string, needsRestart:boolean,
 *   vramMode:string, cacheDevice:string, cacheDtype:string,
 *   workflowOverrides:object, notes:string[]}}
 */
export function planPerfChange({ vramMode, cacheMode } = {}) {
  const out = {
    ok: true, reason: '', needsRestart: false,
    vramMode: '', cacheDevice: '', cacheDtype: '',
    workflowOverrides: {}, notes: [],
  }
  const hasVram = vramMode !== undefined && vramMode !== null && String(vramMode).trim() !== ''
  const hasCache = cacheMode !== undefined && cacheMode !== null && String(cacheMode).trim() !== ''

  if (!hasVram && !hasCache) {
    return { ...out, ok: false, reason: 'vramMode 与 cacheMode 至少要给一个' }
  }

  if (hasVram) {
    const c = getVramChoice(vramMode)
    if (!c) return { ...out, ok: false, reason: `没有这个显存档位：${vramMode}` }
    out.vramMode = c.id
    out.needsRestart = true
    out.notes.push(`${c.label}：${c.summary}（代价：${c.cost}）`)
    out.notes.push('显存档位是 ComfyUI 启动参数，改完必须重启 ComfyUI 才生效')
  }

  if (hasCache) {
    const c = getCacheChoice(cacheMode)
    if (!c) return { ...out, ok: false, reason: `没有这个缓存档位：${cacheMode}` }
    out.cacheDevice = c.device
    out.cacheDtype = c.dtype
    out.workflowOverrides.qwenCacheDevice = c.device
    out.workflowOverrides.qwenCacheDtype = c.dtype
    out.notes.push(`${c.label}：${c.summary}（代价：${c.cost}）`)
    out.notes.push('缓存档位写在工作流里，下次出图即生效，不用重启')
  }

  return out
}

/**
 * 反向：从当前 cfg 推断用户落在哪个档位，供面板高亮当前值。
 * 读不出来就返回空串（不猜一个假的默认值糊弄）。
 */
export function describeCurrent({ vramMode, cacheDevice, cacheDtype } = {}) {
  const v = getVramChoice(vramMode)
  const dev = String(cacheDevice ?? '').trim()
  const dt = String(cacheDtype ?? '').trim()
  const match = CACHE_CHOICES.find((c) => c.device === dev && c.dtype === dt) ?? null
  return {
    vramMode: v ? v.id : '',
    vramLabel: v ? v.label : '',
    cacheMode: match ? match.id : '',
    cacheLabel: match ? match.label : '',
    cacheDevice: dev,
    cacheDtype: dt,
  }
}
