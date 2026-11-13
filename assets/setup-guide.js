/* assets/setup-guide.js —— 图形化傻瓜式安装引导（非 ESM，<script defer> 单文件）
 *
 * 为什么在 assets/：lib/client.js 贴着 DSH Store 256 KB 单文件上限，新 UI 一律外置。
 * 为什么不用 import：DSH 客户端是 window.__ModuleLoader__ 单入口纯脚本，lib/ 不经 web 暴露。
 *
 * 设计要点（用户要求「入口藏得太隐蔽，改明显一点，图形化傻瓜式」）：
 *   · 一个**常驻可见**的大按钮（不是收在二级菜单里），带进度环与状态色；
 *   · 点开是分步卡片向导：状态灯 / 进度条 / 大白话 / 一键复制命令 / 明确的联网与同意提示；
 *   · 首次进入自动弹一次（可关，localStorage 记住），缺件时按钮变琥珀色提示；
 *   · 只展示与复制命令，**绝不从网页触发本机安装进程**（安全红线，端点也写死了）。
 *
 * 所有文案与状态来自 GET api/qwen-paint/setup-guide；端点不通时降级为静态步骤清单。
 */
(function () {
  'use strict'
  if (window.DshQpSetupGuide && window.DshQpSetupGuide.__guide === true) return

  var GUIDE_PATH = 'api/qwen-paint/setup-guide'
  var STORE_KEY = 'dshqp.setupGuide.seen'
  var HIDE_KEY = 'dshqp.setupGuide.hidden'
  var state = null
  var els = {}
  var opened = false
  var dismissed = false
  var forced = false // show() 用它跳过「已经弹过就不再挂载」这道闸

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  /* ★★ 2026-11-13 用户报「安装引导死活点不动、还关不掉」——两轮修复的定案 ★★
   *
   * 根因 ①：assets/panel.js:926-935 早记过 —— DSH 宿主会吞 `click`（复合事件），
   *   后加的安装引导却只绑 click ⇒ 点不动。
   * 根因 ②（二轮复测才说清）：用户要的「关掉」是**整个引导**，包括右下角常驻悬浮按钮。
   *   旧 × 只把面板 hidden，fab 永远留在屏幕上 ⇒ 看起来就是「关不掉」；
   *   面板里的选项（含 cpu-accel / mask-fx 的按钮）也还是只绑 click ⇒ 还是点不动。
   *
   * 定案：
   *   ① onTap()：click / pointerup / mouseup / touchend **四种事件全监听** + 300ms 冷却去重，
   *      不再赌宿主放哪一种；键盘 Enter/Space 另给无指针通道。
   *   ② installPointerFallback()：给其它浮层里「只绑 click」的旧控件补发 click，
   *      同样监听四种 up 事件；只在插件浮层白名单内，宿主已派发时绝不重复。
   *   ③ × / Escape / hide() = **dismiss()**：把面板 **和悬浮按钮一起移除**并记住偏好，
   *      下次启动不再挂载；`show()` 可恢复。Alt+H 是不依赖任何指针事件的硬关闭快捷键。
   *   ④ 全程不碰 lib/client.js（用户定的体积红线）。
   */
  /**
   * ★★ 2026-11-13 二轮修复：用户复测「还是点不动」。
   * 上一轮只赌 pointerup，但宿主可能连 pointer 事件序列一起吞掉，只留 mouse / touch / click 中的某一种。
   * ⇒ 不再猜宿主放哪种事件：**click / pointerup / mouseup / touchend 全部监听**，
   *   同一次手势会连派好几个 ⇒ 用 300ms 冷却去重，保证只触发一次。
   *   只要其中任何一种能到达，按钮就一定能用；键盘 Enter/Space 是额外的无指针通道。
   */
  var TAP_UP = ['click', 'pointerup', 'mouseup', 'touchend']

  function onTap(node, fn) {
    if (!node || typeof node.addEventListener !== 'function') return
    if (typeof node.setAttribute === 'function') node.setAttribute('data-dshqp-direct', '1')
    var lastFire = 0
    var run = function (ev) {
      var now = Date.now()
      if (now - lastFire < 300) return // 同一次手势的 click + pointerup + mouseup 只算一次
      lastFire = now
      fn(ev)
    }
    for (var i = 0; i < TAP_UP.length; i += 1) node.addEventListener(TAP_UP[i], run)
    node.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        lastFire = Date.now()
        fn(ev)
      }
    })
  }

  function hasClass(node, cls) {
    return String((node && node.className) || '').split(/\s+/u).indexOf(cls) >= 0
  }

  /** 只在插件自己的浮层里生效；最多往上爬 12 层，绝不碰宿主 / React 消息树。 */
  function inPluginScope(node) {
    var SCOPE = ['sg-panel', 'sg-fab', 'cp-panel', 'dshqp-mask-overlay',
      'dshqp-mask-card', 'qwen-paint-opt-panel', 'qwen-paint-opt-menu', 'mf-box', 'ca-box']
    var n = node
    for (var i = 0; n && i < 12; i += 1) {
      for (var j = 0; j < SCOPE.length; j += 1) if (hasClass(n, SCOPE[j])) return true
      n = n.parentNode
    }
    return false
  }

  function isTapTarget(node) {
    var tag = String((node && node.tagName) || '').toUpperCase()
    if (tag === 'BUTTON' || tag === 'A') return true
    if (tag === 'INPUT') {
      var ty = String(node.type || '').toLowerCase()
      return ty === 'radio' || ty === 'checkbox'
    }
    return false
  }

  /**
   * 给「只绑 click」的旧控件（cpu-accel / mask-fx / client.js 浮层 / panel.js 的 ×）兜底。
   * 宿主正常派发 click 时**绝不补**（时间戳 + 目标去重），所以不会双触发。
   * 用 el.click() 而不是 dispatchEvent：radio / checkbox 需要它自带的 checked 切换与 change。
   * ★ 二轮：四种 up 事件都监听，且不再依赖 window.PointerEvent 是否存在。
   */
  var fallbackInstalled = false
  function installPointerFallback() {
    if (fallbackInstalled || typeof document.addEventListener !== 'function') return
    fallbackInstalled = true
    var lastClick = { t: 0, el: null }
    try {
      document.addEventListener('click', function (ev) {
        lastClick = { t: Date.now(), el: ev.target }
      }, true)
    } catch (e) { return }
    var UP = ['pointerup', 'mouseup', 'touchend']
    for (var k = 0; k < UP.length; k += 1) {
      try {
        document.addEventListener(UP[k], function (ev) {
          var target = ev.target
          if (!target || !isTapTarget(target) || !inPluginScope(target)) return
          if (typeof target.getAttribute === 'function'
            && target.getAttribute('data-dshqp-direct') === '1') return
          var at = Date.now()
          setTimeout(function () {
            if (lastClick.el === target && lastClick.t >= at - 60 && lastClick.t <= at + 600) return
            try {
              if (typeof target.click === 'function') target.click()
              else if (typeof target.dispatchEvent === 'function' && typeof window.MouseEvent === 'function') {
                target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
              }
            } catch (e) { /* 补发失败不影响其它功能 */ }
          }, 40)
        }, true)
      } catch (e) { /* 忽略 */ }
    }
  }

  function statusText(s) {
    return s === 'done' ? '已就绪' : s === 'todo' ? '待处理'
      : s === 'optional' ? '可选' : '检测中'
  }

  function copy(text, btn) {
    var done = function (ok) {
      var old = btn.textContent
      btn.textContent = ok ? '已复制 ✓' : '复制失败，请手动选中'
      setTimeout(function () { btn.textContent = old }, 1800)
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true) }, function () { done(false) })
      } else {
        var ta = el('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(ta)
        ta.select()
        var ok = document.execCommand('copy')
        ta.remove()
        done(ok)
      }
    } catch (e) { done(false) }
  }

  function stepCard(step, index) {
    var card = el('div', 'sg-card')
    card.setAttribute('data-status', step.status)
    var head = el('div', 'sg-card-head')
    var no = el('span', 'sg-no', String(index + 1).padStart(2, '0'))
    var titleBox = el('div', 'sg-title-box')
    titleBox.appendChild(el('div', 'sg-title', step.title))
    var tags = el('div', 'sg-tags')
    if (step.optional) tags.appendChild(el('span', 'sg-tag sg-tag-opt', '可选'))
    if (step.network) tags.appendChild(el('span', 'sg-tag sg-tag-net', '会联网下载'))
    if (step.consent) tags.appendChild(el('span', 'sg-tag sg-tag-ask', '需你确认'))
    if (tags.children.length) titleBox.appendChild(tags)
    head.appendChild(no)
    head.appendChild(titleBox)
    head.appendChild(el('span', 'sg-status', statusText(step.status)))
    card.appendChild(head)
    card.appendChild(el('p', 'sg-hint', step.hint))
    if (step.choices && step.choices.length) {
      var choices = el('div', 'sg-choices')
      step.choices.forEach(function (c) {
        var b = el('button', 'sg-btn sg-btn-ghost', c.label)
        b.type = 'button'
        onTap(b, function () { copy(c.command, b) })
        b.title = c.command
        choices.appendChild(b)
      })
      card.appendChild(choices)
    }
    if (step.command) {
      var row = el('div', 'sg-cmdrow')
      var code = el('code', 'sg-cmd', step.command)
      row.appendChild(code)
      var cp = el('button', 'sg-btn sg-btn-copy', '复制命令')
      cp.type = 'button'
      onTap(cp, function () { copy(step.command, cp) })
      row.appendChild(cp)
      card.appendChild(row)
    }
    if (step.extra) card.appendChild(el('p', 'sg-extra', step.extra))
    return card
  }

  function render() {
    if (!els.list) return
    els.list.textContent = ''
    var steps = (state && state.steps) || []
    steps.forEach(function (s, i) { els.list.appendChild(stepCard(s, i)) })
    var done = state ? state.done : 0
    var total = state ? state.total : 0
    var pct = total ? Math.round(done / total * 100) : 0
    els.bar.style.width = pct + '%'
    els.progress.textContent = state && state.probed
      ? (done + ' / ' + total + ' 步已就绪')
      : '状态未探测 · 步骤仍可照做'
    els.fab.textContent = state && state.ready ? '安装引导 · 已就绪'
      : (state && state.probed ? '一键安装引导 · ' + done + '/' + total : '一键安装引导')
    els.fab.setAttribute('data-ready', state && state.ready ? '1' : '0')
    els.headline.textContent = (state && state.headline) || '视频 / 生图 / TTS 全能 · 本机运行'
    if (els.pack) {
      els.pack.textContent = state && state.videoDownloadPack && state.videoDownloadPack.available
        ? '✓ 视频模型自动下载包：已提供（--video-models，默认不装、需你同意、按权威 size+sha256 校验）'
        : '视频模型自动下载包：状态未知'
    }
  }

  function load() {
    return fetch(GUIDE_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) { if (j && j.ok) { state = j; render() } })
      .catch(function () { /* 端点不通就用内置静态清单，不弹错 */ })
  }

  /** 显隐双保险：hidden 属性 + style.display。CSS 没加载 / 被宿主覆盖时也一定关得掉。 */
  function setVisible(on) {
    if (!els.panel) return
    els.panel.hidden = !on
    try { els.panel.style.display = on ? '' : 'none' } catch (e) { /* 忽略 */ }
  }

  function open() {
    if (!els.panel) return
    setVisible(true)
    opened = true
    loadCpuAccel()
    load()
  }
  function close() {
    if (!els.panel) return
    setVisible(false)
    opened = false
    try { localStorage.setItem(STORE_KEY, '1') } catch (e) { /* 隐私模式忽略 */ }
  }

  function removeNode(n) {
    try {
      if (n && n.parentNode && typeof n.parentNode.removeChild === 'function') n.parentNode.removeChild(n)
      else if (n && typeof n.remove === 'function') n.remove()
    } catch (e) { /* 忽略 */ }
  }

  /** ★ 用户要的「关掉」：把面板 + 右下角悬浮按钮一起移除，写偏好，下次启动不再挂载。 */
  function isDismissed() {
    if (dismissed) return true
    try { return localStorage.getItem(HIDE_KEY) === '1' } catch (e) { return false }
  }
  function hasSeen() {
    try { return localStorage.getItem(STORE_KEY) === '1' } catch (e) { return false }
  }
  function dismiss() {
    close() // 先收起（hidden + display 双保险），再整体摘除
    try { localStorage.setItem(HIDE_KEY, '1') } catch (e) { /* 隐私模式忽略 */ }
    try { localStorage.setItem(STORE_KEY, '1') } catch (e) { /* 忽略 */ }
    dismissed = true
    removeNode(els.panel)
    removeNode(els.fab)
    els.panel = null; els.fab = null; els.list = null
    els.bar = null; els.progress = null; els.headline = null; els.pack = null
    return true
  }
  /** 恢复入口（控制台 / 其它插件可调用）；清掉隐藏偏好后重新挂载一次。 */
  function show() {
    try { localStorage.removeItem(HIDE_KEY) } catch (e) { /* 忽略 */ }
    dismissed = false
    forced = true
    mount()
    return true
  }

  /** 多条退路：Escape / Alt+H 硬关闭 / 点面板外收起 / 再点一次浮标。 */
  var guardsInstalled = false
  function installGuards() {
    if (guardsInstalled || typeof document.addEventListener !== 'function') return
    guardsInstalled = true
    try {
      document.addEventListener('keydown', function (ev) {
        // ★ 完全不依赖任何指针事件的硬通道：Alt+H 直接把整个引导关掉
        if (ev.altKey && (ev.key === 'h' || ev.key === 'H')) { dismiss(); return }
        if (!opened) return
        if (ev.key === 'Escape' || ev.key === 'Esc') dismiss()
      }, true)
      var OUTSIDE = ['pointerup', 'mouseup', 'touchend', 'click']
      for (var i = 0; i < OUTSIDE.length; i += 1) {
        document.addEventListener(OUTSIDE[i], function (ev) {
          if (!opened) return
          var t = ev.target
          if (els.panel && typeof els.panel.contains === 'function' && els.panel.contains(t)) return
          if (els.fab && typeof els.fab.contains === 'function' && els.fab.contains(t)) return
          dismiss() // ★ 一次性引导：点外面也算「看完了」，整个入口不再出现
        }, true)
      }
    } catch (e) { /* 忽略 */ }
  }

  function injectCss() {
    if (document.getElementById('dshqp-setup-guide-css')) return
    var l = document.createElement('link')
    l.id = 'dshqp-setup-guide-css'
    l.rel = 'stylesheet'
    l.href = 'qwen-paint/setup-guide.css'
    document.head.appendChild(l)
  }

  /**
   * 懒加载 CPU 加速档面板。
   * 为什么不直接写成第二个 <script> 标签：它只在用户真打开引导面板时才需要，
   * 平时不该多一次静态资源请求；而且它是独立文件，坏了也不会拖垮引导本身。
   */
  function loadCpuAccel() {
    if (window.DshQpCpuAccel && window.DshQpCpuAccel.__cpu === true) return
    if (document.getElementById('dshqp-cpu-accel-js')) return
    var s = document.createElement('script')
    s.id = 'dshqp-cpu-accel-js'
    s.src = 'qwen-paint/cpu-accel.js'
    s.defer = true
    document.head.appendChild(s)
  }

  function mount() {
    // ★ 2026-11-13 用户定：「这个安装引导只弹一次之后就不要了」。
    //   seen 写过 = 上次已经弹过 ⇒ 这次**连常驻按钮都不挂载**，彻底不再出现。
    //   任何关闭动作都会 dismiss() 把面板和按钮一起摘掉；show() 用 forced 跳过这道闸。
    if (!forced && (isDismissed() || hasSeen())) return
    forced = false
    injectCss()
    if (document.getElementById('dshqp-setup-guide-fab')) return
    // 常驻显眼入口：右下角大按钮，避开通用面板的左下浮标。
    var fab = el('button', 'sg-fab')
    fab.id = 'dshqp-setup-guide-fab'
    fab.type = 'button'
    fab.textContent = '一键安装引导'
    fab.title = '图形化安装引导：ComfyUI / 生图 / 视频 / 语音 / DSH 挂载'
    onTap(fab, function () { opened ? dismiss() : open() })
    els.fab = fab

    var panel = el('div', 'sg-panel')
    panel.hidden = true
    try { panel.style.display = 'none' } catch (e) { /* 忽略 */ }
    var head = el('div', 'sg-head')
    var hb = el('div', 'sg-head-box')
    hb.appendChild(el('h3', 'sg-h3', '装好这个插件，只要 7 步'))
    var headline = el('div', 'sg-headline', '视频 / 生图 / TTS 全能 · 本机运行')
    hb.appendChild(headline)
    els.headline = headline
    head.appendChild(hb)
    var x = el('button', 'sg-x', '×')
    x.type = 'button'
    x.title = '彻底关闭这个安装引导（连同右下角悬浮按钮一起移除）'
    onTap(x, dismiss)
    head.appendChild(x)
    panel.appendChild(head)

    var barWrap = el('div', 'sg-barwrap')
    var bar = el('div', 'sg-bar')
    barWrap.appendChild(bar)
    els.bar = bar
    panel.appendChild(barWrap)
    var progress = el('div', 'sg-progress', '状态未探测 · 步骤仍可照做')
    els.progress = progress
    panel.appendChild(progress)

    var pack = el('div', 'sg-pack', '')
    els.pack = pack
    panel.appendChild(pack)

    // ★ 2026-11-13：CPU 指令集 / 加速档的插槽。内容由 cpu-accel.js 渲染 ——
    //   不为它单开浮标（右下角已经有一个，再加只会更乱），就长在引导面板里。
    var cpuSlot = el('div', 'sg-cpu-slot')
    cpuSlot.id = 'dshqp-cpu-accel-slot'
    panel.appendChild(cpuSlot)

    var safety = el('div', 'sg-safety',
      '这个引导只展示和复制命令，绝不会从网页偷偷在你电脑上跑安装。所有联网下载都要你在终端里亲自执行。'
      + ' 本引导只出现这一次：按 × / Escape / Alt+H 或点面板外，都会把它连同右下角悬浮按钮一起移除，'
      + '以后启动也不再出现。想再看时在控制台执行 DshQpSetupGuide.show() 即可。')
    panel.appendChild(safety)

    var list = el('div', 'sg-list')
    els.list = list
    panel.appendChild(list)

    var foot = el('div', 'sg-foot')
    var again = el('button', 'sg-btn sg-btn-ghost', '重新检测')
    again.type = 'button'
    onTap(again, load)
    foot.appendChild(again)
    var toCap = el('button', 'sg-btn sg-btn-ghost', '查看能力状态')
    toCap.type = 'button'
    onTap(toCap, function () {
      fetch('api/qwen-paint/integration/state', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var d = el('pre', 'sg-json', JSON.stringify(j, null, 2))
          els.list.insertBefore(d, els.list.firstChild)
        })
        .catch(function () { /* 忽略 */ })
    })
    foot.appendChild(toCap)
    panel.appendChild(foot)

    document.body.appendChild(fab)
    document.body.appendChild(panel)
    els.panel = panel
    installGuards()
    installPointerFallback()
    render()
    load()
    // 首次自动弹一次，之后只在用户点按钮时开；绝不强推。
    // ★ 2026-11-13 修：seen 在「决定自动弹」时就写，不再等 close()。
    //   否则一旦关不掉，localStorage 永远是空的 ⇒ 每次启动都自动弹，越用越烦。
    try {
      if (localStorage.getItem(STORE_KEY) !== '1') {
        try { localStorage.setItem(STORE_KEY, '1') } catch (e) { /* 隐私模式忽略 */ }
        setTimeout(open, 1200)
      }
    } catch (e) { /* 隐私模式忽略 */ }
  }

  window.DshQpSetupGuide = {
    __guide: true,
    open: open, close: close,
    hide: dismiss, dismiss: dismiss, show: show,
    isDismissed: isDismissed, isOpen: function () { return opened === true },
    reload: load, onTap: onTap,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount)
  } else { mount() }
})()
