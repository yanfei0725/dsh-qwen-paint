/**
 * lib/video-post.js —— A2 视频后处理独立成层。
 *
 * ★★ 这一层存在的理由，不是"把代码拆开好看"，而是：
 *   过去「视频生成完之后还能做什么」这件事散在三处 ——
 *   `video-frames-endpoints.js`（抽帧/截段/改帧回贴）、
 *   `video-workflow.js` 的音轨补丁、`subtitle-plan.js` 的字幕 ——
 *   Agent 想编排"抽帧→改→回贴→加字幕"时，只能靠读源码猜哪一步先做、哪步缺依赖。
 *
 *   本层给出一份**可核对的执行计划**：每步的入口、依赖、当前能不能跑、不能跑的原因。
 *   它不重复实现任何一步，只负责「排序 + 前置条件 + 如实报缺件」。
 *
 * ★★ 一条必须说清的事实：`attach-audio` 不是"给已有视频混流"。
 *   本插件没有音频混流实现（VHS_LoadAudio 是**生成图里**的节点），
 *   所以加/换音轨只能在**重新生成时**带 `audioTrack`。
 *   把这条写成"给成片加音轨"就是骗人 —— 用户拿成片来加会发现根本没这个入口。
 */

/** 后处理步骤，顺序即推荐执行顺序（前面的产物是后面的输入）。 */
export const POST_STEPS = [
  {
    id: 'probe',
    label: '探测时长与帧率',
    route: 'GET /api/qwen-paint/video/probe',
    needs: ['ffprobe'],
    produces: 'seconds / fps（后面每步都要用）',
  },
  {
    id: 'frame-save',
    label: '存帧为图（浏览器画布，零依赖）',
    route: 'POST /api/qwen-paint/video/frame-save',
    needs: [],
    produces: 'PNG 落盘（不经过 ffmpeg）',
  },
  {
    id: 'frame',
    label: '按时间点抽单帧',
    route: 'POST /api/qwen-paint/video/frame',
    needs: ['ffmpeg'],
    produces: '单帧 PNG',
  },
  {
    id: 'clip',
    label: '截取片段',
    route: 'POST /api/qwen-paint/video/clip',
    needs: ['ffmpeg'],
    produces: '短片段 mp4',
  },
  {
    id: 'replace-frame',
    label: '改帧回贴（把改好的图贴回原视频）',
    route: 'POST /api/qwen-paint/video/replace-frame',
    needs: ['ffmpeg'],
    produces: '新 mp4',
    after: ['frame', 'clip'],
  },
  {
    id: 'attach-audio',
    label: '换音轨',
    route: '（重新生成时带 audioTrack，不是给成片混流）',
    needs: ['VHS_LoadAudio'],
    produces: '带音轨的新 mp4',
    caveat: '本插件没有对成片混流的能力：音轨是在**生成时**由 VHS_LoadAudio 接进 VHS_VideoCombine 的。'
      + '要让已有视频换音轨，得用 ffmpeg 自己做。',
  },
  {
    id: 'subtitle',
    label: '字幕（脚本字幕可用；语音转写要另装）',
    route: 'lib/subtitle-plan.js',
    needs: [],
    produces: 'SRT / VTT 文本',
    caveat: '默认是脚本字幕，时间戳按句均分、未与语音对齐；语音转写需外部 ASR 能力。',
  },
]

const has = (list, name) => Array.isArray(list) && list.includes(name)

/**
 * 生成后处理计划。
 *
 * @param {object} o
 * @param {string|null} o.ffmpeg  探测到的 ffmpeg 路径，null = 没有
 * @param {string|null} [o.ffprobe]
 * @param {string[]} [o.nodes]    ComfyUI 节点名清单（判断 VHS_LoadAudio）
 * @param {boolean} [o.hasVideo]  是否已经有成片可处理
 * @returns {{ok:boolean, available:Array, blocked:Array, plan:Array, notes:string[]}}
 */
export function planPost({ ffmpeg = null, ffprobe = null, nodes, hasVideo = true } = {}) {
  const tools = { ffmpeg: ffmpeg ?? null, ffprobe: ffprobe ?? null }
  const available = []
  const blocked = []

  for (const step of POST_STEPS) {
    const missing = []
    for (const dep of step.needs) {
      if (dep === 'ffmpeg' && tools.ffmpeg === null) missing.push('ffmpeg')
      if (dep === 'ffprobe' && (tools.ffprobe === null || tools.ffprobe === undefined)) missing.push('ffprobe')
      if (dep === 'VHS_LoadAudio') {
        // 节点清单没拿到时不是"不支持"，而是"不知道"—— 不要谎报缺件。
        if (Array.isArray(nodes) && !has(nodes, dep)) missing.push(dep)
      }
    }
    const entry = {
      id: step.id,
      label: step.label,
      route: step.route,
      produces: step.produces,
      needs: step.needs,
      after: step.after ?? [],
      caveat: step.caveat ?? '',
      available: missing.length === 0,
      missing,
      reason: missing.length === 0
        ? ''
        : `缺 ${missing.join('、')}${missing.includes('ffmpeg') ? '（装好并加进 PATH，或用 FFMPEG_PATH 指定）' : ''}`,
    }
    if (entry.available) available.push(entry)
    else blocked.push(entry)
  }

  const notes = []
  if (!hasVideo) notes.push('还没有成片：先把视频生成出来，再谈后处理。')
  if (tools.ffmpeg === null) {
    notes.push('没找到 ffmpeg：抽帧 / 截段 / 改帧回贴都用不了；'
      + '但「存帧为图」走浏览器画布，零依赖仍然可用，字幕也不需要 ffmpeg。')
  }
  if (tools.ffmpeg !== null && !tools.ffprobe) {
    notes.push('有 ffmpeg 没 ffprobe：能处理，但探不到真实帧率，需要你按生成时的设置填。')
  }
  notes.push('执行顺序按 plan 数组来：抽帧 → 改 → 回贴 → 换音轨 → 字幕，跳步会拿不到输入。')

  return {
    ok: true,
    available,
    blocked,
    // plan 只含当前真能跑的步骤，且保持固定顺序 —— 便于 Agent 直接照着走。
    plan: available.map((s) => s.id),
    notes,
  }
}
