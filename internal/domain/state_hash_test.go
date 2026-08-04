package domain

import "testing"

func TestHashStateStable(t *testing.T) {
	state := reduceFixture(t, 40437)
	first := HashState(state)
	second := HashState(state)
	if first != second {
		t.Errorf("hash must be stable: %s != %s", first, second)
	}
	if state.StateHash != first {
		t.Errorf("reducer state hash must equal HashState output")
	}
}

// TestHashStateFieldOrderIndependent 验证字段顺序无关：两种构造方式
// （赋值顺序/集合插入顺序不同）的等值状态产生相同哈希。
func TestHashStateFieldOrderIndependent(t *testing.T) {
	buildA := func() *TickState {
		status := PlayerStatusActive
		units := []UnitSnapshot{
			{ID: "u1", Position: Position{1, 1}, HP: 2, UnitType: UnitWorker, Cargo: 1},
			{ID: "u2", Position: Position{2, 2}, HP: 4, UnitType: UnitVanguard},
		}
		core := &Core{ID: "c1", Position: Position{0, 0}, HP: 5, Shield: 5,
			State: CoreNormal, OwnerUsername: "fixture_user"}
		enemyType := UnitVanguard
		enemies := []VisibleEntity{
			{ID: "e1", Kind: "UNIT", Position: Position{0, 3}, HP: 4, UnitType: &enemyType},
		}
		state := &TickState{Tick: 7, Status: status}
		state.Resources = 3
		state.ResourceCapacity = 15
		state.ResourceSpace = 12
		state.Population = 3
		state.Core = core
		state.Units = units
		state.Workers = units[:1]
		state.Vanguards = units[1:]
		state.VisibleEnemies = enemies
		state.ResourceCells = NewSet(CellKey(5, 5), CellKey(6, 6))
		state.ObstacleCells = NewSet(CellKey(9, 9))
		state.Beacon = Beacon{Position: Position{-1, 1}, Status: BeaconGround}
		return state
	}
	buildB := func() *TickState {
		// 相同的值，不同的赋值顺序与集合插入顺序。
		status := PlayerStatusActive
		state := &TickState{Resources: 3, Population: 3, Tick: 7, Status: status}
		state.ObstacleCells = NewSet(CellKey(9, 9))
		state.ResourceCells = NewSet(CellKey(6, 6), CellKey(5, 5))
		state.Beacon = Beacon{Position: Position{-1, 1}, Status: BeaconGround}
		state.Core = &Core{OwnerUsername: "fixture_user", State: CoreNormal, Shield: 5, HP: 5,
			Position: Position{0, 0}, ID: "c1"}
		state.Rangers = nil
		state.Workers = []UnitSnapshot{
			{ID: "u1", Position: Position{1, 1}, HP: 2, UnitType: UnitWorker, Cargo: 1},
		}
		state.Vanguards = []UnitSnapshot{
			{ID: "u2", Position: Position{2, 2}, HP: 4, UnitType: UnitVanguard},
		}
		state.Units = append(append([]UnitSnapshot{}, state.Workers...), state.Vanguards...)
		enemyType := UnitVanguard
		state.VisibleEnemies = []VisibleEntity{
			{ID: "e1", Kind: "UNIT", Position: Position{0, 3}, HP: 4, UnitType: &enemyType},
		}
		state.ResourceCapacity = 15
		state.ResourceSpace = 12
		return state
	}
	if HashState(buildA()) != HashState(buildB()) {
		t.Error("equal states built differently must hash equally")
	}
}

func TestHashStateSensitiveToChanges(t *testing.T) {
	base := reduceFixture(t, 40437)
	hash := HashState(base)

	changedResources := reduceFixture(t, 40437)
	changedResources.Resources++
	if HashState(changedResources) == hash {
		t.Error("resources change must alter hash")
	}

	changedObstacle := reduceFixture(t, 40437)
	changedObstacle.ObstacleCells = changedObstacle.ObstacleCells.Clone()
	changedObstacle.ObstacleCells.Add(CellKey(0, 0))
	if HashState(changedObstacle) == hash {
		t.Error("obstacle change must alter hash")
	}

	changedUnit := reduceFixture(t, 40437)
	changedUnit.Units = append([]UnitSnapshot(nil), changedUnit.Units...)
	changedUnit.Units[0].HP++
	if HashState(changedUnit) == hash {
		t.Error("unit change must alter hash")
	}

	noEvents := reduceFixture(t, 40437)
	noEvents.Events = nil
	if HashState(noEvents) == hash {
		t.Error("events change must alter hash")
	}
}

// TestHashStateExcludesStateHash 验证 StateHash 字段本身不参与哈希。
func TestHashStateExcludesStateHash(t *testing.T) {
	state := reduceFixture(t, 40437)
	hash := HashState(state)
	state.StateHash = "deadbeef"
	if HashState(state) != hash {
		t.Error("StateHash must not participate in hashing")
	}
}

// TestHashStateNumericStability 验证数值稳定序列化：整值浮点与整数等价。
func TestHashStateNumericStability(t *testing.T) {
	build := func(values map[string]any) *TickState {
		return &TickState{
			Tick:          1,
			Status:        PlayerStatusActive,
			ResourceCells: make(Set[string]),
			ObstacleCells: make(Set[string]),
			Events: []Event{
				{EventID: "e1", Tick: 1, EventType: "HARVEST_SUCCEEDED", Values: values},
			},
		}
	}
	intHash := HashState(build(map[string]any{"amount": 1, "ok": true}))
	floatHash := HashState(build(map[string]any{"amount": float64(1), "ok": true}))
	if intHash != floatHash {
		t.Error("integral float must hash identically to int")
	}
	fractionHash := HashState(build(map[string]any{"amount": 1.5, "ok": true}))
	if fractionHash == intHash {
		t.Error("fractional value must hash differently")
	}
}

// TestHashStateStringEscaping 验证字符串转义确定性（引号/反斜杠/控制字符）。
func TestHashStateStringEscaping(t *testing.T) {
	build := func(owner string) *TickState {
		return &TickState{
			Tick:          1,
			Status:        PlayerStatusActive,
			ResourceCells: make(Set[string]),
			ObstacleCells: make(Set[string]),
			Core: &Core{ID: "c1", Position: Position{0, 0}, HP: 5, Shield: 5,
				State: CoreNormal, OwnerUsername: owner},
		}
	}
	weird := "user\"with\\backslash\nand\ttab\x01"
	first := HashState(build(weird))
	second := HashState(build(weird))
	if first != second {
		t.Error("escaping must be deterministic")
	}
	if first == HashState(build("plain")) {
		t.Error("escaped content must hash differently from plain content")
	}
}
