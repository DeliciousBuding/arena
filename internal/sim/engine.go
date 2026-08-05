// Package sim 实现 Digital Twin 规则结算引擎（B7-B 前置）。
// 输入 TickState + Plan，确定性结算下一 tick 的状态变化。
// 本批：movement / economy / combat 子系统与 Settle 入口；信标/自毁后续批次。
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
	Moves          int
	Blocked        int
	Harvests       int
	Deposits       int
	Spawns         int
	SpawnBlocked   int
	ResourceDelta  int
	Kills          int // 本 tick 击杀的敌方实体数（战斗阶段）
	ShotsFired     int // 本 tick Ranger SHOOT 攻击数（含未命中）
	SweepsFired    int // 本 tick Vanguard SWEEP 攻击数（含未命中）
	UnitsLost      int // 本 tick 被敌方击杀的己方单位数
	HPRecovered    int // 本 tick 恢复的 HP 总量（单位 + Core HEAL）
	ShieldRepaired int // 本 tick 恢复的护盾量（REPAIR_SHIELD）
}

// Engine 是确定性结算引擎（默认无状态，并发安全；挂载 Refill 后
// 跨 tick 有状态——单写者使用，与 runtime Loop 一致）。
type Engine struct {
	// Refill 是资源补满引擎（官方规则：4 tick 配额 + 视野揭示）；
	// nil = 不启用（纯结算，fixture 回放路径不受影响）。
	Refill *RefillConfig
}

// NewEngine 构造结算引擎（默认不启用资源 refill）。
func NewEngine() *Engine {
	return &Engine{}
}

// Settle 结算一个 tick：应用移动、经济活动、战斗与 Core 动作，产出下一状态。
// 确定性：同输入同输出（无随机、稳定遍历顺序）。
// 结算顺序（裁决语义）：MOVE（让位）→ HARVEST/DEPOSIT → COMBAT → Core
// SPAWN——满载 Worker 本 tick 让位腾空 Core 格后，SPAWN 同 tick 即可结算；
// 战斗按官方顺序第 9-10 步（移动与经济之后、Core 动作之前），基于移动后
// 的 next 状态冻结战斗快照、同时应用伤害、移除死亡敌方实体。
// 挂载 Refill 时，settle 末尾执行视野揭示 + 每 4 tick 配额补满。
func (e *Engine) Settle(state *domain.TickState, plan *domain.Plan) SettleResult {
	next := cloneState(state)
	return e.settleInto(next, plan)
}

// SettleInPlace 原地结算：直接修改传入状态并返回（不克隆）。
// 调用方必须保证 state 结算后不再使用（批量评估/长跑热路径：
// 避免每 tick 879MB 级深拷贝分配——克隆是批量并发评估的 GC 主瓶颈，
// 16 并发仅 3.3x 的根因）。语义与 Settle 完全一致。
func (e *Engine) SettleInPlace(state *domain.TickState, plan *domain.Plan) SettleResult {
	return e.settleInto(state, plan)
}

// settleInto 是结算主体：在 next 状态上就地应用全部阶段。
// 确定性：同输入同输出（无随机、稳定遍历顺序）。
func (e *Engine) settleInto(next *domain.TickState, plan *domain.Plan) SettleResult {
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

	harvestEvents := e.applyHarvests(next, harvestWorkers, &stats)
	depositEvents := applyDeposits(next, depositWorkers, &stats)
	events = append(events, harvestEvents...)
	events = append(events, depositEvents...)

	combatEvents := applyCombat(next, plan, &stats)
	events = append(events, combatEvents...)

	// 敌方攻击（官方对称语义）：敌方单位攻击我方单位/Core，死亡移除。
	enemyEvents := applyEnemyAttacks(next, &stats)
	events = append(events, enemyEvents...)

	// 单位 HEAL（战斗伤害后、Core 动作前；升序 UUID 先结算，官方顺序
	// 第 11 步），随后 Core 动作使用剩余资源。
	healEvents := applyUnitHeals(next, plan)
	for _, event := range healEvents {
		if event.EventType == "UNIT_HEAL_SUCCEEDED" {
			if amount, ok := event.Values["amount"].(int); ok {
				stats.HPRecovered += amount
			}
		}
	}
	events = append(events, healEvents...)

	coreEvents := e.applyCoreAction(next, plan.CoreAction)
	for _, event := range coreEvents {
		if event.EventType == "SPAWN" {
			stats.Spawns++
		}
		if event.EventType == "SPAWN_BLOCKED_CORE_OCCUPIED" {
			stats.SpawnBlocked++
		}
		if event.EventType == "CORE_HEAL_SUCCEEDED" {
			if amount, ok := event.Values["amount"].(int); ok {
				stats.HPRecovered += amount
			}
		}
		if event.EventType == "CORE_SHIELD_REPAIRED" {
			stats.ShieldRepaired++
		}
	}
	events = append(events, coreEvents...)

	// 一致性：分列（Workers/Vanguards/Rangers）从 Units 重建——结算只
	// 修改 Units 的位置/cargo，若不回写分列，决策（读 Units）与分配
	// （读分列）会看到不同状态，导致闭环卡死（真实拓扑测试暴露）。
	rebuildColumns(next)

	// 资源 refill + 视野揭示（官方规则）：reveal 每 tick 执行（视野内
	// active 潜在格进入 ResourceCells），refill 每 4 tick 补满配额
	// （mined 格恢复 active）。挂载 Refill 时才启用（fixture 回放保持
	// 纯结算不变）。
	if e.Refill != nil {
		e.Refill.applyRefillAndReveal(next)
	}

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
