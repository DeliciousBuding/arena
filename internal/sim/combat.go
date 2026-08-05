package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// rangerRange 是 Ranger 射程（Chebyshev 距离判定，与 Ranger 视野半径一致；
// 官方规则为八方向 1-3 格，本引擎按 5 格 Chebyshev + 视线遮挡裁决）。
const rangerRange = 5

// combatAttack 是一次已校验的合法攻击（伤害累积阶段产物）。
// SHOOT 命中带 targetID；SWEEP 命中带 hits 与受击实体 ID 列表。
type combatAttack struct {
	unitID    string
	eventType string // SHOOT / SHOOT_MISSED / SWEEP / SWEEP_MISSED
	cell      domain.Position
	targetID  string
	hits      int
	damageTo  []string
}

// applyCombat 结算战斗阶段（官方结算顺序第 9-10 步：冻结快照 → 校验并
// 累积所有合法攻击 → 同时应用伤害 → 移除死亡实体）。
//
// 快照语义：进入战斗时 MOVE/HARVEST/DEPOSIT 已结算，next 状态即冻结的
// 不可变战斗快照——所有攻击的校验与伤害累积都基于战斗前 HP（同 tick
// 攻击互不提前生效）。攻击按 sortedUnitIDs 确定性顺序收集；伤害统一
// 累积到 map 后一次性应用，最后从 VisibleEnemies 移除 HP<=0 的敌方
// 实体。战斗只作用于敌方（VisibleEnemies），己方单位不受己方攻击；
// 死亡单位无需手动清理分列（rebuildColumns 按 Units 重建）。
func applyCombat(state *domain.TickState, plan *domain.Plan, stats *SettleStats) []domain.Event {
	damageByID := make(map[string]int)
	attacks := make([]combatAttack, 0, 4)

	for _, unitID := range sortedUnitIDs(plan.UnitActions) {
		action, ok := plan.UnitActions[unitID]
		if !ok {
			continue
		}
		var attack combatAttack
		var valid bool
		switch action.Kind {
		case domain.ActionShoot:
			attack, valid = collectShoot(state, unitID, action)
		case domain.ActionSweep:
			attack, valid = collectSweep(state, unitID, action)
		default:
			continue
		}
		if !valid {
			continue // 非法攻击（非射手类型/缺字段/非法方向）静默忽略
		}
		for _, enemyID := range attack.damageTo {
			damageByID[enemyID]++
		}
		switch attack.eventType {
		case "SHOOT", "SHOOT_MISSED":
			stats.ShotsFired++
		case "SWEEP", "SWEEP_MISSED":
			stats.SweepsFired++
		}
		attacks = append(attacks, attack)
	}

	// 同时应用伤害：所有攻击累积完成后统一扣血（战斗快照语义）。
	kills := 0
	alive := state.VisibleEnemies[:0]
	for _, enemy := range state.VisibleEnemies {
		if damage, hit := damageByID[enemy.ID]; hit {
			enemy.HP -= damage
		}
		if enemy.HP <= 0 {
			kills++
			continue
		}
		alive = append(alive, enemy)
	}
	state.VisibleEnemies = alive
	stats.Kills += kills

	return buildCombatEvents(state.Tick, attacks)
}

// collectShoot 校验并累积一次 SHOOT 攻击：
//   - 合法：射手存活且为 Ranger，expected_cell 在 5 格 Chebyshev 内且
//     视线无遮挡（domain.LineBlocked）；
//   - 命中：带 target_id（精度模式）时目标必须仍在 expected_cell；
//     无 target_id（v0.13 空格射击）时命中该格 HP 最低的敌方实体
//     （同 HP 取 ID 升序，VisibleEnemies 按 ID 升序，顺序扫描即满足）；
//   - 目标不在格/越界/被遮挡统一为 SHOOT_MISSED。
//
// 返回 (攻击, 是否合法)；非法（非 Ranger/缺 expected_cell）返回 false。
func collectShoot(state *domain.TickState, unitID string, action domain.UnitAction) (combatAttack, bool) {
	unit := findUnit(state, unitID)
	if unit == nil || unit.UnitType != domain.UnitRanger || action.ExpectedCell == nil {
		return combatAttack{}, false
	}
	cell := *action.ExpectedCell
	distance := domain.Chebyshev(unit.Position, cell)
	if distance < 1 || distance > rangerRange || domain.LineBlocked(unit.Position, cell, state.ObstacleCells) {
		return combatAttack{unitID: unitID, eventType: "SHOOT_MISSED", cell: cell}, true
	}
	attack := combatAttack{unitID: unitID, eventType: "SHOOT_MISSED", cell: cell}
	var enemy *domain.VisibleEntity
	if action.TargetID != nil {
		enemy = findEnemyAt(state, *action.TargetID, cell)
	} else {
		enemy = lowestHPEnemyAt(state, cell)
	}
	if enemy != nil {
		attack.eventType = "SHOOT"
		attack.targetID = enemy.ID
		attack.damageTo = []string{enemy.ID}
	}
	return attack, true
}

// collectSweep 校验并累积一次 SWEEP 攻击：Vanguard 对相邻格（cardinal
// direction）内每个敌方单位/敌方 Core 各造成 1 伤害（AOE，官方规则：
// 敌 Core 同样受击，己方对象不受伤害）。格内无敌人为 SWEEP_MISSED。
// 返回 (攻击, 是否合法)；非法（非 Vanguard/缺方向/方向非法）返回 false。
func collectSweep(state *domain.TickState, unitID string, action domain.UnitAction) (combatAttack, bool) {
	unit := findUnit(state, unitID)
	if unit == nil || unit.UnitType != domain.UnitVanguard || action.Direction == nil {
		return combatAttack{}, false
	}
	if !domain.ValidDirection(*action.Direction) {
		return combatAttack{}, false
	}
	cell := domain.Move(unit.Position, *action.Direction)
	attack := combatAttack{unitID: unitID, eventType: "SWEEP_MISSED", cell: cell}
	for _, enemy := range state.VisibleEnemies {
		if enemy.Position != cell {
			continue
		}
		attack.hits++
		attack.damageTo = append(attack.damageTo, enemy.ID)
	}
	if attack.hits > 0 {
		attack.eventType = "SWEEP"
	}
	return attack, true
}

// findEnemyAt 按 ID 查找位于指定格的敌方实体（无则 nil）。
func findEnemyAt(state *domain.TickState, enemyID string, cell domain.Position) *domain.VisibleEntity {
	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		if enemy.ID == enemyID && enemy.Position == cell {
			return enemy
		}
	}
	return nil
}

// lowestHPEnemyAt 返回指定格内 HP 最低的敌方实体（同 HP 取 ID 升序，
// VisibleEnemies 按 ID 升序，顺序扫描天然满足）。无则 nil。
func lowestHPEnemyAt(state *domain.TickState, cell domain.Position) *domain.VisibleEntity {
	var best *domain.VisibleEntity
	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		if enemy.Position != cell {
			continue
		}
		if best == nil || enemy.HP < best.HP {
			best = enemy
		}
	}
	return best
}

// buildCombatEvents 按攻击收集顺序构造战斗事件（与 sortedUnitIDs 一致，
// 确定性）。命中事件带目标/命中数；miss 事件按官方语义省略 target_id。
func buildCombatEvents(tick int, attacks []combatAttack) []domain.Event {
	events := make([]domain.Event, 0, len(attacks))
	for _, attack := range attacks {
		actorID := attack.unitID
		cell := attack.cell
		event := domain.Event{
			Tick:      tick,
			EventType: attack.eventType,
			ActorID:   &actorID,
			Position:  &cell,
		}
		switch attack.eventType {
		case "SHOOT":
			targetID := attack.targetID
			event.TargetID = &targetID
			event.Values = map[string]any{"damage": 1}
		case "SWEEP":
			event.Values = map[string]any{"hits": attack.hits}
		}
		events = append(events, event)
	}
	return events
}
