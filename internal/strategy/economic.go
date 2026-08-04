package strategy

import (
	"sort"

	"github.com/deliciousbuding/arena/internal/domain"
)

// 经济规划辅助：worker 全局资源分配 + 移动目标冲突仲裁 + Core 恢复期
// （respawn override）判定。
//
// 语义（docs/go/03-module-spec.md M4 + Lane 2 裁决，参照 TS 版
// WorkerTaskPlanner 全局贪心分配与 resolveMoveCapacity 仲裁）：
//   - assignWorkers：全部空手 worker × 所有可见资源格一次全局匹配，
//     每格至多一个 worker（第一版贪心：按 worker ID 升序各取曼哈顿
//     距离最近的未占用格）；
//   - arbitrateMoveCapacity：同 tick 多单位规划到同一目标格时，只保留
//     任务优先级最高者（deposit/return > harvest > combat > explore），
//     其余降级 WAIT（第一版不重规划）；
//   - respawnOverride：Core 缺失 / 玩家 RESPAWNING / Core 非 NORMAL 时
//     强制经济模式：单位不探索远处，spawn 走紧急通道（无视 reserve）。

// movePriority 是移动目标的任务优先级（数值越大越优先保留）。
type movePriority int

const (
	priorityExplore movePriority = iota
	priorityCombat
	priorityHarvest
	priorityReturn // deposit / 满载回仓
)

// emergencyWorkerFloor 是补员紧急线（对齐 TS 版 WORKER_RECOVERY_FLOOR）：
// worker 数低于此线视为经济紧急，spawn 只要求 cost（不攒 reserve）。
const emergencyWorkerFloor = 2

// assignWorkers 为全部空手 worker 做全局资源格分配（每格至多一个 worker）。
// 返回 unitID → 目标格：
//   - 满载 worker 不参与分配（走回仓/上交流程）；
//   - 已站在资源格上的空手 worker 本 tick 直接 HARVEST，其所在格视为占用；
//   - 其余空手 worker 按 ID 升序，各取曼哈顿距离最近的未占用格
//     （候选格先按 (x,y) 排序——map 迭代无序不可依赖；平局自然取排序
//     更前的格，即 x 小、再 y 小）；
//   - 资源格不足时未分到的 worker 不进入结果（调用方转探索/待命）。
func assignWorkers(state *domain.TickState) map[string]domain.Position {
	assignments := make(map[string]domain.Position)

	available := make([]domain.Position, 0, state.ResourceCells.Len())
	for key := range state.ResourceCells {
		if position, err := domain.ParseCellKey(key); err == nil {
			available = append(available, position)
		}
	}
	sort.Slice(available, func(i, j int) bool {
		if available[i][0] != available[j][0] {
			return available[i][0] < available[j][0]
		}
		return available[i][1] < available[j][1]
	})

	claimed := make(map[string]struct{}, len(available))
	harvesters := make(map[string]struct{})
	for _, worker := range state.Workers {
		if worker.Cargo > 0 {
			continue
		}
		key := domain.CellKey(worker.Position[0], worker.Position[1])
		if state.ResourceCells.Contains(key) {
			claimed[key] = struct{}{}
			harvesters[worker.ID] = struct{}{}
		}
	}

	workers := append([]domain.UnitSnapshot(nil), state.Workers...)
	sort.Slice(workers, func(i, j int) bool { return workers[i].ID < workers[j].ID })

	for _, worker := range workers {
		if worker.Cargo > 0 {
			continue
		}
		if _, harvesting := harvesters[worker.ID]; harvesting {
			continue
		}
		bestIndex := -1
		bestDistance := 0
		for index, cell := range available {
			if _, taken := claimed[domain.CellKey(cell[0], cell[1])]; taken {
				continue
			}
			distance := domain.Manhattan(worker.Position, cell)
			// available 已按 (x,y) 排序：严格小于才替换 ⇒ 平局取排序更前的格。
			if bestIndex == -1 || distance < bestDistance {
				bestIndex = index
				bestDistance = distance
			}
		}
		if bestIndex == -1 {
			break // 无未占用格：后续 worker 亦然
		}
		cell := available[bestIndex]
		assignments[worker.ID] = cell
		claimed[domain.CellKey(cell[0], cell[1])] = struct{}{}
	}
	return assignments
}

// movePriorityFor 从动作 intent 映射任务优先级（deposit/return >
// harvest > combat > explore）。非移动动作（HARVEST/DEPOSIT/SHOOT/HEAL
// 等）不产生目标格，不会进入仲裁。
func movePriorityFor(intent string) movePriority {
	switch intent {
	case "deposit", "return_core":
		return priorityReturn
	case "harvest", "to_resource":
		return priorityHarvest
	case "engage", "defend", "to_core_heal":
		return priorityCombat
	default: // explore / patrol
		return priorityExplore
	}
}

// moveCandidate 是一条 MOVE 候选（目标格 + 任务优先级）。
type moveCandidate struct {
	unitID      string
	destination domain.Position
	priority    movePriority
	intent      string
}

// arbitrateMoveCapacity 做一次性移动容量仲裁：同一目标格只保留优先级
// 最高的单位（同优先级保留 ID 升序最小者），其余返回 loser 名单。
// 与 TS 版 resolveMoveCapacity 的"冲突格淘汰低优先级到达者"语义一致
// （第一版不重规划，loser 由调用方降级 WAIT）。
func arbitrateMoveCapacity(candidates []moveCandidate) []moveCandidate {
	bestByCell := make(map[string]moveCandidate, len(candidates))
	for _, candidate := range candidates {
		key := domain.CellKey(candidate.destination[0], candidate.destination[1])
		existing, ok := bestByCell[key]
		if !ok || candidate.priority > existing.priority ||
			(candidate.priority == existing.priority && candidate.unitID < existing.unitID) {
			bestByCell[key] = candidate
		}
	}
	winners := make(map[string]struct{}, len(bestByCell))
	for _, best := range bestByCell {
		winners[best.unitID] = struct{}{}
	}
	losers := make([]moveCandidate, 0, len(candidates)-len(winners))
	for _, candidate := range candidates {
		if _, won := winners[candidate.unitID]; !won {
			losers = append(losers, candidate)
		}
	}
	return losers
}

// respawnOverride 报告当前是否处于 Core 恢复期（Core 缺失 / 玩家
// RESPAWNING / Core 非 NORMAL）。期间强制经济模式：单位回核心防守或采
// 最近资源（不探索远处），spawn 走紧急通道（resources >= cost 即 spawn，
// 无视 reserve）。planner 无跨 tick 状态，恢复边沿的重新决策天然即时生效。
func respawnOverride(state *domain.TickState) bool {
	if state.Status == domain.PlayerStatusRespawning {
		return true
	}
	if state.Core == nil {
		return true
	}
	return state.Core.State != domain.CoreNormal
}

// findUnitSnapshot 按 ID 查找己方单位快照。
func findUnitSnapshot(state *domain.TickState, unitID string) *domain.UnitSnapshot {
	for i := range state.Units {
		if state.Units[i].ID == unitID {
			return &state.Units[i]
		}
	}
	return nil
}
