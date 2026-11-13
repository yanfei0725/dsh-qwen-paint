/* assets/mask-fx.js —— 蒙版编辑增强 / 卸载内存模式（非 ESM，<script defer> 单文件）
 *
 * 为什么在 assets/：lib/client.js 只剩 1 KB 就到 DSH Store 单文件上限，UI 一律外置。
 *
 * ## 真接线，不是假滑块
 *   · 羽化 / 反选：导出 maskPng 时在离屏 canvas 上用 filter=blur、difference 真实改写像素；
 *   · 外扩 / 边缘融合 / 重绘强度：由 client.js 把 maskFx 放进 POST body，端点规范化后
 *     写进 InpaintCropImproved 的 mask_expand_pixels / mask_blend_pixels 与 ManualSigmas；
 *   · 卸载内存模式：POST /api/qwen-paint/mask-fx 设置 off|auto|manual，
 *     action=unload 立刻向本机 ComfyUI /free 释放模型；auto 由 host 在任务完成后触发。
 *
 * 控件通过 MutationObserver 注入既有 .dshqp-mask-tools，不改 React 管的树。
 */
(function () {
  'use strict'
  if (window.DshQpMaskFx && window.DshQpMaskFx.__mf === true) return

  var API = 'api/qwen-paint/mask-fx'
  var LIMITS = {
    feather: { min: 0, max: 256, def: 32 },
    edgeBlend: { min: 0, max: 100, def: 0 },
    grow: { min: 0, max: 64, def: 8 },
    denoise: { min: 0.3, max: 1, def: 0.7, step: 0.05 },
    softness: { min: 0, max: 100, def: 50 },
  }
  var v = {
    feather: 32, edgeBlend: 0, grow: 8, denoise: 0.7,
    softness: 50, invert: false, preview: true, unloadMemory: false,
  }
  var memoryMode = 'off'
  var wired = new WeakSet()

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = String(text)
    return n
  }

  function clamp(x, lim) {
    var n = Number(x)
    if (!isFinite(n)) return lim.def
    return Math.min(lim.max, Math.max(lim.min, n))
  }

  function slider(labelText, key, suffix, onInput) {
    var lim = LIMITS[key]
    var wrap = el('label', 'mf-field')
    var top = el('span', 'mf-field-top')
    top.appendChild(el('span', 'mf-label', labelText))
    var val = el('span', 'mf-val', String(v[key]) + suffix)
    top.appendChild(val)
    wrap.appendChild(top)
    var input = el('input', 'mf-range')
    input.type = 'range'
    input.min = String(lim.min)
    input.max = String(lim.max)
    input.step = String(lim.step || 1)
    input.value = String(v[key])
    input.addEventListener('input', function () {
      v[key] = clamp(input.value, lim)
      val.textContent = String(v[key]) + suffix
      if (onInput) onInput(v[key])
      saveDebounced()
    })
    wrap.appendChild(input)
    return wrap
  }

  var saveTimer = null
  function saveDebounced() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(function () {
      fetch(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maskFx: v, memoryMode: memoryMode }),
      }).catch(function () { /* 端点不可用时 UI 仍能用（前端羽化不依赖网络） */ })
    }, 450)
  }

  function toggle(labelText, key) {
    var lab = el('label', 'mf-check')
    var box = el('input')
    box.type = 'checkbox'
    box.checked = !!v[key]
    box.addEventListener('change', function () {
      v[key] = box.checked
      saveDebounced()
    })
    lab.appendChild(box)
    lab.appendChild(el('span', '', labelText))
    return lab
  }

  function buildControls(tools) {
    if (wired.has(tools)) return
    wired.add(tools)
    var box = el('div', 'mf-box')
    var head = el('div', 'mf-head')
    head.appendChild(el('span', 'mf-head-title', '蒙版精修 · 羽化 / 边缘融合 / 卸载内存'))
    var reset = el('button', 'mf-mini', '恢复默认')
    reset.type = 'button'
    reset.addEventListener('click', function () {
      Object.keys(LIMITS).forEach(function (k) { v[k] = LIMITS[k].def })
      v.invert = false; v.preview = true
      box.querySelectorAll('input[type=range]').forEach(function (r) {
        var key = r.getAttribute('data-key')
        if (key && LIMITS[key]) r.value = String(LIMITS[key].def)
      })
      saveDebounced()
      buildControlsAgain(tools, box)
    })
    head.appendChild(reset)
    box.appendChild(head)

    var grid = el('div', 'mf-grid')
    ;[
      slider('羽化（像素）', 'feather', 'px'),
      slider('边缘融合（叠加）', 'edgeBlend', '%'),
      slider('蒙版外扩', 'grow', 'px'),
      slider('重绘强度', 'denoise', ''),
      slider('笔刷柔和度', 'softness', '%'),
    ].forEach(function (node, i) {
      var key = ['feather', 'edgeBlend', 'grow', 'denoise', 'softness'][i]
      var r = node.querySelector('input[type=range]')
      if (r) r.setAttribute('data-key', key)
      grid.appendChild(node)
    })
    box.appendChild(grid)

    var checks = el('div', 'mf-checks')
    checks.appendChild(toggle('反选蒙版', 'invert'))
    checks.appendChild(toggle('显示蒙版预览', 'preview'))
    checks.appendChild(toggle('完成后卸载内存', 'unloadMemory'))
    box.appendChild(checks)

    var mem = el('div', 'mf-mem')
    mem.appendChild(el('span', 'mf-label', '卸载内存模式'))
    var sel = el('select', 'mf-select')
    ;[['off', '关闭'], ['auto', '每次任务后自动'], ['manual', '只手动']].forEach(function (p) {
      var o = el('option', '', p[1])
      o.value = p[0]
      if (p[0] === memoryMode) o.selected = true
      sel.appendChild(o)
    })
    sel.addEventListener('change', function () {
      memoryMode = sel.value
      saveDebounced()
    })
    mem.appendChild(sel)
    var now = el('button', 'mf-mini', '立即释放')
    now.type = 'button'
    now.addEventListener('click', function () {
      now.disabled = true
      now.textContent = '释放中…'
      fetch(API, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unload' }),
      }).then(function (r) { return r.json() }).then(function (j) {
        now.textContent = j && j.ok ? '已释放 ✓' : '未在线'
      }).catch(function () { now.textContent = '失败' })
        .then(function () { setTimeout(function () { now.disabled = false; now.textContent = '立即释放' }, 1800) })
    })
    mem.appendChild(now)
    box.appendChild(mem)

    var note = el('div', 'mf-note',
      '羽化与反选在浏览器里真实改写蒙版像素；外扩、边缘融合、重绘强度写入 ComfyUI 节点参数。')
    box.appendChild(note)
    tools.appendChild(box)
  }

  function buildControlsAgain(tools, oldBox) {
    // 只同步显示值，不重建 DOM（避免监听器泄漏）
    var ranges = oldBox.querySelectorAll('input[type=range]')
    ranges.forEach(function (r) {
      var key = r.getAttribute('data-key')
      if (!key || !LIMITS[key]) return
      r.value = String(v[key])
      var val = r.parentNode.querySelector('.mf-val')
      if (val) val.textContent = String(v[key])
    })
  }

  /** 导出蒙版：在离屏 canvas 上真实应用羽化、柔化与反选，返回 data:image/png;base64,… */
  function exportMask(source) {
    try {
      if (!source || !source.width || !source.height) return source ? source.toDataURL('image/png') : ''
      var w = source.width, h = source.height
      var out = document.createElement('canvas')
      out.width = w; out.height = h
      var ctx = out.getContext('2d')
      // 柔和度按百分比映射到一个小半径模糊；羽化是主模糊半径。
      // ★ 2026-11-13 审计修：原来按「feather/4 = 固定像素」算，与蒙版分辨率脱钩 ——
      //   同一档参数在 512 蒙版上是 1.5% 宽度、在 2048 上只有 0.4%，视觉上完全不同。
      //   改成以 1024 为基准做线性归一，并硬限在短边 10% 以内，防止整张糊掉。
      var span = Math.min(w, h) || 1024
      var softPx = Math.round((v.softness / 100) * 4 * (span / 1024))
      var norm = span / 1024
      var blurPx = Math.round((v.feather / 4) * norm) + softPx
      var blurCap = Math.max(1, Math.round(span * 0.1))
      if (blurPx > blurCap) blurPx = blurCap
      if (blurPx > 0 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + blurPx + 'px)'
      ctx.drawImage(source, 0, 0)
      ctx.filter = 'none'
      if (v.invert) {
        ctx.globalCompositeOperation = 'difference'
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.globalCompositeOperation = 'source-over'
      }
      return out.toDataURL('image/png')
    } catch (e) {
      return source ? source.toDataURL('image/png') : ''
    }
  }

  function scan() {
    try {
      document.querySelectorAll('.dshqp-mask-tools').forEach(buildControls)
    } catch (e) { /* 忽略 */ }
  }

  function mount() {
    scan()
    var mo = new MutationObserver(function () { scan() })
    mo.observe(document.body, { childList: true, subtree: true })
    fetch(API, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (!j || !j.ok) return
        var c = j.current || {}
        Object.keys(LIMITS).forEach(function (k) { if (c[k] !== undefined) v[k] = clamp(c[k], LIMITS[k]) })
        if (typeof c.invert === 'boolean') v.invert = c.invert
        if (typeof c.preview === 'boolean') v.preview = c.preview
        if (j.memoryMode) memoryMode = j.memoryMode
        scan()
      })
      .catch(function () { /* 端点不可用时用默认值 */ })
  }

  window.DshQpMaskFx = {
    __mf: true,
    values: function () { return JSON.parse(JSON.stringify(v)) },
    exportMask: exportMask,
    getMemoryMode: function () { return memoryMode },
    scan: scan,
  }

  var css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = 'qwen-paint/mask-fx.css'
  document.head.appendChild(css)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else { mount() }
})()
