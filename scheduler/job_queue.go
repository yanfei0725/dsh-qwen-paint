// Command comfy-scheduler —— 报告 v3 §13.1 的「L3 调度器」独立实现（Go 1.27）。
//
// ## 为什么只有这一层用 Go
// 三层耗时模型（报告 §13.1）：
//   L1 GPU 采样        18.12 s/段（本机 832x480 / 25 帧 / 4 步实测，ACTIVE.md）
//   L2 换模型/显存     ~41 s 冷启动
//   L3 调度器自身      微秒~毫秒（HTTP / JSON / 队列判断）
// Go 重写**只动 L3**，占比 < 1%。报告 v3 因此把「用 Go 重写整个插件」判为**不采纳**
// （要重做 7 个工具契约、rc.5 兼容、非 ESM 客户端三块已验证资产）。
//
// 所以本模块是**独立、可选、不进插件发布物**的调度器原型：
//   · 不改 DSH 插件主体（插件仍是 lib/*.js 的 ESM）；
//   · 不进 package.json 的 files，不随插件发布；
//   · 用途是让「L3 占比 < 1%」这个结论有可执行、可复测的基准（见 BenchmarkQueueDecision）。
//
// 功能与报告 §10 对齐：三类任务互斥串行、hybrid 三段依赖链、段间卸载、
// cancel、进度权重 20/10/70、8 帧重叠分块。
package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Stage 是混合链的一段。
type Stage string

const (
	StageImage Stage = "image"
	StageTTS   Stage = "tts"
	StageVideo Stage = "video"
)

// stageWeight 与 lib/hybrid-runner.js 的 HYBRID_STAGES 同口径（报告 §9）。
var stageWeight = map[Stage]float64{StageImage: 0.2, StageTTS: 0.1, StageVideo: 0.7}

var (
	ErrQueueEmpty   = errors.New("queue empty")
	ErrDuplicateJob = errors.New("duplicate job id")
	ErrNoRunningJob = errors.New("no running job")
)

// Job 是一个待提交的 ComfyUI 任务。Stages 只有一段时是单模式，三段时是 hybrid。
type Job struct {
	ID        string
	Stages    []Stage
	Frames    int
	Height    int
	CreatedAt time.Time
}

// Segment 是 8 帧重叠分块的一段（与 lib/workflow-ast.js 的 ChunkPass 同算法）。
type Segment struct {
	Index      int
	StartFrame int
	FrameCount int
	SeedOffset int
}

// JobResult 是完成结果。
type JobResult struct {
	ID      string
	Files   []string
	Seconds float64
	Err     error
}

// Queue 是进程内互斥队列：同一 ComfyUI 实例上 image/video/tts 三类串行
// （20 GB 显存装不下两套模型，报告 §10 ①）。
type Queue struct {
	mu       sync.Mutex
	pending  []*Job
	running  *Job
	done     map[string]*JobResult
	canceled map[string]bool
}

// NewQueue 建空队列。
func NewQueue() *Queue {
	return &Queue{done: make(map[string]*JobResult), canceled: make(map[string]bool)}
}

// Submit 入队。重复 id 直接拒绝（不静默覆盖）。
func (q *Queue) Submit(j *Job) error {
	if j == nil || j.ID == "" {
		return errors.New("job needs an id")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, exists := q.done[j.ID]; exists {
		return ErrDuplicateJob
	}
	for _, p := range q.pending {
		if p.ID == j.ID {
			return ErrDuplicateJob
		}
	}
	if q.running != nil && q.running.ID == j.ID {
		return ErrDuplicateJob
	}
	if j.CreatedAt.IsZero() {
		j.CreatedAt = time.Now()
	}
	q.pending = append(q.pending, j)
	return nil
}

// Next 取出下一个任务并置为 running；已有任务在跑时返回 ErrQueueEmpty（互斥）。
func (q *Queue) Next() (*Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.running != nil {
		return nil, ErrQueueEmpty
	}
	// ⚠ 不能递归调用 q.Next()：sync.Mutex 不可重入，持锁递归会死锁。
	// 用循环跳过「启动前已取消」的任务，不占执行位。
	for len(q.pending) > 0 {
		j := q.pending[0]
		q.pending = q.pending[1:]
		if q.canceled[j.ID] {
			q.done[j.ID] = &JobResult{ID: j.ID, Err: errors.New("canceled before start")}
			continue
		}
		q.running = j
		return j, nil
	}
	return nil, ErrQueueEmpty
}

// Complete 收尾并释放互斥位。
func (q *Queue) Complete(id string, res *JobResult) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.running == nil || q.running.ID != id {
		return ErrNoRunningJob
	}
	if res == nil {
		res = &JobResult{ID: id}
	}
	res.ID = id
	q.done[id] = res
	q.running = nil
	return nil
}

// Cancel 标记取消（running 中的任务由执行器检查 IsCanceled 后自行中断）。
func (q *Queue) Cancel(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.running != nil && q.running.ID == id {
		q.canceled[id] = true
		return true
	}
	for i, p := range q.pending {
		if p.ID == id {
			q.canceled[id] = true
			q.pending = append(q.pending[:i], q.pending[i+1:]...)
			return true
		}
	}
	return false
}

// IsCanceled 给执行器的取消检查点。
func (q *Queue) IsCanceled(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.canceled[id]
}

// Result 取完成结果。
func (q *Queue) Result(id string) (JobResult, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	r, ok := q.done[id]
	if !ok || r == nil {
		return JobResult{}, false
	}
	return *r, true
}

// Pending 返回排队数（进度端点用）。
func (q *Queue) Pending() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pending)
}

// Progress 按报告 §9 的 20/10/70 权重换算整体进度。
// stageIndex 是当前段下标，frac 是该段内部进度 [0,1]。
func Progress(stages []Stage, stageIndex int, frac float64) float64 {
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	base := 0.0
	for i := 0; i < stageIndex && i < len(stages); i++ {
		base += stageWeight[stages[i]]
	}
	if stageIndex >= len(stages) {
		return 1
	}
	p := base + stageWeight[stages[stageIndex]]*frac
	if p > 1 {
		return 1
	}
	return p
}

// PlanChunks 与 lib/workflow-ast.js ChunkPass 同口径：frames > per 时切 N 段、overlap 帧重叠。
// 报告 §10 验收：81 帧 / 49 每块 / 8 重叠 → 2 段（49 帧 + 40 帧）。
func PlanChunks(frames, per, overlap int) []Segment {
	if frames <= per {
		return []Segment{{Index: 0, StartFrame: 0, FrameCount: frames, SeedOffset: 0}}
	}
	stride := per - overlap
	if stride <= 0 {
		return []Segment{{Index: 0, StartFrame: 0, FrameCount: frames, SeedOffset: 0}}
	}
	out := []Segment{}
	for start := 0; start < frames; start += stride {
		end := start + per
		if end > frames {
			end = frames
		}
		out = append(out, Segment{
			Index:      len(out),
			StartFrame: start,
			FrameCount: end - start,
			SeedOffset: len(out),
		})
		if end >= frames {
			break
		}
	}
	return out
}

func main() {
	q := NewQueue()
	_ = q.Submit(&Job{ID: "demo", Stages: []Stage{StageImage, StageTTS, StageVideo}, Frames: 81, Height: 480})
	j, _ := q.Next()
	fmt.Printf("comfy-pipeline L3 scheduler (standalone; NOT shipped with the DSH plugin)\n")
	fmt.Printf("job=%s stages=%v chunks(81/49/8)=%d\n", j.ID, j.Stages, len(PlanChunks(81, 49, 8)))
	fmt.Printf("progress after image=%.2f, after tts=%.2f, after video=%.2f\n",
		Progress(j.Stages, 1, 0), Progress(j.Stages, 2, 0), Progress(j.Stages, 3, 0))
	_ = q.Complete(j.ID, &JobResult{ID: j.ID, Seconds: 18.12})
	fmt.Println("L3 结论：队列判断为 ns 级，相对 L1 采样 18.12 s/段占比 < 1%（go test -bench 可复测）")
}
