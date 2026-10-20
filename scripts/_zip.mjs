// 把 dist/pkg 打成 zip（用 node 内置能力，避免依赖外部 zip 命令）
// 用法：node scripts/_zip.mjs <输出zip路径>
import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'dist', 'pkg')
const OUT = process.argv[2]
if (!OUT) {
  console.error('用法：node scripts/_zip.mjs <输出zip路径>')
  process.exit(2)
}

// ---- 最小 zip 写入器（store/deflate 均可，这里统一 deflate） ----
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

async function walk(dir, base = '') {
  const out = []
  const ents = await fs.readdir(dir, { withFileTypes: true })
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of ents) {
    const full = path.join(dir, e.name)
    const rel = base ? base + '/' + e.name : e.name
    if (e.isDirectory()) out.push(...(await walk(full, rel)))
    else out.push({ full, rel })
  }
  return out
}

const files = await walk(SRC)
const chunks = []
const central = []
let offset = 0

// DOS 时间戳：固定用当前本地时间
const now = new Date()
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

for (const f of files) {
  const data = await fs.readFile(f.full)
  const comp = zlib.deflateRawSync(data, { level: 9 })
  const nameBuf = Buffer.from(f.rel, 'utf8')
  const crc = crc32(data)

  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)        // version needed
  local.writeUInt16LE(0x0800, 6)    // UTF-8 flag
  local.writeUInt16LE(8, 8)         // deflate
  local.writeUInt16LE(dosTime, 10)
  local.writeUInt16LE(dosDate, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(comp.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  local.writeUInt16LE(0, 28)
  chunks.push(local, nameBuf, comp)

  const cen = Buffer.alloc(46)
  cen.writeUInt32LE(0x02014b50, 0)
  cen.writeUInt16LE(20, 4)
  cen.writeUInt16LE(20, 6)
  cen.writeUInt16LE(0x0800, 8)
  cen.writeUInt16LE(8, 10)
  cen.writeUInt16LE(dosTime, 12)
  cen.writeUInt16LE(dosDate, 14)
  cen.writeUInt32LE(crc, 16)
  cen.writeUInt32LE(comp.length, 20)
  cen.writeUInt32LE(data.length, 24)
  cen.writeUInt16LE(nameBuf.length, 28)
  cen.writeUInt32LE(offset, 42)
  central.push(cen, nameBuf)

  offset += local.length + nameBuf.length + comp.length
}

const cenBuf = Buffer.concat(central)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(cenBuf.length, 12)
eocd.writeUInt32LE(offset, 16)

await fs.writeFile(OUT, Buffer.concat([...chunks, cenBuf, eocd]))

const st = await fs.stat(OUT)
console.log(`✓ 已写出 ${OUT}`)
console.log(`  文件数 ${files.length}，zip 大小 ${st.size} 字节`)
for (const f of files) console.log('   ·', f.rel)
