package domain

import "testing"

// worldState 构造 Observe 输入状态。
func worldState(tick int) *TickState {
	return &TickState{
		Tick:          tick,
		Status:        PlayerStatusActive,
		ObstacleCells: make(Set[string]),
		ResourceCells: make(Set[string]),
	}
}

func TestWorldObstaclePersistence(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.ObstacleCells = keySet(Position{10, 10}, Position{20, 20})
	world.Observe(state1)
	state2 := worldState(2)
	state2.ObstacleCells = keySet(Position{30, 30})
	world.Observe(state2)

	obstacles := world.Obstacles(nil)
	for _, key := range []string{"10,10", "20,20", "30,30"} {
		if !obstacles.Contains(key) {
			t.Errorf("obstacle %s must persist across ticks", key)
		}
	}
	if obstacles.Len() != 3 {
		t.Errorf("obstacles = %d, want 3", obstacles.Len())
	}
	// 返回副本：修改不影响内部记忆。
	obstacles.Add("99,99")
	if world.Obstacles(nil).Contains("99,99") {
		t.Error("Obstacles must return a copy")
	}
}

func TestWorldResourceLifecycle(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.ResourceCells = keySet(Position{5, 5})
	world.Observe(state1)

	snapshot := world.Snapshot()
	if len(snapshot.Resources) != 1 || snapshot.Resources[0].State != ResourceStateVisible ||
		snapshot.Resources[0].FirstSeenTick != 1 {
		t.Fatalf("resource memory = %+v", snapshot.Resources)
	}

	// 未再可见 → stale；firstSeen 保留。
	world.Observe(worldState(3))
	snapshot = world.Snapshot()
	if len(snapshot.Resources) != 1 || snapshot.Resources[0].State != ResourceStateStale {
		t.Fatalf("resource must turn stale: %+v", snapshot.Resources)
	}

	// 重新可见 → visible，firstSeen 保持 1。
	state10 := worldState(10)
	state10.ResourceCells = keySet(Position{5, 5})
	world.Observe(state10)
	snapshot = world.Snapshot()
	if snapshot.Resources[0].State != ResourceStateVisible || snapshot.Resources[0].FirstSeenTick != 1 {
		t.Errorf("resource re-visible state = %+v", snapshot.Resources[0])
	}

	// 长时间不可见 → TTL 过期删除（lastSeen=10，tick 75 时 75-10=65 > 64）。
	world.Observe(worldState(75))
	if got := world.Snapshot().Resources; len(got) != 0 {
		t.Errorf("stale resource must expire after TTL: %+v", got)
	}
}

func TestWorldHarvestEvents(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.ResourceCells = keySet(Position{3, 3}, Position{4, 4})
	world.Observe(state1)

	// HARVEST_SUCCEEDED @3,3 → harvested。
	state2 := worldState(2)
	state2.Events = []Event{
		{EventType: "HARVEST_SUCCEEDED", Position: posPtr(Position{3, 3})},
	}
	world.Observe(state2)
	snapshot := world.Snapshot()
	if len(snapshot.Resources) != 2 {
		t.Fatalf("resources = %d, want 2", len(snapshot.Resources))
	}
	byCell := make(map[string]ResourceSnapshot, len(snapshot.Resources))
	for _, resource := range snapshot.Resources {
		byCell[resource.Cell] = resource
	}
	if byCell["3,3"].State != ResourceStateHarvested {
		t.Errorf("3,3 state = %q, want harvested", byCell["3,3"].State)
	}
	if byCell["4,4"].State != ResourceStateStale {
		t.Errorf("4,4 state = %q, want stale (not visible, not harvested)", byCell["4,4"].State)
	}

	// HARVEST_FAILED @4,4 → stale + failedCells 冷却排除。
	state3 := worldState(3)
	state3.Events = []Event{
		{EventType: "HARVEST_FAILED", Position: posPtr(Position{4, 4})},
	}
	world.Observe(state3)
	hints := world.ResourceHints(8, 4)
	for _, hint := range hints {
		if hint == (Position{4, 4}) {
			t.Errorf("failed cell must be excluded within cooldown: %v", hints)
		}
	}
}

func TestWorldEnemyMemoryMerge(t *testing.T) {
	world := NewWorld()
	state5 := worldState(5)
	state5.VisibleEnemies = []VisibleEntity{
		{ID: "e1", Kind: "UNIT", Position: Position{1, 1}, HP: 2, UnitType: unitTypePtr(UnitVanguard)},
	}
	world.Observe(state5)

	state6 := worldState(6)
	state6.VisibleEnemies = []VisibleEntity{
		{ID: "e1", Kind: "UNIT", Position: Position{2, 2}, HP: 1},
	}
	world.Observe(state6)

	hints := world.EnemyHints(6)
	if len(hints) != 1 {
		t.Fatalf("enemy hints = %d, want 1", len(hints))
	}
	if hints[0].Position != (Position{2, 2}) || hints[0].LastSeenTick != 6 {
		t.Errorf("enemy memory not refreshed: %+v", hints[0])
	}

	// 超过 maxAge 后不再出现。
	world.Observe(worldState(20))
	if got := world.EnemyHints(6); len(got) != 0 {
		t.Errorf("stale enemy must be filtered: %+v", got)
	}
}

func TestWorldResetOnTickRegression(t *testing.T) {
	world := NewWorld()
	state100 := worldState(100)
	state100.ObstacleCells = keySet(Position{1, 1})
	state100.ResourceCells = keySet(Position{2, 2})
	world.Observe(state100)

	if world.WorldResetCount != 0 || world.LastWorldResetTick != nil {
		t.Fatalf("no reset expected yet: %d %v", world.WorldResetCount, world.LastWorldResetTick)
	}

	// tick 回退（世界重置）→ 全清 + 计数。
	state50 := worldState(50)
	world.Observe(state50)
	if world.WorldResetCount != 1 {
		t.Errorf("reset count = %d, want 1", world.WorldResetCount)
	}
	if world.LastWorldResetTick == nil || *world.LastWorldResetTick != 50 {
		t.Errorf("last reset tick = %v, want 50", world.LastWorldResetTick)
	}
	if got := world.Obstacles(nil); got.Len() != 0 {
		t.Errorf("obstacles must be cleared after reset: %v", got)
	}
	if got := world.Snapshot().Resources; len(got) != 0 {
		t.Errorf("resources must be cleared after reset: %+v", got)
	}
}

func TestWorldUnitMemoryLifecycle(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.Units = []UnitSnapshot{{ID: "u1", Position: Position{0, 0}, HP: 2, UnitType: UnitWorker}}
	world.Observe(state1)

	memory := world.UnitMemory("u1", 3)
	if memory.WorkerMode != WorkerModePatrol || memory.PatrolDirection != 3 ||
		memory.PatrolStarted || memory.HarvestTarget != nil || memory.LastTick != 1 {
		t.Fatalf("default unit memory = %+v", memory)
	}
	memory.WorkerMode = WorkerModeGoHarvest
	memory.PatrolStarted = true

	// 同 id 再次获取：状态保留。
	again := world.UnitMemory("u1", 99)
	if again.WorkerMode != WorkerModeGoHarvest || !again.PatrolStarted {
		t.Errorf("unit memory not persistent: %+v", again)
	}
	if world.Snapshot().UnitModes["u1"] != WorkerModeGoHarvest {
		t.Errorf("snapshot unit mode = %q", world.Snapshot().UnitModes["u1"])
	}

	// 单位死亡（不在 live units）→ 记忆剔除。
	world.Observe(worldState(2))
	if _, ok := world.Snapshot().UnitModes["u1"]; ok {
		t.Error("unit memory must be pruned when unit is dead")
	}
}

func TestWorldMovementObstacles(t *testing.T) {
	world := NewWorld()
	state10 := worldState(10)
	state10.Units = []UnitSnapshot{{ID: "u1", Position: Position{0, 0}, HP: 2, UnitType: UnitWorker}}
	state10.Events = []Event{
		{EventType: "UNIT_MOVE_FAILED", ActorID: strPtr("u1"),
			ReasonCode: strPtr("MOVE_CONTESTED"), Position: posPtr(Position{5, 5})},
	}
	world.Observe(state10)

	blocked := world.MovementObstacles("u1", nil, 3)
	if !blocked.Contains("5,5") {
		t.Fatalf("contested cell must be blocked within cooldown: %v", blocked)
	}
	if !blocked.Contains("5,5") || blocked.Len() != 1 {
		t.Fatalf("movement obstacles = %v", blocked)
	}

	// tick 13：13-10=3，冷却（<3）已过 → 解除。
	state13 := worldState(13)
	state13.Units = state10.Units
	world.Observe(state13)
	if got := world.MovementObstacles("u1", nil, 3); got.Len() != 0 {
		t.Errorf("cooldown must expire: %v", got)
	}

	// 非瞬态原因忽略。
	state20 := worldState(20)
	state20.Units = state10.Units
	state20.Events = []Event{
		{EventType: "UNIT_MOVE_FAILED", ActorID: strPtr("u1"),
			ReasonCode: strPtr("MOVE_INVALID"), Position: posPtr(Position{7, 7})},
	}
	world.Observe(state20)
	if got := world.MovementObstacles("u1", nil, 3); got.Len() != 0 {
		t.Errorf("non-transient failure must be ignored: %v", got)
	}

	// 未知单位无失败记录。
	if got := world.MovementObstacles("ghost", nil, 3); got.Len() != 0 {
		t.Errorf("unknown unit must have no obstacles: %v", got)
	}
}

func TestWorldResourceHintsOrdering(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.ResourceCells = keySet(Position{1, 1}, Position{2, 2})
	world.Observe(state1)

	// 两个 stale（t1 见过），一个再可见（t5），一个 HARVEST_FAILED。
	state5 := worldState(5)
	state5.ResourceCells = keySet(Position{2, 2})
	state5.Events = []Event{
		{EventType: "HARVEST_FAILED", Position: posPtr(Position{1, 1})},
	}
	world.Observe(state5)

	hints := world.ResourceHints(8, 4)
	if len(hints) != 1 || hints[0] != (Position{2, 2}) {
		t.Fatalf("hints = %v, want only visible cell (failed excluded)", hints)
	}

	// failed 冷却过后 stale 可见，且按最近见过排序；(1,1) 最后见过 t1，
	// 在 maxAge=10 内，按 recency 排在 (2,2)（t5）之后。
	state10 := worldState(10)
	state10.ResourceCells = keySet(Position{3, 3})
	world.Observe(state10)
	hints = world.ResourceHints(10, 4)
	want := []Position{{3, 3}, {2, 2}, {1, 1}}
	if len(hints) != len(want) {
		t.Fatalf("hints = %v, want %v", hints, want)
	}
	for i := range want {
		if hints[i] != want[i] {
			t.Fatalf("hints = %v, want %v (visible first, then recency)", hints, want)
		}
	}
}

func TestWorldSnapshotDeterministic(t *testing.T) {
	world := NewWorld()
	state1 := worldState(1)
	state1.ObstacleCells = keySet(Position{9, 9}, Position{1, 1})
	state1.ResourceCells = keySet(Position{2, 2})
	state1.Units = []UnitSnapshot{{ID: "u2", Position: Position{0, 0}, HP: 2, UnitType: UnitWorker}}
	world.Observe(state1)
	world.UnitMemory("u2", 0)

	first := world.Snapshot()
	second := world.Snapshot()
	if len(first.Obstacles) != 2 || first.Obstacles[0] != "1,1" || first.Obstacles[1] != "9,9" {
		t.Errorf("obstacles not sorted: %v", first.Obstacles)
	}
	if len(first.Resources) != 1 || first.Resources[0].Cell != "2,2" {
		t.Errorf("resources = %+v", first.Resources)
	}
	if first.UnitModes["u2"] != WorkerModePatrol {
		t.Errorf("unit modes = %v", first.UnitModes)
	}
	if len(first.Obstacles) != len(second.Obstacles) ||
		first.Obstacles[0] != second.Obstacles[0] ||
		first.Resources[0].Cell != second.Resources[0].Cell {
		t.Errorf("snapshot not deterministic")
	}
}
