/**
 * lib/vram-strategy.js —— B4 显存动态策略。
 *
 * ★★ 一句话说清边界：
 *   显存档位（`--lowvram` / `--highvram` / `--normalvram` 等）是**启动参数**，
 *   改它必须重启 ComfyUI。所以本模块**不做运行时切换**，只做两件事：
 *     ① 出图**前**看一眼当前可用显存与本次任务量，判断"要不要提醒用户换档"；
 *     ② 给出一句人话解释为什么这么建议。
 *
 *   真正的档位切换仍然由 `lib/perf-presets.js` 的只读清单 + 用户去 DSH 配 完成。
 *   任何"自动帮你切档"的实现都是假的 —— 切不了，只是骗你点了个按钮。
 *
 * ★★ 阈值是**经验下限**，不是实测结论：`heuristic: true` 会随结果一起返回。
 *   本项目至今没有可信的速度基准，所以这里只判断"够不够"，不承诺"多快"。
 */

/**
 * 各任务类型的显存经验下限（MB）。
 * 取值思路：模型权重常驻部分 + 采样时的激活峰值。宁可保守 ——
 * 报"够用"却 OOM 比报"紧张"多等一会儿难受得多。
 */
export const KIND_FLOORS_MB = {
  image: 3400,
  video: 6400,
  upscale: 2800,
  tts: 1200,
}

/** 档位由省到费。索引越大越吃显存、越快。 */
export const MODE_LADDER = ['save', 'auto', 'ram', 'resident']

/**
 * 按可用显存挑一个建议档位。
 *
 * @param {object} o
 * @param {number|null} o.freeMB   当前可用显存（来自 /system_stats 的 vram_free）
 * @param {number|null} [o.totalMB]
 * @param {'image'|'video'|'upscale'|'tts'} [o.kind]
 * @param {number} [o.pixels]      本次输出像素数（视频按帧累计）
 * @param {string} [o.userMode]    用户在配置里手选的档位
 * @returns {object}
 */
export function pickVramMode({ freeMB, totalMB, kind, pixels, userMode } = {}) {
  const k = String(kind ?? 'image')
  const floor = KIND_FLOORS_MB[k] ?? KIND_FLOORS_MB.image
  const px = Number(pixels)
  // 像素数超 1080p 量级时把下限再抬一档：激活值随面积走，比权重更敏感。
  const scale = Number.isFinite(px) && px > 2_600_000 ? 1.5 : 1
  const needMB = Math.round(floor * scale)

  const chosen = String(userMode ?? '').trim()
  if (chosen !== '' && chosen !== 'auto') {
    // ★ 用户手选优先，连"不够"也只提醒不推翻 —— 他可能比我们更清楚。
    return {
      ok: true,
      mode: chosen,
      mode_from: 'user',
      need_mb: needMB,
      free_mb: Number.isFinite(Number(freeMB)) ? Number(freeMB) : null,
      heuristic: true,
      warning: Number(freeMB) < needMB
        // ★ 已经是 save 时不能再劝它"降到 save"——那是我自己写出来的废话。
        ? (chosen === 'save'
          ? `已经是最省的 save 档了，但当前可用约 ${Math.round(Number(freeMB))}MB 仍低于 ${needMB}MB 经验下限；`
            + '再 OOM 只能降分辨率/帧数，或关掉别的占显存程序'
          : `你选的 ${chosen} 档预计要 ${needMB}MB，当前可用约 ${Math.round(Number(freeMB))}MB，可能 OOM；`
            + '真炸了再降到 save 档（需重启 ComfyUI）')
        : '',
      reason: `档位由你在配置里指定（${chosen}），本建议不覆盖用户选择`,
    }
  }

  const free = Number(freeMB)
  if (!Number.isFinite(free) || free <= 0) {
    return {
      ok: false,
      mode: 'auto',
      mode_from: 'unknown',
      need_mb: needMB,
      free_mb: null,
      heuristic: true,
      warning: '',
      reason: '没拿到可用显存（ComfyUI 离线或 /system_stats 不可用），保持 auto 不动',
    }
  }

  let mode
  let why
  if (free < needMB) {
    mode = 'save'
    why = `可用 ${Math.round(free)}MB 低于${k}任务的 ${needMB}MB 经验下限，建议 save 档（权重按需换入）`
  } else if (free >= needMB * 2.2) {
    mode = 'resident'
    why = `可用 ${Math.round(free)}MB 是需求 ${needMB}MB 的两倍多，建议 resident 档减少反复换入`
  } else if (free >= needMB * 1.4) {
    mode = 'ram'
    why = `可用 ${Math.round(free)}MB 较宽裕，建议 ram 档（模型留内存、少换入）`
  } else {
    mode = 'auto'
    why = `可用 ${Math.round(free)}MB 刚够 ${needMB}MB，建议保持 auto 由 ComfyUI 自己调度`
  }

  return {
    ok: true,
    mode,
    mode_from: 'computed',
    need_mb: needMB,
    free_mb: Math.round(free),
    total_mb: Number.isFinite(Number(totalMB)) ? Math.round(Number(totalMB)) : null,
    heuristic: true,
    warning: '',
    // ★ 必须带上这句，否则用户会以为改完立刻生效。
    restart_required: true,
    reason: why,
    note: '显存档位是启动参数，改完必须重启 ComfyUI 才生效；本模块不会替你改配置。'
      + '阈值是经验下限（heuristic），不是本机实测结果。',
  }
}

/** 给面板/日志用的一行摘要。 */
export function explainVramPick(pick) {
  if (!pick || typeof pick !== 'object') return ''
  const bits = []
  bits.push(pick.ok ? `建议 ${pick.mode} 档` : `保持 ${pick.mode}`)
  if (pick.need_mb) bits.push(`需求约 ${pick.need_mb}MB`)
  if (pick.free_mb !== null && pick.free_mb !== undefined) bits.push(`可用约 ${pick.free_mb}MB`)
  if (pick.restart_required) bits.push('改档需重启 ComfyUI')
  return `${bits.join('，')}。${pick.reason ?? ''}`
}
