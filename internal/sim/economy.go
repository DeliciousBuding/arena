package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// applyHarvests 结算 HARVEST 动作：worker 必须站在可见资源格上，
// 成功 +1 cargo（每 tick 至多 1）。
func applyHarvests(state *domain.TickState, workerIDs []string, stats *SettleStats) []domain.Event {
	events := make([]domain.Event, 0, len(workerIDs))
	for _, unitID := range workerIDs {
		unit := findUnit(state, unitID)
		if unit == nil || unit.UnitType != domain.UnitWorker {
			continue
		}
		if !state.ResourceCells.Contains(domain.CellKey(unit.Position[0], unit.Position[1])) {
			events = append(events, harvestEvent(state.Tick, unitID, "HARVEST_FAILED_NO_RESOURCE"))
			continue
		}
		unit.Cargo++
		stats.Harvests++
		events = append(events, harvestEvent(state.Tick, unitID, ""))
	}
	return events
}

// applyDeposits 结算 DEPOSIT 动作：worker 带 cargo 且站在 Core 格，
// 资源入仓并遵守容量上限（超出部分丢弃并记 REJECTED）。
func applyDeposits(state *domain.TickState, workerIDs []string, stats *SettleStats) []domain.Event {
	events := make([]domain.Event, 0, len(workerIDs))
	for _, unitID := range workerIDs {
		unit := findUnit(state, unitID)
		if unit == nil || unit.UnitType != domain.UnitWorker || unit.Cargo <= 0 {
			continue
		}
		if state.Core == nil || unit.Position != state.Core.Position {
			events = append(events, depositEvent(state.Tick, unitID, "DEPOSIT_FAILED_NOT_AT_CORE"))
			continue
		}
		accepted := unit.Cargo
		if overflow := state.Resources + accepted - state.ResourceCapacity; overflow > 0 {
			accepted -= overflow
			events = append(events, depositEvent(state.Tick, unitID, "DEPOSIT_REJECTED_CAPACITY"))
		}
		if accepted > 0 {
			state.Resources += accepted
			stats.ResourceDelta += accepted
			stats.Deposits++
		}
		unit.Cargo -= accepted
	}
	return events
}

// harvestEvent 构造采集事件（reason 为空表示成功）。
func harvestEvent(tick int, unitID string, reason string) domain.Event {
	event := domain.Event{
		Tick:      tick,
		EventType: "HARVEST",
		ActorID:   &unitID,
	}
	if reason != "" {
		event.EventType = reason
	}
	return event
}

// depositEvent 构造存款事件（reason 为空表示成功）。
func depositEvent(tick int, unitID string, reason string) domain.Event {
	event := domain.Event{
		Tick:      tick,
		EventType: "DEPOSIT",
		ActorID:   &unitID,
	}
	if reason != "" {
		event.EventType = reason
	}
	return event
}
