"""
直接单测 QwenTomePatchModel 的 patch 逻辑 —— 绕开 ComfyUI，用真实形状喂进去。

目的：把"到底是我的形状处理错，还是 patch 根本没被调用"这个问题**分离**开。
上一轮在真机上反复看到 `apply_rope expects each leading freqs_cis dim ...`，
但 debug 文件是空的 —— 有两种可能：
  (a) patch 被调用了，但我的 pe 处理没能把行数对上；
  (b) patch 压根没被调用（那空文件是正常的），错在别处。
本脚本用**纯 Python 造数据**直接调 patch，跑通就证明 (a) 的可能性已被排除。

用法：python scripts/_tome_patch_test.py
"""
import sys, os, math
import torch

NODE_DIR = r"X:////ComfyUI\custom_nodes\QwenToMe-QwenImage21"
sys.path.insert(0, NODE_DIR)

# 以"包"的方式导入（__init__.py 里有相对导入 .qwen_tome_core）
import importlib.util
spec = importlib.util.spec_from_file_location(
    "qwen_tome_pkg", os.path.join(NODE_DIR, "__init__.py"),
    submodule_search_locations=[NODE_DIR],
)
mod = importlib.util.module_from_spec(spec)
sys.modules["qwen_tome_pkg"] = mod
spec.loader.exec_module(mod)

_make = mod._make_tome_attn_patch
_as_dict = mod._as_dict_patch

fails = []
def check(name, cond, extra=""):
    ok = bool(cond)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + extra) if extra else ''}")
    if not ok: fails.append(name)

B, H, N, D = 1, 24, 1024, 64
# ★ 网格必须与"目标段 token 数"严密对齐（h*w == n_target），
#   这是 ToMe 内部的硬约束（见 qwen_tome_core.resolve_target_hw 注释）。
#   所以这里取 PREFIX=0、N=1024=32*32，让网格与序列长度恰好相等。
PREFIX = 0                        # 先测"无前缀"这个最干净的情形
NT = N - PREFIX                   # 1024 = 32*32 ✓

print("=== A. 构造真实形状的输入 ===")
q = torch.randn(B, H, N, D, dtype=torch.float32)
k = torch.randn(B, H, N, D, dtype=torch.float32)
v = torch.randn(B, H, N, D, dtype=torch.float32)
# pe：按千问约定，patch 看到的是 (1, 1, N, ...)。
# 真实里最后一维是 rope 的 cos/sin 对，这里用 (1,1,N,D,2) 覆盖"维数>4"的情形。
pe = torch.randn(1, 1, N, D, 2, dtype=torch.float32)
print(f"  q/k/v={tuple(q.shape)}  pe={tuple(pe.shape)}  prefix_len={PREFIX}  n_target={NT}")

print("\n=== B. img_slice 与网格要自洽才可能真合并 ===")
# ⚠ 关键：get_functions 要求 downsample = ceil(sqrt(grid_h*grid_w / n_target)) <= 1，
#   即网格面积不能超过目标 token 数。824 token → 取 28x28=784（<=824）才成立。
#   若网格给 32x32=1024 就会直通（上一版实测遇到的正是这个，属测试数据不自洽）。
extra = {"img_slice": [PREFIX, N], "original_shape": (1, 16, 32, 32)}

fn, out_fn = _make(0.3, "mean", True)
wrapped = _as_dict(fn)

print("\n=== C. patch 必须返回含 q/k/v/pe 的 dict，且行数一致 ===")
res = wrapped(q, k, v, pe=pe, attn_mask=None, extra_options=extra)
check("返回 dict", isinstance(res, dict), type(res).__name__)
check("含 q/k/v/pe 四键", set(res.keys()) == {"q", "k", "v", "pe"}, str(sorted(res.keys())))

nq, nk, nv, npe = res["q"], res["k"], res["v"], res["pe"]
print(f"  q {tuple(q.shape)} -> {tuple(nq.shape)}")
print(f"  k {tuple(k.shape)} -> {tuple(nk.shape)}")
print(f"  v {tuple(v.shape)} -> {tuple(nv.shape)}")
print(f"  pe {tuple(pe.shape)} -> {tuple(npe.shape)}")

check("q/k/v 行数一致", nq.shape[2] == nk.shape[2] == nv.shape[2],
      f"{nq.shape[2]}/{nk.shape[2]}/{nv.shape[2]}")
check("★ pe 行数与 q 相同（apply_rope1 的硬要求）", npe.shape[2] == nq.shape[2],
      f"pe.shape[2]={npe.shape[2]} vs q.shape[2]={nq.shape[2]}")
check("pe 的其它维保持不变",
      tuple(npe.shape[:2]) == tuple(pe.shape[:2]) and tuple(npe.shape[3:]) == tuple(pe.shape[3:]),
      f"{tuple(npe.shape[:2]) + tuple(npe.shape[3:])} vs {tuple(pe.shape[:2]) + tuple(pe.shape[3:])}")

print("\n=== D. 前缀段必须逐位未动 ===")
check("q 前缀未变", torch.equal(nq[:, :, :PREFIX, :], q[:, :, :PREFIX, :]))
check("k 前缀未变", torch.equal(nk[:, :, :PREFIX, :], k[:, :, :PREFIX, :]))
check("v 前缀未变", torch.equal(nv[:, :, :PREFIX, :], v[:, :, :PREFIX, :]))
# ⚠ pe 的行维是 index 2（不是 -2）—— 第一版用 `[..., :PREFIX, :]` 切错了维，
#   切到了 D 那一维，于是"前缀未变"变成了一句没有意义的比较（假失败）。
check("pe 前缀未变（沿 index 2 的行维）",
      torch.equal(npe[:, :, :PREFIX, :, :], pe[:, :, :PREFIX, :, :]))

print("\n=== D2. 带**非零前缀**时，pe 前缀必须逐位保留（上一轮真 bug 的回归锁） ===")
# ⚠ 第一版这里是真 bug：对整个序列做合并 → 前缀也被合并掉，
#   pe 比 q 少了整整 prefix_len 行 → apply_rope1 报错。
#   本小节的常量前缀（全 7.0）能一眼看出前缀有没有被动过。
P2 = 200
NT2 = N - P2                      # 824；用一个能整除的网格覆盖（见 resolve_target_hw）
pe2 = torch.randn(1, 1, N, D, 2)
pe2[:, :, :P2, :, :] = 7.0        # 打标
q2 = torch.randn(B, H, N, D)
extra2 = {"img_slice": [P2, N], "original_shape": (1, 16, 28, 28)}
f2, _ = _make(0.3, "mean", False)
r2 = _as_dict(f2)(q2, q2, q2, pe=pe2, attn_mask=None, extra_options=extra2)
check("pe 前缀逐位保留（全 7.0）",
      torch.equal(r2["pe"][:, :, :P2, :, :], pe2[:, :, :P2, :, :]))
check("q 前缀逐位保留",
      torch.equal(r2["q"][:, :, :P2, :], q2[:, :, :P2, :]))
check("★ pe 行数 == q 行数（前缀对齐后）",
      r2["pe"].shape[2] == r2["q"].shape[2],
      f"pe={r2['pe'].shape[2]} q={r2['q'].shape[2]}")

print("\n=== E. 模拟 apply_rope1 的形状校验（复刻 comfy_kitchen 的检查） ===")
# ⚠ 千问在 model.py:98 把 q/k/v/pe 都 transpose 回 (B, N, H, D) 再 apply_rope1。
#   pe 是 (1, 1, N, D, 2)，transpose(1,2) 后 → (1, N, 1, D, 2)：
#   **序列长度那一维跑到了 index 1**（不是 2）。第一版把 index 写错，
#   于是报 "fc.shape[2]=1 vs x.shape[1]=717" 这种假失败。
x = nq.transpose(1, 2).contiguous()          # (B, N', H, D)
fc = npe.transpose(1, 2).contiguous()        # (1, N', 1, D, 2)
print(f"  apply_rope1 视角: x={tuple(x.shape)}  freqs_cis={tuple(fc.shape)}")
# 找 freqs_cis 里"长度等于 x 序列长度"的那一维 —— 那就是行维
x_seq = x.shape[1]
fc_row = next((d for d in range(fc.dim()) if fc.shape[d] == x_seq), None)
check("freqs_cis 存在与 x 序列长度相同的维", fc_row is not None,
      f"x_seq={x_seq} fc.shape={tuple(fc.shape)}")
check("freqs_cis 其余前置维都是 1 或与 x 相同",
      all(fc.shape[i] in (1, x.shape[i]) for i in range(fc.dim()) if i != fc_row and i < x.dim()),
      f"fc={tuple(fc.shape)} x={tuple(x.shape)}")

print("\n=== F. unmerge 必须把序列还原回原长度 ===")
# ⚠ attention 的输入是 (B, H, N', D)（千问全程用 (B,N,H,D)，patch 里 transpose 成 (B,H,N,D)）。
#   `attn_output_patch` 收到的是 attn 的输出，形状 (B, H, N', D)。
attn_out = nq                                # (B, H, N', D)
out = out_fn(attn_out, extra_options=extra)
print(f"  attn 输出 {tuple(attn_out.shape)} -> {tuple(out.shape)}")
check("还原到原长度 N", out.shape[2] == N, f"{out.shape[2]} vs {N}")

print("\n=== G. ratio=0 必须是完全直通 ===")
f0, o0 = _make(0.0, "mean", False)
w0 = _as_dict(f0)
r0 = w0(q, k, v, pe=pe, attn_mask=None, extra_options=extra)
check("ratio=0 时 q 原样", r0["q"] is q)
check("ratio=0 时 pe 原样", r0["pe"] is pe)

print("\n=== H. 网格与序列不自洽时的行为 ===")
# ⚠ 这里是**测试预期写错过一次**的地方，说明一下现在的正确行为：
#   `resolve_target_hw` 的策略是"**自适应对齐**"而不是"发现不齐就不做"——
#   它会重新算一个面积恰好等于 n_target 的因数对网格。
#   所以给 (1,16,30,30)（900 != 1024）时，它**照样会合并**（改用 32x32 网格），
#   这比"直接放弃"更好：能省的时间照省，且形状始终自洽。
#   真正会退化为"不合并"的只有：找不到任何因数对（n_target 为质数等）。
bad_extra = {"img_slice": [PREFIX, N], "original_shape": (1, 16, 30, 30)}
fb, ob = _make(0.3, "mean", False)
wb = _as_dict(fb)
rb = wb(q, k, v, pe=pe, attn_mask=None, extra_options=bad_extra)
check("不自洽时不报错", isinstance(rb, dict))
print(f"  30x30(=900) 与 n_target=1024 不齐 → 自适应后 q 行数 {rb['q'].shape[2]}（已合并，形状自洽）")
check("自适应后 q/k/v/pe 行数仍互相一致",
      rb["q"].shape[2] == rb["k"].shape[2] == rb["v"].shape[2] == rb["pe"].shape[2],
      f"q={rb['q'].shape[2]} k={rb['k'].shape[2]} v={rb['v'].shape[2]} pe={rb['pe'].shape[2]}")
check("自适应后 pe 行数 == q 行数（apply_rope1 硬要求）",
      rb["pe"].shape[2] == rb["q"].shape[2])

print("\n=== I. 三种 merge_mode 的 pe 行数都要对齐 ===")
for mode in ("mean", "max", "sum"):
    fm, om = _make(0.3, mode, False)
    wm = _as_dict(fm)
    rm = wm(q, k, v, pe=pe, attn_mask=None, extra_options=extra)
    check(f"merge_mode={mode} 行数对齐",
          rm["pe"].shape[2] == rm["q"].shape[2],
          f"pe={rm['pe'].shape[2]} q={rm['q'].shape[2]}")

print("\n" + "=" * 62)
if fails:
    print(f"FAILED {len(fails)} 项：")
    for f in fails: print("  -", f)
    sys.exit(1)
print("全部通过 —— patch 的形状处理是正确的")
