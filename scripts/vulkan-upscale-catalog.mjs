/**
 * scripts/vulkan-upscale-catalog.mjs —— Vulkan 直跑超分引擎的下载目录与安装步骤。
 *
 * 数据唯一真相源 = lib/vulkan-upscale.js 的 VULKAN_UPSCALE_ENGINES（MIT / 权威字节数 /
 * GitHub Releases 官方源单源——可执行文件不加第三方加速镜像，供应链红线）。本文件只做「下载 → 大小校验 → 解压 → 登记」：
 *   · Release 不提供 sha256 ⇒ 只比服务器权威字节数，并在结果里如实说明未做哈希校验；
 *   · 解压用系统 bsdtar（Windows 自带 tar.exe；Linux 的 GNU tar 不支持 zip ⇒ 如实认输给手动路径）；
 *   · 默认不装、绝不自动下载；只下载不上传。
 *
 * CLI：
 *   node scripts/vulkan-upscale-catalog.mjs --list
 *   node scripts/vulkan-upscale-catalog.mjs --download --engine=realesrgan-ncnn-vulkan --dir=<目录>
 * setup.mjs 用法：runVulkanUpscaleStep({ want, pick, dir, isTTY, ask, log, download, statSize, removeFile, extract })
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { VULKAN_UPSCALE_ENGINES } from '../lib/vulkan-upscale.js'

const platKey = process.platform === 'win32' ? 'win32' : 'linux'
const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl'
const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'

const curlDownload = (url, dest) => new Promise((resolve, reject) => {
  const r = spawnSync(curlBin, ['-sS', '-L', '--fail', '--create-dirs', '--max-time', '1800', '-o', dest, url],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (r.status === 0) resolve()
  else reject(new Error(`curl 退出码 ${r.status ?? 'null'}（${(r.stderr || '').slice(0, 160)}）`))
})

const tarExtract = (zip, dir) => {
  const r = spawnSync(tarBin, ['-xf', zip, '-C', dir], { encoding: 'utf8' })
  return r.status === 0 ? { ok: true } : { ok: false, reason: `${tarBin} 退出码 ${r.status}（${(r.stderr || '').slice(0, 200)}）` }
}

/**
 * 安装步骤（注入式依赖，setup.mjs 与本 CLI 共用同一实现）。
 * 返回 { installed: null | { engine, version, dir, exe, models } }。
 */
export async function runVulkanUpscaleStep({
  want, pick = null, dir = '', isTTY = false, ask = null,
  log = () => {}, download = curlDownload, statSize = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0),
  removeFile = (p) => fs.rmSync(p, { force: true }), extract = tarExtract,
} = {}) {
  if (want !== 'yes') {
    log('  · Vulkan 直跑超分是可选功能：不装完全不影响其它功能；要装请单独跑 --vulkan-upscale。')
    return { installed: null }
  }
  const engines = VULKAN_UPSCALE_ENGINES
  let engine = engines[0]
  const pickText = String(pick ?? '').trim()
  if (pickText !== '') {
    const idx = Math.trunc(Number(pickText)) - 1
    if (!Number.isInteger(idx) || idx < 0 || idx >= engines.length) {
      log('  ✗ --vulkan-pick 编号无效（1=' + engines.map((e, i) => `${i + 1}.${e.id}`).join(' 2=') + '）')
      return { installed: null }
    }
    engine = engines[idx]
  } else if (isTTY && typeof ask === 'function') {
    log('  可选引擎：')
    engines.forEach((e, i) => log(`    ${i + 1}. ${e.id} —— ${e.label}（${e.assets[platKey]?.name ?? '当前平台无包'}）`))
    const answer = await ask('  选一个（回车=1，不装输入 n）：')
    const t = String(answer ?? '').trim().toLowerCase()
    if (t === 'n' || t === 'no') { log('  · 已跳过（未下载任何东西）。'); return { installed: null } }
    const idx = Math.trunc(Number(t)) - 1
    if (Number.isInteger(idx) && idx >= 0 && idx < engines.length) engine = engines[idx]
  }
  const asset = engine.assets[platKey] ?? null
  if (!asset) { log(`  ✗ ${engine.id} 在 ${platKey} 没有预编译包，未下载。`); return { installed: null } }
  const targetDir = path.resolve(String(dir ?? '').trim() || path.join(process.cwd(), 'dshqp-vulkan-upscale'))
  fs.mkdirSync(targetDir, { recursive: true })
  const zipPath = path.join(targetDir, asset.name)
  const sources = [asset.url, asset.mirror].filter(Boolean)
  let okFile = false
  for (const src of sources) {
    log(`  · 下载：${src}`)
    try { await download(src, zipPath) } catch (e) { log(`  · 源失败（试下一个）：${e.message ?? e}`); continue }
    const got = statSize(zipPath)
    if (got === asset.bytes) { okFile = true; log(`  · 大小校验通过：${got} B（服务器权威值）`) ; break }
    log(`  · 大小不符：期望 ${asset.bytes}，实际 ${got} —— 删除后试下一个源（未做哈希校验：Release 无 sha256，如实说明）`)
    removeFile(zipPath)
  }
  if (!okFile) {
    log('  ✗ 全部源失败或大小不符 —— 未安装，绝不谎称成功。可自备 zip 放到 ' + targetDir + ' 后手动解压。')
    return { installed: null }
  }
  const ex = extract(zipPath, targetDir)
  if (!ex.ok) { log('  ✗ 解压失败：' + ex.reason + '；请手动解压 ' + zipPath + ' 到 ' + targetDir); return { installed: null } }
  removeFile(zipPath)
  const exe = path.join(targetDir, engine.exeName[platKey] ?? engine.exeName.win32)
  if (!fs.existsSync(exe)) { log('  ✗ 解压后未见 ' + engine.exeName[platKey] + '，请手动检查 ' + targetDir); return { installed: null } }
  const modelsDir = path.join(targetDir, 'models')
  const models = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir).filter((f) => f.endsWith('.param')).map((f) => f.replace(/\.param$/u, ''))
    : []
  const manifest = { engine: engine.id, version: engine.version, license: engine.license, dir: targetDir, exe, models, installedAt: new Date().toISOString(), hashChecked: false }
  fs.writeFileSync(path.join(targetDir, 'installed.json'), JSON.stringify(manifest, null, 2), 'utf8')
  log(`  · 模型（动态探测）：${models.length > 0 ? models.join('、') : '（models/ 下无 .param —— 以引擎实际为准）'}`)
  return { installed: manifest }
}

/* --------------------------------- CLI --------------------------------- */

const isMain = process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href } catch { return false }
})()

if (isMain) {
  const has = (f) => process.argv.includes(f)
  const valueOf = (f) => {
    const i = process.argv.indexOf(f)
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
  }
  if (has('--list')) {
    console.log('Vulkan 直跑超分引擎目录（数据源 = lib/vulkan-upscale.js）：')
    for (const [i, e] of VULKAN_UPSCALE_ENGINES.entries()) {
      console.log(`  ${i + 1}. ${e.id} —— ${e.label}`)
      console.log(`     版本 ${e.version} · 许可 ${e.license} · ${e.repo}`)
      console.log(`     win32：${e.assets.win32.name}（${e.assets.win32.bytes} B）`)
      console.log(`     ${e.note}`)
    }
    process.exit(0)
  }
  if (has('--download')) {
    const report = await runVulkanUpscaleStep({
      want: 'yes',
      pick: valueOf('--engine') ? String(VULKAN_UPSCALE_ENGINES.findIndex((e) => e.id === String(valueOf('--engine')).trim()) + 1) : valueOf('--pick'),
      dir: valueOf('--dir') ?? '',
      isTTY: false,
      log: (s) => console.log(s),
    })
    process.exit(report.installed ? 0 : 1)
  }
  console.log('用法：--list 查看；--download --engine=<id> --dir=<目录> 安装')
  process.exit(0)
}
