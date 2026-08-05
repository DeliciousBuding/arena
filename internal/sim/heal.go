package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// 治疗/护盾修复结算（官方规则）：
//   - HEAL 消耗对象完整动作，战斗伤害结算后执行；每恢复 1 HP 花费 1 资源
//     （从 Core 仓库扣），一次动作恢复尽量多 HP（受剩余资源与上限约束）；
//   - 单位 HEAL 必须存活且与己方静止 Core 同格（升序 UUID 先结算，
//     随后 Core 动作使用剩余资源）；
//   - REPAIR_SHIELD 恰好花费 1 资源恢复 1 盾（不超过当前盾上限）；
//   - 事件：UNIT_HEAL_SUCCEEDED / CORE_HEAL_SUCCEEDED（amount/hp/cost）、
//     CORE_SHIELD_REPAIRED（shield/cost）、失败事件
//     UNIT_HEAL_FAILED / CORE_HEAL_FAILED / SHIELD_REPAIR_FAILED
//     （HP_FULL / SHIELD_FULL / INSUFFICIENT_RESOURCES / NOT_AT_OWN_CORE /
//     CORE_MOVING）。

// applyUnitHeals 结算单位 HEAL 动作（战斗伤害后、Core 动作前；
// 按 sortedUnitIDs 确定性顺序，官方：升序 UUID）。返回事件；
// 恢复量由调用方从事件统计（Settle 内 HPRecovered 累积）。
func applyUnitHeals(state *domain.TickState, plan *domain.Plan) []domain.Event {
	events := make([]domain.Event, 0, 4)
	for _, unitID := range sortedUnitIDs(plan.UnitActions) {
		action, ok := plan.UnitActions[unitID]
		if !ok || action.Kind != domain.ActionHeal {
			continue
		}
		unit := findUnit(state, unitID)
		if unit == nil {
			continue
		}
		event := healEvent(state.Tick, unitID, "UNIT_HEAL_FAILED")
		if state.Core == nil {
			reason := "NOT_AT_OWN_CORE"
			event.ReasonCode = &reason
			events = append(events, event)
			continue
		}
		if state.Core.State != domain.CoreNormal {
			reason := "CORE_MOVING"
			event.ReasonCode = &reason
			events = append(events, event)
			continue
		}
		if unit.Position != state.Core.Position {
			reason := "NOT_AT_OWN_CORE"
			event.ReasonCode = &reason
			events = append(events, event)
			continue
		}
		missing := domain.UnitMaxHP(unit.UnitType) - unit.HP
		if missing <= 0 {
			reason := "HP_FULL"
			event.ReasonCode = &reason
			events = append(events, event)
			continue
		}
		// 每恢复 1 HP 花费 1 资源（受剩余资源约束）。
		amount := missing
		if state.Resources < amount {
			amount = state.Resources
		}
		if amount <= 0 {
			reason := "INSUFFICIENT_RESOURCES"
			event.ReasonCode = &reason
			events = append(events, event)
			continue
		}
		unit.HP += amount
		state.Resources -= amount
		events = append(events, healEvent(state.Tick, unitID, "UNIT_HEAL_SUCCEEDED", amount, unit.HP, amount))
	}
	return events
}

// applyCoreHeal 结算 Core HEAL 动作（SPAWN 之后、Core 动作内：
// 每恢复 1 HP 花费 1 资源；失败 HP_FULL / INSUFFICIENT_RESOURCES）。
func applyCoreHeal(state *domain.TickState, action *domain.CoreAction) []domain.Event {
	if action == nil || action.Kind != domain.CoreHeal || state.Core == nil {
		return nil
	}
	event := healEvent(state.Tick, "core", "CORE_HEAL_FAILED")
	missing := domain.CoreMaxHP - state.Core.HP
	if missing <= 0 {
		reason := "HP_FULL"
		event.ReasonCode = &reason
		return []domain.Event{event}
	}
	amount := missing
	if state.Resources < amount {
		amount = state.Resources
	}
	if amount <= 0 {
		reason := "INSUFFICIENT_RESOURCES"
		event.ReasonCode = &reason
		return []domain.Event{event}
	}
	state.Core.HP += amount
	state.Resources -= amount
	return []domain.Event{healEvent(state.Tick, "core", "CORE_HEAL_SUCCEEDED", amount, state.Core.HP, amount)}
}

// applyCoreShieldRepair 结算 REPAIR_SHIELD 动作：恰好 1 资源恢复 1 盾
// （不超过当前盾上限；失败 SHIELD_FULL / INSUFFICIENT_RESOURCES）。
func applyCoreShieldRepair(state *domain.TickState, action *domain.CoreAction) []domain.Event {
	if action == nil || action.Kind != domain.CoreRepairShield || state.Core == nil {
		return nil
	}
	event := healEvent(state.Tick, "core", "SHIELD_REPAIR_FAILED")
	if state.Core.Shield >= domain.CoreMaxShield {
		reason := "SHIELD_FULL"
		event.ReasonCode = &reason
		return []domain.Event{event}
	}
	if state.Resources < 1 {
		reason := "INSUFFICIENT_RESOURCES"
		event.ReasonCode = &reason
		return []domain.Event{event}
	}
	state.Core.Shield++
	state.Resources--
	return []domain.Event{healEvent(state.Tick, "core", "CORE_SHIELD_REPAIRED", 1, state.Core.Shield, 1)}
}

// healEvent 构造治疗/修复事件（成功带 amount/hp/cost；失败带 reason）。
func healEvent(tick int, actorID string, eventType string, values ...int) domain.Event {
	event := domain.Event{
		Tick:      tick,
		EventType: eventType,
		ActorID:   &actorID,
	}
	if len(values) == 3 {
		event.Values = map[string]any{
			"amount": values[0],
			"hp":     values[1],
			"cost":   values[2],
		}
	}
	return event
}
