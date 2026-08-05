package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// economyStateWithMilitary 构造带 Vanguard/Ranger + 敌方单位的状态。
func economyStateWithMilitary() (*domain.TickState, *strategy.Planner) {
	state := economyBaseState()
	state.Resources = 10
	state.ResourceSpace = 0
	state.Units = append(state.Units,
		domain.UnitSnapshot{ID: "vanguard-1", Position: domain.Position{10, 10}, HP: 4, UnitType: domain.UnitVanguard},
		domain.UnitSnapshot{ID: "ranger-1", Position: domain.Position{15, 15}, HP: 2, UnitType: domain.UnitRanger},
	)
	state.Vanguards = append(state.Vanguards, state.Units[2])
	state.Rangers = append(state.Rangers, state.Units[3])
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{10, 11}, HP: 2},
	}
	planner := strategy.NewPlanner(strategy.Config{
		WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 8, ThreatDistance: 10, SpawnReserve: 0,
	})
	return state, planner
}

// TestCombatFullLoopVanguardSweepKills：Vanguard 紧邻敌人 → planner 发
// SWEEP → engine 结算 1 伤害；第二 tick 再 SWEEP 击杀（战斗闭环集成）。
func TestCombatFullLoopVanguardSweepKills(t *testing.T) {
	state, planner := economyStateWithMilitary()
	engine := NewEngine()

	state.Tick = 1
	plan := planner.Decide(state)
	// Vanguard 紧邻 (10,11) 敌人 → SWEEP DOWN。
	vanguardAction := plan.UnitActions["vanguard-1"]
	if vanguardAction.Kind != domain.ActionSweep {
		t.Fatalf("vanguard action = %s, want SWEEP", vanguardAction.Kind)
	}
	result := engine.Settle(state, plan)
	// HP=2 敌人受 1 伤害存活：kills=0，SWEEP 事件 hits=1。
	if result.Stats.Kills != 0 {
		t.Errorf("kills = %d, want 0 (HP=2 enemy survives 1 damage)", result.Stats.Kills)
	}
	if len(result.NextState.VisibleEnemies) != 1 {
		t.Fatalf("enemies = %d, want 1 (survived)", len(result.NextState.VisibleEnemies))
	}
	if got := result.NextState.VisibleEnemies[0].HP; got != 1 {
		t.Errorf("enemy HP = %d, want 1 after sweep", got)
	}
	sweepEvent := false
	for _, event := range result.Events {
		if event.EventType == "SWEEP" {
			sweepEvent = true
		}
	}
	if !sweepEvent {
		t.Errorf("expected SWEEP event, got %+v", result.Events)
	}

	// 第二 tick：再 SWEEP → HP 1→0 击杀。
	state = result.NextState
	state.Tick = 2
	plan = planner.Decide(state)
	result = engine.Settle(state, plan)
	if result.Stats.Kills != 1 {
		t.Errorf("tick 2 kills = %d, want 1 (HP=1 enemy killed)", result.Stats.Kills)
	}
	if len(result.NextState.VisibleEnemies) != 0 {
		t.Errorf("enemies = %d, want 0 (killed)", len(result.NextState.VisibleEnemies))
	}
}

// TestCombatFullLoopRangerShootKills：Ranger 视野内敌人 → planner 发
// SHOOT → engine 结算（射程 5 + 视线）。
func TestCombatFullLoopRangerShootKills(t *testing.T) {
	state, planner := economyStateWithMilitary()
	// Ranger 在 (15,15)，敌人移到 (15,18)（距离 3，射程内）。
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-1", Kind: "UNIT", Position: domain.Position{15, 18}, HP: 1},
	}
	// Vanguard 移开，避免 SWEEP 干扰。
	state.Units[2].Position = domain.Position{30, 30}
	state.Vanguards[0].Position = domain.Position{30, 30}

	engine := NewEngine()
	state.Tick = 1
	plan := planner.Decide(state)
	rangerAction := plan.UnitActions["ranger-1"]
	if rangerAction.Kind != domain.ActionShoot {
		t.Fatalf("ranger action = %s, want SHOOT", rangerAction.Kind)
	}
	result := engine.Settle(state, plan)
	if result.Stats.Kills != 1 {
		t.Errorf("kills = %d, want 1 (enemy HP=1 killed)", result.Stats.Kills)
	}
	if len(result.NextState.VisibleEnemies) != 0 {
		t.Errorf("enemies = %d, want 0 (killed)", len(result.NextState.VisibleEnemies))
	}
	// 击杀事件存在。
	found := false
	for _, event := range result.Events {
		if event.EventType == "SHOOT" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected SHOOT event, got %+v", result.Events)
	}
}
