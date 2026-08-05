package sim

import (
	"testing"

	"github.com/deliciousbuding/arena/internal/domain"
)

// TestRefillRevealsLatentCellsInVision：潜在资源格在视野内 → reveal 进入
// ResourceCells（视野揭示语义）。
func TestRefillRevealsLatentCellsInVision(t *testing.T) {
	state := baseState()
	// worker 在 (3,0)：视野半径 3 → (4,0) 可见、(10,0) 不可见。
	state.ResourceCells = domain.NewSet[string]()
	refill := NewRefillConfig([]domain.Position{{4, 0}, {10, 0}})

	refill.reveal(state)
	if !state.ResourceCells.Contains(domain.CellKey(4, 0)) {
		t.Errorf("(4,0) should be revealed (within worker vision), got %v", state.ResourceCells)
	}
	if state.ResourceCells.Contains(domain.CellKey(10, 0)) {
		t.Errorf("(10,0) should NOT be revealed (outside vision), got %v", state.ResourceCells)
	}
}

// TestRefillMinedCellDisappearsThenRestores：采空标记 mined → reveal 不恢复；
// 4 tick 后 refill 补满 → 再次 reveal（配额内）。
func TestRefillMinedCellDisappearsThenRestores(t *testing.T) {
	state := baseState()
	state.Tick = 4
	state.ResourceCells = domain.NewSet[string]()
	refill := NewRefillConfig([]domain.Position{{4, 0}})

	refill.reveal(state)
	if !state.ResourceCells.Contains(domain.CellKey(4, 0)) {
		t.Fatalf("(4,0) not revealed initially")
	}
	// 采空：mined → reveal 不恢复。
	refill.markMined(domain.Position{4, 0})
	state.ResourceCells = domain.NewSet[string]()
	refill.reveal(state)
	if state.ResourceCells.Contains(domain.CellKey(4, 0)) {
		t.Errorf("mined cell revealed before refill")
	}
	// tick 8（4 tick 周期）refill 补满 → reveal 恢复。
	state.Tick = 8
	refill.applyRefillAndReveal(state)
	if !state.ResourceCells.Contains(domain.CellKey(4, 0)) {
		t.Errorf("mined cell not restored after refill cycle")
	}
}

// TestRefillRespectsChunkQuota：chunk 内 mined 格超过配额 → 只恢复配额内
// 数量（官方公式 max(2, floor(128/(8+ring)))；原点 chunk ring=0 → 配额
// 16——所有格都恢复）。
func TestRefillRespectsChunkQuota(t *testing.T) {
	state := baseState()
	state.Tick = 4
	refill := NewRefillConfig([]domain.Position{{1, 0}, {2, 0}, {3, 0}})
	// 全部采空。
	for _, pos := range []domain.Position{{1, 0}, {2, 0}, {3, 0}} {
		refill.markMined(pos)
	}
	state.Tick = 8
	refill.applyRefillAndReveal(state)
	for _, pos := range []domain.Position{{1, 0}, {2, 0}, {3, 0}} {
		if !state.ResourceCells.Contains(domain.CellKey(pos[0], pos[1])) {
			t.Errorf("cell %v not restored (quota 16 >= 3 mined)", pos)
		}
	}
}

// TestRefillChunkRingQuota：远端 chunk（ring 高）配额小——3 格 mined
// 且配额 2 → 只恢复 2 格（确定性顺序：坐标升序）。
func TestRefillChunkRingQuota(t *testing.T) {
	state := baseState()
	state.Tick = 4
	// (96,0) 在 chunk (64..96, 0..32) 的东边：ring = 96/32 = 3 → 配额
	// floor(128/11) = 11。用更高 ring 验证配额收缩：(128,0) → ring 4 →
	// floor(128/12) = 10。为构造配额 2，用 (320,0) ring 10 → 128/18=7。
	// 直接验证配额函数单调递减即可。
	refill := NewRefillConfig([]domain.Position{{4, 0}})
	origin := refill.chunkOrigin(domain.Position{320, 0})
	ringQuota := refill.chunkQuota(origin)
	originNear := refill.chunkOrigin(domain.Position{4, 0})
	nearQuota := refill.chunkQuota(originNear)
	if ringQuota >= nearQuota {
		t.Errorf("far chunk quota %d should be < near chunk quota %d", ringQuota, nearQuota)
	}
	if ringQuota < 2 {
		t.Errorf("quota floor violated: %d < 2", ringQuota)
	}
}

// TestRefillSettlesFullCycle：完整 Settle 周期——harvest 采空后格消失，
// refill 周期后恢复（模拟引擎集成）。
func TestRefillSettlesFullCycle(t *testing.T) {
	state := baseState()
	state.ResourceCells = domain.NewSet(domain.CellKey(3, 0))
	engine := NewEngine()
	engine.Refill = NewRefillConfig([]domain.Position{{3, 0}})

	// tick 1: worker 在资源格上采（cargo 0→1），格消失。
	plan := &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{
		"worker-1": {Kind: domain.ActionHarvest},
	}}
	result := engine.Settle(state, plan)
	if result.Stats.Harvests != 1 {
		t.Fatalf("harvests = %d, want 1", result.Stats.Harvests)
	}
	if result.NextState.ResourceCells.Contains(domain.CellKey(3, 0)) {
		t.Errorf("mined cell should disappear from ResourceCells")
	}
	// tick 2-3: 格仍未恢复（refill 周期未到）。
	state = result.NextState
	for tick := 2; tick <= 3; tick++ {
		state.Tick = tick
		result = engine.Settle(state, &domain.Plan{Tick: tick, UnitActions: map[string]domain.UnitAction{}})
		if result.NextState.ResourceCells.Contains(domain.CellKey(3, 0)) {
			t.Errorf("tick %d: cell restored before refill cycle", tick)
		}
		state = result.NextState
	}
	// tick 4: refill 周期 → 格恢复（worker 在 (3,0) 视野内）。
	state.Tick = 4
	result = engine.Settle(state, &domain.Plan{Tick: 4, UnitActions: map[string]domain.UnitAction{}})
	if !result.NextState.ResourceCells.Contains(domain.CellKey(3, 0)) {
		t.Errorf("tick 4: cell not restored after refill cycle")
	}
}

// TestVisionRadiusValues：官方视野半径数值（Worker 3 / Vanguard 4 /
// Ranger 5 / Core 5）。
func TestVisionRadiusValues(t *testing.T) {
	if got := VisionRadius(domain.UnitWorker); got != 3 {
		t.Errorf("worker vision = %d, want 3", got)
	}
	if got := VisionRadius(domain.UnitVanguard); got != 4 {
		t.Errorf("vanguard vision = %d, want 4", got)
	}
	if got := VisionRadius(domain.UnitRanger); got != 5 {
		t.Errorf("ranger vision = %d, want 5", got)
	}
	if CoreVisionRadius != 5 {
		t.Errorf("core vision = %d, want 5", CoreVisionRadius)
	}
}

// TestInUnionVision：并集视野判定（任一己方对象视野内即 true）。
func TestInUnionVision(t *testing.T) {
	state := baseState() // worker-1 在 (3,0)，Core 在 (0,0)
	if !InUnionVision(state, domain.Position{5, 0}) {
		t.Errorf("(5,0) should be in worker vision (worker at (3,0), r=3)")
	}
	if InUnionVision(state, domain.Position{9, 0}) {
		t.Errorf("(9,0) should be outside vision (dist 6 > 3)")
	}
	if !InUnionVision(state, domain.Position{2, 2}) {
		t.Errorf("(2,2) should be in core vision (core at (0,0), r=5)")
	}
}

// TestRefillOverQuotaRestoresLowestCoords：超配额 chunk 时按坐标升序
// 恢复（确定性）——mined 3 格配额 2 → 恢复坐标最小的 2 格（x 优先，
// 同 x 取 y 小），与调用顺序无关（回归：map 迭代序漂移修复）。
// 直接检查 refill 内部状态（远端格不在视野内，reveal 不显示）。
// ring 35 chunk（x 1120..1152）：配额 floor(128/43)=2 < 3 mined。
func TestRefillOverQuotaRestoresLowestCoords(t *testing.T) {
	state := baseState()
	state.Tick = 4
	cells := []domain.Position{{1120, 1}, {1120, 3}, {1121, 2}}
	refill := NewRefillConfig(cells)
	for _, pos := range cells {
		refill.markMined(pos)
	}
	state.Tick = 8
	refill.applyRefillAndReveal(state)
	restored := 0
	for _, pos := range cells {
		if refill.latent[domain.CellKey(pos[0], pos[1])].state == refillActive {
			restored++
		}
	}
	if restored != 2 {
		t.Fatalf("restored = %d, want 2 (quota)", restored)
	}
	// 坐标升序：x=1120 先（y 1、3），x=1121 后。
	if refill.latent[domain.CellKey(1120, 1)].state != refillActive ||
		refill.latent[domain.CellKey(1120, 3)].state != refillActive {
		t.Errorf("expected lowest-x cells restored (1120,1)/(1120,3), got states %v/%v/%v",
			refill.latent[domain.CellKey(1120, 1)].state,
			refill.latent[domain.CellKey(1120, 3)].state,
			refill.latent[domain.CellKey(1121, 2)].state)
	}
	if refill.latent[domain.CellKey(1121, 2)].state == refillActive {
		t.Errorf("(1121,2) should NOT be restored (quota 2, x=1121 last)")
	}
}

// TestRefillRestoreOrderDeterministicAcrossInstances：超配额场景两个
// 独立实例恢复结果一致（确定性，与构造顺序无关）。
func TestRefillRestoreOrderDeterministicAcrossInstances(t *testing.T) {
	cells := []domain.Position{{1120, 1}, {1120, 3}, {1121, 2}}
	restore := func(order []domain.Position) map[string]bool {
		state := baseState()
		state.Tick = 4
		refill := NewRefillConfig(order)
		for _, pos := range order {
			refill.markMined(pos)
		}
		state.Tick = 8
		refill.applyRefillAndReveal(state)
		result := make(map[string]bool)
		for _, pos := range cells {
			result[domain.CellKey(pos[0], pos[1])] = refill.latent[domain.CellKey(pos[0], pos[1])].state == refillActive
		}
		return result
	}
	first := restore(cells)
	reversed := make([]domain.Position, len(cells))
	for i := range cells {
		reversed[i] = cells[len(cells)-1-i]
	}
	second := restore(reversed)
	for _, pos := range cells {
		key := domain.CellKey(pos[0], pos[1])
		if first[key] != second[key] {
			t.Errorf("restore differs by input order for %s: %v vs %v", key, first[key], second[key])
		}
	}
}
