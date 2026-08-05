package sim

import (
	"reflect"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// enemyEntity 构造最小敌方实体（UNIT 类型，用于 VisibleEnemies）。
func enemyEntity(id string, x, y, hp int) domain.VisibleEntity {
	return domain.VisibleEntity{
		ID: id, Position: domain.Position{x, y}, Kind: "UNIT", HP: hp,
	}
}

// combatBaseState 构造带 Ranger 射手的最小战斗状态（ranger-1 在 (0,0)，
// worker-1 在 (3,0)；Units 按 ID 升序）。
func combatBaseState() *domain.TickState {
	state := baseState()
	state.Population = 2
	state.Units = []domain.UnitSnapshot{
		{ID: "ranger-1", Position: domain.Position{0, 0}, HP: domain.UnitMaxHPRanger, UnitType: domain.UnitRanger},
		{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Rangers = []domain.UnitSnapshot{state.Units[0]}
	state.Workers = []domain.UnitSnapshot{state.Units[1]}
	return state
}

// vanguardBaseState 构造带 Vanguard 的最小战斗状态（vanguard-1 在 (0,0)）。
func vanguardBaseState() *domain.TickState {
	state := baseState()
	state.Population = 2
	state.Units = []domain.UnitSnapshot{
		{ID: "vanguard-1", Position: domain.Position{0, 0}, HP: domain.UnitMaxHPVanguard, UnitType: domain.UnitVanguard},
		{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Vanguards = []domain.UnitSnapshot{state.Units[0]}
	state.Workers = []domain.UnitSnapshot{state.Units[1]}
	return state
}

func shootAction(cell domain.Position, targetID string) domain.UnitAction {
	return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}
}

func sweepAction(direction domain.Direction) domain.UnitAction {
	return domain.UnitAction{Kind: domain.ActionSweep, Direction: &direction}
}

func countEvents(events []domain.Event, eventType string) int {
	count := 0
	for _, event := range events {
		if event.EventType == eventType {
			count++
		}
	}
	return count
}

// TestCombatRangerShootHits：Ranger 命中 expected_cell 内的目标 →
// 1 伤害，HP=1 目标被击杀（Kills=1），SHOOT 事件带 target_id。
func TestCombatRangerShootHits(t *testing.T) {
	state := combatBaseState()
	state.VisibleEnemies = []domain.VisibleEntity{enemyEntity("enemy-1", 2, 0, 1)}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"ranger-1": shootAction(domain.Position{2, 0}, "enemy-1"),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ShotsFired != 1 || result.Stats.Kills != 1 {
		t.Fatalf("stats = %+v, want 1 shot 1 kill", result.Stats)
	}
	if len(result.NextState.VisibleEnemies) != 0 {
		t.Fatalf("enemies = %+v, want none (killed)", result.NextState.VisibleEnemies)
	}
	if countEvents(result.Events, "SHOOT") != 1 || countEvents(result.Events, "SHOOT_MISSED") != 0 {
		t.Fatalf("events = %+v, want 1 SHOOT", result.Events)
	}
	for _, event := range result.Events {
		if event.EventType != "SHOOT" {
			continue
		}
		if event.TargetID == nil || *event.TargetID != "enemy-1" {
			t.Fatalf("SHOOT event target = %v, want enemy-1", event.TargetID)
		}
	}
}

// TestCombatRangerShootMisses：目标不在 expected_cell → SHOOT_MISSED，
// 不造成伤害、无击杀（命中统计仍计入 ShotsFired）。
func TestCombatRangerShootMisses(t *testing.T) {
	state := combatBaseState()
	state.VisibleEnemies = []domain.VisibleEntity{enemyEntity("enemy-1", 2, 0, 1)}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"ranger-1": shootAction(domain.Position{2, 0}, "enemy-2"), // 目标不在该格
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ShotsFired != 1 || result.Stats.Kills != 0 {
		t.Fatalf("stats = %+v, want 1 shot 0 kills", result.Stats)
	}
	if len(result.NextState.VisibleEnemies) != 1 || result.NextState.VisibleEnemies[0].HP != 1 {
		t.Fatalf("enemies = %+v, want enemy-1 unharmed", result.NextState.VisibleEnemies)
	}
	if countEvents(result.Events, "SHOOT_MISSED") != 1 || countEvents(result.Events, "SHOOT") != 0 {
		t.Fatalf("events = %+v, want 1 SHOOT_MISSED", result.Events)
	}
}

// TestCombatVanguardSweepHitsMultiple：Vanguard 对相邻格内两个敌方单位
// 各造成 1 伤害（AOE），HP=1 者被击杀（Kills=1），SWEEP 事件 hits=2。
func TestCombatVanguardSweepHitsMultiple(t *testing.T) {
	state := vanguardBaseState()
	state.VisibleEnemies = []domain.VisibleEntity{
		enemyEntity("enemy-1", 1, 0, 2),
		enemyEntity("enemy-2", 1, 0, 1),
	}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"vanguard-1": sweepAction(domain.DirectionRight),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.SweepsFired != 1 || result.Stats.Kills != 1 {
		t.Fatalf("stats = %+v, want 1 sweep 1 kill", result.Stats)
	}
	alive := result.NextState.VisibleEnemies
	if len(alive) != 1 || alive[0].ID != "enemy-1" || alive[0].HP != 1 {
		t.Fatalf("enemies = %+v, want enemy-1 at 1 HP", alive)
	}
	for _, event := range result.Events {
		if event.EventType != "SWEEP" {
			continue
		}
		hits, ok := event.Values["hits"].(int)
		if !ok || hits != 2 {
			t.Fatalf("SWEEP event values = %+v, want hits=2", event.Values)
		}
	}
	if countEvents(result.Events, "SWEEP") != 1 || countEvents(result.Events, "SWEEP_MISSED") != 0 {
		t.Fatalf("events = %+v, want 1 SWEEP", result.Events)
	}
}

// TestCombatVanguardSweepMisses：相邻格内无敌 → SWEEP_MISSED，无伤害。
func TestCombatVanguardSweepMisses(t *testing.T) {
	state := vanguardBaseState() // 无可见敌人
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"vanguard-1": sweepAction(domain.DirectionRight),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.SweepsFired != 1 || result.Stats.Kills != 0 {
		t.Fatalf("stats = %+v, want 1 sweep 0 kills", result.Stats)
	}
	if countEvents(result.Events, "SWEEP_MISSED") != 1 || countEvents(result.Events, "SWEEP") != 0 {
		t.Fatalf("events = %+v, want 1 SWEEP_MISSED", result.Events)
	}
}

// TestCombatWorkerShootIgnored：Worker 不是射手，SHOOT 动作静默忽略
// （无事件、无伤害、不计 ShotsFired）。
func TestCombatWorkerShootIgnored(t *testing.T) {
	state := baseState() // 只有 worker-1
	state.VisibleEnemies = []domain.VisibleEntity{enemyEntity("enemy-1", 2, 0, 1)}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"worker-1": shootAction(domain.Position{2, 0}, "enemy-1"),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ShotsFired != 0 || result.Stats.Kills != 0 {
		t.Fatalf("stats = %+v, want 0 shots 0 kills", result.Stats)
	}
	if len(result.NextState.VisibleEnemies) != 1 || result.NextState.VisibleEnemies[0].HP != 1 {
		t.Fatalf("enemies = %+v, want enemy-1 unharmed", result.NextState.VisibleEnemies)
	}
	if countEvents(result.Events, "SHOOT") != 0 || countEvents(result.Events, "SHOOT_MISSED") != 0 {
		t.Fatalf("events = %+v, want no shoot events", result.Events)
	}
}

// TestCombatDeterministic：同输入两次结算，事件/统计/敌余状态一致。
func TestCombatDeterministic(t *testing.T) {
	state := combatBaseState()
	state.Population = 3
	state.Units = []domain.UnitSnapshot{
		{ID: "ranger-1", Position: domain.Position{0, 0}, HP: domain.UnitMaxHPRanger, UnitType: domain.UnitRanger},
		{ID: "vanguard-1", Position: domain.Position{0, 1}, HP: domain.UnitMaxHPVanguard, UnitType: domain.UnitVanguard},
		{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Rangers = []domain.UnitSnapshot{state.Units[0]}
	state.Vanguards = []domain.UnitSnapshot{state.Units[1]}
	state.Workers = []domain.UnitSnapshot{state.Units[2]}
	state.VisibleEnemies = []domain.VisibleEntity{
		enemyEntity("enemy-1", 2, 0, 1),
		enemyEntity("enemy-2", 1, 1, 3),
	}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"ranger-1":   shootAction(domain.Position{2, 0}, "enemy-1"),
			"vanguard-1": sweepAction(domain.DirectionLeft),
			"worker-1":   {Kind: domain.ActionWait},
		},
	}
	first := NewEngine().Settle(state, plan)
	second := NewEngine().Settle(state, plan)
	if !reflect.DeepEqual(first.Stats, second.Stats) {
		t.Fatalf("determinism broken: stats %+v vs %+v", first.Stats, second.Stats)
	}
	if !reflect.DeepEqual(first.Events, second.Events) {
		t.Fatalf("determinism broken: events %+v vs %+v", first.Events, second.Events)
	}
	if !reflect.DeepEqual(first.NextState.VisibleEnemies, second.NextState.VisibleEnemies) {
		t.Fatalf("determinism broken: enemies %+v vs %+v",
			first.NextState.VisibleEnemies, second.NextState.VisibleEnemies)
	}
}

// TestCombatSimultaneousDamage：两发射击同目标时伤害同时应用（快照语义）
// ——第二发射手校验时目标仍存活，两发都命中（Kills=1，ShotsFired=2）。
func TestCombatSimultaneousDamage(t *testing.T) {
	state := combatBaseState()
	state.Population = 3
	state.Units = []domain.UnitSnapshot{
		{ID: "ranger-1", Position: domain.Position{0, 0}, HP: domain.UnitMaxHPRanger, UnitType: domain.UnitRanger},
		{ID: "ranger-2", Position: domain.Position{0, 2}, HP: domain.UnitMaxHPRanger, UnitType: domain.UnitRanger},
		{ID: "worker-1", Position: domain.Position{3, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	}
	state.Rangers = []domain.UnitSnapshot{state.Units[0], state.Units[1]}
	state.Workers = []domain.UnitSnapshot{state.Units[2]}
	state.VisibleEnemies = []domain.VisibleEntity{enemyEntity("enemy-1", 2, 0, 1)}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"ranger-1": shootAction(domain.Position{2, 0}, "enemy-1"),
			"ranger-2": shootAction(domain.Position{2, 0}, "enemy-1"),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ShotsFired != 2 || result.Stats.Kills != 1 {
		t.Fatalf("stats = %+v, want 2 shots 1 kill (simultaneous)", result.Stats)
	}
	if countEvents(result.Events, "SHOOT") != 2 {
		t.Fatalf("events = %+v, want 2 SHOOT hits", result.Events)
	}
}

// TestCombatRangerShootLineBlocked：视线被障碍遮挡 → SHOOT_MISSED，
// 目标不受伤害。
func TestCombatRangerShootLineBlocked(t *testing.T) {
	state := combatBaseState()
	state.ObstacleCells = domain.NewSet(domain.CellKey(1, 0))
	state.VisibleEnemies = []domain.VisibleEntity{enemyEntity("enemy-1", 2, 0, 2)}
	plan := &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"ranger-1": shootAction(domain.Position{2, 0}, "enemy-1"),
		},
	}
	result := NewEngine().Settle(state, plan)
	if result.Stats.ShotsFired != 1 || result.Stats.Kills != 0 {
		t.Fatalf("stats = %+v, want 1 shot 0 kills", result.Stats)
	}
	if len(result.NextState.VisibleEnemies) != 1 || result.NextState.VisibleEnemies[0].HP != 2 {
		t.Fatalf("enemies = %+v, want enemy-1 unharmed (line blocked)", result.NextState.VisibleEnemies)
	}
	if countEvents(result.Events, "SHOOT_MISSED") != 1 {
		t.Fatalf("events = %+v, want 1 SHOOT_MISSED", result.Events)
	}
}
