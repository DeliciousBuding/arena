package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// testScenes 构造两个独立场景（dense/sparse）。
func testScenes() []*Scenario {
	base := benchState()
	denseLatent := []domain.Position{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {2, 0}, {-2, 0}, {0, 2}, {0, -2}}
	sparseLatent := []domain.Position{{38, 45}, {30, 34}, {46, 34}}
	base.ResourceCells = domain.NewSet[string]()
	return []*Scenario{
		{
			Name:            "dense",
			Initial:         base,
			LatentResources: denseLatent,
		},
		{
			Name:            "sparse",
			Initial:         base,
			LatentResources: sparseLatent,
		},
	}
}

// TestBatchRunsAllCombinations：2 场景 × 2 策略 = 4 结果，确定性顺序。
func TestBatchRunsAllCombinations(t *testing.T) {
	policies := []*strategy.Config{
		{WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25},
		{WorkerTarget: 10, PopulationCeiling: 20, ExploreRadius: 12, ThreatDistance: 5, SpawnReserve: 2, MilitaryRatio: 0},
	}
	results := Batch(testScenes(), policies, 50, BatchOption{Workers: 4})
	if len(results) != 4 {
		t.Fatalf("results = %d, want 4 (2 scenes × 2 policies)", len(results))
	}
	// 确定性顺序：scene 升序 × policy 升序。
	if results[0].Scene != "dense" || results[1].Scene != "dense" {
		t.Errorf("first two should be dense: %s, %s", results[0].Scene, results[1].Scene)
	}
	if results[0].Policy >= results[1].Policy {
		t.Errorf("policies not sorted: %s >= %s", results[0].Policy, results[1].Policy)
	}
	if results[2].Scene != "sparse" {
		t.Errorf("third should be sparse: %s", results[2].Scene)
	}
	// Timeline 采样存在（每 25 tick + 末尾）。
	if len(results[0].Timeline) < 2 {
		t.Errorf("timeline points = %d, want >= 2", len(results[0].Timeline))
	}
}

// TestBatchDeterministicAcrossRuns：两次 Batch 结果逐项一致（并发安全）。
func TestBatchDeterministicAcrossRuns(t *testing.T) {
	policies := []*strategy.Config{
		{WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25},
	}
	first := Batch(testScenes(), policies, 100, BatchOption{Workers: 2})
	second := Batch(testScenes(), policies, 100, BatchOption{Workers: 2})
	if len(first) != len(second) {
		t.Fatalf("result count differs: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i].Stats.Deposits != second[i].Stats.Deposits {
			t.Errorf("scene %s deposits differ: %d vs %d", first[i].Scene, first[i].Stats.Deposits, second[i].Stats.Deposits)
		}
		if first[i].Final.Resources != second[i].Final.Resources {
			t.Errorf("scene %s resources differ: %d vs %d", first[i].Scene, first[i].Final.Resources, second[i].Final.Resources)
		}
	}
}

// TestBatchEvaluateScore：Evaluate 回调生效（评分写入 Score）。
func TestBatchEvaluateScore(t *testing.T) {
	policies := []*strategy.Config{
		{WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25},
	}
	results := Batch(testScenes(), policies, 50, BatchOption{
		Workers: 2,
		Evaluate: func(stats []SettleStats, final *domain.TickState) float64 {
			return float64(len(final.Workers))*10 + float64(final.Resources)
		},
	})
	for _, result := range results {
		if result.Score <= 0 {
			t.Errorf("scene %s score = %f, want > 0", result.Scene, result.Score)
		}
	}
}

// TestBatchScenarioCloneIsolated：并发场景互不干扰（每 worker 独立状态）。
func TestBatchScenarioCloneIsolated(t *testing.T) {
	scenes := testScenes()
	// 两个 worker 同时跑同一场景——各自独立，不改原始状态。
	policies := []*strategy.Config{
		{WorkerTarget: 6, PopulationCeiling: 16, ExploreRadius: 17, ThreatDistance: 5, SpawnReserve: 0, MilitaryRatio: 25},
	}
	_ = Batch(scenes, policies, 50, BatchOption{Workers: 4})
	// 原始场景 Initial 未被修改（tick 仍是 1）。
	for _, scene := range scenes {
		if scene.Initial.Tick != 1 {
			t.Errorf("scene %s initial mutated: tick = %d, want 1", scene.Name, scene.Initial.Tick)
		}
	}
}
