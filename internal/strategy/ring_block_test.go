package strategy

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// 环形互堵回归场景：4 个满载 worker 在 Core 四邻 + 4 个空载在更外环，
// 全部试图穿过彼此到达目的地（回仓/采格）。修复前：所有 moveToward
// 第一步互相被占 → 全员 WAIT 永久冻结。修复后：stuck 指纹 + stepAside
// 让位打破环，经济持续运转。

// ringBlockState 构造 Core 四邻被 4 个满载 worker 围死的初始状态。
func ringBlockState() *domain.TickState {
	state := &domain.TickState{
		Tick: 1, Status: domain.PlayerStatusActive,
		Resources: 0, ResourceCapacity: 10, ResourceSpace: 10, Population: 4,
		Core:          &domain.Core{ID: "core-1", Position: domain.Position{0, 0}, HP: domain.CoreMaxHP, Shield: domain.CoreMaxShield, State: domain.CoreNormal},
		ResourceCells: domain.NewSet[string](domain.CellKey(3, 0), domain.CellKey(-3, 0), domain.CellKey(0, 3), domain.CellKey(0, -3)),
		ObstacleCells: domain.NewSet[string](),
		Beacon:        domain.Beacon{}, // 空 Status = 无信标
	}
	fullWorkers := []domain.Position{{1, 0}, {0, 1}, {-1, 0}, {0, -1}}
	emptyWorkers := []domain.Position{{2, 0}, {0, 2}, {-2, 0}, {0, -2}}
	units := make([]domain.UnitSnapshot, 0, 8)
	for i, pos := range fullWorkers {
		units = append(units, domain.UnitSnapshot{
			ID: "full-" + string(rune('a'+i)), Position: pos, HP: 2, UnitType: domain.UnitWorker, Cargo: 1,
		})
	}
	for i, pos := range emptyWorkers {
		units = append(units, domain.UnitSnapshot{
			ID: "empty-" + string(rune('a'+i)), Position: pos, HP: 2, UnitType: domain.UnitWorker, Cargo: 0,
		})
	}
	state.Units = units
	state.Workers = units
	return state
}

// TestRingBlockDeadlockBroken：环形互堵 60 tick 内必须有 deposit
// 且单位在移动（修复前：0 deposit、全员原地 WAIT）。
func TestRingBlockDeadlockBroken(t *testing.T) {
	state := ringBlockState()
	planner := NewPlanner(DefaultConfig())
	planner.config.WorkerTarget = 8

	deposits := 0
	moves := 0
	for tick := 1; tick <= 60; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		for _, action := range plan.UnitActions {
			if action.Kind == domain.ActionMove {
				moves++
			}
		}
		settled := settleForTest(state, plan)
		deposits += settled.deposits
		state = settled.state
	}
	if deposits == 0 {
		t.Fatalf("ring block deadlock: 0 deposits in 60 ticks (all units mutually blocking)")
	}
	if moves == 0 {
		t.Fatal("no move actions planned in 60 ticks")
	}
	t.Logf("ring block broken: deposits=%d moves=%d workers=%d", deposits, moves, len(state.Workers))
}

// TestCoreRingYieldEmptyWorker：Core 四邻全为资源格时（dense 拓扑），
// 空载 worker 让位必须允许踩资源格（yieldFromCore skipResources=false）。
func TestCoreRingYieldEmptyWorker(t *testing.T) {
	state := ringBlockState()
	// dense 拓扑：Core 四邻全变资源格 → yieldFullCore（skip=true）
	// 无路可走，空载让位（skip=false）必须能踩资源格。
	state.ResourceCells = domain.NewSet[string](
		domain.CellKey(1, 0), domain.CellKey(0, 1), domain.CellKey(-1, 0), domain.CellKey(0, -1),
		domain.CellKey(3, 0), domain.CellKey(-3, 0), domain.CellKey(0, 3), domain.CellKey(0, -3),
	)
	planner := NewPlanner(DefaultConfig())
	planner.config.WorkerTarget = 8

	deposits := 0
	for tick := 1; tick <= 80; tick++ {
		state.Tick = tick
		plan := planner.Decide(state)
		settled := settleForTest(state, plan)
		deposits += settled.deposits
		state = settled.state
	}
	if deposits == 0 {
		t.Fatalf("core-ring yield: 0 deposits in 80 ticks (empty worker cannot leave core)")
	}
	t.Logf("core-ring yield: deposits=%d workers=%d", deposits, len(state.Workers))
}

// settleForTest 是策略测试专用迷你结算：只应用 MOVE（移动到目标格，
// 若被占则原地）+ 统计 DEPOSIT。不模拟 harvest/spawn/战斗（策略包
// 不依赖 sim 引擎，避免循环导入）。
func settleForTest(state *domain.TickState, plan *domain.Plan) settleResult {
	result := settleResult{state: state}
	occupied := make(map[domain.Position]struct{}, len(state.Units))
	for _, unit := range state.Units {
		occupied[unit.Position] = struct{}{}
	}
	for i := range state.Units {
		unit := &state.Units[i]
		action, has := plan.UnitActions[unit.ID]
		if !has {
			continue
		}
		switch action.Kind {
		case domain.ActionMove:
			if action.Direction == nil {
				continue
			}
			next := domain.Move(unit.Position, *action.Direction)
			if state.ObstacleCells.Contains(domain.CellKey(next[0], next[1])) {
				continue
			}
			if _, taken := occupied[next]; taken {
				continue
			}
			delete(occupied, unit.Position)
			unit.Position = next
			occupied[next] = struct{}{}
		case domain.ActionDeposit:
			if state.Core != nil && unit.Position == state.Core.Position && unit.Cargo > 0 {
				unit.Cargo = 0
				state.Resources += 1
				result.deposits++
			}
		}
	}
	// 同步 Workers 列（settle 后状态一致性）。
	state.Workers = append([]domain.UnitSnapshot(nil), state.Units...)
	return result
}

// settleResult 是测试用结算结果。
type settleResult struct {
	deposits int
	state    *domain.TickState
}
