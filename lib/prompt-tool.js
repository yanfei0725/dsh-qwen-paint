/**
 * lib/prompt-tool.js —— 给 Agent 的「用模板拼提示词」工具（F28 的对外入口）。
 *
 * 两种用法：
 *   · 不传 template → 返回模板清单（含每个模板要填哪些槽位、示例是什么）
 *   · 传 template + slots → 返回渲染好的完整 prompt、推荐负向词与尺寸
 *
 * ⚠ parameters 只用 DSH assertSupportedJsonSchema 认的关键字子集
 *   （type / properties / required / items / additionalProperties / description），
 *   刻意不写 enum / format —— 宿主注册时会直接拒绝没见过的关键字。
 */
import { listTemplates, renderTemplate } from './prompt-templates.js'

export const PROMPT_TOOL_NAME = 'compose_prompt'

export function makePromptTool(deps = {}) {
  const { log } = deps
  return {
    name: PROMPT_TOOL_NAME,
    description: '把场景模板 + 槽位值拼成结构完整的出图提示词。'
      + '不传 template 时返回全部模板清单（产品图 / 角色立绘 / 封面图 / 场景概念图 / 静物特写 / 室内空间），'
      + '每个模板会列出需要填的槽位与示例值。'
      + '传 template 与 slots 时返回渲染好的 prompt、推荐负向词与推荐尺寸，可直接交给 draw_image。'
      + '必填槽位缺失时 ok=false 并返回 missing 清单 —— 按 missing 补齐后重试，不要跳过必填项硬出图。'
      + '这是**结构脚手架**，不做「把一句话扩写成一大段」的润色：槽位内容仍由你决定。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        template: { type: 'string', description: '模板 id（如 product / character / cover / scene / still-life / interior）；不传则只返回清单。' },
        slots: {
          type: 'object',
          description: '槽位键值对，如 { "subject": "一只磨砂黑色保温杯", "material": "哑光不锈钢" }。键名见清单里每个模板的 slots。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          prompt: { type: 'string' },
          negative: { type: 'string' },
          size: { type: 'string' },
          missing: { type: 'array', items: { type: 'object' } },
          templates: { type: 'array', items: { type: 'object' } },
          note: { type: 'string' },
        },
      },
    },
    async execute(args = {}) {
      try {
        const id = typeof args?.template === 'string' ? args.template.trim() : ''
        if (id === '') {
          const templates = listTemplates()
          return {
            ok: true,
            prompt: '', negative: '', size: '', missing: [],
            templates,
            note: `共 ${templates.length} 个模板。选一个，把 slots 里标 required 的键填上再调用一次。`,
          }
        }
        const r = renderTemplate(id, args?.slots)
        if (!r.name) {
          return {
            ok: false, prompt: '', negative: '', size: '', missing: [],
            templates: listTemplates(),
            note: `没有 id 为「${id}」的模板。上面是可用的清单。`,
          }
        }
        if (r.missing.length > 0) {
          return {
            ok: false, prompt: r.prompt, negative: r.negative, size: r.size,
            missing: r.missing, templates: [],
            note: `还缺必填槽位：${r.missing.map((m) => `${m.label}(${m.key})`).join('、')}。`
              + '补齐后重试；上面的 prompt 是当前已填部分的预览，不要直接拿去出图。',
          }
        }
        return {
          ok: true, prompt: r.prompt, negative: r.negative, size: r.size,
          missing: [], templates: [],
          note: '可直接传给 draw_image 的 prompt / negative / size。'
            + '想要更贴你的想法，把某个槽位再写细一点重跑本工具即可。',
        }
      } catch (error) {
        try { log?.('warn', `提示词模板工具失败：${error?.message ?? error}`) } catch { /* 忽略 */ }
        return {
          ok: false, prompt: '', negative: '', size: '', missing: [], templates: [],
          note: '模板渲染失败（详见插件日志）；不影响出图。',
        }
      }
    },
  }
}
