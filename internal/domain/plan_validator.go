package domain

import "fmt"

// ValidatePlan 对候选计划做语义校验并返回修复结果（与 TS 版
// validatePlan 同语义；见 RepairPlan）。
func ValidatePlan(state *TickState, plan Plan) ValidationResult {
	return RepairPlan(state, plan)
}

// RepairPlan 逐动作语义校验候选计划（与 TS 版 validatePlan 同语义）：
//   - tick 不匹配 → 直接返回空计划（tick_mismatch）；
//   - 未知单位（不在己方单位中）剔除并记录 unknown_unit；
//   - 逐动作校验（能力/位置/LOS/资源/beacon 等），非法动作从修复后的
//     计划中剔除（repair = 剔除，不降级为 WAIT，与 TS 版一致）；
//   - Core 动作非法则置空；
//   - 合法动作与其 intents 原样保留；动作按 unit ID 升序确定性处理。
func RepairPlan(state *TickState, plan Plan) ValidationResult {
	if plan.Tick != state.Tick {
		return ValidationResult{
			Valid:    false,
			Repaired: true,
			Plan: Plan{
				Tick:        state.Tick,
				UnitActions: map[string]UnitAction{},
				Intents:     map[string]string{},
			},
			Issues: []ValidationIssue{{
				Code:    CodeTickMismatch,
				ActorID: "plan",
				Message: "plan tick does not match state tick",
			}},
		}
	}

	var issues []ValidationIssue
	unitActions := make(map[string]UnitAction, len(plan.UnitActions))
	intents := make(map[string]string)

	ids := make([]string, 0, len(plan.UnitActions))
	for unitID := range plan.UnitActions {
		ids = append(ids, unitID)
	}
	sortStrings(ids)

	for _, unitID := range ids {
		action := plan.UnitActions[unitID]
		unit := findUnit(state, unitID)
		if unit == nil {
			issues = append(issues, ValidationIssue{
				Code:    CodeUnknownUnit,
				ActorID: unitID,
				Message: "unit is not currently controlled",
			})
			continue
		}
		if issue := validateUnitAction(state, unit, action); issue != nil {
			issues = append(issues, *issue)
			continue
		}
		unitActions[unitID] = action
		if intent, ok := plan.Intents[unitID]; ok {
			intents[unitID] = intent
		}
	}

	var coreAction *CoreAction
	if plan.CoreAction != nil {
		if issue := validateCoreAction(state, *plan.CoreAction); issue != nil {
			issues = append(issues, *issue)
		} else {
			copy := *plan.CoreAction
			coreAction = &copy
			if intent, ok := plan.Intents["core"]; ok {
				intents["core"] = intent
			}
		}
	}

	return ValidationResult{
		Valid:    len(issues) == 0,
		Repaired: len(issues) > 0,
		Plan: Plan{
			Tick:        state.Tick,
			UnitActions: unitActions,
			CoreAction:  coreAction,
			Intents:     intents,
		},
		Issues: issues,
	}
}

// validateUnitAction 校验单个单位动作（与 TS 版 validateUnitAction 同语义；
// Direction 缺失为 Go 结构性守卫，记 blocked_move——TS 判别联合无法表达）。
func validateUnitAction(state *TickState, unit *UnitSnapshot, action UnitAction) *ValidationIssue {
	issue := func(code ValidationCode, message string) *ValidationIssue {
		return &ValidationIssue{Code: code, ActorID: unit.ID, Message: message}
	}

	switch action.Kind {
	case ActionWait, ActionSelfDestruct:
		return nil
	case ActionMove:
		if action.Direction == nil {
			return issue(CodeBlockedMove, "MOVE requires a direction")
		}
		next := Move(unit.Position, *action.Direction)
		if state.ObstacleCells.Contains(CellKey(next[0], next[1])) {
			return issue(CodeBlockedMove, "destination is a known obstacle")
		}
		return nil
	case ActionHarvest:
		if unit.UnitType != UnitWorker {
			return issue(CodeWrongCapability, "only Workers can harvest")
		}
		if !state.ResourceCells.Contains(CellKey(unit.Position[0], unit.Position[1])) {
			return issue(CodeInvalidHarvest, "Worker is not standing on a visible resource cell")
		}
		return nil
	case ActionDeposit:
		if unit.UnitType != UnitWorker {
			return issue(CodeWrongCapability, "only Workers can deposit")
		}
		if unit.Cargo <= 0 || state.ResourceSpace <= 0 || state.Core == nil {
			return issue(CodeInvalidDeposit, "deposit requires cargo, Core capacity, and an active Core")
		}
		if !samePosition(unit.Position, state.Core.Position) {
			return issue(CodeInvalidDeposit, "Worker must be on the Core cell")
		}
		return nil
	case ActionSweep:
		if unit.UnitType != UnitVanguard {
			return issue(CodeWrongCapability, "only Vanguards can sweep")
		}
		return nil
	case ActionShoot:
		if unit.UnitType != UnitRanger {
			return issue(CodeWrongCapability, "only Rangers can shoot")
		}
		if action.ExpectedCell == nil {
			return issue(CodeInvalidShot, "SHOOT requires expected_cell")
		}
		cell := *action.ExpectedCell
		dx := cell[0] - unit.Position[0]
		dy := cell[1] - unit.Position[1]
		distance := max(abs(dx), abs(dy))
		aligned := dx == 0 || dy == 0 || abs(dx) == abs(dy)
		if distance < 1 || distance > 3 || !aligned ||
			LineBlocked(unit.Position, cell, state.ObstacleCells) {
			return issue(CodeInvalidShot, "target cell is out of line-of-sight range")
		}
		if action.TargetID != nil {
			target := findEnemy(state, *action.TargetID)
			if target == nil || !samePosition(target.Position, cell) {
				return issue(CodeInvalidShot, "target is not visible at expected_cell")
			}
		}
		return nil
	case ActionPickupBeacon:
		if state.Beacon.Status == BeaconGround && state.Beacon.CarrierID == nil &&
			samePosition(unit.Position, state.Beacon.Position) {
			return nil
		}
		return issue(CodeInvalidBeacon, "Beacon is not available on this cell")
	case ActionDropBeacon:
		if state.Beacon.CarrierID != nil && *state.Beacon.CarrierID == unit.ID {
			return nil
		}
		return issue(CodeInvalidBeacon, "unit is not carrying the Beacon")
	case ActionHeal:
		if state.Core == nil || state.Core.State != CoreNormal ||
			!samePosition(unit.Position, state.Core.Position) {
			return issue(CodeInvalidHeal, "unit healing requires a stationary Core on the same cell")
		}
		if unit.HP >= UnitMaxHP(unit.UnitType) {
			return issue(CodeInvalidHeal, "unit is already at maximum HP")
		}
		return nil
	}
	return issue(CodeWrongCapability, fmt.Sprintf("unknown action kind %q", action.Kind))
}

// validateCoreAction 校验 Core 动作（与 TS 版 validateCoreAction 同语义）。
func validateCoreAction(state *TickState, action CoreAction) *ValidationIssue {
	actorID := "core"
	if state.Core != nil {
		actorID = state.Core.ID
	}
	issue := func(code ValidationCode, message string) *ValidationIssue {
		return &ValidationIssue{Code: code, ActorID: actorID, Message: message}
	}
	if state.Core == nil {
		return issue(CodeMissingCore, "no controlled Core is available")
	}

	switch action.Kind {
	case CoreWait:
		return nil
	case CoreHeal:
		if state.Core.HP >= CoreMaxHP {
			return issue(CodeCoreUnavailable, "Core is already at maximum HP")
		}
		return nil
	case CoreRepairShield:
		if state.Core.State != CoreNormal || state.Core.Shield >= CoreMaxShield {
			return issue(CodeCoreUnavailable, "shield repair requires a stationary damaged Core")
		}
		if state.Resources < 1 {
			return issue(CodeInsufficientResources, "shield repair costs one resource")
		}
		return nil
	case CoreSpawn:
		if state.Core.State != CoreNormal {
			return issue(CodeCoreUnavailable, "moving Core cannot spawn")
		}
		if action.UnitType == nil {
			return issue(CodeCoreUnavailable, "SPAWN requires unit_type")
		}
		cost := SpawnCost(*action.UnitType)
		if state.Resources < cost {
			return issue(CodeInsufficientResources,
				fmt.Sprintf("spawn %s costs %d", *action.UnitType, cost))
		}
		return nil
	case CoreStartMove:
		if state.Core.State != CoreNormal {
			return issue(CodeCoreUnavailable, "Core is already moving")
		}
		return nil
	case CoreCancelMove:
		if state.Core.State != CoreMoving {
			return issue(CodeCoreUnavailable, "Core is not moving")
		}
		return nil
	case CorePickupBeacon:
		if state.Beacon.Status == BeaconGround &&
			samePosition(state.Core.Position, state.Beacon.Position) {
			return nil
		}
		return issue(CodeInvalidBeacon, "Beacon is not available on the Core cell")
	case CoreDropBeacon:
		if state.Beacon.CarrierID != nil && *state.Beacon.CarrierID == state.Core.ID {
			return nil
		}
		return issue(CodeInvalidBeacon, "Core is not carrying the Beacon")
	case CoreSelfDestruct:
		// v0.12：存活 Core 可无条件自毁。
		return nil
	}
	return issue(CodeCoreUnavailable, fmt.Sprintf("unknown core action kind %q", action.Kind))
}

// CountEnemiesNearCore 返回距 Core 曼哈顿距离 <= radius 的可见敌方数量
// （与 TS 版 countEnemiesNearCore 同语义；Core 缺失返回 0）。
func CountEnemiesNearCore(state *TickState, radius int) int {
	if state.Core == nil {
		return 0
	}
	count := 0
	for i := range state.VisibleEnemies {
		if Manhattan(state.VisibleEnemies[i].Position, state.Core.Position) <= radius {
			count++
		}
	}
	return count
}

// findUnit 按 ID 查找己方单位。
func findUnit(state *TickState, unitID string) *UnitSnapshot {
	for i := range state.Units {
		if state.Units[i].ID == unitID {
			return &state.Units[i]
		}
	}
	return nil
}

// findEnemy 按 ID 查找可见敌方实体。
func findEnemy(state *TickState, enemyID string) *VisibleEntity {
	for i := range state.VisibleEnemies {
		if state.VisibleEnemies[i].ID == enemyID {
			return &state.VisibleEnemies[i]
		}
	}
	return nil
}

func samePosition(a, b Position) bool {
	return a == b
}

// sortStrings 插入排序（确定性，按字节升序）。
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
