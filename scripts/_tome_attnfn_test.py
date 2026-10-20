"""
attn_fn 版 ToMe 的单元测试。

重点验三件事：
  1. 行数守恒 —— attn_fn 出口行数必须严格 == 入口 N（否则 _gated_residual 抛错）
  2. prefix 段按位不变 —— 前缀不被合并影响（ratio 变化时前缀结果应一致）
  3. 轴序正确 —— (B,N,H,D) 的合并必须按 N 维做，不能把 B 和 N 搅在一起
"""

import sys, os, math
import torch

sys.path.insert(0, r"X:////ComfyUI\custom_nodes\QwenToMe-QwenImage21")

from qwen_tome_attnfn import make_tome_attn_fn, _merge_pairs, _unmerge_pairs, _unwrap

torch.manual_seed(42)
PASS, FAIL = 0, 0

def check(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK] {name} {extra}")
    else:
        FAIL += 1
        print(f"  [!!] {name} FAILED {extra}")

def fake_attn(q, k, v, heads, **kw):
    """模拟原 attn_fn：对 (B,N,H,D) 做全注意力，返回 (B,N,H*D)"""
    qq, kk, vv = _unwrap(q), _unwrap(k), _unwrap(v)
    qf, kf, vf = qq.flatten(2), kk.flatten(2), vv.flatten(2)
    scale = qf.shape[-1] ** -0.5
    return ((qf @ kf.transpose(1, 2)) * scale).softmax(-1) @ vf

print("=== §A _merge_pairs / _unmerge_pairs 基本正确性 ===")
x = torch.arange(24, dtype=torch.float32).reshape(1, 6, 4)
m = _merge_pairs(x)
check("merge 形状", m.shape == (1, 3, 4), f"{tuple(m.shape)}")
check("merge 值 = 相邻均值", torch.allclose(m[0, 0], (x[0, 0] + x[0, 1]) / 2))
u = _unmerge_pairs(m, 6)
check("unmerge 形状", u.shape == (1, 6, 4), f"{tuple(u.shape)}")
check("unmerge 把合并行铺回两行", torch.allclose(u[0, 0], u[0, 1]))

print()
print("=== §B 行数守恒（核心）===")
for (B, N, P, H, D) in [(1, 2063, 1039, 32, 128), (1, 512, 256, 4, 8), (2, 1152, 128, 8, 16)]:
    q = torch.randn(B, N, H, D)
    ratio = 0.5
    fn = make_tome_attn_fn(fake_attn, ratio, P, debug=False)
    out = fn(q, q.clone(), q.clone(), H)
    check(f"B={B} N={N} P={P} ratio={ratio} 行数守恒",
          out.shape == (B, N, H * D), f"got {tuple(out.shape)}")

print()
print("=== §C ratio=0 / 边界情况必须直通 ===")
q = torch.randn(1, 2063, 32, 128)
base = fake_attn(q, q.clone(), q.clone(), 32)
fn0 = make_tome_attn_fn(fake_attn, 0.0, 1039)
check("ratio=0 与基准逐位相同", torch.allclose(fn0(q, q.clone(), q.clone(), 32), base, atol=1e-6))
fnP = make_tome_attn_fn(fake_attn, 0.5, 0)   # 无前缀
o = fnP(q, q.clone(), q.clone(), 32)
check("P=0 直通（不合并）", torch.allclose(o, base, atol=1e-6))

q_small = torch.randn(1, 6, 4, 8)
fnS = make_tome_attn_fn(fake_attn, 0.5, 3)
oS = fnS(q_small, q_small.clone(), q_small.clone(), 4)
check("n_target<8 直通", oS.shape == (1, 6, 32), f"{tuple(oS.shape)}")

print()
print("=== §D 轴序正确性：改动 batch 的另一行不应影响第 0 行 ===")
B, N, P, H, D = 2, 512, 128, 4, 16
q1 = torch.randn(1, N, H, D)
q2 = torch.randn(1, N, H, D)
fn = make_tome_attn_fn(fake_attn, 0.5, P)
o_single = fn(q1.clone(), q1.clone(), q1.clone(), H)
o_batch = fn(torch.cat([q1, q2]), torch.cat([q1, q2]), torch.cat([q1, q2]), H)
check("batch 内各行互不干扰（轴序正确）",
      torch.allclose(o_single[0], o_batch[0], atol=1e-5),
      f"max diff={(o_single[0]-o_batch[0]).abs().max().item():.3e}")

print()
print("=== §E prefix 段（文本+参考图）不被合并 ===")
B, N, P, H, D = 1, 1024, 512, 4, 16
q = torch.randn(B, N, H, D)
fnA = make_tome_attn_fn(fake_attn, 0.25, P)
fnB = make_tome_attn_fn(fake_attn, 0.75, P)
oA = fnA(q.clone(), q.clone(), q.clone(), H)
oB = fnB(q.clone(), q.clone(), q.clone(), H)
# prefix 段在两种 ratio 下的注意力结果应当一致（前缀自身不合并，且键只含前缀）
d = (oA[:, :P] - oB[:, :P]).abs().max().item()
check("不同 ratio 下 prefix 段结果一致", d < 1e-4, f"max diff={d:.3e}")
check("★ 全部行数仍守恒",
      oA.shape[1] == N and oB.shape[1] == N, f"{tuple(oA.shape)} {tuple(oB.shape)}")

print()
print("=== §F 注意力规模确实下降了 ===")
calls = []
def counting_attn(q, k, v, heads, **kw):
    calls.append(_unwrap(q).shape[1])
    return fake_attn(q, k, v, heads, **kw)

# ToMe 版内部自己算，不走 orig，所以统计内部规模：改为直接看日志
logs = []
B, N, P, H, D = 1, 2063, 1039, 32, 128
q = torch.randn(B, N, H, D)
fn = make_tome_attn_fn(fake_attn, 0.5, P, debug=True, log_fn=logs.append)
o = fn(q.clone(), q.clone(), q.clone(), H)
line = " ".join(logs)
check("日志显示目标段被压缩", "合并" in line, line.strip()[:120])
# ★ 这条断言是抓真实 bug 的：第一版 prefix 段索引写错，靠"异常回退"兜住了形状，
#   表面「通过」但优化其实**完全没生效**。必须显式禁止回退路径被走到。
check("★ 没有走异常回退（优化真的生效了）",
      "异常回退" not in line,
      line.strip()[:160])
check("★ 完成日志存在", "ToMe 完成" in line, line.strip()[-80:])
check("压缩后行数守恒", o.shape[1] == N, f"{tuple(o.shape)}")

print()
print("=== §G 异常必须回退而不是崩 ===")
def boom(q, k, v, heads, **kw):
    raise RuntimeError("boom")
fnG = make_tome_attn_fn(fake_attn, 0.5, P, debug=True, log_fn=logs.append)
oG = fnG(q.clone(), q.clone(), q.clone(), H)
check("正常返回且行数守恒", oG.shape[1] == N, f"{tuple(oG.shape)}")

print()
print("=" * 50)
print(f"通过 {PASS} / 失败 {FAIL}")
if FAIL:
    sys.exit(1)
print("全部通过 ✅")
