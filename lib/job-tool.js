/** job-tool —— 设计说明逐字外置：docs/tts-lowlatency-design-notes.md#tts-lowlatency-space-job-tool */
import { createJobQueue } from './job-queue.js'

export const JOB_TOOL_NAME = 'manage_jobs'
export const JOB_ACTIONS = Object.freeze([
  'submit', 'list', 'cancel', 'retry', 'pause', 'resume', 'config',
])

/** 没有注入任何 runner 时的占位作业：纯内存、零 I/O、零出图、零联网。 */
const offlinePlaceholderRun = ({ id, payload, attempt }) => ({
  offline: true,
  id,
  attempt,
  payload,
  note: 'no runner injected; placeholder job only, no real work performed',
})

function briefError(e) {
  const raw = e && typeof e === 'object' && e.message !== undefined ? e.message : e
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error'
}

function resolveRun(args, deps) {
  if (typeof args.run === 'function') return args.run
  const runners = deps.runners && typeof deps.runners === 'object' ? deps.runners : {}
  const name = String(args.kind ?? args.runner ?? '').trim()
  if (name !== '' && typeof runners[name] === 'function') return runners[name]
  if (typeof deps.makeRun === 'function') {
    const made = deps.makeRun(args)
    if (typeof made === 'function') return made
  }
  if (typeof deps.defaultRun === 'function') return deps.defaultRun
  return offlinePlaceholderRun
}

/** 六个返回键的默认值；保证任何分支都不会回空对象给 Agent。 */
function blank(ok, reason) {
  return { ok, jobs: [], job: {}, stats: {}, config: {}, reason }
}

export function makeJobTool(deps = {}) {
  const queue = deps.queue ?? createJobQueue(deps.queueOptions ?? {})
  const log = deps.log
  const qstats = () => (typeof queue.stats === 'function' ? queue.stats() : {})
  const qconfig = () => (typeof queue.config === 'function' ? queue.config() : {})

  return {
    name: JOB_TOOL_NAME,
    description: '管理本机后台作业队列：提交、查看、取消、重跑、暂停、恢复、改配置。'
      + '当你需要「把多个出图/处理任务排队、让重要的先跑、中途取消某个长任务、'
      + '或失败后自动重试」时用本工具。队列是纯进程内编排，作业体由宿主注入，'
      + '本身不联网、不出图、不起子进程。'
      + '【各 action 参数】'
      + 'submit：必填 id，可选 priority（low/normal/high/urgent 或数字，越大越先跑）、'
      + 'kind（选 deps.runners 里的作业执行器）、payload（透传给 run 的任意对象）；'
      + '重复 id 会被明确拒绝。'
      + 'list：可选 state（pending/running/done/failed/canceled）过滤，返回 jobs 与 stats。'
      + 'cancel：必填 id；未开始的直接移除，运行中的通过 AbortSignal 通知其自行收尾。'
      + 'retry：必填 id；把 failed/canceled 的作业用原参数重新入队。'
      + 'pause / resume：暂停或恢复调度（已在跑的不打断）。'
      + 'config：不带参数时只读返回当前配置；带 concurrency / maxRetries / backoffMs 时更新并返回新配置。'
      + '未注入具体 runner 时，submit 提交的是纯内存占位作业（不产生真实出图/联网）。',
    timeoutMs: 30 * 1000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', description: 'submit / list / cancel / retry / pause / resume / config' },
        id: { type: 'string', description: '作业 id；submit / cancel / retry 需要。' },
        priority: { type: 'integer', description: 'submit 的优先级：也可在 description 里写的 low/normal/high/urgent 字符串；数字越大越先跑。' },
        kind: { type: 'string', description: 'submit 选哪个作业执行器（deps.runners 的键名）。' },
        payload: { type: 'object', description: 'submit 透传给 run 的任意对象。' },
        state: { type: 'string', description: 'list 的状态过滤：pending/running/done/failed/canceled。' },
        concurrency: { type: 'integer', description: 'config 更新最大并发数。' },
        maxRetries: { type: 'integer', description: 'config 更新单作业失败后的最大重试次数。' },
        backoffMs: { type: 'integer', description: 'config 更新指数退避基数（毫秒）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          jobs: { type: 'array', items: { type: 'object' } },
          job: { type: 'object' },
          stats: { type: 'object' },
          config: { type: 'object' },
          reason: { type: 'string' },
        },
      },
    },

    async execute(args = {}) {
      const action = String(args.action ?? '').trim()
      try {
        switch (action) {
          case 'submit': {
            const id = String(args.id ?? '').trim()
            if (id === '') return blank(false, 'submit 需要 id')
            const run = resolveRun(args, deps)
            const r = queue.enqueue({
              id,
              priority: args.priority,
              run,
              payload: args.payload,
            })
            return {
              ok: r.ok,
              jobs: [],
              job: r.job || {},
              stats: qstats(),
              config: qconfig(),
              reason: r.reason || '',
            }
          }
          case 'list': {
            const jobs = typeof queue.list === 'function' ? queue.list({ state: args.state }) : []
            return { ok: true, jobs, job: {}, stats: qstats(), config: qconfig(), reason: '' }
          }
          case 'cancel': {
            const id = String(args.id ?? '').trim()
            if (id === '') return blank(false, 'cancel 需要 id')
            const r = queue.cancel(id)
            return {
              ok: r.ok,
              jobs: [],
              job: r.job || {},
              stats: qstats(),
              config: qconfig(),
              reason: r.reason || '',
            }
          }
          case 'retry': {
            const id = String(args.id ?? '').trim()
            if (id === '') return blank(false, 'retry 需要 id')
            const r = queue.retry(id)
            return {
              ok: r.ok,
              jobs: [],
              job: r.job || {},
              stats: qstats(),
              config: qconfig(),
              reason: r.reason || '',
            }
          }
          case 'pause': {
            queue.pause()
            return { ok: true, jobs: [], job: {}, stats: qstats(), config: qconfig(), reason: '调度已暂停' }
          }
          case 'resume': {
            queue.resume()
            return { ok: true, jobs: [], job: {}, stats: qstats(), config: qconfig(), reason: '调度已恢复' }
          }
          case 'config': {
            const patch = {}
            if (args.concurrency !== undefined) patch.concurrency = args.concurrency
            if (args.maxRetries !== undefined) patch.maxRetries = args.maxRetries
            if (args.backoffMs !== undefined) patch.backoffMs = args.backoffMs
            let cfg = qconfig()
            if (Object.keys(patch).length > 0 && typeof queue.configure === 'function') {
              cfg = queue.configure(patch)
            }
            return {
              ok: true,
              jobs: [],
              job: {},
              stats: qstats(),
              config: cfg,
              reason: Object.keys(patch).length > 0 ? '配置已更新' : '当前配置（只读）',
            }
          }
          default:
            return blank(false, '未知 action；可用：' + JOB_ACTIONS.join(' / '))
        }
      } catch (error) {
        try { log?.('warn', 'manage_jobs 执行失败：' + briefError(error)) } catch { /* 忽略 */ }
        return blank(false, '内部错误：' + briefError(error))
      }
    },
  }
}
