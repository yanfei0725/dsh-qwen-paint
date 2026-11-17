# 源码头注释外置存档（逐字可逆）

本文件保存从 `lib/*.js` 外置的纯说明性文件头注释，源码处留锚点。逐字可追溯，不含功能代码。

## `tts-lowlatency.js` 头注释（锚点 `hdr-note-tts-lowlatency`）

```
// TTS 低延迟编排：只实现通用工程思路（语义分块 / 外部服务适配 / 诚实引导），
// 不复制 AnifLive-TTS( PolyForm NC ) 或 GSV.CPP( MIT ) 的任何代码与二进制。
// 权威事实见 docs/tts-lowlatency-design-notes.md。
```

## `media-exec.js` 头注释（锚点 `hdr-note-media-exec`）

```
/**
 * lib/media-exec.js —— 媒体转换的 ffmpeg 探测 + 真执行器。
 *
 * 为什么单独一层：
 *   既有 `convert_to_gif` 是「未注入 runCommand 就只回参数预览」的纯计算工具，
 *   那是诚实，但也意味着宿主默认没接执行器时功能不可用。这次用户要的是
 *   「真的能把文件转成指定格式」，所以补一层可注入、可探测、可降级的执行器：
 *     · 探测到 ffmpeg → 真跑（execFile + argv 数组，绝不拼 shell 字符串）；
 *     · 探测不到 / 执行器被禁用 → 明确返回原因，绝不假装生成了文件。
 *
 * 探测范式沿用 lib/video-frames-endpoints.js::detectTools()（本机已验证）：
 *   先 FFMPEG_PATH 环境变量，再 PATH 里的 `ffmpeg -version`，带 10 分钟缓存。
 *   这里额外提供 ffprobe（可选，用于能力端点的版本信息）；拿不到不影响转换。
 *
 * 安全边界：
 *   · command 必须是数组；首元素固定为 'ffmpeg'，由本层替换成探测到的可执行文件；
 *   · 调用方传进来的任何字符串都只作为 argv 元素，不进 shell；
 *   · 超时 / maxBuffer 有界；异常只写本机日志，回固定文案，不回吐 error.message
 *     （可能夹带本机绝对路径）。
 */
```

## `speech-tool.js` 头注释（锚点 `hdr-note-speech-tool`）

```
/**
 * lib/speech-tool.js —— 独立语音工具 + 混合模式共用的 TTS 段（B3 剩余项）。
 *
 * ## 为什么抽出来
 *   以前 TTS 只能绑死在 `generate_hybrid` 的「图 → 音 → 视频」三段里，
 *   只想配个音也得跑完三段。现在：
 *     · `generate_speech` 是独立工具（复用同一套声明式兜底链与保存节点）；
 *     · `generate_hybrid` 的 TTS 段改为调用**同一个** `runSpeechStage`，消除两份实现。
 *
 * ## 设计
 *   · 所有 I/O（探活 / 提交 / 取字节 / 落盘辅助）由 `deps` 注入：
 *     纯编排层，离线可注入假依赖做行为级断言，不联网、不 spawn。
 *   · 能力探测只看 /object_info 的**真实节点类名**（见 tts-workflow.js 的事故复盘）；
 *     缺件抛 `ttsMissingReport` 清单，绝不假装能出音频、绝不自动下载权重。
 *   · 落盘扩展名取 ComfyUI 返回的真实 `filename`，不写死 .wav。
 *   · 不为验证生成任何媒体：测试注入假 deps，零真实 fetch / 零真实 ComfyUI。
 */
```

## `tts-accel.js` 头注释（锚点 `hdr-note-tts-accel`）

```
/**
 * lib/tts-accel.js —— TTS 加速后端的可插拔适配层。
 *
 * ★ 诚实边界：
 *   · 用户资料里提到的 CUDA Graph / Triton 融合 / GGUF / 流式 / 声码器 fp16 mel
 *     都是**方向性建议**；公开检索只确认了 faster-qwen3-tts（andimarafioti）
 *     与 ComfyUI-Qwen3-TTS（wanaigc）两个仓库存在，其余具体包名/节点名
 *     （ComfyUI-Qwen3-TTS-Fast、qwen3-tts-triton、Qwen3-TTS-GGUF、
 *      qwen3-tts-streaming）均**未查到可确认仓库**。
 *   · ⇒ 这里只做「能力探测 → 可用才启用 → 否则明确降级」，
 *     绝不把任何包硬编码成已安装。
 *   · 用户给的倍率 / RTF / 毫秒数一律是 unverified，不写进代码结论，
 *     `unverified: true` 是每项后端自带的标记。
 *   · 本模块不启动进程、不联网、不下载权重。
 */
```
