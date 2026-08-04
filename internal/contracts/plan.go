package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ActionKind 是 arena_plan 单位动作类型（arena-plan.schema.json 的
// actions[].kind enum，与 hero SDK 的 UnitAction 判别一一对应）。
type ActionKind string

const (
	ActionMove         ActionKind = "MOVE"
	ActionSweep        ActionKind = "SWEEP"
	ActionShoot        ActionKind = "SHOOT"
	ActionHarvest      ActionKind = "HARVEST"
	ActionDeposit      ActionKind = "DEPOSIT"
	ActionHeal         ActionKind = "HEAL"
	ActionPickupBeacon ActionKind = "PICKUP_BEACON"
	ActionDropBeacon   ActionKind = "DROP_BEACON"
	ActionSelfDestruct ActionKind = "SELF_DESTRUCT"
	ActionWait         ActionKind = "WAIT"
)

// AllActionKinds 返回 arena_plan 的动作类型全集（黄金对齐测试逐项断言）。
func AllActionKinds() []ActionKind {
	return []ActionKind{
		ActionMove, ActionSweep, ActionShoot, ActionHarvest, ActionDeposit,
		ActionHeal, ActionPickupBeacon, ActionDropBeacon, ActionSelfDestruct,
		ActionWait,
	}
}

// ValidActionKind 报告动作类型是否在枚举内。
func ValidActionKind(kind ActionKind) bool {
	for _, known := range AllActionKinds() {
		if kind == known {
			return true
		}
	}
	return false
}

// CoreActionKind 是 arena_plan 的 Core 动作类型（arena-plan.schema.json 的
// core.kind enum 子集：SPAWN/HEAL/REPAIR_SHIELD/WAIT）。
type CoreActionKind string

const (
	CoreSpawn        CoreActionKind = "SPAWN"
	CoreHeal         CoreActionKind = "HEAL"
	CoreRepairShield CoreActionKind = "REPAIR_SHIELD"
	CoreWait         CoreActionKind = "WAIT"
)

// AllCoreActionKinds 返回 Core 动作类型全集（黄金对齐测试逐项断言）。
func AllCoreActionKinds() []CoreActionKind {
	return []CoreActionKind{CoreSpawn, CoreHeal, CoreRepairShield, CoreWait}
}

// ValidCoreActionKind 报告 Core 动作类型是否在枚举内。
func ValidCoreActionKind(kind CoreActionKind) bool {
	for _, known := range AllCoreActionKinds() {
		if kind == known {
			return true
		}
	}
	return false
}

// Direction 是移动/横扫方向（hero SDK Direction：UP/DOWN/LEFT/RIGHT）。
type Direction string

const (
	DirectionUp    Direction = "UP"
	DirectionDown  Direction = "DOWN"
	DirectionLeft  Direction = "LEFT"
	DirectionRight Direction = "RIGHT"
)

// AllDirections 返回方向全集（黄金对齐测试逐项断言）。
func AllDirections() []Direction {
	return []Direction{DirectionUp, DirectionDown, DirectionLeft, DirectionRight}
}

// ValidDirection 报告方向是否在枚举内。
func ValidDirection(direction Direction) bool {
	for _, known := range AllDirections() {
		if direction == known {
			return true
		}
	}
	return false
}

// UnitType 是可生产的单位类型（hero SDK UnitType：WORKER/VANGUARD/RANGER）。
type UnitType string

const (
	UnitTypeWorker   UnitType = "WORKER"
	UnitTypeVanguard UnitType = "VANGUARD"
	UnitTypeRanger   UnitType = "RANGER"
)

// AllUnitTypes 返回单位类型全集（黄金对齐测试逐项断言）。
func AllUnitTypes() []UnitType {
	return []UnitType{UnitTypeWorker, UnitTypeVanguard, UnitTypeRanger}
}

// ValidUnitType 报告单位类型是否在枚举内。
func ValidUnitType(unitType UnitType) bool {
	for _, known := range AllUnitTypes() {
		if unitType == known {
			return true
		}
	}
	return false
}

// UnitAction 是 arena_plan 中单个受控单位的动作（arena-plan.schema.json
// actions[]：required unit/kind；direction 仅 MOVE/SWEEP 需要；
// target_id/expected_cell 仅 SHOOT 使用）。
type UnitAction struct {
	Unit         string     `json:"unit"`
	Kind         ActionKind `json:"kind"`
	Direction    *Direction `json:"direction,omitempty"`
	TargetID     *string    `json:"target_id,omitempty"`
	ExpectedCell *Position  `json:"expected_cell,omitempty"`
}

// CoreAction 是 arena_plan 中 Core 的动作（arena-plan.schema.json core；
// SPAWN 需要 unit_type，其余类型不允许）。
type CoreAction struct {
	Kind     CoreActionKind `json:"kind"`
	UnitType *UnitType      `json:"unit_type,omitempty"`
}

// Plan 是 arena_plan 工具协议的完整载荷（LLM 候选计划）：
// actions/core/reason。core 为 null 或缺失表示本 Tick 无 Core 动作。
type Plan struct {
	Actions []UnitAction `json:"actions"`
	Core    *CoreAction  `json:"core,omitempty"`
	Reason  string       `json:"reason,omitempty"`
}

// ValidateUnitAction 校验单个单位动作的值域：
//   - unit/kind 必填（schema required）；
//   - kind 必须在枚举内；
//   - direction 仅 MOVE/SWEEP 需要（schema "MOVE/SWEEP 必需"），
//     其余 kind 不允许携带；
//   - target_id 仅 SHOOT 使用（schema "射击目标 UUID（SHOOT 用）"），
//     可选（缺失 = 对格射击 cell fire）；
//   - expected_cell 仅 SHOOT 使用，且 SHOOT 必需——arena_plan 的 SHOOT
//     最终映射为 wire SHOOT（hero SDK ShootActionSchema 的 expected_cell
//     非空），计划层提前拒绝必然无法提交的 SHOOT。
func ValidateUnitAction(action *UnitAction) error {
	if action == nil {
		return errors.New("unit action is nil")
	}
	if action.Unit == "" {
		return errors.New("unit action requires unit")
	}
	if !ValidActionKind(action.Kind) {
		return fmt.Errorf("invalid action kind %q", action.Kind)
	}
	switch action.Kind {
	case ActionMove, ActionSweep:
		if action.Direction == nil {
			return fmt.Errorf("%s requires direction", action.Kind)
		}
		if !ValidDirection(*action.Direction) {
			return fmt.Errorf("invalid direction %q", *action.Direction)
		}
		if action.TargetID != nil || action.ExpectedCell != nil {
			return fmt.Errorf("%s does not allow target_id/expected_cell", action.Kind)
		}
	case ActionShoot:
		if action.ExpectedCell == nil {
			return errors.New("SHOOT requires expected_cell")
		}
		if action.Direction != nil {
			return errors.New("SHOOT does not allow direction")
		}
	default:
		if action.Direction != nil || action.TargetID != nil || action.ExpectedCell != nil {
			return fmt.Errorf("%s does not allow direction/target_id/expected_cell", action.Kind)
		}
	}
	return nil
}

// ValidateCoreAction 校验 Core 动作的值域：
// kind 必须在枚举内；SPAWN 需要合法的 unit_type，其余类型不允许。
func ValidateCoreAction(action *CoreAction) error {
	if action == nil {
		return errors.New("core action is nil")
	}
	if !ValidCoreActionKind(action.Kind) {
		return fmt.Errorf("invalid core action kind %q", action.Kind)
	}
	if action.Kind == CoreSpawn {
		if action.UnitType == nil {
			return errors.New("SPAWN requires unit_type")
		}
		if !ValidUnitType(*action.UnitType) {
			return fmt.Errorf("invalid unit_type %q", *action.UnitType)
		}
	} else if action.UnitType != nil {
		return fmt.Errorf("%s does not allow unit_type", action.Kind)
	}
	return nil
}

// ValidatePlan 校验 arena_plan 载荷：actions 必填（可为空数组），
// 每个单位至多一个动作（重复 unit 拒绝，见 02-contracts.md §3），
// core/reason 可选。
func ValidatePlan(plan *Plan) error {
	if plan == nil {
		return errors.New("plan is nil")
	}
	if plan.Actions == nil {
		return errors.New("plan requires actions")
	}
	seen := make(map[string]struct{}, len(plan.Actions))
	for i := range plan.Actions {
		action := &plan.Actions[i]
		if err := ValidateUnitAction(action); err != nil {
			return fmt.Errorf("actions[%d]: %w", i, err)
		}
		if _, duplicate := seen[action.Unit]; duplicate {
			return fmt.Errorf("actions[%d]: duplicate unit %q (at most one action per unit)", i, action.Unit)
		}
		seen[action.Unit] = struct{}{}
	}
	if plan.Core != nil {
		if err := ValidateCoreAction(plan.Core); err != nil {
			return fmt.Errorf("core: %w", err)
		}
	}
	return nil
}

// MarshalPlan 序列化 arena_plan 载荷（先校验，非法计划拒绝序列化）。
// 输出为确定性紧凑 JSON：字段顺序与 omitempty 语义稳定，往返字节一致。
func MarshalPlan(plan Plan) ([]byte, error) {
	if err := ValidatePlan(&plan); err != nil {
		return nil, fmt.Errorf("marshal plan: %w", err)
	}
	data, err := json.Marshal(plan)
	if err != nil {
		return nil, fmt.Errorf("marshal plan: %w", err)
	}
	return data, nil
}

// ParsePlan 解析 arena_plan 载荷：严格反序列化（拒绝未知字段——schema
// additionalProperties: false，契约冻结策略要求 Go 结构体与 schema 同步升级）
// + 全量校验。
func ParsePlan(data []byte) (*Plan, error) {
	var plan Plan
	if err := decodeStrict(data, &plan); err != nil {
		return nil, fmt.Errorf("parse plan: %w", err)
	}
	if err := ValidatePlan(&plan); err != nil {
		return nil, fmt.Errorf("invalid plan: %w", err)
	}
	return &plan, nil
}

// QueryBounds 是 arena_map 的可选范围过滤 [x1, y1, x2, y2]
// （world-query.schema.json：minItems/maxItems 均为 4）。
type QueryBounds [4]int

// UnmarshalJSON 实现 encoding/json.Unmarshaler：长度必须恰为 4。
func (b *QueryBounds) UnmarshalJSON(data []byte) error {
	var cells []int
	if err := json.Unmarshal(data, &cells); err != nil {
		return fmt.Errorf("bounds must be an array of 4 integers: %w", err)
	}
	if len(cells) != 4 {
		return fmt.Errorf("bounds must have exactly 4 elements, got %d", len(cells))
	}
	for i, cell := range cells {
		b[i] = cell
	}
	return nil
}

// WorldQuery 是 arena_map 工具协议的请求载荷（world-query.schema.json）：
// query 必填（stats/obstacles/allies），bounds 可选 [x1,y1,x2,y2]。
type WorldQuery struct {
	Query  string       `json:"query"`
	Bounds *QueryBounds `json:"bounds,omitempty"`
}

// ValidateWorldQuery 校验地图查询载荷的值域（query 枚举 + bounds 形状）。
func ValidateWorldQuery(query *WorldQuery) error {
	if query == nil {
		return errors.New("world query is nil")
	}
	switch query.Query {
	case "stats", "obstacles", "allies":
	default:
		return fmt.Errorf("invalid query %q (must be stats/obstacles/allies)", query.Query)
	}
	return nil
}

// MarshalWorldQuery 序列化 arena_map 请求（先校验）。
func MarshalWorldQuery(query WorldQuery) ([]byte, error) {
	if err := ValidateWorldQuery(&query); err != nil {
		return nil, fmt.Errorf("marshal world query: %w", err)
	}
	data, err := json.Marshal(query)
	if err != nil {
		return nil, fmt.Errorf("marshal world query: %w", err)
	}
	return data, nil
}

// ParseWorldQuery 解析 arena_map 请求：严格反序列化（拒绝未知字段）
// + 全量校验。
func ParseWorldQuery(data []byte) (*WorldQuery, error) {
	var query WorldQuery
	if err := decodeStrict(data, &query); err != nil {
		return nil, fmt.Errorf("parse world query: %w", err)
	}
	if err := ValidateWorldQuery(&query); err != nil {
		return nil, fmt.Errorf("invalid world query: %w", err)
	}
	return &query, nil
}

// decodeStrict 反序列化且拒绝未知字段与尾部垃圾数据
// （frozen schema：arena_plan / arena_map）。
func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("trailing data after JSON document")
	}
	return nil
}
