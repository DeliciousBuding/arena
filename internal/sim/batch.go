// Batch 是并发批量评估 API：多场景 × 多策略并行跑 sim 闭环，
// 结果确定性（每实例独立 Engine/Planner，无共享状态）。
// 使用场景：参数搜索（optsearch）、策略赛马、回归黄金集。
package sim

import (
	"fmt"
	"runtime"
	"sort"
	"sync"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// BatchResult 是单次评估结果。
type BatchResult struct {
	Scene    string // 场景名
	Policy   string // 策略名
	Ticks    int
	Stats    SettleStats // 累计统计
	Final    *domain.TickState
	Score    float64 // 调用方评分函数结果（Evaluate 为空时 = 0）
	Timeline []TimelinePoint
}

// TimelinePoint 是逐 tick 关键指标采样（黄金集/赛马对比用）。
type TimelinePoint struct {
	Tick          int
	Resources     int
	ResourceCells int // 视野内可见资源格数（经济冻结诊断：reveal 不足）
	Workers       int
	Deposits      int // 累计 deposit 数（冻结检测：连续采样段不变 = 死锁）
	Kills         int
	UnitsLost     int
	Mode          string
}

// Evaluate 是评分函数（nil = 不评分）。输入为逐 tick 统计快照。
type Evaluate func(stats []SettleStats, final *domain.TickState) float64

// BatchOption 是批量评估配置。
type BatchOption struct {
	Workers  int // 并发数（<=0 = GOMAXPROCS）
	Interval int // Timeline 采样间隔（<=0 = 25）
	Evaluate Evaluate
}

// Batch 并发评估：scenes[i] × policies[j] 全组合并行跑 ticks 闭环。
// 高并发设计（Go 天然优势）：
//   - 固定 worker pool（不每任务起 goroutine）：goroutine 复用，
//     任务经 channel 分发，worker 数 = NumCPU（超卖配置）
//   - 无锁结果收集：预分配结果槽，每 worker 独占写入自己的槽
//     （无共享 mutex——共享锁在 8+ 并发下是扩展性瓶颈）
//   - 每 worker 独立 Engine/Planner/Refill/状态：零共享可变状态，
//     纯 embarrassingly parallel
//
// 结果确定性：同输入同输出（每组合独立实例，互不干扰）。
func Batch(scenes []*Scenario, policies []*strategy.Config, ticks int, opt BatchOption) []BatchResult {
	if opt.Workers <= 0 {
		opt.Workers = defaultWorkers()
	}
	if opt.Interval <= 0 {
		opt.Interval = 25
	}
	if len(scenes) == 0 || len(policies) == 0 {
		return nil
	}

	// 任务队列：预生成全组合索引（确定性顺序：scene 外循环 × policy 内循环）。
	type task struct {
		sceneIndex  int
		policyIndex int
		slotIndex   int
	}
	tasks := make([]task, 0, len(scenes)*len(policies))
	for sceneIndex := range scenes {
		for policyIndex := range policies {
			tasks = append(tasks, task{sceneIndex: sceneIndex, policyIndex: policyIndex, slotIndex: len(tasks)})
		}
	}

	// 无锁结果槽：每个任务一个独立槽，worker 只写自己的 slotIndex。
	slots := make([]BatchResult, len(tasks))
	workerCount := min(opt.Workers, len(tasks))
	taskChannel := make(chan task)
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for t := range taskChannel {
				slots[t.slotIndex] = runScenario(scenes[t.sceneIndex], policies[t.policyIndex], ticks, opt)
			}
		}()
	}
	for _, t := range tasks {
		taskChannel <- t
	}
	close(taskChannel)
	wg.Wait()

	// 确定性顺序：scene 名升序 × policy 名升序。
	sort.Slice(slots, func(i, j int) bool {
		if slots[i].Scene != slots[j].Scene {
			return slots[i].Scene < slots[j].Scene
		}
		return slots[i].Policy < slots[j].Policy
	})
	return slots
}

// runScenario 跑单个 场景×策略 组合（独立实例，可并发）。
// 热路径：每 tick 用 SettleInPlace 原地结算（不克隆——初始 CloneState
// 已保证 worker 间隔离；克隆是批量评估的 GC 主瓶颈）。
func runScenario(scene *Scenario, policy *strategy.Config, ticks int, opt BatchOption) BatchResult {
	state := scene.CloneState()
	planner := strategy.NewPlanner(*policy)
	engine := NewEngine()
	engine.Refill = NewRefillConfig(scene.LatentResources)

	result := BatchResult{Scene: scene.Name, Policy: policyName(policy), Ticks: ticks}
	statsPerTick := make([]SettleStats, 0, ticks)
	for tick := 1; tick <= ticks; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.SettleInPlace(state, plan)
		result.Stats.Moves += settled.Stats.Moves
		result.Stats.Blocked += settled.Stats.Blocked
		result.Stats.Harvests += settled.Stats.Harvests
		result.Stats.Deposits += settled.Stats.Deposits
		result.Stats.Spawns += settled.Stats.Spawns
		result.Stats.SpawnBlocked += settled.Stats.SpawnBlocked
		result.Stats.ResourceDelta += settled.Stats.ResourceDelta
		result.Stats.Kills += settled.Stats.Kills
		result.Stats.ShotsFired += settled.Stats.ShotsFired
		result.Stats.SweepsFired += settled.Stats.SweepsFired
		result.Stats.UnitsLost += settled.Stats.UnitsLost
		result.Stats.HPRecovered += settled.Stats.HPRecovered
		result.Stats.ShieldRepaired += settled.Stats.ShieldRepaired
		statsPerTick = append(statsPerTick, settled.Stats)
		if tick%opt.Interval == 0 || tick == ticks {
			result.Timeline = append(result.Timeline, TimelinePoint{
				Tick:          tick,
				Resources:     state.Resources,
				ResourceCells: len(state.ResourceCells),
				Workers:       len(state.Workers),
				Deposits:      result.Stats.Deposits,
				Kills:         result.Stats.Kills,
				UnitsLost:     result.Stats.UnitsLost,
				Mode:          string(planner.DirectiveMode()),
			})
		}
	}
	result.Final = state
	if opt.Evaluate != nil {
		result.Score = opt.Evaluate(statsPerTick, state)
	}
	return result
}

// policyName 返回策略的可读名：优先 Config.Name（策略文件命名），
// 否则确定性字段拼接（默认策略/内联策略）。
func policyName(policy *strategy.Config) string {
	if policy.Name != "" {
		return policy.Name
	}
	return fmt.Sprintf("wt%d_r%d_er%d_pc%d_m%d",
		policy.WorkerTarget, policy.SpawnReserve, policy.ExploreRadius,
		policy.PopulationCeiling, policy.MilitaryRatio)
}

// Scenario 是独立场景（不依赖 game 包）：
// 初始状态 + 潜在资源池 + 场景名。CloneState 深拷贝供并发安全。
type Scenario struct {
	Name            string
	Initial         *domain.TickState
	LatentResources []domain.Position
}

// CloneState 深拷贝初始状态（并发安全：每 worker 独立副本）。
func (s *Scenario) CloneState() *domain.TickState {
	return cloneState(s.Initial)
}

// defaultWorkers 返回默认并发数 = NumCPU（超卖 1 倍：纯 CPU 批处理，
// 每 worker 独占核心；28 核机器 → 28 worker，无需再乘 2——评估间无
// I/O 等待，超卖只会增加调度抖动）。
func defaultWorkers() int {
	return runtime.NumCPU()
}
