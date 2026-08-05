package strategy

import (
	"fmt"
	"testing"
	"time"

	"github.com/deliciousbuding/arena/internal/domain"
)

// baseState 构造最小合法状态：健康 Core 在原点、空资源/障碍集合、
// 一个空手 Worker 在 Core 格上（其余分支由各用例覆写）。
func baseState() *domain.TickState {
	return &domain.TickState{
		Tick:             1,
		Status:           domain.PlayerStatusActive,
		Resources:        5,
		ResourceCapacity: 10,
		ResourceSpace:    5,
		Population:       2,
		Core: &domain.Core{
			ID:       "core-1",
			Position: domain.Position{0, 0},
			HP:       domain.CoreMaxHP,
			Shield:   domain.CoreMaxShield,
			State:    domain.CoreNormal,
		},
		Units: []domain.UnitSnapshot{
			{ID: "worker-1", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		Workers: []domain.UnitSnapshot{
			{ID: "worker-1", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		ResourceCells: domain.NewSet[string](),
		ObstacleCells: domain.NewSet[string](),
		Beacon: domain.Beacon{
			Position: domain.Position{-17, 77},
			Status:   domain.BeaconGround,
		},
	}
}

// requireUnitAction 断言计划中某单位存在动作并返回。
func requireUnitAction(t *testing.T, plan *domain.Plan, unitID string) domain.UnitAction {
	t.Helper()
	action, ok := plan.UnitActions[unitID]
	if !ok {
		t.Fatalf("plan for unit %s not found (actions=%v)", unitID, plan.UnitActions)
	}
	return action
}

// fullCoreDeadlockState 构造 t4 真实满仓死锁状态（实测抓取）：
// resources=10、population=2、capacity=10（space=0）、workerTarget=8、
// spawnReserve=0；满载 Worker 在 Core 格，空载 Worker 在外。
// Core 相邻 4 格均为安全空地（无资源/障碍/单位）。
func fullCoreDeadlockState() *domain.TickState {
	state := baseState()
	state.Resources = 10
	state.ResourceCapacity = 10
	state.ResourceSpace = 0
	state.Population = 2
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-full", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-empty", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Units = append([]domain.UnitSnapshot(nil), state.Workers...)
	return state
}

// TestYieldFullCoreBreaksDeadlock：满仓 + 满载 Worker 站在 Core → 让位
// MOVE + Core SPAWN WORKER 同计划且通过校验（t4 破锁核心回归）。
func TestYieldFullCoreBreaksDeadlock(t *testing.T) {
	state := fullCoreDeadlockState()
	planner := NewPlanner(Config{
		WorkerTarget:      8,
		PopulationCeiling: 20,
		ExploreRadius:     8,
		ThreatDistance:    5,
		SpawnReserve:      0,
	})
	plan := planner.Decide(state)

	// 满载 Worker 必须让位（MOVE 离开 Core），不能 WAIT。
	fullAction := requireUnitAction(t, plan, "worker-full")
	if fullAction.Kind != domain.ActionMove || fullAction.Direction == nil {
		t.Fatalf("worker-full = %+v, want MOVE away from core", fullAction)
	}
	if intent := plan.Intents["worker-full"]; intent != "yield_full_core" {
		t.Errorf("worker-full intent = %q, want yield_full_core", intent)
	}
	// 目标格必须不在 Core 上。
	destination := domain.Move(state.Core.Position, *fullAction.Direction)
	if destination == state.Core.Position {
		t.Errorf("worker-full destination = core cell, want yield away")
	}

	// Core 计划 SPAWN WORKER（满载 Worker 不视为永久占位，不阻止 SPAWN）。
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn ||
		plan.CoreAction.UnitType == nil || *plan.CoreAction.UnitType != domain.UnitWorker {
		t.Fatalf("core action = %+v, want SPAWN WORKER", plan.CoreAction)
	}

	// 同一份计划必须通过语义校验（裁决要求 plan valid = true）。
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestYieldFullCoreSkipsBlockedCells：让位探测按固定顺序跳过障碍格、
// 资源格与占用格，取第一个安全格。
func TestYieldFullCoreSkipsBlockedCells(t *testing.T) {
	state := fullCoreDeadlockState()
	// Core 在 (0,0)：UP=(0,-1) 障碍、RIGHT=(1,0) 资源格、DOWN=(0,1) 被
	// 己方单位占用 → 只能 LEFT=(-1,0)。
	state.ObstacleCells.Add(domain.CellKey(0, -1))
	state.ResourceCells.Add(domain.CellKey(1, 0))
	state.Units = append(state.Units,
		domain.UnitSnapshot{ID: "blocker", Position: domain.Position{0, 1}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0})
	state.Workers = append(state.Workers,
		domain.UnitSnapshot{ID: "blocker", Position: domain.Position{0, 1}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0})

	plan := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0}).Decide(state)
	fullAction := requireUnitAction(t, plan, "worker-full")
	if fullAction.Direction == nil || *fullAction.Direction != domain.DirectionLeft {
		t.Fatalf("worker-full = %+v, want MOVE LEFT (first safe cell)", fullAction)
	}
}

// TestYieldFullCoreSurroundedFallsBackToWait：Core 四面全被堵死（无安全
// 相邻格）→ 降级 WAIT（不产生非法 MOVE）。
func TestYieldFullCoreSurroundedFallsBackToWait(t *testing.T) {
	state := fullCoreDeadlockState()
	for _, cell := range []domain.Position{{0, -1}, {1, 0}, {0, 1}, {-1, 0}} {
		state.ObstacleCells.Add(domain.CellKey(cell[0], cell[1]))
	}
	plan := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0}).Decide(state)
	fullAction := requireUnitAction(t, plan, "worker-full")
	if fullAction.Kind != domain.ActionWait {
		t.Fatalf("worker-full = %+v, want WAIT fallback (all cells blocked)", fullAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestFullWorkerOffCoreStillWaitsOnFullCapacity：满载 Worker 不在 Core 上
// 且满仓 → 仍 WAIT（不长途回仓，等 SPAWN 腾出空间）。
func TestFullWorkerOffCoreStillWaitsOnFullCapacity(t *testing.T) {
	state := fullCoreDeadlockState()
	state.Workers[0].Position = domain.Position{3, 3}
	state.Units[0].Position = domain.Position{3, 3}
	plan := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0}).Decide(state)
	action := requireUnitAction(t, plan, "worker-full")
	if action.Kind != domain.ActionWait {
		t.Fatalf("worker-full = %+v, want WAIT (off core, capacity full)", action)
	}
}

// TestPatrolPersistsPerUnitTarget：同一 planner 跨 tick 时，同一单位持续
// 朝同一目标直线移动（不会每 tick 换方向原地打转——真机 20t 资源枯竭
// 根因回归）。开放地图无障碍：直线推进方向必须稳定。
func TestPatrolPersistsPerUnitTarget(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0})

	first := planner.Decide(state)
	firstAction := requireUnitAction(t, first, "worker-1")
	if firstAction.Kind != domain.ActionMove {
		t.Fatalf("first decide action = %+v, want MOVE", firstAction)
	}
	// 模拟单位移动到目标方向一格（同 planner 下一 tick）。
	state.Units[0].Position = domain.Move(state.Units[0].Position, *firstAction.Direction)
	state.Workers[0].Position = state.Units[0].Position
	state.Tick = 2

	second := planner.Decide(state)
	secondAction := requireUnitAction(t, second, "worker-1")
	// 目标未到达：方向应保持一致（同一直线推进）。
	if secondAction.Kind != domain.ActionMove || secondAction.Direction == nil {
		t.Fatalf("second decide action = %+v, want MOVE", secondAction)
	}
	if *secondAction.Direction != *firstAction.Direction {
		t.Errorf("patrol direction changed %v → %v, want persistent (same target)", *firstAction.Direction, *secondAction.Direction)
	}
}

// TestPatrolAdvancesRings：单位到达目标后换下一方位目标（环半径扩展，
// 探索逐步扩大）。
func TestPatrolAdvancesRings(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0})

	// 模拟 20 tick 移动（不遇到目标时持续朝同一方向）。
	directions := make([]domain.Direction, 0, 20)
	for tick := 1; tick <= 20; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		action := requireUnitAction(t, plan, "worker-1")
		if action.Kind != domain.ActionMove || action.Direction == nil {
			break
		}
		directions = append(directions, *action.Direction)
		state.Units[0].Position = domain.Move(state.Units[0].Position, *action.Direction)
		state.Workers[0].Position = state.Units[0].Position
	}
	// 目标 radius=8：到达后换方向（8 格内方向不变；20 格至少两次换向）。
	if len(directions) < 12 {
		t.Fatalf("only %d moves in 20 ticks, want steady outward patrol", len(directions))
	}
}

// TestDecideUsesWorldResourceHints：实时视野无资源格但世界记忆有 →
// worker 朝记忆格移动（to_resource 而不是 explore）。
func TestDecideUsesWorldResourceHints(t *testing.T) {
	state := baseState()
	state.ObstacleCells = domain.NewSet[string]()
	state.ResourceCells = domain.NewSet[string]() // 实时视野空

	world := domain.NewWorld()
	// 世界记忆：远处资源格 (10, 0)。
	world.Observe(&domain.TickState{
		Tick:          1,
		Core:          state.Core,
		Units:         state.Units,
		Workers:       state.Workers,
		ResourceCells: domain.NewSet[string](domain.CellKey(10, 0)),
	})

	decideState := state.WithResourceHints(world.ResourceHints(0, 0))
	plan := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0}).Decide(decideState)

	action := requireUnitAction(t, plan, "worker-1")
	if plan.Intents["worker-1"] != "to_resource" {
		t.Fatalf("intent = %q, want to_resource (memory hint merged)", plan.Intents["worker-1"])
	}
	if action.Kind != domain.ActionMove || action.Direction == nil {
		t.Fatalf("action = %+v, want MOVE toward memory resource", action)
	}
}

// TestPatrolInitialDirectionsSpread：多 worker 首目标方向按 ID 分散
// （不同单位同时出发覆盖不同方位，不挤在同一方向）。
func TestPatrolInitialDirectionsSpread(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	state.ObstacleCells = domain.NewSet[string]()
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-a", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "worker-b", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "worker-c", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Units = append([]domain.UnitSnapshot(nil), state.Workers...)
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0})
	plan := planner.Decide(state)

	directions := map[domain.Direction]bool{}
	moved := 0
	for _, worker := range state.Workers {
		action := requireUnitAction(t, plan, worker.ID)
		if action.Kind == domain.ActionMove && action.Direction != nil {
			directions[*action.Direction] = true
			moved++
		}
	}
	// 同格同目标会被仲裁降级——验证至少出现 2 个不同方向（分散生效）。
	if len(directions) < 2 {
		t.Errorf("initial directions = %v (moved=%d), want >= 2 distinct (ID-hash spread)", directions, moved)
	}
}

// TestMoveAvoidsOwnUnits：拥挤排布（t4 实测：4 worker 排成一排，计划
// 互相踩格导致服务器不结算移动）——每个单位的目标格不得被其他己方
// 单位占据，计划互相不冲突。
func TestMoveAvoidsOwnUnits(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	state.ObstacleCells = domain.NewSet[string]()
	// t4 实测排布：Core 在 (98,84)，4 个 worker 在 y=76 排成一排。
	state.Core.Position = domain.Position{98, 84}
	state.Workers = []domain.UnitSnapshot{
		{ID: "w-1", Position: domain.Position{94, 76}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-2", Position: domain.Position{95, 76}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-3", Position: domain.Position{96, 76}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-4", Position: domain.Position{101, 76}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Units = append([]domain.UnitSnapshot(nil), state.Workers...)
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0})
	plan := planner.Decide(state)

	occupied := make(map[string]domain.Position, len(state.Workers))
	for _, worker := range state.Workers {
		occupied[worker.ID] = worker.Position
	}
	for _, worker := range state.Workers {
		action := requireUnitAction(t, plan, worker.ID)
		if action.Kind != domain.ActionMove || action.Direction == nil {
			continue // WAIT 可接受（无路可走时降级）
		}
		destination := domain.Move(worker.Position, *action.Direction)
		for otherID, otherPos := range occupied {
			if otherID == worker.ID {
				continue
			}
			if destination == otherPos {
				t.Errorf("%s moves onto %s's cell %v (would be rejected by server)", worker.ID, otherID, destination)
			}
		}
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

func TestDecideSpawnsWorkerWhenResourcesSufficient(t *testing.T) {
	state := baseState()
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction == nil {
		t.Fatalf("expected core spawn action, got nil")
	}
	if plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("core action = %s, want %s", plan.CoreAction.Kind, domain.CoreSpawn)
	}
	if plan.CoreAction.UnitType == nil || *plan.CoreAction.UnitType != domain.UnitWorker {
		t.Fatalf("spawn unit type = %v, want WORKER", plan.CoreAction.UnitType)
	}
	if intent := plan.Intents["core"]; intent != "spawn" {
		t.Errorf("core intent = %q, want spawn", intent)
	}
	// 计划必须通过语义校验（M4：计划合法性 100%）。
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestDecideNoSpawnWhenResourcesInsufficient：资源不足（WORKER 成本 5）→
// 不 spawn，Core 满血 → 无 Core 动作。
func TestDecideNoSpawnWhenResourcesInsufficient(t *testing.T) {
	state := baseState()
	state.Resources = 4
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no core action with resources 4, got %+v", plan.CoreAction)
	}
}

// TestDecideNoSpawnWhenWorkerTargetMet：Worker 数达到目标 → 不 spawn
// worker（显式 MilitaryRatio=0 排除军事分支）。
func TestDecideNoSpawnWhenWorkerTargetMet(t *testing.T) {
	state := baseState()
	state.Resources = 50
	state.Population = 13 // 默认 workerTarget=13（多场景优化）
	for i := 1; i < 13; i++ {
		id := fmt.Sprintf("worker-%d", i+1)
		state.Units = append(state.Units, domain.UnitSnapshot{
			ID: id, Position: domain.Position{i, 0}, HP: 2, UnitType: domain.UnitWorker,
		})
		state.Workers = append(state.Workers, domain.UnitSnapshot{
			ID: id, Position: domain.Position{i, 0}, HP: 2, UnitType: domain.UnitWorker,
		})
	}
	config := DefaultConfig()
	config.MilitaryRatio = 0
	plan := NewPlanner(config).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no spawn with workers == target, got %+v", plan.CoreAction)
	}
}

// TestDecideNoSpawnWhenPopulationCeilingReached：人口达到上限 → 不 spawn。
func TestDecideNoSpawnWhenPopulationCeilingReached(t *testing.T) {
	state := baseState()
	state.Resources = 50
	state.Population = 30 // 默认 ceiling=30（模拟退火优化后）
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no spawn at population ceiling, got %+v", plan.CoreAction)
	}
}

// TestDecideCoreHealsWhenDamaged：资源不足 spawn + Core 掉血 + Worker≥2 →
// Core HEAL。
func TestDecideCoreHealsWhenDamaged(t *testing.T) {
	state := baseState()
	state.Resources = 4
	state.Core.HP = 2
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "worker-2", Position: domain.Position{1, 0}, HP: 2, UnitType: domain.UnitWorker,
	})
	state.Workers = append(state.Workers, domain.UnitSnapshot{
		ID: "worker-2", Position: domain.Position{1, 0}, HP: 2, UnitType: domain.UnitWorker,
	})
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreHeal {
		t.Fatalf("expected core HEAL, got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestDecideCoreHealRequiresWorkers：掉血但 Worker < 2 → 不治疗（无动作）。
func TestDecideCoreHealRequiresWorkers(t *testing.T) {
	state := baseState()
	state.Resources = 4
	state.Core.HP = 2
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no core action with 1 worker, got %+v", plan.CoreAction)
	}
}

// TestDecideNilCoreEmitsNoCoreAction：无 Core → 无 Core 动作且不 panic。
func TestDecideNilCoreEmitsNoCoreAction(t *testing.T) {
	state := baseState()
	state.Core = nil
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no core action without core, got %+v", plan.CoreAction)
	}
}

// TestDecideMovingCoreEmitsNoCoreAction：Core MOVING → 不 spawn 不治疗。
func TestDecideMovingCoreEmitsNoCoreAction(t *testing.T) {
	state := baseState()
	state.Core.State = domain.CoreMoving
	state.Core.HP = 2
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no core action while core moving, got %+v", plan.CoreAction)
	}
}

// TestWorkerDepositsAtCore：Worker 满载且站在 Core 格 → DEPOSIT。
func TestWorkerDepositsAtCore(t *testing.T) {
	state := baseState()
	state.Units[0].Cargo = 1
	state.Workers[0].Cargo = 1
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionDeposit {
		t.Fatalf("worker action = %s, want DEPOSIT", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "deposit" {
		t.Errorf("intent = %q, want deposit", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestWorkerReturnsToCoreWithCargo：Worker 满载但不在 Core 格 → 向 Core
// 移动（return_core）。
func TestWorkerReturnsToCoreWithCargo(t *testing.T) {
	state := baseState()
	state.Units[0] = domain.UnitSnapshot{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1}
	state.Workers[0] = state.Units[0]
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker action = %s, want MOVE", action.Kind)
	}
	if action.Direction == nil || *action.Direction != domain.DirectionLeft {
		t.Errorf("direction = %v, want LEFT (toward core at origin)", action.Direction)
	}
	if intent := plan.Intents["worker-1"]; intent != "return_core" {
		t.Errorf("intent = %q, want return_core", intent)
	}
}

// TestWorkerWaitsWithoutCoreWhenCarrying：满载但无 Core → WAIT。
func TestWorkerWaitsWithoutCoreWhenCarrying(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.Units[0].Cargo = 1
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("worker action = %s, want WAIT", action.Kind)
	}
}

// TestWorkerHarvestsOnResourceCell：空手站在资源格 → HARVEST。
func TestWorkerHarvestsOnResourceCell(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(0, 0))
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionHarvest {
		t.Fatalf("worker action = %s, want HARVEST", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "harvest" {
		t.Errorf("intent = %q, want harvest", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestWorkerMovesToResourceCell：空手且已知资源格存在 → 向资源格移动
// （to_resource）。
func TestWorkerMovesToResourceCell(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(0, 5))
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "to_resource" {
		t.Errorf("intent = %q, want to_resource", intent)
	}
}

// TestWorkerPatrolsWhenNoResources：无资源格 → 探索巡逻（explore）。
func TestWorkerPatrolsWhenNoResources(t *testing.T) {
	state := baseState()
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "explore" {
		t.Errorf("intent = %q, want explore", intent)
	}
}

// TestWorkerPicksUpBeacon：Beacon 在地上、无携带者、单位站在 Beacon 格 →
// PICKUP_BEACON。
func TestWorkerPicksUpBeacon(t *testing.T) {
	state := baseState()
	state.Beacon = domain.Beacon{Position: domain.Position{4, 4}, Status: domain.BeaconGround}
	state.Units[0] = domain.UnitSnapshot{ID: "worker-1", Position: domain.Position{4, 4}, HP: 2, UnitType: domain.UnitWorker}
	state.Workers[0] = state.Units[0]
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionPickupBeacon {
		t.Fatalf("worker action = %s, want PICKUP_BEACON", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "beacon" {
		t.Errorf("intent = %q, want beacon", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestWorkerBlockedByObstaclesWaits：四周全被障碍围住 → 无法移动 → WAIT
// （moveToward 失败路径）。
func TestWorkerBlockedByObstaclesWaits(t *testing.T) {
	state := baseState()
	state.ObstacleCells = domain.NewSet(
		domain.CellKey(-1, 0), domain.CellKey(1, 0),
		domain.CellKey(0, -1), domain.CellKey(0, 1),
	)
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("worker action = %s, want WAIT when fully blocked", action.Kind)
	}
}

// TestVanguardSweepsAdjacentEnemy：敌人紧邻（相邻格）→ SWEEP AOE（比
// engage 逼近优先，战斗闭环）。
func TestVanguardSweepsAdjacentEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{2, 2}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{2, 3}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionSweep {
		t.Fatalf("vanguard action = %s, want SWEEP (adjacent enemy)", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "sweep" {
		t.Errorf("intent = %q, want sweep", intent)
	}
	if action.Direction == nil || *action.Direction != domain.DirectionDown {
		t.Errorf("direction = %v, want DOWN (enemy at (2,3))", action.Direction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestVanguardSweepOrderDeterministic：四面都有敌人 → 取确定性顺序
// （UP→RIGHT→DOWN→LEFT）第一个。
func TestVanguardSweepOrderDeterministic(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-down", Kind: "UNIT", Position: domain.Position{0, 1}, HP: 4, UnitType: &enemyType},
		{ID: "enemy-up", Kind: "UNIT", Position: domain.Position{0, -1}, HP: 4, UnitType: &enemyType},
		{ID: "enemy-left", Kind: "UNIT", Position: domain.Position{-1, 0}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionSweep || action.Direction == nil || *action.Direction != domain.DirectionUp {
		t.Fatalf("vanguard = %+v, want SWEEP UP (first in yield order)", action)
	}
}

// TestVanguardSweepsEnemyCoreAdjacent：敌方 Core 紧邻 → SWEEP（官方规则：
// 相邻格敌方 Core 也受 1 伤害）。
func TestVanguardSweepsEnemyCoreAdjacent(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{2, 2}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-core", Kind: "CORE", Position: domain.Position{3, 2}, HP: 5},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionSweep || action.Direction == nil || *action.Direction != domain.DirectionRight {
		t.Fatalf("vanguard = %+v, want SWEEP RIGHT (enemy core adjacent)", action)
	}
}

// TestVanguardEngagesNearbyEnemy：敌人进入 ThreatDistance → 前压 engage
// （防御/战斗分支触发）。
func TestVanguardEngagesNearbyEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{2, 2}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{4, 2}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("vanguard action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "engage" {
		t.Errorf("intent = %q, want engage", intent)
	}
	if action.Direction == nil || *action.Direction != domain.DirectionRight {
		t.Errorf("direction = %v, want RIGHT (toward enemy)", action.Direction)
	}
}

// TestVanguardRaidDistantEnemy：敌人超出 ThreatDistance → 不 engage 防御，
// 但军事单位主动出击（激进打野：无近敌时朝可见敌人推进压制对手）。
func TestVanguardRaidDistantEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{6, 0}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("vanguard action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "raid" {
		t.Errorf("intent = %q, want raid", intent)
	}
}

// TestVanguardRaidEnemyCore：可见敌方 Core → Vanguard 朝敌方 Core
// 推进（raid_core——摧毁敌方 Core 捕获其库存资源，官方 v0.9 机制）。
func TestVanguardRaidEnemyCore(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-core", Kind: "CORE", Position: domain.Position{20, 0}, HP: 10},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove || action.Direction == nil {
		t.Fatalf("vanguard action = %+v, want MOVE toward enemy core", action)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "raid_core" {
		t.Errorf("intent = %q, want raid_core", intent)
	}
}

// TestRangerShootsEnemyCoreInRange：敌方 Core 在 Ranger 射程内 →
// SHOOT（打野远程压制；近敌分支优先，intent=shoot）。
func TestRangerShootsEnemyCoreInRange(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{0, 0}, HP: 3, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-core", Kind: "CORE", Position: domain.Position{3, 0}, HP: 10},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionShoot || action.TargetID == nil || *action.TargetID != "enemy-core" {
		t.Fatalf("ranger action = %+v, want SHOOT enemy-core", action)
	}
	// 3 格内走近敌分支（intent=shoot）；行为等价于打野（攻击敌方 Core）。
	if intent := plan.Intents["ranger-1"]; intent != "shoot" && intent != "raid_core" {
		t.Errorf("intent = %q, want shoot or raid_core", intent)
	}
}

// TestRangerRaidsDistantEnemyCore：敌方 Core 超出近敌分支但可见 →
// Ranger 逼近（raid_core 打野出击）。
func TestRangerRaidsDistantEnemyCore(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{0, 0}, HP: 3, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-core", Kind: "CORE", Position: domain.Position{20, 0}, HP: 10},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionMove || action.Direction == nil {
		t.Fatalf("ranger action = %+v, want MOVE toward enemy core", action)
	}
	if intent := plan.Intents["ranger-1"]; intent != "raid_core" {
		t.Errorf("intent = %q, want raid_core", intent)
	}
}

// TestMilitarySpawnsBeforeWorkerTarget：worker 达 MilitarySpawnFloor（6）
// 即产军事（不等 workerTarget 满编——激进产兵）。
func TestMilitarySpawnsBeforeWorkerTarget(t *testing.T) {
	state := baseState()
	state.Resources = 12
	state.ResourceSpace = 10
	state.Population = 7
	state.Units = []domain.UnitSnapshot{
		{ID: "w-1", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-2", Position: domain.Position{1, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-3", Position: domain.Position{2, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-4", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-5", Position: domain.Position{4, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "w-6", Position: domain.Position{5, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Workers = append([]domain.UnitSnapshot(nil), state.Units...)
	config := DefaultConfig() // workerTarget=8 > floor=6
	config.WorkerTarget = 100 // 极端：worker 远未达 target，军事仍应产出

	plan := NewPlanner(config).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn ||
		plan.CoreAction.UnitType == nil || *plan.CoreAction.UnitType != domain.UnitVanguard {
		t.Fatalf("core action = %+v, want SPAWN VANGUARD (floor=6 met, target=100 not)", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestVanguardHealsAtCore：Vanguard 掉血且站在 Core 格 → HEAL。
func TestVanguardHealsAtCore(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionHeal {
		t.Fatalf("vanguard action = %s, want HEAL", action.Kind)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestVanguardReturnsToCoreToHeal：Vanguard 掉血且不在 Core 格 → 回 Core
// （to_core_heal）。Core 被己方占位时 WAIT 排队（目标被占不绕行）。
func TestVanguardReturnsToCoreToHeal(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 3}, HP: 1, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	// Core 被 worker-full（baseState 满载 worker 在 Core 格）占位 →
	// WAIT 排队等占位者离开（不绕行——绕行会占住其他等待者的目标格）。
	if action.Kind != domain.ActionWait {
		t.Fatalf("vanguard action = %s, want WAIT (core occupied)", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "to_core_heal" {
		t.Errorf("intent = %q, want to_core_heal", intent)
	}
}

// TestVanguardPatrolsWhenHealthy：Vanguard 满血无敌人 → 巡逻。
func TestVanguardPatrolsWhenHealthy(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("vanguard action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "patrol" {
		t.Errorf("intent = %q, want patrol", intent)
	}
}

// TestVanguardEngageTieBreakPicksLowerID：两个同距离敌人 → 选 ID 小的
// （确定性平局判定）。
func TestVanguardEngageTieBreakPicksLowerID(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-b", Kind: "UNIT", Position: domain.Position{2, 0}, HP: 4, UnitType: &enemyType},
		{ID: "enemy-a", Kind: "UNIT", Position: domain.Position{0, 2}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	// 两个敌人均曼哈顿距离 2；nearestEnemy 平局取 ID 较小者 enemy-a
	// （在 (0,2)，从原点出发第一步 DOWN）。
	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Direction == nil || *action.Direction != domain.DirectionDown {
		t.Errorf("direction = %v, want DOWN (engage enemy-a)", action.Direction)
	}
}

// TestRangerShootsVisibleEnemy：Ranger 视野内直线可见敌人（Chebyshev ≤ 3）→
// SHOOT（带 target_id + expected_cell）。
func TestRangerShootsVisibleEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{5, 2}, HP: 4, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionShoot {
		t.Fatalf("ranger action = %s, want SHOOT", action.Kind)
	}
	if action.TargetID == nil || *action.TargetID != "enemy-1" {
		t.Errorf("target_id = %v, want enemy-1", action.TargetID)
	}
	if action.ExpectedCell == nil || *action.ExpectedCell != (domain.Position{5, 2}) {
		t.Errorf("expected_cell = %v, want [5 2]", action.ExpectedCell)
	}
	if intent := plan.Intents["ranger-1"]; intent != "shoot" {
		t.Errorf("intent = %q, want shoot", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestRangerSkipsShootWhenLineBlocked：敌人可见但视线被障碍遮挡 → 不
// SHOOT（转 raid：逼近敌人绕开障碍再打——激进打野语义）。
func TestRangerSkipsShootWhenLineBlocked(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{5, 2}, HP: 4, UnitType: &enemyType},
	}
	state.ObstacleCells = domain.NewSet(domain.CellKey(5, 3))
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind == domain.ActionShoot {
		t.Fatalf("expected no SHOOT through obstacle, got %+v", action)
	}
	if intent := plan.Intents["ranger-1"]; intent != "raid" {
		t.Errorf("intent = %q, want raid (advance around obstacle)", intent)
	}
}

// TestRangerHealsAtCore：Ranger 掉血站在 Core 格 → HEAL。
func TestRangerHealsAtCore(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{0, 0}, HP: 1, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionHeal {
		t.Fatalf("ranger action = %s, want HEAL", action.Kind)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestRangerPatrolsWhenNoEnemies：Ranger 无敌人满血 → 巡逻。
func TestRangerPatrolsWhenNoEnemies(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("ranger action = %s, want MOVE", action.Kind)
	}
	if intent := plan.Intents["ranger-1"]; intent != "patrol" {
		t.Errorf("intent = %q, want patrol", intent)
	}
}

// TestDecideNoUnitsProducesEmptyPlan：无单位无 Core → 空计划，无非法动作。
func TestDecideNoUnitsProducesEmptyPlan(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.Units = nil
	state.Workers = nil
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if len(plan.UnitActions) != 0 {
		t.Fatalf("expected empty unit actions, got %v", plan.UnitActions)
	}
	if plan.CoreAction != nil {
		t.Fatalf("expected no core action, got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestDecideIgnoresUnknownUnitType：未知单位类型 → 不为该单位产出动作。
func TestDecideIgnoresUnknownUnitType(t *testing.T) {
	state := baseState()
	state.Units = []domain.UnitSnapshot{
		{ID: "mystery-1", Position: domain.Position{0, 0}, HP: 2, UnitType: "MECH"},
	}
	state.Workers = nil
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if _, ok := plan.UnitActions["mystery-1"]; ok {
		t.Fatalf("expected no action for unknown unit type, got %v", plan.UnitActions)
	}
}

// TestDecideZeroValueStateNoPanic：零值状态（Decide 不接受 nil 实参，
// 按任务约定构造零值）→ 不 panic、产出空计划。
func TestDecideZeroValueStateNoPanic(t *testing.T) {
	state := &domain.TickState{}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan == nil {
		t.Fatal("expected non-nil plan for zero-value state")
	}
	if len(plan.UnitActions) != 0 {
		t.Errorf("expected empty actions, got %v", plan.UnitActions)
	}
}

// TestConfigCombinationsDoNotPanic：极端/零值/负值配置组合均不 panic。
func TestConfigCombinationsDoNotPanic(t *testing.T) {
	configs := []Config{
		{},
		{WorkerTarget: -5, PopulationCeiling: -1, ExploreRadius: 0, ThreatDistance: -1},
		{WorkerTarget: 1000, PopulationCeiling: 1000, ExploreRadius: 64, ThreatDistance: 100},
		{WorkerTarget: 0, PopulationCeiling: 0, ExploreRadius: 1, ThreatDistance: 1},
		{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5},
	}
	for index, config := range configs {
		t.Run(fmt.Sprintf("config-%d", index), func(t *testing.T) {
			state := baseState()
			state.Core.HP = 2
			state.Resources = 0
			plan := NewPlanner(config).Decide(state)
			if plan == nil {
				t.Fatal("expected non-nil plan")
			}
			// 无 Core 变体同样不 panic。
			noCore := baseState()
			noCore.Core = nil
			if plan := NewPlanner(config).Decide(noCore); plan == nil {
				t.Fatal("expected non-nil plan without core")
			}
		})
	}
}

// TestLargeUnitListPerformance：200 单位决策 < 400ms（防 O(n²) 查找与
// 导航搜索爆炸）。单位散布在资源格附近，BFS 边界框小，测的是真实热点：
// decideUnit 的逐单位线性查找。预算说明：本机实测基线 ~140-160ms
// （200 单位 × 有界 BFS）；per-unit 巡逻目标分散后目标分布更广，实测
// 波动至 270ms（机器负载敏感）；400ms 仍远低于 15s tick 窗口，同时
// 能拦截数量级回归。
func TestLargeUnitListPerformance(t *testing.T) {
	state := baseState()
	unitCount := 200
	state.Units = make([]domain.UnitSnapshot, 0, unitCount)
	state.Workers = make([]domain.UnitSnapshot, 0, unitCount)
	resourcePosition := domain.Position{20, 20}
	for i := 0; i < unitCount; i++ {
		id := fmt.Sprintf("worker-%03d", i)
		unit := domain.UnitSnapshot{
			ID: id,
			Position: domain.Position{
				resourcePosition[0] + i%9,
				resourcePosition[1] + i/9,
			},
			HP: 2, UnitType: domain.UnitWorker,
		}
		state.Units = append(state.Units, unit)
		state.Workers = append(state.Workers, unit)
	}
	state.ResourceCells = domain.NewSet(domain.CellKey(resourcePosition[0], resourcePosition[1]))

	start := time.Now()
	plan := NewPlanner(DefaultConfig()).Decide(state)
	elapsed := time.Since(start)

	if len(plan.UnitActions) != unitCount {
		t.Fatalf("expected actions for all %d units, got %d", unitCount, len(plan.UnitActions))
	}
	if elapsed >= 400*time.Millisecond {
		t.Errorf("decide on %d units took %v, want < 400ms", unitCount, elapsed)
	}
}

// TestPatrolPerUnitIndependent：per-unit 巡逻状态互不干扰——同一 tick
// 多个单位各持自己的目标（先前全局共享 exploreIndex 每 tick 换方向，
// 单位原地打转；新语义为单位持久目标）。
func TestPatrolPerUnitIndependent(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	// 三个 worker 分布在三个位置（同格同目标会触发移动仲裁降级，非本测试关注）。
	state.Workers = []domain.UnitSnapshot{
		{ID: "worker-a", Position: domain.Position{0, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "worker-b", Position: domain.Position{5, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		{ID: "worker-c", Position: domain.Position{0, 5}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Units = append([]domain.UnitSnapshot(nil), state.Workers...)
	planner := NewPlanner(DefaultConfig())

	first := planner.Decide(state)
	// 首目标方向按 beacon 方位（同一初始 dir=0）：三单位方向一致可接受；
	// 关键回归是"单位不随全局索引每 tick 换方向"——模拟移动后方向持久。
	var firstDirections []domain.Direction
	for _, worker := range state.Workers {
		action := requireUnitAction(t, first, worker.ID)
		if action.Kind != domain.ActionMove || action.Direction == nil {
			t.Fatalf("%s action = %+v, want MOVE", worker.ID, action)
		}
		firstDirections = append(firstDirections, *action.Direction)
	}

	// 各单位沿自己的方向移动一格后，下一 tick 方向必须保持。
	for i, worker := range state.Workers {
		state.Workers[i].Position = domain.Move(worker.Position, firstDirections[i])
		state.Units[i].Position = state.Workers[i].Position
	}
	state.Tick = 2
	second := planner.Decide(state)
	for i, worker := range state.Workers {
		action := requireUnitAction(t, second, worker.ID)
		if action.Kind != domain.ActionMove || action.Direction == nil {
			t.Fatalf("%s second action = %+v, want MOVE", worker.ID, action)
		}
		if *action.Direction != firstDirections[i] {
			t.Errorf("%s direction changed %v → %v, want persistent per-unit target",
				worker.ID, firstDirections[i], *action.Direction)
		}
	}
}

// TestMilitarySpawnAfterWorkerTarget：worker 达 target + 军事占比不足 →
// 先产 Vanguard（防御优先）。
func TestMilitarySpawnAfterWorkerTarget(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker},
	})
	state.Resources = 50
	config := Config{WorkerTarget: 3, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25}
	plan := NewPlanner(config).Decide(state)

	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("core action = %+v, want SPAWN", plan.CoreAction)
	}
	if plan.CoreAction.UnitType == nil || *plan.CoreAction.UnitType != domain.UnitVanguard {
		t.Errorf("unit type = %v, want VANGUARD (military ratio 25%% of 3 pop = 1)", plan.CoreAction.UnitType)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestMilitarySpawnAlternatesRanger：已有 1 Vanguard → 下一个军事是 Ranger。
func TestMilitarySpawnAlternatesRanger(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker},
	})
	state.Resources = 50
	state.Vanguards = []domain.UnitSnapshot{{ID: "vanguard-1", Position: domain.Position{5, 5}, HP: 4, UnitType: domain.UnitVanguard}}
	state.Units = append(state.Units, state.Vanguards[0])
	config := Config{WorkerTarget: 3, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 50}
	plan := NewPlanner(config).Decide(state)

	if plan.CoreAction == nil || plan.CoreAction.UnitType == nil {
		t.Fatalf("core action = %+v, want SPAWN RANGER", plan.CoreAction)
	}
	if *plan.CoreAction.UnitType != domain.UnitRanger {
		t.Errorf("unit type = %v, want RANGER (2nd military alternates)", plan.CoreAction.UnitType)
	}
}

// TestMilitarySpawnDisabledByRatioZero：MilitaryRatio=0 → 不产军事。
func TestMilitarySpawnDisabledByRatioZero(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker},
	})
	state.Resources = 50
	config := Config{WorkerTarget: 3, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 0}
	plan := NewPlanner(config).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("core action = %+v, want nil (military disabled)", plan.CoreAction)
	}
}
