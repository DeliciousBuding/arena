package domain

// Plan 是一次决策的完整动作计划（对齐 TS 版 Plan）。
type Plan struct {
	Tick        int
	UnitActions map[string]UnitAction
	CoreAction  *CoreAction
	Intents     map[string]string
}

// UnitActionKind 是单位动作类型。
type UnitActionKind string

// UnitActionKind 枚举（与服务器/arena_plan 协议一致）。
const (
	ActionWait         UnitActionKind = "WAIT"
	ActionMove         UnitActionKind = "MOVE"
	ActionHarvest      UnitActionKind = "HARVEST"
	ActionDeposit      UnitActionKind = "DEPOSIT"
	ActionSweep        UnitActionKind = "SWEEP"
	ActionShoot        UnitActionKind = "SHOOT"
	ActionPickupBeacon UnitActionKind = "PICKUP_BEACON"
	ActionDropBeacon   UnitActionKind = "DROP_BEACON"
	ActionSelfDestruct UnitActionKind = "SELF_DESTRUCT"
	ActionHeal         UnitActionKind = "HEAL"
)

// UnitAction 是单位动作。
type UnitAction struct {
	Kind         UnitActionKind
	Direction    *Direction
	TargetID     *string
	ExpectedCell *Position
}

// CoreActionKind 是 Core 动作类型。
type CoreActionKind string

// CoreActionKind 枚举。
const (
	CoreWait         CoreActionKind = "WAIT"
	CoreSpawn        CoreActionKind = "SPAWN"
	CoreRepairShield CoreActionKind = "REPAIR_SHIELD"
	CoreHeal         CoreActionKind = "HEAL"
	CoreStartMove    CoreActionKind = "START_MOVE"
	CoreCancelMove   CoreActionKind = "CANCEL_MOVE"
	CorePickupBeacon CoreActionKind = "PICKUP_BEACON"
	CoreDropBeacon   CoreActionKind = "DROP_BEACON"
	CoreSelfDestruct CoreActionKind = "SELF_DESTRUCT"
)

// CoreAction 是 Core 动作。
type CoreAction struct {
	Kind      CoreActionKind
	UnitType  *UnitType
	Direction *Direction // START_MOVE 方向
}

// 单位与 Core 属性常量（与服务器规则一致）。
const (
	UnitMaxHPWorker   = 2
	UnitMaxHPVanguard = 4
	UnitMaxHPRanger   = 2
	CoreMaxHP         = 5
	CoreMaxShield     = 5
)

// SpawnCost 返回单位生成成本（与服务器规则一致）。
func SpawnCost(unitType UnitType) int {
	switch unitType {
	case UnitWorker:
		return 5
	case UnitVanguard:
		return 10
	case UnitRanger:
		return 12
	}
	return 0
}

// UnitMaxHP 返回单位最大 HP。
func UnitMaxHP(unitType UnitType) int {
	switch unitType {
	case UnitWorker:
		return UnitMaxHPWorker
	case UnitVanguard:
		return UnitMaxHPVanguard
	case UnitRanger:
		return UnitMaxHPRanger
	}
	return 0
}

// ValidationCode 是校验失败分类（与 TS 版一致）。
type ValidationCode string

// ValidationCode 枚举。
const (
	CodeTickMismatch          ValidationCode = "tick_mismatch"
	CodeUnknownUnit           ValidationCode = "unknown_unit"
	CodeWrongCapability       ValidationCode = "wrong_capability"
	CodeBlockedMove           ValidationCode = "blocked_move"
	CodeInvalidHarvest        ValidationCode = "invalid_harvest"
	CodeInvalidDeposit        ValidationCode = "invalid_deposit"
	CodeInvalidHeal           ValidationCode = "invalid_heal"
	CodeInvalidBeacon         ValidationCode = "invalid_beacon"
	CodeInvalidShot           ValidationCode = "invalid_shot"
	CodeMissingCore           ValidationCode = "missing_core"
	CodeCoreUnavailable       ValidationCode = "core_unavailable"
	CodeInsufficientResources ValidationCode = "insufficient_resources"
)

// ValidationIssue 是单条校验问题。
type ValidationIssue struct {
	Code    ValidationCode
	ActorID string
	Message string
}

// ValidationResult 是校验结果（repaired 计划 + 问题列表）。
type ValidationResult struct {
	Valid    bool
	Repaired bool
	Plan     Plan
	Issues   []ValidationIssue
}
