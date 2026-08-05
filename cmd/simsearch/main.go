// simsearch：大规模策略/死锁搜索（模拟器平台化）。
// 并发跑「随机场景 × 参数网格」全组合，自动检测：
//   - 经济冻结（长时间 0 deposit = 死锁/互堵）
//   - 资源枯竭（工人不增长/不采）
//   - 高频阻塞（blocked/moves 比例异常 = 振荡）
//
// 输出按冻结严重度排序的 TOP 场景+策略，用于发现算法漏洞。
// 用法：
//
//	simsearch --scenes 40 --policies 24 --ticks 300 --workers 28
//	simsearch --scenes 200 --policies 100 --ticks 500 --workers 28
package main

import (
	"flag"
	"fmt"
	"math/rand"
	"sort"
	"strings"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/sim"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// searchResult 是单次搜索评估结果（含冻结诊断）。
type searchResult struct {
	SceneName  string
	PolicyName string
	Ticks      int
	Deposits   int
	Harvests   int
	Workers    int
	Blocked    int
	Moves      int
	Frozen     int // 冻结 tick 数（连续无 deposit 的最长段）
	FrozenAt   int // 冻结起始 tick（0 = 未冻结）
	Starvation int // 资源枯竭（harvests==0）
}

func main() {
	sceneCount := flag.Int("scenes", 40, "random scenes count")
	policyCount := flag.Int("policies", 24, "policy grid count")
	ticks := flag.Int("ticks", 300, "simulation ticks")
	workers := flag.Int("workers", 0, "parallel workers (0 = NumCPU)")
	seed := flag.Int64("seed", 20260805, "deterministic seed")
	inspect := flag.Int("inspect", -1, "print scene details for this index and exit")
	flag.Parse()

	scenes := generateScenes(*sceneCount, *seed)
	policies := generatePolicies(*policyCount, *seed+1)

	if *inspect >= 0 && *inspect < len(scenes) {
		scene := scenes[*inspect]
		fmt.Printf("scene %s: core=(%d,%d) initial workers=%d latent=%d\n",
			scene.Name, scene.Initial.Core.Position[0], scene.Initial.Core.Position[1],
			len(scene.Initial.Workers), len(scene.LatentResources))
		for i, cell := range scene.LatentResources {
			dist := domain.Manhattan(scene.Initial.Core.Position, cell)
			fmt.Printf("  latent[%d]=(%d,%d) manhattan=%d\n", i, cell[0], cell[1], dist)
		}
		return
	}

	fmt.Printf("search: %d scenes × %d policies = %d evals, %d ticks each\n",
		len(scenes), len(policies), len(scenes)*len(policies), *ticks)

	results := sim.Batch(scenes, policies, *ticks, sim.BatchOption{Workers: *workers})

	// 冻结诊断：扫描 Timeline 找最长 0-deposit 段。
	diagnosed := make([]searchResult, 0, len(results))
	for _, result := range results {
		diag := searchResult{
			SceneName:  result.Scene,
			PolicyName: result.Policy,
			Ticks:      result.Ticks,
			Deposits:   result.Stats.Deposits,
			Harvests:   result.Stats.Harvests,
			Workers:    len(result.Final.Workers),
			Blocked:    result.Stats.Blocked,
			Moves:      result.Stats.Moves,
		}
		if result.Stats.Harvests == 0 {
			diag.Starvation = 1
		}
		// 冻结段：用 Timeline 采样（每 25 tick）近似。
		lastDeposit := 0
		prevDeposits := 0
		longest := 0
		frozenAt := 0
		for _, point := range result.Timeline {
			if point.Tick%25 == 0 {
				if point.Deposits == prevDeposits {
					if lastDeposit == 0 {
						lastDeposit = point.Tick
					}
					if point.Tick-lastDeposit > longest {
						longest = point.Tick - lastDeposit
						frozenAt = lastDeposit
					}
				} else {
					lastDeposit = 0
				}
				prevDeposits = point.Deposits
			}
		}
		diag.Frozen = longest
		diag.FrozenAt = frozenAt
		diagnosed = append(diagnosed, diag)
	}

	// 按冻结长度降序（最严重在前）。
	sort.Slice(diagnosed, func(i, j int) bool {
		return diagnosed[i].Frozen > diagnosed[j].Frozen
	})

	// 汇总统计。
	frozenCount := 0
	starvedCount := 0
	healthy := 0
	for _, diag := range diagnosed {
		if diag.Frozen >= *ticks/4 {
			frozenCount++
		}
		if diag.Starvation > 0 {
			starvedCount++
		}
		if diag.Deposits > 0 && diag.Frozen < *ticks/4 {
			healthy++
		}
	}
	fmt.Printf("summary: frozen=%d starved=%d healthy=%d\n", frozenCount, starvedCount, healthy)

	// 输出 TOP 冻结（前 20）。
	fmt.Printf("\n=== top frozen (deposits stuck >= %d ticks) ===\n", *ticks/4)
	fmt.Printf("%-24s %-16s %6s %6s %6s %6s %6s %6s %6s\n",
		"scene", "policy", "dep", "harv", "work", "block", "moves", "frozen", "at")
	shown := 0
	for _, diag := range diagnosed {
		if diag.Frozen < *ticks/4 {
			continue
		}
		if shown >= 20 {
			break
		}
		shown++
		fmt.Printf("%-24s %-16s %6d %6d %6d %6d %6d %6d %6d\n",
			diag.SceneName, diag.PolicyName, diag.Deposits, diag.Harvests,
			diag.Workers, diag.Blocked, diag.Moves, diag.Frozen, diag.FrozenAt)
	}
	if shown == 0 {
		fmt.Println("  (none — no deadlocks found)")
	}

	// 输出健康 TOP（deposits 最高，前 10）。
	sort.Slice(diagnosed, func(i, j int) bool {
		return diagnosed[i].Deposits > diagnosed[j].Deposits
	})
	fmt.Printf("\n=== top economy (highest deposits) ===\n")
	fmt.Printf("%-24s %-16s %6s %6s %6s %6s\n",
		"scene", "policy", "dep", "harv", "work", "block")
	for i := 0; i < 10 && i < len(diagnosed); i++ {
		diag := diagnosed[i]
		fmt.Printf("%-24s %-16s %6d %6d %6d %6d\n",
			diag.SceneName, diag.PolicyName, diag.Deposits, diag.Harvests, diag.Workers, diag.Blocked)
	}
}

// generateScenes 生成确定性随机场景：Core 在原点附近，资源池随机散布
// （chunk 配额语义：密度/距离可变——覆盖 dense 近程与 sparse 远程）。
func generateScenes(count int, seed int64) []*sim.Scenario {
	rng := rand.New(rand.NewSource(seed))
	scenes := make([]*sim.Scenario, 0, count)
	for i := 0; i < count; i++ {
		core := domain.Position{rng.Intn(21) - 10, rng.Intn(21) - 10}
		workerCount := 1 + rng.Intn(2) // 1-2 初始 worker
		latentCount := 2 + rng.Intn(10)
		latent := make([]domain.Position, 0, latentCount)
		for j := 0; j < latentCount; j++ {
			// 距离混合：40% 近程（Core 周围 8 内）、60% 远程（8-30）。
			if rng.Intn(100) < 40 {
				latent = append(latent, domain.Position{
					core[0] + rng.Intn(17) - 8,
					core[1] + rng.Intn(17) - 8,
				})
			} else {
				latent = append(latent, domain.Position{
					core[0] + rng.Intn(61) - 30,
					core[1] + rng.Intn(61) - 30,
				})
			}
		}
		state := &domain.TickState{
			Tick: 1, Status: domain.PlayerStatusActive,
			Resources: 10, ResourceCapacity: 10, ResourceSpace: 0, Population: workerCount,
			Core:          &domain.Core{ID: "core-1", Position: core, HP: domain.CoreMaxHP, Shield: domain.CoreMaxShield, State: domain.CoreNormal},
			ResourceCells: domain.NewSet[string](),
			ObstacleCells: domain.NewSet[string](),
			Beacon:        domain.Beacon{},
		}
		workers := make([]domain.UnitSnapshot, 0, workerCount)
		for w := 0; w < workerCount; w++ {
			position := core
			if w > 0 {
				position = domain.Position{core[0] + rng.Intn(9) - 4, core[1] + rng.Intn(9) - 4}
			}
			workers = append(workers, domain.UnitSnapshot{
				ID: fmt.Sprintf("w-%d", w), Position: position, HP: 2, UnitType: domain.UnitWorker, Cargo: 0,
			})
		}
		state.Units = workers
		state.Workers = workers
		scenes = append(scenes, &sim.Scenario{
			Name:            fmt.Sprintf("rand-%02d", i),
			Initial:         state,
			LatentResources: latent,
		})
	}
	return scenes
}

// generatePolicies 生成参数网格：workerTarget × exploreRadius × reserve
// 组合（覆盖激进/稳健/保守三档）。
func generatePolicies(count int, seed int64) []*strategy.Config {
	rng := rand.New(rand.NewSource(seed))
	workerTargets := []int{4, 6, 8, 10, 13, 16}
	exploreRadii := []int{8, 12, 17, 24}
	reserves := []int{0, 1, 2, 3}
	policies := make([]*strategy.Config, 0, count)
	for i := 0; i < count; i++ {
		config := strategy.DefaultConfig()
		config.WorkerTarget = workerTargets[rng.Intn(len(workerTargets))]
		config.ExploreRadius = exploreRadii[rng.Intn(len(exploreRadii))]
		config.SpawnReserve = reserves[rng.Intn(len(reserves))]
		config.PopulationCeiling = config.WorkerTarget + 3
		config.MilitaryRatio = []int{0, 25, 50}[rng.Intn(3)]
		config.Name = fmt.Sprintf("wt%d-er%d-r%d-m%d",
			config.WorkerTarget, config.ExploreRadius, config.SpawnReserve, config.MilitaryRatio)
		policies = append(policies, &config)
	}
	// 排序保证确定性顺序（Batch 结果排序也依赖名字）。
	sort.Slice(policies, func(i, j int) bool {
		return strings.Compare(policies[i].Name, policies[j].Name) < 0
	})
	return policies
}
