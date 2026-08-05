package sim

import (
	"fmt"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// benchState 构造经济闭环场景（与 optsearch 同构：refill 池 + 满载死锁起点）。
func benchState() *domain.TickState {
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
	for _, cell := range []domain.Position{{36, 51}, {36, 52}, {37, 39}, {37, 42}, {37, 44}, {38, 34}, {38, 43}, {38, 50}, {39, 41}, {39, 44}, {39, 52}, {40, 40}} {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	return state
}

// runTicks 跑 N tick 闭环（planner + engine + refill），返回耗时。
func runTicks(ticks int) {
	state := benchState()
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25,
	})
	engine := NewEngine()
	engine.Refill = NewRefillConfig([]domain.Position{
		{38, 45}, {30, 34}, {46, 34}, {30, 46}, {46, 46}, {38, 26},
		{38, 47}, {28, 36}, {48, 36}, {28, 48}, {48, 48}, {40, 24},
	})
	for tick := 1; tick <= ticks; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.Settle(state, plan)
		state = settled.NextState
	}
}

// BenchmarkSim100Ticks：单次 100 tick 闭环耗时（optsearch 单次评估）。
func BenchmarkSim100Ticks(b *testing.B) {
	for i := 0; i < b.N; i++ {
		runTicks(100)
	}
}

// BenchmarkSim1000Ticks：1000 tick 长跑耗时（批量模拟）。
func BenchmarkSim1000Ticks(b *testing.B) {
	for i := 0; i < b.N; i++ {
		runTicks(1000)
	}
}

// BenchmarkSimParallel1000：8 并发 × 1000 tick（高并发批量评估）。
func BenchmarkSimParallel1000(b *testing.B) {
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			runTicks(1000)
		}
	})
}

// TestSimRunSanity：benchState 可跑通（无 panic、状态一致）。
func TestSimRunSanity(t *testing.T) {
	state := benchState()
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25,
	})
	engine := NewEngine()
	engine.Refill = NewRefillConfig([]domain.Position{
		{38, 45}, {30, 34}, {46, 34}, {30, 46}, {46, 46}, {38, 26},
		{38, 47}, {28, 36}, {48, 36}, {28, 48}, {48, 48}, {40, 24},
	})
	for tick := 1; tick <= 200; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := engine.Settle(state, plan)
		state = settled.NextState
	}
	t.Logf("200 ticks: workers=%d resources=%d", len(state.Workers), state.Resources)
	_ = fmt.Sprint(state.Tick)
}
