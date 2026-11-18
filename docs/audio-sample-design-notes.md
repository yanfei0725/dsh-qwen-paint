# lib/audio-sample.js 设计说明（长注释外置自源码）

> 由 scripts/slim-comments.mjs --apply 生成；源码只留一行锚点，逐字原文见下方各节。


---

<!-- 由 scripts/slim-comments.mjs 自动外置；源码只留锚点，逐字内容见此。 -->

### audio-sample-note-001（原 lib/audio-sample.js L1-22）

```js
/**
 * lib/audio-sample.js —— 拖入音频样本库（本地批次，未发布）。
 *
 * ## 覆盖的需求
 *   用户可直接拖入 MP3 / WAV / FLAC 等音频，作为「新音色」的参考样本。
 *
 * ## ★ 诚实边界
 *   这是**零样本 / 参考音频音色克隆**：把样本交给 TTS 节点做说话人嵌入，
 *   **不训练、不微调、不产出新的权重文件**。任何「训练新音色」的说法都是误导。
 *   样本只作为推理时的参考输入，插件不自动下载任何模型权重。
 *
 * ## 隐私与安全
 *   · 样本一律落在 outputDir 的 .voice-samples/ 子目录，拒绝 .. 穿越与任意本机路径；
 *   · 对外只暴露 id / 文件名 / 相对路径，绝不回吐本机绝对路径；
 *   · 文件名净化、大小上限、扩展名白名单；id 只允许 [a-z0-9_-]；
 *   · 用户可删除样本（连文件一起删），删除是显式动作。
 *
 * ## 为什么用模块级单例
 *   lib/speech-tool.js 在 index.js 里创建，端点却在 lib/tool-registry.js 里注册，
 *   两者不共享 deps。用 getAudioSampleStore(outputDir) 单例让两边拿到同一个库，
 *   **零 index.js 改动**（贴着 DSH Store 单文件上限）。
 */
```
