// Package strategy 实现确定性规划器（SafetyPlanner 语义子集）。
// 当前为纵向闭环的最小合法实现：spawn/harvest/deposit/巡逻/防御，
// 与 TS 版 SafetyPlanner 的差分对齐在阶段 A 验收进行。
package strategy

import (
	"sort"

	"github.com/deliciousbuding/arena/internal/domain"
)

// Config 是规划器配置（对齐 TS 版 DEFAULT_SAFETY_CONFIG）。
type Config struct {
	WorkerTarget      int // 目标 Worker 数（spawn 阈值）
	PopulationCeiling int // 人口上限
	ExploreRadius     int // 探索半径
	ThreatDistance    int // 威胁判定距离（Manhattan）
}

// DefaultConfig 返回默认配置。
func DefaultConfig() Config {
	return Config{
		WorkerTarget:      8,
		PopulationCeiling: 20,
		ExploreRadius:     8,
		ThreatDistance:    5,
	}
}

// Planner 是确定性规划器（无副作用，不接触游戏）。
type Planner struct {
	config       Config
	exploreIndex int
}

// NewPlanner 创建规划器。
func NewPlanner(config Config) *Planner {
	return &Planner{config: config}
}

// Decide 产出确定性计划（同输入同输出）。
func (p *Planner) Decide(state *domain.TickState) *domain.Plan {
	plan := &domain.Plan{
		Tick:        state.Tick,
		UnitActions: make(map[string]domain.UnitAction),
		Intents:     make(map[string]string),
	}

	if coreAction := p.decideCore(state); coreAction != nil {
		plan.CoreAction = coreAction
		plan.Intents["core"] = "spawn"
	}

	unitIDs := make([]string, 0, len(state.Units))
	for _, unit := range state.Units {
		unitIDs = append(unitIDs, unit.ID)
	}
	sort.Strings(unitIDs)
	for _, id := range unitIDs {
		if action, intent, ok := p.decideUnit(state, id); ok {
			plan.UnitActions[id] = action
			plan.Intents[id] = intent
		}
	}
	return plan
}

func (p *Planner) decideCore(state *domain.TickState) *domain.CoreAction {
	if state.Core == nil || state.Core.State != domain.CoreNormal {
		return nil
	}
	workers := len(state.Workers)
	if workers < p.config.WorkerTarget && state.Population < p.config.PopulationCeiling &&
		state.Resources >= domain.SpawnCost(domain.UnitWorker) {
		unitType := domain.UnitWorker
		return &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &unitType}
	}
	if state.Core.HP < domain.CoreMaxHP && workers >= 2 {
		return &domain.CoreAction{Kind: domain.CoreHeal}
	}
	return nil
}

func (p *Planner) decideUnit(state *domain.TickState, unitID string) (domain.UnitAction, string, bool) {
	var unit *domain.UnitSnapshot
	for i := range state.Units {
		if state.Units[i].ID == unitID {
			unit = &state.Units[i]
			break
		}
	}
	if unit == nil {
		return domain.UnitAction{}, "", false
	}

	// 信标拾取优先。
	if state.Beacon.Status == domain.BeaconGround && state.Beacon.CarrierID == nil &&
		unit.Position == state.Beacon.Position {
		return domain.UnitAction{Kind: domain.ActionPickupBeacon}, "beacon", true
	}

	switch unit.UnitType {
	case domain.UnitWorker:
		return p.decideWorker(state, unit)
	case domain.UnitVanguard:
		return p.decideVanguard(state, unit)
	case domain.UnitRanger:
		return p.decideRanger(state, unit)
	}
	return domain.UnitAction{}, "", false
}

func (p *Planner) decideWorker(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if unit.Cargo >= 1 {
		if state.ResourceSpace <= 0 {
			// Core 容量已满（resources == capacity）：无处可存，
			// 原地等待防 deposit 非法动作循环。
			return domain.UnitAction{Kind: domain.ActionWait}, "wait_full", true
		}
		if state.Core != nil && unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionDeposit}, "deposit", true
		}
		if state.Core != nil {
			return p.moveToward(state, unit, state.Core.Position), "return_core", true
		}
		return domain.UnitAction{Kind: domain.ActionWait}, "wait", true
	}
	if state.ResourceCells.Contains(domain.CellKey(unit.Position[0], unit.Position[1])) {
		return domain.UnitAction{Kind: domain.ActionHarvest}, "harvest", true
	}
	if target := nearestResourceCell(state); target != nil {
		return p.moveToward(state, unit, *target), "to_resource", true
	}
	return p.patrol(state, unit), "explore", true
}

func (p *Planner) decideVanguard(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if enemy := nearestEnemy(state, unit.Position, p.config.ThreatDistance); enemy != nil {
		return p.moveToward(state, unit, enemy.Position), "engage", true
	}
	if state.Core != nil && unit.HP < domain.UnitMaxHP(unit.UnitType) {
		if unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionHeal}, "heal", true
		}
		return p.moveToward(state, unit, state.Core.Position), "to_core_heal", true
	}
	return p.patrol(state, unit), "patrol", true
}

func (p *Planner) decideRanger(state *domain.TickState, unit *domain.UnitSnapshot) (domain.UnitAction, string, bool) {
	if enemy := nearestEnemy(state, unit.Position, 3); enemy != nil {
		if !domain.LineBlocked(unit.Position, enemy.Position, state.ObstacleCells) {
			targetID := enemy.ID
			cell := enemy.Position
			return domain.UnitAction{Kind: domain.ActionShoot, TargetID: &targetID, ExpectedCell: &cell}, "shoot", true
		}
	}
	if state.Core != nil && unit.HP < domain.UnitMaxHP(unit.UnitType) {
		if unit.Position == state.Core.Position {
			return domain.UnitAction{Kind: domain.ActionHeal}, "heal", true
		}
		return p.moveToward(state, unit, state.Core.Position), "to_core_heal", true
	}
	return p.patrol(state, unit), "patrol", true
}

func (p *Planner) moveToward(state *domain.TickState, unit *domain.UnitSnapshot, target domain.Position) domain.UnitAction {
	if direction, ok := domain.StepToward(unit.Position, target, state.ObstacleCells); ok {
		dir := direction
		return domain.UnitAction{Kind: domain.ActionMove, Direction: &dir}
	}
	return domain.UnitAction{Kind: domain.ActionWait}
}

func (p *Planner) patrol(state *domain.TickState, unit *domain.UnitSnapshot) domain.UnitAction {
	home := domain.Position{0, 0}
	if state.Core != nil {
		home = state.Core.Position
	}
	target := domain.ExploreTarget(home, state.Beacon.Position, p.exploreIndex%8, p.config.ExploreRadius)
	p.exploreIndex++
	return p.moveToward(state, unit, target)
}

func nearestResourceCell(state *domain.TickState) *domain.Position {
	var best *domain.Position
	for key := range state.ResourceCells {
		position, err := domain.ParseCellKey(key)
		if err != nil {
			continue
		}
		if best == nil {
			copy := position
			best = &copy
			continue
		}
		if position[0] < best[0] || (position[0] == best[0] && position[1] < best[1]) {
			copy := position
			best = &copy
		}
	}
	return best
}

func nearestEnemy(state *domain.TickState, from domain.Position, radius int) *domain.VisibleEntity {
	var best *domain.VisibleEntity
	bestDistance := 0
	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		distance := domain.Manhattan(from, enemy.Position)
		if distance > radius {
			continue
		}
		if best == nil || distance < bestDistance ||
			(distance == bestDistance && enemy.ID < best.ID) {
			best = enemy
			bestDistance = distance
		}
	}
	return best
}
