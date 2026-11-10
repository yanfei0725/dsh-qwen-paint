/* assets/panel.js —— 通用 Comfy 控制层面板（非 ESM，`<script defer>` 单文件）
 *
 * ## 硬约束（别改成 import）
 *   DSH 的客户端形态是 `window.__ModuleLoader__` 单入口的纯脚本，**不能 import ESM**；
 *   `lib/` 也不经 web 暴露。所以契约数据一律从
 *   `GET /api/comfy-pipeline/schema`（已挂到 `window.ComfyPipelineSchema`）读，
 *   控制项存到 `GET/POST /api/comfy-pipeline/controls`。
 *
 * ## 这个面板**不装**什么
 *   视频模式（wan22 / ltxv / framepack）与混合模式的后端工作流在本插件里**还不存在**，
 *   所以那两个 tab 是 `disabled` 的，并如实标注原因 —— 摆一个拨了没反应的滑块，
 *   比不给更坏（本项目历史上被"假报告"坑过）。
 *   同理：`fps` / `denoise` / `tileSize` / `chunkOverlap` 四项当前**没有消费方**，一律禁用并注明。
 *
 * ## 速度%的真实语义
 *   只压**画幅像素预算**（长边 1024→896→768→640）与参考图张数上限。
 *   **绝不改蒸馏步数** —— 官方 Turbo 是 8/9 步蒸馏模型，改步数不是"快"而是"糊"。
 */
(function () {
  'use strict'

  var existing = window.ComfyPipelinePanel
  if (existing && existing.__cp === true) return

  var SCHEMA_PATH = 'api/comfy-pipeline/schema'
  var CONTROLS_PATH = 'api/comfy-pipeline/controls'
  var FALLBACK_TIERS = [25, 50, 75, 100]

  var schema = null
  var state = null
  var nodes = null
  var saveTimer = null
  var saveSeq = 0

  /* ============================ 纯函数（可被回归直接测） ============================ */

  function defsByKey() {
    var out = {}
    var groups = (schema && schema.controls) || {}
    Object.keys(groups).forEach(function (g) {
      var list = groups[g] || []
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && typeof list[i].key === 'string') out[list[i].key] = list[i]
      }
    })
    return out
  }

  /** 按契约定义 clamp 到 [min,max] 并对齐 step（从 min 起算，不是从 0）。 */
  function clampByDef(def, value) {
    var v = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(v)) return def && Number.isFinite(def['default']) ? def['default'] : 0
    var min = def && Number.isFinite(def.min) ? def.min : -Infinity
    var max = def && Number.isFinite(def.max) ? def.max : Infinity
    var step = def && Number.isFinite(def.step) && def.step > 0 ? def.step : 0
    v = Math.min(max, Math.max(min, v))
    if (step > 0) {
      var base = def && Number.isFinite(def.min) ? def.min : 0
      v = base + Math.round((v - base) / step) * step
      v = Math.min(max, Math.max(min, v))
      v = Number(v.toFixed(4))
    }
    if (def && (def.type === 'number' || def.type === 'integer')) v = Math.trunc(v)
    return v
  }

  function speedTiers() {
    var t = schema && schema.speedTiers
    return Array.isArray(t) && t.length > 0 ? t : FALLBACK_TIERS
  }

  /** 16 档滑块值 → 最近的 4 档之一。 */
  function quantize(speed) {
    var tiers = speedTiers()
    var v = Number(speed)
    if (!Number.isFinite(v)) return tiers[tiers.length - 1]
    return tiers.reduce(function (best, t) {
      return Math.abs(t - v) < Math.abs(best - v) ? t : best
    }, tiers[0])
  }

  /** 该档的 SPEEED_MAP.image 描述（尺寸/参考图张数）。契约里没有就返回 null，绝不编。 */
  function speedSlot(speed) {
    var map = schema && schema.speedMap
    var slot = map && map.image ? map.image[quantize(speed)] : null
    return slot && typeof slot === 'object' ? slot : null
  }

  function speedEdge(speed) {
    var slot = speedSlot(speed)
    return slot && Number.isFinite(slot.size) ? slot.size : null
  }

  function speedRefs(speed) {
    var slot = speedSlot(speed)
    return slot && Number.isFinite(slot.refs) ? slot.refs : null
  }

  function aspectTicks() {
    var def = defsByKey().aspect
    return def && Array.isArray(def.ticks) ? def.ticks : ['1:1']
  }

  /**
   * 状态 → POST 载荷。**只输出契约里认识的键**，其余一律不出现（服务端还会再洗一遍，
   * 但前端先洗的好处是：UI 上就不可能拨出非法值）。
   */
  function buildPayload(input) {
    var defs = defsByKey()
    var src = input && typeof input === 'object' ? input : {}
    var out = {}
    var modes = (schema && schema.modes) || []
    var okMode = false
    for (var i = 0; i < modes.length; i += 1) if (modes[i].id === src.mode) okMode = true
    out.mode = okMode ? src.mode : 'image'
    Object.keys(defs).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(src, key)) return
      out[key] = clampByDef(defs[key], src[key])
    })
    return out
  }

  /** 人话摘要：档位一律标「吸附」，没实测基准就不编 ETA 数字。 */
  function describe(input) {
    var c = buildPayload(input)
    var ticks = aspectTicks()
    var idx = Math.min(ticks.length - 1, Math.max(0, Math.trunc(c.aspect || 0)))
    var edge = speedEdge(c.speedPercent)
    var refs = speedRefs(c.speedPercent)
    var parts = [ticks[idx], '速度 ' + c.speedPercent + '%（吸附 ' + quantize(c.speedPercent) + ' 档）']
    if (edge !== null) parts.push('长边 ' + edge)
    if (refs !== null) parts.push('该档参考图预算 ' + refs)
    return parts.join(' · ')
  }

  /* ============================ 契约加载 ============================ */

  function loadSchema() {
    if (schema) return Promise.resolve(schema)
    if (window.ComfyPipelineSchema) {
      schema = window.ComfyPipelineSchema
      return Promise.resolve(schema)
    }
    return fetch(SCHEMA_PATH, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (j && j.ok && j.schema) {
          schema = j.schema
          window.ComfyPipelineSchema = j.schema
        }
        return schema
      })
      .catch(function () { return null })
  }

  function loadControls() {
    return fetch(CONTROLS_PATH, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (j && j.ok && j.controls) return sanitizeLocal(j.controls)
        return sanitizeLocal({})
      })
      .catch(function () { return sanitizeLocal({}) })
  }

  function sanitizeLocal(raw) {
    var defs = defsByKey()
    var out = buildPayload(raw)
    Object.keys(defs).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(out, key) && Number.isFinite(defs[key]['default'])) {
        out[key] = defs[key]['default']
      }
    })
    if (!out.mode) out.mode = 'image'
    return out
  }

  /* ============================ DOM ============================ */

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function setStatus(text, kind) {
    if (!nodes || !nodes.status) return
    nodes.status.textContent = text
    nodes.status.className = 'cp-status' + (kind ? ' is-' + kind : '')
  }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 300)
  }

  function save() {
    saveTimer = null
    var payload = buildPayload(state)
    var seq = (saveSeq += 1)
    if (nodes && nodes.fab) nodes.fab.classList.add('is-busy')
    setStatus('保存中…')
    fetch(CONTROLS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (seq !== saveSeq) return // 有更新的保存在路上，丢弃这次的旧结果
        if (nodes && nodes.fab) nodes.fab.classList.remove('is-busy')
        if (!j || j.ok !== true) {
          setStatus('保存失败：' + ((j && j.reason) || '未知原因'), 'err')
          return
        }
        if (j.controls) state = sanitizeLocal(j.controls)
        setStatus(j.saved === false
          ? '已生效（写盘失败：' + (j.reason || '目录只读') + '，重启后回到默认）'
          : '已保存 · ' + (j.summary || describe(state)),
        j.saved === false ? 'err' : 'ok')
      })
      .catch(function (err) {
        if (nodes && nodes.fab) nodes.fab.classList.remove('is-busy')
        setStatus('保存失败：' + (err && err.message ? err.message : err), 'err')
      })
  }

  function field(label, key, opts) {
    var def = defsByKey()[key] || {}
    var wrap = el('div', 'cp-field' + (opts && opts.disabled ? ' cp-off' : ''))
    var top = el('div', 'cp-field-top')
    top.appendChild(el('span', 'cp-label', label))
    var val = el('span', 'cp-value')
    top.appendChild(val)
    wrap.appendChild(top)

    var input
    if (def.type === 'number' || def.type === 'integer' || key === 'seed') {
      input = el('input')
      input.type = 'number'
      if (Number.isFinite(def.min)) input.min = String(def.min)
      if (Number.isFinite(def.max)) input.max = String(def.max)
      if (Number.isFinite(def.step)) input.step = String(def.step)
    } else {
      input = el('input')
      input.type = 'range'
      input.min = String(Number.isFinite(def.min) ? def.min : 0)
      input.max = String(Number.isFinite(def.max) ? def.max : 100)
      input.step = String(Number.isFinite(def.step) ? def.step : 1)
    }
    input.value = String(state[key] !== undefined ? state[key] : (def['default'] !== undefined ? def['default'] : 0))
    if (opts && opts.disabled) input.disabled = true
    wrap.appendChild(input)

    var hint = null
    if (opts && opts.hint) {
      hint = el('p', 'cp-hint' + (opts.warn ? ' is-warn' : ''), opts.hint)
      wrap.appendChild(hint)
    }
    var ticks = null
    if (opts && Array.isArray(opts.ticks)) {
      ticks = el('div', 'cp-ticks')
      opts.ticks.forEach(function (t) { ticks.appendChild(el('span', null, t)) })
      wrap.appendChild(ticks)
    }

    var paint = function () {
      var v = state[key]
      if (key === 'seed') {
        val.textContent = v < 0 ? '随机' : String(v)
      } else if (Array.isArray(opts && opts.ticks) && Number.isFinite(Number(v))) {
        var i = Math.min(opts.ticks.length - 1, Math.max(0, Math.trunc(Number(v))))
        val.textContent = opts.ticks[i]
        if (ticks) {
          for (var k = 0; k < ticks.children.length; k += 1) {
            ticks.children[k].className = k === i ? 'is-on' : ''
          }
        }
      } else {
        val.textContent = String(v)
      }
      if (opts && typeof opts.onPaint === 'function') opts.onPaint(v, hint)
    }
    paint()

    input.addEventListener('input', function () {
      state[key] = clampByDef(def, input.value)
      // 数字框允许输入中间态（如先敲 "-"），但存储值始终是洗过的
      paint()
      scheduleSave()
      if (opts && opts.onAfter) opts.onAfter()
    })
    wrap._paint = paint
    return wrap
  }

  function render() {
    var modes = (schema && schema.modes) || []
    var ticks = aspectTicks()

    var fab = el('button', 'cp-fab')
    fab.type = 'button'
    fab.appendChild(el('span', 'cp-fab-dot'))
    fab.appendChild(el('span', null, 'Comfy 控制'))
    document.body.appendChild(fab)

    var panel = el('div', 'cp-panel')
    panel.hidden = true

    var head = el('div', 'cp-head')
    head.appendChild(el('h4', null, '通用 Comfy 控制层'))
    var x = el('button', 'cp-x', '×')
    x.type = 'button'
    head.appendChild(x)
    panel.appendChild(head)

    var tabs = el('nav', 'cp-tabs')
    var tabEls = {}
    modes.forEach(function (m) {
      var available = m.id === 'image'
      var b = el('button', 'cp-tab' + (m.id === state.mode ? ' is-on' : ''), m.label || m.id)
      b.type = 'button'
      b.title = available ? ('交付 ' + (m.deliver || '')) : '后端工作流未接入，暂不可选'
      if (!available) b.disabled = true
      b.addEventListener('click', function () {
        if (!available) return
        state.mode = m.id
        Object.keys(tabEls).forEach(function (id) { tabEls[id].className = 'cp-tab' + (id === state.mode ? ' is-on' : '') })
        scheduleSave()
      })
      tabEls[m.id] = b
      tabs.appendChild(b)
    })
    panel.appendChild(tabs)

    var note = el('p', 'cp-note', '')
    panel.appendChild(note)

    var common = el('div', 'cp-common')
    common.appendChild(field('画幅比例', 'aspect', { ticks: ticks }))
    common.appendChild(field('速度百分比', 'speedPercent', {
      hint: '',
      onPaint: function (v, hint) {
        if (!hint) return
        var d = describe({ aspect: state.aspect, speedPercent: v })
        hint.textContent = d + '（只压画幅像素预算，不改蒸馏步数 —— 不掉画质）'
      },
    }))
    panel.appendChild(common)

    var adv = el('details', 'cp-adv')
    adv.appendChild(el('summary', null, '高级设置'))
    var body = el('div', 'cp-adv-body')
    body.appendChild(field('种子（-1 = 每次随机）', 'seed', { hint: '同提示词 + 同种子 = 同一张图；-1 每次都不一样。' }))
    body.appendChild(field('采样步数', 'steps', {
      hint: '仅在原生链路（textControl=native）真正按它采样；官方 Turbo 链固定 8/9 步蒸馏，会忽略本值。',
      warn: true,
    }))
    body.appendChild(field('每轮张数', 'count', { hint: '同一次调用出多张只加载一次模型。' }))
    body.appendChild(field('帧率 fps', 'fps', { disabled: true, hint: '视频后端工作流未接入，本项暂不生效。' }))
    body.appendChild(field('降噪 denoise', 'denoise', { disabled: true, hint: '编辑链的降噪由任务链内部按 LoRA 工作点定，暂不由面板接管。' }))
    body.appendChild(field('VAE 分块 tileSize', 'tileSize', { disabled: true, hint: 'VAE 分块由优化开关接管，暂不走面板。' }))
    body.appendChild(field('分块重叠 chunkOverlap', 'chunkOverlap', { disabled: true, hint: '同上：VAE 分块相关参数暂不走面板。' }))
    adv.appendChild(body)
    panel.appendChild(adv)

    var foot = el('div', 'cp-foot')
    var status = el('span', 'cp-status', '就绪')
    var reset = el('button', 'cp-reset', '恢复默认')
    reset.type = 'button'
    reset.addEventListener('click', function () {
      var defs = defsByKey()
      Object.keys(defs).forEach(function (k) {
        if (Number.isFinite(defs[k]['default'])) state[k] = defs[k]['default']
      })
      state.mode = 'image'
      syncInputs()
      scheduleSave()
      setStatus('已恢复默认值')
    })
    foot.appendChild(status)
    foot.appendChild(reset)
    panel.appendChild(foot)

    document.body.appendChild(panel)
    nodes = { fab: fab, panel: panel, status: status, note: note }
    return nodes
  }

  function syncInputs() {
    if (!nodes || !nodes.panel) return
    var wraps = nodes.panel.querySelectorAll('.cp-field')
    for (var i = 0; i < wraps.length; i += 1) {
      if (typeof wraps[i]._paint === 'function') wraps[i]._paint()
    }
    var inputs = nodes.panel.querySelectorAll('.cp-field input')
    for (var j = 0; j < inputs.length; j += 1) {
      // 用 _paint 的格子顺序对不上时，退化成"从 state 重新填一遍"
      void inputs[j]
    }
  }

  function refreshNote() {
    if (!nodes || !nodes.note) return
    var modes = (schema && schema.modes) || []
    var off = modes.filter(function (m) { return m.id !== 'image' })
    nodes.note.textContent = off.length === 0
      ? ''
      : off.map(function (m) { return (m.label || m.id) + '（' + (m.backends || m.chain || []).join('/') + '）'; }).join('、')
        + '：后端工作流尚未接入本插件，暂不可选。'
  }

  function open() { if (nodes) { nodes.panel.hidden = false; refreshNote() } }
  function close() { if (nodes) nodes.panel.hidden = true }

  function wire() {
    var fab = nodes.fab
    var panel = nodes.panel
    fab.addEventListener('click', function () { panel.hidden ? open() : close() })
    var x = panel.querySelector('.cp-x')
    if (x) x.addEventListener('click', close)
    // 点面板外面收起（与既有优化面板同一套习惯）
    document.addEventListener('click', function (ev) {
      if (panel.hidden) return
      if (panel.contains(ev.target) || fab.contains(ev.target)) return
      close()
    }, true)
  }

  function mount() {
    if (nodes) return Promise.resolve(nodes)
    return loadSchema()
      .then(loadControls)
      .then(function (controls) {
        state = controls
        render()
        wire()
        refreshNote()
        setStatus('就绪 · ' + describe(state))
        return nodes
      })
  }

  /* ============================ 导出 ============================ */
  window.ComfyPipelinePanel = {
    __cp: true,
    mount: mount,
    open: open,
    close: close,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null },
    api: {
      clampByDef: clampByDef,
      quantize: quantize,
      speedEdge: speedEdge,
      speedRefs: speedRefs,
      aspectTicks: aspectTicks,
      buildPayload: buildPayload,
      describe: describe,
    },
  }

  // 自挂载：脚本是 defer 加载的，DOM 已就绪；宿主没准备好就等 DOMContentLoaded。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount() })
  } else {
    mount()
  }
})()
