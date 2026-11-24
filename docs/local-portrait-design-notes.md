# lib/local-portrait.js 设计说明（从源码外置，压 2 MB 红线）

> 本文件逐字保存 `lib/local-portrait.js` 原有头部说明，功能不变。

lib/local-portrait.js —— 内置 Rust 图片合成器的发现 + 调用 + 围栏（纯逻辑 / 依赖注入）。

对应 tools-rust/dshqp-portrait（源码可复现构建），产物放 assets/bin/dshqp-portrait.exe。

## 诚实边界

这是纯 CPU 的「贴图合成 / 预演」底座（把选定人物图按框选贴到底图上，可绿幕抠图 + 边缘羽化），**不是像素级换脸**。真正换脸要几 GB 扩散模型 + GPU，本插件不捆绑、不下载、不假装能做。人脸检测/对齐需 ONNX 模型（模型除外），走发现 + 引导，见 lib/portrait-swap.js。

本模块：不 spawn、不联网、不读文件内容；由宿主注入 runArgv / exists / toPath。路径围栏：三个路径（底图 / 人物图 / 输出）都必须落在 outputDir 内，防越权读写；文本规范化之后再对已存在路径做 realpath 元数据复验，挡住 junction / symlink 穿透。异常只回固定文案 + 降级原因，不回吐 error.message（可能夹带本机路径）。

## 跨平台围栏补记（2026-11-21）

Linux 的 `path.resolve('X:\\x.png')` 不认盘符为绝对路径，会把 Windows 盘符路径当成普通文件名收进出图目录。因此 `isInsideOutputDir` 在解析前追加一条：仅当**本机 path 也不认为它是绝对路径**时，拒 `X:\` / `X:/` / UNC 写法。Windows 本机合法的盘内绝对路径照常放行，避免误伤。
