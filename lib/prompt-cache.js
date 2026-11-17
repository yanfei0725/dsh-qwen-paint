// 设计说明已外置 → docs/backend-headers-design-notes.md#hdr-note-prompt-cache

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEDUP_FILE = '.comfy-pipeline-dedup.json'
/** 这些键**不参与语义指纹**（它们只影响"这次提交长什么样"，不改变任务本身）。 */
export const NON_SEMANTIC_KEYS = ['client_id', 'filename_prefix']
/** 本地去重表最多留多少条（FIFO 淘汰，够用且不会无限长）。 */
export const DEDUP_MAX_ENTRIES = 64

/**
 * 稳定序列化：对象键排序、剔除非语义键。数组保持顺序（顺序在图里是有意义的）。
 */
export function stableStringify(value, dropKeys = NON_SEMANTIC_KEYS) {
  const drop = new Set(dropKeys)
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).sort()) {
        if (drop.has(k)) continue
        out[k] = walk(v[k])
      }
      return out
    }
    return v
  }
  return JSON.stringify(walk(value))
}

/**
 * 语义指纹（本地层用）。同一个任务 ⇒ 同一个指纹；改 seed ⇒ 换指纹。
 * @returns {string} 16 位 hex（够避碰，又不会把缓存文件撑大）
 */
export function semanticFingerprint(workflow) {
  const text = stableStringify(workflow)
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * ComfyUI 层**不要**做的事：这里刻意不提供"归一化后再提交"的函数。
 * 需要校验时只用这个函数比较两份提交体是否**逐字节**一致。
 */
export function sameSubmitBody(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 打开本地去重表。返回的操作全是同步且不抛的。
 * @param {string} outputDir 成品目录（缓存与成品同目录，跟着用户改目录走）
 */
export function createLocalDedup(outputDir) {
  const dir = typeof outputDir === 'string' && outputDir.trim() !== '' ? outputDir.trim() : '.'
  const file = path.join(dir, DEDUP_FILE)

  const read = () => {
    try {
      if (!existsSync(file)) return {}
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  const write = (table) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return true
    } catch {
      try { unlinkSync(`${file}.${process.pid}.tmp`) } catch { /* 没建出来就算了 */ }
      return false
    }
  }

  return {
    path: file,
    /**
     * 查：命中且**所有文件都还在**才返回文件数组；否则 null（必须照常提交）。
     */
    lookup(key) {
      if (typeof key !== 'string' || key === '') return null
      const entry = read()[key]
      const files = Array.isArray(entry?.files) ? entry.files.filter((f) => typeof f === 'string' && f !== '') : []
      if (files.length === 0) return null
      if (!files.every((f) => existsSync(f))) return null
      return files
    },
    /** 记：只保留最近 DEDUP_MAX_ENTRIES 条。 */
    remember(key, files) {
      if (typeof key !== 'string' || key === '') return false
      const list = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f !== '') : []
      if (list.length === 0) return false
      const table = read()
      table[key] = { files: list, at: Date.now() }
      const keys = Object.keys(table)
      for (const k of keys.slice(0, Math.max(0, keys.length - DEDUP_MAX_ENTRIES))) delete table[k]
      return write(table)
    },
    /** 表里有几条（诊断用）。 */
    size() {
      return Object.keys(read()).length
    },
  }
}
