package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// baseState 构造最小合法状态（健康 Core 在原点、一个 worker、无资源）。
func baseState() *domain.TickState {
	return &domain.TickState{
		Tick:             1,
		Status:           domain.PlayerStatusActive,
		Resources:        0,
		ResourceCapacity: 10,
		ResourceSpace:    10,
		Population:       1,
		Core: &domain.Core{
			ID: "core-1", Position: domain.Position{0, 0}, HP: domain.CoreMaxHP,
			Shield: domain.CoreMaxShield, State: domain.CoreNormal,
		},
		Units: []domain.UnitSnapshot{
			{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		Workers:        []domain.UnitSnapshot{{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0}},
		ResourceCells:  domain.NewSet[string](),
		ObstacleCells:  domain.NewSet[string](),
		VisibleEnemies: nil,
	}
}

func moveAction(dir domain.Direction) domain.UnitAction {
	return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}
}

// TestSettleMovesUnit：MOVE 结算移动位置。
func TestSettleMovesUnit(t *testing.T) {
	state := baseState()
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Moves != 1 || result.Stats.Blocked != 0 {
		t.Fatalf("stats = %+v, want 1 move 0 blocked", result.Stats)
	}
	if got := result.NextState.Units[0].Position; got != (domain.Position{2, 0}) {
		t.Fatalf("unit position = %v, want [2 0]", got)
	}
}

// TestSettleBlocksObstacle：目标格为障碍 → 不移动（MOVE_BLOCKED_OBSTACLE）。
func TestSettleBlocksObstacle(t *testing.T) {
	state := baseState()
	state.ObstacleCells = domain.NewSet(domain.CellKey(2, 0))
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Moves != 0 || result.Stats.Blocked != 1 {
		t.Fatalf("stats = %+v, want 0 moves 1 blocked", result.Stats)
	}
	if got := result.NextState.Units[0].Position; got != (domain.Position{3, 0}) {
		t.Fatalf("unit position = %v, want unchanged [3 0]", got)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "MOVE_BLOCKED" && event.ReasonCode != nil && *event.ReasonCode == "MOVE_BLOCKED_OBSTACLE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected MOVE_BLOCKED_OBSTACLE event, got %+v", result.Events)
	}
}

// TestSettleBlocksBoundary：地图边界外禁止移动。
func TestSettleBlocksBoundary(t *testing.T) {
	state := baseState()
	state.Units[0].Position = domain.Position{-1000, 0}
	state.Workers[0].Position = domain.Position{-1000, 0}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Blocked != 1 {
		t.Fatalf("blocked = %d, want 1 (boundary)", result.Stats.Blocked)
	}
}

// TestSettleBlocksOccupiedCell：目标格被其他单位占据 → 不移动。
func TestSettleBlocksOccupiedCell(t *testing.T) {
	state := baseState()
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "worker-2", Position: domain.Position{2, 0}, HP: 2, UnitType: domain.UnitWorker,
	})
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Moves != 0 || result.Stats.Blocked != 1 {
		t.Fatalf("stats = %+v, want 0 moves 1 blocked (occupied)", result.Stats)
	}
}

// TestSettleHarvestAddsCargo：worker 站在资源格 → HARVEST +1 cargo。
func TestSettleHarvestAddsCargo(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(3, 0))
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": {Kind: domain.ActionHarvest},
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Harvests != 1 {
		t.Fatalf("harvests = %d, want 1", result.Stats.Harvests)
	}
	if got := result.NextState.Units[0].Cargo; got != 1 {
		t.Fatalf("cargo = %d, want 1", got)
	}
}

// TestSettleHarvestFailsWithoutResource：worker 不在资源格 → HARVEST 失败。
func TestSettleHarvestFailsWithoutResource(t *testing.T) {
	state := baseState() // 无资源格
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": {Kind: domain.ActionHarvest},
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Harvests != 0 {
		t.Fatalf("harvests = %d, want 0", result.Stats.Harvests)
	}
	if got := result.NextState.Units[0].Cargo; got != 0 {
		t.Fatalf("cargo = %d, want 0", got)
	}
}

// TestSettleDepositAddsResources：worker 带 cargo 站 Core 格 → DEPOSIT 入仓。
func TestSettleDepositAddsResources(t *testing.T) {
	state := baseState()
	state.Units[0].Cargo = 3
	state.Workers[0].Cargo = 3
	state.Units[0].Position = domain.Position{0, 0}
	state.Workers[0].Position = domain.Position{0, 0}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": {Kind: domain.ActionDeposit},
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.Deposits != 1 || result.Stats.ResourceDelta != 3 {
		t.Fatalf("stats = %+v, want 1 deposit delta 3", result.Stats)
	}
	if got := result.NextState.Resources; got != 3 {
		t.Fatalf("resources = %d, want 3", got)
	}
	if got := result.NextState.Units[0].Cargo; got != 0 {
		t.Fatalf("cargo = %d, want 0 after deposit", got)
	}
}

// TestSettleDepositRespectsCapacity：容量上限丢弃超出部分（REJECTED 事件）。
func TestSettleDepositRespectsCapacity(t *testing.T) {
	state := baseState()
	state.Resources = 9
	state.Units[0].Cargo = 3
	state.Workers[0].Cargo = 3
	state.Units[0].Position = domain.Position{0, 0}
	state.Workers[0].Position = domain.Position{0, 0}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": {Kind: domain.ActionDeposit},
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ResourceDelta != 1 {
		t.Fatalf("resourceDelta = %d, want 1 (capacity limited)", result.Stats.ResourceDelta)
	}
	if got := result.NextState.Resources; got != 10 {
		t.Fatalf("resources = %d, want 10 (capacity cap)", got)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "DEPOSIT_REJECTED_CAPACITY" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected DEPOSIT_REJECTED_CAPACITY event, got %+v", result.Events)
	}
}

// TestSettleDoesNotMutateInput：结算不修改输入 state（深拷贝语义）。
func TestSettleDoesNotMutateInput(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(3, 0))
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": {Kind: domain.ActionHarvest},
		},
	}
	before := *state
	NewEngine().Settle(state, plan)
	if state.Units[0].Cargo != before.Units[0].Cargo {
		t.Fatalf("input mutated: cargo %d -> %d", before.Units[0].Cargo, state.Units[0].Cargo)
	}
	if state.Resources != before.Resources {
		t.Fatalf("input mutated: resources %d -> %d", before.Resources, state.Resources)
	}
}

// TestSettleDeterministic：同输入两次结算结果一致。
func TestSettleDeterministic(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(4, 0), domain.CellKey(5, 0))
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		},
	}
	first := NewEngine().Settle(state, plan)
	second := NewEngine().Settle(state, plan)
	if first.NextState.Units[0].Position != second.NextState.Units[0].Position {
		t.Fatal("determinism broken: position differs")
	}
	if first.Stats != second.Stats {
		t.Fatalf("determinism broken: stats %+v vs %+v", first.Stats, second.Stats)
	}
	if len(first.Events) != len(second.Events) {
		t.Fatal("determinism broken: event count differs")
	}
}

// TestSettleFullCycle：完整经济闭环（移动→采集→回仓→存款）。
func TestSettleFullCycle(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(3, 0))
	// tick 1: worker 在资源格上采集
	harvestPlan := &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{
		"worker-1": {Kind: domain.ActionHarvest},
	}}
	result1 := NewEngine().Settle(state, harvestPlan)
	if result1.NextState.Units[0].Cargo != 1 {
		t.Fatalf("after harvest cargo = %d, want 1", result1.NextState.Units[0].Cargo)
	}
	// tick 2-4: worker 回仓（每次一格，3 步到 Core 格）
	state2 := result1.NextState
	for step := 0; step < 3; step++ {
		returnPlan := &domain.Plan{Tick: 2 + step, UnitActions: map[string]domain.UnitAction{
			"worker-1": moveAction(domain.DirectionLeft),
		}}
		state2 = NewEngine().Settle(state2, returnPlan).NextState
	}
	if state2.Units[0].Position != (domain.Position{0, 0}) {
		t.Fatalf("worker not at core: %v", state2.Units[0].Position)
	}
	depositPlan := &domain.Plan{Tick: 5, UnitActions: map[string]domain.UnitAction{
		"worker-1": {Kind: domain.ActionDeposit},
	}}
	result3 := NewEngine().Settle(state2, depositPlan)
	if result3.NextState.Resources != 1 {
		t.Fatalf("resources = %d, want 1 (full cycle)", result3.NextState.Resources)
	}
	if result3.NextState.Units[0].Cargo != 0 {
		t.Fatalf("cargo = %d, want 0", result3.NextState.Units[0].Cargo)
	}
}
