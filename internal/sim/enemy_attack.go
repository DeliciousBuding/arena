package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// 敌方攻击结算（官方规则对称语义）：敌方单位在战斗阶段同时攻击我方。
//   - Vanguard：相邻格（Chebyshev 1）1 伤害；
//   - Ranger：八方向 1-3 格（轴向/对角线，视线无遮挡）1 伤害；
//   - Worker：无攻击；
//   - 目标选择：范围内最近的己方对象（单位优先于 Core，Manhattan 距离，
//     平局取 ID 升序——确定性）；
//   - 伤害先扣 Core Shield 再扣 HP（官方：shield before HP）；
//   - 我方单位 HP<=0 从 Units 移除（rebuildColumns 重建分列）；
//   - 事件：ENEMY_ATTACK（带 target_id + damage）、UNIT_DESTROYED、
//     CORE_DAMAGED（Values shieldRemaining/hpRemaining）。
//
// 快照语义与 applyCombat 一致：伤害统一累积后同时应用（同 tick 敌方
// 攻击互不提前生效）。

// enemyRangerRange 是敌方 Ranger 射程（八方向 1-3 格）。
const enemyRangerRange = 3

// applyEnemyAttacks 结算敌方攻击阶段（applyCombat 之后、Core SPAWN 之前）。
func applyEnemyAttacks(state *domain.TickState, stats *SettleStats) []domain.Event {
	damageByTarget := make(map[string]int)
	type attackInfo struct {
		actorID string
		target  string
	}
	attacks := make([]attackInfo, 0, 4)

	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		if enemy.Kind != "UNIT" || enemy.UnitType == nil {
			continue // 敌方 Core 的攻击结算不在本引擎范围（服务器侧）
		}
		if target := enemyAttackTarget(state, enemy); target != "" {
			damageByTarget[target]++
			attacks = append(attacks, attackInfo{actorID: enemy.ID, target: target})
		}
	}

	events := make([]domain.Event, 0, len(attacks)+2)
	for _, attack := range attacks {
		actorID := attack.actorID
		targetID := attack.target
		event := domain.Event{
			Tick:      state.Tick,
			EventType: "ENEMY_ATTACK",
			ActorID:   &actorID,
			TargetID:  &targetID,
			Values:    map[string]any{"damage": 1},
		}
		events = append(events, event)
	}

	// 同时应用伤害（快照语义）：Core Shield 优先，其次 Core HP，最后单位 HP。
	if state.Core != nil {
		if damage, hit := damageByTarget["core"]; hit {
			shieldAbsorb := damage
			if shieldAbsorb > state.Core.Shield {
				shieldAbsorb = state.Core.Shield
			}
			state.Core.Shield -= shieldAbsorb
			hpDamage := damage - shieldAbsorb
			if hpDamage > 0 {
				state.Core.HP -= hpDamage
			}
			event := domain.Event{
				Tick:      state.Tick,
				EventType: "CORE_DAMAGED",
				Values: map[string]any{
					"damage":          damage,
					"shieldRemaining": state.Core.Shield,
					"hpRemaining":     state.Core.HP,
				},
			}
			events = append(events, event)
		}
	}

	// 单位死亡移除（Units 内按 ID 稳定顺序重建）。
	alive := state.Units[:0]
	for _, unit := range state.Units {
		if damage, hit := damageByTarget[unit.ID]; hit {
			unit.HP -= damage
		}
		if unit.HP <= 0 {
			stats.UnitsLost++
			unitID := unit.ID
			events = append(events, domain.Event{
				Tick:      state.Tick,
				EventType: "UNIT_DESTROYED",
				ActorID:   &unitID,
				Values:    map[string]any{"unitType": string(unit.UnitType)},
			})
			continue
		}
		alive = append(alive, unit)
	}
	state.Units = alive
	return events
}

// enemyAttackTarget 返回敌方单位的目标（"" = 无目标）：
// 范围内最近的己方对象——Core 用固定键 "core"，单位用 ID。
// 目标优先级：Manhattan 距离近者优先；同距离单位优先于 Core。
// Vanguard 相邻格；Ranger 八方向 1-3 格（视线无遮挡）。
func enemyAttackTarget(state *domain.TickState, enemy *domain.VisibleEntity) string {
	bestID := ""
	bestDistance := int(^uint(0) >> 1) // MaxInt
	bestIsCore := false

	consider := func(targetID string, distance int, isCore bool) {
		if distance > bestDistance {
			return
		}
		if distance == bestDistance && isCore && !bestIsCore {
			return // 同距离单位优先于 Core
		}
		if distance < bestDistance || (distance == bestDistance && !isCore && bestIsCore) {
			bestID = targetID
			bestDistance = distance
			bestIsCore = isCore
		}
	}

	// 己方单位（按 Units 顺序，Manhattan 距离；同距离取 Units 先序）。
	for _, unit := range state.Units {
		if unit.Position == enemy.Position {
			continue
		}
		distance := domain.Manhattan(enemy.Position, unit.Position)
		if enemyCanHit(enemy, unit.Position, distance) {
			consider(unit.ID, distance, false)
		}
	}
	// Core（固定键 "core"）。
	if state.Core != nil && state.Core.Position != enemy.Position {
		distance := domain.Manhattan(enemy.Position, state.Core.Position)
		if enemyCanHit(enemy, state.Core.Position, distance) {
			consider("core", distance, true)
		}
	}
	return bestID
}

// enemyCanHit 报告敌方单位能否命中目标格（按官方攻击表）：
// Vanguard 相邻 1 格（Chebyshev）；Ranger 八方向 1-3 格且视线无遮挡。
func enemyCanHit(enemy *domain.VisibleEntity, target domain.Position, manhattan int) bool {
	if enemy.UnitType == nil {
		return false
	}
	chebyshev := domain.Chebyshev(enemy.Position, target)
	switch *enemy.UnitType {
	case domain.UnitVanguard:
		return chebyshev == 1
	case domain.UnitRanger:
		if manhattan < 1 || manhattan > enemyRangerRange {
			return false
		}
		// 八方向：轴向（dx==0 || dy==0）或对角线（|dx|==|dy|）。
		dx := target[0] - enemy.Position[0]
		dy := target[1] - enemy.Position[1]
		if dx != 0 && dy != 0 && absInt(dx) != absInt(dy) {
			return false
		}
		return true
	}
	return false
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
