package sim

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// 视野规则（官方 v0.13）：玩家视野 = 所有存活己方对象的视野并集。
//   - Worker 半径 3、Core 半径 5、Vanguard 半径 4、Ranger 半径 5；
//   - 视野揭示语义：只有视野扫过的潜在资源格才进入 ResourceCells；
//   - state 是全量快照（无 diff）。
//
// 并集视野用于 refill 引擎的 reveal 判定（见 refill.go）。

// VisionRadius 返回单位类型的视野半径（官方数值）。
func VisionRadius(unitType domain.UnitType) int {
	switch unitType {
	case domain.UnitWorker:
		return 3
	case domain.UnitVanguard:
		return 4
	case domain.UnitRanger:
		return 5
	}
	return 0
}

// CoreVisionRadius 是 Core 的视野半径。
const CoreVisionRadius = 5

// chebyshevDistance 返回两格的 Chebyshev 距离（视野为方形区域，
// 官方 hero 视野语义：max(|dx|, |dy|) <= radius）。
func chebyshevDistance(a, b domain.Position) int {
	dx := a[0] - b[0]
	if dx < 0 {
		dx = -dx
	}
	dy := a[1] - b[1]
	if dy < 0 {
		dy = -dy
	}
	if dx > dy {
		return dx
	}
	return dy
}

// InUnionVision 报告格 p 是否在任一己方对象（Core + 所有单位）的
// 视野内。Core 缺失时仅单位视野。
func InUnionVision(state *domain.TickState, p domain.Position) bool {
	if state.Core != nil && chebyshevDistance(p, state.Core.Position) <= CoreVisionRadius {
		return true
	}
	for _, unit := range state.Units {
		radius := VisionRadius(unit.UnitType)
		if radius > 0 && chebyshevDistance(p, unit.Position) <= radius {
			return true
		}
	}
	return false
}
