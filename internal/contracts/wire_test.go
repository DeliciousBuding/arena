package contracts

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// TestParseStreamMessageTick 验证 "tick" 信封解析。
func TestParseStreamMessageTick(t *testing.T) {
	message, err := ParseStreamMessage([]byte(`{"type":"tick","data":40437}`))
	if err != nil {
		t.Fatalf("ParseStreamMessage: %v", err)
	}
	tick, ok := message.(*TickMessage)
	if !ok {
		t.Fatalf("message type = %T, want *TickMessage", message)
	}
	if tick.Type != MessageTypeTick || tick.Data != 40437 {
		t.Errorf("tick = %+v, want {tick 40437}", tick)
	}
}

// TestParseStreamMessageState 验证 "state" 信封：载荷即真实 fixture record
// （fixture 与服务器 state 同构，见 02-contracts.md §3）。
func TestParseStreamMessageState(t *testing.T) {
	record, err := os.ReadFile(fixturePath("40437.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	envelope, err := json.Marshal(map[string]any{"type": MessageTypeState, "data": json.RawMessage(record)})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	message, err := ParseStreamMessage(envelope)
	if err != nil {
		t.Fatalf("ParseStreamMessage: %v", err)
	}
	state, ok := message.(*StateMessage)
	if !ok {
		t.Fatalf("message type = %T, want *StateMessage", message)
	}
	if state.Data.Population != 3 || len(state.Data.Objects) != 5 {
		t.Errorf("state = population %d objects %d", state.Data.Population, len(state.Data.Objects))
	}
}

// TestParseStreamMessageReceived 验证 "received" 信封：回执 + 完整计划，
// plan.tick 必须与回执 tick 一致（hero SDK checkReceivedConsistency）。
func TestParseStreamMessageReceived(t *testing.T) {
	message, err := ParseStreamMessage([]byte(`{"type":"received","data":{` +
		`"tick":40437,"source":"AGENT","received_at":"2026-08-02T13:35:04Z",` +
		`"plan":{"tick":40437,"unit_actions":{"u1":{"type":"MOVE","direction":"UP"}},` +
		`"core_action":{"type":"SPAWN","unit_type":"WORKER"}}}}`))
	if err != nil {
		t.Fatalf("ParseStreamMessage: %v", err)
	}
	received, ok := message.(*ReceivedMessage)
	if !ok {
		t.Fatalf("message type = %T, want *ReceivedMessage", message)
	}
	if received.Data.Source != CommandSourceAgent {
		t.Errorf("source = %q, want AGENT", received.Data.Source)
	}
	if len(received.Data.Plan.UnitActions) != 1 {
		t.Errorf("unit_actions = %v", received.Data.Plan.UnitActions)
	}
	if received.Data.Plan.CoreAction == nil ||
		received.Data.Plan.CoreAction.Type != string(WireCoreSpawn) {
		t.Errorf("core_action = %+v", received.Data.Plan.CoreAction)
	}
}

// TestParseStreamMessageErrors 覆盖 WS 消息非法样例。
func TestParseStreamMessageErrors(t *testing.T) {
	cases := []struct {
		name string
		json string
	}{
		{name: "malformed json", json: `not-json`},
		{name: "unknown type", json: `{"type":"chime","data":1}`},
		{name: "missing type", json: `{"data":1}`},
		{name: "tick data not integer", json: `{"type":"tick","data":"40437"}`},
		{name: "tick data zero", json: `{"type":"tick","data":0}`},
		{name: "state payload empty", json: `{"type":"state","data":{}}`},
		{name: "state payload invalid status", json: `{"type":"state","data":{"status":"X","resources":0,"population":0,"population_tier":0,"upkeep_next_tick":0,"champion_beacon":{"position":[0,0],"status":null,"carrier_id":null},"objects":[],"events":[]}}`},
		{name: "received source invalid", json: `{"type":"received","data":{"tick":1,"source":"BOT","received_at":"t","plan":{"tick":1,"unit_actions":{}}}}`},
		{name: "received plan tick mismatch", json: `{"type":"received","data":{"tick":1,"source":"AGENT","received_at":"t","plan":{"tick":2,"unit_actions":{}}}}`},
		{name: "received plan invalid action", json: `{"type":"received","data":{"tick":1,"source":"AGENT","received_at":"t","plan":{"tick":1,"unit_actions":{"u1":{"type":"MOVE"}}}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseStreamMessage([]byte(tc.json)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

// TestCommandPlanRoundTrip 验证提交计划黄金往返（Marshal → Parse → Marshal
// 字节相同；map 键与字段顺序确定）。
func TestCommandPlanRoundTrip(t *testing.T) {
	up := DirectionUp
	plan := CommandPlan{
		Tick: 40437,
		UnitActions: map[string]WireAction{
			"u1": {Type: string(WireUnitMove), Direction: &up},
			"u2": {Type: string(WireUnitShoot), ExpectedCell: &Position{3, 4}},
			"u3": {Type: string(WireUnitWait)},
		},
		CoreAction: &WireAction{Type: string(WireCoreSpawn), UnitType: ptrUnitType(UnitTypeWorker)},
	}
	first, err := MarshalCommandPlan(plan)
	if err != nil {
		t.Fatalf("MarshalCommandPlan: %v", err)
	}
	parsed, err := ParseCommandPlan(first)
	if err != nil {
		t.Fatalf("ParseCommandPlan: %v", err)
	}
	second, err := MarshalCommandPlan(*parsed)
	if err != nil {
		t.Fatalf("MarshalCommandPlan after parse: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Errorf("round trip bytes differ:\nfirst:  %s\nsecond: %s", first, second)
	}
}

func ptrUnitType(t UnitType) *UnitType { return &t }

// TestMarshalCommandPlanOmitsNullCoreAction 验证 nil core_action 被省略
// （与 SDK encodePlan 的 exclude_none 语义一致）。
func TestMarshalCommandPlanOmitsNullCoreAction(t *testing.T) {
	plan := CommandPlan{Tick: 40437, UnitActions: map[string]WireAction{}}
	data, err := MarshalCommandPlan(plan)
	if err != nil {
		t.Fatalf("MarshalCommandPlan: %v", err)
	}
	if strings.Contains(string(data), "core_action") {
		t.Errorf("marshal = %s, must not contain core_action", data)
	}
}

// TestParseCommandPlanNullCoreAction 验证显式 null core_action 解析为 nil。
func TestParseCommandPlanNullCoreAction(t *testing.T) {
	plan, err := ParseCommandPlan([]byte(`{"tick":1,"unit_actions":{},"core_action":null}`))
	if err != nil {
		t.Fatalf("ParseCommandPlan: %v", err)
	}
	if plan.CoreAction != nil {
		t.Errorf("core_action = %+v, want nil", plan.CoreAction)
	}
}

// TestValidateCommandPlanInvalid 覆盖提交计划非法样例。
func TestValidateCommandPlanInvalid(t *testing.T) {
	cases := []struct {
		name string
		json string
	}{
		{name: "tick zero", json: `{"tick":0,"unit_actions":{}}`},
		{name: "missing unit_actions", json: `{"tick":1}`},
		{name: "unknown unit action type", json: `{"tick":1,"unit_actions":{"u1":{"type":"JUMP"}}}`},
		{name: "move without direction", json: `{"tick":1,"unit_actions":{"u1":{"type":"MOVE"}}}`},
		{name: "shoot without expected_cell", json: `{"tick":1,"unit_actions":{"u1":{"type":"SHOOT"}}}`},
		{name: "harvest with unit_type", json: `{"tick":1,"unit_actions":{"u1":{"type":"HARVEST","unit_type":"WORKER"}}}`},
		{name: "core unknown type", json: `{"tick":1,"unit_actions":{},"core_action":{"type":"JUMP"}}`},
		{name: "core spawn without unit_type", json: `{"tick":1,"unit_actions":{},"core_action":{"type":"SPAWN"}}`},
		{name: "core start_move without direction", json: `{"tick":1,"unit_actions":{},"core_action":{"type":"START_MOVE"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseCommandPlan([]byte(tc.json)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

// TestValidateWireUnitActionInvalid 逐项覆盖 wire 单位动作非法变体
// （hero SDK UnitActionSchema：类型判别 + 字段约束）。
func TestValidateWireUnitActionInvalid(t *testing.T) {
	up := DirectionUp
	cell := Position{1, 2}
	target := "e1"
	worker := UnitTypeWorker
	cases := []struct {
		name   string
		action WireAction
	}{
		{name: "unknown type", action: WireAction{Type: "JUMP"}},
		{name: "wait with direction", action: WireAction{Type: string(WireUnitWait), Direction: &up}},
		{name: "wait with unit_type", action: WireAction{Type: string(WireUnitWait), UnitType: &worker}},
		{name: "move without direction", action: WireAction{Type: string(WireUnitMove)}},
		{name: "move bad direction", action: WireAction{Type: string(WireUnitMove), Direction: ptrDirection("NORTH")}},
		{name: "move with target", action: WireAction{Type: string(WireUnitMove), Direction: &up, TargetID: &target}},
		{name: "move with expected_cell", action: WireAction{Type: string(WireUnitMove), Direction: &up, ExpectedCell: &cell}},
		{name: "sweep without direction", action: WireAction{Type: string(WireUnitSweep)}},
		{name: "sweep with unit_type", action: WireAction{Type: string(WireUnitSweep), Direction: &up, UnitType: &worker}},
		{name: "shoot without expected_cell", action: WireAction{Type: string(WireUnitShoot), TargetID: &target}},
		{name: "shoot with direction", action: WireAction{Type: string(WireUnitShoot), Direction: &up, ExpectedCell: &cell}},
		{name: "shoot with unit_type", action: WireAction{Type: string(WireUnitShoot), ExpectedCell: &cell, UnitType: &worker}},
		{name: "harvest with target", action: WireAction{Type: string(WireUnitHarvest), TargetID: &target}},
		{name: "deposit with expected_cell", action: WireAction{Type: string(WireUnitDeposit), ExpectedCell: &cell}},
		{name: "heal with direction", action: WireAction{Type: string(WireUnitHeal), Direction: &up}},
		{name: "pickup beacon with unit_type", action: WireAction{Type: string(WireUnitPickupBeacon), UnitType: &worker}},
		{name: "drop beacon with target", action: WireAction{Type: string(WireUnitDropBeacon), TargetID: &target}},
		{name: "self destruct with expected_cell", action: WireAction{Type: string(WireUnitSelfDestruct), ExpectedCell: &cell}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateWireUnitAction(&tc.action); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func ptrDirection(d Direction) *Direction { return &d }

// TestValidateWireCoreActionInvalid 逐项覆盖 wire Core 动作非法变体
// （hero SDK CoreActionSchema）。
func TestValidateWireCoreActionInvalid(t *testing.T) {
	up := DirectionUp
	worker := UnitTypeWorker
	cases := []struct {
		name   string
		action WireAction
	}{
		{name: "unknown type", action: WireAction{Type: "JUMP"}},
		{name: "spawn without unit_type", action: WireAction{Type: string(WireCoreSpawn)}},
		{name: "spawn bad unit_type", action: WireAction{Type: string(WireCoreSpawn), UnitType: ptrUnitType("TANK")}},
		{name: "spawn with direction", action: WireAction{Type: string(WireCoreSpawn), UnitType: &worker, Direction: &up}},
		{name: "spawn with target", action: WireAction{Type: string(WireCoreSpawn), UnitType: &worker, TargetID: ptrString("e1")}},
		{name: "start_move without direction", action: WireAction{Type: string(WireCoreStartMove)}},
		{name: "start_move bad direction", action: WireAction{Type: string(WireCoreStartMove), Direction: ptrDirection("NORTH")}},
		{name: "start_move with unit_type", action: WireAction{Type: string(WireCoreStartMove), Direction: &up, UnitType: &worker}},
		{name: "wait with unit_type", action: WireAction{Type: string(WireCoreWait), UnitType: &worker}},
		{name: "repair_shield with direction", action: WireAction{Type: string(WireCoreRepairShield), Direction: &up}},
		{name: "cancel_move with target", action: WireAction{Type: string(WireCoreCancelMove), TargetID: ptrString("e1")}},
		{name: "heal with expected_cell", action: WireAction{Type: string(WireCoreHeal), ExpectedCell: &Position{1, 2}}},
		{name: "self destruct with unit_type", action: WireAction{Type: string(WireCoreSelfDestruct), UnitType: &worker}},
		{name: "pickup beacon with direction", action: WireAction{Type: string(WireCorePickupBeacon), Direction: &up}},
		{name: "drop beacon with unit_type", action: WireAction{Type: string(WireCoreDropBeacon), UnitType: &worker}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateWireCoreAction(&tc.action); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func ptrString(s string) *string { return &s }

// TestWireUnitActionsAllValid 验证 wire 单位动作全集每个类型的合法形态。
func TestWireUnitActionsAllValid(t *testing.T) {
	up := DirectionUp
	valid := map[string]WireAction{
		string(WireUnitWait):         {Type: string(WireUnitWait)},
		string(WireUnitMove):         {Type: string(WireUnitMove), Direction: &up},
		string(WireUnitHarvest):      {Type: string(WireUnitHarvest)},
		string(WireUnitDeposit):      {Type: string(WireUnitDeposit)},
		string(WireUnitSweep):        {Type: string(WireUnitSweep), Direction: &up},
		string(WireUnitShoot):        {Type: string(WireUnitShoot), ExpectedCell: &Position{1, 2}},
		string(WireUnitPickupBeacon): {Type: string(WireUnitPickupBeacon)},
		string(WireUnitDropBeacon):   {Type: string(WireUnitDropBeacon)},
		string(WireUnitSelfDestruct): {Type: string(WireUnitSelfDestruct)},
		string(WireUnitHeal):         {Type: string(WireUnitHeal)},
	}
	if len(valid) != len(AllWireUnitActionTypes()) {
		t.Fatalf("valid fixture count %d != enum count %d", len(valid), len(AllWireUnitActionTypes()))
	}
	for _, enumType := range AllWireUnitActionTypes() {
		action, ok := valid[string(enumType)]
		if !ok {
			t.Errorf("missing valid fixture for %s", enumType)
			continue
		}
		if err := ValidateWireUnitAction(&action); err != nil {
			t.Errorf("ValidateWireUnitAction(%s): %v", enumType, err)
		}
	}
}

// TestWireCoreActionsAllValid 验证 wire Core 动作全集每个类型的合法形态。
func TestWireCoreActionsAllValid(t *testing.T) {
	up := DirectionUp
	worker := UnitTypeWorker
	valid := map[string]WireAction{
		string(WireCoreWait):         {Type: string(WireCoreWait)},
		string(WireCoreSpawn):        {Type: string(WireCoreSpawn), UnitType: &worker},
		string(WireCoreRepairShield): {Type: string(WireCoreRepairShield)},
		string(WireCoreStartMove):    {Type: string(WireCoreStartMove), Direction: &up},
		string(WireCoreCancelMove):   {Type: string(WireCoreCancelMove)},
		string(WireCorePickupBeacon): {Type: string(WireCorePickupBeacon)},
		string(WireCoreDropBeacon):   {Type: string(WireCoreDropBeacon)},
		string(WireCoreHeal):         {Type: string(WireCoreHeal)},
		string(WireCoreSelfDestruct): {Type: string(WireCoreSelfDestruct)},
	}
	if len(valid) != len(AllWireCoreActionTypes()) {
		t.Fatalf("valid fixture count %d != enum count %d", len(valid), len(AllWireCoreActionTypes()))
	}
	for _, enumType := range AllWireCoreActionTypes() {
		action, ok := valid[string(enumType)]
		if !ok {
			t.Errorf("missing valid fixture for %s", enumType)
			continue
		}
		if err := ValidateWireCoreAction(&action); err != nil {
			t.Errorf("ValidateWireCoreAction(%s): %v", enumType, err)
		}
	}
}

// TestWireEnumCompleteness 枚举全集断言：wire 单位 10 类 / Core 9 类
// （hero SDK UnitActionSchema / CoreActionSchema 判别并集）。
func TestWireEnumCompleteness(t *testing.T) {
	wantUnit := []WireUnitActionType{
		WireUnitWait, WireUnitMove, WireUnitHarvest, WireUnitDeposit,
		WireUnitSweep, WireUnitShoot, WireUnitPickupBeacon, WireUnitDropBeacon,
		WireUnitSelfDestruct, WireUnitHeal,
	}
	gotUnit := AllWireUnitActionTypes()
	if len(gotUnit) != len(wantUnit) {
		t.Fatalf("AllWireUnitActionTypes() = %v, want %v", gotUnit, wantUnit)
	}
	for i := range wantUnit {
		if gotUnit[i] != wantUnit[i] {
			t.Fatalf("AllWireUnitActionTypes() = %v, want %v", gotUnit, wantUnit)
		}
	}

	wantCore := []WireCoreActionType{
		WireCoreWait, WireCoreSpawn, WireCoreRepairShield, WireCoreStartMove,
		WireCoreCancelMove, WireCorePickupBeacon, WireCoreDropBeacon,
		WireCoreHeal, WireCoreSelfDestruct,
	}
	gotCore := AllWireCoreActionTypes()
	if len(gotCore) != len(wantCore) {
		t.Fatalf("AllWireCoreActionTypes() = %v, want %v", gotCore, wantCore)
	}
	for i := range wantCore {
		if gotCore[i] != wantCore[i] {
			t.Fatalf("AllWireCoreActionTypes() = %v, want %v", gotCore, wantCore)
		}
	}
}

// TestParseAcceptedValid 验证 HTTP 202 回执解析。
func TestParseAcceptedValid(t *testing.T) {
	accepted, err := ParseAccepted([]byte(`{"accepted":true,"tick":40500,"source":"AGENT","received_at":"2026-08-02T13:35:04Z"}`))
	if err != nil {
		t.Fatalf("ParseAccepted: %v", err)
	}
	if !accepted.Accepted || accepted.Tick != 40500 || accepted.Source != CommandSourceAgent {
		t.Errorf("accepted = %+v", accepted)
	}
	if !ValidCommandSource(CommandSourceAgent) || !ValidCommandSource(CommandSourceManual) {
		t.Error("ValidCommandSource must accept AGENT/MANUAL")
	}
	if ValidCommandSource("BOT") {
		t.Error("ValidCommandSource must reject unknown source")
	}
}

// TestParseAcceptedInvalid 覆盖回执非法样例。
func TestParseAcceptedInvalid(t *testing.T) {
	cases := []struct {
		name string
		json string
	}{
		{name: "malformed json", json: `{`},
		{name: "accepted false", json: `{"accepted":false,"tick":1,"source":"AGENT","received_at":"t"}`},
		{name: "tick zero", json: `{"accepted":true,"tick":0,"source":"AGENT","received_at":"t"}`},
		{name: "unknown source", json: `{"accepted":true,"tick":1,"source":"BOT","received_at":"t"}`},
		{name: "missing received_at", json: `{"accepted":true,"tick":1,"source":"AGENT"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseAccepted([]byte(tc.json)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

// TestWireValidateNil 覆盖 wire 层 nil 入参。
func TestWireValidateNil(t *testing.T) {
	if err := ValidateWireUnitAction(nil); err == nil {
		t.Error("ValidateWireUnitAction(nil) must fail")
	}
	if err := ValidateWireCoreAction(nil); err == nil {
		t.Error("ValidateWireCoreAction(nil) must fail")
	}
	if err := ValidateCommandPlan(nil); err == nil {
		t.Error("ValidateCommandPlan(nil) must fail")
	}
	if err := ValidateAccepted(nil); err == nil {
		t.Error("ValidateAccepted(nil) must fail")
	}
	if err := ValidateReceived(nil); err == nil {
		t.Error("ValidateReceived(nil) must fail")
	}
}
