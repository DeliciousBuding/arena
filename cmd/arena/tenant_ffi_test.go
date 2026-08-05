package main

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/deliciousbuding/arena/internal/runtime"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// 编译期断言：FfiPlanner 满足 runtime.Planner（tenant 接线依赖此契约）。
var _ runtime.Planner = (*strategy.FfiPlanner)(nil)

func TestResolveFfiLibPathDefault(t *testing.T) {
	t.Setenv(ffiLibEnvVar, "")
	got := resolveFfiLibPath("t1", "runtime")
	want := filepath.Join("runtime", "t1", "arena-sim-ffi.dll")
	if got != want {
		t.Fatalf("resolveFfiLibPath() = %q, want %q", got, want)
	}
}

func TestResolveFfiLibPathEnvOverride(t *testing.T) {
	override := "C:/libs/arena_sim_ffi.dll"
	t.Setenv(ffiLibEnvVar, override)
	if got := resolveFfiLibPath("t1", "runtime"); got != override {
		t.Fatalf("resolveFfiLibPath() = %q, want env override %q", got, override)
	}
}

func TestNewFfiPlannerMissingLibFallsBackSafely(t *testing.T) {
	// dll 缺失：NewFfiPlanner 不得报错/panic，类型保持 *strategy.FfiPlanner
	//（Decide 时自动回退 Go 原生 planner）；Close 对空句柄/库为 no-op。
	missingLib := filepath.Join(t.TempDir(), "arena-sim-ffi.dll")
	planner := strategy.NewFfiPlanner(strategy.DefaultConfig(), missingLib, testLogger())
	var _ runtime.Planner = planner // 接口满足性（编译期）
	// Close 对空句柄/库为 no-op（释放路径安全）。
	planner.Close()
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
