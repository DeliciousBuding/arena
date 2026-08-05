package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// worldBound 是模拟地图边界（坐标绝对值上限，超出禁止移动）。
const worldBound = 1000

// applyMove 应用单个 MOVE 动作：障碍/边界/冲突阻挡时不移动。
// 返回 (已移动, 阻挡原因)；未移动且未阻挡时返回 (false, "")（如原地）。
func applyMove(state *domain.TickState, unitID string, action domain.UnitAction, stats *SettleStats) (bool, string) {
	unit := findUnit(state, unitID)
	if unit == nil || action.Direction == nil {
		return false, ""
	}
	next := domain.Move(unit.Position, *action.Direction)

	if state.ObstacleCells.Contains(domain.CellKey(next[0], next[1])) {
		stats.Blocked++
		return false, "MOVE_BLOCKED_OBSTACLE"
	}
	if next[0] < -worldBound || next[0] > worldBound || next[1] < -worldBound || next[1] > worldBound {
		stats.Blocked++
		return false, "MOVE_BLOCKED_BOUNDARY"
	}
	if occupiedByOther(state, unitID, next) {
		stats.Blocked++
		return false, "MOVE_BLOCKED_OCCUPIED"
	}

	unit.Position = next
	stats.Moves++
	return true, ""
}

// occupiedByOther 报告目标格是否被其他己方单位占据（按 ID 排序后的
// 位置快照判断：模拟按计划顺序依次移动，已移动单位占据新格视为占用）。
func occupiedByOther(state *domain.TickState, unitID string, cell domain.Position) bool {
	for i := range state.Units {
		other := &state.Units[i]
		if other.ID == unitID {
			continue
		}
		if other.Position == cell {
			return true
		}
	}
	return false
}

// findUnit 按 ID 查找己方单位（可变引用，供结算修改位置）。
func findUnit(state *domain.TickState, unitID string) *domain.UnitSnapshot {
	for i := range state.Units {
		if state.Units[i].ID == unitID {
			return &state.Units[i]
		}
	}
	return nil
}

// moveEvent 构造移动结算事件（方向或阻挡原因二选一）。
func moveEvent(tick int, unitID string, direction *domain.Direction, reason string) domain.Event {
	event := domain.Event{
		Tick:      tick,
		EventType: "MOVE",
		ActorID:   &unitID,
	}
	if reason != "" {
		event.EventType = "MOVE_BLOCKED"
		event.ReasonCode = &reason
	} else if direction != nil {
		event.Values = map[string]any{"direction": string(*direction)}
	}
	return event
}
