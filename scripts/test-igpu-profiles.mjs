#!/usr/bin/env node
/**
 * test-igpu-profiles.mjs —— 用户可选核显型号 / 可选自动下载 离线回归
 *
 * ★ 2026-11-13 新增。用户明确要求「不要试本机核显、不用跑实测」，
 *   所以本套件**全程零联网、零硬件探测、零 GPU 调用、零媒体生成**：
 *   只测纯数据、纯函数，以及对 setup.mjs / config.js 的源码级接线断言。
 *
 * 锁住的四件事：
 *   ① 用户清单里的每个型号都在，且性能数字标注为「未经实测 / 不可比」；
 *   ② 自动下载**默认关闭**，`--check` 永远排在下载之前；
 *   ③ `assessLowEndReadiness()` 的旧判定完全不变（防回归）；
 *   ④ 体积红线（单文件 ≤ 262144 B / lib 合计 ≤ 2097152 B）。
 */
import path from 'node:path'
import fs from 'node:fs'
import {
  IGPU_PROFILE_IDS, IGPU_PROFILES, IGPU_BACKENDS, IGPU_QUANTS,
  IGPU_AUTO_DOWNLOAD_DEFAULT, IGPU_DOWNLOAD_CATALOG,
  findIgpuProfile, matchIgpuProfile, igpuPlanFor, listIgpuOptions,
} from '../lib/igpu-profiles.js'
import { assessLowEndReadiness } from '../lib/config.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, '$1')), '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ', name) }
  else { fail++; console.log('  FAIL', name, extra ?? '') }
}

console.log('=== 1. 用户清单完整性 ===')
{
  const ids = IGPU_PROFILES.map((p) => p.id)
  ok('10 个可选型号', ids.length === 10, ids.length)
  ok('ID 清单与档案一一对应', IGPU_PROFILE_IDS.length === ids.length
    && IGPU_PROFILE_IDS.every((x) => ids.includes(x)))
  ok('id 无重复', new Set(ids).size === ids.length)
  ok('rank 无重复', new Set(IGPU_PROFILES.map((p) => p.rank)).size === ids.length)
  // 用户清单里点名的型号，逐条核对
  const must = [
    'amd-780m', 'amd-680m', 'amd-760m', 'amd-660m', 'amd-8060s',
    'intel-iris-xe-96eu', 'intel-uhd', 'intel-arc-140v', 'intel-arc-140t', 'intel-arc-b390',
  ]
  ok('★ 用户清单 10 个型号一个不少', must.every((x) => ids.includes(x)),
    must.filter((x) => !ids.includes(x)))
  const allNames = IGPU_PROFILES.map((p) => p.name).join(' | ')
  for (const kw of ['780M', '680M', '760M', '660M', '8060S', 'Iris Xe', 'UHD', '140V', '140T', 'B390']) {
    ok(`清单含「${kw}」`, allNames.includes(kw))
  }
  ok('代表处理器 7840HS / 8845HS 在 780M',
    IGPU_PROFILES.find((p) => p.id === 'amd-780m').cpus.join().includes('7840HS'))
  ok('代表处理器 6800H / 7735HS 在 680M',
    IGPU_PROFILES.find((p) => p.id === 'amd-680m').cpus.join().includes('7735HS'))
  ok('Iris Xe 标注 11 代 80EU → 12 代 96EU 强约 30%',
    IGPU_PROFILES.find((p) => p.id === 'intel-iris-xe-96eu').reference.note.includes('30%'))
  ok('8060S 标注 AMD 官方 Windows 原生支持',
    IGPU_PROFILES.find((p) => p.id === 'amd-8060s').reference.note.includes('AMD 官方'))
  ok('优先级顺序：B390 > 780M > 140V > 680M > Iris Xe',
    (() => {
      const r = (id) => IGPU_PROFILES.find((p) => p.id === id).rank
      return r('intel-arc-b390') < r('amd-780m') && r('amd-780m') < r('intel-arc-140v')
        && r('intel-arc-140v') < r('amd-680m') && r('amd-680m') < r('intel-iris-xe-96eu')
    })())
}

console.log('=== 2. 诚实口径：绝不冒充实测 ===')
{
  ok('★ 每个型号的经 igpuPlanFor 后都带 unverified:true',
    IGPU_PROFILES.every((p) => igpuPlanFor(p.id).reference.unverified === true))
  ok('★ 每个参考都标注 comparable:false',
    IGPU_PROFILES.every((p) => igpuPlanFor(p.id).reference.comparable === false))
  ok('★ 参考来源写明「用户清单 / 社区公开、未实测」',
    IGPU_PROFILES.every((p) => /社区|用户/u.test(igpuPlanFor(p.id).reference.source)
      && igpuPlanFor(p.id).reference.source.includes('未做')))
  const sec = (id) => IGPU_PROFILES.find((p) => p.id === id).reference.sec
  ok('780M 参考 15s', sec('amd-780m') === 15)
  ok('680M 参考 120s', sec('amd-680m') === 120)
  ok('Iris Xe 参考 12s（且注明 SDXL 6分46秒）',
    sec('intel-iris-xe-96eu') === 12
    && IGPU_PROFILES.find((p) => p.id === 'intel-iris-xe-96eu').reference.note.includes('6 分 46 秒'))
  ok('140V 参考 54s 且注明 290.8s/16张≈18.1s',
    sec('intel-arc-140v') === 54
    && IGPU_PROFILES.find((p) => p.id === 'intel-arc-140v').reference.note.includes('290.8'))
  ok('★ 无秒数的型号不许编造（140T / B390 / 760M / 660M / UHD / 8060S）',
    ['intel-arc-140t', 'intel-arc-b390', 'amd-760m', 'amd-660m', 'intel-uhd', 'amd-8060s']
      .every((id) => sec(id) === null))
  ok('UHD 如实写明「非常吃力」',
    IGPU_PROFILES.find((p) => p.id === 'intel-uhd').reference.note.includes('非常吃力'))
  ok('后端说明里 DirectML/OpenVINO 明确会改用户环境且不自动装',
    IGPU_BACKENDS.directml.changesEnv === true && IGPU_BACKENDS.openvino.changesEnv === true
    && /不自动装/u.test(IGPU_BACKENDS.directml.hint + IGPU_BACKENDS.openvino.hint))
  ok('ROCm 说明限定 8060S / gfx1151',
    IGPU_BACKENDS.rocm.hint.includes('gfx1151') && IGPU_BACKENDS.rocm.changesEnv === false)
}

console.log('=== 3. 后端 / 量化 / 分辨率建议 ===')
{
  ok('AMD 消费级核显走 DirectML',
    ['amd-780m', 'amd-680m', 'amd-760m', 'amd-660m'].every((id) => igpuPlanFor(id).backend === 'directml'))
  ok('Intel 核显走 OpenVINO',
    ['intel-iris-xe-96eu', 'intel-uhd', 'intel-arc-140v', 'intel-arc-140t', 'intel-arc-b390']
      .every((id) => igpuPlanFor(id).backend === 'openvino'))
  ok('8060S 走 ROCm 原生', igpuPlanFor('amd-8060s').backend === 'rocm')
  ok('★ 核显机不要 1024：所有型号建议边长 ≤ 720',
    IGPU_PROFILES.every((p) => p.resolution <= 720 && p.resolution >= 512))
  ok('最弱两档（660M / UHD）降到 512',
    igpuPlanFor('amd-660m').resolution === 512 && igpuPlanFor('intel-uhd').resolution === 512)
  ok('共享显存一律 lowvram / ram',
    IGPU_PROFILES.every((p) => ['save', 'ram', 'standard'].includes(p.vramMode)))
  ok('★ 有可下载文件的只有 gguf-q4',
    Object.values(IGPU_QUANTS).filter((q) => q.downloadable).length === 1)
  ok('更轻档位如实标注「自备、不自动下载」',
    IGPU_QUANTS['gguf-q3-or-lighter'].downloadable === false
    && IGPU_QUANTS['gguf-q3-or-lighter'].hint.includes('不自动下载'))
}

console.log('=== 4. 查找 / 软匹配 / 计划 ===')
{
  ok('精确查找命中', findIgpuProfile('amd-780m')?.name.includes('780M'))
  ok('未知 id 返回 null（不 fallback 成近似型号）', findIgpuProfile('nope') === null)
  ok('空 / auto / none 返回 null',
    ['', 'auto', 'none', null, undefined].every((x) => findIgpuProfile(x) === null))
  ok('软匹配 780M', matchIgpuProfile(['AMD Radeon 780M'])?.id === 'amd-780m')
  ok('软匹配 Iris Xe', matchIgpuProfile(['Intel Iris Xe Graphics'])?.id === 'intel-iris-xe-96eu')
  ok('软匹配 8060S 优先于泛化的 Radeon', matchIgpuProfile(['AMD Radeon(TM) Graphics 8060S'])?.id === 'amd-8060s')
  ok('认不出就返回 null', matchIgpuProfile(['NVIDIA GeForce RTX 4090']) === null)
  ok('空设备名返回 null', matchIgpuProfile([]) === null)
  const plan = igpuPlanFor('amd-780m')
  ok('plan 字段齐全', ['profileId', 'name', 'backend', 'backendLabel', 'backendHint',
    'quant', 'quantLabel', 'resolution', 'vramMode', 'precisionTier', 'reference', 'notes',
    'downloadable', 'suggestedDownloads', 'autoDownload'].every((k) => k in plan))
  ok('★ plan.autoDownload 恒为 false',
    IGPU_PROFILES.every((p) => igpuPlanFor(p.id).autoDownload === false))
  ok('可下载型号给出建议下载 id，不可下载型号给空数组',
    plan.suggestedDownloads.length === 1
    && igpuPlanFor('intel-uhd').suggestedDownloads.length === 0)
  ok('igpuPlanFor(null) 返回 null', igpuPlanFor(null) === null)
  const list = listIgpuOptions()
  ok('listIgpuOptions 数量与档案一致且 8060S 置顶',
    list.length === IGPU_PROFILES.length && list[0].id === 'amd-8060s')
}

console.log('=== 5. 可选自动下载：默认关闭 + 服务器权威值 ===')
{
  ok('★ IGPU_AUTO_DOWNLOAD_DEFAULT === false', IGPU_AUTO_DOWNLOAD_DEFAULT === false)
  ok('下载清单只有 1 项', IGPU_DOWNLOAD_CATALOG.length === 1)
  const m = IGPU_DOWNLOAD_CATALOG[0]
  ok('★ size 用服务器权威值 4604558112（不是 4.2GB 估算）', m.size === 4604558112)
  ok('★ sha256 与 HF API lfs.oid 一致',
    m.sha256 === 'e79c8a009f2ecbdb6c70fd663d9aea9ee304a0d91f347e4169a756b8ad141b41')
  ok('★ 优先源是实测可达的 hf-mirror 备份仓库',
    m.sources[0].includes('hf-mirror.com') && m.sources[0].includes('KasugaiSakura'))
  ok('多源轮询（≥2 个源）', m.sources.length >= 2)
  ok('★ 前置条件如实列出架构名不匹配风险',
    m.requires.some((r) => r.includes('ComfyUI-GGUF'))
    && m.requires.some((r) => r.includes('qwen_image21')))
}

console.log('=== 6. assessLowEndReadiness 回归锁（旧行为一个字都不能变） ===')
{
  const a = assessLowEndReadiness({ sharedMemory: true, systemRAMGB: 16, vramGB: 8 })
  ok('★ 16G内存+核显共享8G → 180s / 达标 / gguf',
    a.speedTargetSec === 180 && a.meetsAcceptableBar === true && a.tier === 'gguf')
  const b = assessLowEndReadiness({ sharedMemory: true, systemRAMGB: 8, vramGB: 8 })
  ok('★ 整机只有8G → 360s / 不达标',
    b.speedTargetSec === 360 && b.meetsAcceptableBar === false)
  const c = assessLowEndReadiness({ sharedMemory: false, vramGB: 20, systemRAMGB: 30.9 })
  ok('★ 独显20G → 60s', c.speedTargetSec === 60)
  ok('不传型号时 igpuProfile === null', a.igpuProfile === null && c.igpuProfile === null)
  ok('unverified 仍为 true', a.unverified === true)
  const d = assessLowEndReadiness({ sharedMemory: true, systemRAMGB: 16, vramGB: 8, igpuProfileId: 'amd-780m' })
  ok('★ 指定型号后 speedTargetSec 不变（参考秒数 15 不许顶替 180）', d.speedTargetSec === 180)
  ok('★ 指定型号后 meetsAcceptableBar / tier 不变',
    d.meetsAcceptableBar === a.meetsAcceptableBar && d.tier === a.tier)
  ok('指定型号后透出 igpuProfile 且 id 正确', d.igpuProfile?.profileId === 'amd-780m')
  ok('★ 透出的参考标注 unverified + comparable:false',
    d.igpuProfile.reference.unverified === true && d.igpuProfile.reference.comparable === false)
  ok('caveat 明确写出「不可直接比较」', d.caveat.includes('不可与本插件的 speedTargetSec 直接比较'))
  const e = assessLowEndReadiness({ sharedMemory: true, systemRAMGB: 16, vramGB: 8, igpuProfileId: 'nope' })
  ok('无效型号不给建议且不影响判定', e.igpuProfile === null && e.speedTargetSec === 180)
}

console.log('=== 7. setup.mjs 接线（源码级，零执行下载） ===')
{
  const S = readSrc('scripts/setup.mjs')
  ok('★ 提供 --list-igpu 选项', S.includes("has('--list-igpu')"))
  ok('★ 提供 --igpu <id> 选项', S.includes("valueOf('--igpu')"))
  ok('★ 提供 --igpu-download 显式开关', S.includes("has('--igpu-download')"))
  ok('★ 默认不改环境：DirectML/OpenVINO 只在提示里出现，无自动安装调用',
    !/installDirectml|installOpenvino|pip install.*directml/u.test(S))
  ok('★ --check 早退仍在下载之前', (() => {
    const atCheck = S.indexOf('if (CHECK_ONLY) {')
    const atIgpuDl = S.indexOf('if (IGPU_DOWNLOAD &&')
    return atCheck > 0 && atIgpuDl > atCheck
  })())
  ok('★ --check 分支里没有下载调用',
    !/if \(CHECK_ONLY\) \{[\s\S]{0,500}?downloadWithCurl/u.test(S))
  ok('★ IGPU 下载块受显式开关与已选型号双重约束',
    S.includes('if (IGPU_DOWNLOAD && IGPU_PLAN !== null && IGPU_PLAN.downloadable)'))
  ok('未给开关时只打印提示', S.includes('核显推荐主模型**未下载**'))
  ok('★ 下载后按 size + sha256 双校验且不合格删除',
    S.includes('digest !== m.sha256') && S.includes('fs.rmSync(dest, { force: true })'))
  ok('★ 保留原有 GGUF_BASES 与 ggufUrlsOf（不破坏既有断言）',
    S.includes('const GGUF_BASES = [') && S.includes('ggufUrlsOf(model)'))
  ok('★ 已验证镜像源来自数据模块而不是硬编码 URL',
    S.includes('IGPU_DOWNLOAD_CATALOG') && !S.includes('KasugaiSakura'))
  ok('型号清单非法 id 会明确报错', S.includes('不在清单里'))
  ok('★ 交互只做推荐、不替用户决定', S.includes('绝不替用户做决定'))
}

console.log('=== 8. config.js 接线 + 体积红线 ===')
{
  const C = readSrc('lib/config.js')
  ok('config.js 引入 igpuPlanFor', C.includes("import { igpuPlanFor } from './igpu-profiles.js'"))
  ok('★ 只附加建议、不替换门槛', C.includes('绝不改动上面的门槛判定'))
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
  const total = libFiles.reduce((s, f) => s + Buffer.byteLength(readSrc(`lib/${f}`), 'utf8'), 0)
  ok('★ lib/igpu-profiles.js 单文件未超 262144 B',
    Buffer.byteLength(readSrc('lib/igpu-profiles.js'), 'utf8') <= 262144)
  ok(`★ lib/*.js 合计 ${total} B ≤ 2097152 B`, total <= 2097152, total)
  ok('setup.mjs 单文件也在红线内（非 lib，但按同口径核一下）',
    Buffer.byteLength(readSrc('scripts/setup.mjs'), 'utf8') <= 262144)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('全部通过 ✓（零联网 / 零硬件探测 / 零媒体生成）')
