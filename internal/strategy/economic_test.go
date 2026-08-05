package strategy

import (
	"bytes"
	"encoding/json"
	"sort"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// ---- Lane 2 经济化专项测试：全局分配 / 移动容量仲裁 / workerTarget
// reserve / respawn override / 确定性 ----

// workerState 构造带给定 worker 的确定性状态（Core 在原点 NORMAL，
// 无资源格、无敌人；Population 与 worker 数一致）。
func workerState(workers []domain.UnitSnapshot) *domain.TickState {
	state := baseState()
	state.Workers = workers
	state.Units = append([]domain.UnitSnapshot(nil), workers...)
	state.Population = len(workers)
	return state
}

// cellSet 从坐标列表构造资源格集合。
func cellSet(cells ...domain.Position) domain.Set[string] {
	keys := make([]string, 0, len(cells))
	for _, cell := range cells {
		keys = append(keys, domain.CellKey(cell[0], cell[1]))
	}
	return domain.NewSet(keys...)
}

// sortedAssignments 把分配结果编码为确定性行（键升序），用于深比较。
func sortedAssignments(assignments map[string]domain.Position) []string {
	keys := make([]string, 0, len(assignments))
	for key := range assignments {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rows := make([]string, 0, len(keys))
	for _, key := range keys {
		cell := assignments[key]
		rows = append(rows, key+"="+domain.CellKey(cell[0], cell[1]))
	}
	return rows
}

// --- 全局分配 ---

// TestAssignWorkersTwoWorkersThreeCellsDistinctTargets：2 worker + 3 资源格
// → 各自分到最近的未占用格，目标格互不相同。
func TestAssignWorkersTwoWorkersThreeCellsDistinctTargets(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{5, 5}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 5}, domain.Position{5, 0}, domain.Position{3, 3})

	assignments := assignWorkers(state)
	if len(assignments) != 2 {
		t.Fatalf("assignments = %v, want 2 entries", assignments)
	}
	// worker-1: (0,5) d5 / (5,0) d5 平局取 x 小 → (0,5)；(3,3) d6 更远。
	if assignments["worker-1"] != (domain.Position{0, 5}) {
		t.Errorf("worker-1 target = %v, want [0 5]", assignments["worker-1"])
	}
	// worker-2: (3,3) d4 最近。
	if assignments["worker-2"] != (domain.Position{3, 3}) {
		t.Errorf("worker-2 target = %v, want [3 3]", assignments["worker-2"])
	}
	if assignments["worker-1"] == assignments["worker-2"] {
		t.Fatalf("workers share a target cell: %v", assignments)
	}
}

// TestAssignWorkersFiveWorkersTwoCellsOnlyTwoAssigned：5 worker + 2 资源格
// → 只有 2 个拿到不同资源格，其余不参与（不会再去抢同一格）。
func TestAssignWorkersFiveWorkersTwoCellsOnlyTwoAssigned(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-4", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-5", Position: domain.Position{4, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 5}, domain.Position{10, 10})

	assignments := assignWorkers(state)
	if len(assignments) != 2 {
		t.Fatalf("assignments = %v, want exactly 2 entries", assignments)
	}
	if assignments["worker-1"] == assignments["worker-2"] {
		t.Fatalf("assigned workers share a cell: %v", assignments)
	}
	for _, id := range []string{"worker-3", "worker-4", "worker-5"} {
		if _, ok := assignments[id]; ok {
			t.Errorf("worker %s should be unassigned, got %v", id, assignments[id])
		}
	}
}

// TestAssignWorkersNearestByManhattanNotLexicographic：分配按曼哈顿最近，
// 而非旧版的字典序最小格（(0,6) 字典序更小但 (3,2) 更近）。
func TestAssignWorkersNearestByManhattanNotLexicographic(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 6}, domain.Position{3, 2})

	assignments := assignWorkers(state)
	if assignments["worker-1"] != (domain.Position{3, 2}) {
		t.Errorf("worker-1 target = %v, want [3 2] (nearest by Manhattan)", assignments["worker-1"])
	}
}

// TestAssignWorkersTieBreakSmallerXThenY：同曼哈顿距离平局 → 取 x 小、
// 再 y 小的格。
func TestAssignWorkersTieBreakSmallerXThenY(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{2, 2}, domain.Position{1, 3})

	assignments := assignWorkers(state)
	if assignments["worker-1"] != (domain.Position{1, 3}) {
		t.Errorf("worker-1 target = %v, want [1 3] (tie-break smaller x)", assignments["worker-1"])
	}
}

// TestAssignWorkersHarvesterClaimsItsCell：已站在资源格上的 worker 本 tick
// 直接 HARVEST，其所在格被占用，其他 worker 不得再分配同格。
func TestAssignWorkersHarvesterClaimsItsCell(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{2, 2}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{10, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{2, 2}, domain.Position{10, 2})

	assignments := assignWorkers(state)
	// worker-1 站在 (2,2) 上开采，不进入分配；worker-2 只能拿 (10,2)。
	if _, ok := assignments["worker-1"]; ok {
		t.Errorf("harvesting worker-1 should not be assigned, got %v", assignments["worker-1"])
	}
	if assignments["worker-2"] != (domain.Position{10, 2}) {
		t.Errorf("worker-2 target = %v, want [10 2] (cell (2,2) claimed)", assignments["worker-2"])
	}
}

// TestAssignWorkersCarryingWorkerExcluded：满载 worker 走回仓/上交流程，
// 不参与资源分配（不占用候选格）。
func TestAssignWorkersCarryingWorkerExcluded(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-2", Position: domain.Position{5, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{5, 2})

	assignments := assignWorkers(state)
	if _, ok := assignments["worker-1"]; ok {
		t.Errorf("carrying worker-1 should not be assigned, got %v", assignments["worker-1"])
	}
	if assignments["worker-2"] != (domain.Position{5, 2}) {
		t.Errorf("worker-2 target = %v, want [5 2]", assignments["worker-2"])
	}
}

// TestAssignWorkersDeterministicAcrossCalls：含平局的多 worker 场景，
// 两次分配结果逐项一致（map 迭代无序不引入抖动）。
func TestAssignWorkersDeterministicAcrossCalls(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 1}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 2}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 4}, domain.Position{4, 0}, domain.Position{2, 4}, domain.Position{4, 2})

	first := sortedAssignments(assignWorkers(state))
	second := sortedAssignments(assignWorkers(state))
	if len(first) != 3 {
		t.Fatalf("assignments = %v, want 3 entries", first)
	}
	if len(first) != len(second) {
		t.Fatalf("assignment count differs across calls: %v vs %v", first, second)
	}
	for i := range first {
		if first[i] != second[i] {
			t.Errorf("assignment differs: %v vs %v", first, second)
			break
		}
	}
}

// TestAssignWorkersNoCellsEmptyAssignment：无可见资源格 → 空分配，不 panic。
func TestAssignWorkersNoCellsEmptyAssignment(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = domain.NewSet[string]()

	assignments := assignWorkers(state)
	if len(assignments) != 0 {
		t.Fatalf("assignments = %v, want empty", assignments)
	}
}

// --- 全局分配在 Decide 中的落地 ---

// TestWorkerMovesToAssignedCell：两个 worker 各自走向分配格
// （to_resource），目标格互不相同。
func TestWorkerMovesToAssignedCell(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{2, 2}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 3}, domain.Position{0, 5})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	// worker-1: (0,0)→(0,3) 直线 DOWN 无阻挡（worker-2 已移开，不挡路）。
	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker-1 action = %s, want MOVE", action.Kind)
	}
	if action.Direction == nil || *action.Direction != domain.DirectionDown {
		t.Errorf("worker-1 direction = %v, want DOWN", action.Direction)
	}
	if intent := plan.Intents["worker-1"]; intent != "to_resource" {
		t.Errorf("worker-1 intent = %q, want to_resource", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestWorkerWithoutAssignmentExplores：资源格不足时，未分到格的 worker
// 正常期转探索（explore），不抢占已分配格。
func TestWorkerWithoutAssignmentExplores(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{0, 2}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 3}, domain.Position{0, 5})
	state.Beacon = domain.Beacon{Position: domain.Position{10, 0}, Status: domain.BeaconGround}

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if intent := plan.Intents["worker-1"]; intent != "to_resource" {
		t.Errorf("worker-1 intent = %q, want to_resource", intent)
	}
	if intent := plan.Intents["worker-2"]; intent != "to_resource" {
		t.Errorf("worker-2 intent = %q, want to_resource", intent)
	}
	action := requireUnitAction(t, plan, "worker-3")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker-3 action = %s, want MOVE (explore)", action.Kind)
	}
	if intent := plan.Intents["worker-3"]; intent != "explore" {
		t.Errorf("worker-3 intent = %q, want explore", intent)
	}
}

// TestDecideFiveWorkersTwoCellsOnlyTwoGoToResource：5 worker + 2 格 → 计划
// 中只有 2 个 to_resource，其余不 HARVEST 同格（转探索）。
func TestDecideFiveWorkersTwoCellsOnlyTwoGoToResource(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{2, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-4", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-5", Position: domain.Position{4, 0}, UnitType: domain.UnitWorker},
	})
	state.ResourceCells = cellSet(domain.Position{0, 5}, domain.Position{10, 10})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	toResource := 0
	explores := 0
	for _, id := range []string{"worker-1", "worker-2", "worker-3", "worker-4", "worker-5"} {
		action := requireUnitAction(t, plan, id)
		switch plan.Intents[id] {
		case "to_resource":
			toResource++
			if action.Kind != domain.ActionMove {
				t.Errorf("%s: to_resource must be a MOVE, got %s", id, action.Kind)
			}
		case "explore":
			explores++
		case "harvest":
			t.Errorf("%s: no worker may harvest a shared cell", id)
		default:
			t.Errorf("%s: unexpected intent %q", id, plan.Intents[id])
		}
	}
	if toResource != 2 {
		t.Errorf("to_resource count = %d, want 2", toResource)
	}
	if explores != 3 {
		t.Errorf("explore count = %d, want 3", explores)
	}
}

// --- 移动容量仲裁 ---

// TestMoveCapacityReturnBeatsToResource：满载回仓（return_core）与采资源
// （to_resource）争同一目标格 → 回仓保留，采资源让路 WAIT。
func TestMoveCapacityReturnBeatsToResource(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	state.Core = &domain.Core{
		ID: "core-1", Position: domain.Position{2, 0}, HP: domain.CoreMaxHP,
		Shield: domain.CoreMaxShield, State: domain.CoreNormal,
	}
	state.ResourceCells = cellSet(domain.Position{2, 0})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	// worker-1 回仓：从 (3,0) 向左 → (2,0)；worker-2 采 (2,0)：从 (1,0)
	// 向右 → (2,0)。目标格冲突 → 高优先级（return）保留。
	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove || action.Direction == nil || *action.Direction != domain.DirectionLeft {
		t.Fatalf("worker-1 action = %+v, want MOVE LEFT", action)
	}
	loser := requireUnitAction(t, plan, "worker-2")
	if loser.Kind != domain.ActionWait {
		t.Fatalf("worker-2 action = %s, want WAIT (lost capacity arbitration)", loser.Kind)
	}
	if intent := plan.Intents["worker-2"]; intent != "capacity_wait:to_resource" {
		t.Errorf("worker-2 intent = %q, want capacity_wait:to_resource", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestMoveCapacityReturnBeatsExplore：回仓与探索争同一目标格 → 回仓保留，
// 探索让路（deposit 优先级胜过 explore）。
func TestMoveCapacityReturnBeatsExplore(t *testing.T) {
	// 函数级仲裁验证（patrol 目标按 ID 分散后，Decide 链路的 explore
	// 目标格不可控——直接验证优先级排序）。
	candidates := []moveCandidate{
		{unitID: "worker-2", destination: domain.Position{2, 0}, priority: movePriorityFor("explore"), intent: "explore"},
		{unitID: "worker-1", destination: domain.Position{2, 0}, priority: movePriorityFor("return_core"), intent: "return_core"},
	}
	losers := arbitrateMoveCapacity(candidates)
	if len(losers) != 1 || losers[0].unitID != "worker-2" {
		t.Fatalf("losers = %+v, want [worker-2] (explore demoted by return)", losers)
	}
	if losers[0].intent != "explore" {
		t.Errorf("loser intent = %q, want explore", losers[0].intent)
	}
}

// TestMoveCapacityTieBreakKeepsLowerUnitID：同优先级争同一目标格 →
// 保留 ID 升序最小者，其余 WAIT。
func TestMoveCapacityTieBreakKeepsLowerUnitID(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-2", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
	})
	state.Core = &domain.Core{
		ID: "core-1", Position: domain.Position{2, 0}, HP: domain.CoreMaxHP,
		Shield: domain.CoreMaxShield, State: domain.CoreNormal,
	}

	plan := NewPlanner(DefaultConfig()).Decide(state)
	winner := requireUnitAction(t, plan, "worker-1")
	if winner.Kind != domain.ActionMove || winner.Direction == nil || *winner.Direction != domain.DirectionLeft {
		t.Fatalf("worker-1 action = %+v, want MOVE LEFT", winner)
	}
	loser := requireUnitAction(t, plan, "worker-2")
	if loser.Kind != domain.ActionWait {
		t.Fatalf("worker-2 action = %s, want WAIT (tie-break lower ID)", loser.Kind)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestMoveCapacityDistinctTargetsUnaffected：目标格不同的单位互不影响，
// 全部保留 MOVE。
func TestMoveCapacityDistinctTargetsUnaffected(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
	})
	state.Core = &domain.Core{
		ID: "core-1", Position: domain.Position{2, 0}, HP: domain.CoreMaxHP,
		Shield: domain.CoreMaxShield, State: domain.CoreNormal,
	}
	state.ResourceCells = cellSet(domain.Position{5, 1})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	for _, id := range []string{"worker-1", "worker-2"} {
		action := requireUnitAction(t, plan, id)
		if action.Kind != domain.ActionMove {
			t.Fatalf("%s action = %s, want MOVE (distinct targets)", id, action.Kind)
		}
	}
}

// TestMoveCapacityEngageBeatsExplore：战斗（engage）与探索争同一目标格
// → 战斗保留，探索让路。
func TestMoveCapacityEngageBeatsExplore(t *testing.T) {
	// 函数级仲裁验证（patrol 目标按 ID 分散后，Decide 链路不可控）。
	candidates := []moveCandidate{
		{unitID: "worker-1", destination: domain.Position{3, 2}, priority: movePriorityFor("explore"), intent: "explore"},
		{unitID: "vanguard-1", destination: domain.Position{3, 2}, priority: movePriorityFor("engage"), intent: "engage"},
	}
	losers := arbitrateMoveCapacity(candidates)
	if len(losers) != 1 || losers[0].unitID != "worker-1" {
		t.Fatalf("losers = %+v, want [worker-1] (explore demoted by engage)", losers)
	}
}

// --- workerTarget 消费：reserve guard + 紧急通道 ---

// TestSpawnBlockedBelowCostPlusReserve：worker 充足（≥2）时正常扩张需
// resources >= cost + reserve；不足 → 不 spawn。
func TestSpawnBlockedBelowCostPlusReserve(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	cost := domain.SpawnCost(domain.UnitWorker)
	state.Resources = cost // 刚好 cost，缺 reserve

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("resources = cost with 2 workers: expected no spawn (reserve guard), got %+v", plan.CoreAction)
	}
}

// TestSpawnAllowedAtCostPlusReserve：resources >= cost + reserve → 正常
// 扩张通道 spawn。
func TestSpawnAllowedAtCostPlusReserve(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	state.Resources = domain.SpawnCost(domain.UnitWorker) + DefaultConfig().SpawnReserve

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("expected SPAWN at cost+reserve, got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestSpawnEmergencyNoWorkersSpawnsAtCost：0 worker 紧急通道 →
// resources >= cost 即 spawn（无视 reserve）。
func TestSpawnEmergencyNoWorkersSpawnsAtCost(t *testing.T) {
	state := baseState()
	state.Workers = nil
	state.Units = nil
	state.Population = 0
	state.Resources = domain.SpawnCost(domain.UnitWorker)

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("expected SPAWN (emergency, 0 workers), got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestSpawnEmergencySingleWorkerSpawnsAtCost：1 worker（低于补员紧急线）
// → resources >= cost 即 spawn。
func TestSpawnEmergencySingleWorkerSpawnsAtCost(t *testing.T) {
	state := baseState() // 1 worker，resources = 5 = cost
	plan := NewPlanner(DefaultConfig()).Decide(state)

	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("expected SPAWN (emergency, 1 worker), got %+v", plan.CoreAction)
	}
}

// TestSpawnReserveConfigurableZeroSpawnsAtCost：reserve 可配；配置为 0 时
// worker 充足的正常扩张也只要 cost。
func TestSpawnReserveConfigurableZeroSpawnsAtCost(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	state.Resources = domain.SpawnCost(domain.UnitWorker)
	config := DefaultConfig()
	config.SpawnReserve = 0

	plan := NewPlanner(config).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("expected SPAWN with SpawnReserve=0, got %+v", plan.CoreAction)
	}
}

// --- respawn override ---

// TestRespawnNilCoreWorkerHoldsPosition：Core 缺失恢复期，无资源格 →
// worker 原地待命（defend），不探索远处；无 Core 动作。
func TestRespawnNilCoreWorkerHoldsPosition(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.ResourceCells = domain.NewSet[string]()

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("expected no core action without core, got %+v", plan.CoreAction)
	}
	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("worker action = %s, want WAIT during recovery", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "defend" {
		t.Errorf("intent = %q, want defend", intent)
	}
}

// TestRespawnNilCoreWorkerHarvestsNearestResource：恢复期仍采最近资源
// （经济重建），不探索远处。
func TestRespawnNilCoreWorkerHarvestsNearestResource(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.ResourceCells = cellSet(domain.Position{0, 3})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("worker action = %s, want MOVE to nearest resource", action.Kind)
	}
	if intent := plan.Intents["worker-1"]; intent != "to_resource" {
		t.Errorf("intent = %q, want to_resource", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestRespawnStatusRespawningSpawnsAtCostIgnoringReserve：RESPAWNING 恢复
// 期走紧急通道，resources == cost 即 spawn（无视 reserve）。
func TestRespawnStatusRespawningSpawnsAtCostIgnoringReserve(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
	})
	state.Status = domain.PlayerStatusRespawning
	state.Resources = domain.SpawnCost(domain.UnitWorker)

	plan := NewPlanner(DefaultConfig()).Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("expected SPAWN during respawn (no reserve), got %+v", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestRespawnMovingCoreVanguardReturnsToCore：Core MOVING 恢复期，健康的
// Vanguard 回核心防守（defend），不巡逻。
func TestRespawnMovingCoreVanguardReturnsToCore(t *testing.T) {
	state := baseState()
	state.Core.State = domain.CoreMoving
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 3}, HP: domain.UnitMaxHP(domain.UnitVanguard), UnitType: domain.UnitVanguard,
	})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionMove || action.Direction == nil || *action.Direction != domain.DirectionUp {
		t.Fatalf("vanguard action = %+v, want MOVE UP (back to core)", action)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "defend" {
		t.Errorf("intent = %q, want defend", intent)
	}
}

// TestRespawnMovingCoreVanguardAtCoreWaits：恢复期已在 Core 格的健康单位
// 原地待命（defend），不巡逻。
func TestRespawnMovingCoreVanguardAtCoreWaits(t *testing.T) {
	state := baseState()
	state.Core.State = domain.CoreMoving
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{0, 0}, HP: domain.UnitMaxHP(domain.UnitVanguard), UnitType: domain.UnitVanguard,
	})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("vanguard action = %s, want WAIT at core during recovery", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "defend" {
		t.Errorf("intent = %q, want defend", intent)
	}
}

// TestRespawnNilCoreVanguardHoldsPosition：Core 缺失恢复期，Vanguard
// 原地待命（defend），不巡逻远处。
func TestRespawnNilCoreVanguardHoldsPosition(t *testing.T) {
	state := baseState()
	state.Core = nil
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{5, 5}, HP: domain.UnitMaxHP(domain.UnitVanguard), UnitType: domain.UnitVanguard,
	})

	plan := NewPlanner(DefaultConfig()).Decide(state)
	action := requireUnitAction(t, plan, "vanguard-1")
	if action.Kind != domain.ActionWait {
		t.Fatalf("vanguard action = %s, want WAIT without core during recovery", action.Kind)
	}
	if intent := plan.Intents["vanguard-1"]; intent != "defend" {
		t.Errorf("intent = %q, want defend", intent)
	}
}

// --- 确定性 ---

// TestDecideDeterministicSameInputSameOutput：同输入两次 Decide 序列化
// 字节完全一致（覆盖全局分配 + 冲突仲裁路径）。
func TestDecideDeterministicSameInputSameOutput(t *testing.T) {
	state := workerState([]domain.UnitSnapshot{
		{ID: "worker-1", Position: domain.Position{0, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-2", Position: domain.Position{0, 1}, UnitType: domain.UnitWorker},
		{ID: "worker-3", Position: domain.Position{1, 0}, UnitType: domain.UnitWorker},
		{ID: "worker-4", Position: domain.Position{1, 1}, UnitType: domain.UnitWorker},
		{ID: "worker-5", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
		{ID: "worker-6", Position: domain.Position{3, 0}, UnitType: domain.UnitWorker, Cargo: 1},
	})
	state.Core = &domain.Core{
		ID: "core-1", Position: domain.Position{2, 0}, HP: domain.CoreMaxHP,
		Shield: domain.CoreMaxShield, State: domain.CoreNormal,
	}
	state.ResourceCells = cellSet(domain.Position{0, 4}, domain.Position{4, 0}, domain.Position{1, 5}, domain.Position{5, 1})
	state.Resources = 50

	planner := NewPlanner(DefaultConfig())
	first := planner.Decide(state)
	second := NewPlanner(DefaultConfig()).Decide(state)
	third := planner.Decide(state) // 同一实例再次调用同样确定

	bytesA, errA := json.Marshal(first)
	bytesB, errB := json.Marshal(second)
	bytesC, errC := json.Marshal(third)
	if errA != nil || errB != nil || errC != nil {
		t.Fatalf("marshal plan: %v / %v / %v", errA, errB, errC)
	}
	if !bytes.Equal(bytesA, bytesB) {
		t.Fatalf("fresh planners differ:\nA=%s\nB=%s", bytesA, bytesB)
	}
	if !bytes.Equal(bytesA, bytesC) {
		t.Fatalf("same planner twice differs:\nA=%s\nC=%s", bytesA, bytesC)
	}
}
