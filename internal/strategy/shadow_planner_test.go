// F3 验收：shadow 双跑对比逻辑单测（mock 注入反向验证——对比器
// 真的会报警）。真实 cdylib 集成在 cmd/simshadow/main_test.go
// （同包测试不能导入 internal/sim，避免 import cycle）。

package strategy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

func dirPtr(direction domain.Direction) *domain.Direction   { return &direction }
func unitTypePtr(unitType domain.UnitType) *domain.UnitType { return &unitType }

// 相同语义、map 顺序不同的两份计划 → match=true、diff 为空。
func TestShadowCompareMatch(t *testing.T) {
	workerType := domain.UnitWorker
	goPlan := &domain.Plan{
		Tick: 7,
		UnitActions: map[string]domain.UnitAction{
			"w1": {Kind: domain.ActionMove, Direction: dirPtr(domain.DirectionUp)},
			"w2": {Kind: domain.ActionHarvest},
		},
		CoreAction: &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &workerType},
		Intents:    map[string]string{"w1": "patrol", "w2": "to_resource", "core": "spawn"},
	}
	rustPlan := &domain.Plan{
		Tick: 7,
		UnitActions: map[string]domain.UnitAction{
			"w2": {Kind: domain.ActionHarvest},
			"w1": {Kind: domain.ActionMove, Direction: dirPtr(domain.DirectionUp)},
		},
		CoreAction: &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &workerType},
		Intents:    map[string]string{"core": "spawn", "w1": "patrol", "w2": "to_resource"},
	}

	matched, diff := comparePlans(goPlan, rustPlan)
	if !matched {
		t.Fatalf("expected match, diff=%v", diff)
	}
	if len(diff) != 0 {
		t.Fatalf("expected empty diff, got %v", diff)
	}
}

// 各类差异（单位动作 Kind/Direction/TargetID、core 存在性、intents）
// → match=false 且 diff 非空、逐项可读。
func TestShadowCompareDiverges(t *testing.T) {
	workerType := domain.UnitWorker
	goPlan := &domain.Plan{
		Tick: 3,
		UnitActions: map[string]domain.UnitAction{
			"w1": {Kind: domain.ActionMove, Direction: dirPtr(domain.DirectionUp)},
			"w2": {Kind: domain.ActionHarvest},
		},
		CoreAction: &domain.CoreAction{Kind: domain.CoreSpawn, UnitType: &workerType},
		Intents:    map[string]string{"w1": "patrol", "w2": "to_resource", "core": "spawn"},
	}
	rustPlan := &domain.Plan{
		Tick: 3,
		UnitActions: map[string]domain.UnitAction{
			"w1": {Kind: domain.ActionWait},
			"w2": {Kind: domain.ActionMove, Direction: dirPtr(domain.DirectionRight)},
			"w3": {Kind: domain.ActionMove, Direction: dirPtr(domain.DirectionDown)},
		},
		CoreAction: &domain.CoreAction{Kind: domain.CoreHeal},
		Intents:    map[string]string{"w1": "capacity_wait", "w2": "patrol", "core": "heal"},
	}

	matched, diff := comparePlans(goPlan, rustPlan)
	if matched {
		t.Fatal("expected divergence")
	}
	if len(diff) == 0 {
		t.Fatal("expected non-empty diff")
	}
	joined := strings.Join(diff, "\n")
	for _, want := range []string{
		"unit w1: kind go=MOVE rust=WAIT",
		"unit w2: direction go=<nil> rust=RIGHT",
		"unit w3: go=absent rust=present",
		"core: kind go=SPAWN rust=HEAL",
		"intent w1: go=patrol rust=capacity_wait",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("diff missing %q:\n%s", want, joined)
		}
	}
}

// 反向验证：mock rust planner 返回不同动作 → Decide 返回 goPlan、
// match=false、diff 非空、decision.jsonl 落盘报警、统计正确。
func TestShadowPlannerDetectsDivergence(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "decision.jsonl")
	shadow := newShadowPlanner(
		NewPlanner(DefaultConfig()),
		&mutatingRustMock{planner: NewPlanner(DefaultConfig())},
		logPath,
		testLogger(),
	)
	defer shadow.Close()

	// testState 起点：worker-full 满载站 Core（无仓库空间）→ Go planner
	// 确定性给 MOVE（满仓破锁让位）；mock 把 worker-full 翻成 WAIT。
	state := testState()
	state.Tick = 1
	plan := shadow.Decide(state)

	stats := shadow.Stats()
	if stats.MatchCount != 0 || stats.DivergenceCount != 1 {
		t.Fatalf("expected 1 divergence, got %+v", stats)
	}
	if stats.FirstDivergenceTick != 1 {
		t.Fatalf("expected first divergence at tick 1, got %d", stats.FirstDivergenceTick)
	}
	if plan.UnitActions["worker-full"].Kind != domain.ActionMove {
		t.Fatalf("Decide must return the go plan (worker-full MOVE), got %+v", plan.UnitActions["worker-full"])
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read decision log: %v", err)
	}
	line := string(data)
	for _, want := range []string{`"tick":1`, `"match":false`, `"diff":["unit worker-full: kind go=MOVE rust=WAIT"`} {
		if !strings.Contains(line, want) {
			t.Errorf("decision.jsonl missing %q:\n%s", want, line)
		}
	}
}

// mutatingRustMock 是确定性 mock rust planner：内部真实 planner 决策后
// 把 worker-full 的动作翻成 WAIT（制造一个真实计划上的单点差异）。
type mutatingRustMock struct {
	planner *Planner
}

func (m *mutatingRustMock) Decide(state *domain.TickState) *domain.Plan {
	plan := m.planner.Decide(state)
	mutated := *plan
	unitActions := make(map[string]domain.UnitAction, len(plan.UnitActions))
	for id, action := range plan.UnitActions {
		if id == "worker-full" {
			action = domain.UnitAction{Kind: domain.ActionWait}
		}
		unitActions[id] = action
	}
	mutated.UnitActions = unitActions
	return &mutated
}

func (m *mutatingRustMock) ApplyDirective(directive Directive) { m.planner.ApplyDirective(directive) }
func (m *mutatingRustMock) Close()                             {}
