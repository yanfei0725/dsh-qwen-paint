"""
验证：在 ("single_block", i) 的 patch_replace 里包 attn_fn，
      attn_fn 收到的 q/k/v 是什么形状？rope 加了没？
      attn_fn 返回值的形状要求是什么？

思路：不跑真模型，直接读源码推 + 单元验证 _gated_residual 的约束。

关键源码（comfy/ldm/qwen_image21/model.py）：

  Attention.forward (L82-108):
      B, N, _ = x.shape
      q = self.to_q(x).view(B, N, self.heads, -1)      # (B, N, H, D)
      k = self.to_k(x).view(B, N, self.heads, -1)
      v = self.to_v(x).view(B, N, self.heads, -1)
      patches = ... attn1_patch ...
      if in_training or patches:
          q, k = norm_q(q), norm_k(k)
          if patches:
              q,k,v,pe = transpose(1,2)   -> (B,H,N,D)
              ... 调 attn1_patch ...
              q,k,v,pe = transpose(1,2)   -> (B,N,H,D)
          q = apply_rope1(q, pe)          # ← rope 在这一步加
          k = apply_rope1(k, pe)
      else:
          q, k = ck.rms_rope(q, k, pe, ...)   # ← 另一条路，也在这一步加 rope
      q,k,v = AttentionTensorContainer(q/k/v)
      return self.to_out[0](attn_fn(q, k, v, self.heads, ...))

  block_causal_attention (L197-213):
      def attn(q, k, v, heads, preferred_attention=None):
          q, k, v = q.take(), k.take(), v.take()     # (B, N, H, D)
          ...
          for i,(start,end,mask) in enumerate(segments):
              query = q[:, start:end].flatten(2)     # (B, end-start, H*D)
              key   = k[:, :end].flatten(2)
              value = v[:, :end].flatten(2)
              outs.append(optimized_attention(query,key,value,heads,mask=...))
          return cat(outs, dim=1)                    # (B, N, H*D)

  _gated_residual (L128-133):
      x[:, prefix_len:].addcmul_(y[:, prefix_len:], g_target)
      → y 的行数必须 == x 的行数 == N
      ⚠ 注意 y 是 attn 的**返回值**，即 to_out[0](attn_fn(...))
        to_out 是 Linear，不改行数
      → 所以 attn_fn 必须返回 (B, N, H*D)，行数 N

  ★ 结论：
    - attn_fn 收到 (B, N, H, D)，rope **已加**
    - attn_fn 必须返回 (B, N, H*D)，行数必须 == 输入 N
    - segments 的 start/end 是**原始**索引，所以 q/k/v 进 attn_fn 时必须是原始 N
    - ⇒ 合并/反合并必须**都发生在 attn_fn 内部**，外部行数不变

这就是为什么 attn1_patch 那条路死掉：attn1_patch 在 rope **之前**、
在 segments 切片**之前**改了 N，外部没人反合并。
"""

import sys, os

def main():
    print("=== 契约总结（读源码得出，非推测） ===")
    print()
    print("attn_fn 入口:  q,k,v = (B, N, H, D)   <- rope 已加, N = 原始序列长")
    print("attn_fn 出口:  (B, N, H*D)            <- 行数必须严格 = N")
    print("_gated_residual: x[:, prefix_len:] += y[:, prefix_len:] * g")
    print("               => y.shape[1] 必须 == x.shape[1]")
    print()
    print("ToMe 正确插入点: attn_fn 内部")
    print("  q(orig N) -> [切 target 段] -> merge -> attention -> unmerge -> 拼回 prefix")
    print("  => 出口行数 = N  ✅")
    print()
    print("ToMe 错误插入点(已实测失败): attn1_patch")
    print("  attn1_patch 在 rope 前改小 N -> apply_rope1 报错 / 无 attn1_output_patch 反合并")
    print()

    # 用数值验证 unmerge 的语义：merge 后 unmerge 能否还原形状
    print("=== 数值验证：merge -> attention -> unmerge 的尺寸守恒 ===")
    import torch
    torch.manual_seed(0)

    B, N, P, H, D = 1, 2063, 1039, 32, 128
    n_target = N - P
    print(f"B={B} N={N} prefix_len={P} n_target={n_target} H={H} D={D}")

    x = torch.randn(B, N, H, D)
    # 模拟 segments：prefix 一段 + target 一段
    seg_prefix = (0, P, None)
    seg_target = (P, N, None)

    q, k, v = x.clone(), x.clone(), x.clone()

    # --- 原始 attn（无 ToMe）---
    def plain_attn(q, k, v):
        outs = []
        for (s, e, m) in (seg_prefix, seg_target):
            query = q[:, s:e].flatten(2)
            key = k[:, :e].flatten(2)
            value = v[:, :e].flatten(2)
            # 用简化 attention 代替 optimized_attention
            scale = (query.shape[-1]) ** -0.5
            att = (query @ key.transpose(1, 2)) * scale
            outs.append(att.softmax(-1) @ value)
        return torch.cat(outs, dim=1)

    out_plain = plain_attn(q, k, v)
    print(f"无 ToMe 输出: {tuple(out_plain.shape)}  行数==N? {out_plain.shape[1] == N}")

    # --- ToMe attn：只合并 target 段 ---
    ratio = 0.5
    r = int(n_target * ratio // 2)  # 合并对数
    n_keep = n_target - r
    print(f"ratio={ratio} -> 合并 {r} 对, target {n_target} -> {n_keep}")

    def tome_attn(q, k, v):
        # prefix 段原样
        qp, kp, vp = q[:, :P], k[:, :P], v[:, :P]
        qt, kt, vt = q[:, P:], k[:, P:], v[:, P:]
        # 简化 merge：相邻两行取平均
        def merge(x):
            a = x[:, 0::2]
            b = x[:, 1::2]
            m = (a + b) / 2
            # 余数行直接留在后面
            if x.shape[1] % 2:
                m = torch.cat([m, x[:, -1:]], dim=1)
            return m
        def unmerge(x, orig_len):
            # 逆操作：把合并行复制回两行（近似重建）
            pair = x.repeat_interleave(2, dim=1)
            return pair[:, :orig_len]
        qm, km, vm = merge(qt), merge(kt), merge(vt)
        nm = qm.shape[1]
        # 合并段自注意力
        query = qm.flatten(2)
        key = km.flatten(2)
        value = vm.flatten(2)
        scale = query.shape[-1] ** -0.5
        att = (query @ key.transpose(1, 2)) * scale
        o = att.softmax(-1) @ value
        o = unmerge(o, n_target)
        # 拼回 prefix
        # prefix 段仍要算注意力（可以看到 target 的合并版，这里简化：prefix 只用 prefix）
        oq = qp.flatten(2)
        ok = kp.flatten(2)
        ov = vp.flatten(2)
        scale2 = oq.shape[-1] ** -0.5
        a2 = (oq @ ok.transpose(1, 2)) * scale2
        op = a2.softmax(-1) @ ov
        return torch.cat([op, o], dim=1)

    out_tome = tome_attn(q, k, v)
    print(f"ToMe 输出 : {tuple(out_tome.shape)}  行数==N? {out_tome.shape[1] == N}")
    assert out_tome.shape[1] == N, "★ 行数不守恒，_gated_residual 会炸"

    # 误差度量
    mse = ((out_plain - out_tome) ** 2).mean().item()
    denom = (out_plain ** 2).mean().item()
    print(f"相对 MSE: {mse / denom:.4f}  （仅示意，真实质量要看出图）")
    print()
    print("=== 尺寸守恒验证通过 ===")
    print()
    print("结论：方案可行。ToMe 应实现在 attn_fn 包装层，而不是 attn1_patch。")


if __name__ == "__main__":
    main()
