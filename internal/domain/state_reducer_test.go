package domain

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// TestReduceFixture40437 是 B3-B 验收事实断言：resources=1、population=3、
// 3 个 WORKER、CORE @[20,-97] hp5/shield5、beacon @[-17,77]、obstacle 10 格。
func TestReduceFixture40437(t *testing.T) {
	state := reduceFixture(t, 40437)

	if state.Tick != 40437 {
		t.Errorf("tick = %d, want 40437", state.Tick)
	}
	if state.Status != PlayerStatusActive {
		t.Errorf("status = %q, want ACTIVE", state.Status)
	}
	if state.Resources != 1 {
		t.Errorf("resources = %d, want 1", state.Resources)
	}
	if state.Population != 3 {
		t.Errorf("population = %d, want 3", state.Population)
	}
	if state.PopulationTier != 0 {
		t.Errorf("population_tier = %d, want 0", state.PopulationTier)
	}
	if state.UpkeepNextTick != 0 {
		t.Errorf("upkeep_next_tick = %d, want 0", state.UpkeepNextTick)
	}
	// 核心容量公式：max(minCapacity=10, population*5) = 15。
	if state.ResourceCapacity != 15 {
		t.Errorf("resource_capacity = %d, want 15", state.ResourceCapacity)
	}
	if state.ResourceSpace != 14 {
		t.Errorf("resource_space = %d, want 14", state.ResourceSpace)
	}

	if state.Core == nil {
		t.Fatal("core is nil")
	}
	if state.Core.ID != "d2d5a983-d24d-4763-a01a-9a658bc35010" {
		t.Errorf("core id = %q", state.Core.ID)
	}
	if state.Core.Position != (Position{20, -97}) {
		t.Errorf("core position = %v, want [20 -97]", state.Core.Position)
	}
	if state.Core.HP != 5 || state.Core.Shield != 5 {
		t.Errorf("core hp/shield = %d/%d, want 5/5", state.Core.HP, state.Core.Shield)
	}
	if state.Core.State != CoreNormal {
		t.Errorf("core state = %q, want NORMAL", state.Core.State)
	}
	if state.Core.OwnerUsername != "fixture_user" {
		t.Errorf("core owner = %q", state.Core.OwnerUsername)
	}

	if len(state.Units) != 3 {
		t.Fatalf("units = %d, want 3", len(state.Units))
	}
	for _, unit := range state.Units {
		if unit.UnitType != UnitWorker {
			t.Errorf("unit %s type = %q, want WORKER", unit.ID, unit.UnitType)
		}
	}
	if state.Units[0].ID != "312e4dbf-d356-49ef-b599-691ef3f7c9e8" ||
		state.Units[1].ID != "9c8ee7d0-f25c-420f-9ed7-c4997540a14b" ||
		state.Units[2].ID != "b1db4ce5-08df-485f-a5d6-2a8982621a9c" {
		t.Errorf("units not sorted by id: %q %q %q",
			state.Units[0].ID, state.Units[1].ID, state.Units[2].ID)
	}
	if state.Units[0].Position != (Position{20, -86}) || state.Units[0].HP != 2 || state.Units[0].Cargo != 1 {
		t.Errorf("unit 312e4dbf = %+v", state.Units[0])
	}
	if state.Units[1].Cargo != 0 || state.Units[2].Cargo != 0 {
		t.Errorf("worker cargo must pass through: %d %d", state.Units[1].Cargo, state.Units[2].Cargo)
	}

	if len(state.Workers) != 3 || len(state.Vanguards) != 0 || len(state.Rangers) != 0 {
		t.Errorf("classification wrong: workers=%d vanguards=%d rangers=%d",
			len(state.Workers), len(state.Vanguards), len(state.Rangers))
	}
	if len(state.VisibleEnemies) != 0 {
		t.Errorf("visible enemies = %d, want 0", len(state.VisibleEnemies))
	}
	if state.ResourceCells.Len() != 0 {
		t.Errorf("resource cells = %d, want 0", state.ResourceCells.Len())
	}
	if state.ObstacleCells.Len() != 10 {
		t.Errorf("obstacle cells = %d, want 10", state.ObstacleCells.Len())
	}
	for _, key := range []string{"17,-86", "24,-98", "20,-102", "19,-84"} {
		if !state.ObstacleCells.Contains(key) {
			t.Errorf("obstacle cell %q missing", key)
		}
	}

	if state.Beacon.Position != (Position{-17, 77}) {
		t.Errorf("beacon position = %v, want [-17 77]", state.Beacon.Position)
	}
	if state.Beacon.Status != "" {
		t.Errorf("beacon status = %q, want empty (server did not report)", state.Beacon.Status)
	}
	if state.Beacon.CarrierID != nil {
		t.Errorf("beacon carrier = %v, want nil", *state.Beacon.CarrierID)
	}

	if len(state.Events) != 3 {
		t.Fatalf("events = %d, want 3", len(state.Events))
	}
	if state.Events[0].EventID != "419de2eb-4e97-4053-8282-f2eae03cec3a" ||
		state.Events[0].Tick != 40436 ||
		state.Events[0].EventType != "UNIT_MOVE_SUCCEEDED" ||
		state.Events[0].ActorID == nil ||
		*state.Events[0].ActorID != "312e4dbf-d356-49ef-b599-691ef3f7c9e8" ||
		state.Events[0].Position == nil ||
		*state.Events[0].Position != (Position{20, -86}) {
		t.Errorf("event[0] = %+v", state.Events[0])
	}

	if len(state.StateHash) != 64 {
		t.Errorf("state hash = %q, want 64 hex chars", state.StateHash)
	}
	if HashState(state) != state.StateHash {
		t.Errorf("state hash must match HashState output")
	}
}

// TestReduceUnitClassification 覆盖三类单位的分类与敌方提取。
func TestReduceUnitClassification(t *testing.T) {
	controlled := true
	record := &contracts.DifferentialRecord{
		Status:     contracts.PlayerStatusActive,
		Resources:  7,
		Population: 3,
		ChampionBeacon: contracts.ChampionBeacon{
			Position: contracts.Position{1, 1},
		},
		Objects: []contracts.Object{
			{Kind: contracts.ObjectKindUnit, ID: "w1", Controlled: &controlled,
				Position: &contracts.Position{1, 2}, HP: intPtr(2), UnitType: string(contracts.UnitTypeWorker)},
			{Kind: contracts.ObjectKindUnit, ID: "v1", Controlled: &controlled,
				Position: &contracts.Position{2, 2}, HP: intPtr(4), UnitType: string(contracts.UnitTypeVanguard)},
			{Kind: contracts.ObjectKindUnit, ID: "r1", Controlled: &controlled,
				Position: &contracts.Position{3, 2}, HP: intPtr(2), UnitType: string(contracts.UnitTypeRanger)},
			{Kind: contracts.ObjectKindUnit, ID: "e1", Controlled: boolPtr(false),
				Position: &contracts.Position{4, 2}, HP: intPtr(4), UnitType: string(contracts.UnitTypeVanguard)},
		},
	}
	state, err := Reduce(record, 10)
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	if len(state.Units) != 3 {
		t.Fatalf("units = %d, want 3", len(state.Units))
	}
	if len(state.Workers) != 1 || len(state.Vanguards) != 1 || len(state.Rangers) != 1 {
		t.Errorf("classification wrong: %d/%d/%d",
			len(state.Workers), len(state.Vanguards), len(state.Rangers))
	}
	if len(state.VisibleEnemies) != 1 {
		t.Fatalf("enemies = %d, want 1", len(state.VisibleEnemies))
	}
	enemy := state.VisibleEnemies[0]
	if enemy.ID != "e1" || enemy.Kind != "UNIT" || enemy.Position != (Position{4, 2}) ||
		enemy.HP != 4 || enemy.UnitType == nil || *enemy.UnitType != UnitVanguard {
		t.Errorf("enemy = %+v", enemy)
	}
	if state.ResourceCapacity != 15 || state.ResourceSpace != 8 {
		t.Errorf("capacity = %d space = %d, want 15/8", state.ResourceCapacity, state.ResourceSpace)
	}
}

// TestReduceEnemyFromFixture 用 40440 的敌方 VANGUARD 验证敌方提取。
func TestReduceEnemyFromFixture(t *testing.T) {
	state := reduceFixture(t, 40440)
	if len(state.VisibleEnemies) != 1 {
		t.Fatalf("enemies = %d, want 1", len(state.VisibleEnemies))
	}
	enemy := state.VisibleEnemies[0]
	if enemy.ID != "c063e04a-643e-4fea-a79f-0662466ba055" {
		t.Errorf("enemy id = %q", enemy.ID)
	}
	if enemy.Position != (Position{36, 50}) || enemy.HP != 4 {
		t.Errorf("enemy = %+v", enemy)
	}
	if enemy.UnitType == nil || *enemy.UnitType != UnitVanguard {
		t.Errorf("enemy unit type = %v", enemy.UnitType)
	}
	if len(state.Units) != 5 {
		t.Errorf("units = %d, want 5", len(state.Units))
	}
}

// TestReduceResourceCellFromFixture 用 40457 的 RESOURCE 格验证资源格收集。
func TestReduceResourceCellFromFixture(t *testing.T) {
	state := reduceFixture(t, 40457)
	if state.ResourceCells.Len() != 1 {
		t.Fatalf("resource cells = %d, want 1", state.ResourceCells.Len())
	}
	if !state.ResourceCells.Contains("38,45") {
		t.Errorf("resource cell 38,45 missing: %v", state.ResourceCells)
	}
}

// TestReduceCoreMoving 验证 MOVING 状态的 Core 归约。
func TestReduceCoreMoving(t *testing.T) {
	controlled := true
	state := contracts.CoreStateMoving
	record := &contracts.DifferentialRecord{
		Status:     contracts.PlayerStatusActive,
		Population: 2,
		ChampionBeacon: contracts.ChampionBeacon{
			Position: contracts.Position{0, 0},
		},
		Objects: []contracts.Object{
			{Kind: contracts.ObjectKindCore, ID: "core-1", Controlled: &controlled,
				Position: &contracts.Position{5, 5}, HP: intPtr(3), Shield: intPtr(2),
				State: string(state)},
		},
	}
	reduced, err := Reduce(record, 42)
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	if reduced.Core == nil || reduced.Core.State != CoreMoving {
		t.Fatalf("core state = %v, want MOVING", reduced.Core)
	}
	if reduced.Core.Position != (Position{5, 5}) || reduced.Core.HP != 3 || reduced.Core.Shield != 2 {
		t.Errorf("core = %+v", reduced.Core)
	}
	if reduced.ResourceCapacity != 10 {
		t.Errorf("capacity = %d, want min 10", reduced.ResourceCapacity)
	}
}

// TestReduceBeaconCarried 验证 beacon 透传（CARRIED + carrier）。
func TestReduceBeaconCarried(t *testing.T) {
	status := contracts.BeaconStatusCarried
	carrier := "unit-9"
	record := &contracts.DifferentialRecord{
		Status:     contracts.PlayerStatusActive,
		Population: 1,
		ChampionBeacon: contracts.ChampionBeacon{
			Position:  contracts.Position{3, 4},
			Status:    &status,
			CarrierID: &carrier,
		},
	}
	state, err := Reduce(record, 5)
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	if state.Beacon.Status != BeaconCarried {
		t.Errorf("beacon status = %q, want CARRIED", state.Beacon.Status)
	}
	if state.Beacon.CarrierID == nil || *state.Beacon.CarrierID != "unit-9" {
		t.Errorf("beacon carrier = %v", state.Beacon.CarrierID)
	}
	if state.Beacon.Position != (Position{3, 4}) {
		t.Errorf("beacon position = %v", state.Beacon.Position)
	}
}

// TestReduceCargoOnlyForWorkers 验证 cargo 仅 WORKER 有效。
func TestReduceCargoOnlyForWorkers(t *testing.T) {
	controlled := true
	record := &contracts.DifferentialRecord{
		Status:     contracts.PlayerStatusActive,
		Population: 3,
		ChampionBeacon: contracts.ChampionBeacon{
			Position: contracts.Position{0, 0},
		},
		Objects: []contracts.Object{
			{Kind: contracts.ObjectKindUnit, ID: "w-no-cargo", Controlled: &controlled,
				Position: &contracts.Position{0, 1}, HP: intPtr(2), UnitType: string(contracts.UnitTypeWorker)},
			{Kind: contracts.ObjectKindUnit, ID: "w-cargo", Controlled: &controlled,
				Position: &contracts.Position{0, 2}, HP: intPtr(2), UnitType: string(contracts.UnitTypeWorker),
				Cargo: intPtr(2)},
			{Kind: contracts.ObjectKindUnit, ID: "v-cargo", Controlled: &controlled,
				Position: &contracts.Position{0, 3}, HP: intPtr(4), UnitType: string(contracts.UnitTypeVanguard),
				Cargo: intPtr(3)},
		},
	}
	state, err := Reduce(record, 7)
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	byID := make(map[string]UnitSnapshot, len(state.Units))
	for _, unit := range state.Units {
		byID[unit.ID] = unit
	}
	if byID["w-no-cargo"].Cargo != 0 {
		t.Errorf("worker without cargo = %d, want 0", byID["w-no-cargo"].Cargo)
	}
	if byID["w-cargo"].Cargo != 2 {
		t.Errorf("worker cargo = %d, want 2", byID["w-cargo"].Cargo)
	}
	if byID["v-cargo"].Cargo != 0 {
		t.Errorf("vanguard cargo = %d, want 0", byID["v-cargo"].Cargo)
	}
}

// TestReduceRespawningStatus 验证 RESPAWNING 状态透传。
func TestReduceRespawningStatus(t *testing.T) {
	respawnTick := 100
	record := &contracts.DifferentialRecord{
		Status:        contracts.PlayerStatusRespawning,
		RespawnAtTick: &respawnTick,
		Population:    0,
		ChampionBeacon: contracts.ChampionBeacon{
			Position: contracts.Position{0, 0},
		},
	}
	state, err := Reduce(record, 90)
	if err != nil {
		t.Fatalf("reduce: %v", err)
	}
	if state.Status != PlayerStatusRespawning {
		t.Errorf("status = %q, want RESPAWNING", state.Status)
	}
	if state.Core != nil {
		t.Errorf("core must be nil while respawning")
	}
}

// TestReduceRejectsInvalidInput 验证非法输入的拒绝。
func TestReduceRejectsInvalidInput(t *testing.T) {
	if _, err := Reduce(nil, 1); err == nil {
		t.Error("nil record must error")
	}
	record := &contracts.DifferentialRecord{
		Status:     contracts.PlayerStatusActive,
		Population: 1,
		ChampionBeacon: contracts.ChampionBeacon{
			Position: contracts.Position{0, 0},
		},
	}
	if _, err := Reduce(record, 0); err == nil {
		t.Error("tick 0 must error")
	}
	if _, err := Reduce(record, -3); err == nil {
		t.Error("negative tick must error")
	}
}

func intPtr(value int) *int {
	return &value
}

func boolPtr(value bool) *bool {
	return &value
}
