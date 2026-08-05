// F3 集成验收：真实 cdylib + 真实引擎闭环的 shadow 双跑
// （ARENA_SIM_FFI_DLL 缺失时跳过）。同包测试不能放
// internal/strategy（import cycle：sim → strategy），故在此。
package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
)

func shadowTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, nil))
}

// shadowTestState 构造最小决策状态（与 internal/strategy 测试同构）。
func shadowTestState() *domain.TickState {
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

// 真实 dll 双跑：同一 tick 流 Go/Rust 决策全程一致（match=true），
// decision.jsonl 逐 tick 落盘、行数 = ticks。长程 divergence 即本
// 测试失败——这是 F3 验收产物（diff 报告），不许改 planner 代码。
func TestShadowRunnerIntegration(t *testing.T) {
	libPath := os.Getenv("ARENA_SIM_FFI_DLL")
	if libPath == "" {
		t.Skip("ARENA_SIM_FFI_DLL not set (point to sim-rs/target/release/arena_sim_ffi.dll)")
	}

	const ticks = 50
	scene := &sim.Scenario{
		Name:            "integration",
		Initial:         shadowTestState(),
		LatentResources: []domain.Position{{38, 45}, {38, 51}},
	}
	outDir := t.TempDir()

	stats := runShadowScene(scene, ticks, libPath, outDir, shadowTestLogger())

	if stats.MatchCount != ticks {
		t.Fatalf("expected %d matched ticks, got matched=%d diverged=%d first_divergence=%d",
			ticks, stats.MatchCount, stats.DivergenceCount, stats.FirstDivergenceTick)
	}
	if stats.DivergenceCount != 0 {
		t.Fatalf("unexpected divergence: matched=%d diverged=%d first_divergence=%d",
			stats.MatchCount, stats.DivergenceCount, stats.FirstDivergenceTick)
	}

	data, err := os.ReadFile(filepath.Join(outDir, "integration-decision.jsonl"))
	if err != nil {
		t.Fatalf("read decision.jsonl: %v", err)
	}
	if lines := strings.Count(string(data), "\n"); lines != ticks {
		t.Fatalf("expected %d decision.jsonl lines, got %d", ticks, lines)
	}
}
