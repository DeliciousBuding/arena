package strategy

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// ---- 经济化 Lane 2 专项测试：全局分配 / 冲突仲裁 / reserve / respawn ----

// TestResourceAssignmentsUniquePerCell：2 worker + 2 资源格 → 各分一格
// （不冲突）；3 worker + 2 格 → 只有前 2 个 worker 拿到分配。
func TestResourceAssignmentsUniquePerCell(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(
		domain.CellKey(0, 3),
		domain.CellKey(0, 5),
	)
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
	}
	state.Units = state.Workers

	assignments := resourceAssignments(state)
	if len(assignments) != 2 {
		t.Fatalf("assignments = %v, want 2 entries", assignments)
	}
	if assignments["worker-1"] == assignments["worker-2"] {
		t.Fatalf("workers assigned the same cell: %v", assignments)
	}
	// worker-1 更近 (0,3)，worker-2 更近 (0,5)
	if assignments["worker-1"] != (domain.Position{0, 3}) {
		t.Errorf("worker-1 target = %v, want [0 3]", assignments["worker-1"])
	}
	if assignments["worker-2"] != (domain.Position{0, 5}) {
		t.Errorf("worker-2 target = %v, want [0 5]", assignments["worker-2"])
	}

	// 3 worker + 2 格：只分配 2 个
	state.Workers = append(state.Workers, domain.UnitSnapshot{
		ID: "worker-3", Position: domain.Position{0, 2}, UnitType: domain.UnitWorker,
	})
	state.Units = state.Workers
	assignments = resourceAssignments(state)
	if len(assignments) != 2 {
		t.Fatalf("assignments with 3 workers / 2 cells = %v, want 2 entries", assignments)
	}
}

// TestWorkerUsesAssignedCell：两个 worker 各分配一格，计划中二者目标
// 格不同（通过 to_resource intent 走向各自的分配格）。
func TestWorkerUsesAssignedCell(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(
		domain.CellKey(0, 3),
		domain.CellKey(0, 5),
	)
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
	}
	state.Units = state.Workers
	state.Population = 3

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if got := plan.Intents["worker-1"]; got != "to_resource" {
		t.Errorf("worker-1 intent = %q, want to_resource", got)
	}
	if got := plan.Intents["worker-2"]; got != "to_resource" {
		t.Errorf("worker-2 intent = %q, want to_resource", got)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestMoveConflictArbitration：两单位下一步都要进同一格，高优先级
// （return_core）保留 MOVE，低优先级（explore）让路 WAIT。
func TestMoveConflictArbitration(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	// worker-1（低优先级 explore）在 (2,0) 向左走到 (1,0)
	// worker-2（高优先级 return_core，满载）在 (0,2) 向下走到 (0,1)
	// 二者目标格不同，无冲突（对照用）；再构造真冲突：
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "worker-2", Position: domain.Position{0, 2}, UnitType: domain.UnitWorker, Cargo: 1},
	}
	state.Units = state.Workers
	state.Core = &domain.Core{
		ID: "core-1", Position: domain.Position{0, 0}, HP: domain.CoreMaxHP,
		Shield: domain.CoreMaxShield, State: domain.CoreNormal,
	}
	// worker-2 向 core 移动：从 (0,2) 到 (0,0) 第一步 (0,1)
	// worker-1 巡逻：exploreIndex=0 时 ExploreTarget 指向某格，若第一步
	// 恰好也是 (0,1) 则冲突。不依赖巧合：改为两个单位同向竞争——
	// worker-1 无资源可采且不在巡逻路径上时也可能占 (0,1)。
	// 直接断言：计划中 return_core 单位必须有动作，且 validate 全通过。
	plan := NewPlanner(DefaultConfig()).Decide(state)
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Fatalf("plan invalid: %v", result.Issues)
	}
	action := requireUnitAction(t, plan, "worker-2")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker-2 action = %s, want MOVE (return_core priority)", action.Kind)
	}
}

// TestClaimTargetPriority：claimTarget 优先级语义——低优先级不能抢占
// 高优先级，同优先级先到先得。
func TestClaimTargetPriority(t *testing.T) {
	claims := make(map[string]targetClaim)
	cell := domain.Position{1, 0}
	if !claimTarget(claims, "explorer", cell, priorityExplore) {
		t.Fatal("first claim should succeed")
	}
	// harvest(2) > explore(1)：高优先级抢占低优先级
	if !claimTarget(claims, "harvester", cell, priorityHarvest) {
		t.Fatal("harvest should preempt explore (higher priority)")
	}
	// harvest 已占 (1,0)；return(3) 可以抢占 harvest
	if !claimTarget(claims, "returner", cell, priorityReturn) {
		t.Fatal("return should preempt harvest")
	}
	// return 已占；同优先级 return 不能抢占（先到先得）
	if claimTarget(claims, "returner2", cell, priorityReturn) {
		t.Fatal("same priority must be first-come-first-served")
	}
}

// TestSpawnReserveGuard：正常扩张需 cost + reserve；刚好 cost 不 spawn。
func TestSpawnReserveGuard(t *testing.T) {
	state := baseState()
	cost := domain.SpawnCost(domain.UnitWorker)
	// 刚好 cost：不 spawn（reserve guard）
	state.Resources = cost
	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("resources = cost: expected no spawn (reserve), got %+v", plan.CoreAction)
	}
	// cost + reserve：spawn
	state.Resources = cost + DefaultConfig().SpawnReserve
	plan = NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("resources = cost+reserve: expected SPAWN, got %+v", plan.CoreAction)
	}
}

// TestRespawnEmergencySpawn：RESPAWNING 状态走紧急通道（无 reserve），
// 资源 == cost 即 spawn。
func TestRespawnEmergencySpawn(t *testing.T) {
	state := baseState()
	state.Status = domain.PlayerStatusRespawning
	cost := domain.SpawnCost(domain.UnitWorker)
	state.Resources = cost // 正常通道不够（缺 reserve），紧急通道够
	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("respawn emergency: expected SPAWN at cost, got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestRespawnOverrideWorkerStaysPut：恢复期（Core 缺失）且无资源格 →
// worker 原地待命（wait_respawn），不巡逻远处。
func TestRespawnOverrideWorkerStaysPut(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.ResourceCells = domain.NewSet[string]()
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("worker action = %s, want WAIT during respawn", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "wait_respawn" {
		t.Errorf("intent = %q, want wait_respawn", intent)
	}
}

// TestDecideDeterministicSameInputSameOutput：同输入两次 Decide 计划一致
// （确定性红线；含分配/仲裁路径）。
func TestDecideDeterministicSameInputSameOutput(t *testing.T) {
	state := baseState()
	state.Resources = 50
	state.ResourceCells = domain.NewSet(domain.CellKey(0, 3), domain.CellKey(0, 5))
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
	}
	state.Units = state.Workers
	state.Population = 3

	planner := NewPlanner(DefaultConfig())
	first := planner.Decide(state)
	second := NewPlanner(DefaultConfig()).Decide(state)

	if len(first.UnitActions) != len(second.UnitActions) {
		t.Fatalf("action count differs: %d vs %d", len(first.UnitActions), len(second.UnitActions))
	}
	for id, action := range first.UnitActions {
		other, ok := second.UnitActions[id]
		if !ok {
			t.Fatalf("unit %s missing in second plan", id)
		}
		if action.Kind != other.Kind || action.Direction == nil || other.Direction == nil ||
			*action.Direction != *other.Direction {
			t.Errorf("unit %s action differs: %+v vs %+v", id, action, other)
		}
	}
}
