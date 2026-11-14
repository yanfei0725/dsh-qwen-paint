/**
 * assets/draft.js —— D25 草图台（Canvas 手绘 → 出图参考）。
 *
 * 为什么需要它：千问的图生图/局部重绘都要一张"底图"，但用户的构图往往还在脑子里。
 * 让他先画一张粗糙的线稿，比让他写三百字描述有效得多。
 *
 * ★ 三条设计约束（与 history.js 同口径）：
 *   ① 不用 innerHTML —— 一律 createElement + textContent，杜绝注入面；
 *   ② 不引外部资源 —— 不加载任何 CDN/字体/图片，离线可用；
 *   ③ 只发本机相对路径请求 —— 不拼绝对 URL，也不把数据发到外部。
 *
 * ★ 草稿**不进生成历史**：它没有 prompt / seed / 模型，混进历史会让"最近生成了什么"变脏。
 *   这里只把 PNG 落盘并把绝对路径交回，用户/Agent 拿它当 reference 继续画。
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (window.DshQpDraft && window.DshQpDraft.__dr === true) return

  var SIZES = [512, 768]
  var MAX_UNDO = 12
  var SAVE_API = 'api/qwen-paint/draft'

  var state = { size: 512, brush: 8, eraser: false, undo: [], drawing: false, last: null, saved: '' }
  var els = {}
  var overlay = null

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  /** ★ 0.32.1 审计 A3：与 assets/history.js 同口径的四事件源点按。
   *  DSH 宿主会吞掉 click（pointerdown 被 preventDefault / 指针轻移 / 文字选中），
   *  只绑 click + touchend 会重现用户报过两次的「点不动」。
   *  冷却去重保证同一手势里四种事件只算一次。 */
  var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']
  function tap(node, fn) {
    var lastAt = 0
    function fire(ev) {
      var now = Date.now()
      if (now - lastAt < 300) return
      lastAt = now
      fn(ev)
    }
    for (var i = 0; i < TAP_UP.length; i += 1) node.addEventListener(TAP_UP[i], fire)
  }

  function injectCss() {
    if (document.getElementById('dshqp-draft-css')) return
    var l = document.createElement('link')
    l.id = 'dshqp-draft-css'
    l.rel = 'stylesheet'
    l.href = 'qwen-paint/draft.css'
    document.head.appendChild(l)
  }

  /* ------------------------------------------------------------ 画布 ---- */

  function ctx2d() { return els.canvas && els.canvas.getContext ? els.canvas.getContext('2d') : null }

  function paintBackground(c) {
    // ★ 必须铺白底：透明底 PNG 在部分环节会被当成"空图"，也会让线稿看不清。
    c.fillStyle = '#ffffff'
    c.fillRect(0, 0, els.canvas.width, els.canvas.height)
  }

  function snapshot() {
    if (state.undo.length >= MAX_UNDO) state.undo.shift()
    try { state.undo.push(els.canvas.toDataURL('image/png')) } catch (e) { /* 画布被污染时忽略 */ }
  }

  function restore(dataUrl) {
    var c = ctx2d()
    if (!c || !dataUrl) return
    var img = new Image()
    img.onload = function () {
      c.clearRect(0, 0, els.canvas.width, els.canvas.height)
      c.drawImage(img, 0, 0)
    }
    img.src = dataUrl
  }

  function posOf(ev) {
    var r = els.canvas.getBoundingClientRect()
    var x = (ev.clientX - r.left) * (els.canvas.width / (r.width || els.canvas.width))
    var y = (ev.clientY - r.top) * (els.canvas.height / (r.height || els.canvas.height))
    return { x: x, y: y }
  }

  function strokeTo(p) {
    var c = ctx2d()
    if (!c || !state.last) return
    c.strokeStyle = state.eraser ? '#ffffff' : '#111111'
    c.lineWidth = state.eraser ? state.brush * 2.2 : state.brush
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.beginPath()
    c.moveTo(state.last.x, state.last.y)
    c.lineTo(p.x, p.y)
    c.stroke()
    state.last = p
  }

  function bindCanvas() {
    var cv = els.canvas
    cv.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return
      state.drawing = true
      snapshot()
      state.last = posOf(ev)
      if (cv.setPointerCapture) { try { cv.setPointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ } }
      // 单击也要留一个点，否则轻点一下什么都看不到。
      strokeTo({ x: state.last.x + 0.01, y: state.last.y + 0.01 })
      ev.preventDefault()
    })
    cv.addEventListener('pointermove', function (ev) {
      if (!state.drawing) return
      strokeTo(posOf(ev))
      ev.preventDefault()
    })
    var stop = function () { state.drawing = false; state.last = null }
    cv.addEventListener('pointerup', stop)
    cv.addEventListener('pointercancel', stop)
    cv.addEventListener('pointerleave', stop)
  }

  function resizeCanvas(size) {
    state.size = SIZES.indexOf(size) >= 0 ? size : SIZES[0]
    els.canvas.width = state.size
    els.canvas.height = state.size
    state.undo = []
    paintBackground(ctx2d())
    paintStatus('')
  }

  /* ------------------------------------------------------------ 面板 ---- */

  function paintStatus(msg, isErr) {
    if (!els.status) return
    els.status.textContent = msg || ''
    els.status.className = 'dshqp-dr-status' + (isErr ? ' dshqp-dr-bad' : '')
  }

  function buildPanel() {
    var ov = el('div', 'dshqp-dr-mask')
    ov.setAttribute('role', 'dialog')
    ov.setAttribute('aria-label', '草图台')
    var box = el('div', 'dshqp-dr-box')

    var head = el('div', 'dshqp-dr-head')
    head.appendChild(el('div', 'dshqp-dr-title', '草图台 · 手绘一张当参考'))
    var x = el('button', 'dshqp-dr-x', '×')
    x.type = 'button'
    x.setAttribute('aria-label', '关闭')
    tap(x, function () { close() })
    head.appendChild(x)
    box.appendChild(head)

    box.appendChild(el('div', 'dshqp-dr-tip',
      '画个大概就行：轮廓、明暗块、主体位置。导出后把路径填进 draw_image 的 reference。'
      + '线稿越好，出图越接近；画布 512 够用，细节多再用 768。'))

    var cv = document.createElement('canvas')
    cv.className = 'dshqp-dr-canvas'
    cv.width = state.size
    cv.height = state.size
    els.canvas = cv
    var wrap = el('div', 'dshqp-dr-canvaswrap')
    wrap.appendChild(cv)
    box.appendChild(wrap)

    var bar = el('div', 'dshqp-dr-bar')

    var pen = el('button', 'dshqp-dr-btn dshqp-dr-on', '画笔')
    pen.type = 'button'
    var era = el('button', 'dshqp-dr-btn', '橡皮')
    era.type = 'button'
    function setEraser(on) {
      state.eraser = on
      pen.className = 'dshqp-dr-btn' + (on ? '' : ' dshqp-dr-on')
      era.className = 'dshqp-dr-btn' + (on ? ' dshqp-dr-on' : '')
    }
    tap(pen, function () { setEraser(false) })
    tap(era, function () { setEraser(true) })
    bar.appendChild(pen)
    bar.appendChild(era)

    var sizeSel = document.createElement('select')
    sizeSel.className = 'dshqp-dr-sel'
    for (var i = 0; i < SIZES.length; i += 1) {
      var o = document.createElement('option')
      o.value = String(SIZES[i])
      o.textContent = SIZES[i] + '×' + SIZES[i]
      if (SIZES[i] === state.size) o.selected = true
      sizeSel.appendChild(o)
    }
    sizeSel.addEventListener('change', function () { resizeCanvas(Number(sizeSel.value)) })
    bar.appendChild(sizeSel)

    var brush = document.createElement('input')
    brush.type = 'range'
    brush.min = '2'
    brush.max = '32'
    brush.value = String(state.brush)
    brush.className = 'dshqp-dr-range'
    brush.setAttribute('aria-label', '笔刷粗细')
    brush.addEventListener('input', function () { state.brush = Number(brush.value) || 8 })
    bar.appendChild(brush)
    box.appendChild(bar)

    var bar2 = el('div', 'dshqp-dr-bar')
    var undo = el('button', 'dshqp-dr-btn', '撤销')
    undo.type = 'button'
    tap(undo, function () {
      if (state.undo.length === 0) { paintStatus('没有可撤销的操作了'); return }
      var last = state.undo.pop()
      var c = ctx2d()
      if (c) { c.clearRect(0, 0, els.canvas.width, els.canvas.height) }
      paintBackground(ctx2d())
      restore(last)
      paintStatus('已撤销一步')
    })
    var clear = el('button', 'dshqp-dr-btn', '清空')
    clear.type = 'button'
    tap(clear, function () {
      snapshot()
      paintBackground(ctx2d())
      paintStatus('已清空')
    })
    bar2.appendChild(undo)
    bar2.appendChild(clear)
    box.appendChild(bar2)

    var actions = el('div', 'dshqp-dr-bar')
    var saveBtn = el('button', 'dshqp-dr-btn dshqp-dr-primary', '导出并复制路径')
    saveBtn.type = 'button'
    // ⚠ 这里曾经写成 `tap(save, function(){ save(save) })`：按钮变量覆盖了同名函数，
    //   点下去会把 button 当函数调，直接抛 TypeError。名字必须分开。
    tap(saveBtn, function () { doSave(saveBtn) })
    var copy = el('button', 'dshqp-dr-btn', '再复制一次')
    copy.type = 'button'
    tap(copy, function () { copyPath() })
    actions.appendChild(saveBtn)
    actions.appendChild(copy)
    box.appendChild(actions)

    els.status = el('div', 'dshqp-dr-status')
    box.appendChild(els.status)

    var pathBox = el('div', 'dshqp-dr-path')
    els.pathEl = pathBox
    box.appendChild(pathBox)

    ov.appendChild(box)
    // 点遮罩空白处退出 —— 与其它浮层一致（用户两次反馈"关不掉"）。
    tap(ov, function (ev) { if (ev.target === ov) close() })
    return ov
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
        return true
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch (e2) { return false }
  }

  function copyPath() {
    if (!state.saved) { paintStatus('还没有导出的路径', true); return }
    paintStatus(copyText(state.saved) ? '路径已复制' : '复制失败，请手动选中路径', false)
  }

  function doSave(btn) {
    var c = ctx2d()
    if (!c) { paintStatus('画布不可用（浏览器不支持 canvas）', true); return }
    btn.disabled = true
    paintStatus('正在保存…')
    var dataUrl
    try {
      dataUrl = els.canvas.toDataURL('image/png')
    } catch (e) {
      btn.disabled = false
      paintStatus('导出失败：' + (e && e.message ? e.message : '未知原因'), true)
      return
    }
    fetch(SAVE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ data_url: dataUrl }),
    }).then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        btn.disabled = false
        if (!j || j.ok !== true) {
          paintStatus((j && j.reason) ? String(j.reason) : '保存失败（接口没有返回原因）', true)
          return
        }
        state.saved = String(j.path || '')
        els.pathEl.textContent = state.saved
        els.pathEl.title = state.saved
        paintStatus('已保存 ' + j.bytes + ' 字节；路径已复制，填进 draw_image 的 reference 即可')
        copyText(state.saved)
      })
      .catch(function (e) {
        btn.disabled = false
        paintStatus('保存失败：' + (e && e.message ? e.message : '网络错误'), true)
      })
  }

  function open() {
    if (!overlay) return
    if (overlay.parentNode === null) document.body.appendChild(overlay)
    overlay.hidden = false
    if (els.canvas && els.canvas.width === 0) resizeCanvas(state.size)
    else if (state.undo.length === 0) paintBackground(ctx2d())
  }

  function close() {
    if (overlay) overlay.hidden = true
  }

  /* --------------------------------------------------------- 菜单注入 ---- */

  function scanMenu() {
    if (typeof document.querySelectorAll !== 'function') return
    var menus = document.querySelectorAll('.dshqp-menu')
    for (var i = 0; i < menus.length; i += 1) {
      var m = menus[i]
      if (typeof m.querySelector === 'function' && m.querySelector('[data-dshqp-draft="1"]')) continue
      var item = el('button', 'dshqp-menu-item', '草图台（手绘一张当参考）')
      item.type = 'button'
      item.setAttribute('data-dshqp-draft', '1')
      tap(item, function () { open() })
      m.insertBefore(item, m.firstChild)
    }
  }

  function mount() {
    injectCss()
    overlay = buildPanel()
    document.body.appendChild(overlay)
    overlay.hidden = true
    bindCanvas()
    paintBackground(ctx2d())
    scanMenu()
    document.addEventListener('keydown', function (ev) {
      if (String(ev && ev.key) !== 'Escape') return
      close()
    })
    var mo = new MutationObserver(function () { scanMenu() })
    mo.observe(document.body, { childList: true, subtree: true })
  }

  window.DshQpDraft = {
    __dr: true,
    open: open,
    close: close,
    getState: function () {
      return { size: state.size, brush: state.brush, eraser: state.eraser, saved: state.saved, undo: state.undo.length }
    },
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
}())
