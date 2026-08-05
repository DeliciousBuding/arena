package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// TestCoreHealRestoresHP：Core 掉血 + 资源足够 → HEAL 每 HP 1 资源。
func TestCoreHealRestoresHP(t *testing.T) {
	state := baseState()
	state.Core.HP = 3 // 缺 2 HP（CoreMaxHP=5）
	state.Resources = 5
	plan := &domain.Plan{Tick: 1, CoreAction: &domain.CoreAction{Kind: domain.CoreHeal}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.HPRecovered != 2 {
		t.Errorf("hpRecovered = %d, want 2", result.Stats.HPRecovered)
	}
	if result.NextState.Core.HP != domain.CoreMaxHP {
		t.Errorf("core HP = %d, want %d", result.NextState.Core.HP, domain.CoreMaxHP)
	}
	if result.NextState.Resources != 3 {
		t.Errorf("resources = %d, want 3 (5 - 2)", result.NextState.Resources)
	}
}

// TestCoreHealFailsWhenFull：Core 满血 → HEAL 失败（HP_FULL，不花资源）。
func TestCoreHealFailsWhenFull(t *testing.T) {
	state := baseState() // Core 满血
	state.Resources = 5
	plan := &domain.Plan{Tick: 1, CoreAction: &domain.CoreAction{Kind: domain.CoreHeal}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.HPRecovered != 0 {
		t.Errorf("hpRecovered = %d, want 0", result.Stats.HPRecovered)
	}
	if result.NextState.Resources != 5 {
		t.Errorf("resources = %d, want 5 (no spend)", result.NextState.Resources)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "CORE_HEAL_FAILED" && event.ReasonCode != nil && *event.ReasonCode == "HP_FULL" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected CORE_HEAL_FAILED HP_FULL, got %+v", result.Events)
	}
}

// TestShieldRepairRestoresOneShield：护盾不满 + 1 资源 → REPAIR_SHIELD 恢复 1 盾。
func TestShieldRepairRestoresOneShield(t *testing.T) {
	state := baseState()
	state.Core.Shield = domain.CoreMaxShield - 1
	state.Resources = 3
	plan := &domain.Plan{Tick: 1, CoreAction: &domain.CoreAction{Kind: domain.CoreRepairShield}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.ShieldRepaired != 1 {
		t.Errorf("shieldRepaired = %d, want 1", result.Stats.ShieldRepaired)
	}
	if result.NextState.Core.Shield != domain.CoreMaxShield {
		t.Errorf("shield = %d, want %d", result.NextState.Core.Shield, domain.CoreMaxShield)
	}
	if result.NextState.Resources != 2 {
		t.Errorf("resources = %d, want 2 (3 - 1)", result.NextState.Resources)
	}
}

// TestShieldRepairFailsWhenFull：护盾满 → REPAIR_SHIELD 失败（SHIELD_FULL）。
func TestShieldRepairFailsWhenFull(t *testing.T) {
	state := baseState() // Shield 满
	state.Resources = 3
	plan := &domain.Plan{Tick: 1, CoreAction: &domain.CoreAction{Kind: domain.CoreRepairShield}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.ShieldRepaired != 0 {
		t.Errorf("shieldRepaired = %d, want 0", result.Stats.ShieldRepaired)
	}
	if result.NextState.Resources != 3 {
		t.Errorf("resources = %d, want 3 (no spend)", result.NextState.Resources)
	}
}

// TestUnitHealRestoresHP：单位掉血且在 Core 格 → HEAL 恢复（每 HP 1 资源）。
func TestUnitHealRestoresHP(t *testing.T) {
	state := baseState()
	state.Units[0].Position = domain.Position{0, 0} // 站 Core 格
	state.Workers[0].Position = domain.Position{0, 0}
	state.Units[0].HP = 1 // worker 缺 1 HP
	state.Workers[0].HP = 1
	state.Resources = 4
	plan := &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{
		"worker-1": {Kind: domain.ActionHeal},
	}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.HPRecovered != 1 {
		t.Errorf("hpRecovered = %d, want 1", result.Stats.HPRecovered)
	}
	if result.NextState.Units[0].HP != 2 {
		t.Errorf("worker HP = %d, want 2", result.NextState.Units[0].HP)
	}
	if result.NextState.Resources != 3 {
		t.Errorf("resources = %d, want 3 (4 - 1)", result.NextState.Resources)
	}
}

// TestUnitHealFailsNotAtCore：单位不在 Core 格 → HEAL 失败（NOT_AT_OWN_CORE）。
func TestUnitHealFailsNotAtCore(t *testing.T) {
	state := baseState()
	state.Units[0].Position = domain.Position{3, 3}
	state.Workers[0].Position = domain.Position{3, 3}
	state.Resources = 4
	plan := &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{
		"worker-1": {Kind: domain.ActionHeal},
	}}

	result := NewEngine().Settle(state, plan)
	if result.Stats.HPRecovered != 0 {
		t.Errorf("hpRecovered = %d, want 0", result.Stats.HPRecovered)
	}
	found := false
	for _, event := range result.Events {
		if event.EventType == "UNIT_HEAL_FAILED" && event.ReasonCode != nil && *event.ReasonCode == "NOT_AT_OWN_CORE" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected UNIT_HEAL_FAILED NOT_AT_OWN_CORE, got %+v", result.Events)
	}
}
