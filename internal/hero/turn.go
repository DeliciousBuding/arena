package hero

import (
	"context"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
)

// Turn 是单 Tick 的计划构建器（对齐 TS 版 turn.ts）：
// 收集单位/Core 动作（wire 格式），构建完整提交计划。
type Turn struct {
	tick        int
	client      *ArenaHeroClient
	unitActions map[string]contracts.WireAction
	coreAction  *contracts.WireAction
	closed      bool
}

// NewTurn 创建指定 tick 的 Turn（不含客户端绑定；由 client.NewTurn 绑定）。
func NewTurn(tick int) *Turn {
	return &Turn{
		tick:        tick,
		unitActions: make(map[string]contracts.WireAction),
	}
}

// Tick 返回 Turn 的 tick。
func (t *Turn) Tick() int {
	return t.tick
}

func (t *Turn) ensureOpen() error {
	if t.closed {
		return newTurnClosedError("this Turn is no longer current")
	}
	return nil
}

// SetUnitAction 为指定单位设置动作（wire 校验；每单位至多一个，覆盖旧值）。
func (t *Turn) SetUnitAction(unitID string, action contracts.WireAction) error {
	if err := t.ensureOpen(); err != nil {
		return err
	}
	if err := contracts.ValidateWireUnitAction(&action); err != nil {
		return newInvalidActionError("invalid unit action: %v", err)
	}
	t.unitActions[unitID] = action
	return nil
}

// SetCoreAction 设置 Core 动作（wire 校验）。
func (t *Turn) SetCoreAction(action contracts.WireAction) error {
	if err := t.ensureOpen(); err != nil {
		return err
	}
	if err := contracts.ValidateWireCoreAction(&action); err != nil {
		return newInvalidActionError("invalid core action: %v", err)
	}
	t.coreAction = &action
	return nil
}

// Build 构建完整提交计划（独立副本；tick 固定；core_action 可空）。
func (t *Turn) Build() (contracts.CommandPlan, error) {
	if err := t.ensureOpen(); err != nil {
		return contracts.CommandPlan{}, err
	}
	unitActions := make(map[string]contracts.WireAction, len(t.unitActions))
	for id, action := range t.unitActions {
		unitActions[id] = action
	}
	var coreAction *contracts.WireAction
	if t.coreAction != nil {
		copy := *t.coreAction
		coreAction = &copy
	}
	return contracts.CommandPlan{
		Tick:        t.tick,
		UnitActions: unitActions,
		CoreAction:  coreAction,
	}, nil
}

// Replace 全量替换计划内容（先校验后生效）。
func (t *Turn) Replace(plan contracts.CommandPlan) error {
	if err := t.ensureOpen(); err != nil {
		return err
	}
	if err := contracts.ValidateCommandPlan(&plan); err != nil {
		return newInvalidActionError("invalid replacement plan: %v", err)
	}
	t.unitActions = make(map[string]contracts.WireAction, len(plan.UnitActions))
	for id, action := range plan.UnitActions {
		t.unitActions[id] = action
	}
	t.coreAction = plan.CoreAction
	return nil
}

// Clear 清空已收集的动作。
func (t *Turn) Clear() error {
	if err := t.ensureOpen(); err != nil {
		return err
	}
	t.unitActions = make(map[string]contracts.WireAction)
	t.coreAction = nil
	return nil
}

// Close 关闭 Turn（幂等）；关闭后一切操作返回 TurnClosedError。
func (t *Turn) Close() {
	t.closed = true
}

// Submit 提交计划（需经 client.NewTurn 绑定；idempotencyKey 空则自动生成）。
func (t *Turn) Submit(ctx context.Context, idempotencyKey string) (*contracts.Accepted, error) {
	if err := t.ensureOpen(); err != nil {
		return nil, err
	}
	if t.client == nil {
		return nil, newConfigurationError("turn is not bound to a client")
	}
	plan, err := t.Build()
	if err != nil {
		return nil, err
	}
	key, err := ValidateIdempotencyKey(idempotencyKey, t.tick)
	if err != nil {
		return nil, err
	}
	return t.client.Submit(ctx, plan, key)
}

// ---- 单位动作便捷方法 ----

// Move 为单位设置 MOVE 动作。
func (t *Turn) Move(unitID string, direction contracts.Direction) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitMove), Direction: &direction})
}

// Sweep 为单位设置 SWEEP 动作。
func (t *Turn) Sweep(unitID string, direction contracts.Direction) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitSweep), Direction: &direction})
}

// Shoot 为单位设置 SHOOT 动作（targetID 为 nil 时 cell fire）。
func (t *Turn) Shoot(unitID string, expectedCell contracts.Position, targetID *string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{
		Type: string(contracts.WireUnitShoot), TargetID: targetID, ExpectedCell: &expectedCell,
	})
}

// Harvest 为单位设置 HARVEST 动作。
func (t *Turn) Harvest(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitHarvest)})
}

// Deposit 为单位设置 DEPOSIT 动作。
func (t *Turn) Deposit(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitDeposit)})
}

// Heal 为单位设置 HEAL 动作。
func (t *Turn) Heal(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitHeal)})
}

// PickupBeacon 为单位设置 PICKUP_BEACON 动作。
func (t *Turn) PickupBeacon(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitPickupBeacon)})
}

// DropBeacon 为单位设置 DROP_BEACON 动作。
func (t *Turn) DropBeacon(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitDropBeacon)})
}

// SelfDestruct 为单位设置 SELF_DESTRUCT 动作。
func (t *Turn) SelfDestruct(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitSelfDestruct)})
}

// Wait 为单位设置 WAIT 动作。
func (t *Turn) Wait(unitID string) error {
	return t.SetUnitAction(unitID, contracts.WireAction{Type: string(contracts.WireUnitWait)})
}

// ---- Core 动作便捷方法 ----

func (t *Turn) setCore(action contracts.WireAction) error {
	return t.SetCoreAction(action)
}

// Spawn 为 Core 设置 SPAWN 动作。
func (t *Turn) Spawn(unitType contracts.UnitType) error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreSpawn), UnitType: &unitType})
}

// RepairShield 为 Core 设置 REPAIR_SHIELD 动作。
func (t *Turn) RepairShield() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreRepairShield)})
}

// StartMove 为 Core 设置 START_MOVE 动作。
func (t *Turn) StartMove(direction contracts.Direction) error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreStartMove), Direction: &direction})
}

// CancelMove 为 Core 设置 CANCEL_MOVE 动作。
func (t *Turn) CancelMove() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreCancelMove)})
}

// CoreHeal 为 Core 设置 HEAL 动作。
func (t *Turn) CoreHeal() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreHeal)})
}

// CorePickupBeacon 为 Core 设置 PICKUP_BEACON 动作。
func (t *Turn) CorePickupBeacon() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCorePickupBeacon)})
}

// CoreDropBeacon 为 Core 设置 DROP_BEACON 动作。
func (t *Turn) CoreDropBeacon() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreDropBeacon)})
}

// CoreSelfDestruct 为 Core 设置 SELF_DESTRUCT 动作。
func (t *Turn) CoreSelfDestruct() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreSelfDestruct)})
}

// CoreWait 为 Core 设置 WAIT 动作。
func (t *Turn) CoreWait() error {
	return t.setCore(contracts.WireAction{Type: string(contracts.WireCoreWait)})
}

// PlanToCommandPlan 将领域计划（validator 输出）转为可提交的 wire 计划。
func PlanToCommandPlan(plan *domain.Plan) (*contracts.CommandPlan, error) {
	if plan == nil {
		return nil, newProtocolError("plan is nil")
	}
	unitActions := make(map[string]contracts.WireAction, len(plan.UnitActions))
	for id, action := range plan.UnitActions {
		wire, err := domainActionToWire(action)
		if err != nil {
			return nil, err
		}
		unitActions[id] = wire
	}
	var coreAction *contracts.WireAction
	if plan.CoreAction != nil {
		wire := contracts.WireAction{Type: string(plan.CoreAction.Kind)}
		switch plan.CoreAction.Kind {
		case domain.CoreSpawn:
			if plan.CoreAction.UnitType == nil {
				return nil, newInvalidActionError("SPAWN requires unit_type")
			}
			unitType := contracts.UnitType(*plan.CoreAction.UnitType)
			wire.UnitType = &unitType
		case domain.CoreStartMove:
			// START_MOVE 需要 direction（wire 校验要求）。
			if plan.CoreAction.Direction == nil {
				return nil, newInvalidActionError("START_MOVE requires direction")
			}
			dir := contracts.Direction(*plan.CoreAction.Direction)
			wire.Direction = &dir
		}
		coreAction = &wire
	}
	commandPlan := &contracts.CommandPlan{
		Tick:        plan.Tick,
		UnitActions: unitActions,
		CoreAction:  coreAction,
	}
	if err := contracts.ValidateCommandPlan(commandPlan); err != nil {
		return nil, newInvalidActionError("invalid command plan: %v", err)
	}
	return commandPlan, nil
}

func domainActionToWire(action domain.UnitAction) (contracts.WireAction, error) {
	wire := contracts.WireAction{Type: string(action.Kind)}
	switch action.Kind {
	case domain.ActionMove, domain.ActionSweep:
		if action.Direction == nil {
			return wire, newInvalidActionError("%s requires direction", action.Kind)
		}
		dir := contracts.Direction(*action.Direction)
		wire.Direction = &dir
	case domain.ActionShoot:
		if action.ExpectedCell == nil {
			return wire, newInvalidActionError("SHOOT requires expected_cell")
		}
		cell := contracts.Position(*action.ExpectedCell)
		wire.ExpectedCell = &cell
		if action.TargetID != nil {
			wire.TargetID = action.TargetID
		}
	}
	return wire, nil
}
