package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// enemyState 构造带敌方单位的状态：Core 在原点 + 2 worker。
func enemyState() *domain.TickState {
	state := baseState()
	state.Units = append(state.Units,
		domain.UnitSnapshot{ID: "worker-2", Position: domain.Position{5, 0}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
	)
	state.Workers = append(state.Workers, state.Units[1])
	return state
}

// TestEnemyVanguardAttacksAdjacentUnit：敌方 Vanguard 相邻 → 攻击我方
// 单位（1 伤害），HP 2→1，UnitsLost=0。
func TestEnemyVanguardAttacksAdjacentUnit(t *testing.T) {
	state := enemyState()
	vanguardType := domain.UnitVanguard
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-v1", Kind: "UNIT", Position: domain.Position{6, 0}, HP: 4, UnitType: &vanguardType},
	}
	engine := NewEngine()

	result := engine.Settle(state, &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}})
	if result.Stats.UnitsLost != 0 {
		t.Fatalf("unitsLost = %d, want 0 (HP 2→1)", result.Stats.UnitsLost)
	}
	// worker-2 在 (5,0) 相邻 (6,0) → 受 1 伤害。
	if got := result.NextState.Units[1].HP; got != 1 {
		t.Errorf("worker-2 HP = %d, want 1 (enemy vanguard adjacent hit)", got)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "ENEMY_ATTACK" && event.TargetID != nil && *event.TargetID == "worker-2" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected ENEMY_ATTACK on worker-2, got %+v", result.Events)
	}
}

// TestEnemyRangerKillsUnit：敌方 Ranger 八方向 3 格内 → 攻击我方 HP=1
// 单位 → 击杀（UnitsLost=1，从 Units 移除）。
func TestEnemyRangerKillsUnit(t *testing.T) {
	state := enemyState()
	state.Units[1].HP = 1 // worker-2 只剩 1 HP
	state.Workers[1].HP = 1
	rangerType := domain.UnitRanger
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-r1", Kind: "UNIT", Position: domain.Position{8, 0}, HP: 2, UnitType: &rangerType},
	}
	engine := NewEngine()

	result := engine.Settle(state, &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}})
	if result.Stats.UnitsLost != 1 {
		t.Fatalf("unitsLost = %d, want 1 (worker killed)", result.Stats.UnitsLost)
	}
	if len(result.NextState.Units) != 1 {
		t.Errorf("units = %d, want 1 (worker-2 removed)", len(result.NextState.Units))
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "UNIT_DESTROYED" && event.ActorID != nil && *event.ActorID == "worker-2" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected UNIT_DESTROYED for worker-2, got %+v", result.Events)
	}
}

// TestEnemyAttacksCoreShieldFirst：敌方攻击 Core → Shield 优先扣减。
func TestEnemyAttacksCoreShieldFirst(t *testing.T) {
	state := enemyState()
	vanguardType := domain.UnitVanguard
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-v1", Kind: "UNIT", Position: domain.Position{1, 0}, HP: 4, UnitType: &vanguardType},
	}
	engine := NewEngine()

	result := engine.Settle(state, &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}})
	next := result.NextState
	if next.Core.Shield != domain.CoreMaxShield-1 {
		t.Errorf("core shield = %d, want %d (shield absorbs 1)", next.Core.Shield, domain.CoreMaxShield-1)
	}
	if next.Core.HP != domain.CoreMaxHP {
		t.Errorf("core HP = %d, want %d (shield first)", next.Core.HP, domain.CoreMaxHP)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "CORE_DAMAGED" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected CORE_DAMAGED event, got %+v", result.Events)
	}
}

// TestEnemyAttackChoosesNearestUnit：敌方可选单位与 Core → 就近单位优先
// （Manhattan 距离）。
func TestEnemyAttackChoosesNearestUnit(t *testing.T) {
	state := enemyState()
	// worker-1 在 (0,0) Core 格，worker-2 在 (5,0)；敌人 (6,0) 只能打
	// worker-2（worker-1 在 Core 上距离 6 超射程）。
	vanguardType := domain.UnitVanguard
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-v1", Kind: "UNIT", Position: domain.Position{6, 0}, HP: 4, UnitType: &vanguardType},
	}
	engine := NewEngine()

	result := engine.Settle(state, &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}})
	if got := result.NextState.Units[1].HP; got != 1 {
		t.Errorf("worker-2 HP = %d, want 1 (nearest target)", got)
	}
}

// TestEnemyWorkerCannotAttack：敌方 Worker 无攻击（官方规则）。
func TestEnemyWorkerCannotAttack(t *testing.T) {
	state := enemyState()
	workerType := domain.UnitWorker
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-w1", Kind: "UNIT", Position: domain.Position{6, 0}, HP: 2, UnitType: &workerType},
	}
	engine := NewEngine()

	result := engine.Settle(state, &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}})
	if result.Stats.UnitsLost != 0 {
		t.Errorf("unitsLost = %d, want 0 (worker cannot attack)", result.Stats.UnitsLost)
	}
	for _, event := range result.Events {
		if event.EventType == "ENEMY_ATTACK" {
			t.Errorf("unexpected ENEMY_ATTACK from worker: %+v", event)
		}
	}
}

// TestEnemyAttackDeterministic：同输入两次结算一致（快照语义 + 目标选择
// 确定性）。
func TestEnemyAttackDeterministic(t *testing.T) {
	state := enemyState()
	vanguardType := domain.UnitVanguard
	state.VisibleEnemies = []domain.VisibleEntity{
		{ID: "enemy-v1", Kind: "UNIT", Position: domain.Position{6, 0}, HP: 4, UnitType: &vanguardType},
	}
	plan := &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}}

	first := NewEngine().Settle(state, plan)
	second := NewEngine().Settle(state, plan)
	if first.Stats.UnitsLost != second.Stats.UnitsLost {
		t.Errorf("unitsLost differs: %d vs %d", first.Stats.UnitsLost, second.Stats.UnitsLost)
	}
	if first.NextState.Units[1].HP != second.NextState.Units[1].HP {
		t.Errorf("HP differs: %d vs %d", first.NextState.Units[1].HP, second.NextState.Units[1].HP)
	}
}
