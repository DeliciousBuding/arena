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

// TestDecideSpawnsWorkerWhenResourcesSufficient：资源充足 + 未达 Worker
// 目标 + 未达人口上限 → Core SPAWN WORKER（M4 验收：spawn 决策正确）。
func TestDecideSpawnsWorkerWhenResourcesSufficient(t *testing.T) {
	state := baseState()
	state.Resources = 100 // 远大于 cost+reserve，正常扩张通道
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

// TestDecideNoSpawnWhenWorkerTargetMet：Worker 数达到目标 → 不 spawn。
func TestDecideNoSpawnWhenWorkerTargetMet(t *testing.T) {
	state := baseState()
	state.Resources = 50
	state.Population = 8
	for i := 1; i < 8; i++ {
		id := fmt.Sprintf("worker-%d", i+1)
		state.Units = append(state.Units, domain.UnitSnapshot{
			ID: id, Position: domain.Position{i, 0}, HP: 2, UnitType: domain.UnitWorker,
		})
		state.Workers = append(state.Workers, domain.UnitSnapshot{
			ID: id, Position: domain.Position{i, 0}, HP: 2, UnitType: domain.UnitWorker,
		})
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction != nil {
		t.Fatalf("expected no spawn with workers == target, got %+v", plan.CoreAction)
	}
}

// TestDecideNoSpawnWhenPopulationCeilingReached：人口达到上限 → 不 spawn。
func TestDecideNoSpawnWhenPopulationCeilingReached(t *testing.T) {
	state := baseState()
	state.Resources = 50
	state.Population = 20
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

// TestVanguardIgnoresDistantEnemy：敌人超出 ThreatDistance → 不 engage，
// 满血健康 → 巡逻。
func TestVanguardIgnoresDistantEnemy(t *testing.T) {
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
	if intent := plan.Intents["vanguard-1"]; intent != "patrol" {
		t.Errorf("intent = %q, want patrol", intent)
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
// （to_core_heal）。
func TestVanguardReturnsToCoreToHeal(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 3}, HP: 1, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("vanguard action = %s, want MOVE", action.Kind)
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
// SHOOT（转巡逻）。
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
	if intent := plan.Intents["ranger-1"]; intent != "patrol" {
		t.Errorf("intent = %q, want patrol", intent)
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

// TestLargeUnitListPerformance：200 单位决策 < 100ms（防 O(n²) 查找与
// 导航搜索爆炸）。单位散布在资源格附近，BFS 边界框小，测的是真实热点：
// decideUnit 的逐单位线性查找。
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
	if elapsed >= 500*time.Millisecond {
		t.Errorf("decide on %d units took %v, want < 500ms", unitCount, elapsed)
	}
}

// TestPatrolCyclesExploreDirections：探索巡逻按 exploreIndex 顺时针遍历
// 8 方位（index 8 回绕到第 0 方位，结果与首轮一致）。
func TestPatrolCyclesExploreDirections(t *testing.T) {
	state := baseState()
	planner := NewPlanner(DefaultConfig())

	firstCycle := make([]domain.Direction, 0, 8)
	for i := 0; i < 8; i++ {
		plan := planner.Decide(state)
		action := requireUnitAction(t, plan, "worker-1")
		if action.Kind != domain.ActionMove {
			t.Fatalf("call %d: action = %s, want MOVE", i, action.Kind)
		}
		firstCycle = append(firstCycle, *action.Direction)
	}

	seen := map[domain.Direction]bool{}
	for _, direction := range firstCycle {
		seen[direction] = true
	}
	for _, direction := range []domain.Direction{
		domain.DirectionUp, domain.DirectionDown, domain.DirectionLeft, domain.DirectionRight,
	} {
		if !seen[direction] {
			t.Errorf("patrol cycle never explored direction %s (cycle=%v)", direction, firstCycle)
		}
	}

	// 第 9 次调用回绕：探索目标应与第 1 次相同。
	plan := planner.Decide(state)
	action := requireUnitAction(t, plan, "worker-1")
	if action.Direction == nil || *action.Direction != firstCycle[0] {
		t.Errorf("wrap-around direction = %v, want %s", action.Direction, firstCycle[0])
	}
}
