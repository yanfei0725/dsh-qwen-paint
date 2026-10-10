"""
耗时取证：把 ComfyUI 日志按"一次出图"切段，把时间拆成
   采样时间（进度条）  vs  非采样开销（模型装卸、VAE、编码、排队）
"""
import io
import os
import re
import sys

# ★ 路径一律**运行时解析**，不写死任何用户目录 ——
#   打包脚本的隐私检查会扫出 `C:\Users\<用户名>\...` 并拦下整个 zip。
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LOG = os.path.join(os.path.dirname(HERE), "..", "ComfyUI-rocm", "ComfyUI", ".dshqp-launch.log")

LOG = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DSHQP_COMFY_LOG", DEFAULT_LOG)
OUT = os.path.join(HERE, "_timing_forensics.txt")

if not os.path.exists(LOG):
    print("日志文件不存在：", LOG)
    print("用法：python _timing_forensics.py [ComfyUI日志路径]")
    print("   或设环境变量 DSHQP_COMFY_LOG=<路径>")
    sys.exit(1)

raw = io.open(LOG, "r", encoding="utf-8", errors="replace").read()

# ★ 日志里有 ANSI 颜色码（\x1b[32m[INFO]\x1b[0m），不剥掉的话
#   "\[INFO\] got prompt" 这类正则全部落空（我第一次就栽在这，报"没找到"）。
ANSI = re.compile(r"\x1b\[[0-9;]*m")
raw = ANSI.sub("", raw)

# ★ 分段基准用 **"Prompt executed"**，不是 "got prompt"。
#   原因：一次 API 提交可能触发多次执行（实测日志里有"一个 got prompt 后面跟着
#   两次 Prompt executed"的情况），按 got prompt 分会**整段漏掉**一笔 ——
#   我第一版就漏了 23.00 s 那笔（恰恰是最快的一笔，最能说明问题）。
#   做法：每次 "Prompt executed" 为一笔，段 = 上一次 executed（没有就用最近的
#   got prompt / 文件头）到本次 executed。
exec_marks = [(m.start(), m.end(), float(m.group(1)))
              for m in re.finditer(r"Prompt executed in ([\d.]+) seconds", raw)]
got_marks = [m.start() for m in re.finditer(r"\[INFO\] got prompt", raw)]
if not exec_marks:
    print("没找到 Prompt executed")
    sys.exit(1)

segments = []
prev_end = 0
for pos, end, _ in exec_marks:
    # 段起点：本次之前最近的 got prompt（但不得早于上一笔的结束）
    starts = [g for g in got_marks if g < pos and g >= prev_end]
    s = max(starts) if starts else prev_end
    # ★ 段必须**包含** "Prompt executed" 这一行本身（end 而不是 pos），
    #   否则段内正则找不到总耗时 —— 我第二版就切成了 raw[s:pos]，6 笔全变 -1。
    segments.append(raw[s:end])
    prev_end = end

rows = []
for idx, seg in enumerate(segments, 1):
    # 采样进度条：取最后一个 "N/N [MM:SS<..." 的时间
    bars = re.findall(r"(\d+)/(\d+)\s*\[(\d+):(\d+)<", seg)
    sample_s = 0.0
    steps = 0
    if bars:
        d, tot, mm, ss = bars[-1]
        sample_s = int(mm) * 60 + int(ss)
        steps = int(tot)

    # Prompt executed in X seconds
    m = re.search(r"Prompt executed in ([\d.]+) seconds", seg)
    total_s = float(m.group(1)) if m else None

    # 模型加载：Requested to load / loaded completely；取最大的那次和总加载量
    loads = re.findall(r"loaded completely;\s*([\d.]+) MB", seg)
    load_mb = sum(float(x) for x in loads)
    load_count = len(loads)

    # 卸载
    unloads = re.findall(r"Unloaded partially:\s*([\d.]+) MB freed", seg)
    unload_mb = sum(float(x) for x in unloads)

    # lowvram patches（>0 说明发生了分块换入换出）
    patches = re.findall(r"lowvram patches:\s*(\d+)", seg)
    patch_max = max((int(x) for x in patches), default=0)

    # TE / Speedup 加速效果
    te = re.search(r"Qwen TE predictor: predicted (\d+)/(\d+) steps \(([\d.]+)% model-call acceleration\)", seg)
    sp = re.search(r"QwenImage21Speedup: (\d+) cached of (\d+) model forwards \(([\d.]+)% skipped\)", seg)

    overhead = (total_s - sample_s) if total_s is not None else None
    rows.append(dict(
        n=idx, steps=steps, sample=sample_s, total=total_s, overhead=overhead,
        load_mb=load_mb, load_n=load_count, unload_mb=unload_mb, patch=patch_max,
        te=te.group(3) if te else "-", sp=sp.group(3) if sp else "-",
    ))

lines = []
lines.append("=== ComfyUI 出图耗时取证 ===")
lines.append("")
hdr = f"{'#':>2} {'步':>3} {'采样s':>7} {'总s':>8} {'非采样s':>8} {'非采样%':>8} {'加载MB':>9} {'卸载MB':>9} {'lowvram':>8} {'TE%':>6} {'Speedup%':>9}"
lines.append(hdr)
lines.append("-" * len(hdr))
for r in rows:
    pct = (r["overhead"] / r["total"] * 100) if (r["total"] and r["overhead"] is not None) else 0
    lines.append(
        f"{r['n']:>2} {r['steps']:>3} {r['sample']:>7.1f} "
        f"{(r['total'] if r['total'] is not None else -1):>8.2f} "
        f"{(r['overhead'] if r['overhead'] is not None else -1):>8.2f} "
        f"{pct:>7.1f}% "
        f"{r['load_mb']:>9.0f} {r['unload_mb']:>9.0f} {r['patch']:>8} "
        f"{r['te']:>6} {r['sp']:>9}"
    )

lines.append("")
tot = [r for r in rows if r["total"] is not None]
if tot:
    avg_total = sum(r["total"] for r in tot) / len(tot)
    avg_sample = sum(r["sample"] for r in tot) / len(tot)
    avg_over = sum(r["overhead"] for r in tot) / len(tot)
    lines.append(f"样本数：{len(tot)}")
    lines.append(f"平均总耗时   ：{avg_total:.2f} s")
    lines.append(f"平均采样     ：{avg_sample:.2f} s（占 {avg_sample / avg_total * 100:.1f}%）")
    lines.append(f"平均非采样   ：{avg_over:.2f} s（占 {avg_over / avg_total * 100:.1f}%）  ←★ 大头在这")
    lines.append(f"最快一笔     ：{min(r['total'] for r in tot):.2f} s")
    lines.append(f"最慢一笔     ：{max(r['total'] for r in tot):.2f} s")
    lines.append("")
    lines.append("=== 单步耗时（同样 8 步，波动有多大）===")
    for r in rows:
        if r["steps"]:
            lines.append(f"  第{r['n']}笔：{r['steps']} 步 / {r['sample']:.1f} s = {r['sample'] / r['steps']:.2f} s/步")

io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")
print("\n".join(lines))
