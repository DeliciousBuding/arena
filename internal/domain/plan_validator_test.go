package domain

import (
	"reflect"
	"testing"
)

// validatorPlan 构造 Plan（tick 与 baseValidatorState 一致）。
func validatorPlan(actions map[string]UnitAction, core *CoreAction) Plan {
	return Plan{
		Tick:        1,
		UnitActions: actions,
		CoreAction:  core,
		Intents:     map[string]string{},
	}
}

func TestValidatePlanTickMismatch(t *testing.T) {
	state := baseValidatorState()
	plan := Plan{Tick: 2, UnitActions: map[string]UnitAction{}}
	result := ValidatePlan(state, plan)
	if result.Valid || !result.Repaired {
		t.Errorf("valid/repaired = %v/%v, want false/true", result.Valid, result.Repaired)
	}
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeTickMismatch {
		t.Errorf("issues = %+v, want tick_mismatch", result.Issues)
	}
	if len(result.Plan.UnitActions) != 0 || result.Plan.CoreAction != nil {
		t.Errorf("tick mismatch must repair to empty plan: %+v", result.Plan)
	}
}

func TestValidatePlanUnknownUnit(t *testing.T) {
	state := baseValidatorState()
	plan := validatorPlan(map[string]UnitAction{
		"ghost-1": {Kind: ActionWait},
	}, nil)
	result := ValidatePlan(state, plan)
	if result.Valid || !result.Repaired {
		t.Fatalf("valid/repaired = %v/%v", result.Valid, result.Repaired)
	}
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeUnknownUnit ||
		result.Issues[0].ActorID != "ghost-1" {
		t.Errorf("issues = %+v", result.Issues)
	}
	if len(result.Plan.UnitActions) != 0 {
		t.Errorf("unknown unit action must be dropped")
	}
}

func TestValidatePlanMove(t *testing.T) {
	state := baseValidatorState()
	// UP → (0,-1) 是障碍 → blocked_move。
	blocked := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionMove, Direction: dirPtr(DirectionUp)},
	}, nil)
	result := ValidatePlan(state, blocked)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeBlockedMove {
		t.Errorf("blocked move issues = %+v", result.Issues)
	}
	if len(result.Plan.UnitActions) != 0 {
		t.Errorf("blocked move must be dropped")
	}
	// RIGHT → (1,0) 畅通 → 保留。
	valid := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionMove, Direction: dirPtr(DirectionRight)},
	}, nil)
	result = ValidatePlan(state, valid)
	if !result.Valid || result.Repaired {
		t.Fatalf("valid/repaired = %v/%v", result.Valid, result.Repaired)
	}
	if len(result.Plan.UnitActions) != 1 {
		t.Errorf("valid move must be kept")
	}
	// 缺 direction（结构性守卫）。
	missing := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionMove},
	}, nil)
	result = ValidatePlan(state, missing)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeBlockedMove {
		t.Errorf("missing direction issues = %+v", result.Issues)
	}
}

func TestValidatePlanHarvest(t *testing.T) {
	state := baseValidatorState()
	// worker-2 站在 (3,3) 资源格上 → 合法。
	ok := validatorPlan(map[string]UnitAction{
		"worker-2": {Kind: ActionHarvest},
	}, nil)
	if result := ValidatePlan(state, ok); !result.Valid {
		t.Errorf("harvest on resource must be valid: %+v", result.Issues)
	}
	// worker-1 不在资源格上 → invalid_harvest。
	off := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionHarvest},
	}, nil)
	result := ValidatePlan(state, off)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidHarvest {
		t.Errorf("harvest off-resource issues = %+v", result.Issues)
	}
	// 非 WORKER → wrong_capability。
	wrong := validatorPlan(map[string]UnitAction{
		"vanguard-1": {Kind: ActionHarvest},
	}, nil)
	result = ValidatePlan(state, wrong)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeWrongCapability {
		t.Errorf("harvest wrong unit issues = %+v", result.Issues)
	}
}

func TestValidatePlanDeposit(t *testing.T) {
	state := baseValidatorState()
	// worker-1 在 core 格且有 cargo → 合法。
	ok := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionDeposit},
	}, nil)
	if result := ValidatePlan(state, ok); !result.Valid {
		t.Errorf("deposit on core must be valid: %+v", result.Issues)
	}
	// worker-2 不在 core 格 → invalid_deposit。
	off := validatorPlan(map[string]UnitAction{
		"worker-2": {Kind: ActionDeposit},
	}, nil)
	result := ValidatePlan(state, off)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidDeposit {
		t.Errorf("deposit off-core issues = %+v", result.Issues)
	}
	// cargo = 0 → invalid_deposit。
	noCargo := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionDeposit},
	}, nil)
	stateZeroCargo := baseValidatorState()
	stateZeroCargo.Units[0].Cargo = 0
	result = ValidatePlan(stateZeroCargo, noCargo)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidDeposit {
		t.Errorf("deposit without cargo issues = %+v", result.Issues)
	}
}

func TestValidatePlanSweep(t *testing.T) {
	state := baseValidatorState()
	ok := validatorPlan(map[string]UnitAction{
		"vanguard-1": {Kind: ActionSweep, Direction: dirPtr(DirectionUp)},
	}, nil)
	if result := ValidatePlan(state, ok); !result.Valid {
		t.Errorf("vanguard sweep must be valid: %+v", result.Issues)
	}
	wrong := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionSweep, Direction: dirPtr(DirectionUp)},
	}, nil)
	result := ValidatePlan(state, wrong)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeWrongCapability {
		t.Errorf("sweep wrong unit issues = %+v", result.Issues)
	}
}

func TestValidatePlanShoot(t *testing.T) {
	state := baseValidatorState()
	// ranger-1 @(0,0) → enemy-1 @(0,3)：距离 3、共线、无障碍 → 合法。
	ok := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, TargetID: strPtr("enemy-1"), ExpectedCell: posPtr(Position{0, 3})},
	}, nil)
	if result := ValidatePlan(state, ok); !result.Valid {
		t.Errorf("valid shot must pass: %+v", result.Issues)
	}
	// cell fire（targetId 为 nil）→ 合法。
	cellFire := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, ExpectedCell: posPtr(Position{0, 2})},
	}, nil)
	if result := ValidatePlan(state, cellFire); !result.Valid {
		t.Errorf("cell fire must pass: %+v", result.Issues)
	}
	// 超射程（距离 9）→ invalid_shot。
	outOfRange := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, ExpectedCell: posPtr(Position{0, 9})},
	}, nil)
	result := ValidatePlan(state, outOfRange)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidShot {
		t.Errorf("out-of-range shot issues = %+v", result.Issues)
	}
	// 不共线 → invalid_shot。
	misaligned := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, ExpectedCell: posPtr(Position{1, 2})},
	}, nil)
	result = ValidatePlan(state, misaligned)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidShot {
		t.Errorf("misaligned shot issues = %+v", result.Issues)
	}
	// 视线被障碍遮挡 → invalid_shot。
	blockedState := baseValidatorState()
	blockedState.ObstacleCells = keySet(Position{0, 1})
	losBlocked := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, ExpectedCell: posPtr(Position{0, 3})},
	}, nil)
	result = ValidatePlan(blockedState, losBlocked)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidShot {
		t.Errorf("LOS-blocked shot issues = %+v", result.Issues)
	}
	// target 不在 expected_cell → invalid_shot。
	wrongCell := validatorPlan(map[string]UnitAction{
		"ranger-1": {Kind: ActionShoot, TargetID: strPtr("enemy-1"), ExpectedCell: posPtr(Position{0, 2})},
	}, nil)
	result = ValidatePlan(state, wrongCell)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidShot {
		t.Errorf("wrong target cell issues = %+v", result.Issues)
	}
	// 非 RANGER → wrong_capability。
	wrongUnit := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionShoot, ExpectedCell: posPtr(Position{0, 2})},
	}, nil)
	result = ValidatePlan(state, wrongUnit)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeWrongCapability {
		t.Errorf("shoot wrong unit issues = %+v", result.Issues)
	}
}

func TestValidatePlanPickupDropBeacon(t *testing.T) {
	state := baseValidatorState()
	// vanguard-1 @(5,5) 与 beacon 同格且 GROUND → 合法。
	pickup := validatorPlan(map[string]UnitAction{
		"vanguard-1": {Kind: ActionPickupBeacon},
	}, nil)
	if result := ValidatePlan(state, pickup); !result.Valid {
		t.Errorf("pickup on beacon must be valid: %+v", result.Issues)
	}
	// worker-1 不在 beacon 格 → invalid_beacon。
	farPickup := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionPickupBeacon},
	}, nil)
	result := ValidatePlan(state, farPickup)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidBeacon {
		t.Errorf("pickup off-beacon issues = %+v", result.Issues)
	}
	// 未携带时 drop → invalid_beacon。
	drop := validatorPlan(map[string]UnitAction{
		"vanguard-1": {Kind: ActionDropBeacon},
	}, nil)
	result = ValidatePlan(state, drop)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidBeacon {
		t.Errorf("drop without carrying issues = %+v", result.Issues)
	}
	// 携带者 drop → 合法。
	carrying := baseValidatorState()
	carrying.Beacon.Status = BeaconCarried
	carrying.Beacon.CarrierID = strPtr("vanguard-1")
	drop = validatorPlan(map[string]UnitAction{
		"vanguard-1": {Kind: ActionDropBeacon},
	}, nil)
	if result := ValidatePlan(carrying, drop); !result.Valid {
		t.Errorf("drop while carrying must be valid: %+v", result.Issues)
	}
}

func TestValidatePlanUnitHeal(t *testing.T) {
	state := baseValidatorState()
	// worker-1 hp1 在 core 格 → 合法。
	ok := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionHeal},
	}, nil)
	if result := ValidatePlan(state, ok); !result.Valid {
		t.Errorf("heal at core must be valid: %+v", result.Issues)
	}
	// 满血 → invalid_heal。
	fullHp := baseValidatorState()
	fullHp.Units[0].HP = 2
	healFull := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionHeal},
	}, nil)
	result := ValidatePlan(fullHp, healFull)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidHeal {
		t.Errorf("heal at full HP issues = %+v", result.Issues)
	}
	// 不在 core 格 → invalid_heal。
	offCore := validatorPlan(map[string]UnitAction{
		"worker-2": {Kind: ActionHeal},
	}, nil)
	result = ValidatePlan(state, offCore)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidHeal {
		t.Errorf("heal off-core issues = %+v", result.Issues)
	}
	// Core MOVING → invalid_heal。
	movingCore := baseValidatorState()
	movingCore.Core.State = CoreMoving
	result = ValidatePlan(movingCore, ok)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidHeal {
		t.Errorf("heal while core moving issues = %+v", result.Issues)
	}
}

func TestValidatePlanCoreActions(t *testing.T) {
	workerType := UnitWorker
	vanguardType := UnitVanguard

	state := baseValidatorState()
	// WAIT → 合法。
	if result := ValidatePlan(state, validatorPlan(nil, &CoreAction{Kind: CoreWait})); !result.Valid {
		t.Errorf("core WAIT must be valid: %+v", result.Issues)
	}
	// SPAWN WORKER（资源 5 = 成本）→ 合法。
	spawn := validatorPlan(nil, &CoreAction{Kind: CoreSpawn, UnitType: &workerType})
	if result := ValidatePlan(state, spawn); !result.Valid {
		t.Errorf("spawn worker must be valid: %+v", result.Issues)
	}
	// 资源不足 → insufficient_resources。
	poor := baseValidatorState()
	poor.Resources = 4
	result := ValidatePlan(poor, spawn)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInsufficientResources {
		t.Errorf("poor spawn issues = %+v", result.Issues)
	}
	if result.Plan.CoreAction != nil {
		t.Errorf("invalid core action must be dropped")
	}
	// Core MOVING → core_unavailable。
	moving := baseValidatorState()
	moving.Core.State = CoreMoving
	result = ValidatePlan(moving, spawn)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeCoreUnavailable {
		t.Errorf("spawn while moving issues = %+v", result.Issues)
	}
	// REPAIR_SHIELD（shield 3 < 5，资源 5）→ 合法。
	repair := validatorPlan(nil, &CoreAction{Kind: CoreRepairShield})
	damaged := baseValidatorState()
	damaged.Core.Shield = 3
	if result := ValidatePlan(damaged, repair); !result.Valid {
		t.Errorf("shield repair must be valid: %+v", result.Issues)
	}
	// 满盾 → core_unavailable。
	result = ValidatePlan(state, repair)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeCoreUnavailable {
		t.Errorf("full shield repair issues = %+v", result.Issues)
	}
	// 无资源修盾 → insufficient_resources。
	noResources := baseValidatorState()
	noResources.Core.Shield = 3
	noResources.Resources = 0
	result = ValidatePlan(noResources, repair)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInsufficientResources {
		t.Errorf("poor shield repair issues = %+v", result.Issues)
	}
	// HEAL（hp 3 < 5）→ 合法；满血 → core_unavailable。
	heal := validatorPlan(nil, &CoreAction{Kind: CoreHeal})
	hurt := baseValidatorState()
	hurt.Core.HP = 3
	if result := ValidatePlan(hurt, heal); !result.Valid {
		t.Errorf("core heal must be valid: %+v", result.Issues)
	}
	result = ValidatePlan(state, heal)
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeCoreUnavailable {
		t.Errorf("full HP core heal issues = %+v", result.Issues)
	}
	// SPAWN VANGUARD（成本 10 > 资源 5）→ insufficient_resources。
	result = ValidatePlan(state, validatorPlan(nil, &CoreAction{Kind: CoreSpawn, UnitType: &vanguardType}))
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInsufficientResources {
		t.Errorf("expensive spawn issues = %+v", result.Issues)
	}
}

func TestValidatePlanMissingCore(t *testing.T) {
	state := baseValidatorState()
	state.Core = nil
	result := ValidatePlan(state, validatorPlan(nil, &CoreAction{Kind: CoreWait}))
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeMissingCore {
		t.Errorf("missing core issues = %+v", result.Issues)
	}
}

func TestValidatePlanRepairKeepsValidActions(t *testing.T) {
	state := baseValidatorState()
	state.Resources = 15
	plan := Plan{
		Tick: 1,
		UnitActions: map[string]UnitAction{
			"worker-1":   {Kind: ActionMove, Direction: dirPtr(DirectionRight)},
			"ranger-1":   {Kind: ActionShoot, ExpectedCell: posPtr(Position{0, 9})},
			"vanguard-1": {Kind: ActionPickupBeacon},
		},
		CoreAction: &CoreAction{Kind: CoreSpawn, UnitType: unitTypePtr(UnitVanguard)},
		Intents: map[string]string{
			"worker-1":   "patrol",
			"ranger-1":   "shoot",
			"vanguard-1": "beacon",
		},
	}
	result := ValidatePlan(state, plan)
	if result.Valid || !result.Repaired {
		t.Fatalf("valid/repaired = %v/%v, want false/true", result.Valid, result.Repaired)
	}
	if len(result.Issues) != 1 || result.Issues[0].Code != CodeInvalidShot {
		t.Fatalf("issues = %+v, want single invalid_shot", result.Issues)
	}
	// 合法动作保留、非法动作剔除。
	if len(result.Plan.UnitActions) != 2 {
		t.Fatalf("kept actions = %d, want 2: %+v", len(result.Plan.UnitActions), result.Plan.UnitActions)
	}
	if _, ok := result.Plan.UnitActions["worker-1"]; !ok {
		t.Error("valid worker action must be kept")
	}
	if _, ok := result.Plan.UnitActions["vanguard-1"]; !ok {
		t.Error("valid vanguard action must be kept")
	}
	if _, ok := result.Plan.UnitActions["ranger-1"]; ok {
		t.Error("invalid ranger action must be dropped")
	}
	// 合法 core 动作保留。
	if result.Plan.CoreAction == nil || result.Plan.CoreAction.Kind != CoreSpawn {
		t.Errorf("valid core action must be kept: %+v", result.Plan.CoreAction)
	}
	// intents 随动作保留/剔除。
	if result.Plan.Intents["worker-1"] != "patrol" || result.Plan.Intents["vanguard-1"] != "beacon" {
		t.Errorf("kept intents = %v", result.Plan.Intents)
	}
	if _, ok := result.Plan.Intents["ranger-1"]; ok {
		t.Errorf("dropped action intent must be dropped: %v", result.Plan.Intents)
	}
}

func TestValidatePlanDeterministic(t *testing.T) {
	state := baseValidatorState()
	plan := validatorPlan(map[string]UnitAction{
		"worker-1":   {Kind: ActionMove, Direction: dirPtr(DirectionUp)},
		"vanguard-1": {Kind: ActionHarvest},
	}, &CoreAction{Kind: CoreSpawn, UnitType: unitTypePtr(UnitVanguard)})
	first := ValidatePlan(state, plan)
	second := ValidatePlan(state, plan)
	if !reflect.DeepEqual(first, second) {
		t.Errorf("validation must be deterministic:\nfirst=%+v\nsecond=%+v", first, second)
	}
}

func TestValidatePlanEmptyAndTrivialActions(t *testing.T) {
	state := baseValidatorState()
	empty := validatorPlan(nil, nil)
	result := ValidatePlan(state, empty)
	if !result.Valid || result.Repaired {
		t.Errorf("empty plan must be valid: %+v", result)
	}
	trivial := validatorPlan(map[string]UnitAction{
		"worker-1": {Kind: ActionWait},
		"ranger-1": {Kind: ActionSelfDestruct},
	}, &CoreAction{Kind: CoreWait})
	if result := ValidatePlan(state, trivial); !result.Valid {
		t.Errorf("WAIT/SELF_DESTRUCT must always be valid: %+v", result.Issues)
	}
}

func TestCountEnemiesNearCore(t *testing.T) {
	state := baseValidatorState()
	if got := CountEnemiesNearCore(state, 3); got != 1 {
		t.Errorf("enemies within radius 3 = %d, want 1", got)
	}
	if got := CountEnemiesNearCore(state, 2); got != 0 {
		t.Errorf("enemies within radius 2 = %d, want 0", got)
	}
	noCore := baseValidatorState()
	noCore.Core = nil
	if got := CountEnemiesNearCore(noCore, 10); got != 0 {
		t.Errorf("enemies without core = %d, want 0", got)
	}
}
