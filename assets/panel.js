/* assets/panel.js —— 通用 Comfy 控制层面板（非 ESM，`<script defer>` 单文件）
 *
 * ## 硬约束（别改成 import）
 *   DSH 的客户端形态是 `window.__ModuleLoader__` 单入口的纯脚本，**不能 import ESM**；
 *   `lib/` 也不经 web 暴露。所以契约数据一律从
 *   `GET /api/comfy-pipeline/schema`（已挂到 `window.ComfyPipelineSchema`）读，
 *   控制项存到 `GET/POST /api/comfy-pipeline/controls`。
 *
 * ## 这个面板**不装**什么
 *   视频链（wan22 / XT-5B）已接进 lib/video-workflow.js ⇒ 可选。
 *   混合模式（image → tts → video）是否可选由 `GET /api/comfy-pipeline/modes` 探测决定：
 *   探到 TTS 节点+权重就自动放行，缺件时 tab 禁用并把**缺什么、放哪**放进 title（如实，
 *   不假装能出音频）—— 摆一个拨了没反应的滑块，比不给更坏（本项目历史上被"假报告"坑过）。
 *   `denoise` / `tileSize` 两项暂无消费方，禁用并注明；`frames` / `fps` 已接视频链、
 *   `chunkOverlap` 供混合链分段拼接消费（advanced 里仍禁用，值走 controls 默认，不谎称没消费方）。
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
  var PROGRESS_PATH = 'api/comfy-pipeline/progress'
  var LIBRARY_PATH = 'api/comfy-pipeline/library'
  var MODES_PATH = 'api/comfy-pipeline/modes'
  var MODEL_OPTIONS_PATH = 'api/comfy-pipeline/model-options'
  var REFERENCE_PATH = 'api/comfy-pipeline/reference'
  var REFERENCE_PREFER_PATH = 'api/comfy-pipeline/reference/prefer'
  var REFERENCE_SEARCH_PATH = 'api/comfy-pipeline/reference/search'
  var FALLBACK_TIERS = [25, 50, 75, 100]

  // 默认与「本地没探到 modes 端点」一致：图/视频可用、混合禁用。
  // 端点回来后按 modes[].available 覆写 —— 探测失败绝不把已可用模式误关。
  var modeAvailability = { image: true, video: true, hybrid: false }
  var modeReason = { hybrid: '' }

  // ★ 2026-11-16 性能：model-options 冷探测要发几十个 /object_info，切模式/重开面板
  //   都会重拉一次 ⇒ 下拉会「卡一下」。前端按 TTL 缓存成功响应，命中就不发请求。
  //   服务端 CAP_CACHE 是 10 分钟；这里取 120 s 更保守，避免配置改了很久不刷新。
  var MODEL_OPTIONS_TTL_MS = 120000
  var modelOptionsCache = { at: 0, data: null }

  var schema = null
  var state = null
  var nodes = null
  var saveTimer = null
  var saveSeq = 0
  var progressTimer = null
  var progressIdleTicks = 0

  /* ============================ 纯函数（可被回归直接测） ============================ */

  /** 缓存是否新鲜：命中必须 data 存在且未过期（TTL 内）。 */
  function modelOptionsFresh(entry, now, ttl) {
    return Boolean(entry && entry.data && Number.isFinite(entry.at)
      && (now - entry.at) >= 0 && (now - entry.at) < ttl)
  }

  /** 构造缓存条目（不原地改，便于纯函数断言）。 */
  function modelOptionsEntry(data, now) {
    return { at: now, data: data }
  }

  /** 期望选项的签名（value + label 逐项）；值或显示名变了就判为需重建。 */
  function optionSignature(opts, emptyLabel) {
    var parts = [String(emptyLabel)]
    for (var i = 0; i < opts.length; i += 1) {
      parts.push(String(opts[i].value) + '\u0000' + String(opts[i].label))
    }
    return parts.join('\u0001')
  }

  /**
   * 增量回填 select：选项集合没变就只改 `sel.value`（不 innerHTML='' 重建），
   * 变了才重建。返回 { same, value, count } 供测试断言。el 注入避免依赖全局 DOM。
   */
  function fillSelect(sel, opts, cur, emptyLabel, el) {
    var sig = optionSignature(opts, emptyLabel)
    var same = sel && sel.__optSig === sig && Array.isArray(sel.__optVals)
      && sel.__optVals.length === opts.length
    var hit = false
    for (var m = 0; m < opts.length; m += 1) if (opts[m].value === cur) hit = true
    var want = hit ? cur : ''
    if (!same && sel) {
      sel.innerHTML = ''
      var auto = el('option', null, emptyLabel)
      auto.value = ''
      sel.appendChild(auto)
      for (var n = 0; n < opts.length; n += 1) {
        var o = el('option', null, opts[n].label)
        o.value = opts[n].value
        sel.appendChild(o)
      }
      sel.__optSig = sig
      sel.__optVals = opts.map(function (o) { return o.value })
    }
    if (sel) sel.value = want
    return { same: same === true, value: want, count: opts.length }
  }

  /** 进度轮询间隔：连续空列表降频，避免面板开着就每 1.5s 白刷一次接口。 */
  function pollIntervalMs(idleTicks) {
    return idleTicks >= 4 ? 5000 : 1500
  }

  // ★ 2026-11-16 二次报障：内存 TTL 缓存刷新 DSH 页面就清零 ⇒ 首次展开下拉仍是
  //   「白条等请求」（后端冷启动拉 3.4MB /object_info）。把成功清单持久化到
  //   localStorage，下次打开**同步**回填，不等网络；后台再静默刷新。
  var MODEL_OPTIONS_STORE_KEY = 'comfyPipelineModelOptions'
  var MODEL_OPTIONS_STORE_VERSION = 1

  /** 读持久化清单：结构/版本/时效任一不合法返回 null（宁可等请求也不回显脏候选）。 */
  function loadPersistedModels(storage, now, ttl) {
    if (!storage) return null
    try {
      var raw = storage.getItem(MODEL_OPTIONS_STORE_KEY)
      if (!raw) return null
      var box = JSON.parse(raw)
      var d = box && box.data
      // 结构和成功态都要对；离线/失败响应绝不持久化，这里再守一道。
      var stale = !box || box.v !== MODEL_OPTIONS_STORE_VERSION
        || !Number.isFinite(box.at) || (now - box.at) < 0 || (now - box.at) >= ttl
        || !d || d.ok !== true || d.online !== true || !Array.isArray(d.unet)
      if (stale) {
        // ★ 2026-11-16 审计：过期即清除，别让已删的模型候选长期留在浏览器里。
        try { storage.removeItem(MODEL_OPTIONS_STORE_KEY) } catch (err) { /* 隐私模式忽略 */ }
        return null
      }
      return d
    } catch (err) { return null }
  }

  /** 写持久化清单：只接受成功且在线的响应，写失败静默忽略（隐私模式）。 */
  function savePersistedModels(storage, data, now) {
    if (!storage || !data || data.ok !== true || data.online !== true) return false
    try {
      storage.setItem(MODEL_OPTIONS_STORE_KEY, JSON.stringify({
        v: MODEL_OPTIONS_STORE_VERSION, at: now, data: data,
      }))
      return true
    } catch (err) { return false }
  }

  /** 给用户看的占位 option（完全没缓存时也有东西，不是空 select 白条）。 */
  function placeholderOption(label, el) {
    var o = el('option', null, label)
    o.value = ''
    o.disabled = true
    return o
  }

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

  /** 该档的描述（生图看 size/refs，视频看 frames/fps/height）。契约里没有就返回 null，绝不编。 */
  function speedSlot(speed, mode) {
    var map = schema && schema.speedMap
    var key = mode === 'video' ? 'video' : 'image'
    var slot = map && map[key] ? map[key][quantize(speed)] : null
    return slot && typeof slot === 'object' ? slot : null
  }

  function speedEdge(speed, mode) {
    var slot = speedSlot(speed, mode)
    return slot && Number.isFinite(slot.size) ? slot.size : null
  }

  function speedRefs(speed, mode) {
    var slot = speedSlot(speed, mode)
    return slot && Number.isFinite(slot.refs) ? slot.refs : null
  }

  /**
   * 当前模式的卡片计划（schema.modePlans，见 lib/mode-schema.js）。
   * 旧 schema 没有这项 → 返回空对象，所有卡片照旧全显（向后兼容）。
   */
  function modePlan() {
    var plans = schema && schema.modePlans
    return (plans && plans[state && state.mode]) || {}
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
      var def = defs[key]
      // ★ 自由文本控制项（负面提示词）：按字符截断，不参与数字 clamp。
      if (def && def.type === 'text') {
        var raw = typeof src[key] === 'string' ? src[key] : String(src[key] == null ? '' : src[key])
        out[key] = def.max && def.max > 0 ? raw.slice(0, def.max) : raw
        return
      }
      out[key] = clampByDef(def, src[key])
    })
    return out
  }

  /** 人话摘要：档位一律标「吸附」，没实测基准就不编 ETA 数字。 */
  function describe(input) {
    var c = buildPayload(input)
    var ticks = aspectTicks()
    var idx = Math.min(ticks.length - 1, Math.max(0, Math.trunc(c.aspect || 0)))
    var slot = speedSlot(c.speedPercent, c.mode)
    var parts = [ticks[idx], '速度 ' + c.speedPercent + '%（吸附 ' + quantize(c.speedPercent) + ' 档）']
    if (slot) {
      if (Number.isFinite(slot.size)) parts.push('长边 ' + slot.size)
      if (Number.isFinite(slot.refs)) parts.push('该档参考图预算 ' + slot.refs)
      if (Number.isFinite(slot.frames)) parts.push(slot.frames + ' 帧')
      if (Number.isFinite(slot.fps)) parts.push(slot.fps + ' fps')
      if (Number.isFinite(slot.height)) parts.push('高 ' + slot.height)
    }
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

  /** 模式可用性探测：只在端点明确回 available=true 时放行，拿不到就保持默认。 */
  function loadModes() {
    return fetch(MODES_PATH, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (j && j.ok && Array.isArray(j.modes)) {
          for (var i = 0; i < j.modes.length; i += 1) {
            var m = j.modes[i]
            if (m && typeof m.id === 'string') modeAvailability[m.id] = m.available === true
          }
          if (j.hybrid && typeof j.hybrid.reason === 'string') modeReason.hybrid = j.hybrid.reason
        }
        return modeAvailability
      })
      .catch(function () { return modeAvailability })
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

  /** 卡片化分区容器：统一 .cp-card 外观 + 一行小标题（UI 现代化重构）。 */
  function card(title, cls) {
    var c = el('div', 'cp-card' + (cls ? ' ' + cls : ''))
    if (title) c.appendChild(el('div', 'cp-card-title', title))
    return c
  }

  function setStatus(text, kind) {
    if (!nodes || !nodes.status) return
    nodes.status.textContent = text
    nodes.status.className = 'cp-status' + (kind ? ' is-' + kind : '')
  }

  /**
   * 生成进度（v3 需求第 3 条）。
   * ⚠ 只渲染它自己拿到的东西：
   *   · 队列位置与已等时长来自 host 的 `/queue` 反查（真数据）；
   *   · 百分比**只在有自家实测基准时**才画，否则走不定长进度条——
   *     拿"时间比例"冒充"采样百分比"就是假进度条，宁可不给。
   */
  function paintProgress(payload) {
    if (!nodes || !nodes.progress) return
    var wrap = nodes.progress
    var items = payload && Array.isArray(payload.items) ? payload.items : []
    if (items.length === 0) { wrap.hidden = true; return }
    var it = items[0]
    wrap.hidden = false
    var fill = wrap.querySelector('.cp-progress-fill')
    var note = wrap.querySelector('.cp-progress-note')
    if (fill) {
      fill.style.width = (it.percent === null || it.percent === undefined ? 100 : it.percent) + '%'
      fill.className = 'cp-progress-fill' + (it.percent === null || it.percent === undefined ? ' is-indeterminate' : '')
    }
    if (note) note.textContent = String(it.note || '')
  }

  function pollProgress() {
    try {
      fetch(PROGRESS_PATH, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          var items = j && j.ok && Array.isArray(j.items) ? j.items : []
          // 有进度就归零（回到快档）；连续空列表逐步降频，面板常开不白刷接口。
          if (items.length > 0) progressIdleTicks = 0
          else progressIdleTicks += 1
          if (j && j.ok) paintProgress(j)
        })
        .catch(function () { progressIdleTicks += 1 /* 进度拿不到就不显示，不报错弹窗 */ })
    } catch (err) { progressIdleTicks += 1 /* 同上 */ }
  }

  // ★ 用递归 setTimeout 而非固定 setInterval —— 间隔随 idleTicks 动态降频。
  function pollTick() {
    if (progressTimer === null) return
    pollProgress()
    progressTimer = setTimeout(pollTick, pollIntervalMs(progressIdleTicks))
  }

  function startPolling() {
    if (progressTimer !== null) return
    progressIdleTicks = 0
    pollProgress()
    progressTimer = setTimeout(pollTick, pollIntervalMs(progressIdleTicks))
  }

  function stopPolling() {
    if (progressTimer === null) return
    clearTimeout(progressTimer)
    progressTimer = null
  }

  /* ---------- 素材库：设计风格 / 用户指令 / 装载 skill ---------- */

  var libState = { styles: [], skillsAvailable: [], selected: 'none', instruction: '', skills: [] }

  function loadLibrary() {
    return fetch(LIBRARY_PATH, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        if (j && j.ok) {
          libState = {
            styles: Array.isArray(j.styles) ? j.styles : [],
            skillsAvailable: Array.isArray(j.skillsAvailable) ? j.skillsAvailable : [],
            selected: j.selected || 'none',
            instruction: j.instruction || '',
            skills: Array.isArray(j.skills) ? j.skills : [],
            libraryError: '',
          }
        } else {
          libState.libraryError = '素材库端点未返回有效数据'
        }
        paintLibrary()
      })
      .catch(function (err) {
        // 不再静默：错误态也要落到下拉里，用户看得见"读失败"而不是空白。
        libState.libraryError = String(err && err.message ? err.message : err || '请求失败')
        paintLibrary()
      })
  }

  function saveLibrary(patch) {
    Object.assign(libState, patch)
    return fetch(LIBRARY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected: libState.selected, instruction: libState.instruction, skills: libState.skills }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || j.ok !== true) { setStatus('素材库保存失败：' + ((j && j.reason) || '未知原因'), 'err'); return }
        setStatus(j.saved === false ? '素材库已生效（写盘失败：' + (j.reason || '目录只读') + '）' : '素材库已保存', j.saved === false ? 'err' : 'ok')
      })
      .catch(function (err) { setStatus('素材库保存失败：' + (err && err.message ? err.message : err), 'err') })
  }

  function paintLibrary() {
    if (!nodes || !nodes.library) return
    var box = nodes.library
    var sel = box.querySelector('.cp-select')
    var ta = box.querySelector('.cp-textarea')
    var list = box.querySelector('.cp-skills')
    if (!sel || !ta || !list) return
    // 风格下拉
    while (sel.children.length > 0) sel.removeChild(sel.children[0])
    if (libState.styles.length === 0) {
      var emptyLabel = libState.libraryError
        ? '（素材库读取失败，请稍后重试）' : '（暂无设计风格）'
      var emptyOpt = el('option', null, emptyLabel)
      emptyOpt.value = ''
      emptyOpt.disabled = true
      sel.appendChild(emptyOpt)
    }
    for (var i = 0; i < libState.styles.length; i += 1) {
      var o = el('option', null, libState.styles[i].name)
      o.value = libState.styles[i].id
      sel.appendChild(o)
    }
    sel.value = libState.selected
    ta.value = libState.instruction
    // ★ 技能装载：带颜色圆点的 Tag 胶囊，整块可点、点整块变色（不再用原生小方块）
    while (list.children.length > 0) list.removeChild(list.children[0])
    for (var k = 0; k < libState.skillsAvailable.length; k += 1) {
      var sk = libState.skillsAvailable[k]
      var on = libState.skills.indexOf(sk.id) >= 0
      var tag = el('button', 'cp-skill-tag' + (on ? ' is-on' : ''))
      tag.type = 'button'
      tag.value = sk.id
      tag.title = sk.desc || ''
      if (typeof tag.setAttribute === 'function') {
        tag.setAttribute('role', 'checkbox')
        tag.setAttribute('aria-checked', on ? 'true' : 'false')
      }
      tag.appendChild(el('span', 'cp-skill-dot'))
      tag.appendChild(el('span', 'cp-skill-name', sk.name || sk.id))
      if (sk.desc) tag.appendChild(el('span', 'cp-skill-desc', sk.desc))
      tag.addEventListener('click', (function (id) {
        return function () {
          var tags = list.querySelectorAll('.cp-skill-tag')
          var picked = []
          for (var n = 0; n < tags.length; n += 1) {
            if (String(tags[n].className).indexOf('is-on') >= 0) picked.push(tags[n].value)
          }
          var at = picked.indexOf(id)
          if (at >= 0) picked.splice(at, 1); else picked.push(id)
          for (var m = 0; m < tags.length; m += 1) {
            var t = tags[m]
            var isOn = picked.indexOf(t.value) >= 0
            t.className = 'cp-skill-tag' + (isOn ? ' is-on' : '')
            if (typeof t.setAttribute === 'function') t.setAttribute('aria-checked', isOn ? 'true' : 'false')
          }
          libState.skills = picked
          saveLibrary({ skills: picked })
        }
      })(sk.id))
      list.appendChild(tag)
    }
    var hint = box.querySelector('.cp-library-hint')
    if (hint) {
      hint.textContent = libState.skillsAvailable.length === 0
        ? '没找到本机已装的 skill（~/.dsh/skills）。请先装载美术、画风、配色相关的 skill。'
        : '共 ' + libState.skillsAvailable.length + ' 个可装载；建议勾美术 / 画风 / 配色相关的，勾上后会把名字与摘要拼进提示词。'
    }
  }

  /* ---------- 角色参考：模型无关策略 + 逐次同意的联网检索 ----------
   * 三条不能破的线：
   *   ① 默认不启用任何策略（''）：生成路径与升级前逐字节一致，零漂移。
   *   ② 策略偏好只存进程内存（服务端 /reference/prefer 也是），不落盘、不写记忆。
   *   ③ 联网检索**绝不自动发**：只有用户主动点「仅本次同意并检索」才 POST 一次
   *      带 consent:true 的请求；按钮不是开关，一次点击只管一次，不留"已同意"状态。
   *      候选只以文本 URL 展示 —— 渲染 <img src=...> 会让浏览器自动下载远程字节，
   *      等于绕过同意门，这条线不能碰。
   */
  var refState = {
    available: false,
    online: false,
    mode: 'image',
    preferred: '',
    selectedLabel: '',
    strategies: [],
    web: null,
    query: '',
    busy: false,
    hint: '',       // 能力探测类提示
    note: '',       // 检索结果 / 错误（与探测提示分开，避免互相覆盖）
    candidates: [],
  }

  function loadReference() {
    var mode = state && state.mode === 'video' ? 'video' : 'image'
    refState.mode = mode
    return fetch(REFERENCE_PATH + '?mode=' + encodeURIComponent(mode), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) {
        refState.available = Boolean(j && j.ok === true)
        if (!refState.available) {
          refState.online = false
          refState.strategies = []
          refState.hint = '未探到角色参考能力端点（后端未启动 / 未升级）。其它功能不受影响。'
          paintReference()
          return
        }
        refState.online = j.online === true
        refState.preferred = typeof j.preferred === 'string' ? j.preferred : ''
        refState.selectedLabel = typeof j.selectedLabel === 'string' ? j.selectedLabel : ''
        refState.strategies = Array.isArray(j.strategies) ? j.strategies : []
        refState.web = j.web && typeof j.web === 'object' ? j.web : null
        refState.hint = ''
        paintReference()
      })
      .catch(function () {
        refState.available = false
        refState.online = false
        refState.strategies = []
        refState.hint = '未探到角色参考能力端点（后端未启动 / 未升级）。其它功能不受影响。'
        paintReference()
      })
  }

  function paintReference() {
    if (!nodes || !nodes.reference) return
    var box = nodes.reference
    var sel = box.querySelector('.cp-ref-select')
    var status = box.querySelector('.cp-ref-status')
    var result = box.querySelector('.cp-ref-result')
    var list = box.querySelector('.cp-ref-candidates')
    var btn = box.querySelector('.cp-ref-search')
    var query = box.querySelector('.cp-ref-query')
    if (!sel || !status || !result || !list || !btn || !query) return

    while (sel.children.length > 0) sel.removeChild(sel.children[0])
    var off = el('option', null, '不启用（默认 · 不改工作流）')
    off.value = ''
    sel.appendChild(off)
    var auto = el('option', null, '自动协商（按后端真实能力）')
    auto.value = 'auto'
    sel.appendChild(auto)
    var usable = 0
    for (var i = 0; i < refState.strategies.length; i += 1) {
      var s = refState.strategies[i]
      if (!s || typeof s.id !== 'string') continue
      if (s.available === true) usable += 1
      var o = el('option', null, String(s.label || s.id) + (s.available === false ? '（当前后端不可用）' : ''))
      o.value = s.id
      sel.appendChild(o)
    }
    sel.value = refState.preferred
    query.value = String(refState.query || '')
    btn.disabled = refState.busy === true

    if (refState.hint !== '') {
      status.textContent = refState.hint
    } else if (!refState.available) {
      status.textContent = '正在探测后端能力…（通用兜底不依赖探测结果，任何扩散模型都成立）'
    } else if (refState.online) {
      status.textContent = '后端已连接 · 自动选中「' + refState.selectedLabel + '」· 可用策略 '
        + usable + ' 种（' + refState.mode + '）'
    } else {
      status.textContent = '后端未连接 · 能力清单暂查不到；通用兜底仍可用于任何扩散模型'
    }
    result.textContent = String(refState.note || '')
    // ★ 只写文本，绝不渲染 <img src=...> —— 那会自动下载远程字节，越过同意门。
    list.textContent = refState.candidates.length > 0
      ? refState.candidates.slice(0, 6).join('\n')
      : ''
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
      // 胶囊滑块「已划过」的填充色：把当前值换算成轨道百分比写进 CSS 变量。
      // 假 DOM 的 style 是普通对象（无 setProperty），守卫后跳过即可，不影响真渲染。
      if (input.type === 'range' && input.style && typeof input.style.setProperty === 'function') {
        var lo = Number(input.min)
        var hi = Number(input.max)
        var num = Number(v)
        var pct = Number.isFinite(num) && hi > lo ? ((num - lo) / (hi - lo)) * 100 : 0
        input.style.setProperty('--cp-fill', Math.max(0, Math.min(100, pct)) + '%')
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

  /** 自由文本控制项（负面提示词）：渲染成 textarea。 */
  function textField(label, key, opts) {
    var def = defsByKey()[key] || {}
    var wrap = el('div', 'cp-field' + (opts && opts.disabled ? ' cp-off' : ''))
    var top = el('div', 'cp-field-top')
    top.appendChild(el('span', 'cp-label', label))
    wrap.appendChild(top)
    var ta = el('textarea', 'cp-textarea cp-text')
    ta.rows = 2
    ta.placeholder = (opts && opts.placeholder) || ''
    ta.value = String(state[key] !== undefined ? state[key] : (def['default'] !== undefined ? def['default'] : ''))
    if (opts && opts.hint) ta.placeholder = ta.placeholder
    wrap.appendChild(ta)
    if (opts && opts.hint) wrap.appendChild(el('p', 'cp-hint', opts.hint))
    ta.addEventListener('input', function () {
      var raw = String(ta.value)
      state[key] = def.max && def.max > 0 ? raw.slice(0, def.max) : raw
      scheduleSave()
    })
    wrap._paint = function () { ta.value = String(state[key] != null ? state[key] : '') }
    return wrap
  }

  /* ============================ 点按兜底 ============================
   * ★★ 2026-11-15 第五次报障「悬浮球没反应 / 叉叉也点不动」的两个真根因：
   *   ① DSH 宿主在 pointerdown 上 preventDefault，click 不派发。
   *     assets/setup-guide.js::installPointerFallback() 的兜底是在
   *     pointerup / mouseup / touchend 时**合成 click**（target.click()），
   *     ⇒ 按钮必须自己绑 click 才救得活。此前 cp-fab 在 hasPointer 分支
   *     只绑 pointerup、没绑 click，所以把 cp-fab 加进兜底白名单也没用。
   *   ② wire() 只在首次 mount 跑一次，绑的是 firstPanel 上的 .cp-x；
   *     切模式 / 宿主重建会 render() 造全新 panel + 全新叉叉，旧监听随旧节点
   *     一起消失 ⇒ 叉叉永久失效。
   * 修法：四种「抬起」事件 + 300ms 冷却；叉叉绑定搬进 render()，每次重建都重绑。
   * ★ 联动纪律：改了兜底层（setup-guide）必须核实消费端真的绑了它合成的事件，
   *   否则就是「白名单加了、按钮还是点不动」的孤儿接线。
   */
  var UI_BUILD = '2026-11-16.1'
  var TAP_EVENTS = ['click', 'pointerup', 'mouseup', 'touchend']
  var TAP_COOLDOWN_MS = 300

  /** 一次手势只放行一次；拖动期间由 suppressUntil 抑制（拖完不该误开关面板）。 */
  function tapFire(state) {
    var now = Date.now()
    if (now < (state.suppressUntil || 0)) return false
    if (now - state.last < TAP_COOLDOWN_MS) return false
    state.last = now
    return true
  }

  /** 给任意按钮绑四种「抬起」事件；shared 可传入同一 state 与拖动链共用冷却。 */
  function bindTap(node, fn, events, shared) {
    var state = shared || { last: 0, suppressUntil: 0 }
    if (!node || typeof node.addEventListener !== 'function') return state
    var list = events || TAP_EVENTS
    for (var i = 0; i < list.length; i += 1) {
      (function (type) {
        node.addEventListener(type, function () {
          if (!tapFire(state)) return
          try { fn() } catch (err) { /* 点按异常不卡死面板 */ }
        })
      })(list[i])
    }
    return state
  }

  function render() {
    var modes = (schema && schema.modes) || []
    var ticks = aspectTicks()

    // 重建时复用已有浮标（否则每切一次模式就多一个按钮）
    // ⚠ 必须写 document.body，不能写 `body`——本函数后面有个 `var body` 是高级区容器，
    //   `var` 提升会让这里读到 undefined（这类错本套回归专门抓，它确实当场抓到了）。
    var fab = (nodes && nodes.fab) || document.body.querySelector('.cp-fab')
    if (!fab) {
      fab = el('button', 'cp-fab')
      fab.type = 'button'
      fab.appendChild(el('span', 'cp-fab-dot'))
      fab.appendChild(el('span', null, 'Comfy 控制'))
      document.body.appendChild(fab)
    }
    // ★ 自证标记：鼠标悬停能看到 UI 构建号，用来确认真机加载的是不是新脚本。
    //   DSH 页面不刷新时 loadComfyPipelinePanel() 会按 id 去重、不会重新加载脚本，
    //   所以「改完没反应」也可能是页面里还跑着上一次加载的旧代码。
    if (typeof fab.setAttribute === 'function') {
      fab.setAttribute('data-cp-ui-build', UI_BUILD)
      fab.title = 'Comfy 控制 · UI ' + UI_BUILD
    }

    var panel = el('div', 'cp-panel')
    panel.hidden = true
    // ★ 三模式差异化：根元素带 data-mode，CSS 按模式换强调色；计划驱动卡片取舍。
    panel.setAttribute('data-mode', state.mode || 'image')

    var head = el('div', 'cp-head')
    head.appendChild(el('h4', null, '通用 Comfy 控制层'))
    var x = el('button', 'cp-x', '×')
    x.type = 'button'
    // ★ 2026-11-15：叉叉必须在 render() 里绑 —— rebuild() 会换掉整个 panel，
    //   wire() 里那个「只绑一次 firstPanel」的旧写法会让重建后的叉叉永久失灵。
    bindTap(x, close)
    head.appendChild(x)
    panel.appendChild(head)

    // 进度块（默认隐藏：没任务时不占地方）
    var progress = el('div', 'cp-progress')
    progress.hidden = true
    var track = el('div', 'cp-progress-track')
    var fill = el('i', 'cp-progress-fill')
    fill.style.width = '0%'
    track.appendChild(fill)
    progress.appendChild(track)
    progress.appendChild(el('span', 'cp-progress-note', ''))
    panel.appendChild(progress)

    var tabs = el('nav', 'cp-tabs')
    var tabEls = {}
    modes.forEach(function (m) {
      // ★ 2026-11-10：可用性由 /api/comfy-pipeline/modes 探测决定（TTS 装好就自动放行）。
      //   缺件时把 ttsMissingReport 的完整清单放进 title，不在 note 里塞一大段。
      var available = modeAvailability[m.id] !== false
      var b = el('button', 'cp-tab' + (m.id === state.mode ? ' is-on' : ''), m.label || m.id)
      b.type = 'button'
      b.title = available
        ? ('交付 ' + (m.deliver || ''))
        : (modeReason[m.id] || '后端工作流未接入，暂不可选')
      if (!available) b.disabled = true
      b.addEventListener('click', function () {
        if (!available) return
        state.mode = m.id
        Object.keys(tabEls).forEach(function (id) { tabEls[id].className = 'cp-tab' + (id === state.mode ? ' is-on' : '') })
        scheduleSave()
        // 切模式要重建 DOM：视频组的可用态依赖它（重建不动 state，不丢已拨的值）
        rebuild()
        // 图片 / 视频两套策略清单不同，重新探一次，不拿旧模式的能力快照冒充新模式
        loadReference()
      })
      tabEls[m.id] = b
      tabs.appendChild(b)
    })
    panel.appendChild(tabs)

    // ★ 每个模式一句话定位（不再是三模式共用同一行空白 note）
    var plan = modePlan()
    if (plan.tagline) panel.appendChild(el('p', 'cp-tagline', plan.tagline))

    // ★ 2026-11-16 报障修复：三段模型各自可选。旧代码把 hybrid 折叠成 image、
    //   用 selected[state.mode] 取 hybrid 键（后端根本没这个键）→ 回显恒空，
    //   且 TTS 段完全无入口。现在每段各有独立下拉 + 独立落盘键 + 独立回显键。
    //   · 生图段 → mainmodel / selected.image
    //   · TTS 段 → ttsbackend + ttsvoice / selected.tts_backend + tts_voice_sample
    //   · 视频段 → unetvideo / selected.video
    if (state.mode === 'image' || state.mode === 'video' || state.mode === 'hybrid') {
      var modelDefs
      if (state.mode === 'hybrid') {
        modelDefs = [
          { label: '混合链 ① 生图主模型', key: 'mainmodel', pick: 'image', src: 'unet', empty: '（自动挑）' },
          { label: '混合链 ② TTS 后端', key: 'ttsbackend', pick: 'tts_backend', src: 'tts_backends', empty: '（默认 Qwen3-TTS）' },
          { label: '混合链 ③ 音色样本', key: 'ttsvoice', pick: 'tts_voice_sample', src: 'tts_voices', empty: '（默认音色）' },
          { label: '混合链 ④ 视频主模型', key: 'unetvideo', pick: 'video', src: 'unet', empty: '（默认 Hummingbird-XT-5B）' },
        ]
      } else if (state.mode === 'video') {
        modelDefs = [{ label: '视频主模型（架构不符会被拒收）', key: 'unetvideo', pick: 'video', src: 'unet', empty: '（默认 Hummingbird-XT-5B）' }]
      } else {
        modelDefs = [{ label: '生图主模型（清空 = 自动挑）', key: 'mainmodel', pick: 'image', src: 'unet', empty: '（自动挑）' }]
      }
      var modelPicks = []
      modelDefs.forEach(function (def) {
        var mc = card(def.label, 'cp-model-card')
        var mSel = el('select', 'cp-select cp-model-select')
        var mStatus = el('p', 'cp-hint cp-model-status', '正在读取本机清单…')
        mSel.addEventListener('change', function () {
          var payload = {}
          payload[def.key] = String(mSel.value)
          mStatus.textContent = '正在保存…'
          fetch('api/qwen-paint/status.json', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
            .then(function (r) { return r.json() })
            .then(function (j) {
              // ★ 2026-11-16 假成功根治：后端拒绝时必须说"没生效"，不能再无条件报喜。
              var cr = j && j.choiceResult
              var rejects = cr && Array.isArray(cr.rejections) ? cr.rejections : []
              // 一次 POST 只改一个控件，但响应里可能带着别的写参数的拒绝原因。
              // 先按 label 认领自己的；认不出且全场只有一条时再兜底，绝不张冠李戴。
              var mine = rejects.filter(function (r) {
                return def.label.indexOf(r.label) >= 0 || r.label.indexOf(def.label) >= 0
              })[0] || (rejects.length === 1 ? rejects[0] : null)
              if (cr && cr.ok === false && mine) {
                mStatus.textContent = '未生效：' + (mine.reason ? mine.reason : '所选值被本机拒绝')
                mStatus.setAttribute('data-choice-rejected', '1')
                return
              }
              mStatus.removeAttribute('data-choice-rejected')
              mStatus.textContent = mSel.value === ''
                ? '已清除（回到默认/自动挑）' : '已选 ' + mSel.value + '（下次生成生效）'
            })
            .catch(function (err) { mStatus.textContent = '保存失败：' + (err && err.message ? err.message : err) })
        })
        mc.appendChild(mSel)
        mc.appendChild(mStatus)
        panel.appendChild(mc)
        modelPicks.push({ def: def, sel: mSel, status: mStatus })
      })
      function applyModelOptions(j) {
        if (!j || j.ok !== true) {
          modelPicks.forEach(function (p) { p.status.textContent = '模型清单读取失败' })
          return
        }
        if (j.online !== true) {
          modelPicks.forEach(function (p) { p.status.textContent = j.reason || 'ComfyUI 未在线，候选暂不可用' })
          return
        }
        var sel = j.selected && typeof j.selected === 'object' ? j.selected : {}
        modelPicks.forEach(function (p) {
          var opts = []
          if (p.def.src === 'unet') {
            var unet = Array.isArray(j.unet) ? j.unet : []
            for (var i = 0; i < unet.length; i += 1) opts.push({ value: String(unet[i]), label: String(unet[i]) })
          } else if (p.def.src === 'tts_backends') {
            var bs = Array.isArray(j.tts_backends) ? j.tts_backends : []
            for (var k = 0; k < bs.length; k += 1) {
              var flag = bs[k].available ? '' : '（未探测到）'
              opts.push({ value: String(bs[k].id), label: String(bs[k].label) + flag })
            }
          } else if (p.def.src === 'tts_voices') {
            var vs = Array.isArray(j.tts_voices) ? j.tts_voices : []
            for (var v = 0; v < vs.length; v += 1) opts.push({ value: String(vs[v].token), label: String(vs[v].name) + ' · ' + String(vs[v].format || '') })
          }
          var cur = typeof sel[p.def.pick] === 'string' ? sel[p.def.pick] : ''
          // 增量回填：选项集合没变就不重建 DOM，只改 value —— 切模式/重开面板不再卡。
          fillSelect(p.sel, opts, cur, p.def.empty, el)
          p.status.textContent = opts.length > 0
            ? '共 ' + opts.length + ' 个本机可用候选'
            : (p.def.src === 'unet' ? 'ComfyUI 在线但没探到主模型文件（models/unet 为空？）' : '暂无候选（未探测到节点 / 未拖入音频样本）')
        })
      }
      // 真正发请求：成功且在线才写两层缓存（内存 + localStorage），失败/离线不缓存留重试。
      // silent=true 表示命中持久化缓存后的后台刷新：失败不覆盖已显示的好状态。
      function fetchModelOptions(silent) {
        fetch(MODEL_OPTIONS_PATH, { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.ok === true && j.online === true) {
              modelOptionsCache = modelOptionsEntry(j, Date.now())
              savePersistedModels(getStorage(), j, Date.now())
            }
            applyModelOptions(j)
          })
          .catch(function (err) {
            if (!silent) {
              modelPicks.forEach(function (p) { p.status.textContent = '模型清单读取失败：' + (err && err.message ? err.message : err) })
            }
          })
      }
      // ★ 命中内存 TTL 缓存：瞬时回填，零请求。
      if (modelOptionsFresh(modelOptionsCache, Date.now(), MODEL_OPTIONS_TTL_MS)) {
        applyModelOptions(modelOptionsCache.data)
      } else {
        // ★ 二次报障根治：内存缓存刷新页面即清零 ⇒ 先读 localStorage 持久化清单，
        //   命中就**同步**回填（下拉立刻能选，不再是白条等 3.4MB objectInfo），再后台静默刷新。
        var persisted = loadPersistedModels(getStorage(), Date.now(), MODEL_OPTIONS_TTL_MS)
        if (persisted) {
          modelOptionsCache = modelOptionsEntry(persisted, Date.now())
          applyModelOptions(persisted)
          fetchModelOptions(true)
        } else {
          // 首次安装 / 缓存过期：放一个禁用占位，不让 select 完全空白；然后拉真清单。
          modelPicks.forEach(function (p) { p.sel.appendChild(placeholderOption('（正在读取本机清单…）', el)) })
          fetchModelOptions(false)
        }
      }
    }

    // ★ 2026-11-16 PPT 模式专属卡：deckTitle + slidesJson → POST /api/qwen-paint/pptx
    //   （轻量档纯 JS 零 GPU，路由已存在）。解析失败先在前端如实拦下。
    if (plan.cards && plan.cards.ppt === true) {
      var pc = card('PPT 大纲（轻量档 · 零 GPU）', 'cp-ppt-card')
      var pt = el('input', 'cp-ppt-title')
      pt.type = 'text'
      pt.placeholder = 'PPT 标题，例：季度汇报'
      var pj = el('textarea', 'cp-textarea cp-ppt-slides')
      pj.rows = 6
      pj.placeholder = '[{"title":"章节一","bullets":["要点 A","要点 B"]}]'
      var pStatus = el('p', 'cp-hint cp-ppt-status', '大纲级草稿；排版美化请走标准/质量档。')
      var pBtn = el('button', 'cp-ref-search', '生成 PPTX')
      pBtn.type = 'button'
      pBtn.addEventListener('click', function () {
        var slides = []
        try { slides = JSON.parse(String(pj.value || '[]')) } catch (e) {
          pStatus.textContent = 'slides JSON 解析失败：' + (e && e.message ? e.message : e) + '（未发起请求）'
          return
        }
        pStatus.textContent = '正在生成 PPTX（纯 JS）…'
        fetch('api/qwen-paint/pptx', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: String(pt.value || '').trim(), slides: slides }),
        })
          .then(function (r) { return r.json() })
          .then(function (j) {
            pStatus.textContent = j && j.ok === true
              ? '已生成：' + (j.output_path || '') + '（' + (j.slides || 0) + ' 页 / ' + (j.bytes || 0) + ' B）'
              : '未生成：' + ((j && j.reason) || '未知原因')
          })
          .catch(function (err) { pStatus.textContent = '请求失败：' + (err && err.message ? err.message : err) })
      })
      pc.appendChild(el('div', 'cp-field-label', 'PPT 标题'))
      pc.appendChild(pt)
      pc.appendChild(el('div', 'cp-field-label', '幻灯片大纲 JSON [{title,bullets[]}]'))
      pc.appendChild(pj)
      pc.appendChild(pBtn)
      pc.appendChild(pStatus)
      panel.appendChild(pc)
    }

    var note = el('p', 'cp-note', '')
    panel.appendChild(note)

    var common = card('画面设置', 'cp-common')
    common.appendChild(field('画幅比例', 'aspect', { ticks: ticks }))
    common.appendChild(field('速度百分比', 'speedPercent', {
      hint: '',
      onPaint: function (v, hint) {
        if (!hint) return
        var d = describe({ aspect: state.aspect, speedPercent: v })
        hint.textContent = d + '（只压画幅像素预算，不改蒸馏步数 —— 不掉画质）'
      },
    }))
    // ★ 0.19.2：负面提示词升为一级可调（之前只藏在风格包里）。
    common.appendChild(textField('负面提示词', 'negative', {
      hint: '不想出现的东西：blurry、多余文字、畸变等。留空用模型默认。',
    }))
    // ★ 2026-11-16：卡片按 modePlans.cards 门控（false = 整卡不渲染，PPT 模式不显示画幅/速度）。
    if (!(plan.cards && plan.cards.common === false)) panel.appendChild(common)

    // ★ 视频参数组：帧数与帧率**真接** generate_video（见 lib/video-workflow.js）。
    //   ★ 差异化：生图模式**整卡不渲染**（挂着三个 disabled 滑块只会让人以为
    //   「生图也有帧数」）；视频/混合模式启用。旧 schema（无 modePlans）照旧全显。
    var videoOn = state.mode === 'video' || state.mode === 'hybrid'
    var showVideo = !(plan.cards && plan.cards['video-group'] === false)
    var vgroup = showVideo ? card('视频参数', 'cp-video-group') : null
    if (showVideo) {
    vgroup.appendChild(field('帧数', 'frames', {
      disabled: !videoOn,
      hint: videoOn ? '' : '先切到视频模式。',
      onPaint: function (v, hint) {
        if (!hint) return
        var f = Number(state.frames)
        var fps = Number(state.fps) || 24
        hint.textContent = f + ' 帧 @' + fps + 'fps ≈ ' + (f / fps).toFixed(2) + 's 成片（帧数自动对齐 4n+1）'
      },
    }))
    vgroup.appendChild(field('帧率 fps', 'fps', { disabled: !videoOn, hint: videoOn ? '' : '先切到视频模式。' }))
    vgroup.appendChild(field('运动幅度', 'motion', {
      disabled: true,
      hint: 'XT-5B 链没有运动幅度参数（只有提示词里写运镜）—— 不装能拨的假滑块。',
    }))
    panel.appendChild(vgroup)
    }

    // ★ 混合模式专属：三段链说明卡。旁白文本与音色由 Agent 按素材库风格包生成，
    //   面板没有可调参数 —— 只讲清链路与边界，不装假滑块。
    if (plan.cards && plan.cards.tts === true) {
      var ttsCard = card('混合链：生图 → TTS → 视频', 'cp-tts-group')
      ttsCard.appendChild(el('p', 'cp-hint',
        '三段各自出活：先生成首帧图，Qwen3-TTS 合成旁白音频，Wan22 把图变成视频。'
        + '音频与 mp4 不自动合流 —— 拿到两个文件后用剪辑工具拼接。'))
      ttsCard.appendChild(el('p', 'cp-hint',
        '旁白内容按素材库的「设计风格 + 用户指令」由 Agent 生成；分段拼接的重叠帧数'
        + '见高级设置的「分块重叠」（混合链会读取本值）。'))
      panel.appendChild(ttsCard)
    }

    // ★ 素材库（用户定义：设计风格 + 用户指令 + 自行装载的 skill）
    var library = card('素材库', 'cp-library')
    library.appendChild(el('div', 'cp-field-label', '设计风格'))
    var styleSel = el('select', 'cp-select')
    // ★ 2026-11-16 P1：创建时零 option + 空 catch = 请求失败永久白条。先放禁用占位。
    var stylePlace = el('option', null, '（正在读取素材库…）')
    stylePlace.value = ''
    stylePlace.disabled = true
    styleSel.appendChild(stylePlace)
    styleSel.addEventListener('change', function () { saveLibrary({ selected: styleSel.value }) })
    library.appendChild(styleSel)
    library.appendChild(el('div', 'cp-field-label', '用户指令（每次生成都带上）'))
    var instr = el('textarea', 'cp-textarea')
    instr.rows = 2
    instr.placeholder = '例：不要卡通、要 35mm 胶片感'
    instr.addEventListener('change', function () { saveLibrary({ instruction: instr.value }) })
    library.appendChild(instr)
    library.appendChild(el('div', 'cp-field-label', '可装载的技能（请装载美术、画风、配色相关的 skill）'))
    library.appendChild(el('div', 'cp-skills'))
    library.appendChild(el('p', 'cp-hint cp-library-hint', ''))
    if (!(plan.cards && plan.cards.library === false)) panel.appendChild(library)

    // ★ 角色参考：独立卡片，刻意不用 .cp-field / checkbox —— 面板回归锁的是
    //   「13 个 .cp-field + 6 个 disabled input」，新 UI 不能挤进那套计数里。
    var reference = card('角色参考（模型无关）', 'cp-reference')
    reference.appendChild(el('p', 'cp-hint',
      '默认不启用 = 生成路径与升级前逐字节一致。启用后按后端 /object_info 的真实节点能力协商；'
      + '协商不到需配套权重的专属适配器（IP-Adapter / ControlNet Reference 等）就自动落到只用基础节点的通用兜底。'))
    reference.appendChild(el('div', 'cp-field-label', '参考策略（只存进程内存，重启回默认）'))
    var refSel = el('select', 'cp-select cp-ref-select')
    refSel.addEventListener('change', function () {
      var v = String(refSel.value)
      refState.preferred = v
      // 只发一个策略 id：不发起任何外部请求，也不写配置 / 记忆。
      fetch(REFERENCE_PREFER_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: v }),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (j && j.ok === true) refState.preferred = typeof j.preferred === 'string' ? j.preferred : v
          setStatus(j && j.ok === true
            ? (refState.preferred === '' ? '角色参考已关闭（零漂移）' : '参考策略已生效：' + refState.preferred)
            : '参考策略保存失败：' + ((j && j.reason) || '未知原因'))
          paintReference()
        })
        .catch(function (err) { setStatus('参考策略保存失败：' + (err && err.message ? err.message : err)) })
    })
    reference.appendChild(refSel)
    reference.appendChild(el('p', 'cp-hint cp-ref-status', ''))

    reference.appendChild(el('div', 'cp-field-label', '联网参考图检索（默认拒绝 · 每次单独同意）'))
    reference.appendChild(el('p', 'cp-hint',
      '只把查询词发往你在配置里指定的外部 https 端点，出站字段仅 query / limit / media；'
      + '不含提示词、seed、本机路径或凭据。只返回候选 URL，插件不下载远程图片字节。端点未配置时一律拒绝。'))
    var refQuery = el('input', 'cp-ref-query')
    refQuery.type = 'text'
    refQuery.placeholder = '例：红发角色 三视图'
    refQuery.addEventListener('input', function () { refState.query = String(refQuery.value) })
    reference.appendChild(refQuery)
    var refBtn = el('button', 'cp-ref-search', '仅本次同意并检索')
    refBtn.type = 'button'
    refBtn.addEventListener('click', function () {
      var q = String(refState.query || '').trim()
      if (q === '') {
        refState.note = '先填查询词；未发起任何联网请求。'
        paintReference()
        return
      }
      if (refState.busy) return
      refState.busy = true
      refState.note = '本次已同意，正在检索…'
      refState.candidates = []
      paintReference()
      // ★ 一次点击 = 一次显式同意；不写任何「记住同意」的开关或持久化状态。
      fetch(REFERENCE_SEARCH_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, consent: true, limit: 6 }),
      })
        .then(function (r) { return r.json() })
        .then(function (j) {
          refState.busy = false
          if (!j || j.ok !== true) {
            refState.candidates = []
            refState.note = '检索未成功：' + ((j && (j.reason || j.code)) || '未知原因') + '（本次同意已随请求结束）'
          } else {
            var urls = []
            var arr = Array.isArray(j.candidates) ? j.candidates : []
            for (var n = 0; n < arr.length; n += 1) {
              if (arr[n] && typeof arr[n].url === 'string') urls.push(arr[n].url)
            }
            refState.candidates = urls
            refState.note = urls.length > 0
              ? '返回 ' + urls.length + ' 条候选（仅 URL，未下载图片）。选定后请自行保存并走本地参考图上传。'
              : '本次没有可用候选（只返回 URL，不下载图片字节）。'
          }
          paintReference()
        })
        .catch(function (err) {
          refState.busy = false
          refState.note = '检索失败：' + (err && err.message ? err.message : err) + '（本次同意已随请求结束）'
          paintReference()
        })
    })
    reference.appendChild(refBtn)
    reference.appendChild(el('p', 'cp-hint cp-ref-result', ''))
    reference.appendChild(el('p', 'cp-hint cp-ref-candidates', ''))
    if (!(plan.cards && plan.cards.reference === false)) panel.appendChild(reference)

    var adv = el('details', 'cp-card cp-adv')
    adv.appendChild(el('summary', null, '高级设置'))
    var body = el('div', 'cp-adv-body')
    // ★ 差异化：高级项按 modePlans.advShow 过滤（生图模式没有视频向的分块/重叠，
    //   挂着 disabled 假滑块只会添乱）。旧 schema（无 advShow）→ 全部照旧显示。
    var advShow = plan.advShow || null
    var advDefs = [
      ['种子（-1 = 每次随机）', 'seed', { hint: '同提示词 + 同种子 = 同一张图；-1 每次都不一样。' }],
      ['采样步数', 'steps', {
        hint: '仅在原生链路（textControl=native）真正按它采样；官方 Turbo 链固定 8/9 步蒸馏，会忽略本值。',
        warn: true,
      }],
      ['提示词引导 CFG', 'cfg', {
        hint: '引导尺度。蒸馏链（Turbo）强制 1.0；原生链默认 2.5，可调。',
      }],
      ['每轮张数', 'count', { hint: '同一次调用出多张只加载一次模型。' }],
      ['降噪 denoise', 'denoise', { disabled: true, hint: '编辑链的降噪由任务链内部按 LoRA 工作点定，暂不由面板接管。' }],
      ['VAE 分块 tileSize', 'tileSize', { disabled: true, hint: 'VAE 分块由优化开关接管，暂不走面板。' }],
      ['分块重叠 chunkOverlap', 'chunkOverlap', { disabled: true, hint: '混合链分段拼接会读取本值（默认 8 帧重叠），面板暂不开放调节。' }],
    ]
    advDefs.forEach(function (d) {
      if (advShow && advShow.indexOf(d[1]) === -1) return
      body.appendChild(field(d[0], d[1], d[2]))
    })
    adv.appendChild(body)
    if (!(plan.cards && plan.cards.advanced === false)) panel.appendChild(adv)

    var foot = el('div', 'cp-foot')
    var status = el('span', 'cp-status', '正在加载面板…')
    var reset = el('button', 'cp-reset', '恢复默认')
    reset.type = 'button'
    reset.addEventListener('click', function () {
      var defs = defsByKey()
      Object.keys(defs).forEach(function (k) {
        if (defs[k] && defs[k].type === 'text') state[k] = defs[k]['default'] != null ? defs[k]['default'] : ''
        else if (Number.isFinite(defs[k]['default'])) state[k] = defs[k]['default']
      })
      state.mode = 'image'
      syncInputs()
      scheduleSave()
      setStatus('已恢复默认值')
    })
    foot.appendChild(status)
    foot.appendChild(reset)
    panel.appendChild(foot)

    // ★★ 2026-11-15（用户第三次强调）：**不要独立的实验室浮层**。
    //   功能不删，但容器从「fixed 悬浮窗 + 独立浮标」改成面板内的一个普通插槽，
    //   由 lab.js 把各功能区直接 append 进来 —— 它就是 Comfy 控制面板的一部分，
    //   宽度跟随面板、贴边由面板决定，不再自己算 left/top/width。
    var labSlot = el('div', 'dshqp-lab-slot')
    labSlot.setAttribute('data-dshqp-lab-slot', '1')
    panel.appendChild(labSlot)

    document.body.appendChild(panel)
    nodes = { fab: fab, panel: panel, status: status, note: note, progress: progress,
      library: library, reference: reference, labSlot: labSlot }
    // rebuild() 会换掉 panel 节点；lab.js 已加载时立刻把功能重挂到新插槽，
    // 否则切一次模式功能区就消失（历史上 catch 过的「缓存旧节点」同类问题）。
    try {
      var lab = window.DshQpLab
      if (lab && typeof lab.mountInto === 'function') lab.mountInto(labSlot)
    } catch (err) { /* 实验室未就绪不影响主面板 */ }
    paintReference()
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
    var off = modes.filter(function (m) { return modeAvailability[m.id] === false })
    nodes.note.textContent = off.length === 0
      ? ''
      : off.map(function (m) { return (m.label || m.id) + '（' + (m.backends || m.chain || []).join(' / ') + '）'; }).join('、')
        + '：链里还有本插件没有的后端段，暂不可选。'
        + (modeReason.hybrid !== '' ? '（混合模式缺件清单见 tab 标题悬浮）' : '')
  }

  /** 重建面板 DOM（保留 state）。模式切换后视频组的 disabled 要变。 */
  function rebuild() {
    if (!nodes) return
    var wasOpen = nodes.panel.hidden === false
    try { nodes.panel.parentNode.removeChild(nodes.panel) } catch (err) { /* 已离体 */ }
    nodes = { fab: nodes.fab, panel: null, status: null, note: null, progress: null,
      library: null, reference: null, labSlot: null }
    render()
    if (wasOpen) open()
  }

  function open() {
    if (!nodes) return
    nodes.panel.hidden = false
    if (nodes.fab) syncPanelPos(nodes.fab, nodes.panel)
    refreshNote()
    startPolling() // 面板开着才轮询进度（关了就停，不白刷接口）
  }

  function close() {
    if (!nodes) return
    nodes.panel.hidden = true
    stopPolling()
  }

  /* ---------- 浮标拖动 ----------
   * 两个「点不动」根因一起修：
   *   ① 原开关绑在 click 上，而 click 是「按下+抬起+无拖动+无取消」的复合事件：
   *      指针轻移、文字被选中、或宿主在 pointerdown 上 preventDefault 都会让它不派发。
   *      改为在 pointerup 自行判定点按 —— 只要按下并抬起就一定有 pointerup，
   *      配合 setPointerCapture 把后续 move/up 锁到浮标，手势不再被吞。
   *   ② rebuild()（切模式）会换掉 nodes.panel，但旧开关闭包缓存了第一个 panel，
   *      之后它的 hidden 再不更新 ⇒ 判断永久卡在 close() 分支，面板再也打不开。
   *      toggle / 外部点击判定一律改读当前 nodes.panel，不缓存旧引用。
   * 位置存 localStorage；无 Pointer Events 的环境退化为「只点不拖」，按钮仍可用。
   * 所有宿主 API（localStorage / getBoundingClientRect / PointerEvent / setPointerCapture）
   * 都带 typeof 守卫，保证 node:vm 假 DOM 下 mount() 不抛错。
   */
  var FAB_POS_KEY = 'comfyPipelineFabPos'
  var DRAG_THRESHOLD = 5 // px：位移小于它算点按，否则算拖动

  function getStorage() {
    try { return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null }
    catch (err) { return null }
  }
  function readFabPos() {
    var s = getStorage()
    if (!s) return null
    try {
      var p = JSON.parse(s.getItem(FAB_POS_KEY) || 'null')
      return (p && Number.isFinite(p.left) && Number.isFinite(p.top)) ? p : null
    } catch (err) { return null }
  }
  function writeFabPos(p) {
    var s = getStorage()
    if (!s) return
    try { s.setItem(FAB_POS_KEY, JSON.stringify(p)) } catch (err) { /* 配额 / 隐私模式 */ }
  }
  function vpSize() {
    var w = (typeof window !== 'undefined' && Number.isFinite(window.innerWidth)) ? window.innerWidth : 1280
    var h = (typeof window !== 'undefined' && Number.isFinite(window.innerHeight)) ? window.innerHeight : 800
    return { w: w, h: h }
  }
  function fabSize(fab) {
    return {
      w: Number.isFinite(fab.offsetWidth) && fab.offsetWidth > 0 ? fab.offsetWidth : 132,
      h: Number.isFinite(fab.offsetHeight) && fab.offsetHeight > 0 ? fab.offsetHeight : 40,
    }
  }

  /* ---------- 浮标几何（纯函数，供回归用 node:vm 直接断言） ----------
   * 用户报障「悬浮球拉到最右边会吞掉展开的界面」→ 当时靠硬预留 pw 解决；
   * 2026-11-14 用户再报「拉不到右面去 / 限制那么多 / 只要对齐一点点」：
   * 改为由翻边保证面板可见，浮标不再被硬预留挤在左侧。
   * 2026-11-15 第三次报「我要它刚好靠边，不是你提前空那么多」：
   *   ⇒ EDGE_GAP = 0，CSS 默认 right/bottom 归零，面板与浮标间不再塞 12px。
   * ★★ 2026-11-15 第四次纠正（用户原话）：「展开的界面直接放到悬浮球的上方，
   *   不是悬浮球的右侧或者左侧」「展开界面 UI 对齐 DSH 的边框，就是边框对齐边框」
   *   「悬浮球放到右边不要变成一个更圆的球，跟以前一样就好」。
   *   ⇒ 删除 geomPanelSide 的左右翻边，改 geomPanelAbove：
   *     · 面板右缘恒等于浮标右缘；浮标贴右时两者右缘都是 vpW ⇒ 与 DSH 右边框同一条线；
   *     · 面板底缘 = 浮标上缘 - 6px 呼吸空隙（上方优先；空间不足只压缩面板高度，绝不翻到下方）；
   *     · 浮标尺寸不再随定位方式变化（CSS width:max-content + white-space:nowrap），
   *       原来的圆角 / padding / min-height 一个都不改。
   *   · 轻吸附：只有离边 ≤24px 才贴边，中间保留用户的微调位置；
   *   · 旧 localStorage 值（可能越界）也走同一 clamp。
   * 全部按数字算，不碰 DOM，因此离线可测；setFabPos / syncPanelPos 只负责读写 style。
   */
  var EDGE_GAP = 0
  // ★ 2026-11-16 用户拍板：展开面板与悬浮球之间留一点呼吸空隙（仅竖向；右缘贴边保持零空隙）。
  var GAP_ABOVE = 6
  function geomPanelWidth(vpW) {
    return Math.min(392, Math.max(EDGE_GAP, vpW))
  }
  /** 水平边界：只留浮标自身宽度，零视口边距（精确贴 DSH 左右边框）。
   * ★ 2026-11-14 去掉给右侧面板预留 pw 的硬边界；2026-11-15 再把 8px 边距归零。
   *   pw 参数保留以兼容既有调用（回归也按同一签名断言），只是不参与上界计算。
   */
  function geomFabBounds(vpW, fsW, pw) {
    void pw
    var minLeft = EDGE_GAP
    var maxLeft = Math.max(minLeft, vpW - fsW - EDGE_GAP)
    return { minLeft: minLeft, maxLeft: maxLeft }
  }
  /** 把任意 x（含越界旧值 / NaN）夹进水平边界。 */
  function geomClampFabX(x, bounds) {
    var n = Number(x)
    if (!Number.isFinite(n)) n = bounds.minLeft
    var hi = Math.max(bounds.minLeft, bounds.maxLeft)
    return Math.min(Math.max(bounds.minLeft, n), hi)
  }
  /** 轻吸附：只在离边很近（≤24px）时贴边，中间区域**保留用户放的位置**。
   * ★ 2026-11-14：旧实现无论放哪儿都吸到两端，用户「对齐一点点」的微调永远被弹回去。
   */
  var SNAP_NEAR = 24
  function geomSnapFabX(x, bounds) {
    var c = geomClampFabX(x, bounds)
    if (c - bounds.minLeft <= SNAP_NEAR) return bounds.minLeft
    if (bounds.maxLeft - c <= SNAP_NEAR) return bounds.maxLeft
    return c
  }
  /** 面板永远在浮标正上方：右缘与浮标右缘对齐（贴右时右缘 = vpW = DSH 右边框）。
   * ★ 2026-11-15 第四次纠正：不再有任何 left/right 翻边，任何位置都不往左右挪。
   *   唯一夹取是「别超出视口」：浮标靠左时 raw 可能为负 → 夹到 0。
   *   pw 传面板真实 offsetWidth（content-box 下含 padding/border），否则右缘会算错越界。
   */
  function geomPanelAbove(fabLeft, fsW, vpW, pw) {
    var raw = fabLeft + fsW - pw
    var maxLeft = Math.max(EDGE_GAP, vpW - pw - EDGE_GAP)
    return Math.min(Math.max(EDGE_GAP, raw), maxLeft)
  }
  /** 一次算全：setFabPos 与「恢复旧 localStorage 位置」共用这一条 clamp。 */
  function geomFabPos(left, top, vpW, vpH, fsW, fsH) {
    var pw = geomPanelWidth(vpW)
    var bounds = geomFabBounds(vpW, fsW, pw)
    var l = geomClampFabX(left, bounds)
    var nt = Number(top)
    if (!Number.isFinite(nt)) nt = EDGE_GAP
    var t = Math.min(Math.max(EDGE_GAP, nt), Math.max(EDGE_GAP, vpH - fsH - EDGE_GAP))
    return { left: l, top: t, minLeft: bounds.minLeft, maxLeft: bounds.maxLeft, pw: pw }
  }

  /** 把 (left,top) 夹进视口并写到 style，返回夹后的坐标（含水平硬边界信息）。 */
  function setFabPos(fab, left, top) {
    var vp = vpSize(), fs = fabSize(fab)
    var g = geomFabPos(left, top, vp.w, vp.h, fs.w, fs.h)
    if (fab.style) {
      fab.style.left = g.left + 'px'; fab.style.top = g.top + 'px'
      fab.style.right = 'auto'; fab.style.bottom = 'auto'
    }
    return { left: g.left, top: g.top, maxLeft: g.maxLeft, pw: g.pw }
  }
  /** 面板恒在浮标正上方：右缘对齐浮标右缘（贴右时与 DSH 右边框重合），底缘 = 浮标上缘 - 6px 呼吸空隙。 */
  function syncPanelPos(fab, panel) {
    if (!panel || !panel.style) return
    var vp = vpSize(), fs = fabSize(fab)
    var l = Number.parseFloat(fab.style && fab.style.left)
    var t = Number.parseFloat(fab.style && fab.style.top)
    // ★ 2026-11-15：CSS 默认右下角时**也要走同一套几何**，不能 early-return，
    //   否则首次展开只能靠 CSS 猜的 bottom:42px，浮标真实高度一变边框就对不上。
    if (!Number.isFinite(l)) l = vp.w - fs.w - EDGE_GAP
    if (!Number.isFinite(t)) t = vp.h - fs.h - EDGE_GAP
    // pw 必须是面板真实占宽：content-box 下 offsetWidth 含 padding + border，
    // 用硬编码 392 会让面板右缘越过视口（用户说的「边框没对齐」）。
    var pw = (Number.isFinite(panel.offsetWidth) && panel.offsetWidth > 0)
      ? panel.offsetWidth : geomPanelWidth(vp.w)
    var ph = (Number.isFinite(panel.offsetHeight) && panel.offsetHeight > 0) ? panel.offsetHeight : 420
    var px = geomPanelAbove(l, fs.w, vp.w, pw)
    var above = t - ph - GAP_ABOVE
    var py = Math.max(EDGE_GAP, above)
    // 上方放不下时只压缩面板高度（overflow-y:auto 可滚），绝不翻到浮标下方 / 左侧 / 右侧。
    if (above < EDGE_GAP) {
      panel.style.maxHeight = Math.max(0, t - EDGE_GAP) + 'px'
    } else {
      panel.style.maxHeight = ''
    }
    panel.style.left = px + 'px'; panel.style.right = 'auto'
    panel.style.top = py + 'px'; panel.style.bottom = 'auto'
    if (typeof panel.setAttribute === 'function') panel.setAttribute('data-cp-panel-side', 'above')
  }

  function toggle() {
    if (!nodes || !nodes.panel) return
    if (nodes.panel.hidden) open(); else close()
  }

  function wire() {
    var fab = nodes.fab
    // 叉叉的绑定在 render() 里（每次重建都重绑），这里不再缓存 firstPanel。
    // 与拖动链共享点按状态：pointerup 由 finish() 判定，其余抬起事件走 bindTap。
    var fabTap = { last: 0, suppressUntil: 0 }

    // 恢复上次拖动位置
    var saved = readFabPos()
    if (saved) setFabPos(fab, saved.left, saved.top)

    // 点面板外收起：读当前 nodes.panel（rebuild 换节点后仍成立），不缓存旧引用
    document.addEventListener('click', function (ev) {
      if (!nodes || !nodes.panel || nodes.panel.hidden) return
      if (nodes.panel.contains(ev.target) || fab.contains(ev.target)) return
      close()
    }, true)

    var hasPointer = (typeof window !== 'undefined' && typeof window.PointerEvent === 'function')

    // 键盘兜底：Enter / Space 自己开关，并阻止默认 click 造成重复
    fab.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        if (typeof ev.preventDefault === 'function') ev.preventDefault()
        toggle() // 键盘路径不与鼠标手势共用冷却：一次按键只派发一个 keydown
      }
    })

    if (!hasPointer) {
      bindTap(fab, toggle, TAP_EVENTS, fabTap) // 无 Pointer Events：不拖动，四种抬起都能点
      return
    }

    var press = null

    // ★ 兜底：pointerup 由 finish() 处理，这里补 click / mouseup / touchend。
    //   setup-guide.js 的宿主兜底是**合成 click**，不绑 click 浮标就永远「没反应」。
    bindTap(fab, toggle, ['click', 'mouseup', 'touchend'], fabTap)

    function originOf() {
      var l = Number.parseFloat(fab.style && fab.style.left)
      var t = Number.parseFloat(fab.style && fab.style.top)
      if (Number.isFinite(l) && Number.isFinite(t)) return { left: l, top: t }
      if (typeof fab.getBoundingClientRect === 'function') {
        var r = fab.getBoundingClientRect()
        if (r && Number.isFinite(r.left) && Number.isFinite(r.top)) return { left: r.left, top: r.top }
      }
      var vp = vpSize(), fs = fabSize(fab)
      // ★ 2026-11-15：CSS 默认已改成右下贴边（right:0 / bottom:0），
      //   这里的兜底坐标必须同口径，否则第一次拖动会凭空跳进 16px。
      return { left: vp.w - fs.w - EDGE_GAP, top: vp.h - fs.h - EDGE_GAP }
    }

    fab.addEventListener('pointerdown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return
      var o = originOf()
      press = { startX: ev.clientX, startY: ev.clientY, originLeft: o.left, originTop: o.top, dragging: false }
      // ★ pointerdown = 新手势开始：重置去重与抑制。
      //   冷却只用于「同一次手势的 click/pointerup/mouseup/touchend 只算一次」，
      //   不能用 300ms 时间窗全局去重 —— 那样快速连点两下会被第二下吞掉。
      fabTap.last = 0
      fabTap.suppressUntil = 0
      if (typeof fab.setPointerCapture === 'function' && ev.pointerId !== undefined) {
        try { fab.setPointerCapture(ev.pointerId) } catch (err) { /* 忽略 */ }
      }
    })

    fab.addEventListener('pointermove', function (ev) {
      if (!press) return
      var dx = ev.clientX - press.startX, dy = ev.clientY - press.startY
      if (!press.dragging && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return
      press.dragging = true
      // 拖动中：抑制同一次手势随后派发的 mouseup / touchend，避免松手误开关面板
      fabTap.suppressUntil = Date.now() + 350
      if (fab.classList && typeof fab.classList.add === 'function') fab.classList.add('is-dragging')
      setFabPos(fab, press.originLeft + dx, press.originTop + dy)
      syncPanelPos(fab, nodes.panel)
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
    })

    function finish(ev) {
      if (!press) return
      var dragged = press.dragging
      var p = dragged ? setFabPos(fab,
        press.originLeft + (ev.clientX - press.startX),
        press.originTop + (ev.clientY - press.startY)) : null
      press = null
      if (fab.classList && typeof fab.classList.remove === 'function') fab.classList.remove('is-dragging')
      if (typeof fab.releasePointerCapture === 'function' && ev.pointerId !== undefined) {
        try { fab.releasePointerCapture(ev.pointerId) } catch (err) { /* 忽略 */ }
      }
      if (dragged) {
        // 拖动结束：pointerup 不 toggle，且继续抑制随后 350ms 内的 mouseup/click/touchend
        fabTap.suppressUntil = Date.now() + 350
        if (p) {
          // 松手轻吸附：只在贴边时对齐，中间保留微调位置；结果仍出自同一硬边界，绝不越界。
          var vp = vpSize(), fs = fabSize(fab)
          var bounds = geomFabBounds(vp.w, fs.w, geomPanelWidth(vp.w))
          var snappedLeft = geomSnapFabX(p.left, bounds)
          var finalPos = setFabPos(fab, snappedLeft, p.top)
          writeFabPos({ left: finalPos.left, top: finalPos.top })
        }
      } else {
        if (tapFire(fabTap)) toggle() // 纯点按：与兜底事件共享冷却，一次手势只开关一次
      }
    }
    fab.addEventListener('pointerup', finish)
    fab.addEventListener('pointercancel', function () {
      press = null
      fabTap.suppressUntil = Date.now() + 350 // 手势取消也不该开关面板
      if (fab.classList && typeof fab.classList.remove === 'function') fab.classList.remove('is-dragging')
    })
  }

  /* ---------- 实验室资源懒加载（按 id 去重挂 head，与 loadQpExtras 同口径） ----------
   * 不改 lib/client.js：登记点放在本脚本里，主代理负责往 ASSET_ROUTES 加对应路由。
   * 资源只走本机相对路径，绝不加载外部 URL；缺 head / 缺 DOM API 时静默跳过，
   * 保证 node:vm 假 DOM 下 mount() 不抛错。
   */
  var LAB_ASSETS = [
    { id: 'dshqp-lab-css', src: 'qwen-paint/lab.css', css: true },
    { id: 'dshqp-lab-js', src: 'qwen-paint/lab.js', css: false },
  ]
  function loadLabAssets() {
    try {
      var doc = (typeof document !== 'undefined') ? document : null
      if (!doc || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') return
      var head = doc.head
      if (!head && typeof doc.getElementsByTagName === 'function') {
        var hs = doc.getElementsByTagName('head')
        head = (hs && hs[0]) ? hs[0] : null
      }
      if (!head || typeof head.appendChild !== 'function') return
      for (var i = 0; i < LAB_ASSETS.length; i += 1) {
        var a = LAB_ASSETS[i]
        if (doc.getElementById(a.id)) continue
        var node = doc.createElement(a.css ? 'link' : 'script')
        node.id = a.id
        if (a.css) { node.rel = 'stylesheet'; node.href = a.src }
        else {
          node.defer = true
          node.src = a.src
          // ★ 2026-11-15：lab.js 加载完直接把它嵌进当前面板的插槽，
          //   不再 attach 成独立浮层、也不降级挂到 body。
          node.onload = function () {
            try {
              var lab = window.DshQpLab
              if (lab && typeof lab.mountInto === 'function' && nodes && nodes.labSlot) {
                lab.mountInto(nodes.labSlot)
              }
            } catch (err) { /* render() 里还有一次主动重挂兜底 */ }
          }
        }
        head.appendChild(node)
      }
    } catch (err) { /* 实验室资源加载失败绝不影响既有面板 */ }
  }

  function mount() {
    if (nodes) return Promise.resolve(nodes)
    return loadSchema()
      .then(function () { return Promise.all([loadControls(), loadModes()]) })
      .then(function (pair) {
        state = pair[0]
        render()
        wire()
        loadLabAssets()
        refreshNote()
        // ★ 2026-11-16 P2：样式库/参考策略还在路上就宣告「就绪」= 假就绪。
        //   主体先可用，但如实标注候选仍在加载；全部落地后再收口成就绪。
        var statusReady = '就绪 · ' + describe(state)
        setStatus(statusReady + '（候选清单加载中…）')
        Promise.allSettled([loadLibrary(), loadReference()]).then(function () {
          setStatus(statusReady)
        })
        return nodes
      })
  }

  /* ============================ 导出 ============================ */
  window.ComfyPipelinePanel = {
    __cp: true,
    uiBuild: UI_BUILD,
    mount: mount,
    open: open,
    close: close,
    getState: function () { return state ? JSON.parse(JSON.stringify(state)) : null },
    getModes: function () { return JSON.parse(JSON.stringify(modeAvailability)) },
    // 2026-11-15：实验室功能区已内嵌进 cp-panel 的插槽；保留这个 getter
    // 供 lab.js / 外部在宿主重建后取当前 panel（绝不能缓存旧引用）。
    getPanelNode: function () { return nodes && nodes.panel ? nodes.panel : null },
    getReferenceState: function () { return JSON.parse(JSON.stringify(refState)) },
    api: {
      clampByDef: clampByDef,
      quantize: quantize,
      speedEdge: speedEdge,
      speedRefs: speedRefs,
      aspectTicks: aspectTicks,
      buildPayload: buildPayload,
      describe: describe,
      // ★ 2026-11-16 性能纯函数：缓存命中/下拉增量回填/轮询降频，供离线回归直调。
      modelOptionsFresh: modelOptionsFresh,
      modelOptionsEntry: modelOptionsEntry,
      optionSignature: optionSignature,
      fillSelect: fillSelect,
      pollIntervalMs: pollIntervalMs,
      // ★ 2026-11-16 二次报障：持久化缓存纯函数（storage 注入，离线可测）。
      loadPersistedModels: loadPersistedModels,
      savePersistedModels: savePersistedModels,
      placeholderOption: placeholderOption,
      modelOptionsStoreKey: MODEL_OPTIONS_STORE_KEY,
      tap: {
        bind: bindTap,
        fire: tapFire,
        events: TAP_EVENTS,
        cooldownMs: TAP_COOLDOWN_MS,
      },
      geom: {
        panelWidth: geomPanelWidth,
        fabBounds: geomFabBounds,
        clampX: geomClampFabX,
        snapX: geomSnapFabX,
        panelAbove: geomPanelAbove,
        fabPos: geomFabPos,
      },
    },
  }

  // 自挂载：脚本是 defer 加载的，DOM 已就绪；宿主没准备好就等 DOMContentLoaded。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount() })
  } else {
    mount()
  }
})()
