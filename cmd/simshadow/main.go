// simshadow：shadow 双跑验证 CLI（fusion-line.md §3 F3）——同一 tick
// 流上 Go planner 与 Rust planner（FFI 决策内核）并行决策、逐 tick
// 对比，产出 decision.jsonl 差分报告 + stdout 汇总。
//
// 用法：
//
//	ARENA_SIM_FFI_DLL=sim-rs/target/release/arena_sim_ffi.dll \
//	  go run ./cmd/simshadow --scene 'runtime/scenes/*.json' --ticks 50
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// sceneFile 是场景 JSON 格式（与 cmd/simrun/main.go 一致）。
// ResourceCells/ObstacleCells 在 JSON 中是字符串数组（人类可读），
// 经 tickStateJSON 反序列化。
type sceneFile struct {
	Name            string            `json:"name"`
	Initial         *tickStateJSON    `json:"initial"`
	LatentResources []domain.Position `json:"latentResources"`
}

// tickStateJSON 是 TickState 的 JSON 镜像：集合字段用数组表达。
type tickStateJSON struct {
	Tick             int                   `json:"tick"`
	Status           string                `json:"status"`
	Resources        int                   `json:"resources"`
	ResourceCapacity int                   `json:"resourceCapacity"`
	ResourceSpace    int                   `json:"resourceSpace"`
	Population       int                   `json:"population"`
	Core             *domain.Core          `json:"core"`
	Units            []domain.UnitSnapshot `json:"units"`
	Workers          []domain.UnitSnapshot `json:"workers"`
	Vanguards        []domain.UnitSnapshot `json:"vanguards"`
	Rangers          []domain.UnitSnapshot `json:"rangers"`
	ResourceCells    []string              `json:"resourceCells"`
	ObstacleCells    []string              `json:"obstacleCells"`
	Beacon           domain.Beacon         `json:"beacon"`
}

// toTickState 转换 JSON 镜像为 domain.TickState。
func (t *tickStateJSON) toTickState() *domain.TickState {
	return &domain.TickState{
		Tick:             t.Tick,
		Status:           domain.PlayerStatus(t.Status),
		Resources:        t.Resources,
		ResourceCapacity: t.ResourceCapacity,
		ResourceSpace:    t.ResourceSpace,
		Population:       t.Population,
		Core:             t.Core,
		Units:            t.Units,
		Workers:          t.Workers,
		Vanguards:        t.Vanguards,
		Rangers:          t.Rangers,
		ResourceCells:    domain.NewSet(t.ResourceCells...),
		ObstacleCells:    domain.NewSet(t.ObstacleCells...),
		Beacon:           t.Beacon,
	}
}

func main() {
	sceneGlob := flag.String("scene", "runtime/scenes/*.json", "scene JSON glob")
	ticks := flag.Int("ticks", 100, "ticks per scene")
	outDir := flag.String("out", "runtime/shadow/", "decision.jsonl output directory")
	flag.Parse()

	dllPath := os.Getenv("ARENA_SIM_FFI_DLL")
	if dllPath == "" {
		fmt.Fprintln(os.Stderr, "simshadow: ARENA_SIM_FFI_DLL not set")
		fmt.Fprintln(os.Stderr, "  set it to the arena-sim-ffi shared library, e.g.:")
		fmt.Fprintln(os.Stderr, "  ARENA_SIM_FFI_DLL=sim-rs/target/release/arena_sim_ffi.dll go run ./cmd/simshadow --scene 'runtime/scenes/*.json' --ticks 50")
		os.Exit(1)
	}
	if *ticks < 1 {
		fmt.Fprintf(os.Stderr, "simshadow: --ticks must be >= 1 (got %d)\n", *ticks)
		os.Exit(1)
	}

	scenes, err := loadScenes(*sceneGlob)
	if err != nil {
		fmt.Fprintf(os.Stderr, "simshadow: load scenes: %v\n", err)
		os.Exit(1)
	}
	if len(scenes) == 0 {
		fmt.Fprintf(os.Stderr, "simshadow: no scenes matched %q\n", *sceneGlob)
		os.Exit(1)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "simshadow: create out dir: %v\n", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	totalTicks, totalMatched, totalDiverged := 0, 0, 0
	overallFirstDivergence := 0
	for _, scene := range scenes {
		stats := runShadowScene(scene, *ticks, dllPath, *outDir, logger)
		totalTicks += *ticks
		totalMatched += stats.MatchCount
		totalDiverged += stats.DivergenceCount
		if stats.FirstDivergenceTick > 0 &&
			(overallFirstDivergence == 0 || stats.FirstDivergenceTick < overallFirstDivergence) {
			overallFirstDivergence = stats.FirstDivergenceTick
		}
		fmt.Printf("shadow: %s %d ticks: matched=%d diverged=%d first_divergence=%s\n",
			scene.Name, *ticks, stats.MatchCount, stats.DivergenceCount, tickOrDash(stats.FirstDivergenceTick))
	}
	fmt.Printf("shadow: total %d scenes %d ticks: matched=%d diverged=%d first_divergence=%s\n",
		len(scenes), totalTicks, totalMatched, totalDiverged, tickOrDash(overallFirstDivergence))
}

// runShadowScene 单场景 shadow 双跑：初始化 → 每 tick 双决策对比 +
// 结算闭环推进（Go 计划结算，Rust 计划仅观察）→ 统计。
func runShadowScene(scene *sim.Scenario, ticks int, dllPath, outDir string, logger *slog.Logger) strategy.ShadowStats {
	state := scene.CloneState()
	config := strategy.DefaultConfig()
	goPlanner := strategy.NewPlanner(config)
	rustPlanner := strategy.NewFfiPlanner(config, dllPath, logger)
	shadow := strategy.NewShadowPlanner(goPlanner, rustPlanner, filepath.Join(outDir, scene.Name+"-decision.jsonl"), logger)
	defer shadow.Close()

	engine := sim.NewEngine()
	engine.Refill = sim.NewRefillConfig(scene.LatentResources)

	for tick := 1; tick <= ticks; tick++ {
		state.Tick = tick
		plan := shadow.Decide(state)
		engine.SettleInPlace(state, plan)
	}
	return shadow.Stats()
}

// tickOrDash 渲染首差异 tick（0 = 无差异 → "-"）。
func tickOrDash(tick int) string {
	if tick == 0 {
		return "-"
	}
	return fmt.Sprintf("%d", tick)
}

// loadScenes 从 glob 加载场景文件（确定性：文件名排序；与
// cmd/simrun/main.go 同构）。
func loadScenes(glob string) ([]*sim.Scenario, error) {
	paths, err := filepath.Glob(glob)
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	scenes := make([]*sim.Scenario, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var file sceneFile
		if err := json.Unmarshal(data, &file); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		name := file.Name
		if name == "" {
			name = strings.TrimSuffix(filepath.Base(path), ".json")
		}
		if file.Initial == nil {
			return nil, fmt.Errorf("%s: initial state missing", path)
		}
		scenes = append(scenes, &sim.Scenario{
			Name:            name,
			Initial:         file.Initial.toTickState(),
			LatentResources: file.LatentResources,
		})
	}
	return scenes, nil
}
