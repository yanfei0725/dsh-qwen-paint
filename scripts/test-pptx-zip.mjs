#!/usr/bin/env node
/**
 * pptx-lite buildZip 直测（2026-11-20 补勘察报告 #14 零触及清单）。
 *
 * buildZip 是 make_pptx 的打包地基（STORE 型 ZIP：local+central+EOCD，CRC32 无压缩）。
 * 断言两层：① 字节级结构（魔数/EOCD 条目数/offset 累计）② **终验 = python zipfile
 * 标准解析器实解**（testzip 全量 CRC 校验 + namelist + 内容 roundtrip）——
 * 结构断言过了不等于真 zip，标准解析器说了算。
 *
 * 纯离线（python 只用标准库，产物写临时目录）。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs'
import { buildZip } from '../lib/pptx-lite.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const zip = buildZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
  { name: 'ppt/slides/slide1.xml', data: '<p:sld>中文内容</p:sld>' },
])

console.log('— 字节级结构')
ok('★ local 头魔数 PK\x03\x04（0x04034b50 LE）+ central PK\x01\x02 + EOCD PK\x05\x06',
  zip.readUInt32LE(0) === 0x04034b50
  && zip.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02])) > 0
  && zip.readUInt32LE(zip.length - 22) === 0x06054b50)
ok('★ EOCD 条目数两处 = 3（本目录数 + 总条目数）',
  zip.readUInt16LE(zip.length - 22 + 10) === 3 && zip.readUInt16LE(zip.length - 22 + 8) === 3)
ok('★ EOCD central 尺寸/offset 与构造累计一致',
  (() => { const eocd = zip.length - 22
    const size = zip.readUInt32LE(eocd + 12)
    const offset = zip.readUInt32LE(eocd + 16)
    const centralStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    return size === zip.length - 22 - centralStart && offset === centralStart })(),
  'EOCD 字段与实际 central 位置不符')
ok('★ UTF-8 文件名（中文 slide 名不炸）',
  zip.includes(Buffer.from('ppt/slides/slide1.xml', 'utf8')))

console.log('— 终验：python zipfile 标准解析器实解')
{
  const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'dsh-zip-'))
  const zipPath = path.join(dir, 't.zip')
  fsp.writeFileSync(zipPath, zip)
  try {
    const out = execFileSync('python', ['-I', '-c', `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()  # 全量 CRC 校验，坏则返回坏文件名
names = z.namelist()
content = z.read('ppt/slides/slide1.xml').decode('utf-8')
print('BAD=' + str(bad))
print('NAMES=' + repr(names))
print('CONTENT_OK=' + str('中文内容' in content))
print('SIZES_OK=' + str(z.getinfo('[Content_Types].xml').file_size == len('<Types/>')))
`, zipPath], { encoding: 'utf8' })
    // ⚠ Windows python print 行尾是 \r\n（CRLF 坑三次实锤）——比对前剥 \r
    const get = (k) => (out.split('\n').find((l) => l.startsWith(k + '=')) ?? '').slice(k.length + 1).replace(/\r$/, '')
    ok('★ testzip 全量 CRC 通过（BAD=None）', get('BAD') === 'None', get('BAD'))
    ok('★ namelist 三件齐（顺序=构造序）',
      get('NAMES') === "['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']", get('NAMES'))
    ok('★ 内容 roundtrip 一致（UTF-8 中文无损坏）', get('CONTENT_OK') === 'True')
    ok('★ 记录尺寸与真实一致（STORE 型无压缩，local/central/EOCD 三处一致才能过 zipfile）',
      get('SIZES_OK') === 'True')
  } finally {
    fsp.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`合计：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
