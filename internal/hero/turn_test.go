package hero

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
)

func TestTurnBuildEmptyPlan(t *testing.T) {
	turn := NewTurn(3)
	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if plan.Tick != 3 {
		t.Errorf("plan tick = %d, want 3", plan.Tick)
	}
	if len(plan.UnitActions) != 0 {
		t.Errorf("unit_actions = %v, want empty", plan.UnitActions)
	}
	if plan.CoreAction != nil {
		t.Errorf("core_action = %v, want nil", plan.CoreAction)
	}
}

func TestTurnCollectsUnitAndCoreActions(t *testing.T) {
	turn := NewTurn(9)
	target := "target-uuid-1234"

	if err := turn.Move("unit-w1", contracts.DirectionUp); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if err := turn.Sweep("unit-v1", contracts.DirectionDown); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if err := turn.Shoot("unit-r1", contracts.Position{5, 6}, &target); err != nil {
		t.Fatalf("Shoot: %v", err)
	}
	if err := turn.Harvest("unit-w2"); err != nil {
		t.Fatalf("Harvest: %v", err)
	}
	if err := turn.Deposit("unit-w3"); err != nil {
		t.Fatalf("Deposit: %v", err)
	}
	if err := turn.Heal("unit-w4"); err != nil {
		t.Fatalf("Heal: %v", err)
	}
	if err := turn.PickupBeacon("unit-w5"); err != nil {
		t.Fatalf("PickupBeacon: %v", err)
	}
	if err := turn.DropBeacon("unit-w6"); err != nil {
		t.Fatalf("DropBeacon: %v", err)
	}
	if err := turn.SelfDestruct("unit-w7"); err != nil {
		t.Fatalf("SelfDestruct: %v", err)
	}
	if err := turn.Wait("unit-w8"); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := turn.Spawn(contracts.UnitTypeWorker); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := turn.RepairShield(); err != nil {
		t.Fatalf("RepairShield: %v", err)
	}
	if err := turn.StartMove(contracts.DirectionLeft); err != nil {
		t.Fatalf("StartMove: %v", err)
	}
	if err := turn.CancelMove(); err != nil {
		t.Fatalf("CancelMove: %v", err)
	}
	if err := turn.CoreHeal(); err != nil {
		t.Fatalf("CoreHeal: %v", err)
	}
	if err := turn.CorePickupBeacon(); err != nil {
		t.Fatalf("CorePickupBeacon: %v", err)
	}
	if err := turn.CoreDropBeacon(); err != nil {
		t.Fatalf("CoreDropBeacon: %v", err)
	}
	if err := turn.CoreSelfDestruct(); err != nil {
		t.Fatalf("CoreSelfDestruct: %v", err)
	}
	if err := turn.CoreWait(); err != nil {
		t.Fatalf("CoreWait: %v", err)
	}

	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if got := len(plan.UnitActions); got != 10 {
		t.Fatalf("unit action count = %d, want 10", got)
	}
	if got := plan.UnitActions["unit-w1"]; got.Type != string(contracts.WireUnitMove) || got.Direction == nil || *got.Direction != contracts.DirectionUp {
		t.Errorf("unit-w1 = %+v", got)
	}
	if got := plan.UnitActions["unit-r1"]; got.Type != string(contracts.WireUnitShoot) ||
		got.TargetID == nil || *got.TargetID != target || got.ExpectedCell == nil || *got.ExpectedCell != (contracts.Position{5, 6}) {
		t.Errorf("unit-r1 = %+v", got)
	}
	if plan.CoreAction == nil || plan.CoreAction.Type != string(contracts.WireCoreWait) {
		t.Errorf("core_action = %+v, want WAIT", plan.CoreAction)
	}
}

func TestTurnBuildSortsUnitActionsByID(t *testing.T) {
	turn := NewTurn(1)
	if err := turn.SetUnitAction("z-unit", contracts.WireAction{Type: string(contracts.WireUnitWait)}); err != nil {
		t.Fatalf("SetUnitAction z: %v", err)
	}
	if err := turn.SetUnitAction("a-unit", contracts.WireAction{Type: string(contracts.WireUnitWait)}); err != nil {
		t.Fatalf("SetUnitAction a: %v", err)
	}
	if err := turn.SetUnitAction("m-unit", contracts.WireAction{Type: string(contracts.WireUnitWait)}); err != nil {
		t.Fatalf("SetUnitAction m: %v", err)
	}
	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	encoded, err := contracts.MarshalCommandPlan(plan)
	if err != nil {
		t.Fatalf("MarshalCommandPlan: %v", err)
	}
	// json.Marshal 对 map 键排序输出（Go 语义）；断言编码文本中的键顺序
	// （不能 unmarshal 后遍历 Go map——map 遍历无序是 flaky 根因）。
	text := string(encoded)
	aPos := strings.Index(text, `"a-unit"`)
	mPos := strings.Index(text, `"m-unit"`)
	zPos := strings.Index(text, `"z-unit"`)
	if aPos < 0 || mPos < 0 || zPos < 0 {
		t.Fatalf("encoded plan missing sorted keys: %s", text)
	}
	if !(aPos < mPos && mPos < zPos) {
		t.Errorf("encoded unit action keys not sorted in output: %s", text)
	}
}

func TestTurnBuildReturnsIndependentCopy(t *testing.T) {
	turn := NewTurn(4)
	if err := turn.Wait("unit-1"); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	// 篡改返回的快照不得影响后续 Build。
	plan.UnitActions["unit-1"] = contracts.WireAction{Type: string(contracts.WireUnitMove), Direction: ptrDirection(contracts.DirectionUp)}
	again, err := turn.Build()
	if err != nil {
		t.Fatalf("second Build: %v", err)
	}
	if got := again.UnitActions["unit-1"].Type; got != string(contracts.WireUnitWait) {
		t.Errorf("builder mutated by returned snapshot: %q", got)
	}
}

func ptrDirection(direction contracts.Direction) *contracts.Direction {
	return &direction
}

func TestTurnReplaceReplacesContent(t *testing.T) {
	turn := NewTurn(8)
	if err := turn.Wait("old-unit"); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := turn.Spawn(contracts.UnitTypeRanger); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	replacement := contracts.CommandPlan{
		Tick:        8,
		UnitActions: map[string]contracts.WireAction{"new-unit": {Type: string(contracts.WireUnitHarvest)}},
		CoreAction:  nil,
	}
	if err := turn.Replace(replacement); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if _, exists := plan.UnitActions["old-unit"]; exists {
		t.Errorf("old unit action survived Replace")
	}
	if got := plan.UnitActions["new-unit"].Type; got != string(contracts.WireUnitHarvest) {
		t.Errorf("new-unit = %q, want HARVEST", got)
	}
	if plan.CoreAction != nil {
		t.Errorf("core_action = %+v, want nil (replaced)", plan.CoreAction)
	}
}

func TestTurnReplaceValidatesPlan(t *testing.T) {
	turn := NewTurn(2)
	err := turn.Replace(contracts.CommandPlan{
		Tick:        2,
		UnitActions: map[string]contracts.WireAction{"bad": {Type: string(contracts.WireUnitMove)}}, // MOVE 缺 direction
	})
	var actionErr *InvalidActionError
	if !asError(err, &actionErr) {
		t.Fatalf("Replace err = %v, want InvalidActionError", err)
	}
}

func TestTurnClear(t *testing.T) {
	turn := NewTurn(6)
	if err := turn.Wait("unit-1"); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if err := turn.Spawn(contracts.UnitTypeWorker); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := turn.Clear(); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	plan, err := turn.Build()
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(plan.UnitActions) != 0 || plan.CoreAction != nil {
		t.Errorf("plan after Clear = %+v, want empty", plan)
	}
}

func TestTurnSetActionValidation(t *testing.T) {
	turn := NewTurn(1)

	err := turn.SetUnitAction("u1", contracts.WireAction{Type: string(contracts.WireUnitMove)})
	var actionErr *InvalidActionError
	if !asError(err, &actionErr) {
		t.Errorf("MOVE without direction: err = %v, want InvalidActionError", err)
	}

	err = turn.SetUnitAction("u1", contracts.WireAction{
		Type:      string(contracts.WireUnitMove),
		Direction: ptrDirection("NOWHERE"),
	})
	if !asError(err, &actionErr) {
		t.Errorf("MOVE with bad direction: err = %v, want InvalidActionError", err)
	}

	err = turn.SetCoreAction(contracts.WireAction{Type: string(contracts.WireCoreSpawn)})
	if !asError(err, &actionErr) {
		t.Errorf("SPAWN without unit_type: err = %v, want InvalidActionError", err)
	}

	err = turn.SetUnitAction("u1", contracts.WireAction{Type: "UNKNOWN_KIND"})
	if !asError(err, &actionErr) {
		t.Errorf("unknown action kind: err = %v, want InvalidActionError", err)
	}

	// 合法动作应成功
	if err := turn.SetUnitAction("u1", contracts.WireAction{Type: string(contracts.WireUnitWait)}); err != nil {
		t.Errorf("WAIT: %v", err)
	}
}

func TestTurnClosedRejectsAllOperations(t *testing.T) {
	turn := NewTurn(5)
	turn.Close()
	turn.Close() // 幂等

	ops := []struct {
		name string
		run  func() error
	}{
		{"Build", func() error { _, err := turn.Build(); return err }},
		{"SetUnitAction", func() error {
			return turn.SetUnitAction("u1", contracts.WireAction{Type: string(contracts.WireUnitWait)})
		}},
		{"SetCoreAction", func() error {
			return turn.SetCoreAction(contracts.WireAction{Type: string(contracts.WireCoreWait)})
		}},
		{"Replace", func() error {
			return turn.Replace(contracts.CommandPlan{Tick: 5, UnitActions: map[string]contracts.WireAction{}})
		}},
		{"Clear", turn.Clear},
		{"Submit", func() error { _, err := turn.Submit(context.Background(), ""); return err }},
	}
	for _, op := range ops {
		err := op.run()
		var closedErr *TurnClosedError
		if !asError(err, &closedErr) {
			t.Errorf("%s on closed turn: err = %v, want TurnClosedError", op.name, err)
		}
	}
}

func TestTurnUnboundSubmitRejected(t *testing.T) {
	turn := NewTurn(1)
	if err := turn.Wait("u1"); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	_, err := turn.Submit(context.Background(), "")
	var confErr *ConfigurationError
	if !asError(err, &confErr) {
		t.Fatalf("Submit err = %v, want ConfigurationError", err)
	}
}

func TestTurnBoundSubmitSendsPlan(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	turn := client.NewTurn(5)
	if err := turn.Move("unit-a", contracts.DirectionUp); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if err := turn.Spawn(contracts.UnitTypeWorker); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	accepted, err := turn.Submit(context.Background(), "")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if accepted.Tick != 7 {
		t.Errorf("accepted tick = %d, want 7", accepted.Tick)
	}
	headers := fs.lastHeaders()
	if got := headers.Get("Idempotency-Key"); !idempotencyKeyPattern.MatchString(got) {
		t.Errorf("Idempotency-Key = %q, want pattern %s", got, idempotencyKeyPattern)
	}
	if got := headers.Get("Authorization"); got != "Bearer "+testAPIKey {
		t.Errorf("Authorization = %q", got)
	}
}
