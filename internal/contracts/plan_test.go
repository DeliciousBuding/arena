package contracts

import (
	"bytes"
	"strings"
	"testing"
)

// TestPlanGoldenRoundTrip 黄金往返：arena_plan 全动作类型合法样例
// Marshal → Parse → Marshal 字节相同（02-contracts.md 契约冻结策略）。
func TestPlanGoldenRoundTrip(t *testing.T) {
	up := DirectionUp
	down := DirectionDown
	left := DirectionLeft
	right := DirectionRight
	target := "enemy-1"
	worker := UnitTypeWorker
	plan := Plan{
		Actions: []UnitAction{
			{Unit: "u1", Kind: ActionMove, Direction: &up},
			{Unit: "u2", Kind: ActionSweep, Direction: &down},
			{Unit: "u3", Kind: ActionShoot, TargetID: &target, ExpectedCell: &Position{3, 4}},
			{Unit: "u4", Kind: ActionShoot, ExpectedCell: &Position{5, 6}},
			{Unit: "u5", Kind: ActionHarvest},
			{Unit: "u6", Kind: ActionDeposit},
			{Unit: "u7", Kind: ActionHeal},
			{Unit: "u8", Kind: ActionPickupBeacon},
			{Unit: "u9", Kind: ActionDropBeacon},
			{Unit: "u10", Kind: ActionSelfDestruct},
			{Unit: "u11", Kind: ActionWait},
			{Unit: "u12", Kind: ActionMove, Direction: &left},
			{Unit: "u13", Kind: ActionSweep, Direction: &right},
		},
		Core:   &CoreAction{Kind: CoreSpawn, UnitType: &worker},
		Reason: "expand economy",
	}
	first, err := MarshalPlan(plan)
	if err != nil {
		t.Fatalf("MarshalPlan: %v", err)
	}
	parsed, err := ParsePlan(first)
	if err != nil {
		t.Fatalf("ParsePlan: %v", err)
	}
	second, err := MarshalPlan(*parsed)
	if err != nil {
		t.Fatalf("MarshalPlan after parse: %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Errorf("round trip bytes differ:\nfirst:  %s\nsecond: %s", first, second)
	}
}

// TestMarshalPlanCanonicalBytes 固定 arena_plan 的规范化输出字节
// （字段顺序 = 结构体顺序，omitempty 语义与 schema 一致）。
func TestMarshalPlanCanonicalBytes(t *testing.T) {
	up := DirectionUp
	plan := Plan{
		Actions: []UnitAction{
			{Unit: "u1", Kind: ActionMove, Direction: &up},
			{Unit: "u2", Kind: ActionWait},
		},
		Core:   &CoreAction{Kind: CoreWait},
		Reason: "r",
	}
	data, err := MarshalPlan(plan)
	if err != nil {
		t.Fatalf("MarshalPlan: %v", err)
	}
	want := `{"actions":[{"unit":"u1","kind":"MOVE","direction":"UP"},{"unit":"u2","kind":"WAIT"}],` +
		`"core":{"kind":"WAIT"},"reason":"r"}`
	if string(data) != want {
		t.Errorf("canonical bytes = %s, want %s", data, want)
	}
}

// TestMarshalPlanOmitsEmptyCore 验证 nil core / 空 reason 被 omitempty 省略。
func TestMarshalPlanOmitsEmptyCore(t *testing.T) {
	plan := Plan{Actions: []UnitAction{}}
	data, err := MarshalPlan(plan)
	if err != nil {
		t.Fatalf("MarshalPlan: %v", err)
	}
	if string(data) != `{"actions":[]}` {
		t.Errorf("marshal = %s, want {\"actions\":[]}", data)
	}
	parsed, err := ParsePlan(data)
	if err != nil {
		t.Fatalf("ParsePlan: %v", err)
	}
	if parsed.Core != nil || parsed.Reason != "" {
		t.Errorf("parsed = %+v, want nil core and empty reason", parsed)
	}
}

// TestParsePlanNullCore 验证显式 "core": null 与缺失 core 等价（均为 nil）。
func TestParsePlanNullCore(t *testing.T) {
	plan, err := ParsePlan([]byte(`{"actions":[{"unit":"u1","kind":"WAIT"}],"core":null}`))
	if err != nil {
		t.Fatalf("ParsePlan: %v", err)
	}
	if plan.Core != nil {
		t.Errorf("core = %+v, want nil", plan.Core)
	}
}

// TestParsePlanFull 验证完整载荷解析（含 core SPAWN 与 reason）。
func TestParsePlanFull(t *testing.T) {
	plan, err := ParsePlan([]byte(`{"actions":[{"unit":"u1","kind":"MOVE","direction":"DOWN"},` +
		`{"unit":"u2","kind":"SHOOT","target_id":"e1","expected_cell":[7,8]}],` +
		`"core":{"kind":"SPAWN","unit_type":"RANGER"},"reason":"harass"}`))
	if err != nil {
		t.Fatalf("ParsePlan: %v", err)
	}
	if plan.Actions[0].Direction == nil || *plan.Actions[0].Direction != DirectionDown {
		t.Errorf("actions[0].direction = %v, want DOWN", plan.Actions[0].Direction)
	}
	if plan.Actions[1].TargetID == nil || *plan.Actions[1].TargetID != "e1" ||
		plan.Actions[1].ExpectedCell == nil || *plan.Actions[1].ExpectedCell != (Position{7, 8}) {
		t.Errorf("actions[1] = %+v", plan.Actions[1])
	}
	if plan.Core == nil || plan.Core.Kind != CoreSpawn ||
		plan.Core.UnitType == nil || *plan.Core.UnitType != UnitTypeRanger {
		t.Errorf("core = %+v", plan.Core)
	}
	if plan.Reason != "harass" {
		t.Errorf("reason = %q", plan.Reason)
	}
}

// TestParsePlanInvalid 覆盖 arena_plan 非法样例：错误枚举、缺必填、类型错误、
// 关系不变量（direction 仅 MOVE/SWEEP、target_id/expected_cell 仅 SHOOT、
// SPAWN 需要 unit_type、每单位至多一个动作）。
func TestParsePlanInvalid(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr string
	}{
		{name: "malformed json", json: `{`, wantErr: "parse plan"},
		{name: "missing actions", json: `{}`, wantErr: "requires actions"},
		{name: "null actions", json: `{"actions":null}`, wantErr: "requires actions"},
		{name: "actions type error", json: `{"actions":"nope"}`, wantErr: "parse plan"},
		{name: "empty unit", json: `{"actions":[{"unit":"","kind":"WAIT"}]}`, wantErr: "requires unit"},
		{name: "missing kind", json: `{"actions":[{"unit":"u1"}]}`, wantErr: "invalid action kind"},
		{name: "unknown kind", json: `{"actions":[{"unit":"u1","kind":"TELEPORT"}]}`, wantErr: "invalid action kind"},
		{name: "unit type error", json: `{"actions":[{"unit":1,"kind":"WAIT"}]}`, wantErr: "parse plan"},
		{name: "move without direction", json: `{"actions":[{"unit":"u1","kind":"MOVE"}]}`, wantErr: "requires direction"},
		{name: "move invalid direction", json: `{"actions":[{"unit":"u1","kind":"MOVE","direction":"NORTH"}]}`, wantErr: "invalid direction"},
		{name: "move with target", json: `{"actions":[{"unit":"u1","kind":"MOVE","direction":"UP","target_id":"e1"}]}`, wantErr: "does not allow"},
		{name: "sweep without direction", json: `{"actions":[{"unit":"u1","kind":"SWEEP"}]}`, wantErr: "requires direction"},
		{name: "sweep with expected_cell", json: `{"actions":[{"unit":"u1","kind":"SWEEP","direction":"UP","expected_cell":[1,2]}]}`, wantErr: "does not allow"},
		{name: "shoot without expected_cell", json: `{"actions":[{"unit":"u1","kind":"SHOOT","target_id":"e1"}]}`, wantErr: "requires expected_cell"},
		{name: "shoot with direction", json: `{"actions":[{"unit":"u1","kind":"SHOOT","direction":"UP","expected_cell":[1,2]}]}`, wantErr: "does not allow direction"},
		{name: "harvest with direction", json: `{"actions":[{"unit":"u1","kind":"HARVEST","direction":"UP"}]}`, wantErr: "does not allow"},
		{name: "deposit with expected_cell", json: `{"actions":[{"unit":"u1","kind":"DEPOSIT","expected_cell":[1,2]}]}`, wantErr: "does not allow"},
		{name: "wait with target", json: `{"actions":[{"unit":"u1","kind":"WAIT","target_id":"e1"}]}`, wantErr: "does not allow"},
		{name: "heal with unit_type", json: `{"actions":[{"unit":"u1","kind":"HEAL","unit_type":"WORKER"}]}`, wantErr: "unknown field"},
		{name: "expected_cell wrong shape", json: `{"actions":[{"unit":"u1","kind":"SHOOT","expected_cell":[1]}]}`, wantErr: "parse plan"},
		{name: "duplicate unit", json: `{"actions":[{"unit":"u1","kind":"WAIT"},{"unit":"u1","kind":"MOVE","direction":"UP"}]}`, wantErr: "duplicate unit"},

		{name: "spawn without unit_type", json: `{"actions":[],"core":{"kind":"SPAWN"}}`, wantErr: "SPAWN requires unit_type"},
		{name: "spawn invalid unit_type", json: `{"actions":[],"core":{"kind":"SPAWN","unit_type":"TANK"}}`, wantErr: "invalid unit_type"},
		{name: "core unknown kind", json: `{"actions":[],"core":{"kind":"JUMP"}}`, wantErr: "invalid core action kind"},
		{name: "heal with unit_type", json: `{"actions":[],"core":{"kind":"HEAL","unit_type":"WORKER"}}`, wantErr: "does not allow unit_type"},
		{name: "wait with unit_type", json: `{"actions":[],"core":{"kind":"WAIT","unit_type":"WORKER"}}`, wantErr: "does not allow unit_type"},
		{name: "core missing kind", json: `{"actions":[],"core":{}}`, wantErr: "invalid core action kind"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParsePlan([]byte(tc.json))
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("error %q does not contain %q", err, tc.wantErr)
			}
		})
	}
}

// TestMarshalPlanRejectsInvalid 验证 MarshalPlan 对非法计划拒绝序列化。
func TestMarshalPlanRejectsInvalid(t *testing.T) {
	plan := Plan{Actions: []UnitAction{{Unit: "u1", Kind: ActionMove}}} // 缺 direction
	if _, err := MarshalPlan(plan); err == nil {
		t.Error("MarshalPlan of invalid plan must fail")
	}
	if _, err := MarshalPlan(Plan{}); err == nil {
		t.Error("MarshalPlan of plan without actions must fail")
	}
}

// TestValidatePlanNil 覆盖 nil 入参。
func TestValidatePlanNil(t *testing.T) {
	if err := ValidatePlan(nil); err == nil {
		t.Error("ValidatePlan(nil) must fail")
	}
	if err := ValidateUnitAction(nil); err == nil {
		t.Error("ValidateUnitAction(nil) must fail")
	}
	if err := ValidateCoreAction(nil); err == nil {
		t.Error("ValidateCoreAction(nil) must fail")
	}
}

// TestActionKindEnumCompleteness 枚举全集断言：与 arena-plan.schema.json 的
// actions[].kind enum 逐项一致（10 项）。
func TestActionKindEnumCompleteness(t *testing.T) {
	want := []ActionKind{
		ActionMove, ActionSweep, ActionShoot, ActionHarvest, ActionDeposit,
		ActionHeal, ActionPickupBeacon, ActionDropBeacon, ActionSelfDestruct,
		ActionWait,
	}
	got := AllActionKinds()
	if len(got) != len(want) {
		t.Fatalf("AllActionKinds() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AllActionKinds() = %v, want %v", got, want)
		}
		if !ValidActionKind(got[i]) {
			t.Errorf("ValidActionKind(%q) = false", got[i])
		}
	}
	if ValidActionKind("JUMP") {
		t.Error("ValidActionKind must reject unknown kind")
	}
}

// TestCoreActionKindEnumCompleteness 枚举全集断言：与 arena-plan.schema.json
// 的 core.kind 子集逐项一致（SPAWN/HEAL/REPAIR_SHIELD/WAIT）。
func TestCoreActionKindEnumCompleteness(t *testing.T) {
	want := []CoreActionKind{CoreSpawn, CoreHeal, CoreRepairShield, CoreWait}
	got := AllCoreActionKinds()
	if len(got) != len(want) {
		t.Fatalf("AllCoreActionKinds() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AllCoreActionKinds() = %v, want %v", got, want)
		}
		if !ValidCoreActionKind(got[i]) {
			t.Errorf("ValidCoreActionKind(%q) = false", got[i])
		}
	}
	if ValidCoreActionKind("JUMP") {
		t.Error("ValidCoreActionKind must reject unknown kind")
	}
}

// TestDirectionEnumCompleteness 枚举全集断言：UP/DOWN/LEFT/RIGHT。
func TestDirectionEnumCompleteness(t *testing.T) {
	want := []Direction{DirectionUp, DirectionDown, DirectionLeft, DirectionRight}
	got := AllDirections()
	if len(got) != len(want) {
		t.Fatalf("AllDirections() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AllDirections() = %v, want %v", got, want)
		}
		if !ValidDirection(got[i]) {
			t.Errorf("ValidDirection(%q) = false", got[i])
		}
	}
	if ValidDirection("NORTH") {
		t.Error("ValidDirection must reject unknown direction")
	}
}

// TestUnitTypeEnumCompleteness 枚举全集断言：WORKER/VANGUARD/RANGER。
func TestUnitTypeEnumCompleteness(t *testing.T) {
	want := []UnitType{UnitTypeWorker, UnitTypeVanguard, UnitTypeRanger}
	got := AllUnitTypes()
	if len(got) != len(want) {
		t.Fatalf("AllUnitTypes() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("AllUnitTypes() = %v, want %v", got, want)
		}
		if !ValidUnitType(got[i]) {
			t.Errorf("ValidUnitType(%q) = false", got[i])
		}
	}
	if ValidUnitType("TANK") {
		t.Error("ValidUnitType must reject unknown type")
	}
}

// TestWorldQueryRoundTrip 覆盖 arena_map 请求：三种 query 值 + bounds 可选。
func TestWorldQueryRoundTrip(t *testing.T) {
	queries := []string{"stats", "obstacles", "allies"}
	for _, query := range queries {
		withBounds := WorldQuery{Query: query, Bounds: &QueryBounds{1, 2, 3, 4}}
		first, err := MarshalWorldQuery(withBounds)
		if err != nil {
			t.Fatalf("MarshalWorldQuery(%s): %v", query, err)
		}
		parsed, err := ParseWorldQuery(first)
		if err != nil {
			t.Fatalf("ParseWorldQuery(%s): %v", query, err)
		}
		second, err := MarshalWorldQuery(*parsed)
		if err != nil {
			t.Fatalf("MarshalWorldQuery after parse: %v", err)
		}
		if !bytes.Equal(first, second) {
			t.Errorf("%s round trip bytes differ: %s vs %s", query, first, second)
		}
		withoutBounds := WorldQuery{Query: query}
		data, err := MarshalWorldQuery(withoutBounds)
		if err != nil {
			t.Fatalf("MarshalWorldQuery without bounds: %v", err)
		}
		if string(data) != `{"query":"`+query+`"}` {
			t.Errorf("marshal without bounds = %s", data)
		}
	}
}

// TestWorldQueryInvalid 覆盖 arena_map 非法样例。
func TestWorldQueryInvalid(t *testing.T) {
	cases := []struct {
		name string
		json string
	}{
		{name: "malformed json", json: `{`},
		{name: "missing query", json: `{}`},
		{name: "unknown query", json: `{"query":"weather"}`},
		{name: "query type error", json: `{"query":1}`},
		{name: "bounds wrong size", json: `{"query":"stats","bounds":[1,2,3]}`},
		{name: "bounds type error", json: `{"query":"stats","bounds":"x"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseWorldQuery([]byte(tc.json)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

// TestValidateWorldQueryNil 覆盖 nil 入参。
func TestValidateWorldQueryNil(t *testing.T) {
	if err := ValidateWorldQuery(nil); err == nil {
		t.Error("ValidateWorldQuery(nil) must fail")
	}
}
