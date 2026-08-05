// optsearch：模拟退火参数优化——sim 经济闭环评分下搜索最优策略参数。
// 与 paramscan（网格）互补：连续参数空间的智能搜索（离线运行，
// 运行时零开销）。
// 用法：go run ./cmd/optsearch [iterations]
package main

import (
	"fmt"
	"math"
	"math/rand"
	"os"
	"strconv"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// searchParams 是可优化参数（连续/整数空间）。
type searchParams struct {
	workerTarget      int
	spawnReserve      int
	exploreRadius     int
	populationCeiling int
}

var paramBounds = struct {
	workerTarget      [2]int
	spawnReserve      [2]int
	exploreRadius     [2]int
	populationCeiling [2]int
}{
	workerTarget:      [2]int{2, 16},
	spawnReserve:      [2]int{0, 8},
	exploreRadius:     [2]int{8, 32},
	populationCeiling: [2]int{10, 30},
}

func defaultParams() searchParams {
	return searchParams{workerTarget: 8, spawnReserve: 5, exploreRadius: 16, populationCeiling: 20}
}

func randomParams(rng *rand.Rand) searchParams {
	return searchParams{
		workerTarget:      paramBounds.workerTarget[0] + rng.Intn(paramBounds.workerTarget[1]-paramBounds.workerTarget[0]+1),
		spawnReserve:      paramBounds.spawnReserve[0] + rng.Intn(paramBounds.spawnReserve[1]-paramBounds.spawnReserve[0]+1),
		exploreRadius:     paramBounds.exploreRadius[0] + rng.Intn(paramBounds.exploreRadius[1]-paramBounds.exploreRadius[0]+1),
		populationCeiling: paramBounds.populationCeiling[0] + rng.Intn(paramBounds.populationCeiling[1]-paramBounds.populationCeiling[0]+1),
	}
}

// neighbor 扰动一个随机维度（±2 整数步）。
func neighbor(p searchParams, rng *rand.Rand) searchParams {
	clamp := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	step := 1 + rng.Intn(2)
	dimension := rng.Intn(4)
	switch dimension {
	case 0:
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.workerTarget = clamp(p.workerTarget+step, paramBounds.workerTarget[0], paramBounds.workerTarget[1])
	case 1:
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.spawnReserve = clamp(p.spawnReserve+step, paramBounds.spawnReserve[0], paramBounds.spawnReserve[1])
	case 2:
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.exploreRadius = clamp(p.exploreRadius+step, paramBounds.exploreRadius[0], paramBounds.exploreRadius[1])
	default:
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.populationCeiling = clamp(p.populationCeiling+step, paramBounds.populationCeiling[0], paramBounds.populationCeiling[1])
	}
	return p
}

// optLatentResources 是 refill 引擎的潜在资源格池（评分场景的
// 服务器秘密分布；与 optState 的初始可见格同源 + 周边扩展格——
// 模拟资源再生空间，评分基于真实游戏逻辑）。
var optLatentResources = []domain.Position{
	{38, 45}, {30, 34}, {46, 34}, {30, 46}, {46, 46}, {38, 26},
	{38, 47}, {28, 36}, {48, 36}, {28, 48}, {48, 48}, {40, 24},
}

// optDenseLatentResources 是密集场景 refill 潜在池（16 格：8 初始
// 可见格 + 6 周边扩展格 + 2 邻 chunk 格）。布局约束：Core 所在 chunk
// 配额 14（floor(128/(8+1))），每 chunk 潜在格数 ≤ 配额，refill 恢复
// 顺序无关（全部恢复）→ 评分确定性（refill 引擎对超配额部分按 map
// 迭代序恢复，会引入随机性）。
var optDenseLatentResources = []domain.Position{
	{37, 38}, {37, 39}, {37, 40}, {38, 38}, {38, 40}, {39, 38}, {39, 39}, {39, 40},
	{36, 39}, {40, 39}, {38, 36}, {38, 42}, {37, 37}, {39, 41},
	{30, 42}, {31, 39},
}

// optSparseLatentResources 是稀疏场景 refill 潜在池（6 格：沿三个
// 远资源方向扩展，模拟低密度地图的再生空间）。
var optSparseLatentResources = []domain.Position{
	{26, 30}, {30, 26}, {50, 30}, {46, 26}, {36, 58}, {40, 54},
}

// optStateFrame 是三个评分场景共享的初始状态框架（Core 满载 worker
// 死锁起点 + 空载 worker 在外 + beacon），仅资源/障碍分布不同。
func optStateFrame() *domain.TickState {
	return &domain.TickState{
		Tick: 1, Status: domain.PlayerStatusActive,
		Resources: 10, ResourceCapacity: 10, ResourceSpace: 0, Population: 2,
		Core: &domain.Core{ID: "core-1", Position: domain.Position{38, 39}, HP: domain.CoreMaxHP, Shield: domain.CoreMaxShield, State: domain.CoreNormal},
		Units: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{38, 39}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{38, 51}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		Workers: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{38, 39}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{38, 51}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		ObstacleCells: domain.NewSet[string](),
		Beacon:        domain.Beacon{Position: domain.Position{-17, 77}, Status: domain.BeaconGround},
	}
}

// optState 是基准评分场景（真实拓扑 + 满载死锁起点 + 6 资源格分布
// 四周不同距离 + 12 格 fixture 障碍——多资源格下参数差异才可区分，
// 单格场景参数平坦）。
func optState() *domain.TickState {
	state := optStateFrame()
	state.ResourceCells = domain.NewSet[string](
		domain.CellKey(38, 45), domain.CellKey(30, 34), domain.CellKey(46, 34),
		domain.CellKey(30, 46), domain.CellKey(46, 46), domain.CellKey(38, 26),
	)
	for _, cell := range []domain.Position{{36, 51}, {36, 52}, {37, 39}, {37, 42}, {37, 44}, {38, 34}, {38, 43}, {38, 50}, {39, 41}, {39, 44}, {39, 52}, {40, 40}} {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	return state
}

// optStateDense 是密集资源评分场景：Core 周围 8 格全资源、无障碍，
// 检验高产场景下的扩张与循环效率。
func optStateDense() *domain.TickState {
	state := optStateFrame()
	state.ResourceCells = domain.NewSet[string](
		domain.CellKey(37, 38), domain.CellKey(37, 39), domain.CellKey(37, 40),
		domain.CellKey(38, 38), domain.CellKey(38, 40),
		domain.CellKey(39, 38), domain.CellKey(39, 39), domain.CellKey(39, 40),
	)
	return state
}

// optStateSparse 是稀疏资源评分场景：Core 远处 3 资源格 + 8 个
// 自构造障碍（不与资源格重叠），检验长距离探索与绕障能力。
func optStateSparse() *domain.TickState {
	state := optStateFrame()
	state.ResourceCells = domain.NewSet[string](
		domain.CellKey(28, 28), domain.CellKey(48, 28), domain.CellKey(38, 56),
	)
	for _, cell := range []domain.Position{{37, 38}, {39, 40}, {36, 42}, {42, 37}, {38, 50}, {35, 36}, {43, 43}, {45, 41}} {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	return state
}

// evaluate 运行 sim 闭环 100 tick，返回经济产出评分（单场景：
// 真实拓扑，供对比与调试）。
func evaluate(p searchParams, ticks int) float64 {
	return evaluateScenario(p, ticks, optState(), optLatentResources)
}

// evaluateScenario 在指定状态与潜在资源池上运行 sim 闭环，返回
// 经济产出评分：workers×10 + deposits×5 + spawns×3 + harvests×2
// （资源格产能约束下衡量扩张与循环效率）。挂载 refill 引擎（官方
// 规则：4 tick 配额 + 视野揭示）——评分基于真实游戏逻辑（资源再生
// + 采空消失），而非"资源永不再生"的简化模型。
// 内部用 sim.Batch 并发评估（多场景 × 多策略全组合并行——Go 多核
// 天然优势；单个体评估复用 Batch 的单场景路径，开销与串行等价）。
func evaluateScenario(p searchParams, ticks int, state *domain.TickState, latent []domain.Position) float64 {
	scenes := []*sim.Scenario{{Name: "score", Initial: state, LatentResources: latent}}
	policies := []*strategy.Config{paramsToConfig(p)}
	results := sim.Batch(scenes, policies, ticks, sim.BatchOption{Workers: 4})
	result := results[0]
	score := float64(result.Stats.Spawns)*3 + float64(result.Stats.Deposits)*5 + float64(result.Stats.Harvests)*2
	score += float64(len(result.Final.Workers)) * 10
	return score
}

// paramsToConfig 把搜索参数转为策略配置。
func paramsToConfig(p searchParams) *strategy.Config {
	return &strategy.Config{
		WorkerTarget: p.workerTarget, PopulationCeiling: p.populationCeiling,
		ExploreRadius: p.exploreRadius, ThreatDistance: 5, SpawnReserve: p.spawnReserve,
	}
}

// scenarioScores 是三个评分场景各自的得分。
type scenarioScores struct {
	base, dense, sparse float64
}

// evaluateMulti 跑三个场景（真实/密集/稀疏），返回三场景最低分
// （最差场景决定评分——鲁棒性优先，防止参数过拟合单场景）与各场景分。
// 并发：3 场景在 Batch 内并行（多核拉满）。
func evaluateMulti(p searchParams, ticks int) (float64, scenarioScores) {
	scenes := []*sim.Scenario{
		{Name: "base", Initial: optState(), LatentResources: optLatentResources},
		{Name: "dense", Initial: optStateDense(), LatentResources: optDenseLatentResources},
		{Name: "sparse", Initial: optStateSparse(), LatentResources: optSparseLatentResources},
	}
	policies := []*strategy.Config{paramsToConfig(p)}
	results := sim.Batch(scenes, policies, ticks, sim.BatchOption{Workers: 4})
	scores := scenarioScores{}
	for _, result := range results {
		score := float64(result.Stats.Spawns)*3 + float64(result.Stats.Deposits)*5 + float64(result.Stats.Harvests)*2
		score += float64(len(result.Final.Workers)) * 10
		switch result.Scene {
		case "base":
			scores.base = score
		case "dense":
			scores.dense = score
		case "sparse":
			scores.sparse = score
		}
	}
	minScore := scores.base
	if scores.dense < minScore {
		minScore = scores.dense
	}
	if scores.sparse < minScore {
		minScore = scores.sparse
	}
	return minScore, scores
}

// evaluateBatch 并发评估多个个体的三场景最差分（GA 种群/SA 链批量
// 并行——这是并发化的核心收益点：N 个体 × 3 场景全部同时跑）。
// 返回与输入顺序一致的得分数组。
func evaluateBatch(params []searchParams, ticks int) []float64 {
	scenes := []*sim.Scenario{
		{Name: "base", Initial: optState(), LatentResources: optLatentResources},
		{Name: "dense", Initial: optStateDense(), LatentResources: optDenseLatentResources},
		{Name: "sparse", Initial: optStateSparse(), LatentResources: optSparseLatentResources},
	}
	policies := make([]*strategy.Config, 0, len(params))
	for _, p := range params {
		policies = append(policies, paramsToConfig(p))
	}
	results := sim.Batch(scenes, policies, ticks, sim.BatchOption{Workers: 0}) // 0 = NumCPU
	// 每个体取三场景最低分（结果按 scene 名升序 × policy 名升序；
	// policy 名含参数值——需按 config 匹配）。
	scores := make([]float64, len(params))
	for i, p := range params {
		want := sim.PolicyName(paramsToConfig(p))
		minScore := math.Inf(1)
		for _, result := range results {
			if result.Policy != want {
				continue
			}
			score := float64(result.Stats.Spawns)*3 + float64(result.Stats.Deposits)*5 + float64(result.Stats.Harvests)*2
			score += float64(len(result.Final.Workers)) * 10
			if score < minScore {
				minScore = score
			}
		}
		scores[i] = minScore
	}
	return scores
}

// formatScores 格式化三场景分，如 "{129, 150, 100}"（base, dense, sparse）。
func formatScores(s scenarioScores) string {
	return fmt.Sprintf("{%.0f, %.0f, %.0f}", s.base, s.dense, s.sparse)
}

func main() {
	iterations := 400
	useGA := false
	for _, arg := range os.Args[1:] {
		if arg == "--ga" {
			useGA = true
			continue
		}
		if n, err := strconv.Atoi(arg); err == nil && n > 0 {
			iterations = n
		}
	}
	const ticks = 100
	rng := rand.New(rand.NewSource(20260805)) // 确定性种子

	if useGA {
		geneticAlgorithm(iterations, ticks, rng)
		return
	}

	current := defaultParams()
	currentScore, currentScores := evaluateMulti(current, ticks)
	best := current
	bestScore := currentScore
	bestScores := currentScores

	// 模拟退火：温度线性降温，Metropolis 接受准则。
	temperature := 50.0
	accepts := 0
	fmt.Printf("=== simulated annealing (%d iterations, %d ticks) ===\n", iterations, ticks)
	fmt.Printf("start: %+v score=%.0f scenario: %s\n", current, currentScore, formatScores(currentScores))
	for i := 0; i < iterations; i++ {
		candidate := neighbor(current, rng)
		candidateScore, candidateScores := evaluateMulti(candidate, ticks)
		delta := candidateScore - currentScore
		if delta >= 0 || rng.Float64() < math.Exp(delta/temperature) {
			current = candidate
			currentScore = candidateScore
			currentScores = candidateScores
			accepts++
			if currentScore > bestScore {
				best = current
				bestScore = currentScore
				bestScores = candidateScores
			}
		}
		temperature *= 0.99
		if temperature < 1 {
			temperature = 1
		}
	}
	fmt.Printf("best: %+v score=%.0f scenario: %s (accepts=%d)\n", best, bestScore, formatScores(bestScores), accepts)
	defaultScore, defaultScores := evaluateMulti(defaultParams(), ticks)
	fmt.Printf("default: %+v score=%.0f scenario: %s\n", defaultParams(), defaultScore, formatScores(defaultScores))
}

// geneticAlgorithm 运行遗传算法参数搜索。
// 种群 20 个体 × generations 代，锦标赛选择（size 3）+ 均匀交叉 + 变异。
func geneticAlgorithm(generations, ticks int, rng *rand.Rand) {
	const populationSize = 20
	pop := make([]searchParams, populationSize)
	fitness := make([]float64, populationSize)
	best := pop[0]
	bestScore := fitness[0]
	var bestScores scenarioScores
	for i := range pop {
		pop[i] = randomParams(rng)
	}
	// 初始种群批量并发评估（20 个体 × 3 场景 = 60 评估一次并行）。
	seedFitness := evaluateBatch(pop, ticks)
	for i := range pop {
		fitness[i] = seedFitness[i]
		if seedFitness[i] > bestScore {
			best = pop[i]
			bestScore = seedFitness[i]
			bestScores = scoresFor(best, ticks)
		}
	}

	fmt.Printf("=== genetic algorithm (%d gen, population %d, %d ticks) ===\n", generations, populationSize, ticks)
	fmt.Printf("seed: %+v score=%.0f scenario: %s\n", best, bestScore, formatScores(bestScores))
	for gen := 0; gen < generations; gen++ {
		next := make([]searchParams, populationSize)
		nextFitness := make([]float64, populationSize)
		// 精英保留：最优个体直接进入下一代。
		next[0] = best
		nextFitness[0] = bestScore
		for i := 1; i < populationSize; i++ {
			parent1 := tournamentSelect(pop, fitness, 3, rng)
			parent2 := tournamentSelect(pop, fitness, 3, rng)
			child := crossover(parent1, parent2, rng)
			child = mutate(child, rng)
			next[i] = child
		}
		// 种群批量并发评估（19 个体 × 3 场景 = 57 评估一次并行跑完——
		// 多核拉满，串行时代每个体 3 场景逐个跑）。
		batchFitness := evaluateBatch(next[1:], ticks)
		for i := 1; i < populationSize; i++ {
			nextFitness[i] = batchFitness[i-1]
			if nextFitness[i] > bestScore {
				best = next[i]
				bestScore = nextFitness[i]
				bestScores = scoresFor(next[i], ticks)
			}
		}
		pop = next
		fitness = nextFitness
		if gen%10 == 9 || gen == generations-1 {
			fmt.Printf("  gen %3d: best=%.0f %+v\n", gen+1, bestScore, best)
		}
	}
	fmt.Printf("best: %+v score=%.0f scenario: %s\n", best, bestScore, formatScores(bestScores))
	defaultScore, defaultScores := evaluateMulti(defaultParams(), ticks)
	fmt.Printf("default: %+v score=%.0f scenario: %s\n", defaultParams(), defaultScore, formatScores(defaultScores))
}

// scoresFor 计算单个体的三场景最差分（best 更新时用）。
func scoresFor(p searchParams, ticks int) scenarioScores {
	_, scores := evaluateMulti(p, ticks)
	return scores
}

// tournamentSelect 从种群中随机选 size 个个体，返回最优。
func tournamentSelect(pop []searchParams, fitness []float64, size int, rng *rand.Rand) searchParams {
	bestIdx := rng.Intn(len(pop))
	bestFitness := fitness[bestIdx]
	for i := 1; i < size; i++ {
		idx := rng.Intn(len(pop))
		if fitness[idx] > bestFitness {
			bestIdx = idx
			bestFitness = fitness[idx]
		}
	}
	return pop[bestIdx]
}

// crossover 对两个父代均匀交叉：每个维度独立等概率从父代之一继承。
func crossover(a, b searchParams, rng *rand.Rand) searchParams {
	child := a
	if rng.Intn(2) == 0 {
		child.workerTarget = b.workerTarget
	}
	if rng.Intn(2) == 0 {
		child.spawnReserve = b.spawnReserve
	}
	if rng.Intn(2) == 0 {
		child.exploreRadius = b.exploreRadius
	}
	if rng.Intn(2) == 0 {
		child.populationCeiling = b.populationCeiling
	}
	return child
}

// mutate 以概率 0.2 扰动每个维度（±2 整数步）。
func mutate(p searchParams, rng *rand.Rand) searchParams {
	clamp := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	if rng.Float64() < 0.2 {
		step := 1 + rng.Intn(2)
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.workerTarget = clamp(p.workerTarget+step, paramBounds.workerTarget[0], paramBounds.workerTarget[1])
	}
	if rng.Float64() < 0.2 {
		step := 1 + rng.Intn(2)
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.spawnReserve = clamp(p.spawnReserve+step, paramBounds.spawnReserve[0], paramBounds.spawnReserve[1])
	}
	if rng.Float64() < 0.2 {
		step := 1 + rng.Intn(2)
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.exploreRadius = clamp(p.exploreRadius+step, paramBounds.exploreRadius[0], paramBounds.exploreRadius[1])
	}
	if rng.Float64() < 0.2 {
		step := 1 + rng.Intn(2)
		if rng.Intn(2) == 0 {
			step = -step
		}
		p.populationCeiling = clamp(p.populationCeiling+step, paramBounds.populationCeiling[0], paramBounds.populationCeiling[1])
	}
	return p
}
