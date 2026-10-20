#!/usr/bin/env bash
# 重启 ComfyUI（ROCm 版），把 stdout/stderr 落到固定日志文件。
# 为什么要写成脚本：heredoc + `$` + 反引号在 Git Bash 里会被吞掉，
# 之前多次踩坑；落成文件最稳。

cd /k/ComfyUI-rocm/ComfyUI || exit 1

# 启动参数与插件 ensureComfyUp 保持一致
ARGS="--listen 127.0.0.1 --port 8188 --use-quad-cross-attention"

nohup /k/ComfyUI-rocm/venv/Scripts/python.exe main.py $ARGS \
  > /k/ComfyUI-rocm/comfy-out.log 2> /k/ComfyUI-rocm/comfy-err.log &

echo "已启动 PID=$!"
