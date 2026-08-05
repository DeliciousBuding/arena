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

// TestStarvedPatrolFocusesOnBeacon：EXPLORE_STARVED 模式下 worker 走
// 螺旋覆盖（目标在环上：距离 ≈ radius；到达后沿环推进）。
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
		t.Fatalf("action = %+v, want MOVE (spiral sweep)", action)
	}
	// 螺旋目标在环上：与 home 距离 ≈ radius（16 ± 3）。
	first := planner.patrolTargets["worker-1"]
	distance := abs(first[0]) + abs(first[1])
	if distance < 13 || distance > 19 {
		t.Errorf("first spiral target = %v (dist %d), want on ring ~16", first, distance)
	}
	// 到达目标后沿环推进（下一目标不同）。
	state.Units[0].Position = first
	state.Workers[0].Position = first
	state.Tick = 2
	planner.Decide(state)
	second := planner.patrolTargets["worker-1"]
	if second == first {
		t.Errorf("spiral target did not advance after arrival (%v)", first)
	}
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

// TestMigrationStartsOnMigrateCandidate：MIGRATE_CAND + 显式启用 →
// Core START_MOVE 朝焦点方向（红线：默认关闭时不发）。
func TestMigrationStartsOnMigrateCandidate(t *testing.T) {
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()
	// Beacon 在正东：焦点东 → START_MOVE RIGHT。
	state.Beacon = domain.Beacon{Position: domain.Position{20, 0}, Status: domain.BeaconGround}

	// 默认关闭：MIGRATE_CAND 也不发。
	disabled := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0})
	disabled.ApplyDirective(Directive{Mode: ModeMigrateCand, Focus: state.Beacon.Position})
	plan := disabled.Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("migration disabled: core action = %+v, want nil", plan.CoreAction)
	}

	// 显式启用：MIGRATE_CAND → START_MOVE RIGHT。
	enabled := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0, EnableCoreMigration: true})
	enabled.ApplyDirective(Directive{Mode: ModeMigrateCand, Focus: state.Beacon.Position})
	plan = enabled.Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreStartMove {
		t.Fatalf("core action = %+v, want START_MOVE", plan.CoreAction)
	}
	if plan.CoreAction.Direction == nil || *plan.CoreAction.Direction != domain.DirectionRight {
		t.Errorf("migration direction = %v, want RIGHT (focus east)", plan.CoreAction.Direction)
	}
	// 计划必须通过校验（wire 转换 + validator）。
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
	}
}

// TestMigrationNotInGrowthMode：GROWTH 模式下即使启用也不迁移。
func TestMigrationNotInGrowthMode(t *testing.T) {
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()
	state.Beacon = domain.Beacon{Position: domain.Position{20, 0}, Status: domain.BeaconGround}
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0, EnableCoreMigration: true})
	planner.ApplyDirective(Directive{Mode: ModeGrowth, Focus: state.Beacon.Position})
	plan := planner.Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("core action = %+v, want nil in GROWTH mode", plan.CoreAction)
	}
}

// TestMigrationStopsWhenCoreMoving：Core MOVING 时不发迁移（不重复发）。
func TestMigrationStopsWhenCoreMoving(t *testing.T) {
	state := baseState()
	state.Resources = 1
	state.ResourceCells = domain.NewSet[string]()
	state.Beacon = domain.Beacon{Position: domain.Position{20, 0}, Status: domain.BeaconGround}
	state.Core.State = domain.CoreMoving
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 0, EnableCoreMigration: true})
	planner.ApplyDirective(Directive{Mode: ModeMigrateCand, Focus: state.Beacon.Position})
	plan := planner.Decide(state)
	if plan.CoreAction != nil {
		t.Fatalf("core action = %+v, want nil while core moving", plan.CoreAction)
	}
}

// TestSpawnReserveClampedToCapacity：reserve 超过 capacity-cost 时被
// 钳制（参数扫描发现的满仓死锁：capacity=10、cost=5、reserve=8 →
// 13>10 永不 spawn）——钳制后 reserve=5，resources=10 恰好可 spawn。
func TestSpawnReserveClampedToCapacity(t *testing.T) {
	state := baseState() // capacity=10, resources=5, pop=2
	state.Resources = 10
	state.ResourceSpace = 0
	planner := NewPlanner(Config{WorkerTarget: 8, PopulationCeiling: 20, ExploreRadius: 16, ThreatDistance: 5, SpawnReserve: 8})
	plan := planner.Decide(state)
	if plan.CoreAction == nil || plan.CoreAction.Kind != domain.CoreSpawn {
		t.Fatalf("core action = %+v, want SPAWN (reserve clamped to 5: 10 >= 5+5)", plan.CoreAction)
	}
	if result := domain.ValidatePlan(state, *plan); !result.Valid {
		t.Errorf("plan invalid: %v", result.Issues)
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
