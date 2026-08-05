// simrun：独立模拟器 CLI（模拟器平台化）——不依赖 game 包，
// 从场景 JSON 加载初始状态 + 潜在资源池，批量并发评估策略，
// 输出统计/时间线/对比。
// 用法：
//
//	simrun --scene scenes/dense.json --ticks 500
//	simrun --scene scenes/*.json --policy wt6.json --workers 8
//	simrun --race --scenes scenes/*.json --policies policies/*.json
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// sceneFile 是场景 JSON 格式（P1 固化）。ResourceCells/ObstacleCells
// 在 JSON 中是字符串数组（人类可读），经 tickStateJSON 反序列化。
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

// policyFile 是策略 JSON 格式（strategy.Config 超集，可省略字段用默认）。
type policyFile struct {
	Name              string `json:"name"`
	WorkerTarget      *int   `json:"workerTarget"`
	PopulationCeiling *int   `json:"populationCeiling"`
	ExploreRadius     *int   `json:"exploreRadius"`
	ThreatDistance    *int   `json:"threatDistance"`
	SpawnReserve      *int   `json:"spawnReserve"`
	MilitaryRatio     *int   `json:"militaryRatio"`
}

func main() {
	sceneGlob := flag.String("scene", "", "scene JSON path or glob (repeatable)")
	policyGlob := flag.String("policy", "", "policy JSON path or glob")
	race := flag.Bool("race", false, "race mode: 多策略对比表")
	ticks := flag.Int("ticks", 300, "simulation ticks")
	workers := flag.Int("workers", 8, "parallel workers")
	flag.Parse()

	if *sceneGlob == "" {
		fmt.Fprintln(os.Stderr, "usage: simrun --scene <scenes/*.json> [--policy <policies/*.json>] [--ticks N] [--workers N] [--race]")
		os.Exit(2)
	}
	scenes, err := loadScenes(*sceneGlob)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load scenes: %v\n", err)
		os.Exit(1)
	}
	policies, err := loadPolicies(*policyGlob)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load policies: %v\n", err)
		os.Exit(1)
	}
	if len(scenes) == 0 {
		fmt.Fprintln(os.Stderr, "no scenes matched")
		os.Exit(1)
	}
	if len(policies) == 0 {
		fmt.Fprintln(os.Stderr, "no policies matched (default config used)")
		policies = []*strategy.Config{defaultPolicy()}
	}

	results := sim.Batch(scenes, policies, *ticks, sim.BatchOption{Workers: *workers})
	if *race {
		printRace(results)
	} else {
		printSummary(results)
	}
}

// defaultPolicy 是默认策略（DefaultConfig）。
func defaultPolicy() *strategy.Config {
	config := strategy.DefaultConfig()
	return &config
}

// loadScenes 从 glob 加载场景文件（确定性：文件名排序）。
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

// loadPolicies 从 glob 加载策略文件（确定性：文件名排序）。
func loadPolicies(glob string) ([]*strategy.Config, error) {
	if glob == "" {
		return nil, nil
	}
	paths, err := filepath.Glob(glob)
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	policies := make([]*strategy.Config, 0, len(paths))
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var file policyFile
		if err := json.Unmarshal(data, &file); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		config := strategy.DefaultConfig()
		if file.WorkerTarget != nil {
			config.WorkerTarget = *file.WorkerTarget
		}
		if file.PopulationCeiling != nil {
			config.PopulationCeiling = *file.PopulationCeiling
		}
		if file.ExploreRadius != nil {
			config.ExploreRadius = *file.ExploreRadius
		}
		if file.ThreatDistance != nil {
			config.ThreatDistance = *file.ThreatDistance
		}
		if file.SpawnReserve != nil {
			config.SpawnReserve = *file.SpawnReserve
		}
		if file.MilitaryRatio != nil {
			config.MilitaryRatio = *file.MilitaryRatio
		}
		// 策略名：文件 name 字段（无则用文件名）。
		name := file.Name
		if name == "" {
			name = strings.TrimSuffix(filepath.Base(path), ".json")
		}
		config.Name = name
		policies = append(policies, &config)
	}
	return policies, nil
}

// printSummary 输出单策略结果摘要。
func printSummary(results []sim.BatchResult) {
	for _, result := range results {
		fmt.Printf("=== %s / %s (%d ticks) ===\n", result.Scene, result.Policy, result.Ticks)
		fmt.Printf("  workers=%d resources=%d\n", len(result.Final.Workers), result.Final.Resources)
		fmt.Printf("  spawns=%d deposits=%d harvests=%d\n", result.Stats.Spawns, result.Stats.Deposits, result.Stats.Harvests)
		fmt.Printf("  kills=%d unitsLost=%d shots=%d sweeps=%d\n", result.Stats.Kills, result.Stats.UnitsLost, result.Stats.ShotsFired, result.Stats.SweepsFired)
		fmt.Printf("  timeline:\n")
		for _, point := range result.Timeline {
			fmt.Printf("    t%-5d res=%-4d workers=%d kills=%d lost=%d mode=%s\n",
				point.Tick, point.Resources, point.Workers, point.Kills, point.UnitsLost, point.Mode)
		}
	}
}

// printRace 输出多策略赛马对比表（场景×策略，关键指标）。
func printRace(results []sim.BatchResult) {
	fmt.Printf("=== race (%d results) ===\n", len(results))
	fmt.Printf("%-20s %-24s %8s %8s %6s %6s %6s %6s\n",
		"scene", "policy", "workers", "res", "spawns", "deposits", "kills", "lost")
	for _, result := range results {
		fmt.Printf("%-20s %-24s %8d %8d %6d %6d %6d %6d\n",
			result.Scene, result.Policy,
			len(result.Final.Workers), result.Final.Resources,
			result.Stats.Spawns, result.Stats.Deposits,
			result.Stats.Kills, result.Stats.UnitsLost)
	}
}
