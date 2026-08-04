package domain

import "testing"

func TestPhaseMachineInitialPhase(t *testing.T) {
	machine := NewPhaseMachine(PhaseConfig{})
	if got := machine.Phase(); got != PhaseEarlyExpansion {
		t.Errorf("initial phase = %q, want early_expansion", got)
	}
	if got := machine.Update(PhaseInput{Population: 1, Resources: 0}); got != PhaseEarlyExpansion {
		t.Errorf("early input phase = %q, want early_expansion", got)
	}
}

func TestPhaseMachineEarlyToBalancedToMilitary(t *testing.T) {
	machine := NewPhaseMachine(DefaultPhaseConfig)
	if got := machine.Update(PhaseInput{Population: 5, Resources: 20}); got != PhaseBalanced {
		t.Errorf("phase = %q, want balanced", got)
	}
	if got := machine.Update(PhaseInput{Population: 18, Resources: 20}); got != PhaseMilitary {
		t.Errorf("phase = %q, want military (population threshold)", got)
	}
}

func TestPhaseMachineBalancedThresholds(t *testing.T) {
	machine := NewPhaseMachine(DefaultPhaseConfig)
	// 人口达标但资源不足 → 仍 early。
	if got := machine.Update(PhaseInput{Population: 5, Resources: 19}); got != PhaseEarlyExpansion {
		t.Errorf("phase = %q, want early_expansion (resources below threshold)", got)
	}
	// 资源达标但人口不足 → 仍 early。
	if got := machine.Update(PhaseInput{Population: 4, Resources: 30}); got != PhaseEarlyExpansion {
		t.Errorf("phase = %q, want early_expansion (population below threshold)", got)
	}
}

func TestPhaseMachineMilitaryByThreat(t *testing.T) {
	machine := NewPhaseMachine(DefaultPhaseConfig)
	if got := machine.Update(PhaseInput{Population: 3, Resources: 1, EnemyNearCore: 2}); got != PhaseMilitary {
		t.Errorf("phase = %q, want military (enemy threat)", got)
	}
	if got := machine.Update(PhaseInput{Population: 3, Resources: 1, EnemyNearCore: 1}); got != PhaseEarlyExpansion {
		t.Errorf("phase = %q, want early_expansion (threat below threshold)", got)
	}
}

func TestPhaseMachineNotMonotonic(t *testing.T) {
	// TS 语义：military 不是粘滞的——压力下降可回到 balanced/early。
	machine := NewPhaseMachine(DefaultPhaseConfig)
	machine.Update(PhaseInput{Population: 20, Resources: 0})
	if got := machine.Phase(); got != PhaseMilitary {
		t.Fatalf("phase = %q, want military", got)
	}
	if got := machine.Update(PhaseInput{Population: 4, Resources: 1, EnemyNearCore: 0}); got != PhaseEarlyExpansion {
		t.Errorf("phase = %q, want early_expansion after pressure drop", got)
	}
}

func TestPhaseMachineForce(t *testing.T) {
	machine := NewPhaseMachine(DefaultPhaseConfig)
	military := PhaseMilitary
	machine.Force(&military)
	if got := machine.Phase(); got != PhaseMilitary {
		t.Fatalf("forced phase = %q, want military", got)
	}
	// 强制期间 update 不改变输出。
	if got := machine.Update(PhaseInput{Population: 1, Resources: 0}); got != PhaseMilitary {
		t.Errorf("forced update = %q, want military", got)
	}
	// 解除强制 → 恢复自动演进。
	machine.Force(nil)
	if got := machine.Update(PhaseInput{Population: 5, Resources: 20}); got != PhaseBalanced {
		t.Errorf("unforced update = %q, want balanced", got)
	}
}

func TestPhaseMachineCustomConfig(t *testing.T) {
	config := PhaseConfig{
		MilitaryPopulation: 6,
		ThreatEnemyNear:    1,
		BalancedPopulation: 3,
		BalancedResources:  10,
	}
	machine := NewPhaseMachine(config)
	if got := machine.Update(PhaseInput{Population: 3, Resources: 10}); got != PhaseBalanced {
		t.Errorf("phase = %q, want balanced (custom thresholds)", got)
	}
	if got := machine.Update(PhaseInput{Population: 6, Resources: 0}); got != PhaseMilitary {
		t.Errorf("phase = %q, want military (custom population)", got)
	}
	if got := machine.Update(PhaseInput{Population: 2, Resources: 1, EnemyNearCore: 1}); got != PhaseMilitary {
		t.Errorf("phase = %q, want military (custom threat)", got)
	}
}
