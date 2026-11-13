/* assets/history.js —— 生成历史浮层（非 ESM，<script defer> 单文件）
 *
 * 为什么在 assets/：lib/client.js 贴着 DSH Store 单文件上限（余量不到 1 KB），
 * 新 UI 一律外置，client.js 只留一行挂载（loadQpExtras 的数组元素）。
 *
 * ## 入口怎么进
 *   lib/client.js 的菜单是**一次性建好、常驻 DOM** 的，本文件用 MutationObserver
 *   在 .dshqp-menu 出现时插一组「历史」到最前面（与 mask-fx.js 注入 .dshqp-mask-tools
 *   同一套手法），不改 React 管的树、也不改 client.js 的体积。
 *
 * ## 数据从哪来
 *   GET  api/qwen-paint/history        搜索 / 类型 / 日期 / 分页
 *   GET  api/qwen-paint/history/stats  总数与各类型（本面板用来显示「共 N 条」）
 *   POST api/qwen-paint/history/delete 软删除（只改 deleted=1，**绝不删磁盘文件**）
 *
 * ## 降级是**如实说**，不是假装有数据
 *   持久化依赖 Node 内置的 node:sqlite（Node >= 22.5）。低版本时后端返回
 *   available=false、persistent=false，面板会明说「本次会话只能看到既有记忆日志」，
 *   不编造、不静默空列表。
 *
 * ## 点击为什么监听四种事件
 *   2026-11-13 用户两次报「点不动」：DSH 宿主会吞 click（assets/panel.js 早有踩坑记录）。
 *   这里与 setup-guide.js / cpu-accel.js / mask-fx.js 同口径：click / pointerup /
 *   mouseup / touchend 全监听 + 300ms 冷却去重，不再赌宿主放哪一种。
 */
(function () {
  'use strict'
  if (window.DshQpHistory && window.DshQpHistory.__hs === true) return

  var LIST_API = 'api/qwen-paint/history'
  var STATS_API = 'api/qwen-paint/history/stats'
  var DEL_API = 'api/qwen-paint/history/delete'
  var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']
  var PAGE = 20

  var KINDS = [
    { id: '', label: '全部类型' },
    { id: 'image', label: '图片' },
    { id: 'video', label: '视频' },
    { id: 'audio', label: '音频' },
    { id: 'other', label: '其它' },
  ]

  var state = {
    keyword: '',
    kind: '',
    from: '',
    to: '',
    offset: 0,
    items: [],
    total: 0,
    available: false,
    persistent: false,
    reason: '',
    busy: false,
    note: '',
  }
  var els = {}
  var previewEl = null
  var seq = 0

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined) n.textContent = String(text)
    return n
  }

  /** 四种 up 事件全监听 + 冷却去重；打标记让 setup-guide 的兜底补发不重复触发。 */
  function tap(node, fn) {
    if (!node || typeof node.addEventListener !== 'function') return
    if (typeof node.setAttribute === 'function') node.setAttribute('data-dshqp-direct', '1')
    var last = 0
    var run = function (ev) {
      var now = Date.now()
      if (now - last < 300) return
      last = now
      fn(ev)
    }
    for (var i = 0; i < TAP_UP.length; i += 1) node.addEventListener(TAP_UP[i], run)
  }

  function fileUrl(p) {
    return 'api/qwen-paint/file?path=' + encodeURIComponent(String(p || ''))
  }

  function fmtTime(iso) {
    var s = String(iso || '')
    if (s.length < 16) return s
    // 后端统一 ISO 8601（UTC）；这里只做「本地时区 YYYY-MM-DD HH:mm」的轻量呈现。
    var d = new Date(s)
    if (isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ')
    var p2 = function (n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
      + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
  }

  function kindLabel(k) {
    for (var i = 0; i < KINDS.length; i += 1) if (KINDS[i].id === k) return KINDS[i].label
    return '其它'
  }

  /* ------------------------------------------------------------------ 数据 ---- */

  function buildQuery() {
    var q = []
    if (state.keyword) q.push('q=' + encodeURIComponent(state.keyword))
    if (state.kind) q.push('kind=' + encodeURIComponent(state.kind))
    if (state.from) q.push('from=' + encodeURIComponent(state.from))
    if (state.to) q.push('to=' + encodeURIComponent(state.to))
    q.push('limit=' + PAGE)
    q.push('offset=' + state.offset)
    return LIST_API + '?' + q.join('&')
  }

  function load() {
    var mine = ++seq
    state.busy = true
    paintState('正在读取历史…')
    fetch(buildQuery(), { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        if (mine !== seq) return   // 连点查询时只认最后一次，避免旧结果覆盖新结果
        state.busy = false
        if (!j || j.ok !== true) {
          state.items = []
          state.total = 0
          state.note = (j && j.reason) ? String(j.reason) : '历史暂不可用'
          paintList()
          paintState(state.note)
          return
        }
        state.items = Array.isArray(j.items) ? j.items : []
        state.total = Number(j.total) || 0
        state.available = j.available === true
        state.persistent = j.persistent === true
        state.reason = String(j.reason || '')
        state.note = ''
        paintList()
        paintState('')
      })
      .catch(function () {
        if (mine !== seq) return
        state.busy = false
        state.items = []
        state.total = 0
        paintList()
        paintState('连不上本机端点（插件可能刚被停用）')
      })
  }

  function removeItem(item) {
    if (!item || !(Number(item.id) > 0)) {
      paintState('这条记录来自会话日志，不能从历史里移除')
      return
    }
    paintState('正在移除…')
    fetch(DEL_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ id: Number(item.id) }),
    })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        if (!j || j.ok !== true) { paintState((j && j.reason) || '移除失败'); return }
        // 移除后当前页可能空掉：回退一页再刷新，别让用户对着空白猜。
        if (state.items.length === 1 && state.offset >= PAGE) state.offset -= PAGE
        load()
        paintState(j.removed ? '已从历史里移除（磁盘文件保留）' : '记录不存在或已被移除')
      })
      .catch(function () { paintState('移除请求失败（本机端点无响应）') })
  }

  /* ------------------------------------------------------------------ 渲染 ---- */

  function paintState(extra) {
    if (!els.state) return
    var bits = []
    if (state.total > 0) bits.push('共 ' + state.total + ' 条')
    if (state.available === false && els.state.dataset.loaded === '1') {
      bits.push('未持久化' + (state.reason ? '（' + state.reason + '）' : ''))
    }
    if (extra) bits.push(extra)
    if (state.note) bits.push(state.note)
    els.state.textContent = bits.join(' · ')
  }

  function badge(kind) {
    var b = el('span', 'hs-badge hs-badge-' + kind, kindLabel(kind).slice(0, 1))
    return b
  }

  function paintList() {
    if (!els.list) return
    els.list.dataset.loaded = '1'
    if (els.state) els.state.dataset.loaded = '1'
    while (els.list.firstChild) els.list.removeChild(els.list.firstChild)

    if (!state.items.length) {
      var empty = el('div', 'hs-empty', state.available === false
        ? '没有可显示的记录。当前 Node 版本没有 node:sqlite，历史不持久化 —— 这只影响"翻旧账"，不影响出图。'
        : '没有匹配的记录。试试清空关键词或放宽日期范围。')
      els.list.appendChild(empty)
      paintPager()
      return
    }

    for (var i = 0; i < state.items.length; i += 1) els.list.appendChild(rowEl(state.items[i]))
    paintPager()
  }

  function rowEl(it) {
    var kind = String(it.kind || 'other')
    var row = el('div', 'hs-row')
    row.setAttribute('data-kind', kind)

    var thumb = el('div', 'hs-thumb')
    var abs = it.path
    if (kind === 'image') {
      var img = el('img')
      img.loading = 'lazy'
      img.alt = ''
      img.src = it.preview_url || fileUrl(abs)
      thumb.appendChild(img)
    } else {
      thumb.appendChild(badge(kind))
    }
    tap(thumb, function () { openPreview(it) })
    row.appendChild(thumb)

    var body = el('div', 'hs-body')
    body.appendChild(el('div', 'hs-prompt', it.prompt ? String(it.prompt) : '（无提示词）'))
    var meta = []
    meta.push(fmtTime(it.created_at))
    if (it.tool_name) meta.push(String(it.tool_name))
    if (it.model) meta.push(String(it.model))
    if (it.width && it.height) meta.push(it.width + '×' + it.height)
    if (it.steps) meta.push('步数 ' + it.steps)
    body.appendChild(el('div', 'hs-meta', meta.join(' · ')))
    row.appendChild(body)

    var acts = el('div', 'hs-acts')
    var bOpen = el('button', 'hs-btn', kind === 'image' ? '看大图' : '预览')
    bOpen.type = 'button'
    tap(bOpen, function () { openPreview(it) })
    acts.appendChild(bOpen)

    var bCopy = el('button', 'hs-btn', '复制路径')
    bCopy.type = 'button'
    tap(bCopy, function () {
      var text = String(abs || '')
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { paintState('路径已复制') },
            function () { paintState('复制失败，请手动选中') })
          return
        }
      } catch (e) { /* 落到下面的兜底 */ }
      paintState('这个环境不支持一键复制：' + text.slice(-40))
    })
    acts.appendChild(bCopy)

    var bDel = el('button', 'hs-btn hs-btn-danger', '移除')
    bDel.type = 'button'
    bDel.title = '只从历史列表移除，不会删除磁盘上的文件'
    tap(bDel, function () { removeItem(it) })
    acts.appendChild(bDel)

    row.appendChild(acts)
    return row
  }

  function paintPager() {
    if (!els.pager) return
    while (els.pager.firstChild) els.pager.removeChild(els.pager.firstChild)
    var page = Math.floor(state.offset / PAGE) + 1
    var pages = Math.max(1, Math.ceil(state.total / PAGE))
    var prev = el('button', 'hs-btn', '上一页')
    prev.type = 'button'
    prev.disabled = state.offset <= 0
    tap(prev, function () { state.offset = Math.max(0, state.offset - PAGE); load() })
    var info = el('span', 'hs-page', '第 ' + page + ' / ' + pages + ' 页')
    var next = el('button', 'hs-btn', '下一页')
    next.type = 'button'
    next.disabled = state.offset + PAGE >= state.total
    tap(next, function () { state.offset += PAGE; load() })
    els.pager.appendChild(prev)
    els.pager.appendChild(info)
    els.pager.appendChild(next)
  }

  /* ---------------------------------------------------------------- 大图预览 ---- */

  function closePreview() {
    if (!previewEl) return
    try { if (previewEl.parentNode) previewEl.parentNode.removeChild(previewEl) } catch (e) { /* 已移除 */ }
    previewEl = null
  }

  function openPreview(it) {
    closePreview()
    var kind = String(it.kind || 'other')
    var src = fileUrl(it.path)
    var ov = el('div', 'hs-preview')
    tap(ov, function (ev) { if (ev.target === ov) closePreview() })
    var card = el('div', 'hs-preview-card')
    if (kind === 'video') {
      var v = el('video', 'hs-preview-media')
      v.controls = true
      v.autoplay = false
      v.src = src
      card.appendChild(v)
    } else if (kind === 'audio') {
      var a = el('audio')
      a.controls = true
      a.src = src
      card.appendChild(a)
    } else {
      var im = el('img', 'hs-preview-media')
      im.alt = ''
      im.src = src
      card.appendChild(im)
    }
    if (it.prompt) card.appendChild(el('div', 'hs-preview-prompt', it.prompt))
    var closeBtn = el('button', 'hs-btn', '关闭（Esc）')
    closeBtn.type = 'button'
    tap(closeBtn, closePreview)
    card.appendChild(closeBtn)
    ov.appendChild(card)
    document.body.appendChild(ov)
    previewEl = ov
  }

  /* ------------------------------------------------------------------ 面板 ---- */

  function buildPanel() {
    var ov = el('div', 'hs-overlay')
    tap(ov, function (ev) { if (ev.target === ov) close() })
    var card = el('div', 'hs-card')
    ov.appendChild(card)

    var head = el('div', 'hs-head')
    head.appendChild(el('div', 'hs-title', '生成历史'))
    var closeBtn = el('button', 'hs-x', '×')
    closeBtn.type = 'button'
    closeBtn.title = '关闭（Esc）'
    tap(closeBtn, close)
    head.appendChild(closeBtn)
    card.appendChild(head)

    card.appendChild(el('div', 'hs-sub',
      '这里列出本机出过的图 / 视频 / 音频。可以按关键词、类型、日期翻旧账；「移除」只是从列表里划掉，磁盘上的文件不会动。'))

    var filters = el('div', 'hs-filters')
    var kw = el('input', 'hs-input')
    kw.type = 'search'
    kw.placeholder = '搜提示词 / 文件名 / 模型…'
    kw.value = state.keyword
    var timer = 0
    kw.addEventListener('input', function () {
      // 输入防抖 350ms：边打边查会把 SQLite 打成一串短查询，体验反而卡。
      if (timer) clearTimeout(timer)
      timer = setTimeout(function () {
        timer = 0
        state.keyword = String(kw.value || '').trim()
        state.offset = 0
        load()
      }, 350)
    })
    filters.appendChild(kw)

    var sel = el('select', 'hs-select')
    for (var i = 0; i < KINDS.length; i += 1) {
      var o = el('option', '', KINDS[i].label)
      o.value = KINDS[i].id
      if (KINDS[i].id === state.kind) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', function () {
      state.kind = String(sel.value || '')
      state.offset = 0
      load()
    })
    filters.appendChild(sel)

    var from = el('input', 'hs-date')
    from.type = 'date'
    from.title = '起始日期'
    from.value = state.from
    from.addEventListener('change', function () {
      state.from = String(from.value || '')
      state.offset = 0
      load()
    })
    filters.appendChild(from)

    var to = el('input', 'hs-date')
    to.type = 'date'
    to.title = '结束日期'
    to.value = state.to
    to.addEventListener('change', function () {
      state.to = String(to.value || '')
      state.offset = 0
      load()
    })
    filters.appendChild(to)

    var reset = el('button', 'hs-btn', '重置')
    reset.type = 'button'
    tap(reset, function () {
      state.keyword = ''; state.kind = ''; state.from = ''; state.to = ''; state.offset = 0
      kw.value = ''; sel.value = ''; from.value = ''; to.value = ''
      load()
    })
    filters.appendChild(reset)
    card.appendChild(filters)

    els.state = el('div', 'hs-state', '正在读取历史…')
    card.appendChild(els.state)

    els.list = el('div', 'hs-list')
    card.appendChild(els.list)

    els.pager = el('div', 'hs-pager')
    card.appendChild(els.pager)

    return ov
  }

  function injectCss() {
    if (document.getElementById('dshqp-history-css')) return
    var l = document.createElement('link')
    l.id = 'dshqp-history-css'
    l.rel = 'stylesheet'
    l.href = 'qwen-paint/history.css'
    document.head.appendChild(l)
  }

  function open() {
    if (!els.overlay) return
    if (els.overlay.parentNode === null) document.body.appendChild(els.overlay)
    els.overlay.hidden = false
    load()
    // fetch stats 只为顶栏「共 N 条」——失败也不影响列表（列表自己带 total）。
    fetch(STATS_API, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (j) {
        if (!j || j.ok !== true) return
        if (Number(j.total) > state.total) { state.total = Number(j.total); paintPager() }
        paintState('')
      })
      .catch(function () { /* 汇总拿不到就用列表里的 total */ })
  }

  function close() {
    closePreview()
    if (els.overlay) els.overlay.hidden = true
  }

  /* --------------------------------------------------------------- 菜单注入 ---- */

  function scanMenu() {
    if (typeof document.querySelectorAll !== 'function') return
    var menus = document.querySelectorAll('.dshqp-menu')
    for (var i = 0; i < menus.length; i += 1) {
      var m = menus[i]
      // 用「条目还在不在」判定，而不是给菜单打标记：client.js 虽然目前只建一次菜单，
      // 但将来若改成每次重建，标记式写法会永久漏注入。
      if (typeof m.querySelector === 'function' && m.querySelector('[data-dshqp-hist="1"]')) continue
      var head = el('div', 'dshqp-menu-head', '历史')
      var item = el('button', 'dshqp-menu-item dshqp-menu-hot', '生成历史（搜索 / 筛选 / 复用）')
      item.type = 'button'
      item.setAttribute('data-dshqp-hist', '1')
      tap(item, function () { open() })
      // 插到最前面：用户的原话是「入口藏得太隐蔽」，历史是高频动作，值得第一眼就看到。
      m.insertBefore(item, m.firstChild)
      m.insertBefore(head, item)
    }
  }

  function mount() {
    injectCss()
    els.overlay = buildPanel()
    document.body.appendChild(els.overlay)
    els.overlay.hidden = true
    scanMenu()
    // ★ Escape 必退：用户 2026-11-13 两次报「关不掉」，就是只留指针一条路。
    //   预览开着就先关预览，否则关面板 —— 与 client.js 各浮层的口径一致。
    document.addEventListener('keydown', function (ev) {
      if (String(ev && ev.key) !== 'Escape') return
      if (previewEl) { closePreview(); return }
      close()
    })
    var mo = new MutationObserver(function () { scanMenu() })
    mo.observe(document.body, { childList: true, subtree: true })
  }

  window.DshQpHistory = {
    __hs: true,
    open: open,
    close: close,
    reload: load,
    getState: function () {
      return {
        keyword: state.keyword, kind: state.kind, offset: state.offset,
        total: state.total, available: state.available, persistent: state.persistent,
      }
    },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else {
    mount()
  }
}())
