// Package sim 实现 Digital Twin 规则结算引擎（B7-B 前置）。
// 输入 TickState + Plan，确定性结算下一 tick 的状态变化。
// 本批：movement / economy 子系统与 Settle 入口；战斗/信标/自毁后续批次。
package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// SettleResult 是单 tick 结算产物：下一状态（深拷贝）、结算事件与统计。
type SettleResult struct {
	NextState *domain.TickState
	Events    []domain.Event
	Stats     SettleStats
}

// SettleStats 是结算统计（遥测/赛马指标）。
type SettleStats struct {
	Moves         int
	Blocked       int
	Harvests      int
	Deposits      int
	Spawns        int
	SpawnBlocked  int
	ResourceDelta int
}

// Engine 是确定性结算引擎（无状态，并发安全）。
type Engine struct{}

// NewEngine 构造结算引擎。
func NewEngine() *Engine {
	return &Engine{}
}

// Settle 结算一个 tick：应用移动、经济活动与 Core 动作，产出下一状态。
// 确定性：同输入同输出（无随机、稳定遍历顺序）。
// 结算顺序（裁决语义）：MOVE（让位）→ HARVEST/DEPOSIT → Core SPAWN——
// 满载 Worker 本 tick 让位腾空 Core 格后，SPAWN 同 tick 即可结算。
func (e *Engine) Settle(state *domain.TickState, plan *domain.Plan) SettleResult {
	next := cloneState(state)
	events := make([]domain.Event, 0, 8)
	stats := SettleStats{}

	harvestWorkers := make([]string, 0)
	depositWorkers := make([]string, 0)
	for _, unitID := range sortedUnitIDs(plan.UnitActions) {
		action, ok := plan.UnitActions[unitID]
		if !ok {
			continue
		}
		switch action.Kind {
		case domain.ActionMove:
			if moved, blocked := applyMove(next, unitID, action, &stats); moved {
				events = append(events, moveEvent(next.Tick, unitID, action.Direction, ""))
			} else if blocked != "" {
				events = append(events, moveEvent(next.Tick, unitID, nil, blocked))
			}
		case domain.ActionHarvest:
			harvestWorkers = append(harvestWorkers, unitID)
		case domain.ActionDeposit:
			depositWorkers = append(depositWorkers, unitID)
		}
	}

	harvestEvents := applyHarvests(next, harvestWorkers, &stats)
	depositEvents := applyDeposits(next, depositWorkers, &stats)
	events = append(events, harvestEvents...)
	events = append(events, depositEvents...)

	coreEvents := e.applyCoreAction(next, plan.CoreAction)
	for _, event := range coreEvents {
		if event.EventType == "SPAWN" {
			stats.Spawns++
		}
		if event.EventType == "SPAWN_BLOCKED_CORE_OCCUPIED" {
			stats.SpawnBlocked++
		}
	}
	events = append(events, coreEvents...)

	// 一致性：分列（Workers/Vanguards/Rangers）从 Units 重建——结算只
	// 修改 Units 的位置/cargo，若不回写分列，决策（读 Units）与分配
	// （读分列）会看到不同状态，导致闭环卡死（真实拓扑测试暴露）。
	rebuildColumns(next)

	return SettleResult{NextState: next, Events: events, Stats: stats}
}

// rebuildColumns 按 Units 重建分列（Workers/Vanguards/Rangers），
// 保持 Units 的既有顺序（reduce 语义：按 ID 升序）。
func rebuildColumns(state *domain.TickState) {
	state.Workers = state.Workers[:0]
	state.Vanguards = state.Vanguards[:0]
	state.Rangers = state.Rangers[:0]
	for _, unit := range state.Units {
		switch unit.UnitType {
		case domain.UnitWorker:
			state.Workers = append(state.Workers, unit)
		case domain.UnitVanguard:
			state.Vanguards = append(state.Vanguards, unit)
		case domain.UnitRanger:
			state.Rangers = append(state.Rangers, unit)
		}
	}
}
