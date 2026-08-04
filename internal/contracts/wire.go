package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
)

// 服务器 WS 流消息类型（hero SDK StreamEnvelopeSchema 的 type 判别值）。
const (
	MessageTypeTick     = "tick"
	MessageTypeState    = "state"
	MessageTypeReceived = "received"
)

// Envelope 是服务器 WS 文本消息的原始信封：type 判别 + data 原始字节。
// 领域层经 ParseStreamMessage 消费；本结构供需要原始载荷的场景使用。
type Envelope struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// TickMessage 是 "tick" 信封：新逻辑 Tick 开始通知（hero SDK Tick）。
type TickMessage struct {
	Type string `json:"type"`
	Data int    `json:"data"`
}

// StateMessage 是 "state" 信封：完整玩家状态替换（hero SDK PlayerState）。
type StateMessage struct {
	Type string      `json:"type"`
	Data PlayerState `json:"data"`
}

// ReceivedMessage 是 "received" 信封：服务器对已提交计划的回执
// （hero SDK Received：tick/source/received_at/plan）。
type ReceivedMessage struct {
	Type string   `json:"type"`
	Data Received `json:"data"`
}

// PlayerState 是服务器 state 信封的载荷（完整权威玩家状态）。
// 与差分 fixture record（DifferentialRecord）字节布局完全一致——fixture
// 正是从服务器 state 消息抓取的原始快照（02-contracts.md §3），
// 因此定义为类型别名，杜绝两处字段漂移。
type PlayerState = DifferentialRecord

// CommandSource 是计划来源槽位（hero SDK CommandSource：AGENT/MANUAL）。
type CommandSource string

const (
	CommandSourceAgent  CommandSource = "AGENT"
	CommandSourceManual CommandSource = "MANUAL"
)

// ValidCommandSource 报告来源是否在枚举内。
func ValidCommandSource(source CommandSource) bool {
	return source == CommandSourceAgent || source == CommandSourceManual
}

// WireUnitActionType 是 wire 单位动作类型（hero SDK UnitActionSchema 判别）。
type WireUnitActionType string

const (
	WireUnitWait         WireUnitActionType = "WAIT"
	WireUnitMove         WireUnitActionType = "MOVE"
	WireUnitHarvest      WireUnitActionType = "HARVEST"
	WireUnitDeposit      WireUnitActionType = "DEPOSIT"
	WireUnitSweep        WireUnitActionType = "SWEEP"
	WireUnitShoot        WireUnitActionType = "SHOOT"
	WireUnitPickupBeacon WireUnitActionType = "PICKUP_BEACON"
	WireUnitDropBeacon   WireUnitActionType = "DROP_BEACON"
	WireUnitSelfDestruct WireUnitActionType = "SELF_DESTRUCT"
	WireUnitHeal         WireUnitActionType = "HEAL"
)

// AllWireUnitActionTypes 返回 wire 单位动作类型全集（黄金对齐测试逐项断言）。
func AllWireUnitActionTypes() []WireUnitActionType {
	return []WireUnitActionType{
		WireUnitWait, WireUnitMove, WireUnitHarvest, WireUnitDeposit,
		WireUnitSweep, WireUnitShoot, WireUnitPickupBeacon, WireUnitDropBeacon,
		WireUnitSelfDestruct, WireUnitHeal,
	}
}

// WireCoreActionType 是 wire Core 动作类型（hero SDK CoreActionSchema 判别，
// 比 arena_plan 的 CoreActionKind 多 START_MOVE/CANCEL_MOVE）。
type WireCoreActionType string

const (
	WireCoreWait         WireCoreActionType = "WAIT"
	WireCoreSpawn        WireCoreActionType = "SPAWN"
	WireCoreRepairShield WireCoreActionType = "REPAIR_SHIELD"
	WireCoreStartMove    WireCoreActionType = "START_MOVE"
	WireCoreCancelMove   WireCoreActionType = "CANCEL_MOVE"
	WireCorePickupBeacon WireCoreActionType = "PICKUP_BEACON"
	WireCoreDropBeacon   WireCoreActionType = "DROP_BEACON"
	WireCoreHeal         WireCoreActionType = "HEAL"
	WireCoreSelfDestruct WireCoreActionType = "SELF_DESTRUCT"
)

// AllWireCoreActionTypes 返回 wire Core 动作类型全集（黄金对齐测试逐项断言）。
func AllWireCoreActionTypes() []WireCoreActionType {
	return []WireCoreActionType{
		WireCoreWait, WireCoreSpawn, WireCoreRepairShield, WireCoreStartMove,
		WireCoreCancelMove, WireCorePickupBeacon, WireCoreDropBeacon,
		WireCoreHeal, WireCoreSelfDestruct,
	}
}

// WireAction 是 wire 层的一个动作（hero SDK UnitAction/CoreAction 共用
// 判别 "type" 字段；单位与 Core 的合法类型集合不同，分别用
// ValidateWireUnitAction / ValidateWireCoreAction 校验）。
// Type 保持普通字符串以同时容纳两套类型集合，合法性由校验函数判定。
type WireAction struct {
	Type         string     `json:"type"`
	Direction    *Direction `json:"direction,omitempty"`
	TargetID     *string    `json:"target_id,omitempty"`
	ExpectedCell *Position  `json:"expected_cell,omitempty"`
	UnitType     *UnitType  `json:"unit_type,omitempty"`
}

// ValidateWireUnitAction 校验 wire 单位动作（hero SDK UnitActionSchema）：
// 类型必须在单位集合内；MOVE/SWEEP 需要 direction；SHOOT 需要
// expected_cell（target_id 可选，缺失 = cell fire）；其余类型不允许
// 携带任何附加字段。
func ValidateWireUnitAction(action *WireAction) error {
	if action == nil {
		return errors.New("unit action is nil")
	}
	rejectExtras := func() error {
		if action.Direction != nil || action.TargetID != nil ||
			action.ExpectedCell != nil || action.UnitType != nil {
			return fmt.Errorf("wire unit action %s does not allow direction/target_id/expected_cell/unit_type", action.Type)
		}
		return nil
	}
	switch WireUnitActionType(action.Type) {
	case WireUnitWait, WireUnitHarvest, WireUnitDeposit, WireUnitPickupBeacon,
		WireUnitDropBeacon, WireUnitSelfDestruct, WireUnitHeal:
		return rejectExtras()
	case WireUnitMove, WireUnitSweep:
		if action.Direction == nil {
			return fmt.Errorf("wire unit action %s requires direction", action.Type)
		}
		if !ValidDirection(*action.Direction) {
			return fmt.Errorf("invalid direction %q", *action.Direction)
		}
		if action.TargetID != nil || action.ExpectedCell != nil || action.UnitType != nil {
			return fmt.Errorf("wire unit action %s does not allow target_id/expected_cell/unit_type", action.Type)
		}
	case WireUnitShoot:
		if action.ExpectedCell == nil {
			return errors.New("wire unit action SHOOT requires expected_cell")
		}
		if action.Direction != nil || action.UnitType != nil {
			return errors.New("wire unit action SHOOT does not allow direction/unit_type")
		}
	default:
		return fmt.Errorf("unknown wire unit action type %q", action.Type)
	}
	return nil
}

// ValidateWireCoreAction 校验 wire Core 动作（hero SDK CoreActionSchema）：
// 类型必须在 Core 集合内；SPAWN 需要 unit_type；START_MOVE 需要
// direction；其余类型不允许携带任何附加字段。
func ValidateWireCoreAction(action *WireAction) error {
	if action == nil {
		return errors.New("core action is nil")
	}
	rejectExtras := func() error {
		if action.Direction != nil || action.TargetID != nil ||
			action.ExpectedCell != nil || action.UnitType != nil {
			return fmt.Errorf("wire core action %s does not allow direction/target_id/expected_cell/unit_type", action.Type)
		}
		return nil
	}
	switch WireCoreActionType(action.Type) {
	case WireCoreWait, WireCoreRepairShield, WireCoreCancelMove, WireCorePickupBeacon,
		WireCoreDropBeacon, WireCoreHeal, WireCoreSelfDestruct:
		return rejectExtras()
	case WireCoreSpawn:
		if action.UnitType == nil {
			return errors.New("wire core action SPAWN requires unit_type")
		}
		if !ValidUnitType(*action.UnitType) {
			return fmt.Errorf("invalid unit_type %q", *action.UnitType)
		}
		if action.Direction != nil || action.TargetID != nil || action.ExpectedCell != nil {
			return errors.New("wire core action SPAWN does not allow direction/target_id/expected_cell")
		}
	case WireCoreStartMove:
		if action.Direction == nil {
			return errors.New("wire core action START_MOVE requires direction")
		}
		if !ValidDirection(*action.Direction) {
			return fmt.Errorf("invalid direction %q", *action.Direction)
		}
		if action.TargetID != nil || action.ExpectedCell != nil || action.UnitType != nil {
			return errors.New("wire core action START_MOVE does not allow target_id/expected_cell/unit_type")
		}
	default:
		return fmt.Errorf("unknown wire core action type %q", action.Type)
	}
	return nil
}

// CommandPlan 是完整提交计划（hero SDK CommandPlan）——HTTP POST
// /api/v1/game/commands 的请求体与 received 回执中的 plan 结构：
// tick + 按单位 id 键控的 unit_actions + 可空 core_action。
// 序列化语义与 SDK encodePlan（exclude_none）对齐：nil core_action 省略。
type CommandPlan struct {
	Tick        int                   `json:"tick"`
	UnitActions map[string]WireAction `json:"unit_actions"`
	CoreAction  *WireAction           `json:"core_action,omitempty"`
}

// ValidateCommandPlan 校验提交计划（hero SDK CommandPlanSchema）：
// tick >= 1、unit_actions 必填（可为空对象）、每个动作按单位/ Core
// 各自的类型集合校验。
func ValidateCommandPlan(plan *CommandPlan) error {
	if plan == nil {
		return errors.New("command plan is nil")
	}
	if plan.Tick < 1 {
		return fmt.Errorf("plan tick must be >= 1, got %d", plan.Tick)
	}
	if plan.UnitActions == nil {
		return errors.New("plan requires unit_actions")
	}
	for id, action := range plan.UnitActions {
		if err := ValidateWireUnitAction(&action); err != nil {
			return fmt.Errorf("unit action %s: %w", id, err)
		}
	}
	if plan.CoreAction != nil {
		if err := ValidateWireCoreAction(plan.CoreAction); err != nil {
			return fmt.Errorf("core action: %w", err)
		}
	}
	return nil
}

// MarshalCommandPlan 序列化提交计划（先校验）。输出为确定性紧凑 JSON：
// 字段顺序（tick/unit_actions/core_action）与 map 键排序稳定，往返字节一致。
// 注：与 TS 版 encodePlan 的 sort_keys 输出（字母序）字段顺序不同，
// 服务器按语义解析 JSON，顺序不影响兼容；如后续需要逐字节对齐，
// 在 hero 客户端（M2）层实现 canonical 编码。
func MarshalCommandPlan(plan CommandPlan) ([]byte, error) {
	if err := ValidateCommandPlan(&plan); err != nil {
		return nil, fmt.Errorf("marshal command plan: %w", err)
	}
	data, err := json.Marshal(plan)
	if err != nil {
		return nil, fmt.Errorf("marshal command plan: %w", err)
	}
	return data, nil
}

// ParseCommandPlan 解析提交计划：反序列化 + 全量校验。
func ParseCommandPlan(data []byte) (*CommandPlan, error) {
	var plan CommandPlan
	if err := json.Unmarshal(data, &plan); err != nil {
		return nil, fmt.Errorf("parse command plan: %w", err)
	}
	if err := ValidateCommandPlan(&plan); err != nil {
		return nil, fmt.Errorf("invalid command plan: %w", err)
	}
	return &plan, nil
}

// Accepted 是提交命令的 HTTP 202 回执（hero SDK Accepted：
// accepted 恒为 true、tick >= 1、source 枚举、received_at 时间戳）。
type Accepted struct {
	Accepted   bool          `json:"accepted"`
	Tick       int           `json:"tick"`
	Source     CommandSource `json:"source"`
	ReceivedAt string        `json:"received_at"`
}

// ValidateAccepted 校验提交回执（hero SDK AcceptedSchema）。
func ValidateAccepted(accepted *Accepted) error {
	if accepted == nil {
		return errors.New("accepted is nil")
	}
	if !accepted.Accepted {
		return errors.New("accepted must be true")
	}
	if accepted.Tick < 1 {
		return fmt.Errorf("accepted tick must be >= 1, got %d", accepted.Tick)
	}
	if !ValidCommandSource(accepted.Source) {
		return fmt.Errorf("invalid command source %q", accepted.Source)
	}
	if accepted.ReceivedAt == "" {
		return errors.New("accepted requires received_at")
	}
	return nil
}

// ParseAccepted 解析提交回执（HTTP 202 响应体）：反序列化 + 全量校验。
func ParseAccepted(data []byte) (*Accepted, error) {
	var accepted Accepted
	if err := json.Unmarshal(data, &accepted); err != nil {
		return nil, fmt.Errorf("parse accepted: %w", err)
	}
	if err := ValidateAccepted(&accepted); err != nil {
		return nil, fmt.Errorf("invalid accepted: %w", err)
	}
	return &accepted, nil
}

// Received 是 "received" 信封的载荷：服务器已持久化的完整计划回执
// （hero SDK Received）。plan.tick 必须与回执 tick 一致
// （hero SDK checkReceivedConsistency）。
type Received struct {
	Tick       int           `json:"tick"`
	Source     CommandSource `json:"source"`
	ReceivedAt string        `json:"received_at"`
	Plan       CommandPlan   `json:"plan"`
}

// ValidateReceived 校验回执（hero SDK ReceivedSchema +
// checkReceivedConsistency）。
func ValidateReceived(received *Received) error {
	if received == nil {
		return errors.New("received is nil")
	}
	if received.Tick < 1 {
		return fmt.Errorf("received tick must be >= 1, got %d", received.Tick)
	}
	if !ValidCommandSource(received.Source) {
		return fmt.Errorf("invalid command source %q", received.Source)
	}
	if received.ReceivedAt == "" {
		return errors.New("received requires received_at")
	}
	if err := ValidateCommandPlan(&received.Plan); err != nil {
		return fmt.Errorf("received plan: %w", err)
	}
	if received.Plan.Tick != received.Tick {
		return fmt.Errorf("received plan tick %d does not match receipt tick %d", received.Plan.Tick, received.Tick)
	}
	return nil
}

// ParseStreamMessage 解析服务器 WS 文本消息（hero SDK parseStreamMessage
// 的 Go 对位）：按 type 判别返回 *TickMessage / *StateMessage /
// *ReceivedMessage；type 未知、载荷类型错误或校验失败一律拒绝。
func ParseStreamMessage(data []byte) (any, error) {
	var envelope Envelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("parse stream message: %w", err)
	}
	switch envelope.Type {
	case MessageTypeTick:
		var tick int
		if err := json.Unmarshal(envelope.Data, &tick); err != nil {
			return nil, fmt.Errorf("tick message data must be an integer: %w", err)
		}
		if tick < 1 {
			return nil, fmt.Errorf("tick message tick must be >= 1, got %d", tick)
		}
		return &TickMessage{Type: envelope.Type, Data: tick}, nil
	case MessageTypeState:
		var state PlayerState
		if err := json.Unmarshal(envelope.Data, &state); err != nil {
			return nil, fmt.Errorf("state message: %w", err)
		}
		if err := ValidateDifferentialRecord(&state); err != nil {
			return nil, fmt.Errorf("state message: %w", err)
		}
		return &StateMessage{Type: envelope.Type, Data: state}, nil
	case MessageTypeReceived:
		var received Received
		if err := json.Unmarshal(envelope.Data, &received); err != nil {
			return nil, fmt.Errorf("received message: %w", err)
		}
		if err := ValidateReceived(&received); err != nil {
			return nil, fmt.Errorf("received message: %w", err)
		}
		return &ReceivedMessage{Type: envelope.Type, Data: received}, nil
	default:
		return nil, fmt.Errorf("unknown stream message type %q", envelope.Type)
	}
}
