package domain

// GamePhase 是三态阶段（与 TS 版 phase-machine.ts 一致）。
type GamePhase string

const (
	PhaseEarlyExpansion GamePhase = "early_expansion"
	PhaseBalanced       GamePhase = "balanced"
	PhaseMilitary       GamePhase = "military"
)

// PhaseConfig 是阶段机阈值（与 TS 版 PhaseConfig 一致）。
type PhaseConfig struct {
	MilitaryPopulation int
	ThreatEnemyNear    int
	BalancedPopulation int
	BalancedResources  int
}

// DefaultPhaseConfig 是默认阈值（与 TS 版 DEFAULT_PHASE_CONFIG 一致）。
var DefaultPhaseConfig = PhaseConfig{
	MilitaryPopulation: 18,
	ThreatEnemyNear:    2,
	BalancedPopulation: 5,
	BalancedResources:  20,
}

// PhaseInput 是阶段机每 tick 输入（与 TS 版 update 入参一致）。
type PhaseInput struct {
	Population    int
	Resources     int
	EnemyNearCore int
}

// PhaseMachine 是阶段状态机：early_expansion/balanced/military 三态转移，
// 以人口/资源/敌人压力为输入（与 TS 版 phase-machine.ts 同语义）。
type PhaseMachine struct {
	config  PhaseConfig
	current GamePhase
	forced  *GamePhase
}

// NewPhaseMachine 构造阶段机（零值 config 使用默认阈值）。
func NewPhaseMachine(config PhaseConfig) *PhaseMachine {
	if config == (PhaseConfig{}) {
		config = DefaultPhaseConfig
	}
	return &PhaseMachine{config: config, current: PhaseEarlyExpansion}
}

// Phase 返回当前阶段（强制阶段优先，与 TS 版 phase getter 一致）。
func (m *PhaseMachine) Phase() GamePhase {
	if m.forced != nil {
		return *m.forced
	}
	return m.current
}

// Update 按输入更新阶段并返回（强制阶段存在时不变，与 TS 版一致）：
//   - enemyNearCore >= ThreatEnemyNear 或 population >= MilitaryPopulation
//     → military；
//   - 否则 population >= BalancedPopulation 且 resources >=
//     BalancedResources → balanced；
//   - 否则 early_expansion。
func (m *PhaseMachine) Update(input PhaseInput) GamePhase {
	if m.forced != nil {
		return *m.forced
	}
	switch {
	case input.EnemyNearCore >= m.config.ThreatEnemyNear ||
		input.Population >= m.config.MilitaryPopulation:
		m.current = PhaseMilitary
	case input.Population >= m.config.BalancedPopulation &&
		input.Resources >= m.config.BalancedResources:
		m.current = PhaseBalanced
	default:
		m.current = PhaseEarlyExpansion
	}
	return m.current
}

// Force 强制/解除强制阶段（nil 解除，与 TS 版 force 一致）。
func (m *PhaseMachine) Force(phase *GamePhase) {
	m.forced = phase
}
