package strategy

// F2 验收：FfiPlanner 单测（mock 路径）+ 集成冒烟（真实 cdylib）。
// 集成测试需要 dll：环境变量 ARENA_SIM_FFI_DLL 指向
// sim-rs/target/release/arena_sim_ffi.dll（缺失时跳过）。

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// testState 构造最小决策状态（真实拓扑死锁起点）。
func testState() *domain.TickState {
	return &domain.TickState{
		Tick:             1,
		Status:           domain.PlayerStatusActive,
		Resources:        10,
		ResourceCapacity: 10,
		ResourceSpace:    0,
		Population:       2,
		Core: &domain.Core{
			ID: "core-1", Position: domain.Position{38, 39},
			HP: domain.CoreMaxHP, Shield: domain.CoreMaxShield, State: domain.CoreNormal,
		},
		Units: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{38, 39}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{38, 51}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		Workers: []domain.UnitSnapshot{
			{ID: "worker-full", Position: domain.Position{38, 39}, HP: 2, UnitType: domain.UnitWorker, Cargo: 1},
			{ID: "worker-empty", Position: domain.Position{38, 51}, HP: 2, UnitType: domain.UnitWorker, Cargo: 0},
		},
		ResourceCells: domain.NewSet("38,45"),
		ObstacleCells: domain.NewSet(
			"36,51", "36,52", "37,39", "37,42", "37,44", "38,34",
			"38,43", "38,50", "39,41", "39,44", "39,52", "40,40",
		),
		Beacon: domain.Beacon{Position: domain.Position{-17, 77}, Status: domain.BeaconGround},
	}
}

// 集成冒烟：真实 dll 加载 + 决策 + 指令 + 释放（跨 C ABI 全链路）。
func TestFfiPlannerIntegration(t *testing.T) {
	libPath := os.Getenv("ARENA_SIM_FFI_DLL")
	if libPath == "" {
		t.Skip("ARENA_SIM_FFI_DLL not set (point to sim-rs/target/release/arena_sim_ffi.dll)")
	}
	planner := NewFfiPlanner(DefaultConfig(), libPath, testLogger())
	defer planner.Close()
	if planner.handle == nil {
		t.Fatal("FFI planner failed to initialize (dll loaded but handle nil)")
	}
	state := testState()
	plan := planner.Decide(state)
	if plan == nil {
		t.Fatal("Decide returned nil plan")
	}
	if plan.Tick != 1 {
		t.Fatalf("plan tick = %d, want 1", plan.Tick)
	}
	// 核心动作：满载 worker-full 让位（yield_full_core）或等待。
	fullAction, ok := plan.UnitActions["worker-full"]
	if !ok {
		t.Fatal("worker-full missing from plan")
	}
	if fullAction.Kind != domain.ActionMove && fullAction.Kind != domain.ActionWait {
		t.Fatalf("worker-full action = %s, want MOVE/WAIT", fullAction.Kind)
	}
	// 跨 tick 记忆：连续多次 decide 不崩溃（planner 状态持久）。
	for i := 0; i < 10; i++ {
		state.Tick = i + 2
		if p := planner.Decide(state); p == nil {
			t.Fatal("Decide nil on repeated tick")
		}
	}
	// 指令下发。
	planner.ApplyDirective(Directive{Mode: ModeGrowth, Focus: domain.Position{0, 0}})
}

// 与 Go 原生 planner 的决策一致性（同 state 同输出；语义对齐差分）。
func TestFfiPlannerMatchesGoPlanner(t *testing.T) {
	libPath := os.Getenv("ARENA_SIM_FFI_DLL")
	if libPath == "" {
		t.Skip("ARENA_SIM_FFI_DLL not set")
	}
	ffi := NewFfiPlanner(DefaultConfig(), libPath, testLogger())
	defer ffi.Close()
	if ffi.handle == nil {
		t.Fatal("FFI planner failed to initialize")
	}
	goPlanner := NewPlanner(DefaultConfig())
	state := testState()
	goPlan := goPlanner.Decide(state)
	rustPlan := ffi.Decide(state)
	if goPlan.Tick != rustPlan.Tick {
		t.Fatalf("tick mismatch: go=%d rust=%d", goPlan.Tick, rustPlan.Tick)
	}
	for id, goAction := range goPlan.UnitActions {
		rustAction, ok := rustPlan.UnitActions[id]
		if !ok {
			t.Fatalf("rust plan missing unit %s (go had %s)", id, goAction.Kind)
		}
		if goAction.Kind != rustAction.Kind {
			t.Fatalf("unit %s kind mismatch: go=%s rust=%s", id, goAction.Kind, rustAction.Kind)
		}
	}
	for id, rustAction := range rustPlan.UnitActions {
		if _, ok := goPlan.UnitActions[id]; !ok {
			t.Fatalf("rust plan has extra unit %s (%s)", id, rustAction.Kind)
		}
	}
	// Core 动作一致性。
	if (goPlan.CoreAction == nil) != (rustPlan.CoreAction == nil) {
		t.Fatalf("core action presence mismatch: go=%v rust=%v", goPlan.CoreAction, rustPlan.CoreAction)
	}
}

// fail-safe：dll 不存在 → 自动回退 Go planner，Decide 正常产出。
func TestFfiPlannerFallbackOnMissingLib(t *testing.T) {
	planner := NewFfiPlanner(DefaultConfig(), "definitely-missing-arena-sim-ffi.dll", testLogger())
	defer planner.Close()
	if planner.handle != nil {
		t.Fatal("handle should be nil when dll missing")
	}
	plan := planner.Decide(testState())
	if plan == nil {
		t.Fatal("fallback Decide returned nil")
	}
	if plan.Tick != 1 {
		t.Fatalf("plan tick = %d, want 1", plan.Tick)
	}
}

// JSON 契约：Go state Marshal 形状必须能被 Rust 镜像解析（PascalCase +
// Set 对象形状）。
func TestStateJSONShape(t *testing.T) {
	data, err := json.Marshal(testState())
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"Tick":1`, `"ResourceCells":{"38,45":{}}`, `"UnitType":"WORKER"`, `"ID":"worker-full"`} {
		if !contains(text, want) {
			t.Fatalf("state JSON missing %s: %s", want, text)
		}
	}
}

// 平台实现必须满足 ffiLib 接口（编译期断言）。
var _ ffiLib = (*ffiLibWindows)(nil)

func contains(haystack, needle string) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
