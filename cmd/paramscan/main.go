// paramscan：sim 经济参数网格扫描——真实拓扑闭环（fixture 障碍 +
// 资源格）下评估 workerTarget × spawnReserve 组合的经济产出。
// 用法：go run ./cmd/paramscan
package main

import (
	"fmt"
	"sort"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

var scanObstacles = []domain.Position{
	{36, 51}, {36, 52}, {37, 39}, {37, 42}, {37, 44},
	{38, 34}, {38, 43}, {38, 50}, {39, 41}, {39, 44}, {39, 52}, {40, 40},
}

// scanState 构造真实拓扑起点（满载死锁态）。
func scanState() *domain.TickState {
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
		ResourceCells: domain.NewSet[string](domain.CellKey(38, 45)),
		ObstacleCells: domain.NewSet[string](),
		Beacon:        domain.Beacon{Position: domain.Position{-17, 77}, Status: domain.BeaconGround},
	}
	for _, cell := range scanObstacles {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	return state
}

type scanResult struct {
	workerTarget int
	spawnReserve int
	workers      int
	spawns       int
	harvests     int
	deposits     int
	resources    int
}

func runScan(workerTarget, spawnReserve, ticks int) scanResult {
	state := scanState()
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget: workerTarget, PopulationCeiling: 20,
		ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: spawnReserve,
	})
	engine := sim.NewEngine()
	result := scanResult{workerTarget: workerTarget, spawnReserve: spawnReserve}
	for tick := 1; tick <= ticks; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.Settle(state, plan)
		result.spawns += settled.Stats.Spawns
		result.harvests += settled.Stats.Harvests
		result.deposits += settled.Stats.Deposits
		state = settled.NextState
	}
	result.workers = len(state.Workers)
	result.resources = state.Resources
	return result
}

func main() {
	const ticks = 100
	var targets = []int{4, 6, 8, 10}
	var reserves = []int{0, 2, 5, 8}

	fmt.Printf("=== economy parameter scan (%d ticks, real fixture topology) ===\n", ticks)
	fmt.Printf("%-6s %-8s %-8s %-6s %-8s %-8s %-8s\n", "target", "reserve", "workers", "spawns", "harvests", "deposits", "resources")

	results := make([]scanResult, 0, len(targets)*len(reserves))
	for _, target := range targets {
		for _, reserve := range reserves {
			results = append(results, runScan(target, reserve, ticks))
		}
	}
	for _, r := range results {
		fmt.Printf("%-6d %-8d %-8d %-6d %-8d %-8d %-8d\n",
			r.workerTarget, r.spawnReserve, r.workers, r.spawns, r.harvests, r.deposits, r.resources)
	}

	// 最优：worker 数最多 + 资源不枯竭（deposits 最高）。
	sort.Slice(results, func(i, j int) bool {
		if results[i].workers != results[j].workers {
			return results[i].workers > results[j].workers
		}
		return results[i].deposits > results[j].deposits
	})
	best := results[0]
	fmt.Printf("\nbest: workerTarget=%d spawnReserve=%d → workers=%d deposits=%d\n",
		best.workerTarget, best.spawnReserve, best.workers, best.deposits)
}
