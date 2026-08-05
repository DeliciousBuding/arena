// simgolden：回归黄金集（模拟器平台化 P2）——固定场景 × 默认策略
// 快照关键指标，--check 模式比对容差（CI 门禁防策略回归）。
// 用法：
//
//	simgolden --update   // 跑 3 场景 × 默认策略，写 runtime/golden.json
//	simgolden --check    // 跑并比对，超容差 → exit 1
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// goldenSnapshot 是单场景快照（关键指标，防回归）。
type goldenSnapshot struct {
	Scene     string `json:"scene"`
	Deposits  int    `json:"deposits"`
	Spawns    int    `json:"spawns"`
	Workers   int    `json:"workers"`
	Kills     int    `json:"kills"`
	UnitsLost int    `json:"unitsLost"`
	Blocked   int    `json:"blocked"`
	Moves     int    `json:"moves"`
	Resources int    `json:"resources"`
}

// goldenFile 是黄金集文件。
type goldenFile struct {
	Ticks    int              `json:"ticks"`
	Policies []string         `json:"policies"`
	Scenes   []goldenSnapshot `json:"scenes"`
}

// 容差配置：Deposits 是核心经济指标（宽松 25% 防噪音），
// UnitsLost 是危险指标（硬性：超过基线 +1 即 FAIL——单位损失是
// 死循环/战斗回归的强信号）。
const (
	depositsTolerance     = 0.25
	spawnsTolerance       = 0.25
	workersTolerance      = 0.20
	killsTolerance        = 0.50
	blockedRatioTolerance = 0.30
	unitsLostHardLimit    = 1 // 允许的额外单位损失（超过 = FAIL）
)

const goldenPath = "runtime/golden.json"

// sceneFile 复用 simrun 的场景 JSON 加载。
type sceneFile struct {
	Name            string            `json:"name"`
	Initial         *tickStateJSON    `json:"initial"`
	LatentResources []domain.Position `json:"latentResources"`
}

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
	update := flag.Bool("update", false, "update golden file")
	ticks := flag.Int("ticks", 500, "simulation ticks")
	workers := flag.Int("workers", 8, "parallel workers")
	flag.Parse()

	scenes, err := loadScenes("runtime/scenes/*.json")
	if err != nil {
		fmt.Fprintf(os.Stderr, "load scenes: %v\n", err)
		os.Exit(1)
	}
	policy := strategy.DefaultConfig()
	policy.Name = "default"

	results := sim.Batch(scenes, []*strategy.Config{&policy}, *ticks, sim.BatchOption{Workers: *workers})

	if *update {
		snapshots := makeSnapshots(results)
		file := goldenFile{Ticks: *ticks, Policies: []string{"default"}, Scenes: snapshots}
		data, err := json.MarshalIndent(file, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "marshal golden: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(goldenPath, data, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write golden: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("golden updated: %s (%d scenes × %d ticks)\n", goldenPath, len(snapshots), *ticks)
		return
	}

	// 默认 --check。
	data, err := os.ReadFile(goldenPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read golden: %v (run simgolden --update first)\n", err)
		os.Exit(1)
	}
	var golden goldenFile
	if err := json.Unmarshal(data, &golden); err != nil {
		fmt.Fprintf(os.Stderr, "parse golden: %v\n", err)
		os.Exit(1)
	}
	if golden.Ticks != *ticks {
		fmt.Fprintf(os.Stderr, "golden ticks=%d, run ticks=%d (re-run --update)\n", golden.Ticks, *ticks)
		os.Exit(1)
	}
	exitCode := compareSnapshots(golden.Scenes, makeSnapshots(results))
	os.Exit(exitCode)
}

// makeSnapshots 从 Batch 结果构建快照（确定性：scene 名升序）。
func makeSnapshots(results []sim.BatchResult) []goldenSnapshot {
	snapshots := make([]goldenSnapshot, 0, len(results))
	for _, result := range results {
		snapshots = append(snapshots, goldenSnapshot{
			Scene:     result.Scene,
			Deposits:  result.Stats.Deposits,
			Spawns:    result.Stats.Spawns,
			Workers:   len(result.Final.Workers),
			Kills:     result.Stats.Kills,
			UnitsLost: result.Stats.UnitsLost,
			Blocked:   result.Stats.Blocked,
			Moves:     result.Stats.Moves,
			Resources: result.Final.Resources,
		})
	}
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].Scene < snapshots[j].Scene })
	return snapshots
}

// compareSnapshots 比对黄金集，超容差打印并返回 exit code。
func compareSnapshots(golden, current []goldenSnapshot) int {
	if len(golden) != len(current) {
		fmt.Printf("FAIL: scene count changed: golden=%d current=%d\n", len(golden), len(current))
		return 1
	}
	failures := 0
	for i := range golden {
		g, c := golden[i], current[i]
		if g.Scene != c.Scene {
			fmt.Printf("FAIL: scene order changed: golden=%s current=%s\n", g.Scene, c.Scene)
			return 1
		}
		// Deposits：核心经济指标，容差内允许浮动。
		if !withinTolerance(g.Deposits, c.Deposits, depositsTolerance) {
			fmt.Printf("FAIL [%s]: deposits %d → %d (tolerance %.0f%%)\n", g.Scene, g.Deposits, c.Deposits, depositsTolerance*100)
			failures++
		}
		if !withinTolerance(g.Spawns, c.Spawns, spawnsTolerance) {
			fmt.Printf("FAIL [%s]: spawns %d → %d (tolerance %.0f%%)\n", g.Scene, g.Spawns, c.Spawns, spawnsTolerance*100)
			failures++
		}
		if !withinTolerance(g.Workers, c.Workers, workersTolerance) {
			fmt.Printf("FAIL [%s]: workers %d → %d (tolerance %.0f%%)\n", g.Scene, g.Workers, c.Workers, workersTolerance*100)
			failures++
		}
		if !withinTolerance(g.Kills, c.Kills, killsTolerance) {
			fmt.Printf("FAIL [%s]: kills %d → %d (tolerance %.0f%%)\n", g.Scene, g.Kills, c.Kills, killsTolerance*100)
			failures++
		}
		// UnitsLost：硬性（超过基线 +1 = FAIL，死循环/战斗回归强信号）。
		if c.UnitsLost > g.UnitsLost+unitsLostHardLimit {
			fmt.Printf("FAIL [%s]: unitsLost %d → %d (hard limit +%d)\n", g.Scene, g.UnitsLost, c.UnitsLost, unitsLostHardLimit)
			failures++
		}
		// Blocked/Moves 比例：死循环代理（blocked 占比暴涨 = 拥堵回归）。
		gRatio, cRatio := blockedRatio(g.Blocked, g.Moves), blockedRatio(c.Blocked, c.Moves)
		if gRatio > 0 && cRatio > gRatio*(1+blockedRatioTolerance) {
			fmt.Printf("FAIL [%s]: blocked ratio %.2f → %.2f (tolerance %.0f%%)\n", g.Scene, gRatio, cRatio, blockedRatioTolerance*100)
			failures++
		}
		if c.UnitsLost > g.UnitsLost {
			fmt.Printf("WARN [%s]: unitsLost %d → %d (within hard limit)\n", g.Scene, g.UnitsLost, c.UnitsLost)
		}
	}
	if failures == 0 {
		fmt.Printf("PASS: %d scenes within tolerance\n", len(golden))
		return 0
	}
	return 1
}

// withinTolerance：|a-b| <= tolerance*max(1,a)。
func withinTolerance(a, b int, tolerance float64) bool {
	return math.Abs(float64(a-b)) <= tolerance*float64(max(1, a))
}

// blockedRatio：blocked/moves（moves=0 时返回 0）。
func blockedRatio(blocked, moves int) float64 {
	if moves == 0 {
		return 0
	}
	return float64(blocked) / float64(moves)
}

// loadScenes 从 glob 加载场景（确定性：文件名排序）。
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
