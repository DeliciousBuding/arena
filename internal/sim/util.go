package sim

import (
	"sort"

	"github.com/deliciousbuding/arena/internal/domain"
)

// cloneState 深拷贝 TickState（集合/切片独立副本，避免别名共享）。
func cloneState(state *domain.TickState) *domain.TickState {
	if state == nil {
		return nil
	}
	clone := *state
	clone.Units = append([]domain.UnitSnapshot(nil), state.Units...)
	clone.Workers = append([]domain.UnitSnapshot(nil), state.Workers...)
	clone.Vanguards = append([]domain.UnitSnapshot(nil), state.Vanguards...)
	clone.Rangers = append([]domain.UnitSnapshot(nil), state.Rangers...)
	clone.VisibleEnemies = append([]domain.VisibleEntity(nil), state.VisibleEnemies...)
	clone.ResourceCells = state.ResourceCells.Clone()
	clone.ObstacleCells = state.ObstacleCells.Clone()
	clone.Events = append([]domain.Event(nil), state.Events...)
	if state.Core != nil {
		core := *state.Core
		clone.Core = &core
	}
	return &clone
}

// sortedUnitIDs 返回计划的单位 ID 稳定升序（确定性结算顺序）。
func sortedUnitIDs(actions map[string]domain.UnitAction) []string {
	ids := make([]string, 0, len(actions))
	for unitID := range actions {
		ids = append(ids, unitID)
	}
	sort.Strings(ids)
	return ids
}
