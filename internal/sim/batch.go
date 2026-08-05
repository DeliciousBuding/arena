// Batch 是并发批量评估 API：多场景 × 多策略并行跑 sim 闭环，
// 结果确定性（每实例独立 Engine/Planner，无共享状态）。
// 使用场景：参数搜索（optsearch）、策略赛马、回归黄金集。
package sim

import (
	"fmt"
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
	Tick      int
	Resources int
	Workers   int
	Kills     int
	UnitsLost int
	Mode      string
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
// 结果确定性：同输入同输出（每组合独立实例，互不干扰）。
func Batch(scenes []*Scenario, policies []*strategy.Config, ticks int, opt BatchOption) []BatchResult {
	if opt.Workers <= 0 {
		opt.Workers = defaultWorkers()
	}
	if opt.Interval <= 0 {
		opt.Interval = 25
	}
	results := make([]BatchResult, 0, len(scenes)*len(policies))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, opt.Workers)

	for _, scene := range scenes {
		for _, policy := range policies {
			wg.Add(1)
			sem <- struct{}{}
			go func(scene *Scenario, policy *strategy.Config) {
				defer wg.Done()
				defer func() { <-sem }()
				result := runScenario(scene, policy, ticks, opt)
				mu.Lock()
				results = append(results, result)
				mu.Unlock()
			}(scene, policy)
		}
	}
	wg.Wait()

	// 确定性顺序：scene 名升序 × policy 名升序。
	sort.Slice(results, func(i, j int) bool {
		if results[i].Scene != results[j].Scene {
			return results[i].Scene < results[j].Scene
		}
		return results[i].Policy < results[j].Policy
	})
	return results
}

// runScenario 跑单个 场景×策略 组合（独立实例，可并发）。
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
		settled := engine.Settle(state, plan)
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
				Tick:      tick,
				Resources: state.Resources,
				Workers:   len(state.Workers),
				Kills:     result.Stats.Kills,
				UnitsLost: result.Stats.UnitsLost,
				Mode:      string(planner.DirectiveMode()),
			})
		}
		state = settled.NextState
	}
	result.Final = state
	if opt.Evaluate != nil {
		result.Score = opt.Evaluate(statsPerTick, state)
	}
	return result
}

// policyName 返回策略的可读名（确定性：字段拼接）。
func policyName(policy *strategy.Config) string {
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

// defaultWorkers 返回默认并发数（GOMAXPROCS）。
func defaultWorkers() int {
	return 8
}
