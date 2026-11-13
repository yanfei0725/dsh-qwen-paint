/**
 * 核显 / 共享显存 / 8 GB 低配支持 —— 纯离线回归（不联网、不起子进程、不写文件）
 *
 * 重点锁住：
 *  · 核显被识别成「共享显存」而不是「独显小显存」
 *  · 共享显存一律走最轻精度档（gguf），不会因为报了显存就升级档位
 *  · 速度门槛是**可量化**的，且明确标 unverified（不许冒充实测结论）
 *  · resolveVramArgs 对共享显存 / 极小显存自动给 --lowvram，但显式档位优先
 *  · 安装脚本不再把核显用户劝退成「换台机器」
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assessLowEndReadiness, resolveVramArgs, GPU_PROFILES, VRAM_MODES,
} from '../lib/config.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const failures = []
// 逐条输出 ✓：回归入口按标记数统计断言，套件自己喊「全部通过」但 0 项会被当假阳性
const ok = (cond, msg) => { if (cond) { passed += 1; console.log(`✓ ${msg}`) } else failures.push(msg) }
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

/* ---------- 1. 核显档位本身 ---------- */
ok(GPU_PROFILES.intel_igpu !== undefined, '★ 存在 intel_igpu 档（核显不再被当成独显）')
eq(GPU_PROFILES.intel_igpu.sharedMemory, true, '★ intel_igpu 标记 sharedMemory=true')
ok(GPU_PROFILES.intel_igpu.args.includes('--lowvram'), '★ intel_igpu 启动参数含 --lowvram')
ok(GPU_PROFILES.intel_igpu.packs.length === 0, '★ 核显不挂任何厂商加速包（装了也没用，只会拖慢启动）')
ok(typeof GPU_PROFILES.intel_igpu.note === 'string' && GPU_PROFILES.intel_igpu.note.length > 20,
  '★ 核显档带人话说明（告诉用户为什么慢、需要多少内存）')

/* ---------- 2. 低配门槛评估 ---------- */
const igpu8 = assessLowEndReadiness({ vramGB: 0, systemRAMGB: 8, sharedMemory: true })
eq(igpu8.tier, 'gguf', '★ 核显 8 GB → 最轻精度档 gguf')
eq(igpu8.meetsAcceptableBar, false, '★ 核显 8 GB 不谎报「达到可接受速度」')
ok(Number.isFinite(igpu8.speedTargetSec) && igpu8.speedTargetSec > 0,
  '★ 核显 8 GB 给得出具体秒数门槛（不是空话）')
eq(igpu8.unverified, true, '★ 门槛标 unverified（不冒充实测结论）')

const igpu16 = assessLowEndReadiness({ vramGB: 0, systemRAMGB: 16, sharedMemory: true })
eq(igpu16.meetsAcceptableBar, true, '★ 核显 16 GB → 达到可接受门槛')
ok(igpu16.speedTargetSec < igpu8.speedTargetSec, '★ 内存越大，门槛秒数越短（单调）')

const sharedWithBigVram = assessLowEndReadiness({ vramGB: 24, systemRAMGB: 32, sharedMemory: true })
eq(sharedWithBigVram.tier, 'gguf', '★★ 共享显存即使报了大显存，也强制最轻档（核显上 q4 最稳）')

const d8 = assessLowEndReadiness({ vramGB: 8 })
eq(d8.tier, 'int8', '独显 8 GB → int8 档')
eq(d8.meetsAcceptableBar, true, '独显 8 GB 视为可达标下限')
const d16 = assessLowEndReadiness({ vramGB: 16 })
eq(d16.meetsAcceptableBar, true, '独显 16 GB 达标')
ok(d16.speedTargetSec < d8.speedTargetSec, '★ 独显显存越大门槛越短')
const d4 = assessLowEndReadiness({ vramGB: 4 })
eq(d4.meetsAcceptableBar, false, '独显 4 GB 不谎报达标')

const unknown = assessLowEndReadiness({})
eq(unknown.speedTargetSec, null, '★★ 拿不到硬件信息 → speedTargetSec=null（不瞎编一个数）')
eq(unknown.unverified, true, '拿不到信息时同样标 unverified')

/* ---------- 3. 驻留参数 ---------- */
const sharedArgs = resolveVramArgs({ mode: 'auto', vramGB: 0, isMac: false, sharedMemory: true })
ok(sharedArgs.args.includes('--lowvram'), '★ 共享显存 auto → 自动 --lowvram')
const tinyArgs = resolveVramArgs({ mode: 'auto', vramGB: 2, isMac: false })
ok(tinyArgs.args.includes('--lowvram'), '★ 显存 < 4 GB auto → 自动 --lowvram')
const explicit = resolveVramArgs({ mode: 'cpu', vramGB: 0, isMac: false, sharedMemory: true })
ok(explicit.args.includes('--cpu'), '★★ 显式档位优先于共享显存自动规则')
const bigArgs = resolveVramArgs({ mode: 'auto', vramGB: 24, isMac: false })
ok(bigArgs.args.includes('--highvram'), '大显存 auto → --highvram')
const noInfo = resolveVramArgs({ mode: 'auto', vramGB: 0, isMac: false })
eq(noInfo.args.length, 0, '拿不到显存 → 不加驻留参数')
ok(VRAM_MODES.includes('auto'), 'VRAM_MODES 仍含 auto（接口未破）')

/* ---------- 4. 安装脚本不再劝退核显 ---------- */
const setupSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
ok(!setupSrc.includes('基本跑不动，建议换台机器'),
  '★★ 安装脚本不再把核显用户劝退成「换台机器」')
ok(/intel[^\n]*核显|核显[^\n]*intel/u.test(setupSrc), '★ 安装脚本里仍有针对 Intel 核显的说明')
ok(/lite|GGUF|gguf/u.test(setupSrc), '★ 安装脚本保留轻量档路径')

/* ---------- 5. 门槛接到工具输出 ---------- */
const accelSrc = fs.readFileSync(path.join(ROOT, 'lib', 'comfy-accel.js'), 'utf8')
ok(/assessLowEndReadiness/u.test(accelSrc), '★ 能力探测里调用了低配门槛评估')
ok(/lowEnd/u.test(accelSrc), '★ 探测结果透出 lowEnd 字段')
ok(/systemRAMGB/u.test(accelSrc), '★ 探测结果透出整机内存（核显用户唯一有意义的那个数）')
ok(/unverified/u.test(accelSrc) || /summary/u.test(accelSrc), '★ 工具输出带人话总结')

const cfgSrc = fs.readFileSync(path.join(ROOT, 'lib', 'config.js'), 'utf8')
ok(/os\.totalmem\(\)/u.test(cfgSrc), '★ 整机内存来自 os.totalmem()（不猜、不起子进程）')

console.log(`\ntest-lowend: ${passed} 项断言通过${failures.length ? `，${failures.length} 项失败` : ''}`)
for (const f of failures) console.error(`  ✗ ${f}`)
if (failures.length) process.exit(1)
