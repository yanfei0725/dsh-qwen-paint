/**
 * scripts/vectorize-catalog.mjs —— 矢量化引擎下载目录（vtracer，MIT）。
 *
 * 数据唯一真相源 = lib/vectorize.js 的 VECTORIZE_ENGINES。只收 vtracer（官方 Release
 * 单源：GitHub visioncortex/vtracer 1.0.0-alpha.4；可执行文件不加第三方加速镜像）；
 * potrace（GPL-2.0+）为用户自备 exe —— SourceForge 无权威直链，不代下载。
 * 解压用系统 bsdtar（Windows 自带 tar.exe）；默认不装、显式执行、只下载不上传。
 *
 * CLI：
 *   node scripts/vectorize-catalog.mjs --list
 *   node scripts/vectorize-catalog.mjs --download --dir=<目录>
 * setup.mjs 用法：runVectorizeStep({ want, pick, dir, isTTY, ask, log, download, statSize, removeFile, extract })
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { VECTORIZE_ENGINES } from '../lib/vectorize.js'

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

export async function runVectorizeStep({
  want, dir = '', isTTY = false, ask = null,
  log = () => {}, download = curlDownload, statSize = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0),
  removeFile = (p) => fs.rmSync(p, { force: true }), extract = tarExtract,
} = {}) {
  if (want !== 'yes') {
    log('  · 矢量化（vtracer）是可选功能：不装完全不影响其它功能；要装请单独跑 --vectorize。')
    return { installed: null }
  }
  const engine = VECTORIZE_ENGINES.find((e) => e.id === 'vtracer' && e.manualOnly !== true)
  if (!engine) { log('  ✗ 目录里没有可下载的矢量化引擎。'); return { installed: null } }
  const asset = engine.assets[platKey] ?? null
  if (!asset) { log(`  ✗ ${engine.id} 在 ${platKey} 没有预编译包，未下载。`); return { installed: null } }
  const targetDir = path.resolve(String(dir ?? '').trim() || path.join(process.cwd(), 'dshqp-vectorize'))
  fs.mkdirSync(targetDir, { recursive: true })
  const zipPath = path.join(targetDir, asset.name)
  log(`  · 下载（官方源）：${asset.url}`)
  try { await download(asset.url, zipPath) } catch (e) { log('  ✗ 下载失败：' + (e.message ?? e) + '；可自备 zip 放到 ' + targetDir + ' 手动解压。'); return { installed: null } }
  const got = statSize(zipPath)
  if (got !== asset.bytes) {
    log(`  ✗ 大小不符：期望 ${asset.bytes}，实际 ${got} —— 未安装，绝不谎称成功（未做哈希校验：Release 无 sha256）。`)
    removeFile(zipPath)
    return { installed: null }
  }
  log(`  · 大小校验通过：${got} B（服务器权威值）`)
  const ex = extract(zipPath, targetDir)
  if (!ex.ok) { log('  ✗ 解压失败：' + ex.reason + '；请手动解压 ' + zipPath + ' 到 ' + targetDir); return { installed: null } }
  removeFile(zipPath)
  const exe = path.join(targetDir, engine.exeName[platKey] ?? engine.exeName.win32)
  if (!fs.existsSync(exe)) { log('  ✗ 解压后未见 ' + engine.exeName[platKey] + '，请手动检查 ' + targetDir); return { installed: null } }
  const manifest = { engine: engine.id, version: engine.version, license: engine.license, dir: targetDir, exe, installedAt: new Date().toISOString(), hashChecked: false }
  fs.writeFileSync(path.join(targetDir, 'installed.json'), JSON.stringify(manifest, null, 2), 'utf8')
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
    console.log('矢量化引擎目录（数据源 = lib/vectorize.js）：')
    for (const e of VECTORIZE_ENGINES) {
      console.log(`  · ${e.id} —— ${e.label}`)
      console.log(`    许可 ${e.license} · ${e.manualOnly ? '用户自备 exe（不代下载）' : Object.values(e.assets).map((a) => `${a.name}（${a.bytes} B）`).join(' / ')}`)
      console.log(`    ${e.note}`)
    }
    process.exit(0)
  }
  if (has('--download')) {
    const report = await runVectorizeStep({ want: 'yes', dir: valueOf('--dir') ?? '', isTTY: false, log: (s) => console.log(s) })
    process.exit(report.installed ? 0 : 1)
  }
  console.log('用法：--list 查看；--download --dir=<目录> 安装 vtracer')
  process.exit(0)
}
