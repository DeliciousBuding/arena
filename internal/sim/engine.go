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
	ResourceDelta int
}

// Engine 是确定性结算引擎（无状态，并发安全）。
type Engine struct{}

// NewEngine 构造结算引擎。
func NewEngine() *Engine {
	return &Engine{}
}

// Settle 结算一个 tick：应用移动与经济活动，产出下一状态。
// 确定性：同输入同输出（无随机、稳定遍历顺序）。
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

	return SettleResult{NextState: next, Events: events, Stats: stats}
}
