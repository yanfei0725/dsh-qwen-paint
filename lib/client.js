// 设计说明已外置 → docs/client-design-notes.md#client-note-001（原 L1-37）

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-qwen-paint',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

      /* React 从平台模块表拿；拿不到就**不注册**（注册了组件一渲染就 TypeError，
         会污染 dsh 自己的渲染树）。见 MEMO：宁可安静降级。 */
      let React = null
      try {
        const seed = require('react')
        React = seed && seed.default ? seed.default : seed
      } catch (err) {
        React = null
      }

      const PLUGIN_ID = 'dsh-qwen-paint'
      const SLOT_KEY = 'tool.call.toolview'
      const TOOL_KEY = 'draw_image'
      const STYLE_ID = 'dsh-qwen-paint-style'
// 设计说明已外置 → docs/client-design-notes.md#client-note-002（原 L61-67）
      const MODEL_PARAM_RE = /[_-](fp8(?:_e4m3fn|_e5m2|_scaled)?|int8|bf16|fp16|q[2-8]_[0-9a-z_]+|w\d+a\d+|convrot|dmd|turbo8|step\d+)(?=[_-]|$)/giu
      const MODEL_EXT_RE = /\.(safetensors|gguf|pth|pt|ckpt|bin|onnx)$/iu
      const splitModelLabelLocal = (name) => {
        const raw = String(name ?? '').trim()
        if (raw === '') return { clean: '', meta: '' }
        const m = MODEL_EXT_RE.exec(raw)
        const ext = m ? m[0].slice(1) : ''
        let stem = m ? raw.slice(0, raw.length - m[0].length) : raw
        const params = []
        const seen = new Set()
        stem = stem.replace(MODEL_PARAM_RE, (_all, p) => {
          const key = String(p).toLowerCase()
          if (!seen.has(key)) { seen.add(key); params.push(key) }
          return ''
        })
        stem = stem.replace(/[_-]{2,}/gu, '_').replace(/^[_-]+|[_-]+$/gu, '')
        const parts = params.slice()
        if (ext !== '') parts.push(ext)
        return { clean: stem !== '' ? stem : raw, meta: parts.join(' · ') }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-074（原 L47-50）
      const WEIGHT_CAPS_KEY = 'comfyPipelineWeightOptions'
      const WEIGHT_CAPS_VERSION = 1
      const WEIGHT_CAPS_TTL = 120000
      const safeStorage = () => {
        try { return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null }
        catch { return null }
      }
      /** 只读成功且结构完整的缓存；版本/时效/结构任一不对就当没有（宁可等请求也不回显脏候选）。 */
      const loadPersistedWeightCaps = (storage, now, ttl) => {
        if (!storage) return null
        try {
          const raw = storage.getItem(WEIGHT_CAPS_KEY)
          if (!raw) return null
          const box = JSON.parse(raw)
          const stale = !box || box.v !== WEIGHT_CAPS_VERSION || !Number.isFinite(box.at)
            || (now - box.at) < 0 || (now - box.at) >= ttl
            || !box.data || typeof box.data !== 'object'
            || !box.data.files || typeof box.data.files !== 'object'
          if (stale) {
            // ★ 过期 / 结构不匹配就当场清掉，不让陈旧候选长期住在 localStorage。
            try { storage.removeItem(WEIGHT_CAPS_KEY) } catch { /* 隐私模式忽略 */ }
            return null
          }
          return box.data
        } catch { return null }
      }
      const savePersistedWeightCaps = (storage, caps, now) => {
        if (!storage || !caps || typeof caps !== 'object' || !caps.files) return false
        try {
          storage.setItem(WEIGHT_CAPS_KEY, JSON.stringify({ v: WEIGHT_CAPS_VERSION, at: now, data: caps }))
          return true
        } catch { return false }
      }
      /** 选项集合：不指定 + 真实文件 + 覆写值已失效项（保住 fileLabels 与「已失效」标注）。 */
      const weightOptionsOf = (caps, sourceKey, labelOf) => {
        const keyMap = { main: ['unet', 'unetGguf'], lora: ['lora'], controlnet: ['controlnet'] }
        const keys = keyMap[sourceKey] ?? [sourceKey]
        const files = []
        for (const k of keys) for (const f of (caps?.files?.[k] ?? [])) files.push(String(f))
        const over = String(caps?.overrides?.[sourceKey] ?? '')
        const info = labelOf ?? ((f) => splitModelLabelLocal(f))
        const opts = [{ value: '', label: '（不指定，用插件自动挑的）', meta: '' }]
        for (const f of files) {
          const d = info(f)
          opts.push({ value: f, label: d.clean, meta: d.meta })
        }
        if (over !== '' && !files.includes(over)) {
          const d = info(over)
          opts.push({ value: over, label: `${d.clean}（已失效）`, meta: d.meta })
        }
        return { files, over, opts }
      }

      // 通用 Comfy 控制层面板的注入 id（重复 apply / HMR 时靠它去重）
      const PANEL_JS_ID = 'comfy-pipeline-panel-js'
      const PANEL_CSS_ID = 'comfy-pipeline-panel-css'
// 设计说明已外置 → docs/client-design-notes.md#client-note-003（原 L92-101）
      const STATUS_SLOT = 'conversation.input.right'
      const STATUS_ID = 'qwen-paint-status'
      /**
       * 状态端点。先试 `/api/` 下的（与内核 `/api/file` 同族，桌面端的 IPC 桥接最可能
       * 覆盖它），不通再回退到根路径。第一次成功后会记住用哪条，不再每条都试。
       */
      const STATUS_PATHS = ['api/qwen-paint/status.json', 'qwen-paint/status.json']
      const POLL_MS = 5000

// 设计说明已外置 → docs/client-design-notes.md#client-note-004（原 L111-124）
      async function postStatus(params) {
        const body = JSON.stringify(params ?? {})
        let lastError = null
        for (const path of STATUS_PATHS) {
          try {
            const res = await fetch(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', accept: 'application/json' },
              body,
            })
            if (res.ok) return res
            lastError = new Error(`HTTP ${res.status}`)
          } catch (error) {
            lastError = error
          }
        }
        throw lastError ?? new Error('POST 状态端点失败')
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-005（原 L144-150）
      const FLOW_ID = 'dshqp-flow'
      const DRAWING_ATTR = 'data-dshqp-drawing'
      const REASONING_ATTR = 'data-dshqp-reasoning'
      const GRAD_STYLE_ID = 'dshqp-flowgrad-css'
      let flowHideTimer = null

// 设计说明已外置 → docs/client-design-notes.md#client-note-006（原 L157-168）
      const FLOW_GRADS = [
        { id: 'macaron', name: '马卡龙', css: 'linear-gradient(135deg,rgb(255,180,200),rgb(255,205,170),rgb(255,225,165),rgb(245,240,180),rgb(190,240,210),rgb(180,230,245),rgb(190,215,250),rgb(220,200,245),rgb(240,200,230),rgb(255,180,200))' },
        { id: 'candy', name: '糖果', css: 'linear-gradient(135deg,rgb(255,145,170),rgb(255,170,130),rgb(255,195,110),rgb(240,220,115),rgb(140,220,175),rgb(115,210,205),rgb(130,195,240),rgb(160,170,235),rgb(210,155,230),rgb(235,135,190),rgb(255,145,170))' },
        { id: 'rouge', name: '酒红', css: 'linear-gradient(135deg,rgb(140,25,45),rgb(175,35,60),rgb(120,20,55),rgb(160,40,75),rgb(190,55,80),rgb(130,30,65),rgb(140,25,45))' },
        { id: 'bamboo', name: '翠青', css: 'linear-gradient(135deg,rgb(70,180,85),rgb(95,200,105),rgb(55,165,70),rgb(110,215,120),rgb(80,190,95),rgb(60,172,78),rgb(70,180,85))' },
        { id: 'aurora', name: '极光幻彩', css: 'linear-gradient(135deg,rgb(70,240,200),rgb(90,200,255),rgb(120,140,255),rgb(180,120,255),rgb(240,140,255),rgb(70,240,200))' },
        { id: 'deepsea', name: '深海蓝调', css: 'linear-gradient(135deg,rgb(20,90,180),rgb(30,140,210),rgb(40,180,220),rgb(20,120,190),rgb(50,160,230),rgb(25,100,200),rgb(20,90,180))' },
        { id: 'sunset', name: '落日熔金', css: 'linear-gradient(135deg,rgb(255,180,80),rgb(255,130,90),rgb(255,90,110),rgb(220,90,150),rgb(160,90,190),rgb(255,180,80))' },
        { id: 'forest', name: '森林秘语', css: 'linear-gradient(135deg,rgb(30,100,60),rgb(60,140,80),rgb(90,180,90),rgb(140,200,80),rgb(180,210,90),rgb(30,100,60))' },
        { id: 'champagne', name: '香槟鎏金', css: 'linear-gradient(135deg,rgb(220,180,100),rgb(240,205,130),rgb(255,225,160),rgb(230,190,110),rgb(245,210,140),rgb(220,180,100))' },
        { id: 'lavender', name: '薰衣草梦境', css: 'linear-gradient(135deg,rgb(180,150,255),rgb(200,170,255),rgb(230,180,240),rgb(255,190,220),rgb(240,160,200),rgb(180,150,255))' },
        { id: 'mint', name: '薄荷汽水', css: 'linear-gradient(135deg,rgb(120,230,180),rgb(150,240,200),rgb(170,240,230),rgb(140,220,240),rgb(120,200,220),rgb(120,230,180))' },
        { id: 'lava', name: '岩浆熔岩', css: 'linear-gradient(135deg,rgb(255,60,40),rgb(255,110,30),rgb(255,170,40),rgb(255,210,70),rgb(255,140,50),rgb(255,60,40))' },
        { id: 'galaxy', name: '银河星紫', css: 'linear-gradient(135deg,rgb(40,30,90),rgb(70,50,130),rgb(110,70,170),rgb(160,90,190),rgb(220,120,180),rgb(40,30,90))' },
        { id: 'ink', name: '墨韵黑白', css: 'linear-gradient(135deg,rgb(20,20,20),rgb(80,80,80),rgb(140,140,140),rgb(200,200,200),rgb(250,250,250),rgb(250,250,250),rgb(200,200,200),rgb(140,140,140),rgb(80,80,80),rgb(20,20,20))' },
        { id: 'indigo', name: '靛蓝夜曲', css: 'linear-gradient(135deg,rgb(32,49,112),rgb(52,76,146),rgb(74,102,180),rgb(100,126,210),rgb(130,132,224),rgb(130,132,224),rgb(100,126,210),rgb(74,102,180),rgb(52,76,146),rgb(32,49,112))' },
      ]

      const FLOW_IDS = FLOW_GRADS.map((grad) => grad.id)

      /** 当前选中的动画 id（由状态轮询写入；null = 还没拿到 → 按默认的流星走）。 */
      let flowStyleNow = null

      /** 本轮该用哪个动画：只认白名单 —— host 已经校验过一次，这里再兜一次，
       *  因为这个值会被拼进 class 名（宁可退回流星，也不许拼出奇怪的类）。 */
      function currentFlowStyle() {
        if (flowStyleNow === 'meteor') return 'meteor'
        return FLOW_IDS.includes(flowStyleNow) ? flowStyleNow : 'meteor'
      }

      /** 流光动画的样式表（含菜单里的小色块）—— 由 FLOW_GRADS 生成，单一数据源。 */
      function flowGradCss() {
        const lines = [
// 设计说明已外置 → docs/client-design-notes.md#client-note-007（原 L202-210）
          '.dshqp-flow-grad {',
          '  position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: hidden;',
          '}',
          '.dshqp-flow-grad::before {',
          '  content: ""; position: absolute; inset: -200%;',
          '  background-size: 100% 100%; background-repeat: no-repeat;',
// 设计说明已外置 → docs/client-design-notes.md#client-note-008（原 L217-220）
          '  animation: dshqp-flowgrad-run 7s ease-in-out infinite alternate;',
          '}',
          '@keyframes dshqp-flowgrad-run {',
          '  from { transform: translate3d(-38%, -38%, 0); }',
          '  to   { transform: translate3d(38%, 38%, 0); }',
          '}',
// 设计说明已外置 → docs/client-design-notes.md#client-note-009（原 L227-233）
          '.dshqp-menu-swatch {',
          '  width: 16px; height: 14px; border-radius: 4px; flex: none;',
          '  border: 1px solid rgba(128,128,128,.45);',
          '  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);',
          '}',
        ]
        for (const grad of FLOW_GRADS) {
          // 渐变落在 ::before 上（真正的动画层）；菜单小色块静态铺满即可。
          lines.push(`.dshqp-flow-grad-${grad.id}::before { background-image: ${grad.css}; }`)
          lines.push(`.dshqp-menu-swatch-${grad.id} { background-image: ${grad.css}; }`)
        }
        return lines.join('\n')
      }

      /** composer 卡片及其父级（兜底用）。 */
      function flowHost() {
        const card = document.querySelector('[data-composer-card]')
        return card !== null && card.parentElement !== null ? { card, host: card.parentElement } : null
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-010（原 L254-265）
      function messageHost() {
        try {
          const item = document.querySelector('[class*="flowItem"]')
          if (item !== null && item.parentElement !== null) return item.parentElement
        } catch (error) { /* 选择器不被支持就算了，走兜底 */ }
        return null
      }

      /** 往上找最近的"真滚动容器"（保存/恢复滚动位置要用它，消息列表本身不一定滚）。 */
      function scrollAncestor(el) {
        let node = el
        for (let depth = 0; depth < 6 && node !== null; depth += 1) {
          try {
            if (node.scrollHeight > node.clientHeight + 20) return node
          } catch (error) { /* 拿不到尺寸就继续往上 */ }
          node = node.parentElement
        }
        return el
      }

            /** 往消息列表末尾插生成动画：容器由 F12 实采得到，只 append、不改消息树（复盘见 README 历史说明）。 */
      /** 出图标记的兜底定时器：到点无条件撤销标记（正常情况下永远用不到）。 */
      let drawingSafetyTimer = null

      function flowStart() {
        try {
          if (document.body) document.body.setAttribute(DRAWING_ATTR, '1')

// 设计说明已外置 → docs/client-design-notes.md#client-note-011（原 L294-302）
          try {
            for (const it of document.querySelectorAll('[class*="flowItem"]')) it.__dshqpOld = true
          } catch (error) { /* 标记失败最多是多藏几条，不影响出图 */ }

          try { markReasoningBlocks() } catch (error) { /* 藏不了不影响出图 */ }

// 设计说明已外置 → docs/client-design-notes.md#client-note-012（原 L309-315）
          if (drawingSafetyTimer !== null) clearTimeout(drawingSafetyTimer)
          drawingSafetyTimer = setTimeout(() => {
            drawingSafetyTimer = null
            try {
              if (document.body) document.body.removeAttribute(DRAWING_ATTR)
              stopReasoningWatch()
              const stale = document.getElementById(FLOW_ID)
              if (stale !== null) stale.remove()
            } catch (error) { /* 忽略 */ }
          }, 12 * 60 * 1000)

          const host = messageHost()
          if (host === null) return

// 设计说明已外置 → docs/client-design-notes.md#client-note-013（原 L330-338）
          let reused = null
          try { reused = document.getElementById(FLOW_ID) } catch (error) { reused = null }
          if (reused !== null) {
            if (reused.parentElement !== host) {
              try { host.appendChild(reused) } catch (error) { /* 挂不过去就当没有，下面会重建 */ }
            }
            if (reused.parentElement === host) {
              watchFlowNode(host)
              watchReasoning()
              return
            }
          }

          // 真没有节点时，才清理残留（正常情况这里已经没有东西可删）并新建
          try {
            for (const stale of document.querySelectorAll(`#${FLOW_ID}`)) {
              try { stale.remove() } catch (error) { /* 已经被移走 */ }
            }
          } catch (error) { /* 清理失败不影响后面的插入 */ }

// 设计说明已外置 → docs/client-design-notes.md#client-note-014（原 L359-366）
          host.appendChild(makeFlowNode())
          watchFlowNode(host)
          // ★ 思考块观察器**只在这段时间挂着**（出图结束由 flowFinish 摘掉）
          watchReasoning()
        } catch (error) {
          warn(`出图动画插入失败（不影响出图）：${error && error.message ? error.message : error}`)
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-015（原 L376-387）
      function detectDarkTheme() {
        try {
          const el = document.body || document.documentElement
          const bg = getComputedStyle(el).backgroundColor || ''
          const m = bg.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
          if (m !== null) {
            const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
            return lum < 140
          }
        } catch (error) { /* 读不到就走兜底 */ }
        try {
          if (typeof matchMedia === 'function') return !matchMedia('(prefers-color-scheme: light)').matches
        } catch (error) { /* 忽略 */ }
        return true
      }

      function makeFlowNode() {
        const box = document.createElement('div')
        box.id = FLOW_ID
        box.className = 'dshqp-flow'
        const style = currentFlowStyle()
        // ★ 把"当前主题"写进属性，CSS 据此在「银白金属 / 黑金属」之间切换
        try { box.setAttribute('data-dshqp-theme', detectDarkTheme() ? 'dark' : 'light') } catch (error) { /* 忽略 */ }

        if (style === 'meteor') {
          // ★ 流星画布（马卡龙流星从中心爆开、带拖尾、撞边反弹）
          try {
            const cv = document.createElement('canvas')
            cv.className = 'dshqp-flow-canvas'
            box.appendChild(cv)
            startMacaronBurst(cv)
          } catch (error) { /* 画布起不来就只显示金属底 + 高光，不影响出图 */ }

          const tip = document.createElement('div')
          tip.className = 'dshqp-flow-tip'
          tip.textContent = '感知世界中'
          box.appendChild(tip)
          return box
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-016（原 L428-432）
        try { box.setAttribute('data-dshqp-grad', style) } catch (error) { /* 忽略 */ }
        try {
          const layer = document.createElement('div')
          layer.className = `dshqp-flow-grad dshqp-flow-grad-${style}`
          box.appendChild(layer)
        } catch (error) { /* 流光层起不来就只剩底色，不影响出图 */ }
        return box
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-017（原 L442-451）
      function startMacaronBurst(canvas) {
        const MACARON = ['#FFB3BA', '#FFDFBA', '#FFF5BA', '#BAFFC9', '#BAE1FF', '#E0BBE4', '#FFC8DD', '#C7CEEA']
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
        if (raf === null) return undefined

        const W = 270
        const H = 480
        let ctx = null
        try {
          canvas.width = W
          canvas.height = H
          ctx = canvas.getContext('2d')
        } catch (error) { return undefined }
        if (ctx === null) return undefined

        const N = 24
        const parts = []
        for (let i = 0; i < N; i += 1) {
          const a = (Math.PI * 2 * i) / N + (Math.random() - 0.5) * 0.35
          const sp = 2.6 + Math.random() * 2.2
          parts.push({
            x: W / 2,
            y: H / 2,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp,
            c: MACARON[i % MACARON.length],
            trail: [],
          })
        }

        // ★ 用户 2026-10-08：「流星保持弹性碰撞，撞到边缘原速度返回」+
        //   「不要淡出啊，要一直存在，直到图片生成完毕」
        //   → **无衰减、无淡出、无寿命上限**：一直匀速弹下去，
        //     直到 canvas 被移出文档（出图结束那一刻）才停。
        const step = () => {
          // ★ 节点已被移出文档（出图结束）→ 自己收工，不留常驻 rAF
          if (typeof canvas.isConnected === 'boolean' && !canvas.isConnected) return
          try { ctx.clearRect(0, 0, W, H) } catch (error) { return }

          for (const p of parts) {
            p.x += p.vx
            p.y += p.vy
            // ★ 无衰减 —— 弹性碰撞，撞到边缘原速度返回
            if (p.x < 0) { p.x = 0; p.vx = -p.vx }
            if (p.x > W) { p.x = W; p.vx = -p.vx }
            if (p.y < 0) { p.y = 0; p.vy = -p.vy }
            if (p.y > H) { p.y = H; p.vy = -p.vy }

            // 拖尾：★ 需求方要求"再长一些" —— 从 6 个残影增到 12 个（长度大约翻倍）
            p.trail.push({ x: p.x, y: p.y })
            if (p.trail.length > 12) p.trail.shift()

            // 浅色拖尾（越靠后越淡越细；★ 不乘 life —— 流星全程存在）
            for (let t = 0; t < p.trail.length; t += 1) {
              const q = p.trail[t]
              const k = (t + 1) / p.trail.length
              ctx.globalAlpha = k * 0.34
              ctx.fillStyle = p.c
              ctx.beginPath()
              ctx.arc(q.x, q.y, 1 + k * 2.6, 0, Math.PI * 2)
              ctx.fill()
            }
            // 流星本体（马卡龙色 + 白色小核）
            ctx.globalAlpha = 0.95
            ctx.fillStyle = p.c
            ctx.beginPath()
            ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalAlpha = 0.85
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
          raf(step)
        }
        raf(step)
        return undefined
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-018（原 L533-542）
      let flowGuard = null
      function watchFlowNode(host) {
        try {
          if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
          flowGuard = setInterval(() => {
            try {
              // 出图结束或列表已卸载 → 自己收工，不留常驻定时器
              if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) {
                if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
                return
              }
              if (host.parentElement === null) {
                if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
                return
              }
              // 节点还好端端待在列表里 → **什么都不做**（绝不能删了重建，那会让动画从头播）
              const existing = document.getElementById(FLOW_ID)
              if (existing !== null && existing.parentElement === host) return
              // 确实丢了才补：先清掉可能残留的同类节点，保证页面上**永远只有一个**
              for (const stale of document.querySelectorAll(`#${FLOW_ID}`)) {
                try { stale.remove() } catch (error) { /* 已经被移走 */ }
              }
              host.appendChild(makeFlowNode())
            } catch (error) { /* 单拍失败不影响下一拍 */ }
          }, 1000)
        } catch (error) { /* 定时器装不上只意味着"节点被删后不会自动补"，不影响出图 */ }
      }

      /** 出图完成（或失败）：撤掉标记，让动画平滑淡出后移除，把位置让给正文里的图片。 */
      function flowFinish() {
        try {
          if (document.body) document.body.removeAttribute(DRAWING_ATTR)

          // ★★★ 三十一次修正（用户：「现在生好图都有了，给我回调回去」）——
          //   **恢复"出图结束就停轮询"**。上一轮我把它改成常驻，导致出图后它还在藏、
          //   思考块一直不回来。这里**第一件事就是停掉它**，然后再还原隐藏。
          stopReasoningWatch()

          // ★★★ 三十次修正（关键）—— **把被内联隐藏的条目全部还原**。
          //   从这一版起，隐藏不再依赖 CSS 规则，而是**直接设 `element.style.display = 'none'`**
          //   （内联样式优先级最高、立刻生效，不受 CSS/选择器影响）。
          //   因此这里必须**逐一把 display 恢复回原值**，否则它们会永远消失。
          //   原值在隐藏时记在 `__dshqpPrevDisplay` 上（通常是空串，即交还给 CSS），这里精确还原。
          try {
            for (const el of document.querySelectorAll(`[${REASONING_ATTR}]`)) {
              try {
                el.style.display = el.__dshqpPrevDisplay || ''
                delete el.__dshqpPrevDisplay
              } catch (error) { /* 单个还原失败不影响其它 */ }
              el.removeAttribute(REASONING_ATTR)
            }
          } catch (error) { /* 还原失败最坏是它们一直藏着；下次出图不会更糟 */ }
          // ★ 标记已撤销，兜底定时器就没必要了（不清掉它 12 分钟后会白跑一次）
          if (drawingSafetyTimer !== null) { clearTimeout(drawingSafetyTimer); drawingSafetyTimer = null }
          if (flowHideTimer !== null) clearTimeout(flowHideTimer)
          // ★ 上一版把变量从 flowObserver（观察器）改成了 flowGuard（轮询定时器），
          //   这里必须同步改 —— 否则出图结束时会因引用未定义变量而抛错。
          if (flowGuard !== null) { clearInterval(flowGuard); flowGuard = null }
          const box = document.getElementById(FLOW_ID)
          if (box === null) return
          // ★ 同样**不碰滚动**（理由见 flowStart 的十一次修正说明）：
          //   移除后由 DSH 自己跟随底部，我插手只会破坏它的正常机制。
          box.setAttribute('data-done', '1')          // CSS 里做淡出
          flowHideTimer = setTimeout(() => {
            flowHideTimer = null
            try { box.remove() } catch (error) { /* 已被移除 */ }
          }, 460)
        } catch (error) {
          /* 清理失败无所谓，下次出图会重建 */
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-019（原 L615-628）
      const REASONING_TEXT_RE = /^\s*(正在分析请求|正在分析|已完成分析|分析中|正在调用工具|调用工具|深度求索|正在思考|思考中|Thinking|Reasoning|Calling)/u
      function markReasoningBlocks() {
        try {
// 设计说明已外置 → docs/client-design-notes.md#client-note-020（原 L632-641）
          if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) return

          const spot = flowHost()
          // ★★ 2026-10-08：扫描范围直接用 document.body —— 用户 F12 诊断显示
          //    "被标记的思考块数量 = 0"，证明之前那个"往上爬 4 层"的范围**根本扫不到消息列表里的思考块**。
          //    性能可接受：只在 DOM 变化后节流 400ms 跑一次，且只读属性。
          const root = document.body
          if (!root || typeof root.querySelectorAll !== 'function') return
          // ★★ 性能护栏（十八次修正的配套）：**全页元素上限**。
          //   消息多的会话（这个已有 195 条）全页上万元素，即便 400ms 一次
          //   也不该无上限遍历。超过上限就**只扫消息列表那一块**，够用且便宜。
          let all
          try {
            all = root.querySelectorAll('div,span,button,p')
          } catch (error) { all = [] }
          if (all.length > 4000) {
            const list = messageHost()
            if (list !== null) {
              try { all = list.querySelectorAll('div,span,button,p') } catch (error) { all = [] }
            }
          }
// 设计说明已外置 → docs/client-design-notes.md#client-note-021（原 L663-692）
          const ITEM_TEXT_RE = /(思考|正在分析请求|正在分析|已完成分析|分析中|正在调用工具|调用工具|深度求索|Thinking|Reasoning|Calling)/u
          const items = (() => {
            try { return document.querySelectorAll('[class*="flowItem"]') } catch (error) { return [] }
          })()
// 设计说明已外置 → docs/client-design-notes.md#client-note-022（原 L697-714）
          const KW = ['已完成分析', '正在分析请求', '正在分析', '正在调用工具', '调用工具', '深度求索', '思考']
          let hitText = 0
          let hitItem = 0
          let missItem = 0
          try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
            const parents = new Set()
            let tn = walker.nextNode()
            while (tn !== null) {
              const raw = (tn.nodeValue || '').trim()
              if (raw !== '' && raw.length <= 120 && KW.some((k) => raw.indexOf(k) !== -1)) {
                if (tn.parentElement !== null) parents.add(tn.parentElement)
              }
              tn = walker.nextNode()
            }
            hitText = parents.size
// 设计说明已外置 → docs/client-design-notes.md#client-note-023（原 L731-742）
            for (const el of parents) {
              // A. 可见性过滤：离屏节点一律不碰
              let visible = true
              try { visible = el.offsetParent !== null } catch (error) { visible = true }
              if (!visible) continue

              // ★★★ 三十五次修正
              //   （用户：「我在新对话里让画图时复现了无法翻看聊天记录的bug」）——
              //   **只处理"本次出图"产生的条目；出图之前就存在的一律不碰。**
              //
              //   根因：在**上面**把历史思考块 display:none 掉，会让**页面总高度骤减**；
              //   新对话历史本来就短，一藏就把可滚动高度吃光 → **滚不动、翻不了记录**。
              //
              //   ⚠ 注意这**不是**昨天那个 scrollTop 的 bug ——
              //     代码里已经没有任何 scrollTop 写入（早期版本曾写 scrollTop 把视图钉死）；
              //     这次是"改了内容高度"，机制完全不同。
              //   旧条目在 flowStart 时统一打了 __dshqpOld 标记，这里直接跳过。
              let oldNode = el
              let isOld = false
              for (let d = 0; d < 8 && oldNode !== null && oldNode !== document.body; d += 1) {
                if (oldNode.__dshqpOld === true) { isOld = true; break }
                oldNode = oldNode.parentElement
              }
              if (isOld) continue

              let item = typeof el.closest === 'function' ? el.closest('[class*="flowItem"]') : null
// 设计说明已外置 → docs/client-design-notes.md#client-note-024（原 L769-777）
              if (item === null) { missItem += 1; continue }

              // ★★ 硬保护：**要藏的元素里若含 2 个以上条目，它必定是消息容器** —— 放弃。
              //    这比任何"层数 / 高度"判据都可靠，直接卡死"藏掉整个聊天区"这类事故。
              let innerItems = 0
              try {
                if (typeof item.querySelectorAll === 'function') innerItems = item.querySelectorAll('[class*="flowItem"]').length
              } catch (error) { innerItems = 0 }
              if (innerItems > 1) { missItem += 1; continue }

// 设计说明已外置 → docs/client-design-notes.md#client-note-025（原 L788-791）
              let itemH = 0
              try { itemH = item.getBoundingClientRect().height } catch (error) { itemH = 0 }
              if (itemH > 120) { missItem += 1; continue }

              if (item.__dshqpHidden === true) continue
              item.__dshqpHidden = true
              item.__dshqpPrevDisplay = item.style.display || ''
              item.style.display = 'none'          // ★ 内联样式，立刻生效
              item.setAttribute(REASONING_ATTR, '1')
              hitItem += 1
              if (item.__dshqpLogged !== true) {
                item.__dshqpLogged = true
                const tag = (item.className || '').toString().slice(0, 34)
                console.log(`[qwen-paint] 已隐藏: ${tag}  「${(item.textContent || '').trim().slice(0, 24)}」`)
              }
            }

// 设计说明已外置 → docs/client-design-notes.md#client-note-026（原 L809-818）
            let hiddenIcons = 0
            const svgs = document.querySelectorAll('svg')
            for (const s of svgs) {
              let sVisible = true
              try { sVisible = s.offsetParent !== null } catch (error) { sVisible = true }
              if (!sVisible) continue
              let su = s.parentElement
              for (let d = 0; d < 6 && su !== null && su !== document.body; d += 1) {
                // ★★ 三十七次修正 —— 与上面同理的**硬保护**：
                //   候选祖先里若含 2 个以上条目，它一定是消息容器（或更外层），**放弃**。
                //   这直接卡死"藏掉整个聊天区"的事故（用户截图那次就是退路选错了层）。
                let innerItems = 0
                try {
                  if (typeof su.querySelectorAll === 'function') innerItems = su.querySelectorAll('[class*="flowItem"]').length
                } catch (error) { innerItems = 0 }
                if (innerItems > 1) break

                let st = ''
                try { st = (su.textContent || '').trim().slice(0, 60) } catch (error) { st = '' }
                if (st !== '' && KW.some((k) => st.indexOf(k) !== -1)) {
                  let r = null
                  try { r = su.getBoundingClientRect() } catch (error) { r = null }
                  // ★ 高度上限收紧到 200px —— 图标那一行本来就很矮，别给它机会选到大容器
                  const fits = r !== null && r.height >= 0 && r.height <= 200 && r.width > 0
                  if (fits && su.__dshqpHidden !== true) {
                    su.__dshqpHidden = true
                    su.__dshqpPrevDisplay = su.style.display || ''
                    su.style.display = 'none'
                    su.setAttribute(REASONING_ATTR, '1')
                    hiddenIcons += 1
                    if (su.__dshqpLogged !== true) {
                      su.__dshqpLogged = true
                      console.log(`[qwen-paint] 已隐藏图标容器: ${(su.className || '').toString().slice(0, 30)}`)
                    }
                  }
                  break
                }
                su = su.parentElement
              }
            }
            if (hiddenIcons > 0) {
              console.log(`[qwen-paint] 本轮清掉图标容器 ${hiddenIcons} 个`)
            }
          } catch (error) {
            warn(`思考块隐藏（TreeWalker 法）出错：${error && error.message ? error.message : error}`)
          }
          if (missItem > 0) {
            console.log(`[qwen-paint] 有 ${missItem} 处关键词所在元素 closest('flowItem') 返回 null —— 说明它们不在条目里`)
          }
        } catch (error) {
          /* 标记失败只是"思考块不会被隐藏"，不影响任何功能 */
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-027（原 L873-886）
      let reasoningTimer = null
      let reasoningPoll = null

// 设计说明已外置 → docs/client-design-notes.md#client-note-028（原 L890-906）
      function watchReasoning() {
        try {
          if (reasoningPoll !== null) return              // 已经在轮询，别重复挂
          markReasoningBlocks()
          reasoningPoll = setInterval(() => {
            try {
// 设计说明已外置 → docs/client-design-notes.md#client-note-029（原 L913-918）
              if (!document.body || !document.body.hasAttribute(DRAWING_ATTR)) {
                stopReasoningWatch()
                return
              }
              markReasoningBlocks()
            } catch (error) { /* 单拍失败不影响下一拍 */ }
          }, 1500)
        } catch (error) {
          /* 定时器装不上就退化成"不隐藏思考块"，不影响出图 */
        }
      }

      /** 出图结束：停掉轮询，界面回到"零常驻、零监听"状态。 */
      function stopReasoningWatch() {
        try {
          if (reasoningPoll !== null) { clearInterval(reasoningPoll); reasoningPoll = null }
          if (reasoningTimer !== null) { clearTimeout(reasoningTimer); reasoningTimer = null }
        } catch (error) { /* 忽略 */ }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-030（原 L939-943）
      function cardCss() {
        return `
.dshqp-card { display: flex; flex-direction: column; gap: 6px; max-width: min(380px, 100%); }
/* ★ 2026-10-19（用户要求）：多图并排（开了「用户自选」且一次出了多张时） */
.dshqp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.dshqp-cell { position: relative; }
.dshqp-idx { position: absolute; top: 6px; left: 6px; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; background: rgba(0,0,0,.62); color: #fff; font-size: 11px; line-height: 18px;
  text-align: center; pointer-events: none; }
.dshqp-img { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid rgba(128,128,128,.30); }
/* ★ 呼吸灯 → 图片的平滑过渡（用户 2026-10-07 指定："图片出来后立刻平滑转换为生成的图片"）。
   做法：图片入场时淡入 + 从略小放大，配合呼吸灯消失，读起来就是那只灯"展开"成了图。
   为什么不做呼吸灯的退场动画：它在 React 里是**被直接卸载**的、没有退场时机；
   靠"图片随即淡入"视觉上已经连贯，不值得为它加延迟卸载的复杂度。 */
.dshqp-img { animation: dshqp-reveal .45s cubic-bezier(.22,.8,.28,1) both; }
/* ★★★ 2026-10-19（用户要求）：圈选重绘弹窗。**独立浮层**，不碰消息树。
   ★ 2026-11-12（用户：「ui 还是有点丑，做得典雅一点」）：改成 **CSS 变量驱动**，
     并在浮层根节点上写 data-dshqp-theme。原来卡片写死 #1b1b1f / #eee ——
     宿主切到浅色主题时就是一块突兀的黑板，这才是"丑"的主因。
     现在深/浅两套只换变量，不改结构；圆角、阴影、间距一并收细。 */
.dshqp-mask-overlay {
  --qp-bg: #1c1d22; --qp-fg: #ecedf1; --qp-muted: rgba(236,237,241,.62);
  --qp-line: rgba(255,255,255,.14); --qp-line-strong: rgba(255,255,255,.26);
  --qp-field: rgba(255,255,255,.06); --qp-field-hover: rgba(255,255,255,.12);
  --qp-accent: #7db3ff; --qp-accent-soft: rgba(125,179,255,.20);
  --qp-on-accent: #0b1220; --qp-shadow: 0 24px 72px rgba(0,0,0,.58);
  --qp-scrim: rgba(0,0,0,.62);
  position: fixed; inset: 0; z-index: 2147483000; background: var(--qp-scrim);
  display: flex; align-items: center; justify-content: center; padding: 16px;
  -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px);
}
.dshqp-mask-overlay[data-dshqp-theme="light"] {
  --qp-bg: #ffffff; --qp-fg: #14161b; --qp-muted: rgba(20,22,27,.60);
  --qp-line: rgba(15,23,42,.12); --qp-line-strong: rgba(15,23,42,.26);
  --qp-field: rgba(15,23,42,.04); --qp-field-hover: rgba(15,23,42,.08);
  --qp-accent: #2563eb; --qp-accent-soft: rgba(37,99,235,.12);
  --qp-on-accent: #ffffff; --qp-shadow: 0 24px 72px rgba(15,23,42,.22);
  --qp-scrim: rgba(15,23,42,.40);
}
.dshqp-mask-card { background: var(--qp-bg); color: var(--qp-fg); border-radius: 16px; padding: 16px 18px;
  width: min(920px, 96vw); max-height: 94vh; overflow: auto;
  border: 1px solid var(--qp-line); box-shadow: var(--qp-shadow);
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  letter-spacing: .01em; }
.dshqp-mask-title { font-size: 14.5px; font-weight: 600; margin-bottom: 5px; letter-spacing: .02em; }
.dshqp-mask-hint { font-size: 12px; color: var(--qp-muted); margin-bottom: 12px; }
.dshqp-mask-stage { position: relative; display: inline-block; max-width: 100%; }
.dshqp-mask-stage img, .dshqp-mask-stage canvas { display: block; max-width: 100%; height: auto; border-radius: 10px; }
.dshqp-mask-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.dshqp-mask-tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }
.dshqp-mask-btn { border: 1px solid var(--qp-line-strong); background: var(--qp-field); color: var(--qp-fg);
  border-radius: 9px; padding: 6px 13px; font-size: 12px; cursor: pointer; font: inherit;
  transition: background .16s ease, border-color .16s ease, transform .16s ease; }
.dshqp-mask-btn:hover { background: var(--qp-field-hover); }
.dshqp-mask-btn:active { transform: translateY(1px); }
.dshqp-mask-btn:focus-visible { outline: 2px solid var(--qp-accent); outline-offset: 2px; }
.dshqp-mask-btn[data-on="1"] { background: var(--qp-accent-soft); border-color: var(--qp-accent); }
/* 主动作（开始重绘 / 截取这一段）：给一个明确的强调，不用用户在一堆同款按钮里找 */
.dshqp-mask-btn[data-primary="1"] { background: var(--qp-accent); border-color: var(--qp-accent);
  color: var(--qp-on-accent); font-weight: 600; }
.dshqp-mask-btn[data-primary="1"]:hover { filter: brightness(1.08); }
/* 编辑台选择面板：三个能力按钮竖排，彼此留间距 */
.dshqp-studio-picker .dshqp-mask-btn { display: block; width: 100%; margin: 8px 0; text-align: left; }
.dshqp-mask-btn:disabled { opacity: .45; cursor: default; transform: none; }
.dshqp-mask-prompt { width: 100%; box-sizing: border-box; min-height: 54px; resize: vertical;
  border-radius: 10px; border: 1px solid var(--qp-line); background: var(--qp-field);
  color: var(--qp-fg); padding: 9px 11px; font: inherit; }
.dshqp-mask-prompt:focus { outline: none; border-color: var(--qp-accent); }
.dshqp-mask-foot { display: flex; gap: 10px; justify-content: flex-end; align-items: center; margin-top: 12px; }
.dshqp-mask-state { margin-right: auto; font-size: 12px; color: var(--qp-muted); }
/* ★ 2026-10-20（0.17.13）：结果图容器 —— 空的时候不占位，免得把"开始重绘"按钮顶下去 */
.dshqp-mask-result:empty { display: none; }
/* ★ 2026-11-12：图片编辑台 + 图上可见操作条。
   以前圈选重绘只有一个 title 悬停提示，用户根本发现不了；现在每张结果图下面直接摆按钮。
   本段是 cardCss 模板字符串的一部分，注释里不许出现反引号。 */
.dshqp-img-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.dshqp-img-btn { border: 1px solid rgba(120,180,255,.55); background: rgba(120,180,255,.16);
  color: #dbe9ff; border-radius: 7px; padding: 4px 9px; font-size: 11px; cursor: pointer; }
.dshqp-img-btn:hover { background: rgba(120,180,255,.30); }
.dshqp-mask-presets { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 2px; }
.dshqp-chip { border: 1px solid var(--qp-line-strong); background: var(--qp-field);
  color: var(--qp-fg); border-radius: 999px; padding: 4px 11px; font-size: 11px; cursor: pointer;
  font: inherit; transition: border-color .16s ease, background .16s ease; }
.dshqp-chip:hover { border-color: var(--qp-accent); background: var(--qp-accent-soft); }
.dshqp-wb-head { font-size: 12px; opacity: .8; margin-bottom: 8px; line-height: 1.7; }
.dshqp-wb-label { font-size: 12px; font-weight: 600; margin: 12px 0 6px; }
.dshqp-wb-list { display: flex; gap: 8px; flex-wrap: wrap; max-height: 176px; overflow: auto; }
.dshqp-wb-thumb { width: 84px; border: 2px solid transparent; border-radius: 10px; overflow: hidden;
  background: var(--qp-field); cursor: pointer; padding: 0;
  transition: border-color .16s ease, transform .16s ease; }
.dshqp-wb-thumb:hover { transform: translateY(-1px); }
.dshqp-wb-thumb[data-on="1"] { border-color: var(--qp-accent); box-shadow: 0 0 0 3px var(--qp-accent-soft); }
.dshqp-wb-thumb img { display: block; width: 100%; height: 62px; object-fit: cover; }
.dshqp-wb-thumb span { display: block; font-size: 10px; padding: 3px 4px; opacity: .8;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshqp-wb-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.dshqp-wb-empty { font-size: 12px; opacity: .72; line-height: 1.7; }
.dshqp-wb-result:empty { display: none; }
.dshqp-wb-result img { display: block; max-width: 100%; border-radius: 8px; margin-top: 10px; }
/* ★ 2026-11-12 视频选帧浮层：播放器 + 参数行 + 结果。与圈选浮层同一套视觉，不另起风格。 */
.dshqp-vid { display: block; width: 100%; max-height: 44vh; border-radius: 10px; background: #000; }
.dshqp-vid-meta { font-size: 12px; opacity: .78; margin: 8px 0 4px; font-variant-numeric: tabular-nums; }
.dshqp-vid-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
.dshqp-vid-lab { font-size: 12px; opacity: .74; }
.dshqp-vid-num { width: 84px; box-sizing: border-box; padding: 5px 7px; font-size: 12px;
  color: var(--qp-fg); background: var(--qp-field); border: 1px solid var(--qp-line-strong);
  border-radius: 8px; font: inherit; font-variant-numeric: tabular-nums; }
.dshqp-vid-num:focus { outline: none; border-color: var(--qp-accent); background: var(--qp-bg); }
.dshqp-vid-list { display: flex; gap: 6px; flex-wrap: wrap; max-height: 84px; overflow: auto; }
.dshqp-vid-list:empty { display: none; }
.dshqp-vid-track { display: flex; gap: 4px; overflow-x: auto; padding: 6px 2px; border-top: 1px solid var(--qp-line); border-bottom: 1px solid var(--qp-line); margin: 8px 0; }
.dshqp-vid-track:empty { display: none; }
.dshqp-vid-thumb { flex: 0 0 auto; width: 72px; height: 42px; object-fit: cover; border-radius: 5px; border: 1px solid var(--qp-line-strong); cursor: pointer; opacity: .82; }
.dshqp-vid-thumb:hover { opacity: 1; border-color: var(--qp-accent); }
.dshqp-wb-result video { display: block; max-width: 100%; border-radius: 8px; margin-top: 10px; }
@keyframes dshqp-reveal {
  from { opacity: 0; transform: scale(.94) translateY(4px); }
  to   { opacity: 1; transform: none; }
}
.dshqp-name { font-size: 12px; line-height: 1.4; opacity: .62; word-break: break-all; }
.dshqp-pending { font-size: 13px; line-height: 1.5; opacity: .72; }
/* ★ 生成中的「RGB 呼吸灯」（用户 2026-10-07 指定）：
   正方形 + 白色流光从左上扫到右下 + 下方小字「正在生成图片」。
   纯 CSS 动画，不占 JS、不依赖 React 重渲染，卸载时随 style 一起摘掉。 */
.dshqp-loading { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 8px 0; }
.dshqp-lamp {
  position: relative; width: 96px; height: 96px; border-radius: 14px; overflow: hidden;
  background: conic-gradient(from 0deg, #ff5f6d, #ffc371, #46e891, #38bdf8, #a855f7, #ff5f6d);
  animation: dshqp-breathe 2.6s ease-in-out infinite;
}
@keyframes dshqp-breathe {
  0%, 100% { opacity: .55; filter: saturate(.85); }
  50%      { opacity: 1;   filter: saturate(1.3); }
}
.dshqp-lamp::after {
  content: ""; position: absolute; inset: -45%;
  background: linear-gradient(115deg, transparent 40%, rgba(255,255,255,.95) 50%, transparent 60%);
  animation: dshqp-sweep 1.8s linear infinite;
}
@keyframes dshqp-sweep {
  from { transform: translate(-58%, -58%); }
  to   { transform: translate(58%, 58%); }
}
.dshqp-loading-text { font-size: 12px; line-height: 1.3; opacity: .82; }
.dshqp-error { font-size: 13px; line-height: 1.5; color: #e5484d; white-space: pre-wrap; word-break: break-word; }
.dshqp-seat { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; line-height: 1; opacity: .8; white-space: nowrap; min-width: 0; }
/* ★★★ 2026-10-09（需求方要求：「✨ 这个星星太丑了，改掉。换成一个更好看的星星」）：
   状态点原先是个 8px 的**纯圆点**，用户觉得难看。现在改成**四角星**（就是 ✨ 那种闪光形）。
   做法：clip-path 抠出星形，不引入任何图片资源。
   ⚠ 光晕必须从 box-shadow 换成 **drop-shadow** —— box-shadow 画的是**元素盒子**的阴影，
     会被 clip-path 一起裁掉、等于消失；drop-shadow 是按**裁剪后的可见形状**投影，才跟得住星形。
   内凹点取 35%/65%（而不是更尖的 38%/62%）：10px 这个尺寸下太尖会糊成一团小刺。 */
/* ★★★ 2026-10-09 重新设计（用户反馈「这个星星太丑了」）。
   改了三处：
     ① 尺寸 10px → 12px：小尺寸下 8 角星的尖角会糊成一团小刺，放大一点才看得出形状；
     ② 内凹 35%/65% → 43%/57%：原来是"胖八角"，现在收成**修长的四角星（sparkle）**，
        四个主角更长、四个次角更短，视觉上更精致、更有"星"的感觉；
     ③ 光晕从单层改成**双层 drop-shadow**（近处一层紧实、远处一层柔和），
        比原来单层 3px 更通透，不再是硬邦邦一圈边。
   ⚠ 仍然不用任何图片资源；光晕必须用 drop-shadow（box-shadow 会被 clip-path 一起裁掉）。 */
.dshqp-dot {
  width: 12px; height: 12px; flex: none;
  background: rgba(128, 128, 128, .55);
  clip-path: polygon(
    50% 0%, 57% 43%, 100% 50%, 57% 57%,
    50% 100%, 43% 57%, 0% 50%, 43% 43%
  );
  transition: background .25s ease, filter .25s ease;
}
.dshqp-dot[data-state="on"] {
  background: #30a46c;
  filter: drop-shadow(0 0 2px rgba(48, 164, 108, .7))
          drop-shadow(0 0 5px rgba(48, 164, 108, .45));
}
.dshqp-dot[data-state="busy"] {
  background: #f5a623;
  filter: drop-shadow(0 0 2px rgba(245, 166, 35, .7))
          drop-shadow(0 0 5px rgba(245, 166, 35, .45));
}
/* ★ 点状态点弹出的「自动关闭时长」菜单（用户 2026-10-07 新增需求：可以选择多久后关后端）。
   向上弹出，避免被 composer 下边缘裁掉。 */
.dshqp-seat[data-clickable="1"] { cursor: pointer; position: relative; }
.dshqp-menu {
  /* ★★★ 用户 2026-10-08 两次反馈后的定案：**挂到 body 上 + fixed 定位**。
     原来是 seat 的子元素 + absolute 定位，会被 composer 那一串祖先的 overflow **裁掉** ——
     新会话里 composer 被抬到屏幕顶部，菜单直接被切头，而且**滚动也救不了**
     （裁的是元素的可见区域，不是它自己的滚动内容）。
     挂到 body 就跟祖先裁剪彻底无关了；坐标由 placeMenu() 每次打开时现算。 */
  position: fixed; top: 0; left: 0; z-index: 2147483000;
  /* ★ 2026-10-09：字放大之后菜单也要跟着宽一点，否则最长那几项（「5 分钟后关闭（默认）」）
     会贴着边框。150 → 176。 */
  display: flex; flex-direction: column; min-width: 176px; padding: 5px;
  border-radius: 10px; background: rgba(30,30,34,.97);
  border: 1px solid rgba(128,128,128,.38); box-shadow: 0 10px 28px rgba(0,0,0,.45);
  /* ★ 用户 2026-10-08：「把这个选择界面稍微调小一点试试」——
     上限 560 → 400，字号/行距也各收一档（配合 max-height 一起看）。 */
  max-height: min(70vh, 400px); overflow-y: auto; overscroll-behavior: contain;
  /* ★ 2026-10-09 通用性：不许超出视口宽度。
     窄屏/分屏/手机横屏时，菜单原来的"按内容自适应"可能顶出去被截掉。 */
  max-width: calc(100vw - 16px);
}
/* ★★★ 2026-10-09 新增（需求方要求）：**功能区 vs 外观区**的分隔线。
   需求原文：「这些你和下面的颜色选择要区分出来啊，这是给用户调整功能的」
   —— 原先"后端 / 自动关闭 / 生图判断"（功能设置）和"生图动画 / 流光"
   （纯外观）是**平铺**在一起的，五组标题一个样式，看不出前三个是一类。
   这条线比普通分组线更明显（渐隐，两侧淡出），一眼就能分出上下两块。
   ⚠ 本段注释里不许出现反引号：CARD_CSS 是 JS 模板字符串，反引号会提前截断它。 */
.dshqp-menu-divider {
  height: 1px; flex: none; margin: 9px 3px 7px;
  background: linear-gradient(90deg,
    transparent 0%, rgba(128, 128, 128, .5) 50%, transparent 100%);
}
/* 分组小标题（「自动关闭」/「生图动画」） */
.dshqp-menu-head {
  font-size: 11px; font-weight: 700; letter-spacing: .04em; opacity: .55;
  padding: 7px 11px 3px; text-align: left; white-space: nowrap;
}
/* 非第一组的分组标题上方加一条分隔线，视觉上分得清两组 */
.dshqp-menu-head + .dshqp-menu-item { margin-top: 1px; }
.dshqp-menu-head:not(:first-child) {
  margin-top: 4px; border-top: 1px solid rgba(128,128,128,.26); padding-top: 6px;
}
/* ★ 子标题（「流光 · 抄自月匠」）：比组标题更轻，**不带**上面那条分隔线 ——
   它紧跟在「流星」那一项后面，画一条线会把"流星属于生图动画"这层关系切断。
   ⚠ 这条必须写在 .dshqp-menu-head:not(:first-child) 之后（两者特异性相同，靠顺序取胜）。 */
.dshqp-menu-head.dshqp-menu-sub {
  border-top: 0; margin-top: 1px; padding-top: 4px;
  opacity: .45; font-size: 10px;
}
/* 「流星」名字前面的小圆点（需求方要求：给自制那个标个点） */
.dshqp-menu-bullet {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: linear-gradient(135deg, #ffd7a1, #ff8fb1 48%, #8fa9ff);
}
/* 名字后面的来源小标签（自制） */
.dshqp-menu-tag {
  font-size: 9.5px; line-height: 1; padding: 1px 5px; border-radius: 999px; flex: none;
  border: 1px solid rgba(128,128,128,.45); opacity: .75;
}
.dshqp-menu-item {
  display: flex; align-items: center; gap: 7px;
  /* ★★★ 2026-10-09（需求方要求：「这几个选项的字有点挤在一起了，你稍微隔开一丢丢，
     并且把字放大一点」）：
       字号 11.5 → **13px**、行高 1.2 → 1.4、内边距 5/9 → **8/11**、条目间距 5 → 7。
       原来是长期"为了不撑宽菜单"一路压下来的，压到后来确实太挤了。 */
  text-align: left; font-size: 13px; line-height: 1.4; padding: 8px 11px; border: 0;
  border-radius: 7px; background: transparent; color: #e8e8ea; cursor: pointer; white-space: nowrap;
  max-width: 100%; overflow: hidden;
}
/* ★ 2026-10-09（需求方要求）：**外观区**（生图动画 / 流光配色）字号收一档、间距也小一点，
   和上面的功能区拉开层次 —— 一眼能看出"上面是调功能、下面是选样子"。
   配合 menu-divider，两组在视觉上彻底分开。 */
/* ★ 2026-10-09（需求方要求：功能区与外观区要分得开，且「下面的颜色选择也太在一起了，
   稍微隔开一点点」）：外观区（生图动画 / 流光配色）字号收一档、间距反而**加大** ——
   色块本来就只有 16px 高，条目挤在一起时整排看起来是一道色带，分不清哪块是哪块。
   内边距 6→9、图标与文字间隔 7→10，让每条色块各自独立成行。 */
.dshqp-menu-item[data-kind="flow"] { font-size: 12px; padding: 9px 11px; gap: 10px; }
/* ★ 2026-10-09：菜单里的**提示条**（目前用于"启动失败原因"）。
   比条目更淡、允许换行 —— 错误信息往往是一长句，绝不能让它撑破菜单。 */
.dshqp-menu-note {
  margin: 2px 6px 6px; padding: 7px 9px; border-radius: 7px;
  font-size: 11px; line-height: 1.45;
  color: #f0a8a2; background: rgba(229, 72, 77, .12);
  border: 1px solid rgba(229, 72, 77, .3);
  white-space: normal; word-break: break-word; overflow-wrap: anywhere;
}
.dshqp-menu-item:hover { background: rgba(128,128,128,.24); }
/* ★★★ 2026-11-12（用户：「这个你放的地方也太不明显了吧你把它改的明显一点」）：
   常用项（圈选重绘 / 图片编辑台 / 视频选帧）用**左侧色条 + 淡底 + 加粗**，
   和一堆设置项拉开层次。左边那个空心单选圆在这里没有意义，换成一条竖色条。 */
.dshqp-menu-item.dshqp-menu-hot {
  background: rgba(90,160,255,.12);
  box-shadow: inset 0 0 0 1px rgba(90,160,255,.30);
  color: #dce9ff; font-weight: 600; margin: 3px 0;
}
.dshqp-menu-item.dshqp-menu-hot:hover { background: rgba(90,160,255,.24); }
.dshqp-menu-item.dshqp-menu-hot::before {
  content: ""; flex: none; width: 3px; height: 14px; border-radius: 2px;
  background: #7fb3ff; border: 0;
}
/* ★ 2026-10-08 需求方要求：把「当前选中的档位」高亮出来。
   ★★★ 2026-10-09（需求方要求：「这个选择的勾你改成圆圈，选哪个就在左边把这个勾改成空心圆圈」）：
   选中标记由 **勾（✓）** 改成**空心圆圈**：
   · 未选中 —— 一个低调的灰色空心圆，当作占位（保证各条目文字左边缘对齐、切换时不左右跳）；
   · 已选中 —— 圆圈变高亮色并加粗，圆心再点一个实心点。
   这就是标准单选（radio）的样子，比原来那个勾轻，也和外观区那排彩色色块明显不是一类。
   圆心点用 **inset box-shadow** 画，省掉再挂一个伪元素。
   ⚠ 尺寸必须写死 13px（原来是 width: 11px + 文字内容撑高），否则空圆在 flex 里会被压扁。 */
.dshqp-menu-item::before {
  content: ""; flex: none; width: 13px; height: 13px; box-sizing: border-box;
  border-radius: 50%; border: 1.5px solid rgba(128, 128, 128, .42);
  transition: border-color .16s ease;
}
.dshqp-menu-item[data-current="1"] { background: rgba(90,160,255,.20); color: #cfe3ff; font-weight: 600; }
.dshqp-menu-item[data-current="1"]:hover { background: rgba(90,160,255,.30); }
.dshqp-menu-item[data-current="1"]::before {
  border-color: #7fb3ff;
  box-shadow: inset 0 0 0 3px #7fb3ff;
}

/* ══════════ 优化状态徽标（★ 2026-10-09）══════════
   ⚠ 尺寸刻意克制：用户两次反馈状态行文字过长会把"推理流光条"挤到第二排，
     所以徽标只放 4~6 个字，详细原因走点击弹出的面板。 */
/* 徽标所在的座位需要定位上下文 —— 否则下面那个绝对定位的详情面板会
   相对更外层（甚至整个页面）定位，弹到莫名其妙的位置去。 */
#qwen-paint-status { position: relative; }
.qwen-paint-opt {
  font-size: 10.5px; line-height: 1; padding: 2px 6px; border-radius: 999px;
  border: 1px solid transparent; cursor: default; flex: none;
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
/* ✓ 已启用：低调（默认状态，不该抢注意力） */
.qwen-paint-opt-on {
  color: #6fcf97; border-color: rgba(111,207,151,.32); background: rgba(111,207,151,.10);
}
/* ⚠ 未启用 / 部分启用：橙色 + 可点击看原因 */
.qwen-paint-opt-warn {
  color: #f5b759; border-color: rgba(245,183,89,.38); background: rgba(245,183,89,.12);
  cursor: pointer; text-decoration: underline dotted rgba(245,183,89,.6);
}
.qwen-paint-opt-warn:hover { background: rgba(245,183,89,.22); }
/* ⏸ 插件已停用：灰 */
.qwen-paint-opt-off {
  color: #9aa0a6; border-color: rgba(154,160,166,.32); background: rgba(154,160,166,.10);
  cursor: pointer;
}
/* 未知：中性 */
.qwen-paint-opt-unknown {
  color: #9aa0a6; border-color: rgba(154,160,166,.26);
}
/* ★ 2026-10-09：ComfyUI 未启动 = **正常状态**（不是故障），用中性外观。
   刻意不用橙色 —— 橙色会让人以为出了问题，可这里其实什么都不用做。 */
.qwen-paint-opt-idle {
  color: #9aa0a6; border-color: rgba(154,160,166,.28); background: rgba(154,160,166,.08);
  cursor: pointer;
}
.qwen-paint-opt-idle:hover { background: rgba(154,160,166,.18); }

/* 优化详情面板（点徽标弹出）。
   ★★★ 2026-10-09 修正：从 absolute 改成 **fixed + 挂 body** —— 跟菜单当初踩的是同一个坑。
     徽标在 composer 里，而 composer 的祖先链上有 overflow 裁剪，
     absolute 面板会被**切掉一半**（用户报的正是"只显示了一半"）。
     挂在 body 上就与祖先裁剪彻底无关，坐标每次打开现算（见 openPanel）。
   ★ 通用性（笔记本 / 台式 / Win / Linux / 任意系统字号都要能用）：
     · 宽高都用 min() 跟着视口收缩，绝不写死像素；
     · 字号 12px 起，不再往下压（小屏 + Linux 字体偏大时不至于糊成一团）；
     · 文字一律允许换行（word-break + overflow-wrap），长英文/长路径不会撑破容器；
     · overscroll-behavior 防止滚到底后把整页带着滚。 */
.qwen-paint-opt-panel {
  position: fixed; top: 0; left: 0; z-index: 2147483000;
  width: min(360px, calc(100vw - 24px));
  max-height: min(62vh, 460px); overflow-y: auto; overscroll-behavior: contain;
  padding: 12px 14px; border-radius: 10px; text-align: left;
  background: #23242a; border: 1px solid rgba(128,128,128,.38);
  box-shadow: 0 8px 26px rgba(0,0,0,.42); color: #e8e8ea;
  font-size: 12px; line-height: 1.6;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel h4 {
  margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #f2f2f4;
}
.qwen-paint-opt-panel .qwen-paint-opt-reason {
  margin: 0 0 7px; padding-left: 15px; position: relative; color: #d6d8dc;
}
.qwen-paint-opt-panel .qwen-paint-opt-reason::before {
  content: "\\2022"; position: absolute; left: 4px; opacity: .6;
}
/* ★ 2026-10-11：关键能力缺口（如缺 UnetLoaderGGUF 节点）。
   与 reasons 分开 —— reasons 只在"没全部启用"时出现，这个**任何时候都要提醒**。 */
.qwen-paint-opt-panel .qwen-paint-opt-warning {
  margin: 0 0 7px; padding: 4px 7px; border-radius: 6px;
  background: rgba(230,160,60,.16); color: #e8b96a;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel .qwen-paint-opt-row {
  display: flex; align-items: baseline; gap: 6px; margin: 3px 0;
}
.qwen-paint-opt-panel .qwen-paint-opt-yes { color: #6fcf97; flex: none; }
.qwen-paint-opt-panel .qwen-paint-opt-no { color: #f0918a; flex: none; }
.qwen-paint-opt-panel .qwen-paint-opt-name { flex: 1; }
/* ★★★ 2026-10-09 四态渲染新增样式 ──────────────────────────────────
   状态词与标记用**同一套颜色**，四行竖排时一眼能比出分布。
   · 已启用  绿 → 无需动作
   · 可启用  黄 → 有动作可做（装节点 / 改配置）
   · 不可启用 红 → 当前做什么都没用，先解决上游
   · 未确认  灰 → 探测没成功，重试即可
   颜色之外还各有**不同的字形**（✓ / ✕ / ?），
   色觉障碍用户也能区分 —— 不能只靠颜色传达状态。 */
.qwen-paint-opt-panel .qwen-paint-opt-can { color: #f5b759; flex: none; }
.qwen-paint-opt-panel .qwen-paint-opt-unk { color: #9aa0a6; flex: none; }
/* ★ 2026-10-09 二次修正新增「让位（按尺寸）」蓝 ——
   host 的 superseded 态：与 BlockCache 争抢同一组 wrapper，按出图尺寸让位，
   **不是故障也不用修**。没有这一档时它会兜底成 unknown（? 未确认），
   而 blockCacheEnabled 默认改为 true 后，TE-Speed / Speedup 默认就是这个态
   ⇒ 缺档等于把"已知且正常"显示成"未确认"，是假报告。
   ⚠ 这段 CSS 在 JS 模板字符串里，注释内**禁止出现反引号**（会提前闭合模板串）。 */
.qwen-paint-opt-panel .qwen-paint-opt-sup { color: #7aa7f0; flex: none; }
.qwen-paint-opt-panel .qwen-paint-opt-mark {
  width: 12px; text-align: center; font-weight: 700;
}
.qwen-paint-opt-panel .qwen-paint-opt-tag {
  flex: none; font-size: 10.5px; padding: 1px 5px; border-radius: 4px;
  border: 1px solid currentColor; opacity: .92;
}
.qwen-paint-opt-panel .qwen-paint-opt-tally {
  margin: 2px 0 8px; padding: 4px 7px; border-radius: 6px;
  background: rgba(128,128,128,.14); font-size: 11px; color: #cfd2d6;
}
/* ★ 2026-10-11：按显卡过滤掉不适用优化时的提示（藏了哪几项、按哪张卡判定的） */
.qwen-paint-opt-panel .qwen-paint-opt-filtered {
  margin: 2px 0 8px; padding: 4px 7px; border-radius: 6px;
  background: rgba(128,128,128,.10); font-size: 11px; color: #a8adb4;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel .qwen-paint-opt-rows { margin-top: 2px; }
/* "该做什么" 缩进在名称之下，与名称左对齐（28px = 标记宽 + 两处 gap） */
.qwen-paint-opt-panel .qwen-paint-opt-action {
  margin: 0 0 6px 28px; font-size: 11px; color: #a8adb4;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel .qwen-paint-opt-row-on .qwen-paint-opt-name { color: #e8e8ea; }
.qwen-paint-opt-panel .qwen-paint-opt-row-available .qwen-paint-opt-name,
.qwen-paint-opt-panel .qwen-paint-opt-row-off .qwen-paint-opt-name { color: #f2d8a8; }
.qwen-paint-opt-panel .qwen-paint-opt-row-blocked .qwen-paint-opt-name { color: #c9cdd2; }
/* ★ 2026-10-09 二次修正：补 superseded / unknown 两档的名称色 ——
   原先只覆盖 on/available/off/blocked，新状态会落到默认色，与同行的蓝色状态词不一致。 */
.qwen-paint-opt-panel .qwen-paint-opt-row-superseded .qwen-paint-opt-name { color: #a9c6f5; }
.qwen-paint-opt-panel .qwen-paint-opt-row-unknown .qwen-paint-opt-name { color: #c9cdd2; }
/* ★★★ 2026-10-09 新增：**逐项开关**（需求方要求「BlockCache T8 没提供开关」）。
   与上面"动作提示"同缩进（28px），视觉上属于同一个条目的附属信息。
   开关本体用标准 role=switch 造型：胶囊 + 滑块，开=绿、关=灰。 */
.qwen-paint-opt-panel .qwen-paint-opt-toggle {
  margin: 0 0 8px 28px; display: flex; align-items: center;
  gap: 7px; flex-wrap: wrap;
}
.qwen-paint-opt-panel .qwen-paint-opt-switch {
  position: relative; flex: none;
  width: 32px; height: 17px; padding: 0; border-radius: 9px;
  border: 1px solid rgba(128,128,128,.5);
  background: rgba(128,128,128,.3);
  cursor: pointer; transition: background .18s, border-color .18s;
  /* 去掉浏览器默认外观，否则各平台长得完全不一样 */
  -webkit-appearance: none; appearance: none;
}
.qwen-paint-opt-panel .qwen-paint-opt-switch .qwen-paint-opt-knob {
  position: absolute; top: 1.5px; left: 1.5px;
  width: 12px; height: 12px; border-radius: 50%;
  background: #f2f3f5; box-shadow: 0 1px 3px rgba(0,0,0,.45);
  transition: transform .18s;
}
.qwen-paint-opt-panel .qwen-paint-opt-switch.is-on {
  background: #3f9d63; border-color: #4fb577;
}
.qwen-paint-opt-panel .qwen-paint-opt-switch.is-on .qwen-paint-opt-knob {
  transform: translateX(15px);
}
.qwen-paint-opt-panel .qwen-paint-opt-switch.is-disabled {
  opacity: .42; cursor: not-allowed;
}
.qwen-paint-opt-panel .qwen-paint-opt-switch-text {
  flex: none; font-size: 11px; color: #d6d8dc;
}
/* ★ 2026-10-14（专业卡版）：多选一档位的下拉控件（显存档 / 精度档 / 文本控制档） */
.qwen-paint-opt-panel .qwen-paint-opt-select {
  flex: 0 1 auto; max-width: 100%;
  padding: 3px 8px; border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, .18);
  background: rgba(255, 255, 255, .06);
  color: #e8eaee; font-size: 11.5px; line-height: 1.4;
  cursor: pointer; outline: none;
}
.qwen-paint-opt-panel .qwen-paint-opt-select:hover { border-color: rgba(255, 255, 255, .3); }
.qwen-paint-opt-panel .qwen-paint-opt-select:disabled { opacity: .42; cursor: not-allowed; }
.qwen-paint-opt-panel .qwen-paint-opt-select option { color: #1b1d21; background: #f3f4f6; }
/* ★ 2026-10-14（专业卡版）：档位选择器整栏（与优化明细分开） */
.qwen-paint-opt-panel .qwen-paint-opt-tiers {
  margin-top: 8px; padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, .1);
  display: flex; flex-direction: column; gap: 6px;
}
.qwen-paint-opt-panel .qwen-paint-opt-tiers-title {
  font-size: 11.5px; font-weight: 600; color: #cfd3d9;
}
.qwen-paint-opt-panel .qwen-paint-opt-tiers-note {
  font-size: 10.5px; line-height: 1.45; color: #a8adb4;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel .qwen-paint-opt-tiers-label {
  flex: 0 1 auto; font-size: 11.5px; color: #d6d8dc; margin-right: 8px;
}
.qwen-paint-opt-panel .qwen-paint-opt-toggle-hint {
  flex-basis: 100%; font-size: 10.5px; color: #a8adb4; line-height: 1.45;
  word-break: break-word; overflow-wrap: anywhere;
}
/* "即时生效 / 永久保存怎么做" —— 必须显眼一点，否则用户会以为改了就一劳永逸 */
.qwen-paint-opt-panel .qwen-paint-opt-toggle-persist {
  flex-basis: 100%; margin-top: 1px; font-size: 10.5px; line-height: 1.45;
  color: #f2d8a8; opacity: .9;
  word-break: break-word; overflow-wrap: anywhere;
}
/* ★ 一句轻量提示（点了「优化」但数据没到时的兜底）。与详情面板同色系，但更薄更小。 */
.qwen-paint-opt-notice {
  position: fixed; top: 0; left: 0; z-index: 2147483000;
  max-width: min(280px, calc(100vw - 24px));
  padding: 6px 10px; border-radius: 8px;
  background: #23242a; border: 1px solid rgba(128,128,128,.38);
  box-shadow: 0 6px 20px rgba(0,0,0,.4); color: #d6d8dc;
  font-size: 11px; line-height: 1.5;
  word-break: break-word; overflow-wrap: anywhere;
}
.qwen-paint-opt-panel .qwen-paint-opt-hint {
  margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(128,128,128,.26);
  opacity: .72; font-size: 10.5px;
}
/* ★★ 出图时**不再**换成"迷你流光灯" —— 用户 2026-10-08 要求改回**小黄点**，
   好和 README 里那张颜色表（🟡 黄 = 正在出图）对上。
   原来的 .dshqp-dot.dshqp-dot-lamp 规则、它用的 dshqp-flow-color 关键帧，
   以及 dshqp-sweep 的引用都已一并清掉 —— 那三样只有它俩互相引用，删干净不留死代码。
   现在出图就是 .dshqp-dot[data-state="busy"] 那条黄底 + 光晕，和在线/未启动同尺寸。 */
/* ★★★ 出图动画（2026-10-08 全面重做，需求方指定）：
   ① 比例改成 **9:16**（手机壁纸）
   ② **跟随系统主题**：浅色系统 = 黑金属；深色系统 = 银白金属
   ③ 金属质感：多段斜向渐变 + 一道高光从左上扫到右下
   ④ 中心爆发马卡龙流星（canvas 层，见 makeFlowNode）
   位置仍是"我那条回复的下方"，随消息流滚动。
   ⚠ flex: none 必须保留 —— 消息列表是 flex 纵向容器，不加它这块会撑满剩余空间、
     把上面的消息全部挤出视口（踩过两次，界面看起来像"全空了"）。
   ⚠ 高度用 min(480px, 62vh)：竖屏比例在高窗口里也不至于顶掉半边界面。
   ⚠⚠ 本段注释里**绝对不许出现反引号** —— CARD_CSS 是 JS 模板字符串，
      反引号会把它提前截断（这个坑 MEMO 里记过两次，我这次又踩了第三次）。 */
.dshqp-flow {
  flex: none;
  position: relative; z-index: 1;
  /* ★ 用户 2026-10-08：小一些（320 高）、靠左。
     ⚠ 高度用**固定 320px**，不用 vh ——
       用户反馈「第一次稍微大一些播完马上又跳到小的去」：
       min(320px, 44vh) 那种写法里的 vh 会随**视口高度**变化（composer 展开、布局稳定后都会变），
       于是块在插入后**尺寸跳变**。固定像素值就完全不会跳。
     ⚠ align-self: flex-start 是**必须的** —— 消息列表是纵向 flex 容器，
       交叉轴默认 stretch 会把这块**横向拉满**，aspect-ratio 9/16 就失效了
       （用户截图里它变成横的，就是这个原因）。 */
  align-self: flex-start;
  height: 320px; aspect-ratio: 9 / 16;
  width: auto; max-width: 100%; margin: 10px 0 14px;
  border-radius: 16px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  /* ★★ 深色主题（默认）= 黑金属。
     用户 2026-10-08 第二次确认：「我现在是黑色主题**应该用黑色金属**」。 */
  background: linear-gradient(135deg,
    #16171b 0%, #33363f 18%, #4a4e59 34%, #1b1d22 52%,
    #2c2f37 68%, #0e0f12 84%, #23252b 100%);
  transition: opacity .42s ease, transform .42s ease;
  /* ★ 用户 2026-10-08：整块"呼吸"——缓慢放大缩小（幅度 2.2%、周期 4 秒）。
     transform 不改变布局，所以不会挤到消息、也不影响滚动位置。 */
  animation: dshqp-flow-breathe 4s ease-in-out infinite;
}
@keyframes dshqp-flow-breathe {
  0%, 100% { transform: scale(1); }
  50%      { transform: scale(1.022); }
}
/* ★ 出图结束：淡出 + 轻微缩小，把位置让给正文里的图片。
   ⚠ 必须 animation: none —— 否则上面"呼吸"里的 transform 会盖住这里的 scale(.97)，
     淡出看起来就"没有缩放"。（属性选择器的权重不如 animation 内的 transform，踩过。） */
.dshqp-flow[data-done="1"] {
  animation: none;
  opacity: 0;
  transform: scale(.97);
}
/* ★★ 浅色主题 = 银白金属（与上面正好相反）。
   主题由 JS 读**实际背景色的亮度**判定后写成 data-dshqp-theme（见 detectDarkTheme），
   CSS 只认这个属性 —— DSH 有自己的主题开关、不跟随系统，所以不能用 prefers-color-scheme。
   ⚠⚠ 本段注释里绝对不许出现反引号（CARD_CSS 是 JS 模板字符串，会被提前截断 —— 已踩四次）。 */
.dshqp-flow[data-dshqp-theme="light"] {
  background: linear-gradient(135deg,
    #f2f3f7 0%, #c9ccd6 18%, #ffffff 34%, #b9bdc9 52%,
    #eef0f5 68%, #a8acb8 84%, #d8dbe3 100%);
}
/* 高光带：从左上扫到右下
   ★ 用户 2026-10-08：「流光再柔和一些」——
     峰值透明度 .90 → .38，过渡从 ±12% 拉宽到 ±20%，周期 2.4s → 3.4s。 */
.dshqp-flow::after {
  content: ""; position: absolute; inset: -60%;
  background: linear-gradient(115deg,
    transparent 30%,
    rgba(255, 255, 255, .06) 42%,
    rgba(255, 255, 255, .38) 50%,
    rgba(255, 255, 255, .06) 58%,
    transparent 70%);
  animation: dshqp-sweep 3.4s linear infinite;
}
/* ★★ 流光方案（带 data-dshqp-grad）**不再叠这道白光扫过** ——
   用户 2026-10-08 要的是"只做流光"，两层光效叠一起就花了。流星方案照旧保留。 */
.dshqp-flow[data-dshqp-grad]::after { display: none; }
/* 流星画布：铺满整块，叠在金属底色之上、文字之下 */
.dshqp-flow-canvas {
  position: absolute; inset: 0; width: 100%; height: 100%;
  z-index: 1; pointer-events: none;
}
/* 文字：银白金属底 → 深字；黑金属底 → 浅字（用媒体查询切）
   ★ 用户 2026-10-08 指定：文案改「感知世界中」、**加粗**，
     并且**放到流星和流光图层之下**（z-index 从 2 降到 0）——
     canvas 是 z-index:1、高光伪元素排在最后，所以文字会在两者之下。 */
.dshqp-flow-tip {
  position: relative; z-index: 0; font-size: 15px; letter-spacing: .1em;
  font-weight: 700;
  /* ★ 默认 = 深色主题（黑金属底）→ 用**浅色字** */
  color: #e8eaf0; text-shadow: 0 1px 6px rgba(0, 0, 0, .65);
}
/* ★ 浅色主题（银白金属底）→ 用**深色字**，与上面正好相反。
   主题由 data-dshqp-theme 驱动，不再用 prefers-color-scheme。 */
.dshqp-flow[data-dshqp-theme="light"] .dshqp-flow-tip {
  color: #2a2d34;
  text-shadow: 0 1px 2px rgba(255, 255, 255, .55);
}
/* （dshqp-flow-color 关键帧已删 —— 它只被状态点的"迷你流光灯"用，
   那个灯在 2026-10-08 按需求方要求改回小黄点了，所以它成了死代码。） */
/* 出图期间把"思考中"的块收起来 —— 需求方要求这时候用户要看的是图，不是分析。
   ⚠ 标记用的是**文案匹配**（见 markReasoningBlocks），不是哈希类名：类名随构建变，
   界面上那句「深度求索中」不会。平时不动它，只有 body 带出图标记时才隐藏。 */
body[data-dshqp-drawing] [data-dshqp-reasoning] { display: none !important; }
/* ★ 压缩 composer 卡片内部的多余留白（用户反馈"输入框和下方选项中间空白太大"）。
   经查内核样式，可安全压缩的是纯间距：卡片 padding-top 8px + 卡片内 gap 12px。
   输入框自身的 min-height 只是**下限**，设为 0 不影响它随内容自动增高。
   ⚠ 这是**覆盖内核样式**：DSH 升级后若属性名变了，这几条会**静默失效**
   （不报错、也不会弄坏界面，只是留白回来）。要撤销就把本段整块删掉。
   [data-composer-card] 是内核声明的稳定属性（见 MEMO），不依赖 CSS Modules 哈希类名。
   ⚠ 本段注释里**不许出现反引号**：CARD_CSS 是 JS 模板字符串，反引号会提前把它截断。
   （2026-10-07 同类问题踩过两次：glow.css 那次被 build.mjs 拦住，这次被自测拦住。） */
[data-composer-card] { padding-top: 6px !important; gap: 8px !important; }
[data-composer-card] textarea { min-height: 0 !important; }
/* ★★ 输入区的真实元素是 Lexical 的 contenteditable div（**不是 textarea**），
   所以上面那条 textarea 规则其实打空了 —— 2026-10-07 查源码确认：
   composer 的输入宿主绑定一个 shell 自有的 Lexical 编辑器，根元素带稳定属性
   data-lexical-editor="true"。用它精确命中；外层容器类名是哈希的（随版本变），
   只能用"含有编辑器"这个关系去够，并把上下内边距一起压掉。
   工具行是卡片的最后一个子级，它的上内边距也顺手压到 2px。 */
[data-composer-card] [data-lexical-editor="true"] {
  min-height: 0 !important;
  padding-top: 4px !important;
  padding-bottom: 4px !important;
}
[data-composer-card] *:has(> [data-lexical-editor="true"]) {
  min-height: 0 !important;
  padding-top: 2px !important;
  padding-bottom: 2px !important;
}
[data-composer-card] > *:last-child { padding-top: 4px !important; }
/* ★ 输入区的滚动条：内核默认给它一条细滑块（还专门定制了轨道间距）。
   我把内边距压掉之后内容刚好溢出，那条滑块就冒出来了（用户反馈"右边多出来的滑动条"）。
   这里把它隐藏 —— 滚轮与键盘滚动照常，只是不再画那条滑块。
   定位用 class 含 _scroll：CSS Modules 的名字部分是稳定的，前缀哈希才会随版本变。 */
[data-composer-card] [class*="_scroll"] { scrollbar-width: none; }
[data-composer-card] [class*="_scroll"]::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}
/* ★ 空会话（hero）：内核默认把内容垂直居中（height:100% + justify-content:center），
   所以上下各留一大片。这里改成靠上、顶部留一小段空。
   定位刻意选得**窄**：class 含 _root，且**直接子元素**是 class 含 _stack 的容器、
   该容器里再含 composer 卡片。正常对话的容器不是这个结构（它的 root 下是 header /
   消息区 / composer 并列），所以匹配不到 —— 避免弄坏已经满意的正常布局。
   ⚠ 同样属于覆盖内核样式：类名是哈希的，DSH 升级后可能静默失效（不会弄坏界面）。
   ⚠ 本段注释不许出现反引号（CARD_CSS 是 JS 模板字符串，反引号会截断它）。 */
[class*="_root"]:has(> [class*="_stack"] [data-composer-card]) {
  justify-content: flex-start !important;
  padding-top: min(10vh, 96px) !important;
}

/* ★★ 2026-11-10（UI 现代化第二轮）：统一色彩系统 + 8px 呼吸间距。
   文字统一灰白 #E5E7EB；标签柔和灰 #9CA3AF；当前值纯白；刻度/参数降为 #6B7280。
   控件之间用 8px 透明间距（gap / margin），不靠描边或分割线堆密度。
   ⚠ 本段注释里不许出现反引号（CARD_CSS 是 JS 模板字符串）。 */
.qwen-paint-opt-panel { color: #E5E7EB; }
.qwen-paint-opt-panel .qwen-paint-opt-tiers { display: flex; flex-direction: column; gap: 8px; }
.qwen-paint-opt-panel .qwen-paint-opt-toggle { row-gap: 8px; }
.qwen-paint-opt-panel .qwen-paint-opt-tiers-label,
.qwen-paint-opt-panel .qwen-paint-opt-opt-name { color: #9CA3AF; }
.qwen-paint-opt-panel .qwen-paint-opt-row {
  border-radius: 8px; padding: 6px 8px; margin-bottom: 8px;
  background: rgba(255,255,255,.035);
}
.qwen-paint-opt-panel .qwen-paint-opt-select {
  border-radius: 8px; color: #FFFFFF;
}
.qwen-paint-opt-panel .qwen-paint-opt-toggle-hint,
.qwen-paint-opt-panel .qwen-paint-opt-tiers-note { color: #6B7280; }
.qwen-paint-opt-select-meta {
  flex: 1 1 auto; min-width: 0; text-align: right;
  font-size: 10px; line-height: 1.4; color: #6B7280;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qwen-paint-opt-select-meta:empty { display: none; }
`.trim()
      }


      /** 只走 console.warn，且它自己也不许抛错。 */
      function warn(message) {
        try {
          console.warn(`[qwen-paint] ${message}`)
        } catch (err) {
          /* 连 console 都没有就彻底安静 */
        }
      }

      /** 把结果块里的文本拼起来（失败时用来显示原因）。 */
      function textOf(block) {
        const parts = []
        const content = block && block.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
          }
        }
        return parts.join('\n').trim()
      }

      /**
       * 取图片绝对路径：优先用 host 侧 presentationMeta 落下的 `meta.path`
       * （最可靠，不依赖文案），退而解析结果文本里的「已出图：<path>」。
       */
      function imagePathOf(block) {
        const meta = block && block.meta
        if (meta && typeof meta.path === 'string' && meta.path.trim() !== '') return meta.path.trim()
        const text = textOf(block)
        const match = /已出图[：:]\s*([^\n（(]+)/u.exec(text)
        return match ? match[1].trim() : null
      }

      /**
       * ★★★ 2026-10-19（用户要求）：**把一次出的多张都取出来**。
       * 优先用 host 经 presentationMeta 传来的 `files`（完整且可靠）；
       * 拿不到就退回单张（老版本后端只有 path）—— 绝不因为字段缺失就不显示图。
       */
      function imagePathsOf(block) {
        const meta = block && block.meta
        const list = meta && Array.isArray(meta.files) ? meta.files.filter((p) => typeof p === 'string' && p !== '') : []
        if (list.length > 0) return list
        const one = imagePathOf(block)
        return one === null ? [] : [one]
      }

      /** ★ 渲染兜底：卡片里任何异常都不许冒出去 —— 冒出去会崩掉 dsh 的那块界面。 */
      function DrawImageCard(props) {
        try {
          return renderCard(props)
        } catch (error) {
          return React.createElement(
            'div',
            { className: 'dshqp-error' },
            `绘图卡片渲染出错：${error && error.message ? error.message : String(error)}`,
          )
        }
      }

      /** 画图卡片：有结果就渲染图，出错显示原文，运行中显示提示。 */
      function renderCard(props) {
        const phase = props && props.phase
        const block = props && props.block

        // ★ 不把 `phase` 当唯一开关：自带 toolview（如 WebRow）压根不看 phase，
        //   只吃 `block`。所以这里只要拿到 block 且能解析出图片路径就直接渲染图，
        //   万一 phase 的取值/传递方式与预期不同，图也不会被"正在画图"遮住。
        if (block !== undefined && block !== null) {
          if (block.isError) {
            const detail = textOf(block) || '未知错误'
// 设计说明已外置 → docs/client-design-notes.md#client-note-031（原 L1709-1715）
            if (phase === 'result') flowFinish()
            return React.createElement('div', { className: 'dshqp-error' }, `画图失败：${detail}`)
          }
          const paths = imagePathsOf(block)
          const filePath = paths.length > 0 ? paths[0] : null
          // ★ 2026-10-19（用户要求）：开了「用户自选」且确实有多张 → 并排全部显示，
          //   让用户自己比较哪张最好（每张都可点开圈选/放大）。
          if (uiUserPickBest === 'on' && paths.length > 1) {
            if (phase === 'result') flowFinish()
            return React.createElement(
              'div',
              { className: 'dshqp-card' },
              React.createElement(
                'div',
                { className: 'dshqp-grid' },
                ...paths.map((p, i) => React.createElement(
                  'div',
                  { className: 'dshqp-cell', key: `${p}-${i}` },
                  React.createElement('img', {
                    className: 'dshqp-img',
                    src: `api/file?path=${encodeURIComponent(p)}`,
                    alt: `第 ${i + 1} 张`,
                    loading: 'lazy',
                    title: '点一下可以圈选局部重绘',
                    style: { cursor: 'zoom-in' },
                    onClick: () => openInpaintDialog(p),
                  }),
                  React.createElement('div', { className: 'dshqp-idx' }, `${i + 1}`),
                  imageActionBar(p),
                )),
              ),
              React.createElement('div', { className: 'dshqp-name' }, `共 ${paths.length} 张 · 点图或下面的按钮即可圈选重绘 / 更多编辑`),
            )
          }
          if (filePath !== null) {
// 设计说明已外置 → docs/client-design-notes.md#client-note-032（原 L1751-1756）
            if (phase === 'result') flowFinish()
            const name = filePath.split(/[\\/]/u).pop() || filePath
            return React.createElement(
              'div',
              { className: 'dshqp-card' },
              React.createElement('img', {
                className: 'dshqp-img',
                // 相对 baseURI 解析 → 桌面端 dsh-ap<本地路径>?...，Web 端 http://…/api/file?...
                src: `api/file?path=${encodeURIComponent(filePath)}`,
                alt: name,
                loading: 'lazy',
                // ★ 2026-10-19（用户要求）：点图 → 独立浮层里圈选局部重绘。
                //   浮层是**自己的 DOM**，不碰消息树（见 openInpaintDialog 顶部的说明）。
                title: '点一下可以圈选局部重绘',
                style: { cursor: 'zoom-in' },
                onClick: () => openInpaintDialog(filePath),
              }),
              imageActionBar(filePath),
              React.createElement('div', { className: 'dshqp-name' }, name),
            )
          }
          // 有 block 但没路径：结果阶段就把文本显示出来，别让这条调用变成空白
          const fallback = textOf(block)
          if (phase === 'result' || fallback !== '') {
            return fallback === ''
              ? null
              : React.createElement('div', { className: 'dshqp-pending' }, fallback)
          }
        }

        // preparing / start：出图要一两分钟，这段时间必须让用户看见「在动」
        // ★ 同时在**聊天流里**放一个 16:9 的大呼吸灯（需求方指定：位置就像我发图片出来那样）
        flowStart()
        // ★ 生成中的 RGB 呼吸灯（需求方指定）：正方形色块呼吸 + 白色流光从左上扫到右下 + 小字
        return React.createElement(
          'div',
          { className: 'dshqp-loading' },
          React.createElement('div', { className: 'dshqp-lamp' }),
          React.createElement('div', { className: 'dshqp-loading-text' }, '正在生成图片'),
        )
      }

      /* ------------------------------------------- composer 下方的在线状态 ---- */

// 设计说明已外置 → docs/client-design-notes.md#client-note-033（原 L1801-1813）
      const OPT_ID = 'qwen-paint-opt'

// 设计说明已外置 → docs/client-design-notes.md#client-note-034（原 L1816-1828）
      function describeOptimizationBadge(opt) {
        if (opt === null || typeof opt !== 'object') {
          return { cls: 'qwen-paint-opt-unknown', text: '优化状态未知', detail: null, clickable: false }
        }
        switch (opt.level) {
          case 'disabled':
            return { cls: 'qwen-paint-opt-off', text: '插件已停用', detail: opt, clickable: true }
          case 'full':
            // ★ 改了：可点。文字仍保持低调，不抢注意力。
            return { cls: 'qwen-paint-opt-on', text: '优化已启用', detail: opt, clickable: true }
          case 'turbo':
            return { cls: 'qwen-paint-opt-warn', text: '优化部分启用', detail: opt, clickable: true }
          case 'basic':
            return { cls: 'qwen-paint-opt-warn', text: '未启用优化', detail: opt, clickable: true }
          case 'probe-failed':
            return { cls: 'qwen-paint-opt-warn', text: '优化未确认', detail: opt, clickable: true }
          case 'idle':
            // ComfyUI 没启动 = 正常状态：中性外观 + 可点开说明"待会儿自动就绪"
            return { cls: 'qwen-paint-opt-idle', text: '待启动检测', detail: opt, clickable: true }
          default:
            return { cls: 'qwen-paint-opt-unknown', text: '优化状态未知', detail: opt, clickable: true }
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-035（原 L1853-1857）
      const OPT_STATE_VIEW = {
        on: { mark: '\u2713', cls: 'qwen-paint-opt-yes', label: '已启用' },
        available: { mark: '\u2713', cls: 'qwen-paint-opt-can', label: '可启用' },
        off: { mark: '\u2713', cls: 'qwen-paint-opt-can', label: '可启用' },
        blocked: { mark: '\u2715', cls: 'qwen-paint-opt-no', label: '不可启用' },
        unknown: { mark: '?', cls: 'qwen-paint-opt-unk', label: '未确认' },
        // ★ 2026-10-09 二次修正新增：host 的 `superseded`（按尺寸让位）。
        //   它既不是"可启用"（没什么可开的），也不是"不可启用"（小尺寸它真的在生效），
        //   更不是"未确认"（我们完全清楚它在干什么）——必须自成一档。
        //   ⇄ 与 ✓/✕/? 都不同，保证色觉障碍用户也能区分。
        superseded: { mark: '\u21C4', cls: 'qwen-paint-opt-sup', label: '让位（按尺寸）' },
      }

      /** 取某一项该显示的状态视图；state 缺失时按老的 on 布尔兜底。 */
      function optStateView(item) {
        const key = typeof item?.state === 'string'
          ? item.state
          : (item?.on ? 'on' : 'available')
        return OPT_STATE_VIEW[key] ?? OPT_STATE_VIEW.unknown
      }

      /** 记住第一条能用的状态端点，之后不再每条都试。 */
      let statusPath = null

      /** 取 host 的 ComfyUI 状态。失败返回 null（显示"未知"而不是崩）。 */
      async function fetchStatus() {
        const candidates = statusPath === null ? STATUS_PATHS : [statusPath]
        for (const candidate of candidates) {
          try {
            const response = await fetch(candidate, { headers: { accept: 'application/json' } })
            if (!response.ok) continue
            const data = await response.json()
            statusPath = candidate
            return data
          } catch (error) {
            /* 换下一条候选路径 */
          }
        }
        return null
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-036（原 L1899-1918）
      function describeStatus(data, fails) {
        if (data === null || typeof data !== 'object') {
          return fails >= 3
            ? { state: 'off', label: '插件后端未就绪' }
            : { state: 'off', label: '检测中…' }
        }
// 设计说明已外置 → docs/client-design-notes.md#client-note-037（原 L1925-1928）
        if (data.online !== true && data.launchFailed === true) {
// 设计说明已外置 → docs/client-design-notes.md#client-note-038（原 L1930-1934）
          const isTimeout = data.launchTimedOut === true
          return {
            state: 'off',
            label: isTimeout ? 'ComfyUI 启动超时' : 'ComfyUI 启动失败',
            // 具体原因走 title 提示（状态行本身必须短，见上面的宽度约束）
            error: typeof data.launchError === 'string' ? data.launchError : '',
          }
        }
        if (data.online !== true && data.starting === true) {
          // 带上已等秒数：让用户看得出"它在动"，而不是卡死了
          const sec = Math.round((Number(data.launchElapsedMs) || 0) / 1000)
          return {
            state: 'busy',
            label: sec >= 1 ? `ComfyUI 启动中 ${sec}s` : 'ComfyUI 启动中…',
            error: '',
          }
        }
        // host 说得清清楚楚：ComfyUI 没起来。
        // 插件有能力按需把它拉起来（出图时自动），所以这里用"未启动"而不是"未知"。
        if (data.online !== true) {
          return { state: 'off', label: 'ComfyUI 未启动', error: '' }
        }
        if (data.busy === true) {
          return { state: 'busy', label: 'ComfyUI 出图中' }
        }
        const left = typeof data.idleShutdownInMs === 'number' ? data.idleShutdownInMs : 0
        if (left > 0) {
          return { state: 'on', label: `ComfyUI 空闲${Math.max(1, Math.ceil(left / 60000))}分` }
        }
        // idleShutdownMs <= 0 = 选了"不自动关闭"，这时只显示在线
        return { state: 'on', label: 'ComfyUI 在线' }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-039（原 L1968-1978）
      function placePanel(panel, el) {
        try {
          if (typeof el.getBoundingClientRect !== 'function') return
          const rect = el.getBoundingClientRect()
          const viewport = Number(window.innerHeight) || 0
          const viewportW = Number(window.innerWidth) || 0
          if (viewport <= 0 || viewportW <= 0) return

          const GAP = 8
          const CEIL = Math.floor(viewport * 0.62) // 最多占屏幕 62%，避免整屏都是面板
          const need = Math.min(Number(panel.scrollHeight) || 0, CEIL)
          const above = rect.top - GAP
          const below = viewport - rect.bottom - GAP
          const down = above < need && below > above
          const room = Math.max(120, down ? below : above)

          panel.style.maxHeight = `${Math.min(room, CEIL, 460)}px`
          const box = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null
          const shown = Math.min(box && box.height ? box.height : room, room)
          const width = box && box.width ? box.width : Math.min(360, viewportW - 24)

          panel.style.top = down
            ? `${Math.max(GAP, Math.min(viewport - GAP - shown, rect.bottom + 6))}px`
            : `${Math.max(GAP, rect.top - shown - 6)}px`
          panel.style.left = `${Math.max(GAP, Math.min(rect.left, viewportW - width - GAP))}px`
        } catch (error) {
          /* 摆不对也照样能用 —— 位置永远不该成为打不开面板的理由 */
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-040（原 L2009-2017）
      function createOptimizationBadge() {
        const el = document.createElement('span')
        el.className = 'qwen-paint-opt qwen-paint-opt-unknown'
        el.textContent = '优化检测中'

        let panel = null
        let outsideHandler = null
        let panelScroll = 0
        // ★ 只在**内容真的变了**时才碰 DOM。状态每 5 秒轮询一次，
        //   每轮都重设 className/textContent 会让浏览器白白重排重绘。
        let lastCls = null
        let lastText = null
        // ★ 最近一次的优化诊断对象（含 detail/stats）—— 供 openDetail 复用。
        //   不用 openPanel 时的临时变量，因为菜单可能在任意时刻来取。
        let lastDetail = null
        // ★ 2026-10-09 新增：面板里"切换某项优化"成功后，通知外层**立刻拉一次状态**，
        //   而不是干等下一次 5 秒轮询 —— 用户点了开关，界面应该马上给反馈。
        //   外层注册（见 createOptimizationBadge 的调用点）；没注册就退回轮询，不报错。
        let onToggleDone = null
        /** 供外层注入"切换完成后立即刷新"的回调。 */
        const setToggleDoneHandler = (fn) => { onToggleDone = typeof fn === 'function' ? fn : null }

        const closePanel = () => {
          // 记住滚动位置，下次打开还原（长内容时体验差别很大）
          if (panel) {
            try { panelScroll = Number(panel.scrollTop) || 0 } catch (error) { panelScroll = 0 }
          }
          if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
          panel = null
          if (outsideHandler) {
            document.removeEventListener('click', outsideHandler, true)
            outsideHandler = null
          }
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-041（原 L2053-2064）
        let payloadNow = null

        const openPanel = (opt) => {
          closePanel()
          panel = document.createElement('div')
          panel.className = 'qwen-paint-opt-panel'

          const h = document.createElement('h4')
          h.textContent = String(opt?.summary ?? '优化状态')
          panel.appendChild(h)

          const reasons = Array.isArray(opt?.reasons) ? opt.reasons : []
          for (const reason of reasons) {
            const p = document.createElement('p')
            p.className = 'qwen-paint-opt-reason'
            p.textContent = String(reason)
            panel.appendChild(p)
          }

// 设计说明已外置 → docs/client-design-notes.md#client-note-042（原 L2084-2087）
          const warnings = Array.isArray(opt?.warnings) ? opt.warnings : []
          for (const w of warnings) {
            const p = document.createElement('p')
            p.className = 'qwen-paint-opt-warning'
            p.textContent = String(w)
            panel.appendChild(p)
          }

// 设计说明已外置 → docs/client-design-notes.md#client-note-043（原 L2096-2106）
          const outDir = typeof payloadNow?.outputDir === 'string' ? payloadNow.outputDir : ''
          if (outDir) {
            const box = document.createElement('div')
            box.className = 'qwen-paint-opt-row'
            box.style.cssText = 'flex-wrap:wrap;row-gap:4px;margin:6px 0 8px'
            const lab = document.createElement('span')
            lab.className = 'qwen-paint-opt-yes'
            lab.style.color = 'var(--color-text-secondary)'
            lab.textContent = '出图存到'
            const val = document.createElement('span')
            val.style.cssText = 'flex:1;min-width:220px;word-break:break-all;color:var(--color-text-primary)'
            val.textContent = `${outDir}（${payloadNow?.outputDirSource ?? ''}）`
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.textContent = '改目录'
            btn.title = '换个位置存图。留空 = 恢复默认（桌面/千问1生图）'
// 设计说明已外置 → docs/client-design-notes.md#client-note-044（原 L2123-2130）
            btn.addEventListener('click', () => {
              if (box.querySelector('.qwen-paint-outdir-edit')) return // 已在编辑态，别叠第二个
              const edit = document.createElement('span')
              edit.className = 'qwen-paint-outdir-edit'
              edit.style.cssText = 'display:flex;flex-basis:100%;gap:6px;align-items:center;flex-wrap:wrap'
              const inp = document.createElement('input')
              inp.type = 'text'
              inp.value = outDir
              inp.style.cssText = 'flex:1;min-width:180px;padding:2px 6px'
              const ok = document.createElement('button')
              ok.type = 'button'
              ok.textContent = '确定'
              const cancel = document.createElement('button')
              cancel.type = 'button'
              cancel.textContent = '取消'
              const hint = document.createElement('span')
              hint.style.cssText = 'flex-basis:100%;font-size:12px;color:var(--color-text-secondary)'
              hint.textContent = '绝对路径如 D:\\我的图\\千问；或只写文件夹名（放到默认位置下）；留空 = 恢复默认'

              const close = () => {
                try { edit.remove() } catch { /* 已被移除 */ }
                btn.disabled = false
              }
              cancel.addEventListener('click', close)

              const submit = async () => {
                ok.disabled = true
                hint.textContent = '正在应用…'
                hint.style.color = 'var(--color-text-secondary)'
                try {
                  const res = await postStatus({ outputDir: inp.value.trim() })
                  const j = await res.json()
                  const got = j.outputDir ?? outDir
                  const bad = String(j.outputDirSource ?? '').includes('不可用')
                  // ★ 回执**写在行内**，不再用 window.alert（会被宿主拦掉）
                  hint.textContent = bad ? `⚠ 这个目录不可用，仍使用：${got}` : `✓ 已改成：${got}`
                  hint.style.color = bad ? 'var(--color-text-warning, #d97706)' : 'var(--color-text-secondary)'
                  const fresh = await fetch(STATUS_PATHS[0], { cache: 'no-store' })
                    .then((r) => r.json()).catch(() => null)
                  if (fresh && fresh.optimization) {
                    payloadNow = fresh
                    // 稍等一下让用户看清回执，再原地刷新面板（不再 hidePanel，免得像"没反应"）
                    window.setTimeout(() => { try { openPanel(fresh.optimization) } catch { /* 忽略 */ } }, 700)
                  }
                  refreshSoon()
                } catch (e) {
                  hint.textContent = `✗ 修改失败：${String(e?.message ?? e)}`
                  hint.style.color = 'var(--color-text-warning, #d97706)'
                } finally {
                  ok.disabled = false
                }
              }
              ok.addEventListener('click', submit)
              inp.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); submit() }
                else if (ev.key === 'Escape') { ev.preventDefault(); close() }
              })

              edit.appendChild(inp)
              edit.appendChild(ok)
              edit.appendChild(cancel)
              edit.appendChild(hint)
              btn.disabled = true
              box.appendChild(edit)
              try { inp.focus(); inp.select() } catch { /* 聚焦失败无所谓 */ }
            })
            box.appendChild(lab)
            box.appendChild(val)
            box.appendChild(btn)
            panel.appendChild(box)
          }

          const detail = Array.isArray(opt?.detail) ? opt.detail : []
          if (detail.length > 0) {
            // ★★★ 2026-10-09：先出一行**总账**（4 项里几项已启用 / 几项能补 / 几项补不了）。
            //   需要的就是"一眼看清分布"，而不是逐个读四行才知道全貌。
            const stats = opt?.stats
            if (stats && Number(stats.total) > 0) {
              const tally = document.createElement('div')
              tally.className = 'qwen-paint-opt-tally'
              const parts = []
              if (stats.on) parts.push(`${stats.on} 项已启用`)
              const fixable = (Number(stats.available) || 0) + (Number(stats.off) || 0)
              if (fixable) parts.push(`${fixable} 项可启用`)
              if (stats.blocked) parts.push(`${stats.blocked} 项当前不可启用`)
              // ★ 2026-10-09 二次修正：`superseded`（按尺寸让位）必须进总账。
              //   否则默认配置下（blockCacheEnabled=true）total=7 而只报"5 项已启用"，
              //   剩下 2 项被无声吞掉 —— 用户会以为坏了 2 项。
              if (stats.superseded) parts.push(`${stats.superseded} 项按尺寸让位`)
// 设计说明已外置 → docs/client-design-notes.md#client-note-045（原 L2220-2223）
              if (stats.optional) {
                const onN = Number(stats.optionalOn) || 0
                parts.push(onN > 0
                  ? `${stats.optional} 项可选（已开 ${onN} 项）`
                  : `${stats.optional} 项可选（默认关）`)
              }
              if (stats.unknown) parts.push(`${stats.unknown} 项未确认`)
              tally.textContent = `共 ${stats.total} 项：${parts.join(' · ')}`
              panel.appendChild(tally)
            }

            // ★★★ 2026-10-11 新增（需求方要求）：「识别是哪个显卡，就把不能用的优化直接隐藏掉」。
            //   藏掉是对的，但**不能静默消失** —— 否则用户会以为"少了一项 = 插件坏了"，
            //   或者压根不知道插件其实认出了他的卡。所以这里如实报：按哪张卡、藏了哪几项。
            const filtered = Array.isArray(opt?.filtered) ? opt.filtered : []
            if (filtered.length > 0) {
              const note = document.createElement('div')
              note.className = 'qwen-paint-opt-filtered'
              const gpuLabel = opt?.gpu?.name ? String(opt.gpu.name) : '当前显卡'
              note.textContent = `已按显卡识别隐藏 ${filtered.length} 项不适用的优化`
                + `（${gpuLabel}）：${filtered.join('、')}`
              panel.appendChild(note)
            }

            const rows = document.createElement('div')
            rows.className = 'qwen-paint-opt-rows'
            for (const item of detail) {
              const view = optStateView(item)

              // 一行 = 状态标记 + 名称 + 状态词。三列固定，
              // 这样四行竖着看下来状态词是对齐的，扫一眼就能比。
              const row = document.createElement('div')
              row.className = `qwen-paint-opt-row qwen-paint-opt-row-${typeof item?.state === 'string' ? item.state : 'unknown'}`

              const mark = document.createElement('span')
              mark.className = `qwen-paint-opt-mark ${view.cls}`
              mark.textContent = view.mark

              const name = document.createElement('span')
              name.className = 'qwen-paint-opt-name'
              name.textContent = String(item?.name ?? '(未命名)')

              const tag = document.createElement('span')
              tag.className = `qwen-paint-opt-tag ${view.cls}`
              tag.textContent = view.label

              row.appendChild(mark)
              row.appendChild(name)
              row.appendChild(tag)
              rows.appendChild(row)

              // ★ "该做什么"单独一行、缩进在名称之下。
              //   这是那条要求「哪些可以启用哪些不能启用」的落点 ——
              //   只说状态不给动作，用户还是不知道下一步；给了动作才是真的能自助修好。
              if (typeof item?.action === 'string' && item.action !== '') {
                const act = document.createElement('div')
                act.className = 'qwen-paint-opt-action'
                act.textContent = `→ ${item.action}`
                rows.appendChild(act)
              }

// 设计说明已外置 → docs/client-design-notes.md#client-note-046（原 L2285-2294）
              const toggle = item?.toggle
              if (toggle && typeof toggle.key === 'string' && toggle.key !== '') {
                const wrap = document.createElement('div')
                wrap.className = 'qwen-paint-opt-toggle'

                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'qwen-paint-opt-switch'
                  + (toggle.on ? ' is-on' : ' is-off')
                  + (toggle.canToggle === true ? '' : ' is-disabled')
                btn.setAttribute('role', 'switch')
                btn.setAttribute('aria-checked', toggle.on ? 'true' : 'false')
                btn.setAttribute('aria-label', `${item?.name ?? '该项'} 开关`)
                // 缺节点时置灰：切了也没用，不如不给点
                if (toggle.canToggle !== true) btn.disabled = true

                const knob = document.createElement('span')
                knob.className = 'qwen-paint-opt-knob'
                btn.appendChild(knob)

                const txt = document.createElement('span')
                txt.className = 'qwen-paint-opt-switch-text'
                txt.textContent = toggle.on ? '已开启' : '已关闭'

                btn.addEventListener('click', async (event) => {
                  // ⚠ 必须 stopPropagation：面板外面有「点空白处关闭」的 capture 监听，
                  //   不拦的话点开关会顺手把整个面板关掉，用户以为"点了就没了"。
                  event.stopPropagation()
                  if (toggle.canToggle !== true) return
                  const next = !toggle.on
                  btn.disabled = true
                  txt.textContent = '切换中…'
                  try {
                    await postStatus({ [toggle.key]: next ? 'on' : 'off' })
                    // 不本地改状态 —— 由 host 的**权威**新状态决定按钮外观。
                    if (typeof onToggleDone === 'function') onToggleDone()
// 设计说明已外置 → docs/client-design-notes.md#client-note-047（原 L2331-2339）
                    const fresh = await fetch('api/qwen-paint/status.json', { cache: 'no-store' })
                      .then((r) => r.json()).catch(() => null)
                    if (fresh && fresh.optimization) {
                      payloadNow = fresh   // 「出图存到」读顶层字段，必须同步更新
                      openPanel(fresh.optimization)
                    } else {
                      closePanel()   // 拉不到就退回老行为，至少不留一个过期面板
                    }
                  } catch (error) {
                    txt.textContent = '切换失败'
                    btn.disabled = false
                  }
                })

                wrap.appendChild(btn)
                wrap.appendChild(txt)

                // 鼠标悬停看详细说明（长文案不进正文，避免把面板撑得很长）
                if (typeof toggle.hint === 'string' && toggle.hint !== '') {
                  wrap.title = toggle.hint
                  const hint = document.createElement('div')
                  hint.className = 'qwen-paint-opt-toggle-hint'
                  hint.textContent = toggle.hint
                  wrap.appendChild(hint)
                }

                // ★ 如实告知"这是运行时开关、重启会还原"—— 并给出永久保存的做法。
                //   宁可多说一句，也不让用户以为改了就一劳永逸。
                if (toggle.canToggle === true) {
                  const persist = document.createElement('div')
                  persist.className = 'qwen-paint-opt-toggle-persist'
                  // ★ 2026-10-12：配置键**从 toggle 里取**，不再写死 blockCacheEnabled
                  //   （原先写死，加第二个开关时会给出错误的"怎么永久保存"指引）。
                  const persistKey = typeof toggle.persistKey === 'string' && toggle.persistKey !== ''
                    ? toggle.persistKey : 'blockCacheEnabled'
                  persist.textContent = '即时生效；要永久保存：在这台机器的 cordis.patch.yml 里'
                    + `把 ${persistKey} 写成 ${toggle.on ? 'true' : 'false'}，重启 DSH 后依然保留。`
                  wrap.appendChild(persist)
                }

                rows.appendChild(wrap)
              }
            }
            panel.appendChild(rows)

// 设计说明已外置 → docs/client-design-notes.md#client-note-048（原 L2385-2388）
            const configSections = [
              { title: '档位（性能 / 精度 / 文本控制）', note: opt?.tierNote, items: opt?.tiers },
              { title: '权重（主模型 / LoRA / ControlNet）', note: '', items: opt?.weights },
            ]
            // ★ 2026-10-14（C3）：**动态下拉**的选项来自 `/api/qwen-paint/capabilities`
            //   （状态体有"不含模型名"的底线，所以文件清单走 caps 端点）。
            //   只在真有动态项时才拉，且**整个面板只拉一次**。
            const allConfigItems = configSections.flatMap((s) => (Array.isArray(s.items) ? s.items : []))
            const hasDynamic = allConfigItems.some((t) => t.dynamic === true)
            const cachedWeightCaps = hasDynamic
              ? loadPersistedWeightCaps(safeStorage(), Date.now(), WEIGHT_CAPS_TTL)
              : null
            const fetchWeightCaps = () => fetch('api/qwen-paint/capabilities', { cache: 'no-store' })
              .then((r) => r.json())
              .then((j) => {
                const caps = j?.caps ?? null
                if (caps) savePersistedWeightCaps(safeStorage(), caps, Date.now())
                return caps
              })
              .catch(() => null)
            let capsPromise = Promise.resolve(null)
            if (hasDynamic) {
              if (cachedWeightCaps) {
                // 命中缓存：界面已经同步填好，后台只刷新缓存，不再重写 DOM。
                fetchWeightCaps()
                capsPromise = Promise.resolve(cachedWeightCaps)
              } else {
                capsPromise = fetchWeightCaps()
              }
            }
            /** 动态下拉的填充任务（无缓存时 caps 回来后统一填）。 */
            const dynamicFills = []
            const fillWeightSelect = (caps, t, sel, nowEl, metaEl, fromCache) => {
              const labels = caps?.fileLabels ?? {}
              const infoOf = (f) => labels[f] ?? splitModelLabelLocal(f)
              const { files, over, opts } = weightOptionsOf(caps, t.sourceKey, infoOf)
              sel.textContent = ''
              sel._metaMap = {}
              for (const o of opts) {
                const op = document.createElement('option')
                op.value = String(o.value)
                op.textContent = String(o.label ?? o.value)
                if (o.meta) sel._metaMap[String(o.value)] = String(o.meta)
                sel.appendChild(op)
              }
              sel.value = over
              metaEl.textContent = sel._metaMap[over] ?? ''
              const cacheNote = fromCache ? '（来自本机缓存，后台正在刷新）' : ''
              if (caps === null) {
                nowEl.textContent = '本机清单暂时取不到（稍后会自动重试）；仍可手动指定模型文件名。'
              } else if (over !== '' && files.length > 0 && !files.includes(over)) {
                nowEl.textContent = `⚠ 你选了「${over}」，但它不在 ComfyUI 的清单里 → 本次未采纳（用的是自动挑的那个）。${cacheNote}`
              } else if (files.length === 0) {
                nowEl.textContent = `ComfyUI 的模型目录里没找到对应权重；仍可手动指定。${cacheNote}`
              } else {
                nowEl.textContent = `可选 ${files.length} 个文件${cacheNote}`
              }
            }

            for (const sec of configSections) {
              const list = Array.isArray(sec.items) ? sec.items : []
              if (list.length === 0) continue
              const tsec = document.createElement('div')
              tsec.className = 'qwen-paint-opt-tiers'
              const th = document.createElement('div')
              th.className = 'qwen-paint-opt-tiers-title'
              th.textContent = sec.title
              tsec.appendChild(th)
              if (typeof sec.note === 'string' && sec.note !== '') {
                const tn = document.createElement('div')
                tn.className = 'qwen-paint-opt-tiers-note'
                tn.textContent = sec.note
                tsec.appendChild(tn)
              }
              for (const t of list) {
                const wrap = document.createElement('div')
                wrap.className = 'qwen-paint-opt-toggle'
                const label = document.createElement('div')
                label.className = 'qwen-paint-opt-tiers-label'
                label.textContent = String(t.name ?? t.key ?? '')
                wrap.appendChild(label)

                // 组装选项：静态项用自带的 options；动态项**先占位**，
                // 等 caps 拉回来后异步填充（openPanel 不是 async，不能用 await）。
                let options = Array.isArray(t.options) ? t.options.slice() : []
                let current = t.value
                let nowText = typeof t.now === 'string' ? t.now : ''

                const sel = document.createElement('select')
                sel.className = 'qwen-paint-opt-select'
                sel.setAttribute('aria-label', `${t.name ?? '该项'} 档位`)
                if (t.canToggle !== true) sel.disabled = true
                // ★ 干净展示名 + 右侧灰色参数小字（fileLabels 由 host 下发）
                sel._metaMap = {}
                const metaEl = document.createElement('span')
                metaEl.className = 'qwen-paint-opt-select-meta'
                for (const o of options) {
                  const op = document.createElement('option')
                  op.value = String(o.value)
                  op.textContent = String(o.label ?? o.value)
                  if (o.meta) sel._metaMap[String(o.value)] = String(o.meta)
                  if (String(o.value) === String(current)) op.selected = true
                  sel.appendChild(op)
                }
                metaEl.textContent = sel._metaMap[String(sel.value)] ?? ''
                const nowEl = document.createElement('div')
                nowEl.className = 'qwen-paint-opt-toggle-hint'
                nowEl.textContent = nowText

                if (t.dynamic === true) {
                  if (cachedWeightCaps) {
                    // ★ 命中持久化缓存：同步填好真实选项，刷新页面首屏不再是「载入中」白条。
                    fillWeightSelect(cachedWeightCaps, t, sel, nowEl, metaEl, true)
                  } else {
                    const ph = document.createElement('option')
                    ph.value = ''
                    ph.textContent = '（正在读取本机清单…）'
                    ph.disabled = true
                    sel.appendChild(ph)
                    sel.value = ''
                    dynamicFills.push({ t, sel, nowEl, metaEl })
                  }
                }
                sel.addEventListener('click', (event) => event.stopPropagation())
                sel.addEventListener('change', async (event) => {
                  event.stopPropagation()
                  if (t.canToggle !== true) return
                  metaEl.textContent = sel._metaMap[String(sel.value)] ?? ''
                  sel.disabled = true
                  try {
                    await postStatus({ [t.key]: sel.value })
                    // 不本地猜状态 —— 拉权威状态原地刷新（与开关同一套做法）
                    const fresh = await fetch('api/qwen-paint/status.json', { cache: 'no-store' })
                      .then((r) => r.json()).catch(() => null)
                    if (fresh && fresh.optimization) {
                      payloadNow = fresh
                      openPanel(fresh.optimization)
                    } else {
                      closePanel()
                    }
                  } catch (error) {
                    sel.disabled = false
                  }
                })
                wrap.appendChild(sel)
                wrap.appendChild(metaEl)

                if (nowText !== '') nowEl.textContent = nowText
                wrap.appendChild(nowEl)
                if (typeof t.hint === 'string' && t.hint !== '') wrap.title = t.hint
                tsec.appendChild(wrap)
              }
              panel.appendChild(tsec)
            }

            // ★ 2026-10-14（C3）：caps 回来后填充动态下拉（选项 = 真实文件；当前值 = 覆写值）。
            if (dynamicFills.length > 0) {
              capsPromise.then((caps) => {
                for (const { t, sel, nowEl, metaEl } of dynamicFills) {
                  fillWeightSelect(caps, t, sel, nowEl, metaEl, false)
                }
              })
            }
          }

          const hint = document.createElement('div')
          hint.className = 'qwen-paint-opt-hint'
          // ★ 2026-10-09：措辞跟着状态走。全绿时提示"还能装什么"，
          //   有缺口时提示"想细查就走工具" —— 别让全绿的用户收到一条故障向的提示。
          const statsForHint = opt?.stats
          hint.textContent = (opt?.ok === true && statsForHint && statsForHint.on === statsForHint.total)
            ? '四项优化全部生效。想进一步压时间可考虑「厂商专用加速包」，'
              + '可在对话里让助手调用 check_acceleration 工具查看。'
            : '想了解完整细节，可在对话里让助手调用 check_acceleration 工具。'
          panel.appendChild(hint)

          // ★★★ 2026-10-09 修正：**挂到 body**（不再挂座位）。
          //   原来挂在座位里，面板会被 composer 祖先的 overflow 裁掉一半 ——
          //   用户报的"只显示了一半"就是这个。挂 body 后与祖先裁剪彻底无关。
          //   ⚠ 必须先挂进 DOM 再量尺寸，否则 getBoundingClientRect 全零、定位会算错。
          const host = document.body ?? document.documentElement
          host.appendChild(panel)
          placePanel(panel, el)

          // 恢复上次的滚动位置：面板内容较长时，每次点开都跳回顶部很烦人
          try { panel.scrollTop = panelScroll } catch (error) { /* 忽略 */ }

          // 点面板外面就关掉（capture 阶段，避免被别的处理器吞掉）
          outsideHandler = (event) => {
            if (panel && !panel.contains(event.target) && event.target !== el) closePanel()
          }
          setTimeout(() => {
            if (outsideHandler) document.addEventListener('click', outsideHandler, true)
          }, 0)
        }

        const update = (opt) => {
          const view = describeOptimizationBadge(opt)
          // ★ 值没变就**直接返回**，一个 DOM 属性都不碰。
          //   状态是 5 秒一次轮询的，若每轮都重设 className/textContent，
          //   浏览器会持续做无谓的样式重算 + 重绘（纯浪费，尤其在笔记本上）。
          if (view.cls === lastCls && view.text === lastText) return
          lastCls = view.cls
          lastText = view.text
          // ★★★ 2026-10-09：把最近一次 detail 存下来 —— 菜单里点「优化」时要复用
          //   （见下方 openDetail）。**不重新算**，避免两处渲染算出不同结果。
          lastDetail = view.detail
          el.className = `qwen-paint-opt ${view.cls}`
          el.textContent = view.text
          // 能不能点，由 host 给的语义字段决定 —— 不再靠样式类名去猜
          const clickable = Boolean(view.detail) && view.clickable === true
          el.style.cursor = clickable ? 'pointer' : 'default'
          if (clickable) {
            el.onclick = (event) => {
              event.stopPropagation()
              if (panel) closePanel()
              else openPanel(view.detail)
            }
          } else {
            el.onclick = null
          }
          el.setAttribute('title', view.detail?.summary ?? view.text)
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-049（原 L2596-2603）
        const openDetail = () => {
          if (!lastDetail) return false
          closePanel()
          openPanel(lastDetail)
          return true
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-050（原 L2611-2616）
        const setNotice = (message) => {
          try {
            const note = document.createElement('div')
            note.className = 'qwen-paint-opt-notice'
            note.textContent = String(message)
            const host = document.body ?? document.documentElement
            host.appendChild(note)
            // 定位到徽标下方（与详情面板同一套定位思路，不依赖祖先 overflow）
            placePanel(note, el)
            setTimeout(() => {
              try { if (note.parentNode) note.parentNode.removeChild(note) } catch (error) { /* 忽略 */ }
            }, 2600)
          } catch (error) {
            /* 提示失败不影响任何功能 —— 绝不让它把点击流程带崩 */
          }
        }

        return {
          el,
          update,
          dispose: closePanel,
          openDetail,
          setNotice,
          setToggleDoneHandler,
// 设计说明已外置 → docs/client-design-notes.md#client-note-051（原 L2641-2644）
          get current() { return lastDetail },
        }
      }


      /**
       * 把状态指示器挂进座位。**纯 DOM** —— 与 dsh-reasoning-glow 同一套路：
       * React 只负责渲染座位，内容与轮询都在这里，不依赖 React 的重渲染。
       * @returns 清理函数（卸载时停轮询、清空座位）
       */
      function mountStatus(seat) {
        const dot = document.createElement('span')
        dot.className = 'dshqp-dot'
        const label = document.createElement('span')
        label.textContent = 'ComfyUI 检测中…'
        seat.appendChild(dot)
        seat.appendChild(label)
        // ★ 2026-10-09：优化状态徽标，紧跟在 ComfyUI 状态后面
        const optBadge = createOptimizationBadge()
        seat.appendChild(optBadge.el)

// 设计说明已外置 → docs/client-design-notes.md#client-note-052（原 L2666-2670）
        if (typeof optBadge.setToggleDoneHandler === 'function') {
          optBadge.setToggleDoneHandler(() => {
            try { poll() } catch (error) { /* 刷新失败不影响开关本身 */ }
          })
        }

        let stopped = false
        let timer = null

// 设计说明已外置 → docs/client-design-notes.md#client-note-053（原 L2680-2690）
        let lastPaint = null
        const paint = (view) => {
          if (stopped) return
          const err = typeof view.error === 'string' ? view.error : ''
          const key = `${view.state}|${view.label}|${err}`
          if (key === lastPaint) return
          lastPaint = key
          dot.setAttribute('data-state', view.state)
          label.textContent = view.label
          // ★ 启动失败时把**具体原因**挂到 title 上 —— 鼠标悬停即可看到 exit code 与错误原文。
          //   状态行本身必须保持简短（宽度约束见 describeStatus 说明），所以原因走这里。
          seat.setAttribute('title', err !== '' ? `${view.label}：${err}` : view.label)
        }

        // ★★ 2026-10-07 新增：点状态点弹出「多久没出图就自动关掉后端」的选项。
        //   调 host 的 `?idleMinutes=N`（N = 0 表示不自动关闭），选完立刻重新拉一次状态。
        const IDLE_CHOICES = [
          { minutes: 0, text: '不自动关闭' },
          { minutes: 1, text: '1 分钟后关闭' },
          { minutes: 5, text: '5 分钟后关闭（默认）' },
          { minutes: 10, text: '10 分钟后关闭' },
          { minutes: 30, text: '30 分钟后关闭' },
        ]

// 设计说明已外置 → docs/client-design-notes.md#client-note-054（原 L2715-2723）
        const TRIGGER_CHOICES = [
          { id: 'off', text: '只在点名时画' },
          { id: 'strict', text: '明确要求才画' },
          { id: 'auto', text: '自动判断（默认）' },
          { id: 'eager', text: '沾边就画' },
        ]
        // ★★★ 2026-10-12（预设工作流）：出图风格预设选项。
        //   只影响画幅（在用户没显式传尺寸时）；壁纸 16:9、人像/动漫 3:4、默认 1:1。
        const PRESET_CHOICES = [
          { id: 'default', text: '默认（1:1）' },
          { id: 'portrait', text: '人像（3:4）' },
          { id: 'anime', text: '动漫插画（3:4）' },
          { id: 'wallpaper', text: '壁纸（16:9）' },
        ]
        let menu = null

        /* ★ 2026-10-08：当前生效的档位（分钟）。菜单里的高亮就是拿它比对出来的。
           null = 还没拉到状态，这时菜单先不点亮，等轮询回来由 syncMenuHighlight 补上。 */
        let idleNow = null
        // ★★★ 2026-10-12：当前出图预设（界面菜单设的，经 ?preset= 下发给后端）。
        let presetNow = 'default'
// 设计说明已外置 → docs/client-design-notes.md#client-note-055（原 L2745-2748）
        const PICK_CHOICES = [
          { id: 'off', text: '关闭（默认）' },
          { id: 'on', text: '开启' },
        ]
        let aiBestNow = 'off'
        let userBestNow = 'off'

        /* ★★★ 2026-10-09：最新一次拿到的优化诊断（与徽标同源）。
           菜单里那栏「优化」靠它显示状态文字；点开时也把**同一个对象**喂给详情面板，
           保证菜单与徽标永远说的是同一件事。null = 还没拉到状态。 */
        let optNow = null

        /** 菜单里「优化」那一项的文字 —— 直接报分布，省得用户非点进去才知道。
         *  ★ 没拿到状态时说"查看优化状态"而不是硬编一个状态词：
         *    编一个"未启用"会让人误以为真的没启用，而那只是"还没拉回来"。 */
        const optMenuText = () => {
          const s = optNow?.stats
          if (!optNow || !s || !Number(s.total)) return `查看优化状态（${optNow?.summary ?? '检测中'}）`
          const bits = [`${s.on}/${s.total} 已启用`]
          // ★ 2026-10-09 二次修正：`superseded`（按尺寸让位）必须报出来 ——
          //   否则默认配置下（blockCacheEnabled=true）菜单只显示"5/7 已启用"，
          //   用户会以为缺了 2 项，其实那 2 项在小尺寸是生效的。
          if (s.superseded) bits.push(`${s.superseded} 让位`)
          const fixable = (Number(s.available) || 0) + (Number(s.off) || 0)
          if (fixable) bits.push(`${fixable} 可启用`)
          if (s.blocked) bits.push(`${s.blocked} 不可启用`)
          if (s.unknown) bits.push(`${s.unknown} 未确认`)
          return `优化状态：${bits.join(' · ')}`
        }

        /* ★★★ 2026-10-09：后端在线状态 + 是否正在启动。
           菜单里的「启动 ComfyUI」按这两个值决定文案与可用性：
           已经在线就置灰（写"已在运行"），点过启动还没起来就写"正在启动…"。 */
        let onlineNow = false
        let startingNow = false
// 设计说明已外置 → docs/client-design-notes.md#client-note-056（原 L2784-2790）
        let startRequestedAt = 0
        /** 本地"启动中"最多撑多久就自行放弃（毫秒）。比后端 45 秒超时略长，留足余量。 */
        const START_GIVEUP_MS = 60000
        /* ★ 2026-10-09：启动失败状态 + 失败原因 —— 菜单里要据此显示「重试」和错误详情。 */
        let launchFailed = false
        let launchError = ''
        /** ★ 2026-10-09：纯超时（无报错）vs 报错退出 —— 菜单文案据此区分。 */
        let launchTimedOut = false
        /** 当前已等待的启动秒数（显示在"启动中 Ns"里）。 */
        let launchElapsedMs = 0
        /* ★ 2026-10-09：当前生效的「生图判断」档位（null = 还没拉到状态）。 */
        let triggerNow = null

// 设计说明已外置 → docs/client-design-notes.md#client-note-057（原 L2804-2809）
        const onDocClick = (event) => {
          if (menu === null) return
          const target = event.target
          // 座位区域放行（"点状态点自己 = 再点一次收起"交给 toggleMenu 管，否则会关了又立刻打开）
          if (target && seat.contains && seat.contains(target)) return
          // ★ 菜单现在挂在 body 上、**不再是座位的子元素**，所以要单独放行 ——
          //   不然点菜单项会被当成"点外面"：捕获阶段先把菜单关掉，手感就是"点一下没反应"。
          if (target && menu.contains && menu.contains(target)) return
          closeMenu()
        }
        const closeMenu = () => {
          if (menu === null) return
          try { menu.remove() } catch (error) { /* 已被移除 */ }
          menu = null
          // 菜单没了就把"点空白处消失"的监听摘掉 —— 它只在菜单活着的时候挂着。
          document.removeEventListener('click', onDocClick, true)
        }

        /** 按当前选择刷新勾选高亮（菜单没开就什么都不做）。
         *  两组各按自己的"当前值"比对：自动关闭比分钟数，生图动画比 id。 */
        const syncMenuHighlight = () => {
          if (menu === null) return
          for (const item of menu.children) {
            const kind = typeof item.getAttribute === 'function' ? item.getAttribute('data-kind') : null
            if (kind === null) continue // 分组标题没有 data-kind
            const value = item.getAttribute('data-value')
            // ★ 2026-10-09：新增 trigger 类型（生图判断档位）的高亮比对
            const on = kind === 'idle'
              ? Number(value) === idleNow
              : kind === 'trigger' ? value === triggerNow
              : kind === 'preset' ? value === presetNow
              : kind === 'aibest' ? value === aiBestNow
              : kind === 'userbest' ? value === userBestNow
              : value === flowStyleNow
            if (on) item.setAttribute('data-current', '1')
            else item.removeAttribute('data-current')
          }
        }

        const pickIdle = (minutes) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          postStatus({ idleMinutes: minutes })
            // ★ 只在这时才认下新档位：请求失败就保持原值，不让高亮说谎。
            .then(() => { if (!stopped) { idleNow = minutes; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /** 点「生图动画」里的一项：写进 host（host 会落盘，重启后记得住），
         *  同样只在请求成功后才认新值，并立刻重画菜单高亮。 */
        const pickFlow = (id) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          postStatus({ flowStyle: id })
            .then(() => { if (!stopped) { flowStyleNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-058（原 L2866-2873）
        const pickTrigger = (id) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          postStatus({ drawTrigger: id })
            .then(() => { if (!stopped) { triggerNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /** ★ 2026-10-19：抽卡「AI 挑图」开关 —— 与 flowStyle 同一套（成功才认新值）。 */
        const pickAiBest = (id) => {
          postStatus({ aiPickBest: id })
            .then(() => { if (!stopped) { aiBestNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /** ★ 2026-10-19：抽卡「用户自选」开关。 */
        const pickUserBest = (id) => {
          postStatus({ userPickBest: id })
            .then(() => { if (!stopped) { userBestNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

        /**
         * ★★★ 2026-10-12（预设工作流）：点预设 → 经 ?preset= 下发给后端。
         *   与 flowStyle 同一套：请求成功才认新值并刷新高亮；不覆盖用户显式尺寸。
         */
        const setPreset = (id) => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          postStatus({ preset: id })
            .then(() => { if (!stopped) { presetNow = id; poll() } })
            .catch(() => { /* 失败就保持原样，下次轮询会纠正显示 */ })
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-059（原 L2906-2911）
        const runWizard = () => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          const wizardUrl = base.replace(/status\.json$/u, 'wizard')
          const lines = ['就绪清单自检', '（正在获取…）']
          if (typeof showNotice === 'function') showNotice(lines.join('\n'))
          else if (typeof alert === 'function') alert(lines.join('\n'))
          fetch(wizardUrl, { headers: { accept: 'application/json' } })
            .then((r) => r.json())
            .then((w) => {
              const out = ['就绪清单自检']
              if (!w || w.ok !== true) out.push('（清单获取失败，稍后再点一次）')
              else {
                if (!w.online) out.push('① ComfyUI 后端：未在线 —— 先点「启动 ComfyUI」或手动启动。')
                else out.push('① ComfyUI 后端：✓ 已在线')
                for (const s of (w.steps || [])) {
                  if (s.id === 'comfy') continue
                  out.push(`${s.ok ? '✓' : '✗'} ${s.label} —— ${s.detail}`)
                }
                if (w.allReady) out.push('\n全部就绪，直接让我画一张试试吧。')
                else out.push('\n按上面的指引补齐后，重开本菜单点「就绪清单自检」复查。')
              }
              if (typeof showNotice === 'function') showNotice(out.join('\n'))
              else if (typeof alert === 'function') alert(out.join('\n'))
            })
            .catch((err) => {
              const msg = `就绪清单自检获取失败：${err?.message ?? err}`
              if (typeof showNotice === 'function') showNotice(msg)
              else if (typeof alert === 'function') alert(msg)
            })
        }

        /**
         * ★★★ 2026-10-12（确认式一键修复）：先预览、再确认执行。
         *   这里直接带 confirm=true 调后端修复端点（只做可逆/无害动作）。
         */
        const runRepairNow = () => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          fetch(`${base.replace(/status\.json$/u, 'repair')}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ confirm: true }),
          })
            .then((r) => r.json())
            .then((data) => {
              const ok = data && data.ok === true
              const done = (data && data.done) || []
              const lines = ['一键修复 · 结果', ok ? (data.summary || '') : (data.reason || '失败')]
              for (const d of done) lines.push(`${d.ok ? '✓' : '✗'} ${d.id}${d.error ? `：${d.error}` : ''}`)
              if (typeof showNotice === 'function') showNotice(lines.join('\n'))
              else if (typeof alert === 'function') alert(lines.join('\n'))
            })
            .catch((err) => {
              const msg = `一键修复请求失败：${err?.message ?? err}`
              if (typeof showNotice === 'function') showNotice(msg)
              else if (typeof alert === 'function') alert(msg)
            })
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-060（原 L2970-2979）
        const startComfy = () => {
          const base = statusPath === null ? STATUS_PATHS[0] : statusPath
          // 重试 = 把上一次的失败痕迹清掉，否则界面会一直挂着旧错误
          startingNow = true
          startRequestedAt = Date.now()   // ← 兜底收口的计时起点（见上方注释）
          launchFailed = false
          launchTimedOut = false
          launchError = ''
          launchElapsedMs = 0
          paint({ state: 'busy', label: 'ComfyUI 启动中…', error: '' })
          postStatus({ start: 1 })
            .then(() => {
              if (stopped) return
              // 拉起通常十几秒到几十秒：先等一会儿再问，避免问到"还没起来"就误判成失败
              setTimeout(() => { if (!stopped) poll() }, 3000)
            })
            .catch(() => {
              if (stopped) return
              startingNow = false
              paint(describeStatus(null, statusFails))
            })
        }

        /** 往菜单里添一组：一个标题 + 若干条目。
         *  sub = true 时是**子标题**（更小更淡、不带上面的分隔线，用在「流光 · 抄自月匠」）。 */
        const addGroup = (title, entries, sub) => {          const head = document.createElement('div')
          head.className = sub === true ? 'dshqp-menu-head dshqp-menu-sub' : 'dshqp-menu-head'
          head.textContent = title
          menu.appendChild(head)
          for (const entry of entries) {
            const item = document.createElement('button')
            item.type = 'button'
            item.className = 'dshqp-menu-item'
            // ★ 2026-11-12（用户：「这个你放的地方也太不明显了吧」）：常用项给强调样式。
            //   以前它跟"自动关闭""生图动画"这些平铺在一起，用户根本扫不到。
            if (entry.hot === true) item.className += ' dshqp-menu-hot'
            item.setAttribute('data-kind', entry.kind)
            item.setAttribute('data-value', String(entry.value))
            // 流光给一个预览小色块：不用真去生一张图，就能看出自己选的是什么颜色
            if (entry.swatch !== undefined) {
              const dot = document.createElement('span')
              dot.className = `dshqp-menu-swatch dshqp-menu-swatch-${entry.swatch}`
              item.appendChild(dot)
            }
            // 名字前面的小圆点（需求方要求：给"流星"标一个点，表示它是自制的那个）
            if (entry.bullet === true) {
              const mark = document.createElement('span')
              mark.className = 'dshqp-menu-bullet'
              item.appendChild(mark)
            }
            const label = document.createElement('span')
            label.textContent = entry.text
            item.appendChild(label)
            // 名字后面的来源小标签（自制 / …）
            if (entry.tag !== undefined) {
              const tag = document.createElement('span')
              tag.className = 'dshqp-menu-tag'
              tag.textContent = entry.tag
              item.appendChild(tag)
            }
            // ★ 2026-10-09：不可用的条目（例如已经在线时的「启动 ComfyUI」）
            //   置灰且不响应点击 —— 让人能看出"这一项现在没意义"，
            //   而不是点了没反应、以为坏了。
            if (entry.muted === true) {
              item.disabled = true
              item.style.opacity = '.45'
              item.style.cursor = 'default'
            } else {
              item.addEventListener('click', (event) => {
                event.stopPropagation()
                closeMenu()
                if (entry.kind === 'studio') openEditStudio()
                else if (entry.kind === 'idle') pickIdle(entry.value)
                else if (entry.kind === 'start') startComfy()
                else if (entry.kind === 'trigger') pickTrigger(entry.value)
                else if (entry.kind === 'opt') openOptDetail()
                else if (entry.kind === 'preset') setPreset(entry.value)
                else if (entry.kind === 'aibest') pickAiBest(entry.value)
                else if (entry.kind === 'userbest') pickUserBest(entry.value)
                else if (entry.kind === 'wizard') runWizard()
                else if (entry.kind === 'repair') runRepairNow()
                else if (entry.kind === 'workbench') openWorkbench('')
                else if (entry.kind === 'recent-inpaint') quickInpaintRecent()
                else if (entry.kind === 'video-timeline') openVideoTimeline('')
                else pickFlow(entry.value)
              })
            }
            menu.appendChild(item)
          }
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-061（原 L3070-3079）
        const addDivider = () => {
          const line = document.createElement('div')
          line.className = 'dshqp-menu-divider'
          menu.appendChild(line)
        }

        /**
         * ★★★ 2026-10-09 新增：菜单里点「优化」→ 弹**同一个**详情面板。
         *
         * 复用徽标那套 openDetail（单一数据源），不再自己拼一份 DOM。
         * 还没拿到状态时给一句明确提示 —— 点了没反应会让人以为坏了。
         */
        const openOptDetail = () => {
          if (optBadge.openDetail()) return
          if (typeof optBadge.setNotice === 'function') optBadge.setNotice('优化状态还在获取中，稍等几秒再点。')
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-062（原 L3097-3113）
        const placeMenu = () => {
          try {
            if (typeof seat.getBoundingClientRect !== 'function') return
            const rect = seat.getBoundingClientRect()
            const viewport = Number(window.innerHeight) || 0
            const viewportW = Number(window.innerWidth) || 0
            if (viewport <= 0) return
            const GAP = 8
            const LIMIT = 400
            menu.style.maxHeight = `${LIMIT}px`
            // scrollHeight 是**内容总高**，不受 max-height 影响 —— 正好用来判断"需要多高"
            const need = Math.min(Number(menu.scrollHeight) || 0, LIMIT)
            const above = rect.top - GAP
            const below = viewport - rect.bottom - GAP
            const wantDown = above < need || rect.top < viewport * 0.45
            const down = wantDown && below > 140
            const room = down ? below : above
            const height = Math.max(140, Math.min(LIMIT, room))
            menu.style.maxHeight = `${height}px`
            const box = typeof menu.getBoundingClientRect === 'function' ? menu.getBoundingClientRect() : null
            const shown = Math.min(box && box.height ? box.height : height, height)
            const width = box && box.width ? box.width : 0
            menu.style.top = down
              ? `${Math.min(Math.max(GAP, viewport - GAP - height), rect.bottom + 6)}px`
              : `${Math.max(GAP, rect.top - shown - 6)}px`
            // 右对齐座位右边缘，同时不许越出视口
            const rightAligned = rect.right - width
            const maxLeft = viewportW > 0 ? viewportW - width - GAP : rightAligned
            menu.style.left = `${Math.max(GAP, Math.min(rightAligned, maxLeft))}px`
          } catch (error) {
            /* 量不到就不动它 —— 菜单能用比"位置完美"重要得多 */
          }
        }

        const toggleMenu = () => {
          if (menu !== null) { closeMenu(); return }
          menu = document.createElement('div')
          menu.className = 'dshqp-menu'
// 设计说明已外置 → docs/client-design-notes.md#client-note-063（原 L3152-3157）
          addGroup('后端', [
            onlineNow
              ? { kind: 'start', text: 'ComfyUI 已在运行', muted: true }
              : launchFailed
                ? { kind: 'start', text: launchTimedOut ? '启动超时，点此重试' : '启动失败，点此重试' }
                : { kind: 'start', text: startingNow ? '正在启动…' : '启动 ComfyUI' },
          ])
          // ★ 2026-10-09：启动失败/超时时把**原因**直接摆进菜单 —— 用户不用去猜、也不用翻日志。
          //   这是需求方明确要求「直接报错」的落点。
          if (!onlineNow && launchFailed && launchError !== '') {
            const why = document.createElement('div')
            why.className = 'dshqp-menu-note'
            why.textContent = `${launchTimedOut ? '超时' : '失败'}原因：${launchError}`
            menu.appendChild(why)
          }
// 设计说明已外置 → docs/client-design-notes.md#client-note-064（原 L3173-3176）
          addGroup('常用（点开就能用）', [
            { kind: 'studio', text: '编辑台（圈选重绘 / 图片编辑 / 视频选帧）', hot: true },
          ])
          addGroup('自动关闭', IDLE_CHOICES.map((choice) => (
            { kind: 'idle', value: choice.minutes, text: choice.text }
          )))
// 设计说明已外置 → docs/client-design-notes.md#client-note-065（原 L3185-3188）
          addGroup('生图判断（重载后生效）', TRIGGER_CHOICES.map((choice) => (
            { kind: 'trigger', value: choice.id, text: choice.text }
          )))

// 设计说明已外置 → docs/client-design-notes.md#client-note-066（原 L3193-3204）
          addGroup('优化', [
            {
              kind: 'opt',
              value: 'detail',
              // 条目文字直接报当前状态，用户在菜单里就能看到分布，不必先点进去
              text: optMenuText(),
            },
          ])

          // ★★★ 2026-10-12（用户要求「预设工作流」）：出图风格预设。
          //   只有用户**没显式传 size** 时才接管画幅；megapixels 永远尊重显式值。
          //   选中写进 uiState + 经 ?preset= 下发给后端，作为下次出图的默认预设。
          addGroup('预设（出图风格）', PRESET_CHOICES.map((choice) => (
            { kind: 'preset', value: choice.id, text: choice.text }
          )))

          // ★★★ 2026-10-12（用户要求「就绪清单自检 / 确认式一键修复」）：工具区。
          addGroup('抽卡挑图（重载后生效）', [
            ...PICK_CHOICES.map((c) => ({ kind: 'aibest', value: c.id, text: `AI 挑图：${c.text}` })),
            ...PICK_CHOICES.map((c) => ({ kind: 'userbest', value: c.id, text: `用户自选：${c.text}` })),
          ])
          addGroup('自检与修复', [
            { kind: 'wizard', text: '就绪清单自检（查缺件）' },
            { kind: 'repair', text: '一键修复（可逆）' },
          ])

          // ★★★ 2026-10-09：**功能区到此为止，下面是外观区**。
          //   上面三项改的是"怎么工作"，下面两项改的是"长什么样"，
          //   用一条明显分隔线划开（需求方要求区分这两类）。
          addDivider()

          // ★ 用户 2026-10-08：「把现在的三个字去掉，在流星前加个点，后面写上自制，
          //   下面的流光统一做一个大标题，标注抄自月匠」。
          //   所以：流星 = 前面一个点 + 后面「自制」标签；15 种流光收进一个子标题下。
          addGroup('生图动画', [
            { kind: 'flow', value: 'meteor', text: '流星', bullet: true, tag: '自制' },
          ])
          // ⚠ 有了这个大标题，条目名就**不再重复带「流光·」前缀**（原来是每项都带）。
          addGroup('流光 · 抄自月匠', FLOW_GRADS.map((grad) => (
            { kind: 'flow', value: grad.id, text: grad.name, swatch: grad.id }
          )), true)
          // ★★ 挂到 **body**（不是座位）—— 摆脱 composer 祖先的 overflow 裁剪。
          //   踩过：挂在座位里时，新会话的菜单会被祖先裁掉头，翻方向/限高都救不了。
          const host = document.body ?? document.documentElement
          host.appendChild(menu)
          // 必须**挂进 DOM 之后**才量得到尺寸（见 placeMenu 的说明）
          placeMenu()
          syncMenuHighlight()
          document.addEventListener('click', onDocClick, true)
        }
        seat.setAttribute('data-clickable', '1')
        // ⚠ 防御：自测用的假座位对象可能没有 addEventListener（真实 DOM 一定有）。
        //   不加这层判断会在这里抛错，把后面的 paint/poll 全带断 —— 自测抓到过一次。
        if (typeof seat.addEventListener === 'function') seat.addEventListener('click', toggleMenu)

        // ★ 2026-10-09：连续取不到状态端点的次数。
        //   用来区分"页面刚加载、host 还没就绪"（一两次，属于正常）和
        //   "端点真的不通"（持续失败，那才值得报出来）。见 describeStatus 的说明。
        let statusFails = 0

        const poll = () => {
          fetchStatus()
            .then((data) => {
              if (stopped) return
              if (data === null) statusFails += 1
              else statusFails = 0
              // ★ 2026-10-09：同步"在线 / 正在启动" —— 菜单里那个「启动 ComfyUI」
              //   的文案和可用性都靠它俩；在线了就把 startingNow 清掉。
              if (data && typeof data === 'object') {
                onlineNow = data.online === true
                if (onlineNow) startingNow = false
                else if (typeof data.starting === 'boolean') startingNow = data.starting
                // ★ 2026-10-09：同步启动失败状态与原因（菜单里要用来显示"重试"+错误详情）
                launchFailed = data.online !== true && data.launchFailed === true
                launchTimedOut = launchFailed && data.launchTimedOut === true
                launchError = typeof data.launchError === 'string' ? data.launchError : ''
                launchElapsedMs = Number(data.launchElapsedMs) || 0
              }
// 设计说明已外置 → docs/client-design-notes.md#client-note-067（原 L3283-3291）
              if (startingNow && startRequestedAt === 0) startRequestedAt = Date.now()
              if (!startingNow) startRequestedAt = 0
              if (startingNow && Date.now() - startRequestedAt > START_GIVEUP_MS) {
                startingNow = false
                startRequestedAt = 0
              }
              paint(describeStatus(data, statusFails))
              // ★ 2026-10-09：同步"优化是否已启用"徽标（含未启用原因）。
              // ★ 2026-10-09：同步"生图判断"档位（菜单高亮用）
              if (data && typeof data.drawTrigger === 'string') {
                if (TRIGGER_CHOICES.some((c) => c.id === data.drawTrigger)) {
                  triggerNow = data.drawTrigger
                }
              }
              // ★★★ 2026-10-09：拿不到 optimization 时**别再说"未知"** ——
              //   那正是两次指出的那类"傻判断"：把可以确定的事实
              //   （端点没通 / 后端是旧版）盖成一句含糊的"未知"。
              //   现在按**能查明的具体原因**分两种说法。
              let optView
              // ★ 两个兜底分支都补 `stats: null`：这里**没有** stats 可报（还没探测），
              //   显式给 null 而不是留 undefined —— 面板那行"共 N 项"据此跳过，
              //   菜单文字也据此走"检测中"。留 undefined 容易被后续代码误当成"有值"。
              if (data === null || typeof data !== 'object') {
                optView = {
                  level: 'unknown',
                  summary: '状态接口未就绪',
                  reasons: ['还没拿到插件后端的响应 —— 页面刚加载时很常见，稍后会自动重试。'],
                  detail: [],
                  stats: null,
                }
              } else if (data.optimization === undefined || data.optimization === null) {
                // 接口有响应、却没有这个字段 ⇒ **正在跑的是旧版后端**（插件是符号链接，
                // 但 DSH 进程仍在用加载时缓存的那份模块）。这句能直接告诉用户该做什么。
                optView = {
                  level: 'unknown',
                  summary: '插件后端是旧版，需重载',
                  reasons: [
                    '状态接口能通，但没带回"优化状态"字段 —— 说明当前运行的是旧版后端。',
                    '重载插件或重启 DSH 之后，这里就会显示真实的优化状态。',
                  ],
                  detail: [],
                  stats: null,
                }
              } else {
                optView = data.optimization
              }
              optBadge.update(optView)
              // ★ 2026-10-12：完整 payload 也存一份 —— 面板里的「出图存到」要读顶层的
              //   `outputDir` / `outputDirSource`（它们**不在** optimization 里）。
              payloadNow = data
              // ★★★ 2026-10-09：把最新优化数据也存一份 —— 菜单里那项要据此显示文字，
              //   点开时也要用它喂给详情面板（与徽标**同源**，绝不各算一套）。
              optNow = optView
              // ★ 记住当前档位供菜单高亮用 —— host 的 snapshot 里本来就带 idleShutdownMs。
              //   注意它是"设定的档位"，不是 idleShutdownInMs 那个"还剩多久"。
              if (data && typeof data.idleShutdownMs === 'number') {
                idleNow = Math.round(data.idleShutdownMs / 60000)
                syncMenuHighlight()
              }
              // ★ 生图动画同理：记住当前选择 —— 菜单高亮和 makeFlowNode 都用它。
              //   只认白名单值，别的一律当没看见（默认照旧走流星）。
              if (data && typeof data.flowStyle === 'string') {
                if (data.flowStyle === 'meteor' || FLOW_IDS.includes(data.flowStyle)) {
                  flowStyleNow = data.flowStyle
                  syncMenuHighlight()
                }
              }
              // ★★★ 2026-10-12：当前出图预设同步（菜单高亮用）。
              // ★ 2026-10-19：抽卡挑图两个开关的当前值（host 的 snapshot 里带）
              if (data && typeof data.aiPickBest === 'string') {
                aiBestNow = data.aiPickBest === 'on' ? 'on' : 'off'
                syncMenuHighlight()
              }
              if (data && typeof data.userPickBest === 'string') {
                userBestNow = data.userPickBest === 'on' ? 'on' : 'off'
                uiUserPickBest = userBestNow
                syncMenuHighlight()
              }
              if (data && typeof data.preset === 'string' && PRESET_CHOICES.some((c) => c.id === data.preset)) {
                presetNow = data.preset
                syncMenuHighlight()
              }
            })
            .catch(() => {
              // 请求本身抛错同样算一次失败（不是"状态未知"，见 describeStatus）
              if (!stopped) {
                statusFails += 1
                paint(describeStatus(null, statusFails))
              }
            })
        }

        paint(describeStatus(null, 0))
        poll()
        timer = setInterval(poll, POLL_MS)

        return () => {
          stopped = true
          if (timer !== null) clearInterval(timer)
          // ★ 卸载时顺手收掉菜单 —— 同时把挂在 document 上的"点空白处消失"监听摘掉，
          //   否则它会一直留在页面上（座位已经没了，菜单却还挂着监听）。
          closeMenu()
          // ★ 2026-10-09：优化面板同理 —— 它挂在 seat 外面（用绝对定位浮起来），
          //   清空 seat 带不走它，必须显式销毁，否则会留一个孤立的浮层在页面上。
          optBadge.dispose()
          try { seat.textContent = '' } catch (error) { /* 座位已被移除 */ }
        }
      }

      /** React 座位：只在 useEffect 里挂纯 DOM，绝不把异常抛进 dsh 的渲染树。 */
      function ComfyStatusSeat() {
        const hostRef = React.useRef(null)
        React.useEffect(() => {
          const seat = hostRef.current
          if (!seat) return undefined
          try {
            return mountStatus(seat)
          } catch (error) {
            warn(`状态指示器挂载失败：${error && error.message ? error.message : error}`)
            return undefined
          }
        }, [])
        return React.createElement('span', { className: 'dshqp-seat', ref: hostRef })
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-068（原 L3417-3423）
      function pingHost(reason) {
        try {
          fetch(`api/qwen-paint/status.json?ping=${encodeURIComponent(reason)}`, { cache: 'no-store' }).catch(() => {})
        } catch (error) {
          /* 自报失败无所谓 */
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-069（原 L3432-3445）
      function loadComfyPipelinePanel() {
        try {
          if (document.getElementById(PANEL_JS_ID) !== null) return
          const link = document.createElement('link')
          link.id = PANEL_CSS_ID
          link.rel = 'stylesheet'
          link.href = 'comfy-pipeline/panel.css'
          document.head.appendChild(link)
          const script = document.createElement('script')
          script.id = PANEL_JS_ID
          script.defer = true
          script.src = 'comfy-pipeline/panel.js'
          document.head.appendChild(script)
        } catch (error) {
          /* 面板加载失败绝不影响现有卡片 */
        }
      }

      /** 图形化安装引导 + 蒙版精修 + 生成历史：assets 独立脚本，lib/client.js 只留这个挂载点。 */
      function loadQpExtras() {
        try {
          for (const [id, src] of [
            ['dshqp-setup-guide-js', 'qwen-paint/setup-guide.js'],
            ['dshqp-mask-fx-js', 'qwen-paint/mask-fx.js'],
            // 生成历史：菜单入口由 history.js 自己注入，client.js 不加历史逻辑。
            ['dshqp-history-js', 'qwen-paint/history.js'],
            ['dshqp-draft-js', 'qwen-paint/draft.js'],
          ]) {
            if (document.getElementById(id)) continue
            const s = document.createElement('script')
            s.id = id; s.defer = true; s.src = src
            document.head.appendChild(s)
          }
        } catch (error) { /* 新 UI 加载失败绝不影响既有卡片 */ }
      }

      function loadComfyPipelineSchema() {
        try {
          fetch('api/comfy-pipeline/schema', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => { if (j && j.ok && j.schema) window.ComfyPipelineSchema = j.schema })
            .catch(() => {})
        } catch (error) {
          /* schema 拉取失败无所谓 */
        }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-070（原 L3493-3496）
      let uiUserPickBest = 'off'

      /** 三个浮层共用的骨架：只抽完全同形的部分；各自 close() 的清理逻辑保持原样。 */
      function makeOverlay(extraClass) {
        const overlay = document.createElement('div')
        overlay.className = extraClass ? 'dshqp-mask-overlay ' + extraClass : 'dshqp-mask-overlay'
        try { overlay.setAttribute('data-dshqp-theme', detectDarkTheme() ? 'dark' : 'light') } catch (error) { /* 忽略 */ }
        const card = document.createElement('div')
        card.className = 'dshqp-mask-card'
        overlay.appendChild(card)
        return { overlay, card }
      }

// 设计说明已外置 → docs/client-design-notes.md#client-note-075（原 L2991-2996）
      function openEditStudio(preselectPath) {
        if (typeof document === 'undefined' || document.body === null) return
        for (const el of Array.from(document.querySelectorAll('.dshqp-studio-picker'))) {
          try { el.remove() } catch (error) { /* 已被移除 */ }
        }
        const { overlay, card } = makeOverlay('dshqp-studio-picker')
        const title = document.createElement('div')
        title.className = 'dshqp-mask-title'
        title.textContent = '编辑台 · 选一个功能'
        card.appendChild(title)
        const hint = document.createElement('div')
        hint.className = 'dshqp-mask-hint'
        hint.textContent = '圈选局部重绘或移除物体 / 打开图片编辑台扩图放大 / 视频选帧截取时间段。选一个后编辑台自动让位。'
        card.appendChild(hint)
        const choices = [
          ['圈选重绘 / 移除物体', () => openInpaintDialog(preselectPath || '')],
          ['图片编辑台（扩图 / 放大 / 移除）', () => openWorkbench(preselectPath || '')],
          ['视频选帧 / 截取时间段', () => openVideoTimeline(preselectPath || '')],
        ]
        for (const [label, fn] of choices) {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'dshqp-mask-btn'
          b.textContent = label
          b.addEventListener('click', () => {
            try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) } catch (error) { /* 已移除 */ }
            fn()
          })
          card.appendChild(b)
        }
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) {
            try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) } catch (error) { /* 已移除 */ }
          }
        })
        document.body.appendChild(overlay)
      }

      /** 最近产物列表：四处调用同一串 fetch，收成一处（行为等价的同一个 Promise）。 */
      function fetchRecent() {
        return fetch('api/qwen-paint/recent-images', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
      }

      function openInpaintDialog(imagePath, opts) {
        if (typeof document === 'undefined' || document.body === null) return
        if (typeof imagePath !== 'string' || imagePath === '') return
        // ★ 2026-11-12：同一块手绘蒙版复用两种动作。默认 inpaint = 历史行为逐字不变；
        //   remove = 圈出要去掉的东西，不用写提示词，走 /quick-edit 的 remove 分支。
        const isRemove = Boolean(opts && opts.mode === 'remove')

        // ★★★ 2026-10-20（0.17.13 修 bug）：同一时刻只允许一个圈选弹窗。
        //   改版前重复点图片会把浮层一层层盖上 —— 视觉上只看得到最上面那层，
        //   底下的层还各自挂着 pointer / keydown 监听，等于悄悄漏监听器。
        //   ✓ 开新的之前把残留的全清掉。
        if (typeof document.querySelectorAll === 'function') {
          for (const el of Array.from(document.querySelectorAll('.dshqp-mask-overlay'))) {
            try { el.remove() } catch (error) { /* 已被移除 */ }
          }
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-071（原 L3533-3536）
        const fileUrl = (p) => `api/qwen-paint/file?path=${encodeURIComponent(p)}`

        const { overlay, card } = makeOverlay('')

        const title = document.createElement('div')
        title.className = 'dshqp-mask-title'
        title.textContent = isRemove ? '圈出要移除的东西' : '圈选局部重绘'
        card.appendChild(title)

        const hint = document.createElement('div')
        hint.className = 'dshqp-mask-hint'
        hint.textContent = isRemove
          ? '用画笔把要去掉的东西涂白，其余区域会自动补全背景、光影和纹理。这个动作不用写提示词。'
          : '用画笔把要改的地方涂出来（白色=重绘），再写一句要改成什么（也可以点下面的常用说法）。没涂的地方保持原样。'
        card.appendChild(hint)

        const stage = document.createElement('div')
        stage.className = 'dshqp-mask-stage'
        card.appendChild(stage)

        const base = document.createElement('img')
        base.alt = '待重绘的图'
        stage.appendChild(base)

        const view = document.createElement('canvas')
        stage.appendChild(view)

        const tools = document.createElement('div')
        tools.className = 'dshqp-mask-tools'
        card.appendChild(tools)

        const mkBtn = (text, on) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'dshqp-mask-btn'
          b.textContent = text
          if (on === true) b.setAttribute('data-on', '1')
          tools.appendChild(b)
          return b
        }

        const btnBrush = mkBtn('画笔', true)
        const btnEraser = mkBtn('橡皮', false)
        const btnClear = mkBtn('清空', false)
        const sizeWrap = document.createElement('span')
        sizeWrap.style.cssText = 'font-size:12px;opacity:.8;display:flex;gap:6px;align-items:center'
        sizeWrap.textContent = '笔刷'
        const size = document.createElement('input')
        size.type = 'range'
        size.min = '4'
        size.max = '120'
        size.value = '28'
        size.style.width = '110px'
        sizeWrap.appendChild(size)
        tools.appendChild(sizeWrap)

        // ★ 傻瓜化：不知道该写什么，点一下就填好，填完还能自己改。
        //   remove 模式不需要提示词，整块不渲染。
        if (!isRemove) {
          const chips = document.createElement('div')
          chips.className = 'dshqp-mask-presets'
          for (const text of [
            '把圈起来的部分换成红色',
            '修复手部和五官，其它不动',
            '去掉多余的文字和水印',
            '改成夜晚的暖色灯光',
            '换成卡通风格',
          ]) {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = 'dshqp-chip'
            b.textContent = text
            b.addEventListener('click', () => { prompt.value = text; prompt.focus() })
            chips.appendChild(b)
          }
          card.appendChild(chips)
        }

        const prompt = document.createElement('textarea')
        prompt.className = 'dshqp-mask-prompt'
        prompt.placeholder = '这一块要改成什么？例如：把帽子换成红色针织帽，其它地方不要动'
        if (isRemove) prompt.style.display = 'none'
        card.appendChild(prompt)

        const foot = document.createElement('div')
        foot.className = 'dshqp-mask-foot'
        card.appendChild(foot)

        const state = document.createElement('div')
        state.className = 'dshqp-mask-state'
        state.textContent = '正在载入图片…'
        foot.appendChild(state)

        const btnCancel = document.createElement('button')
        btnCancel.type = 'button'
        btnCancel.className = 'dshqp-mask-btn'
        btnCancel.textContent = '取消'
        foot.appendChild(btnCancel)

        const btnGo = document.createElement('button')
        btnGo.type = 'button'
        btnGo.className = 'dshqp-mask-btn'
        btnGo.textContent = isRemove ? '移除并补全' : '开始重绘'
        // ★ 主动作给强调色：一堆同款按钮里，用户得一眼看到"点哪个才会出图"
        try { btnGo.setAttribute('data-primary', '1') } catch (error) { /* 忽略 */ }
        btnGo.disabled = true
        foot.appendChild(btnGo)

        // ★★★ 2026-10-20（0.17.13 修 bug）：结果图容器**只造一次**。
        //   改版前每次成功都往 card 里 append 一个新 <img> —— 连点几次「再改一次」
        //   就在弹窗里叠一排结果图，越叠越长还把上面的顶出视野。
        //   ✓ 改成固定容器 + replaceChildren：永远只展示最新一张。
        const resultSlot = document.createElement('div')
        resultSlot.className = 'dshqp-mask-result'
        card.appendChild(resultSlot)

        let drawing = false
        let erasing = false
        let ready = false
        let last = null
        /** 离屏蒙版：黑底 + 白笔迹（ComfyUI 认的就是这个） */
        let maskCanvas = null
        let maskCtx = null

        const close = () => {
          try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) } catch (error) { /* 已被移除 */ }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', onKey)
          }
        }
        const onKey = (e) => { if (e.key === 'Escape') close() }

        const paintStroke = (from, to, erase) => {
          if (maskCtx === null) return
          const r = (Number(size.value) || 28) / 2
          for (const ctx of [view.getContext('2d'), maskCtx]) {
            ctx.save()
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.lineWidth = r * 2
            if (ctx === maskCtx) {
              ctx.strokeStyle = erase ? '#000000' : '#ffffff'
            } else {
              ctx.strokeStyle = erase ? 'rgba(0,0,0,0)' : 'rgba(255,80,120,0.55)'
              ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
            }
            ctx.beginPath()
            ctx.moveTo(from.x, from.y)
            ctx.lineTo(to.x, to.y)
            ctx.stroke()
            ctx.restore()
          }
        }

        const pointOf = (e) => {
          const rect = view.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) return null
          return {
            x: (e.clientX - rect.left) * (view.width / rect.width),
            y: (e.clientY - rect.top) * (view.height / rect.height),
          }
        }

        view.addEventListener('pointerdown', (e) => {
          if (!ready) return
          const p = pointOf(e)
          if (p === null) return
          drawing = true
          last = p
          try { view.setPointerCapture(e.pointerId) } catch (error) { /* 老浏览器 */ }
          paintStroke(p, { x: p.x + 0.01, y: p.y + 0.01 }, erasing) // 点一下也留一个点
          e.preventDefault()
        })
        view.addEventListener('pointermove', (e) => {
          if (!drawing || last === null) return
          const p = pointOf(e)
          if (p === null) return
          paintStroke(last, p, erasing)
          last = p
          e.preventDefault()
        })
        const endStroke = () => { drawing = false; last = null }
        view.addEventListener('pointerup', endStroke)
        view.addEventListener('pointercancel', endStroke)
        view.addEventListener('pointerleave', endStroke)

        btnBrush.addEventListener('click', () => {
          erasing = false
          btnBrush.setAttribute('data-on', '1')
          btnEraser.removeAttribute('data-on')
        })
        btnEraser.addEventListener('click', () => {
          erasing = true
          btnEraser.setAttribute('data-on', '1')
          btnBrush.removeAttribute('data-on')
        })
        btnClear.addEventListener('click', () => {
          if (maskCtx === null) return
          maskCtx.fillStyle = '#000000'
          maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
          const vctx = view.getContext('2d')
          vctx.clearRect(0, 0, view.width, view.height)
        })
        btnCancel.addEventListener('click', close)
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
        }

        btnGo.addEventListener('click', () => {
          const text = String(prompt.value || '').trim()
          if (!isRemove && text === '') { state.textContent = '先写一句"要改成什么"，或点上面的常用说法'; prompt.focus(); return }
          if (maskCanvas === null) { state.textContent = '图片还没载入好'; return }
          btnGo.disabled = true
          btnCancel.disabled = true
          state.textContent = isRemove
            ? '移除并补全中…（要几十秒，别关这个窗口）'
            : '重绘中…（要几十秒，别关这个窗口）'
          let maskPng = ''
          try {
            maskPng = window.DshQpMaskFx
              ? window.DshQpMaskFx.exportMask(maskCanvas)
              : maskCanvas.toDataURL('image/png')
          } catch (error) {
            state.textContent = `蒙版导出失败：${error?.message ?? error}`
            btnGo.disabled = false
            btnCancel.disabled = false
            return
          }
          const endpoint = isRemove ? 'api/qwen-paint/quick-edit' : 'api/qwen-paint/inpaint'
          const fx = window.DshQpMaskFx ? window.DshQpMaskFx.values() : null
          // ★ 2026-11-13 审计修：移除走 /quick-edit，那边不消费 maskFx（数值无意义），
          //   带上只会让人以为蒙版参数对「移除」也生效 —— 干脆不带。
          const payload = isRemove
            ? { action: 'remove', image: imagePath, maskPng }
            : { image: imagePath, prompt: text, maskPng, maskFx: fx }
          fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
            .then((r) => r.json())
            .then((data) => {
              if (!data || data.ok !== true) {
                state.textContent = `失败：${data?.reason ?? '未知原因'}`
                btnGo.disabled = false
                btnCancel.disabled = false
                return
              }
              const out = String(data.path ?? '')
              state.textContent = `完成（${data.seconds ?? '?'}s）：${out}`
              if (out !== '') {
                // 直接把结果图换到弹窗里 —— 用户能立刻看到改得对不对
                const next = document.createElement('img')
                next.alt = '重绘结果'
                next.style.cssText = 'margin-top:10px;max-width:100%;border-radius:8px'
                next.src = `${fileUrl(out)}&t=${Date.now()}`
                // ★ 2026-10-20（0.17.13）：替换而不是追加 —— 只留最新一张（见 resultSlot 注释）
                resultSlot.replaceChildren(next)
                // 换完图后允许再改一次：清空蒙版，保留输入
                btnClear.click()
              }
              btnGo.disabled = false
              btnCancel.disabled = false
              btnGo.textContent = isRemove ? '再移除一次' : '再改一次'
            })
            .catch((error) => {
              state.textContent = `请求失败：${error?.message ?? error}`
              btnGo.disabled = false
              btnCancel.disabled = false
            })
        })

        // 用 fetch 取 blob 再喂 <img>：避免跨协议把 canvas 标脏（toDataURL 会抛 SecurityError）
        // ★ 2026-10-20（0.17.13）：同样走插件自有路由 fileUrl，不依赖 api/file 的登记机制
        fetch(fileUrl(imagePath))
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.blob()
          })
          .then((blob) => {
            const url = URL.createObjectURL(blob)
            base.onload = () => {
              const w = base.naturalWidth || base.width
              const h = base.naturalHeight || base.height
              if (!w || !h) { state.textContent = '图片尺寸读不到，无法圈选'; return }
              view.width = w
              view.height = h
              maskCanvas = document.createElement('canvas')
              maskCanvas.width = w
              maskCanvas.height = h
              maskCtx = maskCanvas.getContext('2d')
              maskCtx.fillStyle = '#000000'
              maskCtx.fillRect(0, 0, w, h)
              ready = true
              state.textContent = `已载入 ${w}×${h}，可以开始圈选`
              btnGo.disabled = false
              try { URL.revokeObjectURL(url) } catch (error) { /* 无所谓 */ }
            }
            base.onerror = () => { state.textContent = '图片载入失败' }
            base.src = url
          })
          .catch((error) => {
            state.textContent = `图片载入失败：${error?.message ?? error}`
          })

        document.body.appendChild(overlay)
        try { prompt.focus() } catch (error) { /* 无所谓 */ }
      }

      /** 结果图下方的**可见操作条**：把「点图能圈选」从悬停提示变成看得见的按钮。 */
      function imageActionBar(imagePath) {
        const mk = (text, fn) => React.createElement('button', {
          type: 'button', className: 'dshqp-img-btn', onClick: fn,
        }, text)
        return React.createElement('div', { className: 'dshqp-img-actions' },
          mk('圈选重绘', () => openInpaintDialog(imagePath)),
          mk('更多编辑', () => openWorkbench(imagePath)),
        )
      }

      /** 插件自有图片字节路由（不依赖内核 deliverables 登记），工作台与圈选浮层共用。 */
      const pluginFileUrl = (p) => `api/qwen-paint/file?path=${encodeURIComponent(p)}`

// 设计说明已外置 → docs/client-design-notes.md#client-note-072（原 L3861-3866）
      function openWorkbench(preselectPath) {
        if (typeof document === 'undefined' || document.body === null) return
        // 同一时刻只留一个，避免叠层 + 监听器泄漏（0.17.13 的教训）
        if (typeof document.querySelectorAll === 'function') {
          for (const el of Array.from(document.querySelectorAll('.dshqp-wb-overlay'))) {
            try { el.remove() } catch (error) { /* 已移除 */ }
          }
        }

        const { overlay, card } = makeOverlay('dshqp-wb-overlay')

        const mk = (tag, cls, text) => {
          const n = document.createElement(tag)
          if (cls) n.className = cls
          if (text !== undefined) n.textContent = text
          return n
        }
        const mkBtn = (text, fn) => {
          const b = mk('button', 'dshqp-mask-btn', text)
          b.type = 'button'
          b.addEventListener('click', fn)
          return b
        }
        const close = () => {
          try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) } catch (error) { /* 已移除 */ }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', onKey)
          }
        }
        const onKey = (e) => { if (e.key === 'Escape') close() }
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
        }

        card.appendChild(mk('div', 'dshqp-mask-title', '图片编辑台'))
        card.appendChild(mk('div', 'dshqp-wb-head',
          '三步：选一张图 → 点要做什么 → 看结果。圈选类的会让你用画笔在图上涂出要改的地方（白色=要改），没涂到的地方保持原样。'))

        card.appendChild(mk('div', 'dshqp-wb-label', '① 选一张图'))
        const list = mk('div', 'dshqp-wb-list')
        const empty = mk('div', 'dshqp-wb-empty', '正在读取最近生成的图…')
        card.appendChild(list)
        card.appendChild(empty)

        let selected = typeof preselectPath === 'string' ? preselectPath : ''
        const status = mk('div', 'dshqp-mask-state', '还没选图')
        const resultSlot = mk('div', 'dshqp-wb-result')

        const select = (path, thumb) => {
          selected = path
          for (const t of Array.from(list.querySelectorAll('.dshqp-wb-thumb'))) t.removeAttribute('data-on')
          if (thumb) thumb.setAttribute('data-on', '1')
          status.textContent = '已选：' + (String(path).split(/[\\/]/u).pop() || path)
        }

        // 最近生成的图：拿不到就给明确指引，绝不留一块空白让人猜
        fetchRecent()
          .then((j) => {
            // ★ 2026-11-12：记忆里也会混进视频 / 音频产物，这里只留图 ——
            //   否则缩略图会裂、点进去也编辑不了。
            const items = (j && Array.isArray(j.items) ? j.items : []).filter((it) => IMAGE_EXT_RE.test(String(it.path)))
            if (items.length === 0) {
              empty.textContent = '还没有可编辑的图。先在对话里说一句「画一只猫」，出图后这里就会出现；也可以直接点聊天里的图片，或点图片下方的「圈选重绘」。'
              return
            }
            empty.textContent = ''
            for (const it of items) {
              const btn = mk('button', 'dshqp-wb-thumb')
              btn.type = 'button'
              btn.title = it.path
              const img = mk('img')
              img.alt = it.name
              img.src = pluginFileUrl(it.path)
              img.loading = 'lazy'
              btn.appendChild(img)
              btn.appendChild(mk('span', null, it.name))
              btn.addEventListener('click', () => select(it.path, btn))
              list.appendChild(btn)
              if (it.path === selected) select(it.path, btn)
            }
            if (selected === '') status.textContent = '点上面任意一张图选中它'
          })
          .catch(() => { empty.textContent = '最近图片读取失败；仍可直接在聊天里点一张图。' })

        card.appendChild(mk('div', 'dshqp-wb-label', '② 想做什么'))
        const actions = mk('div', 'dshqp-wb-actions')
        const needImage = (fn) => () => {
          if (selected === '') { status.textContent = '先选一张图（点上面的缩略图）'; return }
          close()
          fn(selected)
        }
        actions.appendChild(mkBtn('圈选重绘 · 手涂蒙版', needImage((p) => openInpaintDialog(p))))
        actions.appendChild(mkBtn('移除物体 · 圈出要去掉的', needImage((p) => openInpaintDialog(p, { mode: 'remove' }))))
        card.appendChild(actions)

        const showResult = (out) => {
          if (!out) return
          const img = mk('img')
          img.alt = '编辑结果'
          img.src = pluginFileUrl(out) + '&t=' + Date.now()
          resultSlot.replaceChildren(img)
        }
        const runQuick = (payload, label) => {
          if (selected === '') { status.textContent = '先选一张图'; return }
          status.textContent = label + '中…（几十秒，别关窗口）'
          fetch('api/qwen-paint/quick-edit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, image: selected }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!d || d.ok !== true) { status.textContent = '失败：' + (d?.reason ?? '未知原因'); return }
              status.textContent = '完成（' + (d.seconds ?? '?') + 's）'
              showResult(d.path)
            })
            .catch((e) => { status.textContent = '请求失败：' + (e?.message ?? e) })
        }

        card.appendChild(mk('div', 'dshqp-wb-label', '四向扩图（点一下就执行，不用记参数）'))
        const outRow = mk('div', 'dshqp-wb-actions')
        for (const [label, dirs] of [
          ['四周各 20%', { left: 20, right: 20, up: 20, down: 20 }],
          ['左右各 30%', { left: 30, right: 30, up: 0, down: 0 }],
          ['向右扩 50%', { right: 50 }],
          ['向下扩 30%', { down: 30 }],
        ]) outRow.appendChild(mkBtn(label, () => runQuick({ action: 'outpaint', ...dirs }, '扩图')))
        card.appendChild(outRow)

        card.appendChild(mk('div', 'dshqp-wb-label', '高清放大'))
        const upRow = mk('div', 'dshqp-wb-actions')
        for (const s of [2, 4, 8]) upRow.appendChild(mkBtn(s + ' 倍', () => runQuick({ action: 'upscale', scale: s }, '放大')))
        card.appendChild(upRow)

        card.appendChild(mk('div', 'dshqp-wb-label', '③ 结果'))
        card.appendChild(resultSlot)
        const foot = mk('div', 'dshqp-mask-foot')
        foot.appendChild(status)
        foot.appendChild(mkBtn('关闭', close))
        card.appendChild(foot)
        document.body.appendChild(overlay)
        if (selected !== '') status.textContent = '已选：' + (String(selected).split(/[\\/]/u).pop() || selected)
      }

      /** 「圈选重绘最近一张图」：懒人直达，省掉选图那一步；没有图就退到工作台并给指引。 */
      function quickInpaintRecent() {
        fetchRecent()
          .then((j) => {
            const first = j && Array.isArray(j.items) && j.items.length > 0 ? j.items[0].path : ''
            if (first) openInpaintDialog(first)
            else openWorkbench('')
          })
          .catch(() => openWorkbench(''))
      }

      /** 结果文件按扩展名分家：工作台只认图，时间轴只认视频。 */
      const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/iu
      const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv)$/iu

            /** 视频选帧 / 截取时间段：独立浮层、不碰消息树；零依赖那条走浏览器画布，ffmpeg 那条缺件时如实报 needFfmpeg。 */
      function openVideoTimeline(videoPath) {
        if (typeof document === 'undefined' || document.body === null) return
        if (typeof document.querySelectorAll === 'function') {
          for (const el of Array.from(document.querySelectorAll('.dshqp-vid-overlay'))) {
            try { el.remove() } catch (error) { /* 已移除 */ }
          }
        }

        const { overlay, card } = makeOverlay('dshqp-vid-overlay')

        const mk = (tag, cls, text) => {
          const n = document.createElement(tag)
          if (cls) n.className = cls
          if (text !== undefined) n.textContent = text
          return n
        }
        const mkBtn = (text, fn) => {
          const b = mk('button', 'dshqp-mask-btn', text)
          b.type = 'button'
          b.addEventListener('click', fn)
          return b
        }
        const mkNum = (val, min, max) => {
          const i = mk('input', 'dshqp-vid-num')
          i.type = 'number'
          i.min = String(min)
          i.max = String(max)
          i.value = String(val)
          return i
        }
        const close = () => {
          try { if (video) video.pause() } catch (error) { /* 没在播 */ }
          try { thumbVideo.pause() } catch (error) { /* 隐藏的缩略图 video */ }
          try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) } catch (error) { /* 已移除 */ }
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', onKey)
          }
        }
        const onKey = (e) => {
          if (e.key === 'Escape') { close(); return }
          if (e.key === 'ArrowLeft') { step(-1); e.preventDefault() }
          if (e.key === 'ArrowRight') { step(1); e.preventDefault() }
        }
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('keydown', onKey)
        }

        card.appendChild(mk('div', 'dshqp-mask-title', '视频选帧 / 截取时间段'))
        card.appendChild(mk('div', 'dshqp-mask-hint',
          '缩略图点一下就跳；← / → 逐帧。「抽这一帧去修」走浏览器画布（不装东西），'
          + '改完用「把改好的图贴回这一帧」合成新视频；也能框一段时间「截取这一段」。'))

        let currentPath = typeof videoPath === 'string' ? videoPath : ''
        const video = mk('video', 'dshqp-vid')
        video.controls = true
        video.preload = 'metadata'
        video.playsInline = true
        card.appendChild(video)

        // hidden video + canvas: local only, no upload, no ffmpeg
        const thumbTrack = mk('div', 'dshqp-vid-track')
        card.appendChild(thumbTrack)
        const thumbVideo = mk('video')
        thumbVideo.style.display = 'none'
        thumbVideo.preload = 'metadata'
        thumbVideo.muted = true
        card.appendChild(thumbVideo)

        // 选视频：菜单进来时没带路径 → 列出最近的视频让用户点，省掉手抄路径
        const picker = mk('div', 'dshqp-vid-row')
        const pickerHint = mk('span', 'dshqp-vid-lab', currentPath === '' ? '正在找最近的视频…' : '')
        picker.appendChild(pickerHint)
        const pickerList = mk('div', 'dshqp-vid-list')
        card.appendChild(picker)
        card.appendChild(pickerList)

        const meta = mk('div', 'dshqp-vid-meta', '—')
        card.appendChild(meta)

        // 帧率：探测不到就按生成时的默认值，用户可改（改完帧号立刻按新值算）
        const fpsRow = mk('div', 'dshqp-vid-row')
        fpsRow.appendChild(mk('span', 'dshqp-vid-lab', '帧率 fps'))
        const fpsInput = mkNum(24, 1, 240)
        fpsInput.style.width = '72px'
        fpsRow.appendChild(fpsInput)
        fpsRow.appendChild(mk('span', 'dshqp-vid-lab', '（和你生成视频时设的一致即可；不知道就留 24）'))
        card.appendChild(fpsRow)

        // 模式切换：按帧 / 按时间
        let mode = 'frames'
        const modeRow = mk('div', 'dshqp-vid-row')
        const btnFrames = mkBtn('按帧数选', () => setMode('frames'))
        const btnTime = mkBtn('按时间选', () => setMode('time'))
        btnFrames.setAttribute('data-on', '1')
        modeRow.appendChild(btnFrames)
        modeRow.appendChild(btnTime)
        card.appendChild(modeRow)

        const frameRow = mk('div', 'dshqp-vid-row')
        frameRow.appendChild(mk('span', 'dshqp-vid-lab', '起始帧'))
        const startFrameInput = mkNum(0, 0, 999999)
        frameRow.appendChild(startFrameInput)
        frameRow.appendChild(mk('span', 'dshqp-vid-lab', '结束帧'))
        const endFrameInput = mkNum(0, 0, 999999)
        frameRow.appendChild(endFrameInput)
        card.appendChild(frameRow)

        const timeRow = mk('div', 'dshqp-vid-row')
        timeRow.style.display = 'none'
        timeRow.appendChild(mk('span', 'dshqp-vid-lab', '起始时间'))
        const startTimeInput = mk('input', 'dshqp-vid-num')
        startTimeInput.type = 'text'
        startTimeInput.placeholder = '0:00.0'
        timeRow.appendChild(startTimeInput)
        timeRow.appendChild(mk('span', 'dshqp-vid-lab', '结束时间'))
        const endTimeInput = mk('input', 'dshqp-vid-num')
        endTimeInput.type = 'text'
        endTimeInput.placeholder = '0:02.0'
        timeRow.appendChild(endTimeInput)
        card.appendChild(timeRow)

        const advRow = mk('div', 'dshqp-vid-row')
        advRow.appendChild(mk('span', 'dshqp-vid-lab', '每隔 N 帧取一帧'))
        const everyInput = mkNum(1, 1, 999)
        advRow.appendChild(everyInput)
        advRow.appendChild(mk('span', 'dshqp-vid-lab', '最多取几张'))
        const maxInput = mkNum(12, 1, 240)
        advRow.appendChild(maxInput)
        card.appendChild(advRow)

        const navRow = mk('div', 'dshqp-vid-row')
        navRow.appendChild(mkBtn('‹ 上一帧', () => step(-1)))
        navRow.appendChild(mkBtn('下一帧 ›', () => step(1)))
        navRow.appendChild(mkBtn('设为起点', () => markStart()))
        navRow.appendChild(mkBtn('设为终点', () => markEnd()))
        card.appendChild(navRow)

        const actRow = mk('div', 'dshqp-vid-row')
        const btnPickFrame = mkBtn('抽这一帧去修', () => pickCurrentFrame())
        try { btnPickFrame.setAttribute('data-primary', '1') } catch (error) { /* 忽略 */ }
        const btnClip = mkBtn('截取这一段', () => clipSegment())
        const btnBatch = mkBtn('按间隔抽帧', () => batchFrames())
        actRow.appendChild(btnPickFrame)
        actRow.appendChild(btnClip)
        actRow.appendChild(btnBatch)
        const btnReplace = mkBtn('把改好的图贴回这一帧', () => openReplacePicker())
        actRow.appendChild(btnReplace)
        card.appendChild(actRow)

        const replaceRow = mk('div', 'dshqp-vid-row')
        replaceRow.style.display = 'none'
        const replaceHint = mk('span', 'dshqp-vid-lab', '')
        replaceRow.appendChild(replaceHint)
        card.appendChild(replaceRow)
        const replaceList = mk('div', 'dshqp-vid-list')
        card.appendChild(replaceList)

        const resultSlot = mk('div', 'dshqp-wb-result')
        card.appendChild(resultSlot)

        const foot = mk('div', 'dshqp-mask-foot')
        const status = mk('div', 'dshqp-mask-state', currentPath === '' ? '先选一个视频' : '就绪')
        foot.appendChild(status)
        foot.appendChild(mkBtn('关闭', close))
        card.appendChild(foot)

        const fps = () => {
          const v = Number(fpsInput.value)
          return Number.isFinite(v) && v > 0 ? Math.min(240, Math.max(1, v)) : 24
        }
        const curFrame = () => Math.max(0, Math.round((Number(video.currentTime) || 0) * fps()))
        const showMeta = () => {
          const dur = Number.isFinite(video.duration) ? video.duration : 0
          const f = curFrame()
          meta.textContent = `当前 ${video.currentTime.toFixed(2)} s · 第 ${f} 帧 · 总长 ${dur.toFixed(2)} s`
            + `（约 ${Math.max(0, Math.round(dur * fps()))} 帧）`
        }
        const step = (delta) => {
          try {
            video.pause()
            const t = Math.max(0, Math.min(
              Number.isFinite(video.duration) ? video.duration : 1e9,
              (Number(video.currentTime) || 0) + delta / fps(),
            ))
            video.currentTime = t
          } catch (error) { /* 还没元数据 */ }
        }
        const markStart = () => {
          const f = curFrame()
          startFrameInput.value = String(f)
          startTimeInput.value = (Number(video.currentTime) || 0).toFixed(2)
          status.textContent = `起点设为第 ${f} 帧`
        }
        const markEnd = () => {
          const f = curFrame()
          endFrameInput.value = String(f)
          endTimeInput.value = (Number(video.currentTime) || 0).toFixed(2)
          status.textContent = `终点设为第 ${f} 帧`
        }
        function setMode(next) {
          mode = next === 'time' ? 'time' : 'frames'
          btnFrames.setAttribute('data-on', mode === 'frames' ? '1' : '0')
          btnTime.setAttribute('data-on', mode === 'time' ? '1' : '0')
          frameRow.style.display = mode === 'frames' ? '' : 'none'
          timeRow.style.display = mode === 'time' ? '' : 'none'
        }

        /** 组装请求体：两种模式都带上，后端按 mode 取对应那组（不重复换算）。 */
        const selectionBody = () => ({
          mode,
          fps: fps(),
          startFrame: Number(startFrameInput.value) || 0,
          endFrame: Number(endFrameInput.value) || 0,
          startTime: startTimeInput.value,
          endTime: endTimeInput.value,
          everyNth: Number(everyInput.value) || 1,
          maxFrames: Number(maxInput.value) || 12,
        })

        const showImage = (p) => {
          const img = mk('img')
          img.alt = '抽出的帧'
          img.src = pluginFileUrl(p) + '&t=' + Date.now()
          resultSlot.replaceChildren(img)
        }

        /** ★ 零依赖那条路：画布取当前帧 → 落盘 → 直接进圈选重绘。 */
        function pickCurrentFrame() {
          if (currentPath === '') { status.textContent = '先选一个视频'; return }
          if (!video.videoWidth) { status.textContent = '视频还没加载好，等一下再点'; return }
          status.textContent = '正在取出这一帧…'
          try {
            const canvas = document.createElement('canvas')
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
            canvas.getContext('2d').drawImage(video, 0, 0)
            const png = canvas.toDataURL('image/png')
            const frame = curFrame()
            fetch('api/qwen-paint/video/frame-save', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ png, frame }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (!d || d.ok !== true) { status.textContent = '保存这一帧失败：' + (d?.reason ?? '未知原因'); return }
                status.textContent = `已取出第 ${frame} 帧`
                showImage(d.path)
                close()
                openInpaintDialog(d.path)
              })
              .catch((e) => { status.textContent = '请求失败：' + (e?.message ?? e) })
          } catch (error) {
            status.textContent = '取帧失败（浏览器不允许读取这一帧）：' + (error?.message ?? error)
          }
        }

        function clipSegment() {
          if (currentPath === '') { status.textContent = '先选一个视频'; return }
          status.textContent = '正在截取…'
          fetch('api/qwen-paint/video/clip', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: currentPath, ...selectionBody() }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!d || d.ok !== true) {
                status.textContent = d?.needFfmpeg
                  ? '需要 ffmpeg：装一个并加进 PATH（或用 FFMPEG_PATH 指定）后重试；也可以先用「抽这一帧去修」'
                  : '截取失败：' + (d?.reason ?? '未知原因')
                return
              }
              status.textContent = `已截出 ${Number(d.durationSec ?? 0).toFixed(2)} s`
              const v = mk('video', 'dshqp-vid')
              v.controls = true
              v.preload = 'metadata'
              v.src = pluginFileUrl(d.path) + '&t=' + Date.now()
              resultSlot.replaceChildren(v)
              const more = mkBtn('对这一段继续选帧', () => {
                currentPath = d.path
                video.src = pluginFileUrl(d.path) + '&t=' + Date.now()
                try { video.load() } catch (error) { /* 老浏览器 */ }
                status.textContent = '已切到新片段'
              })
              resultSlot.appendChild(more)
            })
            .catch((e) => { status.textContent = '请求失败：' + (e?.message ?? e) })
        }

        /** 按间隔批量抽帧：后端有 ffmpeg 才走得通，逐张抽、进度如实报。 */
        function batchFrames() {
          if (currentPath === '') { status.textContent = '先选一个视频'; return }
          const body = selectionBody()
          const every = Math.max(1, Number(body.everyNth) || 1)
          const max = Math.min(240, Math.max(1, Number(body.maxFrames) || 12))
          const sf = Number(body.startFrame) || 0
          const ef = Number(body.endFrame) || 0
          if (ef < sf) { status.textContent = '结束帧不能小于起始帧'; return }
          const list = []
          for (let f = sf; f <= ef && list.length < max; f += every) list.push(f)
          let i = 0
          let okCount = 0
          const next = () => {
            if (i >= list.length) {
              status.textContent = `抽帧完成：成功 ${okCount} / ${list.length} 张`
              return
            }
            const f = list[i]
            i += 1
            status.textContent = `正在抽第 ${i} / ${list.length} 张（第 ${f} 帧）…`
            fetch('api/qwen-paint/video/frame', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: currentPath, mode: 'frames', fps: fps(), startFrame: f, endFrame: f }),
            })
              .then((r) => r.json())
              .then((d) => {
                if (d && d.ok === true) { okCount += 1; showImage(d.path) }
                else if (d && d.needFfmpeg) {
                  status.textContent = '按间隔抽帧需要 ffmpeg：装一个并加进 PATH；单帧可用「抽这一帧去修」'
                  return
                }
                next()
              })
              .catch(() => next())
          }
          next()
        }

        const THUMB_COUNT = 10
        let thumbSeq = 0, thumbCleanup = null
        function buildThumbs() {
          if (thumbCleanup) { thumbCleanup(); thumbCleanup = null }
          const dur = Number.isFinite(video.duration) ? video.duration : 0
          if (!(dur > 0) || currentPath === '') return
          const mySeq = ++thumbSeq
          thumbTrack.replaceChildren()
          const canvas = document.createElement('canvas')
          let i = 0
          const next = () => { if (mySeq === thumbSeq) thumbVideo.currentTime = Math.min(Math.max(0, dur - 0.02), dur * i / THUMB_COUNT) }
          const onSeeked = () => {
            if (mySeq !== thumbSeq) return
            try {
              const vw = Math.max(1, thumbVideo.videoWidth || 160), vh = Math.max(1, thumbVideo.videoHeight || 90)
              const w = Math.min(160, vw), h = Math.max(1, Math.round(w * vh / vw))
              canvas.width = w; canvas.height = h
              canvas.getContext('2d').drawImage(thumbVideo, 0, 0, w, h)
              const at = Number(thumbVideo.currentTime) || 0, f = Math.round(at * fps())
              const img = mk('img', 'dshqp-vid-thumb')
              img.src = canvas.toDataURL('image/png')
              img.alt = '第 ' + f + ' 帧'
              img.title = '跳到 ' + at.toFixed(2) + ' s'
              img.addEventListener('click', () => { video.currentTime = at; status.textContent = '已跳到第 ' + f + ' 帧' })
              thumbTrack.appendChild(img)
            } catch (error) { /* 取不到就跳过 */ }
            i += 1
            if (i < THUMB_COUNT) next()
            else if (thumbCleanup) { thumbCleanup(); thumbCleanup = null }
          }
          const start = () => { if (mySeq === thumbSeq) next() }
          thumbCleanup = () => { thumbVideo.removeEventListener('seeked', onSeeked); thumbVideo.removeEventListener('loadedmetadata', start) }
          thumbVideo.addEventListener('seeked', onSeeked)
          thumbVideo.addEventListener('loadedmetadata', start, { once: true })
          thumbVideo.src = pluginFileUrl(currentPath) + '&t=' + Date.now()
          try { thumbVideo.load() } catch (error) { /* 老浏览器 */ }
        }
        function openReplacePicker() {
          if (currentPath === '') { status.textContent = '先选一个视频'; return }
          replaceRow.style.display = ''
          replaceHint.textContent = '选一张改好的图：'
          replaceList.replaceChildren()
          fetchRecent()
            .then((j) => {
              const items = (j && Array.isArray(j.items) ? j.items : []).filter((it) => IMAGE_EXT_RE.test(String(it.path)))
              if (items.length === 0) { replaceHint.textContent = '还没有改好的图片，先「抽这一帧去修」'; return }
              items.slice(0, 8).forEach((it, idx) => {
                replaceList.appendChild(mkBtn(it.name || ('图片 ' + (idx + 1)), () => replaceFrameWith(it.path)))
              })
            })
            .catch(() => { replaceHint.textContent = '最近图片读取失败' })
        }
        function replaceFrameWith(imagePath) {
          const frame = curFrame()
          status.textContent = '正在贴回第 ' + frame + ' 帧…'
          fetch('api/qwen-paint/video/replace-frame', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: currentPath, image: imagePath, frame, fps: fps() }),
          }).then((r) => r.json()).then((d) => {
            if (!d || d.ok !== true) {
              status.textContent = d?.needFfmpeg ? '需要 ffmpeg 才能贴回' : '贴回失败：' + (d?.reason ?? '未知原因')
              return
            }
            status.textContent = '已贴回第 ' + frame + ' 帧'
            const v = mk('video', 'dshqp-vid')
            v.controls = true; v.preload = 'metadata'
            v.src = pluginFileUrl(d.path) + '&t=' + Date.now()
            resultSlot.replaceChildren(v)
            resultSlot.appendChild(mkBtn('用新视频继续选帧', () => loadVideo(d.path)))
          }).catch((e) => { status.textContent = '请求失败：' + (e?.message ?? e) })
        }

        video.addEventListener('loadedmetadata', () => {
          const dur = Number.isFinite(video.duration) ? video.duration : 0
          endFrameInput.value = String(Math.max(0, Math.round(dur * fps()) - 1))
          showMeta()
          buildThumbs()
          // 顺手问一下后端有没有 ffmpeg / 真实帧率（有 ffprobe 就用它的权威值）
          if (currentPath !== '') {
            fetch('api/qwen-paint/video/probe?path=' + encodeURIComponent(currentPath), { cache: 'no-store' })
              .then((r) => r.json())
              .then((d) => {
                if (!d || d.ok !== true) return
                if (Number.isFinite(d.fps) && d.fps > 0) fpsInput.value = String(Math.round(d.fps))
                if (Number.isFinite(d.durationSec) && d.durationSec > 0) {
                  endFrameInput.value = String(Math.max(0, Math.round(d.durationSec * fps()) - 1))
                }
                showMeta()
              })
              .catch(() => { /* 没有 ffprobe 就按播放器 + 用户填的 fps 算 */ })
          }
        })
        video.addEventListener('timeupdate', showMeta)
        video.addEventListener('seeked', showMeta)
        fpsInput.addEventListener('change', showMeta)

        const loadVideo = (p) => {
          currentPath = p
          video.src = pluginFileUrl(p) + '&t=' + Date.now()
          try { video.load() } catch (error) { /* 老浏览器 */ }
          status.textContent = '已选：' + (String(p).split(/[\\/]/u).pop() || p)
        }

        if (currentPath !== '') {
          loadVideo(currentPath)
        } else {
          fetchRecent()
            .then((j) => {
              const items = (j && Array.isArray(j.items) ? j.items : []).filter((it) => VIDEO_EXT_RE.test(String(it.path)))
              if (items.length === 0) {
                pickerHint.textContent = '还没找到视频。先在对话里说一句「生成一段 3 秒的视频」，出片后这里就会出现。'
                return
              }
              pickerHint.textContent = '选一个视频：'
              for (const it of items.slice(0, 8)) {
                const b = mkBtn(it.name, () => loadVideo(it.path))
                pickerList.appendChild(b)
              }
            })
            .catch(() => { pickerHint.textContent = '最近视频读取失败；可以先在对话里生成一段视频再来。' })
        }

        document.body.appendChild(overlay)
        setMode('frames')
      }

      function apply(ctx) {
        // ★ 必须用 `!React` 而不是 `React === null`：require('react') 返回 undefined
        //（不抛错）时 React 会是 undefined，`=== null` 拦不住，槽照注册，
        // 组件一渲染就 TypeError 污染 dsh 自己的渲染树（MEMO 里记过这个坑）。
        pingHost('apply')
        loadComfyPipelineSchema()
        loadComfyPipelinePanel()
        loadQpExtras()
        if (!React || typeof React.createElement !== 'function') {
          pingHost('no-react')
          return
        }
        if (ctx === undefined || ctx.slots === undefined) {
          pingHost('no-slots')
          return
        }

// 设计说明已外置 → docs/client-design-notes.md#client-note-073（原 L4502-4506）

        // 两段样式表只差 id / 生成函数 / effect 标签 —— 收成一个注入器。
        //   cardCss / flowGradCss 仍是纯函数、仍在 effect 回调里调用，卸载语义一字未改。
        //   单独两个 style 节点（流光那份由 FLOW_GRADS 单一数据源生成）也照旧。
        const injectStyle = (id, cssFn, label) => {
          try {
            ctx.effect(() => {
              const el = document.createElement('style')
              el.id = id
              el.textContent = cssFn()
              document.head.appendChild(el)
              return () => {
                try { el.remove() } catch (err) { /* 卸载时文件已被移除也无所谓 */ }
              }
            }, label)
          } catch (err) {
            /* 样式失败不影响卡片本身 */
          }
        }
        injectStyle(STYLE_ID, cardCss, 'qwen-paint:style')

        injectStyle(GRAD_STYLE_ID, flowGradCss, 'qwen-paint:grad-style')

        // 只注册 key=toolName 这一个格子；key 未占用 → 不遮蔽任何自带 UI。
        // ★ 整段包 try/catch：槽不存在 / 注册冲突 / 版本差异都**不许**把 dsh 的启动拖垮
        //   （MEMO 记过：自写客户端插件挂槽把界面搞崩过）。失败只 warn，绝不外抛。
        try {
          ctx.slots.inject(SLOT_KEY, () =>
            ctx.slots.register({ name: SLOT_KEY, key: TOOL_KEY }, DrawImageCard),
          )
        } catch (error) {
          warn(`注册 ${SLOT_KEY}[${TOOL_KEY}] 失败，图片卡片不会出现（不影响 dsh 其它功能）：${error && error.message ? error.message : error}`)
        }

        // ComfyUI 在线状态点：挂在 composer **工具行右侧**（发送按钮前面），
        // 避免和左侧控件之间出现大片空白。单个 list 槽，用自定义 id，不抢自带位置。
        try {
          if (typeof React.useRef === 'function' && typeof React.useEffect === 'function') {
            ctx.slots.inject(STATUS_SLOT, () =>
              ctx.slots.register({ name: STATUS_SLOT, id: STATUS_ID, order: 40 }, ComfyStatusSeat),
            )
          } else {
            warn('React 种子缺 useRef/useEffect，跳过 ComfyUI 状态指示器')
          }
        } catch (error) {
          warn(`注册状态指示器失败，状态点不会出现（不影响 dsh 其它功能）：${error && error.message ? error.message : error}`)
        }

        // 走到这里说明两条槽都尝试注册过了 —— 自报一次，便于和上面那些提前 return 区分
        pingHost('registered')
      }

      // ★★ 必须声明 inject：客户端插件的 apply 只在依赖服务就绪后才被调用
      //（照 dsh-reasoning-glow 的写法 `exports.inject = ["slots"]`）。
      // 漏了这句的话 apply 可能在 slots 就绪前就跑，ctx.slots 还是 undefined，
      // apply 里那句守卫会**安静 return** —— 症状是"重启后图永远不显示"，而且不报错。
      exports.inject = ['slots']
      exports.name = PLUGIN_ID
      exports.apply = apply
      // 纯函数测试入口（不含任何 DOM / 网络副作用，供回归套件直接断言）
      exports.__test = {
        loadPersistedWeightCaps, savePersistedWeightCaps, weightOptionsOf,
        WEIGHT_CAPS_KEY, WEIGHT_CAPS_VERSION, WEIGHT_CAPS_TTL,
      }
      return module.exports
    },
  })
}
