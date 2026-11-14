/**
 * lib/history-tool.js —— 给 Agent 的「查历史」轻量工具。
 *
 * 只读 SQLite（或降级读既有 JSONL），**不碰 ComfyUI**。
 * 让 Agent 能把「昨天画的那只柴犬」定位到具体文件，再作为 references / 输入
 * 交给 draw_image / inpaint_image，形成「生成 → 历史 → 再编辑」闭环。
 *
 * ⚠ parameters 只用 DSH assertSupportedJsonSchema 认的关键字子集
 *   （type / properties / required / items / additionalProperties / description），
 *   刻意不写 enum / format，避免宿主注册时直接拒绝。
 */
import { HISTORY_KINDS } from './history-store.js'

export const HISTORY_TOOL_NAME = 'list_generated_images'

export function makeHistoryTool(deps = {}) {
  const { store, log } = deps
  return {
    name: HISTORY_TOOL_NAME,
    description: '查询本机生成历史：按关键词 / 类型 / 日期范围列出此前生成的图片、视频与音频，'
      + '返回每条记录的绝对路径、提示词摘要、参数与时间。纯本地只读、不联网、不调用 ComfyUI。'
      + '需要「把之前那张图再改一下」时，先用本工具找到文件路径，再把它交给 inpaint_image 或 draw_image 的 references。'
      + 'available=false 表示当前 Node 版本不支持持久化历史，只能读本次会话的既有记忆日志。',
    // ★ 0.32.1：只读 SQLite 的工具也要有超时上限，避免宿主侧无限等待。
    timeoutMs: 30 * 1000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '在提示词、文件名、工具名、模型名里做子串匹配；不传则返回全部。' },
        kind: { type: 'string', description: '按类型筛选：image / video / audio / other；不传则全部。' },
        date_from: { type: 'string', description: '起始时间（ISO 8601，含）；不传则不限。' },
        date_to: { type: 'string', description: '结束时间（ISO 8601，含）；不传则不限。' },
        limit: { type: 'integer', description: '每页条数，1–50，默认 20。' },
        offset: { type: 'integer', description: '分页偏移，默认 0。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          available: { type: 'boolean' },
          persistent: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    async execute(args = {}) {
      try {
        const r = await store.query({
          keyword: args.keyword,
          kind: HISTORY_KINDS.includes(String(args.kind ?? '')) ? args.kind : '',
          from: args.date_from,
          to: args.date_to,
          limit: args.limit,
          offset: args.offset,
        })
        return {
          ok: r.ok,
          items: r.items,
          total: r.total,
          limit: r.limit,
          offset: r.offset,
          available: r.available,
          persistent: r.persistent,
          note: r.persistent
            ? '来自 SQLite 历史库（<outputDir>/.qwen-paint-history.db），支持搜索与分页。'
            : '当前 Node 版本无 node:sqlite，历史未持久化；这里只列出既有记忆日志里的记录。',
        }
      } catch (error) {
        try { log?.('warn', `历史工具查询失败：${error?.message ?? error}`) } catch { /* 忽略 */ }
        return {
          ok: false, items: [], total: 0, limit: 20, offset: 0,
          available: false, persistent: false,
          note: '历史查询失败（详见插件日志）；不影响出图。',
        }
      }
    },
  }
}
