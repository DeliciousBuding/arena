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

// optState 是评分场景（真实拓扑 + 满载死锁起点 + 6 资源格分布
// 四周不同距离——多资源格下参数差异才可区分，单格场景参数平坦）。
func optState() *domain.TickState {
	state := &domain.TickState{
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
		ResourceCells: domain.NewSet[string](
			domain.CellKey(38, 45), domain.CellKey(30, 34), domain.CellKey(46, 34),
			domain.CellKey(30, 46), domain.CellKey(46, 46), domain.CellKey(38, 26),
		),
		ObstacleCells: domain.NewSet[string](),
		Beacon:        domain.Beacon{Position: domain.Position{-17, 77}, Status: domain.BeaconGround},
	}
	for _, cell := range []domain.Position{{36, 51}, {36, 52}, {37, 39}, {37, 42}, {37, 44}, {38, 34}, {38, 43}, {38, 50}, {39, 41}, {39, 44}, {39, 52}, {40, 40}} {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	return state
}

// evaluate 运行 sim 闭环 100 tick，返回经济产出评分：
// workers×10 + deposits×5 + spawns×3 + harvests×2（资源格产能约束下
// 衡量扩张与循环效率）。
func evaluate(p searchParams, ticks int) float64 {
	state := optState()
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget: p.workerTarget, PopulationCeiling: p.populationCeiling,
		ExploreRadius: p.exploreRadius, ThreatDistance: 5, SpawnReserve: p.spawnReserve,
	})
	engine := sim.NewEngine()
	score := 0.0
	for tick := 1; tick <= ticks; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.Settle(state, plan)
		score += float64(settled.Stats.Spawns)*3 + float64(settled.Stats.Deposits)*5 + float64(settled.Stats.Harvests)*2
		state = settled.NextState
	}
	score += float64(len(state.Workers)) * 10
	return score
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
	currentScore := evaluate(current, ticks)
	best := current
	bestScore := currentScore

	// 模拟退火：温度线性降温，Metropolis 接受准则。
	temperature := 50.0
	accepts := 0
	fmt.Printf("=== simulated annealing (%d iterations, %d ticks) ===\n", iterations, ticks)
	fmt.Printf("start: %+v score=%.0f\n", current, currentScore)
	for i := 0; i < iterations; i++ {
		candidate := neighbor(current, rng)
		candidateScore := evaluate(candidate, ticks)
		delta := candidateScore - currentScore
		if delta >= 0 || rng.Float64() < math.Exp(delta/temperature) {
			current = candidate
			currentScore = candidateScore
			accepts++
			if currentScore > bestScore {
				best = current
				bestScore = currentScore
			}
		}
		temperature *= 0.99
		if temperature < 1 {
			temperature = 1
		}
	}
	fmt.Printf("best: %+v score=%.0f (accepts=%d)\n", best, bestScore, accepts)
	fmt.Printf("default: %+v score=%.0f\n", defaultParams(), evaluate(defaultParams(), ticks))
}

// geneticAlgorithm 运行遗传算法参数搜索。
// 种群 20 个体 × generations 代，锦标赛选择（size 3）+ 均匀交叉 + 变异。
func geneticAlgorithm(generations, ticks int, rng *rand.Rand) {
	const populationSize = 20
	pop := make([]searchParams, populationSize)
	fitness := make([]float64, populationSize)
	for i := range pop {
		pop[i] = randomParams(rng)
		fitness[i] = evaluate(pop[i], ticks)
	}
	best := pop[0]
	bestScore := fitness[0]
	for i, f := range fitness {
		if f > bestScore {
			best = pop[i]
			bestScore = f
		}
	}

	fmt.Printf("=== genetic algorithm (%d gen, population %d, %d ticks) ===\n", generations, populationSize, ticks)
	fmt.Printf("seed: %+v score=%.0f\n", best, bestScore)
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
			nextFitness[i] = evaluate(child, ticks)
			if nextFitness[i] > bestScore {
				best = next[i]
				bestScore = nextFitness[i]
			}
		}
		pop = next
		fitness = nextFitness
		if gen%10 == 9 || gen == generations-1 {
			fmt.Printf("  gen %3d: best=%.0f %+v\n", gen+1, bestScore, best)
		}
	}
	fmt.Printf("best: %+v score=%.0f\n", best, bestScore)
	fmt.Printf("default: %+v score=%.0f\n", defaultParams(), evaluate(defaultParams(), ticks))
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
