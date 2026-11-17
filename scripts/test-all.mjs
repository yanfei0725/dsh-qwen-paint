#!/usr/bin/env node
/**
 * dsh-qwen-paint —— 统一回归入口（`npm test`）
 *
 * ## 为什么要有这个文件
 *
 * 血泪教训的原文：**"不在回归清单里的测试 = 等于没有测试。"**
 *
 * 这条教训是拿真事换来的：`scripts/selftest.mjs` 从 0.1.0 起一路漂移，
 * 因为没人跑它，直到 0.17.10 才发现里面 15 项断言早就红了
 *（AUTH001 把写操作从 GET 迁到 POST 之后，测试没跟着改）。
 * 那 15 项红着的三天里，**没有任何一条命令会自动变红**。
 *
 * 所以这里做的事只有一件：把"该跑的"钉成一份清单，跑一个不漏，
 * 任何一套红了就让整条命令以非零码退出 —— 让它在 push 之前自己叫。
 *
 * ## 判定口径（重要，别改成"看输出里有没有 ✔"）
 *
 *   ① **退出码**是第一依据：非零 = FAIL。
 *   ② 退出码 0 但输出里有以 `✗` 开头的行 = FAIL（有的套件忘了 `process.exit(1)`，
 *      只靠打印，这类"绿着红"必须抓住）。
 *   ③ 派生进程都起不来（沙箱间歇性禁止派生，曾出现 `spawnSync → EBUSY`）= **SKIP**，
 *      不是 FAIL。环境不允许和自己写错是两件事，混在一起就意味着"永远不会修"。
 *
 * ## 用法
 *
 *   node scripts/test-all.mjs              # 跑全部
 *   node scripts/test-all.mjs --only=net   # 只跑名字里含 net 的
 *   node scripts/test-all.mjs --quiet      # 只打结论和失败详情
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * 回归清单。新增测试脚本时**必须**登记到这里，否则等于没写。
 * `heavy: true` 的排在最后（跑得久，失败时不必等它）。
 */
const SUITES = [
  // —— 三大主力（项数最多，覆盖面最广）——
  { file: 'test-net-guard.mjs', note: '网络边界 + URL 规范化（双斜杠坑）' },
  { file: 'test-request-trust.mjs', note: '本机 HTTP 接口的调用方信任判定 + 405/415 守卫' },
  { file: 'test-workflow-contract.mjs', note: 'ComfyUI 工作流节点契约' },
  // ★ 0.18：官方 Turbo 8/9 步、多图编辑、裁剪回贴、移除、扩图
  { file: 'test-turbo-edit.mjs', note: '官方 Turbo / Crop→Sample→Stitch 任务链' },
  // ★ v3 §15.4 第 1/3 步：ETA 方向 + 16→4 档量化 + schema JSON 桥接
  { file: 'test-mode-schema.mjs', note: 'mode-schema 契约 / ETA / schema 桥接' },
  { file: 'test-model-label.mjs', note: '模型文件名预处理（host + 前端同口径）' },
  { file: 'test-model-options.mjs', note: '主模型候选端点 / 动态白名单 / 视频模型落盘' },
  // ★ v3 §15.4 第 2 步：控制项落地层（clamp / 速度%语义 / 落盘往返 / 优先级）
  { file: 'test-pipeline-controls.mjs', note: '控制项持久化与生效映射（pipeline-controls）' },
  // ★ v3 §15.4 第 3 步前端竖切：面板真渲染一遍（vm + 假 DOM，专抓"静态绿、一渲染就炸"）
  { file: 'test-fab-drag.mjs', note: '浮标拖动 / tap-drag 分离 / rebuild 后开关不卡死（vm + Pointer Events 假 DOM）' },
  // ★ v3 §13.4 / §14.3 代码级修正四件：两层缓存 / pick(installed) / 结构化水位 / runPasses 深拷
  { file: 'test-pipeline-core.mjs', note: '控制层内核四件（缓存/加速档/水位/pass 管线）' },
  // ★ 视频链：Wan 2.2 / XT-5B 工作流图 + generate_video 接线
  { file: 'test-video-workflow.mjs', note: '视频链工作流契约（节点/参数/对齐/接线）' },
  { file: 'test-audio-workflows.mjs', note: '语音克隆 + 音轨合成（真机节点契约/上传/降级）' },
  // ★ 2026-11-14 A1：工作流 JSON 化第一步 —— 清单 / 双轨一致性 / 校验器 / 发布物完整性
  { file: 'test-workflow-manifest.mjs', note: '工作流声明式清单（双轨逐字节一致 / 校验器真抓错 / files 白名单）' },
  // ★ 生成进度：队列位置 + 家自实测 ETA（不编数字）
  { file: 'test-progress.mjs', note: '生成进度与 ETA（队列/EWMA/百分比封顶）' },
  { file: 'test-style-library.mjs', note: '素材库（风格/指令/skill）+ 视频加速档面板项' },
  // ★ 报告 v3 §13/§14：Go L3 调度器原型 + AST A/B/C 三线 + 混合模式
  { file: 'test-workflow-ast.mjs', note: 'B 线 WorkflowAST / 5 passes / 提交前校验与回滚 / comfy-catalog 接线' },
  { file: 'test-hybrid-runner.mjs', note: '混合模式三段编排（20/10/70 权重 / 分段 / 卸载 / 取消）' },
  { file: 'test-tts-workflow.mjs', note: 'TTS 兜底链 / 缺件报告 / 可插拔探测' },
  // ★ 2026-11-13 B3 剩余：独立语音工具 + 描述集中层 + 回包按声明收口
  { file: 'test-speech-tool.mjs', note: 'generate_speech / 描述集中层 / 回包收口（假 deps，零联网零媒体）' },
  { file: 'test-pipeline-modes.mjs', note: '面板 /modes 动态可用性（vm 真跑 mount）' },
  { file: 'test-ast-split.mjs', note: 'A 线 derive-slots + C 线零依赖源码 AST 零漂移验证器' },
  // ★ 2026-11-16 体积红线根治：注释外置减压工具（字符串状态机 / 语义注释保护 / 逐字可逆 / 幂等）
  { file: 'test-slim-comments.mjs', note: '注释外置减压：状态机不误判字符串 / 语义注释不误删 / 零漂移可逆 / 真实源码减压达标与幂等' },
  // ★ 模型无关「角色参考」适配层 + 联网参考图硬同意门（两套都是纯 JS / 注入 fetch，不联网不派生子进程）
  //   新增测试必须登记进本清单，否则等于没写：这两套不登记就永远不会被 npm test 跑到。
  { file: 'test-reference-strategy.mjs', note: '角色参考：能力协商 / 模型无关查槽 / 零漂移 / I2V 起始帧契约' },
  { file: 'test-reference-web.mjs', note: '联网参考图：逐请求同意门 / query 透传 / 端点 SSRF / 载荷白名单 / 不下载图片字节' },
  { file: 'test-reference-config.mjs', note: '配置 / 契约 / 文档一致性：默认不可出站、占位符不漂移、面板只有一条联网出口' },
  { file: 'test-ui-workbench.mjs', note: '图片编辑台：可见入口 / 端点围栏 / 蒙版清理 / 参数 clamp / 装完引导不回退' },
  // ★ 0.2.0：视频模型清单 / 选型 / 下载护栏（纯注入，不联网、不下载、不派生子进程）
  { file: 'test-video-model-catalog.mjs', note: '视频模型：官方清单权威值 / 按显卡推荐 / 默认不装 / 多源轮询 / 只下不传' },
  { file: 'test-lowend.mjs', note: '核显 / 共享显存 / 8 GB：识别为共享显存 / 强制 gguf / 量化门槛 unverified / --lowvram / 不再劝退' },
  { file: 'test-video-frames.mjs', note: '视频选帧：时间码↔帧号 / 两种选法归一 / argv 无注入 / 目录边界 / 无 ffmpeg 不假装成功' },
  // ★ 2026-11-13 时间轴增强：缩略图轨道 + 改完的帧回贴
  { file: 'test-video-replace.mjs', note: '帧回贴：区间换算 / overlay argv / 端点围栏 / 前端接线 / 体积红线' },
  { file: 'test-igpu-profiles.mjs', note: '可选核显型号清单 / 诚实口径 / 可选自动下载默认关闭 / 低配判定回归锁（零联网零硬件探测）' },
  { file: 'test-file-route.mjs', note: '媒体字节路由：穿越拦截 / 大小上限 / MIME 白名单 / nosniff / 只读' },
  { file: 'test-http-errors.mjs', note: '错误响应统一消毒 / 静态资源表驱动外置 / 异常只进本机日志 / 热路径零开销' },
  // ★ 2026-11-13 用户报「安装引导死活点不动、还关不掉」：宿主吞 click，旧 UI 只绑 click 且无退路。
  //   vm + 假 DOM 真派发 pointerup / Escape / 点外部，锁住修复与「不双触发 / 不越界」。
  { file: 'test-ui-pointer.mjs', note: 'UI 点按兜底：宿主吞 click 仍能开关 / Escape 与点外部退路 / 旧按钮补发不重复 / client.js 零字节增长' },
  // ★ 2026-11-13 产品化改造：图形化引导 / 蒙版精修真接线 / 卸载内存 / 外部集成状态
  { file: 'test-product-round.mjs', note: '产品化改造：引导步骤与同意门 / 蒙版参数真透传零漂移 / 卸载三态 / 端点围栏与脱敏 / 目录⊆注册 / 体积红线（全离线）' },
  // ★ 2026-11-13 用户定「每次发布，简介 / 描述 / 版本号全部一起改」：把它变成机器护栏
  { file: 'test-release-metadata.mjs', note: '发布元数据护栏：简介逐字同步 / 版本号六处一致 / 视频下载包能力口径 / 无误读措辞 / 时态·许可·更新说明不许说谎 / 回归套数与体积余量按真实值推导（漏改一处就红）' },
  // ★ 2026-11-13 CPU 指令集识别 / 加速档：五档参数 + --cpu 互斥裁决 + 三态语义 + 端点围栏
  { file: 'test-cpu-profile.mjs', note: 'CPU 加速档：型号/指令集三态 / 五档真实参数 / --cpu 摘显存与GPU内核 / 互斥组后者胜出 / QwenImage21Cache 覆盖 / 端点围栏与脱敏（全离线）' },
  // ★ 2026-11-13 生成历史：真跑 node:sqlite（库在系统临时目录、跑完即删）+ 端点围栏 + 降级口径
  { file: 'test-history.mjs', note: '生成历史：相对路径入库 / 重复忽略 / 软删除不动磁盘文件 / SQL 注入不破表 / 无 sqlite 如实降级 / 端点围栏与脱敏 / 前端无 innerHTML 与外部 URL（全离线）' },
  { file: 'test-history-export.mjs', note: '历史可带走形态：结构化 alt（F30）/ Markdown 引用不泄漏绝对路径（G32）/ 继续编辑候选（G33）/ 缩略图 data_url 三道闸与落盘回滚（G36）' },
  // ★ 2026-11-14 第四/五批：创作编排、运行期护栏、批量守卫
  { file: 'test-batch-guard.mjs', note: '批量出图守卫：种子×尺寸笛卡尔积 / 单张失败不中断整批 / 失败后队列复位 / 错误可操作化诊断（注入假 runOne，零出图）' },
  { file: 'test-creative-chain.mjs', note: '创作编排：产出短引用 #1 最新（D18）/ 时间轴骨架与末段夹取（D20）/ 资源需求三档且不给秒数（E27）/ 数据流摘要 external 是算出来的（F31）/ 色调提取 HSL 与全灰不硬造色相（F29）' },
  { file: 'test-compose-tools.mjs', note: '字幕编排：脚本字幕 SRT/VTT + 语音转写缺件清单（D19）/ 参数来源逐行标注（D23）/ 入口别名只指已注册工具（D24）/ 懒加载盘点如实说做不到运行时跳过（D26）/ 视频后处理层（A2）/ 预设绑定链（A3）' },
  { file: 'test-runtime-guards.mjs', note: '运行期护栏：显存建议只建议不改配置（B4）/ 会话级模型驻留（B5）/ 幂等保护含并发合并与失败不记账（C16）/ 工作流图结构指纹（A1）/ 草图台端点三道闸（D25）' },
  // ★ 2026-11-14 第五批续：五条「诚实边界」收口（A1 契约 / D19 ASR 真通路 / E27 自校准 / B5 全覆盖 / 三模式差异化）
  { file: 'test-contract-asr-eta.mjs', note: '边界收口：契约对账全 diff.kind 与真 buildWorkflow 过契约含 turbo alternates（A1）/ ASR 真通路全分支（D19）/ 本机秒数自校准与不跨档借用（E27）/ 三模式差异化计划一致性（UI）' },
  { file: 'test-pipeline-panel.mjs', note: '控制面板行为回归（渲染 / 请求 / 禁用项 / 三模式差异化：生图隐藏视频组、混合出 TTS 卡）' },
  // ★ 2026-11-16 UI 性能：选模型卡一下 / 渲染占资源 —— model-options TTL 缓存 / 下拉增量回填 / 轮询降频 / lab /health 懒加载（全离线 vm+假 DOM）
  { file: 'test-ui-perf.mjs', note: 'UI 性能：model-options 缓存命中/TTL/失败不缓存 / 下拉增量回填只改 value / 轮询空列表降频 / lab health 懒加载与强制刷新 / 源码接线防孤儿' },
  { file: 'test-perf-config.mjs', note: '提示词模板（F28 渲染无残渣/无重复后缀）/ 显存与缓存档位语义（B7/B8）/ 缓存命中摘要口径（B9）/ 进度分级日志过滤（G35）/ 一键恢复默认改名不删（G34）' },
  // —— 契约 / 面板 / 步骤 ——
  { file: '_tool_contract_test.mjs', note: '工具契约' },
  { file: '_step4_dry_test.mjs', note: '4 步干跑' },
  { file: '_client_scope_test.mjs', note: '面板作用域无未声明标识符' },
  { file: '_opt_status_test.mjs', note: '状态机与状态端点' },
  { file: '_portability_test.mjs', note: '可移植性' },
  { file: '_launch_args_test.mjs', note: '启动参数' },
  { file: '_mac_env_test.mjs', note: 'macOS/MPS 环境变量注入' },
  { file: '_perf_tweaks_test.mjs', note: '性能开关' },
  { file: '_vae_spectrum_test.mjs', note: 'VAE 分块 + Spectrum 跳步节点图' },
  { file: '_gpu_vendor_test.mjs', note: '显卡判定 + Mac 面板' },
  { file: '_manifest_test.mjs', note: 'manifest 一致性' },
  // ★ 2026-10-20 新增（0.17.13）：面板圈选重绘三项修复的回归锁
  //   （蒙版泄漏 / 同毫秒覆盖 / 结果图裂图 / 结果图堆叠 / 浮层双开）
  { file: '_inpaint_ui_test.mjs', note: '圈选重绘 UI 修复 + inpaint 授权围栏回归' },
  // ★ 2026-10-19 补进回归：它一直没被 `npm test` 跑过，漂移了 16 项都没人发现
  //   （全是"源码字符串搬家了/写操作改 POST 了"导致的过期断言）。
  { file: '_review_fixes_test.mjs', note: '0.17.6 那批修复的源码级回归' },
  { file: '_no_private_docs_test.mjs', note: '私人/开发文档不进公开仓库（源码目录 SKIP）' },
  { file: 'test-dsh-compat.mjs', note: 'COMPAT001 实测（无 dsh 环境时明确 SKIP）' },
  { file: 'test-audit-0321.mjs', note: '0.32.1 两轮审计修复：ASR 路径围栏 / 发布物脚本 / 草图台点按 / 嵌套消毒 / 版本简介同步 / 指纹基准只读 / 端点目录别名 / 体积写入前守卫（全离线）' },
  // ★ 2026-11-14 0.32.1 之后能力扩展批次（9 套，全离线、注入假 deps，零出图零联网）
  { file: 'test-gif.mjs', note: 'GIF 转换工具 + 端点（ffmpeg 参数纯构建 / 能力探测如实降级 / 端点围栏）' },
  { file: 'test-job-queue.mjs', note: '通用优先级任务队列（排序 / 并发 / 取消信号 / 重试退避，纯 JS 零 I/O）' },
  { file: 'test-iterate-tool.mjs', note: '单图多轮迭代优化（策略连跑 / 每轮候选 / 挑 best / 三条硬边界）' },
  { file: 'test-history-admin.mjs', note: '生成历史可删改 / 冷热分离 / 参数化查询（幂等 ALTER + 注入 SQL）' },
  { file: 'test-doctor-dag.mjs', note: '运行期自诊断 + 自适应 DAG 编排（默认 dry_run / 缺能力明确降级）' },
  { file: 'test-accel-config.mjs', note: '配置一致性裁决 + 缓存后端注册表 + TTS 加速可插拔（诚实边界）' },
  { file: 'test-vram-budget.mjs', note: '按子任务类型的显存预算建议（与 vram-strategy 档位的概念边界）' },
  { file: 'test-structured-log.mjs', note: '结构化事件日志 JSON Lines（只记事实 / 可跨版本做趋势分析）' },
  { file: 'test-fab-clamp.mjs', note: 'Comfy 控制面板零边距贴 DSH 边框 / 实验室已内嵌（无独立浮层）/ 四事件点按 / 300ms 冷却' },
  // ★ 2026-11-14：孤儿模块修复后的联动护栏（用户亲订「单个功能完成 ≠ 最终完成」）
  { file: 'test-accel-chain.mjs', note: '加速链联动：TTS 加速进链 / 5 个原孤儿模块真实参与 / 端点·工具报告·UI 三处消费 / 16 模块孤儿扫描' },
  { file: 'test-capability-audit.mjs', note: '清单全面排查联动：显存 MB→GB 修复 / 结构化日志落盘 / 显存预算端点 / TeaCache 装配计划 / TTS 补丁零污染 / doctor 探针契约 / Agent 端点目录 / 新模块孤儿扫描' },
  // ★ 2026-11-15：MEMORY.md 第 11 节「明确待办」六条收口后新增的护栏
  { file: 'test-chain-manifest.mjs', note: '三条链统一声明式清单目录 / 契约+指纹来源真校验 / runtime 唯一 / 预设绑定去 pending' },
  { file: 'test-generation-log.mjs', note: '生成完成自动落盘结构化日志（实测总耗时 / 脱敏 / 细分耗时 null / 钩子失败不影响出图）' },
  { file: 'test-draft-pointer.mjs', note: '草图台指针序列离线仿真验收 + smoke.mjs 默认只读 / --submit 显式开关契约' },
  // ★ 2026-11-15：MIT → BSL 1.1（四年后转 Apache-2.0）换证护栏
  { file: 'test-license-bsl.mjs', note: 'BSL 1.1 换证：官方条款正文逐字 + SHA-256 / 五参数 / Change Date 真四年 / 0.32.1 不追溯 / 8 处文档口径 / 第三方许可不误改 / 脱敏' },
  // ★ 2026-11-15 第五次 UI 报障：点不动 / 没反应的两个真根因
  { file: 'test-ui-tap.mjs', note: 'UI 点按专项：四事件假 DOM 真派发 / 300ms 冷却 / 拖动抑制 / 叉叉 render 内重绑 / fab 补绑 click 与宿主合成 click 联动 / UI_BUILD 自证' },
  // ★ 2026-11-15 媒体格式转换批次（图片/视频/音频 11 种 + 动图转视频 + 生成物预设后转码 + Agent 调用）
  { file: 'test-media-convert.mjs', note: '媒体格式转换：11 种格式唯一真相源 / 同类互转与跨类拒绝 / ffmpeg 参数纯构建 / 输入输出双围栏 / ffmpeg 探测与诚实降级 / 生成完成钩子自动后转码（组合不覆盖日志）/ 端点预设 / 七处联动与孤儿扫描（全离线）' },
  // ★ 2026-11-15 本地能力批次（未发布）：TTS 后端 / 音频样本 / 统一协议 / 音乐 BGM /
  //   手动超分 / Worker 分级保活 / 模型下载源 / 七处接线与孤儿扫描（全离线）
  { file: 'test-creative-models.mjs', note: '本地能力批次：GPT-SoVITS v5 dev/turbo 与 IndexTTS2 / 拖入音频样本 / 统一输入输出协议 / ACE-Step 1.5 与 YuE2 / 手动超分 / Worker 热温冷分级保活 / 下载源权威值校验与断点续传 / 七处联动与孤儿扫描（全离线）' },
  // ★ 2026-11-15：进度条 / 滑块 / 卡片横向溢出加固，纯 CSS 盒模型收口 + 改坏变红反向核查
  { file: 'test-overflow.mjs', note: '横向溢出加固：面板 content-box / 滑块 width:100% / flex 子项 min-width:auto 三层收口，三份 CSS 护栏 + 改坏变红反向核查（全离线）' },
  // ★ 2026-11-15：SageAttention / WaveSpeed 真接线（加速链 / 工作流 / 卡片 / 真实节点表探测）
  { file: 'test-attention-wiring.mjs', note: '注意力与编译后端真接线：并入加速链 / 两条工作流构造路径 / 卡片常驻显示 / 本机 /object_info 真实探测 / check_acceleration 报告 / 改坏变红反向核查（全离线）' },
  // ★ 2026-11-15 收尾：三个孤儿模块（entry-alias / color-tone / creative-chain）真接进主链路
  { file: 'test-vectorize.mjs', note: '矢量化两步法：目录事实（MIT / GPL / 权威字节数 / 官方单源）/ argv 与 clamp / potrace 黑白位图限制 / 探测与执行诚实边界（未安装绝不谎称）/ 注册层与文档点名同步（全离线）' },
  { file: 'test-blockswap.mjs', note: '极限低显存 Block 交换：目录事实（MIT / repo / 四态机制 / 不代装）/ 发现（模式匹配 + 未装如实）/ accel-chain 集成消费（低显存提示）/ 文档同步（全离线）' },
  { file: 'test-hw-route.mjs', note: '硬件感知路由：架构解析（NVIDIA 四代 / AMD 三系 + 核显 / Intel / unknown）/ Sage 变体建议（FP8/INT8/unsupported）/ 量化内核保守提示（memory-only/unverified）/ stable-fast 跳过声明 / accel-chain 集成消费 / 文档同步（全离线）' },
  { file: 'test-av-stitch.mjs', note: '轻量缝合：围栏 / 时间轴 / SRT（复用 subtitle-plan）/ ducking argv / ffmpeg 不可用诚实降级 / video-post 头部声明更新 / 注册层与文档点名同步（全离线假 execFile）' },
  { file: 'test-pptx-lite.mjs', note: '轻量档 PPTX：ZIP 结构（PK 签名 / EOCD / store）/ OOXML 组成与转义 / 围栏（.pptx + 出图目录）/ 工具成功与拒绝路径 / 注册层与文档点名同步（全离线）' },
  { file: 'test-media-fx.mjs', note: '内置最小实现：音频后处理（speechnorm/loudnorm/EQ/去齿音）/ 无模型抠图（键控+蒙版）/ 中置相消声源分离；argv 纯构建 / 双围栏 / 诚实降级 / 端点 / 七处接线孤儿扫描（全离线假执行器）' },
  { file: 'test-transcribe.mjs', note: '音频转文字：能力探测诚实分支 / schema / 未配 ASR 先报缺件 / 路径围栏 / 成功收口白名单（不吐 key/路径）/ 端点围栏 / 七处接线孤儿扫描（全离线假 fetch）' },
  { file: 'test-vulkan-upscale.mjs', note: 'Vulkan 直跑超分：资产与许可事实（MIT / 权威字节数）/ argv 构造与逐项 clamp / 探测诚实降级 / 计划与执行边界（未安装绝不谎称）/ 文档与描述点名同步（全离线）' },
  { file: 'test-orphan-wiring.mjs', note: '孤儿模块接线：口语入口别名 / 参考图色调端点（像素上限与方法守卫）/ 时间轴·资源·数据流·产出短引用四工具 / 清单与 UI 入口同步 / 拆掉接线变红反向核查（全离线）' },
  // ★ 2026-11-16 全量审计：六套一直没进回归清单的历史测试（纯 JS / 零联网 / 零子进程，全部真绿）
  //   教训原话：「不在回归清单里的测试 = 等于没有测试」。它们各自锁着真实修过的 bug。
  { file: '_abort_fix_test.mjs', note: '取消原因规范化：非 Error 对象不再泄漏成 [object Object]（toError / cancelReason）' },
  { file: '_adapt_test.mjs', note: '三厂商自适应 + 生图链路自适应（纯函数断言，不联网）' },
  { file: '_init_abort_test.mjs', note: '初始化链路：宿主 API 不全 / 可选服务缺失时不掐死 + 状态端点真注册' },
  { file: '_wrapper_policy_test.mjs', note: '互斥 wrapper 按尺寸自动选（小尺寸 TE-Speed / 大尺寸 BlockCache T8）' },
  { file: '_vram_patch_test.mjs', note: 'detectGpuProfile 真拿得到显存（锁「vramGB 恒为 0 / 驻留参数静默失效」）' },
  { file: '_toggle_field_check.mjs', note: 'BlockCache T8 项必须带 toggle 字段（前端靠它渲染开关）' },
  { file: '_draw_smoke_test.mjs', note: '生图链路 smoke：comfyUrl 指向必然连不上的端口，验降级路径不假装成功' },
  { file: '_intent_test.mjs', note: '生图意图判定四档语义差异 + 未知值安全回落 auto + 插件总开关' },
  { file: '_cordis_proxy_test.mjs', note: 'cordis ctx Proxy 裸读未声明服务属性（静态扫描；有 _vendor 时升级为真机加载）' },
  // ★ 2026-11-16：白条同源 + 选模型假成功（P0/P1/P2）联动护栏
  { file: 'test-white-bar.mjs', note: '假成功与白条：choiceResult 拒绝回传 / 权重下拉持久化缓存（真调纯函数）/ 风格下拉错误态 / 假就绪 / health 重试 / object_info 失败冷却（真跑 fetchFn）' },
  { file: 'test-gap-fill.mjs', note: '2026-11-17 补缺批：队列端点 / 历史 LoRA 筛选与单条读 / 参数包导出与重画 / 前缀模板 / 视频尾帧双轨对称 / ControlNet 预处理纯逻辑与缓存' },
  // ★ 2026-11-17：自研轻量代码动画三件套（不依赖 manim/Remotion）。
  { file: 'test-animation-kit.mjs', note: '自研动画三件套：分镜切句与画面类型 / SVG 五种渲染 / image 降级 draw_image / 合成 argv（字幕+配音）/ 路径围栏 / 执行器降级' },
  { file: 'test-anim-opt.mjs', note: '动画四项纯JS优化（hyperframes清单§13映射）：静态帧去重 / 分镜级缓存 / 草稿定稿档 / 时序校验前置；纯函数+animation-kit接线+体积（全离线内存fs桩）' },
  { file: 'test-layout-vfr-ttscache.mjs', note: '三件新功能：纯JS flex子集布局器（字符宽度估算/四类版式/落盘围栏/光栅降级）+ compose VFR/PTS + TTS旁白内容缓存（指纹/往返/坏文件不命中/命中不探活）；含生产接线与体积' },
  { file: 'test-render-backends.mjs', note: '渲染后端发现模式+动画缓存最小版：硬件编码择优(真跑探测/降级/不谎称) / resvg光栅探测 / 中文字体空白帧自检 / 瓦片缓存+可插拔后端接口 / tool-registry生产接线（全离线假执行器）' },
  { file: 'test-bgm-opt.mjs', note: 'BGM三块优化：音乐计划缓存(指纹/往返/字节自校验/篡改降级) + ducking缝合缓存(文件身份指纹/命中跳过ffmpeg/关缓存强制真跑) + §7装配计划(缓存键/ducking/断点续推/blocked诚实) + 三处生产接线非孤儿（全离线假执行器）' },
  { file: 'test-tts-lowlatency.mjs', note: '外部TTS低延迟编排（抄通用思路非抄代码）：语义分块降首音延迟 / 回环围栏(拒外部host) / gsv+openai两种API格式 / 探活结构化降级 / 许可证合规边界(GSV=MIT,AnifLive=禁商用) / 工具+端点+UI生产接线非孤儿（全离线假fetch）' },
  // —— 最重的一套放最后 ——
  { file: 'selftest.mjs', note: '全量自测（最重，项数最多）', heavy: true },
]

const argv = process.argv.slice(2)
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length).toLowerCase()
const quiet = argv.includes('--quiet')

const picked = only === '' ? SUITES : SUITES.filter((s) => s.file.toLowerCase().includes(only))

if (picked.length === 0) {
  console.error(`✗ 没有匹配 --only=${only} 的套件`)
  process.exit(2)
}

const STDIO_DENIED = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'ENOENT'])
/** 输出里"以 ✗ 开头的行"的条数 —— 用来抓"exit 0 但其实红了"的套件。 */
const crossCount = (text) => text.split('\n').filter((line) => line.trimStart().startsWith('✗')).length
/**
 * ★★★ 2026-10-19 修：**原先只认 `✓`**，于是 12 套用 `OK` / `PASS` / `✅` 的套件被统计成 0 项，
 *   显示成"全部通过"而不是"N 项断言通过"。
 *
 *   更糟的是**假阳性**：某套若因为文件改名 / 路径写错而一条断言都没跑，只要 `exit 0`
 *   且没有 `✗`，这里就会判 PASS —— 等于"没跑"和"跑了全绿"混为一谈。
 *   （这正是本文件开头那条注释说的、selftest 漂移了半年才被发现的老毛病。）
 *
 *   现在：① 认多种成功标记；② **0 项断言且没有成功总结 ⇒ FAIL**（见下面的判定分支）。
 *   要新增一套测试，请让它输出至少一个 `✓` / `OK` / `PASS` / `✅`，
 *   或者在末尾打一行"全部通过"—— 否则会被这里判红。
 */
const OK_MARK = /^(?:✓|OK\b|PASS\b|✅)/u
const tickCount = (text) => text.split('\n').filter((line) => OK_MARK.test(line.trimStart())).length
/** 没有逐条标记的套件（如整体检查型），至少要有一句成功总结，才承认它真的跑了。 */
const declaresSuccess = (text) => /(?:全部通过|结果[：:]\s*通过)/u.test(text)
/** 套件自己在输出里声明了 SKIP（环境不具备）。**不能当 PASS** —— 否则"没跑"和"跑了绿"混为一谈。 */
const declaresSkip = (text) =>
  text.split('\n').some((line) => line.trimStart().startsWith('⤼') || /^SKIP[：:]/u.test(line.trimStart()))

const results = []

console.log(`dsh-qwen-paint 回归 —— 共 ${picked.length} 套${only === '' ? '' : `（筛选：${only}）`}`)
console.log(`工作目录：${ROOT}`)
console.log('')

for (const suite of picked) {
  const script = path.join(HERE, suite.file)
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: suite.heavy ? 300_000 : 180_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const ms = Date.now() - startedAt
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`

  let verdict
  let detail = ''
  if (run.error !== undefined && run.error !== null) {
    const code = String(run.error.code ?? '')
    if (STDIO_DENIED.has(code)) {
      verdict = 'SKIP'
      detail = `环境不允许派生进程（${code}）—— 不是测试写错，换个环境再跑`
    } else {
      verdict = 'FAIL'
      detail = `派生失败：${run.error.message ?? run.error}`
    }
  } else if (run.signal !== null && run.signal !== undefined) {
    verdict = 'FAIL'
    detail = `被信号 ${run.signal} 终止（大概率超时）`
  } else if ((run.status ?? 1) !== 0) {
    verdict = 'FAIL'
    detail = `退出码 ${run.status}`
  } else if (crossCount(out) > 0) {
    verdict = 'FAIL'
    detail = `退出码 0 但输出里有 ${crossCount(out)} 行 ✗（该套件忘了 process.exit(1)）`
  } else if (declaresSkip(out)) {
    verdict = 'SKIP'
    detail = '套件自己声明 SKIP（环境不具备）'
  } else if (tickCount(out) === 0 && !declaresSuccess(out)) {
    // ★★★ 2026-10-19：**一条断言都没有、也没有成功总结** —— 大概率是"根本没跑"，
    //   绝不能因为 exit 0 就当通过。这条是为了堵住假阳性。
    verdict = 'FAIL'
    detail = '没有输出任何断言标记，也没有成功总结 —— 无法确认它真的跑了'
  } else if (tickCount(out) === 0) {
    verdict = 'PASS'
    detail = '通过（该套件无逐条断言输出，仅凭成功总结判定）'
  } else {
    verdict = 'PASS'
    detail = `${tickCount(out)} 项断言通过`
  }

  results.push({ ...suite, verdict, detail, ms, out })

  const mark = verdict === 'PASS' ? '✓' : verdict === 'SKIP' ? '⤼' : '✗'
  console.log(`${mark} ${suite.file.padEnd(30)} ${String(ms).padStart(6)} ms  ${detail}`)
  if (!quiet && verdict !== 'PASS' && suite.note !== '') console.log(`    ${suite.note}`)

  // 失败的套件立刻把它自己的错误行打出来 —— 不然还得再跑一遍才知道红在哪
  if (verdict === 'FAIL') {
    const bad = out.split('\n').filter((line) => line.trimStart().startsWith('✗')).slice(0, 12)
    for (const line of bad) console.log(`      ${line.trim()}`)
    if (bad.length === 0) console.log(`      ${out.trim().split('\n').slice(-3).join('\n      ')}`)
  }
}

const pass = results.filter((r) => r.verdict === 'PASS').length
const fail = results.filter((r) => r.verdict === 'FAIL').length
const skip = results.filter((r) => r.verdict === 'SKIP').length
const ticks = results.reduce((sum, r) => sum + tickCount(r.out), 0)
const totalMs = results.reduce((sum, r) => sum + r.ms, 0)

console.log('')
console.log(`合计：${pass} 通过 / ${fail} 失败 / ${skip} 跳过（断言 ${ticks} 项，耗时 ${(totalMs / 1000).toFixed(1)} s）`)

if (fail > 0) {
  console.log('')
  console.log('失败的套件：')
  for (const r of results.filter((x) => x.verdict === 'FAIL')) console.log(`  · ${r.file} —— ${r.detail}`)
  console.log('')
  console.log('✗ 回归未通过')
  process.exit(1)
}

console.log(skip > 0 ? '✓ 已跑的套件全部通过（有跳过项，见上）' : '✓ 全部通过')
process.exit(0)
