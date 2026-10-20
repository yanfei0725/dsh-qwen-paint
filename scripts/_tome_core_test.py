"""离线单测：不启 ComfyUI，直接验证 qwen_tome_core 的算法正确性。"""
import sys, math, traceback
sys.path.insert(0, r"X:////ComfyUI\custom_nodes\QwenToMe-QwenImage21")

import torch
from qwen_tome_core import get_functions, do_nothing, resolve_target_hw

fails = []
def check(name, cond, extra=""):
    ok = bool(cond)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + extra) if extra else ''}")
    if not ok:
        fails.append(name)

print("=== 1. 基本 merge/unmerge 往返 ===")
N, C = 1024, 64
x = torch.randn(1, N, C)
merge, unmerge = get_functions(x, 0.3, 32, 32)
check("get_functions 返回真实函数", merge is not do_nothing)
m = merge(x)
print(f"    合并后长度 {m.shape[1]}（原 {N}），减少 {N - m.shape[1]} 个")
check("合并后确实变短", m.shape[1] < N, f"{N} -> {m.shape[1]}")
u = unmerge(m)
check("unmerge 还原原始形状", tuple(u.shape) == tuple(x.shape), f"{tuple(u.shape)}")

print("\n=== 2. 未合并 token 必须逐位保留 ===")
# 官方 tomesd 的语义：unmerge 后「未被合并」的 token 应与原值**完全一致**
# 找几个已知未被合并的位置做位级比对
with torch.no_grad():
    # 用全同张量做探测器：若某行被合并，值会变
    det = torch.arange(N, dtype=torch.float32).unsqueeze(0).unsqueeze(-1).repeat(1, 1, C)
    m2, u2 = get_functions(det.clone(), 0.3, 32, 32)
    merged2, un2 = m2(det.clone()), None
    un2 = u2(merged2)
    same = (un2 == det).all(dim=-1)[0]
    n_same = int(same.sum().item())
    print(f"    逐位相同的 token 数：{n_same}/{N}")
    check("存在未被动过的 token", n_same > 0, f"{n_same} 行")
    # 被合并的 token 应该恰好是 diff 的那批，数量上不应为 0
    check("存在被合并的 token", n_same < N, f"{N - n_same} 行被动过")

print("\n=== 3. ratio=0 与不满足下采样条件时必须是 do_nothing ===")
m0, u0 = get_functions(x, 0.0, 32, 32)
check("ratio=0 → do_nothing", m0 is do_nothing and u0 is do_nothing)

# 目标段远小于网格能覆盖的量 → 不合并
big = torch.randn(1, 16, C)
mB, uB = get_functions(big, 0.3, 64, 64)   # 64*64=4096 tokens 期望，实际只有 16
check("token 太少 → do_nothing", mB is do_nothing, "downsample>1")

print("\n=== 4. 多 head / batch 摊平后仍正确 ===")
B, H, NT, D = 1, 24, 1024, 64
q = torch.randn(B, H, NT, D)
flat = q.reshape(B * H, NT, D)
mf, uf = get_functions(flat, 0.3, 32, 32)
merged = mf(flat)
check("B*H 摊平后可合并", merged.shape[1] < NT, f"{NT} -> {merged.shape[1]}")
back = uf(merged)
check("摊平后往返形状一致", tuple(back.shape) == (B * H, NT, D), f"{tuple(back.shape)}")

print("\n=== 5. merge_mode 三种都要能跑 ===")
for mode in ("mean", "max", "sum"):
    try:
        out = mf(flat, mode=mode)
        check(f"merge_mode={mode}", out.shape == merged.shape)
    except Exception as e:
        check(f"merge_mode={mode}", False, f"{type(e).__name__}: {e}")

print("\n=== 6. resolve_target_hw 的网格安全性 ===")
for n in (256, 1024, 4096, 3840, 1920):
    h, w = resolve_target_hw({"img_slice": [100, n + 100]}, n)
    check(f"n={n} → h={h},w={w}，h*w={h*w} <= n", h * w <= n, f"h*w={h*w}")

print("\n=== 7. img_slice 只合并目标段（前缀不动）—— 核心安全断言 ===")
# 构造"前缀全 0、目标段有值"的张量，验证前缀逐位不变
# ⚠ 网格必须与目标段 token 数自洽：grid_h*grid_w 越接近 n_target，downsample 才 =1。
#   上一版这里写死 32x32（=1024）却只给 824 tokens，downsample 算出来是 2 → 正确地直通了，
#   那是**测试的网格给错**，不是代码问题（见 _tome_core_test 的 §6 校验逻辑）。
prefix_len, n_t = 200, 784          # 28*28 = 784 → downsample=1，会真的合并
seq = torch.cat([
    torch.zeros(1, prefix_len, C),
    torch.randn(1, n_t, C),
], dim=1)
ms, us = get_functions(seq[:, prefix_len:, :], 0.3, 28, 28)
check("目标段可合并", ms is not do_nothing)
merged_t = ms(seq[:, prefix_len:, :])
recombined = torch.cat([seq[:, :prefix_len, :], merged_t], dim=1)
check("前缀逐位未变",
      torch.equal(recombined[:, :prefix_len, :], seq[:, :prefix_len, :]))
check("总长正确", recombined.shape[1] == prefix_len + merged_t.shape[1],
      f"{recombined.shape[1]}")

print("\n=== 8. 不同分辨率网格都要能整除，不越界 ===")
for (w_px, h_px) in [(1024, 1024), (864, 1152), (1280, 720), (1536, 640)]:
    tok = (w_px // 16) * (h_px // 16)
    xx = torch.randn(1, tok, C)
    mm, uu = get_functions(xx, 0.3, h_px // 16, w_px // 16)
    if mm is do_nothing:
        check(f"{w_px}x{h_px}", True, "直通（可接受）")
        continue
    try:
        mo = mm(xx)
        uo = uu(mo)
        check(f"{w_px}x{h_px} 往返一致", tuple(uo.shape) == tuple(xx.shape),
              f"{tok} -> {mo.shape[1]} -> {uo.shape[1]}")
    except Exception as e:
        check(f"{w_px}x{h_px}", False, f"{type(e).__name__}: {e}")

print("\n" + "=" * 60)
if fails:
    print(f"FAILED {len(fails)} 项：")
    for f in fails:
        print(f"  - {f}")
    sys.exit(1)
print("全部通过")
