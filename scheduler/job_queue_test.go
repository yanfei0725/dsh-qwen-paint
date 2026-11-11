package main

import (
	"math"
	"strconv"
	"testing"
)

// 报告 §10 验收：81 帧任务自动切成 2 块且拼接无黑帧（8 帧重叠）。
func TestPlanChunks(t *testing.T) {
	got := PlanChunks(81, 49, 8)
	if len(got) != 2 {
		t.Fatalf("81/49/8 应切 2 段，实得 %d: %+v", len(got), got)
	}
	if got[0].FrameCount != 49 || got[1].FrameCount != 40 {
		t.Fatalf("段长应为 49 + 40（重叠 8），实得 %+v", got)
	}
	if got[1].StartFrame != 41 {
		t.Fatalf("第二段应从第 41 帧起（stride=41），实得 %d", got[1].StartFrame)
	}
	if one := PlanChunks(25, 49, 8); len(one) != 1 || one[0].FrameCount != 25 {
		t.Fatalf("短片段不该切块，实得 %+v", one)
	}
	// 覆盖数与原始帧数一致（首尾相接，不丢帧）
	covered := got[len(got)-1].StartFrame + got[len(got)-1].FrameCount
	if covered != 81 {
		t.Fatalf("分块应覆盖全部 81 帧，实得 %d", covered)
	}
}

// 报告 §10 ①：同一 ComfyUI 实例上三类任务互斥串行。
func TestQueueMutualExclusion(t *testing.T) {
	q := NewQueue()
	if err := q.Submit(&Job{ID: "a", Stages: []Stage{StageImage}}); err != nil {
		t.Fatal(err)
	}
	if err := q.Submit(&Job{ID: "b", Stages: []Stage{StageVideo}}); err != nil {
		t.Fatal(err)
	}
	first, err := q.Next()
	if err != nil || first.ID != "a" {
		t.Fatalf("先出 a，实得 %+v err=%v", first, err)
	}
	if _, err := q.Next(); err != ErrQueueEmpty {
		t.Fatalf("已有任务在跑时第二个 Next 必须被互斥挡住，实得 %v", err)
	}
	if q.Pending() != 1 {
		t.Fatalf("b 应仍在排队，实得 pending=%d", q.Pending())
	}
	if err := q.Complete("a", &JobResult{ID: "a"}); err != nil {
		t.Fatal(err)
	}
	second, err := q.Next()
	if err != nil || second.ID != "b" {
		t.Fatalf("a 完成后应放行 b，实得 %+v err=%v", second, err)
	}
}

func TestDuplicateJobRejected(t *testing.T) {
	q := NewQueue()
	_ = q.Submit(&Job{ID: "x"})
	if err := q.Submit(&Job{ID: "x"}); err != ErrDuplicateJob {
		t.Fatalf("重复 id 应拒绝，实得 %v", err)
	}
}

func TestCancel(t *testing.T) {
	q := NewQueue()
	_ = q.Submit(&Job{ID: "run", Stages: []Stage{StageVideo}})
	_, _ = q.Next()
	if !q.Cancel("run") || !q.IsCanceled("run") {
		t.Fatal("running 任务应可取消")
	}
	_ = q.Submit(&Job{ID: "wait"})
	if !q.Cancel("wait") {
		t.Fatal("排队任务应可取消")
	}
	if q.Pending() != 0 {
		t.Fatal("取消的排队任务应出队")
	}
	if _, err := q.Next(); err != ErrQueueEmpty {
		t.Fatalf("被取消的任务不该被执行，实得 %v", err)
	}
}

// 报告 §9：混合三段权重 20% / 10% / 70%。
func TestProgressWeights(t *testing.T) {
	stages := []Stage{StageImage, StageTTS, StageVideo}
	cases := []struct {
		idx  int
		frac float64
		want float64
	}{
		{0, 0, 0.0}, {0, 1, 0.2},
		{1, 0, 0.2}, {1, 1, 0.3},
		{2, 0, 0.3}, {2, 0.5, 0.65}, {2, 1, 1.0},
		{3, 0, 1.0},
	}
	for _, c := range cases {
		// 0.2+0.1 在 float64 里是 0.30000000000000004，必须容差比较
		if got := Progress(stages, c.idx, c.frac); math.Abs(got-c.want) > 1e-9 {
			t.Fatalf("Progress(%d, %.1f)=%.12f, want %.12f", c.idx, c.frac, got, c.want)
		}
	}
}

// BenchmarkQueueDecision —— 给报告 §13.1「L3 占比 < 1%」一个可复测的数字。
// pct-of-L1 以本机实测 L1 采样 18.12 s/段（832x480 / 25 帧 / 4 步）为分母。
func BenchmarkQueueDecision(b *testing.B) {
	q := NewQueue()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		id := "j" + strconv.Itoa(i)
		_ = q.Submit(&Job{ID: id, Stages: []Stage{StageImage}})
		j, err := q.Next()
		if err != nil {
			b.Fatal(err)
		}
		_ = q.Complete(j.ID, &JobResult{ID: j.ID})
	}
	b.StopTimer()
	ns := float64(b.Elapsed().Nanoseconds()) / float64(b.N)
	b.ReportMetric(ns, "ns/op-L3")
	b.ReportMetric(ns/18.12e9*100, "pct-of-L1-segment")
}
