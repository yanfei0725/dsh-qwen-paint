#!/usr/bin/env bash
# 重启 ComfyUI（ROCm 版），把 stdout/stderr 落到固定日志文件。
# 为什么要写成脚本：heredoc + `$` + 反引号在 Git Bash 里会被吞掉，
# 之前多次踩坑；落成文件最稳。
# ⚠ 本机路径不写死：用 COMFY_ROOT 指定 ComfyUI 安装根目录（占位符），
#   本脚本是一次性开发脚手架，本地保留、不进发布物、不在仓库里留本机绝对路径。

COMFY_ROOT="${COMFY_ROOT:-<COMFYUI_ROOT>}"
cd "$COMFY_ROOT/ComfyUI" || exit 1

# 启动参数与插件 ensureComfyUp 保持一致
ARGS="--listen 127.0.0.1 --port 8188 --use-quad-cross-attention"

nohup "$COMFY_ROOT/venv/Scripts/python.exe" main.py $ARGS \
  > "$COMFY_ROOT/comfy-out.log" 2> "$COMFY_ROOT/comfy-err.log" &

echo "已启动 PID=$!"
