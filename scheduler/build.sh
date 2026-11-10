#!/usr/bin/env bash
# 报告 v3 §13.1：Go 只做独立 L3 调度器，验证「占比 < 1%」这个判据。
# ⚠ 产物是**可选原型**，不进 package.json 的 files、不随 DSH 插件发布、不改插件主体。
set -euo pipefail
cd "$(dirname "$0")"
GO_BIN="${GO_BIN:-go}"
command -v "$GO_BIN" >/dev/null || { echo "go MISSING（可设 GO_BIN=/path/to/go）"; exit 127; }
# ⚠ 本机默认 go-build 缓存目录可能被 ACL 拒绝（实测 `mkdir ... Access is denied`）。
# 缓存目录交给 Go 自带默认值（go env GOCACHE），脚本里**不写死任何本机路径**；
# 若默认目录不可写，由调用方显式 `GOCACHE=<可写目录> ./build.sh` 覆盖。
export GOCACHE="${GOCACHE:-$("$GO_BIN" env GOCACHE)}"
mkdir -p "$GOCACHE" 2>/dev/null || true

echo "== go vet =="
"$GO_BIN" vet ./...
echo "== go test =="
"$GO_BIN" test ./... -v
echo "== go test -bench（L3 占比基准）=="
"$GO_BIN" test ./... -run '^$' -bench BenchmarkQueueDecision -benchtime 2000x -benchmem
echo "== go build（产出可选 bin）=="
mkdir -p ../bin
"$GO_BIN" build -o ../bin/comfy-scheduler.exe .
echo "OK: ../bin/comfy-scheduler.exe"
