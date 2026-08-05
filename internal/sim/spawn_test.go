package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// economyBaseState 构造可结算的经济状态：Core 在原点、pop=2、resources=10
// 满仓（capacity=10、space=0）、一个满载 Worker 在 Core 格、一个空载
// Worker 在外（t4 实测死锁状态）。
func economyBaseState() *domain.TickState {
	return &domain.TickState{
		Tick:             1,
		Status:           domain.PlayerStatusActive,
		Resources:        10,
		ResourceCapacity: 10,
		ResourceSpace:    0,
		Population:       2,
		Core: &domain.Core{
			ID:       "core-1",
			Position: domain.Position{0, 0},
			HP:       domain.CoreMaxHP,
			Shield:   domain.CoreMaxShield,
			State:    domain.CoreNormal,
		},
		Units: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		Workers: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		ResourceCells: domain.NewSet[string](),
		ObstacleCells: domain.NewSet[string](),
		Beacon: domain.Beacon{
			Position: domain.Position{-17, 77},
			Status:   domain.BeaconGround,
		},
	}
}

func spawnWorkerPlan(tick int) *domain.Plan {
	unitType := domain.UnitWorker
	return &domain.Plan{
		Tick:        tick,
		UnitActions: map[string]domain.UnitAction{},
		CoreAction:  &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &unitType},
	}
}

// TestSpawnSettlesResourceDeductionAndNewWorker：Core 格空 → SPAWN 结算：
// 资源 10→5、pop 2→3、容量 10→15、space 5、新 Worker 出生在 Core 格。
func TestSpawnSettlesResourceDeductionAndNewWorker(t *testing.T) {
	state := economyBaseState()
	// 满载 Worker 先让位（模拟 planner yield），Core 格空。
	state.Units[0].Position = domain.Position{0, -1}
	state.Workers[0].Position = domain.Position{0, -1}

	result := NewEngine().Settle(state, spawnWorkerPlan(state.Tick))

	if result.Stats.Spawns != 1 {
		t.Fatalf("spawns = %d, want 1", result.Stats.Spawns)
	}
	next := result.NextState
	if next.Resources != 5 {
		t.Errorf("resources = %d, want 5 (10 - cost 5)", next.Resources)
	}
	if next.Population != 3 {
		t.Errorf("population = %d, want 3", next.Population)
	}
	if len(next.Workers) != 3 {
		t.Errorf("workers = %d, want 3", len(next.Workers))
	}
	if next.ResourceCapacity != 15 {
		t.Errorf("capacity = %d, want 15 (max(10, 3*5))", next.ResourceCapacity)
	}
	if next.ResourceSpace != 10 {
		t.Errorf("space = %d, want 10 (15-5)", next.ResourceSpace)
	}
	newWorker := next.Workers[len(next.Workers)-1]
	if newWorker.Position != state.Core.Position {
		t.Errorf("new worker position = %v, want core cell", newWorker.Position)
	}
	if newWorker.Cargo != 0 {
		t.Errorf("new worker cargo = %d, want 0", newWorker.Cargo)
	}
	// 结算后空间恢复：满载 Worker 回 Core 即可 DEPOSIT。
	if next.ResourceSpace <= 0 {
		t.Errorf("space = %d, want > 0 after spawn", next.ResourceSpace)
	}
}

// TestSpawnBlockedByEmptyWorkerOnCore：空载 Worker 站在 Core 格 → SPAWN
// 被永久占位阻止（SPAWN_BLOCKED_CORE_OCCUPIED，资源不变）。
func TestSpawnBlockedByEmptyWorkerOnCore(t *testing.T) {
	state := economyBaseState()
	state.Workers[0].Cargo = 0 // 满载 → 空载（永久占位）
	state.Units[0].Cargo = 0

	result := NewEngine().Settle(state, spawnWorkerPlan(state.Tick))

	if result.Stats.Spawns != 0 || result.Stats.SpawnBlocked != 1 {
		t.Fatalf("spawns=%d blocked=%d, want 0/1", result.Stats.Spawns, result.Stats.SpawnBlocked)
	}
	if result.NextState.Resources != 10 {
		t.Errorf("resources = %d, want 10 (no deduction)", result.NextState.Resources)
	}
	if len(result.NextState.Workers) != 2 {
		t.Errorf("workers = %d, want 2 (no new worker)", len(result.NextState.Workers))
	}
}

// TestSpawnAllowedWithFullWorkerOnCore：满载 Worker 在 Core 格不阻止
// SPAWN（TS 版占位语义核心：满载 Worker 让位后同 tick 即可结算）。
func TestSpawnAllowedWithFullWorkerOnCore(t *testing.T) {
	state := economyBaseState()
	// 满载 Worker 本 tick 让位（MOVE 已在 Settle 内先结算）——直接给
	// 一个"已让位"的 state 验证占位语义本身：满载仍站在 Core 的极端
	// 情况（MOVE 被阻挡）也不应阻止 SPAWN。
	result := NewEngine().Settle(state, spawnWorkerPlan(state.Tick))

	// 结算顺序：本场景满载 Worker 没有 MOVE 动作（还在 Core 上）——
	// 占位语义应允许 SPAWN（满载 Worker 不视为永久占位）。
	if result.Stats.Spawns != 1 {
		t.Fatalf("spawns = %d, want 1 (full worker is not a permanent occupant)", result.Stats.Spawns)
	}
}

// TestSettleOrderYieldThenSpawn：结算顺序（MOVE 让位 → SPAWN）——
// 满载 Worker 让位动作与 SPAWN 同计划，Settle 后 Core 格腾空、SPAWN
// 结算成功。
func TestSettleOrderYieldThenSpawn(t *testing.T) {
	state := economyBaseState()
	up := domain.DirectionUp
	plan := spawnWorkerPlan(state.Tick)
	plan.UnitActions["worker-full"] = domain.UnitAction{Kind: domain.ActionMove, Direction: &up}

	result := NewEngine().Settle(state, plan)

	if result.Stats.Spawns != 1 {
		t.Fatalf("spawns = %d, want 1 (yield moved first)", result.Stats.Spawns)
	}
	next := result.NextState
	for _, unit := range next.Units {
		if unit.ID == "worker-full" && unit.Position == state.Core.Position {
			t.Errorf("worker-full still on core after yield+spawn settle")
		}
	}
	if next.Resources != 5 {
		t.Errorf("resources = %d, want 5", next.Resources)
	}
}

// TestFullEconomicLoopBreakDeadlock：t4 死锁闭环（20 ticks，真实
// strategy.Planner + sim.Engine 每 tick 循环）：
// 满载让位 → SPAWN → resources 下降 → workers 增加 → 卸货空间恢复 →
// 满载回仓 DEPOSIT。断言闭环达成（最终发生 DEPOSIT 且资源回升）。
func TestFullEconomicLoopBreakDeadlock(t *testing.T) {
	state := economyBaseState()
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget:      8,
		PopulationCeiling: 20,
		ExploreRadius:     8,
		ThreatDistance:    5,
		SpawnReserve:      0,
	})
	engine := NewEngine()

	seenDeposit := false
	spawnSeen := false
	minResources := state.Resources
	maxWorkers := len(state.Workers)
	for tick := 1; tick <= 20; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		result := engine.Settle(state, plan)
		if result.Stats.Spawns > 0 {
			spawnSeen = true
		}
		if result.Stats.Deposits > 0 {
			seenDeposit = true
		}
		state = result.NextState
		if state.Resources < minResources {
			minResources = state.Resources
		}
		if len(state.Workers) > maxWorkers {
			maxWorkers = len(state.Workers)
		}
	}

	if !spawnSeen {
		t.Fatal("no spawn settled in 20 ticks (deadlock not broken)")
	}
	if maxWorkers <= 2 {
		t.Errorf("workers stayed at %d, want growth (spawn never settled)", maxWorkers)
	}
	if minResources >= 10 {
		t.Errorf("resources never dropped below 10 (min=%d) — spawn cost never paid", minResources)
	}
	if !seenDeposit {
		t.Errorf("no deposit in 20 ticks — full worker never returned cargo")
	}
	if state.ResourceSpace <= 0 {
		t.Errorf("resource space = %d, want > 0 after loop (economy unblocked)", state.ResourceSpace)
	}
}
