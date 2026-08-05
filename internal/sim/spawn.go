package sim

import (
	"fmt"

	"github.com/deliciousbuding/arena/internal/domain"
)

// 资源容量公式与 domain reducer 同源（max(minCapacity, pop*capacityPerUnit)）。
const (
	coreMinCapacity     = 10
	coreCapacityPerUnit = 5
)

// applyCoreAction 结算 Core 动作（本批仅 SPAWN WORKER）：
//   - 占位语义（TS 版破锁）：Core 格上的满载 Worker 不阻止 SPAWN；
//     空载 Worker / Vanguard / Ranger 视为永久占位（permanentOccupant），
//     阻止 SPAWN 结算（SPAWN_BLOCKED_CORE_OCCUPIED）；
//   - 资源扣除（resources -= cost）与人口/容量刷新
//     （capacity = max(10, pop*5)，space = capacity - resources）；
//   - 新 Worker 出生在 Core 格（ID 确定性生成）。
func (e *Engine) applyCoreAction(state *domain.TickState, action *domain.CoreAction) []domain.Event {
	if action == nil || action.Kind != domain.CoreSpawn || action.UnitType == nil {
		return nil
	}
	unitType := *action.UnitType
	if unitType != domain.UnitWorker {
		// 裁决范围：本批仅支持 WORKER（Vanguard/Ranger 后续批次）。
		return []domain.Event{{Tick: state.Tick, EventType: "SPAWN_UNSUPPORTED"}}
	}
	if state.Core == nil {
		return []domain.Event{{Tick: state.Tick, EventType: "SPAWN_FAILED_NO_CORE"}}
	}
	if occupant := permanentCoreOccupant(state); occupant != "" {
		return []domain.Event{{
			Tick:      state.Tick,
			EventType: "SPAWN_BLOCKED_CORE_OCCUPIED",
			ActorID:   &occupant,
		}}
	}
	cost := domain.SpawnCost(unitType)
	if state.Resources < cost {
		return []domain.Event{{Tick: state.Tick, EventType: "SPAWN_FAILED_INSUFFICIENT_RESOURCES"}}
	}

	state.Resources -= cost
	unitID := fmt.Sprintf("sim-%s-%d", string(unitType), state.Population+1)
	unit := domain.UnitSnapshot{
		ID:       unitID,
		Position: state.Core.Position,
		HP:       domain.UnitMaxHP(unitType),
		UnitType: unitType,
		Cargo:    0,
	}
	state.Units = append(state.Units, unit)
	state.Workers = append(state.Workers, unit)
	state.Population++
	refreshCapacity(state)

	return []domain.Event{{
		Tick:      state.Tick,
		EventType: "SPAWN",
		ActorID:   &unitID,
		Values:    map[string]any{"unitType": string(unitType), "cost": cost},
	}}
}

// permanentCoreOccupant 返回 Core 格上的永久占位单位 ID；
// 满载 Worker 让位语义下不视为永久占位（空串表示无阻挡）。
func permanentCoreOccupant(state *domain.TickState) string {
	if state.Core == nil {
		return ""
	}
	for i := range state.Units {
		unit := &state.Units[i]
		if unit.Position != state.Core.Position {
			continue
		}
		if unit.UnitType == domain.UnitWorker && unit.Cargo > 0 {
			continue // 满载 Worker：本 tick 让位后 SPAWN 即可结算
		}
		return unit.ID
	}
	return ""
}

// refreshCapacity 按人口重算容量与剩余空间（与 domain reducer 同公式）。
func refreshCapacity(state *domain.TickState) {
	capacity := coreMinCapacity
	if capacity < state.Population*coreCapacityPerUnit {
		capacity = state.Population * coreCapacityPerUnit
	}
	state.ResourceCapacity = capacity
	state.ResourceSpace = capacity - state.Resources
}
