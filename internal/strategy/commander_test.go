package strategy

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// TestCommanderGrowthWithProgress：资源/工人/可见资源格有进展 → GROWTH。
func TestCommanderGrowthWithProgress(t *testing.T) {
	commander := NewCommander()
	state := baseState()
	state.ResourceCells.Add(domain.CellKey(1, 0)) // 可见资源格 = 进展

	for i := 0; i < starvedThresholdTicks+5; i++ {
		directive := commander.Update(state)
		if directive.Mode != ModeGrowth {
			t.Fatalf("tick %d: mode = %s, want GROWTH (resource cells visible)", i, directive.Mode)
		}
	}
}

// TestCommanderExploreStarvedAfterNoProgress：资源/工人/资源格连续
// 30 tick 无进展 → EXPLORE_STARVED。
func TestCommanderExploreStarvedAfterNoProgress(t *testing.T) {
	commander := NewCommander()
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()

	for i := 0; i < starvedThresholdTicks; i++ {
		directive := commander.Update(state)
		if i < starvedThresholdTicks-1 && directive.Mode != ModeGrowth {
			t.Fatalf("tick %d: mode = %s, want GROWTH before threshold", i, directive.Mode)
		}
	}
	if directive := commander.Update(state); directive.Mode != ModeExploreStarved {
		t.Fatalf("mode = %s, want EXPLORE_STARVED after %d no-progress ticks", directive.Mode, starvedThresholdTicks)
	}
}

// TestCommanderResetsOnProgress：无进展计数在资源增长时重置回 GROWTH。
func TestCommanderResetsOnProgress(t *testing.T) {
	commander := NewCommander()
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()
	for i := 0; i < starvedThresholdTicks; i++ {
		commander.Update(state)
	}
	state.Resources = 3 // 资源增长（deposit 结算）
	if directive := commander.Update(state); directive.Mode != ModeGrowth {
		t.Fatalf("mode = %s, want GROWTH after resource growth resets counter", directive.Mode)
	}
}

// TestCommanderMigrateCandidate：EXPLORE_STARVED 持续到 100 tick →
// MIGRATE_CAND（只评估不执行）。
func TestCommanderMigrateCandidate(t *testing.T) {
	commander := NewCommander()
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()
	for i := 0; i < migrateCandidateTicks; i++ {
		commander.Update(state)
	}
	if directive := commander.Update(state); directive.Mode != ModeMigrateCand {
		t.Fatalf("mode = %s, want MIGRATE_CAND after %d ticks", directive.Mode, migrateCandidateTicks)
	}
}

// TestStuckDetectionForcesNewTarget：服务器位置连续 3 tick 不变 →
// patrol 强制换目标（停滞跳出，计划合法但结算未生效的场景）。
func TestStuckDetectionForcesNewTarget(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	state.ObstacleCells = domain.NewSet[string]()
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0})

	planner.Decide(state)
	firstTarget := planner.patrolTargets["worker-1"]

	// 位置保持不动（服务器不结算）连续 4 tick：第 4 次（stuck>=3）
	// 决策应强制换巡逻目标。
	for tick := 2; tick <= 5; tick++ {
		state.Tick = tick // 位置不变（worker 仍在 (0,0)）
		planner.Decide(state)
	}
	secondTarget := planner.patrolTargets["worker-1"]
	if firstTarget == secondTarget {
		t.Errorf("patrol target never changed while stuck (target=%v)", firstTarget)
	}
}

// TestStarvedPatrolFocusesOnBeacon：EXPLORE_STARVED 模式下 worker 朝
// 指挥焦点（Beacon）方向推进（不再是 8 方位分散）。
func TestStarvedPatrolFocusesOnBeacon(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	state.ObstacleCells = domain.NewSet[string]()
	// Beacon 在正东 (20,0)：焦点方向 = 东。
	state.Beacon = domain.Beacon{Position: domain.Position{20, 0}, Status: domain.BeaconGround}
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0})
	planner.ApplyDirective(Directive{Mode: ModeExploreStarved, Focus: state.Beacon.Position})

	plan := planner.Decide(state)
	action := requireUnitAction(t, plan, "worker-1")
	if action.Kind != domain.ActionMove || action.Direction == nil {
		t.Fatalf("action = %+v, want MOVE toward beacon", action)
	}
	// 焦点正东：第一步必须向东（RIGHT）。
	if *action.Direction != domain.DirectionRight {
		t.Errorf("direction = %v, want RIGHT (focus sweep toward beacon)", *action.Direction)
	}
}

// TestStarvedPatrolRecoversToGrowth：模式切回 GROWTH 后恢复 8 方位巡逻
// （指令传递可逆）。
func TestStarvedPatrolRecoversToGrowth(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet[string]()
	state.ObstacleCells = domain.NewSet[string]()
	state.Beacon = domain.Beacon{Position: domain.Position{20, 0}, Status: domain.BeaconGround}
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0})

	planner.ApplyDirective(Directive{Mode: ModeGrowth, Focus: state.Beacon.Position})
	plan := planner.Decide(state)
	if intent := plan.Intents["worker-1"]; intent != "explore" {
		t.Fatalf("intent = %q, want explore (growth mode)", intent)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}
