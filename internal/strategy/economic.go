package strategy

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// 经济规划辅助：worker 全局资源分配与移动目标冲突仲裁。
//
// 语义（docs/go/03-module-spec.md M4 + 赛马裁决 Lane 2）：
//   - 全局分配：所有 worker + 所有可见资源格一次匹配，每格至多一个
//     worker（第一版贪心：按 worker ID 升序分配最近的未占用格）；
//   - 冲突仲裁：同 tick 多单位目标格冲突时，任务优先级高的保留，
//     低的让路（WAIT），优先级：deposit/return > harvest > combat > explore。

// movePriority 是移动目标的任务优先级（数值越大越优先保留）。
type movePriority int

const (
	priorityExplore movePriority = iota
	priorityCombat
	priorityHarvest
	priorityReturn // deposit / 回仓
)

// resourceAssignments 为全部 worker 做全局资源格分配。
// 返回 unitID → 目标格；可见资源格少于 worker 时只分配前 N 个
// （按 worker ID 升序，state.Workers 已排序）。
func resourceAssignments(state *domain.TickState) map[string]domain.Position {
	assignments := make(map[string]domain.Position)
	available := make([]domain.Position, 0, state.ResourceCells.Len())
	for key := range state.ResourceCells {
		if position, err := domain.ParseCellKey(key); err == nil {
			available = append(available, position)
		}
	}
	for _, worker := range state.Workers {
		bestIndex := -1
		for index, position := range available {
			if bestIndex == -1 ||
				domain.Manhattan(worker.Position, position) < domain.Manhattan(worker.Position, available[bestIndex]) {
				bestIndex = index
			}
		}
		if bestIndex == -1 {
			break // 无剩余资源格
		}
		assignments[worker.ID] = available[bestIndex]
		available = append(available[:bestIndex], available[bestIndex+1:]...)
	}
	return assignments
}

// targetClaim 记录单位对目标格的占用声明，供同 tick 冲突仲裁。
type targetClaim struct {
	unitID   string
	priority movePriority
}

// claimTarget 尝试认领目标格：无人认领或当前认领者优先级更低则成功，
// 否则返回 false（调用方应降级为 WAIT）。
func claimTarget(claims map[string]targetClaim, unitID string, cell domain.Position, priority movePriority) bool {
	key := domain.CellKey(cell[0], cell[1])
	existing, ok := claims[key]
	if !ok || priority > existing.priority {
		claims[key] = targetClaim{unitID: unitID, priority: priority}
		return true
	}
	return false
}

// respawnOverride 报告当前是否处于 Core 恢复期（Core 缺失/非 NORMAL），
// 期间强制经济重建：单位不探索远处，spawn 走紧急通道（无 reserve）。
func respawnOverride(state *domain.TickState) bool {
	return state.Core == nil || state.Core.State != domain.CoreNormal
}
