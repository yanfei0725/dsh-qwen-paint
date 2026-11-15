/**
 * scripts/setup-audio-models.mjs —— 语音 / 音乐模型的可选下载入口（CLI）。
 *
 * 用法（全部默认只读，不下载、不安装）：
 *   node scripts/setup-audio-models.mjs --list
 *   node scripts/setup-audio-models.mjs --refresh --group=gpt_sovits_v5
 *   node scripts/setup-audio-models.mjs --download --group=gpt_sovits_v5 \
 *       --variant=dev --file=<远端列出的文件名> --dir=<你指定的相对目录>
 *   不带参数 → 交互式问「模型 → 档位 → 文件」，最后仍需显式确认才下载。
 *
 * ## 边界
 *   · 默认关闭、绝不自动下载；下载只下载，安装由用户自己完成。
 *   · 绝不上传本机模型文件；本脚本不写任何本机绝对路径，目标目录由参数传入。
 *   · 文件清单运行时动态列举，未核实到仓库名的模型只给「自备文件」指引。
 *   · 完整性只以服务器权威值判定；失败多源轮询后仍不行就明确让用户自备。
 */
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  DEFAULT_SOURCES, describeCatalog, listCatalogGroups, findGroup,
  listRepoFiles, downloadWithFallback, selfBringGuide,
} from './audio-model-catalog.mjs'

const argv = process.argv.slice(2)
const flag = (name) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : ''
}
const has = (name) => argv.includes('--' + name)

function printList() {
  const c = describeCatalog()
  console.log('新增语音 / 音乐模型下载清单（只读，默认不下载 / 不安装）')
  console.log('下载源：' + c.sources.map((s) => s.id + '(' + s.label + ')').join(' | '))
  for (const g of c.groups) {
    console.log('')
    console.log('  [' + g.id + '] ' + g.label + '（' + g.kind + '）')
    console.log('    仓库：' + (g.hfRepo || '未核实 → 只支持自备文件'))
    console.log('    档位：' + g.variants.map((v) => v.id + ' = ' + v.label).join(' / '))
    console.log('    说明：' + g.repoNote)
    if (g.selfBringOnly) console.log('    ⚠ ' + g.installHint)
  }
  console.log('')
  for (const r of c.rules) console.log('  · ' + r)
}

async function refresh(groupId) {
  const g = findGroup(groupId)
  if (!g) { console.log('未知模型：' + groupId + '；可用：' + listCatalogGroups().map((x) => x.id).join(' / ')); return }
  if (!g.hfRepo) { console.log(selfBringGuide(g).reason); console.log(g.installHint); return }
  for (const source of DEFAULT_SOURCES) {
    const r = await listRepoFiles({ source, repo: g.hfRepo, fetch: globalThis.fetch })
    console.log('  [' + source.id + '] ' + (r.ok ? '列到 ' + r.files.length + ' 个文件' : r.reason))
    if (r.ok) {
      for (const f of r.files.slice(0, 40)) {
        console.log('    ' + f.tier.label + ' | ' + f.path + (f.size ? ' | ' + f.size + ' B(远端声明)' : ''))
      }
      if (r.files.length > 40) console.log('    … 其余 ' + (r.files.length - 40) + ' 个省略')
      return
    }
  }
  console.log('所有源都没能列出文件；' + selfBringGuide(g).reason)
}

async function download(groupId, variantId, file, dir) {
  const g = findGroup(groupId)
  if (!g) { console.log('未知模型：' + groupId); return }
  if (!g.hfRepo) { console.log(selfBringGuide(g).reason); console.log(g.installHint); return }
  if (!file) { console.log('请用 --file= 指定远端列出的文件名（先 --refresh 看清单）'); return }
  if (!dir) { console.log('请用 --dir= 指定目标目录（相对路径，由你自己决定放哪）'); return }
  if (path.isAbsolute(dir)) { console.log('拒绝绝对路径：请用相对目录名，脚本不写本机绝对路径'); return }
  if (!g.variants.some((v) => v.id === variantId)) {
    console.log('未知档位：' + variantId + '；可用：' + g.variants.map((v) => v.id).join(' / ')); return
  }
  const target = path.join(dir, path.basename(file))
  const t0 = Date.now()
  const r = await downloadWithFallback({
    repo: g.hfRepo, file, sources: DEFAULT_SOURCES, fetch: globalThis.fetch,
    fs, target, group: g,
  })
  const secs = (Date.now() - t0) / 1000
  if (!r.ok) {
    console.log('下载未完成：' + r.reason)
    for (const s of r.steps ?? []) console.log('  · ' + s)
    for (const a of r.attempts ?? []) console.log('  [' + a.source + '] ' + a.reason)
    return
  }
  const rate = secs > 0 ? (r.size / 1024 / 1024 / secs).toFixed(2) + ' MB/s' : '—'
  console.log('文件名：' + path.basename(target))
  console.log('实际大小 = 服务器权威大小 = ' + r.size + ' B' + (r.resumed ? '（断点续传）' : ''))
  console.log('来源：' + r.source + ' | 耗时 ' + secs.toFixed(1) + ' s | 平均 ' + rate)
  console.log('ETag（可选自行比对）：' + (r.etag || '服务器未提供'))
  console.log('校验口径：以服务器 Content-Length / X-Linked-Size 为准；未声称哈希已验证。')
  console.log('只下载、未安装；装到哪、怎么装由你决定。插件不上传任何本机文件。')
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(String(a ?? '').trim())))
  console.log('可选模型：')
  for (const g of listCatalogGroups()) console.log('  ' + g.id + ' → ' + g.label)
  const gid = await ask('选模型 id（直接回车退出）: ')
  if (!gid) { console.log('未选择，零下载。'); rl.close(); return }
  const g = findGroup(gid)
  if (!g) { console.log('未知模型，零下载。'); rl.close(); return }
  console.log('档位：' + g.variants.map((v) => v.id + ' = ' + v.label).join(' / '))
  const vid = await ask('选档位 id: ')
  if (!g.hfRepo) { console.log(selfBringGuide(g).reason); rl.close(); return }
  for (const source of DEFAULT_SOURCES) {
    const r = await listRepoFiles({ source, repo: g.hfRepo, fetch: globalThis.fetch })
    if (!r.ok) { console.log('  [' + source.id + '] ' + r.reason); continue }
    console.log('远端文件（' + r.files.length + ' 个，前 20）：')
    r.files.slice(0, 20).forEach((f) => console.log('  ' + f.path))
    const file = await ask('要下载的文件名（直接回车跳过）: ')
    if (!file) { console.log('未指定文件，零下载。'); rl.close(); return }
    const dir = await ask('目标相对目录（直接回车跳过）: ')
    if (!dir) { console.log('未指定目录，零下载。'); rl.close(); return }
    const yes = await ask('确认下载？输入 y 才继续（默认不下载）: ')
    rl.close()
    if (yes.toLowerCase() !== 'y') { console.log('未确认，零下载、零安装。'); return }
    await download(gid, vid, file, dir)
    return
  }
  rl.close()
  console.log('所有源都没能列出文件；' + selfBringGuide(g).reason)
}

async function main() {
  if (has('list') || argv.length === 0 && !process.stdin.isTTY) { printList(); return }
  if (has('refresh')) { await refresh(flag('group')); return }
  if (has('download')) {
    await download(flag('group'), flag('variant') || 'default', flag('file'), flag('dir'))
    return
  }
  console.log('提示：--list 只读列清单；--refresh 列远端文件；--download 才真下载。')
  await interactive()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => console.log('下载脚本异常（详见本机日志）；零安装、零上传。'))
}
