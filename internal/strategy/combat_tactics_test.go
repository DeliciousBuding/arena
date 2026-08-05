package strategy

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// TestRangerKitesCloseEnemy：敌人距离 2（近战威胁）→ Ranger 先撤退
// （kite），保持射程优势。
func TestRangerKitesCloseEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	// 敌人距离 2（Chebyshev）：Ranger 在 (5,5)，敌人 (7,5)。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{7, 5}, HP: 2, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionMove {
		t.Fatalf("ranger action = %s, want MOVE (kite away)", action.Kind)
	}
	if intent := plan.Intents["ranger-1"]; intent != "kite" {
		t.Errorf("intent = %q, want kite", intent)
	}
	if action.Direction == nil || *action.Direction != domain.DirectionLeft {
		t.Errorf("direction = %v, want LEFT (away from enemy at (7,5))", action.Direction)
	}
}

// TestRangerShootsAtRangeThree：敌人距离 3（射程内无近战威胁）→ 直接 SHOOT。
func TestRangerShootsAtRangeThree(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "ranger-1", Position: domain.Position{5, 5}, HP: 2, UnitType: domain.UnitRanger,
	})
	state.Rangers = append(state.Rangers, state.Units[1])
	// 敌人距离 3：Ranger (5,5)，敌人 (8,5)。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{8, 5}, HP: 2, UnitType: &enemyType},
	}
	plan := NewPlanner(DefaultConfig()).Decide(state)

	action := requireUnitAction(t, plan, "ranger-1")
	if action.Kind != domain.ActionShoot {
		t.Fatalf("ranger action = %s, want SHOOT (range 3, no kite needed)", action.Kind)
	}
	if intent := plan.Intents["ranger-1"]; intent != "shoot" {
		t.Errorf("intent = %q, want shoot", intent)
	}
}

// TestVanguardDisengagesAfterChaseTimeout：追敌 8 tick 追不上 → 放弃
// 追击回核心（disengage，跳出追敌死循环）。
func TestVanguardDisengagesAfterChaseTimeout(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{5, 5}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	// 敌人持续在威胁距离边缘（永远追不上）。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{10, 5}, HP: 4, UnitType: &enemyType},
	}
	config := Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 10, SpawnReserve: 0}
	planner := NewPlanner(config)

	// 前 8 tick engage；第 9 tick 超时 → disengage。
	for tick := 1; tick <= 9; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		if tick < 9 {
			if intent := plan.Intents["vanguard-1"]; intent != "engage" {
				t.Fatalf("tick %d: intent = %q, want engage", tick, intent)
			}
		} else {
			if intent := plan.Intents["vanguard-1"]; intent != "disengage" {
				t.Fatalf("tick %d: intent = %q, want disengage (chase timeout)", tick, intent)
			}
		}
	}
}

// TestVanguardEngageResetsWithoutEnemy：敌人消失 → engage 计数重置，
// 重新 engage 不会立即超时。
func TestVanguardEngageResetsWithoutEnemy(t *testing.T) {
	state := baseState()
	enemyType := domain.UnitVanguard
	state.Units = append(state.Units, domain.UnitSnapshot{
		ID: "vanguard-1", Position: domain.Position{5, 5}, HP: 4, UnitType: domain.UnitVanguard,
	})
	state.Vanguards = append(state.Vanguards, state.Units[1])
	config := Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 10, SpawnReserve: 0}
	planner := NewPlanner(config)

	// 5 tick 有敌人（engage 计数累积）。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{10, 5}, HP: 4, UnitType: &enemyType},
	}
	for tick := 1; tick <= 5; tick++ {
		state.Tick = tick
		planner.Decide(state)
	}
	// 敌人消失 1 tick（重置）。
	state.VisibleEnemies = nil
	state.Tick = 6
	planner.Decide(state)
	// 敌人重现：应重新 engage（计数已重置，不会立即超时）。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{10, 5}, HP: 4, UnitType: &enemyType},
	}
	state.Tick = 7
	plan := planner.Decide(state)
	if intent := plan.Intents["vanguard-1"]; intent != "engage" {
		t.Errorf("intent = %q, want engage (counter reset after enemy gone)", intent)
	}
}
