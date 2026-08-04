package domain

import "sort"

// World 记忆常量（与 TS 版 world.ts 一致）。
const (
	// ResourceMemoryTTLTicks 是 stale/harvested 资源记忆的过期 TTL
	// （≈4 个 refill 周期），防"幽灵资源"——记忆中的资源格实际已被
	// 采空/不再 refill。
	ResourceMemoryTTLTicks = 64
	// DefaultResourceMaxAge 是 resourceHints 中 stale 记忆的最大年龄。
	DefaultResourceMaxAge = 8
	// DefaultFailedCooldown 是 resourceHints 中 HARVEST_FAILED 的冷却。
	DefaultFailedCooldown = 4
	// DefaultMovementCooldownTicks 是 movementObstacles 的默认冷却。
	DefaultMovementCooldownTicks = 3
)

// transientMoveFailureReasons 是单位级动态避让的瞬态移动失败原因
// （与 TS 版 TRANSIENT_MOVE_FAILURE_REASONS 一致）。
var transientMoveFailureReasons = map[string]struct{}{
	"MOVE_CONTESTED":            {},
	"MOVE_SWAP_BLOCKED":         {},
	"MOVE_DESTINATION_OCCUPIED": {},
	"CELL_UNIT_LIMIT":           {},
}

// ResourceState 是资源记忆状态（与 TS 版 ResourceState 一致）。
type ResourceState string

const (
	ResourceStateVisible   ResourceState = "visible"
	ResourceStateStale     ResourceState = "stale"
	ResourceStateHarvested ResourceState = "harvested"
)

// WorkerMode 是单位工作模式（与 TS 版 WorkerMode 一致）。
type WorkerMode string

const (
	WorkerModePatrol    WorkerMode = "patrol"
	WorkerModeGoHarvest WorkerMode = "go_harvest"
)

// ResourceMemory 是资源格记忆（State/LastSeenTick 由 Observe 更新）。
type ResourceMemory struct {
	Cell          Position
	State         ResourceState
	FirstSeenTick int
	LastSeenTick  int
}

// EnemyMemory 是敌方实体记忆。
type EnemyMemory struct {
	ID           string
	Position     Position
	Kind         string
	UnitType     *UnitType
	LastSeenTick int
}

// UnitMemory 是单位工作状态记忆（决策层读写，与 TS 版 UnitMemory 一致）。
type UnitMemory struct {
	WorkerMode      WorkerMode
	HarvestTarget   *Position
	PatrolDirection int
	PatrolRing      int
	PatrolStarted   bool
	PatrolReturning bool
	LastTick        int
}

// ResourceSnapshot 是 WorldSnapshot 中的资源记忆条目。
type ResourceSnapshot struct {
	Cell          string
	State         ResourceState
	FirstSeenTick int
	LastSeenTick  int
}

// EnemySnapshot 是 WorldSnapshot 中的敌方记忆条目。
type EnemySnapshot struct {
	ID           string
	Cell         string
	Kind         string
	LastSeenTick int
}

// WorldSnapshot 是 World 记忆的确定性快照（与 TS 版 snapshot 同语义，
// 切片均按稳定序排列）。
type WorldSnapshot struct {
	Tick      int
	Obstacles []string
	Resources []ResourceSnapshot
	Enemies   []EnemySnapshot
	UnitModes map[string]WorkerMode
}

// World 维护跨 tick 的世界记忆：障碍、资源、敌方实体，以及单位级移动
// 失败冷却（与 TS 版 world.ts World 同语义）：
//   - 障碍永久记忆（直到世界重置）；
//   - 资源记忆状态机 visible → stale/harvested → TTL 过期删除；
//   - 敌方实体按 ID 覆盖更新（位置/类型随新观察刷新）；
//   - tick 回退（服务器世界重置/异常）触发全清并计数。
type World struct {
	tick             int
	obstacleMemory   Set[string]
	resourceMemory   map[string]*ResourceMemory
	enemyMemory      map[string]*EnemyMemory
	failedCells      map[string]int
	unitMoveFailures map[string]map[string]int
	unitMemories     map[string]*UnitMemory

	// WorldResetCount 是世界重置计数（tick 回退检测触发；决策层遥测/测试可读）。
	WorldResetCount int
	// LastWorldResetTick 是最近一次世界重置发生时的 tick（从未重置 = nil）。
	LastWorldResetTick *int
}

// NewWorld 构造空 World。
func NewWorld() *World {
	return &World{
		obstacleMemory:   make(Set[string]),
		resourceMemory:   make(map[string]*ResourceMemory),
		enemyMemory:      make(map[string]*EnemyMemory),
		failedCells:      make(map[string]int),
		unitMoveFailures: make(map[string]map[string]int),
		unitMemories:     make(map[string]*UnitMemory),
	}
}

// Observe 吸收一个规范化 TickState，更新跨 tick 记忆
// （与 TS 版 World.observe 同语义）。
func (w *World) Observe(state *TickState) {
	if w.tick > state.Tick {
		w.reset(state.Tick)
	}
	w.tick = state.Tick

	for cell := range state.ObstacleCells {
		w.obstacleMemory.Add(cell)
	}

	visibleResources := state.ResourceCells.Clone()
	for cell := range visibleResources {
		previous := w.resourceMemory[cell]
		firstSeen := state.Tick
		if previous != nil {
			firstSeen = previous.FirstSeenTick
		}
		position, err := ParseCellKey(cell)
		if err != nil {
			continue
		}
		w.resourceMemory[cell] = &ResourceMemory{
			Cell:          position,
			State:         ResourceStateVisible,
			FirstSeenTick: firstSeen,
			LastSeenTick:  state.Tick,
		}
	}
	for key, memory := range w.resourceMemory {
		if visibleResources.Contains(key) {
			continue
		}
		if memory.State == ResourceStateVisible || memory.State == ResourceStateHarvested {
			memory.State = ResourceStateStale
		}
	}

	for i := range state.Events {
		event := &state.Events[i]
		if event.Position == nil {
			continue
		}
		cell := CellKey(event.Position[0], event.Position[1])
		switch event.EventType {
		case "HARVEST_FAILED":
			w.failedCells[cell] = state.Tick
			if memory := w.resourceMemory[cell]; memory != nil && memory.State == ResourceStateVisible {
				memory.State = ResourceStateStale
			}
		case "HARVEST_SUCCEEDED":
			previous := w.resourceMemory[cell]
			firstSeen := state.Tick
			if previous != nil {
				firstSeen = previous.FirstSeenTick
			}
			position := *event.Position
			w.resourceMemory[cell] = &ResourceMemory{
				Cell:          position,
				State:         ResourceStateHarvested,
				FirstSeenTick: firstSeen,
				LastSeenTick:  state.Tick,
			}
		case "UNIT_MOVE_FAILED":
			if event.ActorID == nil || event.ReasonCode == nil {
				continue
			}
			if _, transient := transientMoveFailureReasons[*event.ReasonCode]; !transient {
				continue
			}
			failures := w.unitMoveFailures[*event.ActorID]
			if failures == nil {
				failures = make(map[string]int)
				w.unitMoveFailures[*event.ActorID] = failures
			}
			failures[cell] = state.Tick
		}
	}

	for i := range state.VisibleEnemies {
		enemy := &state.VisibleEnemies[i]
		w.enemyMemory[enemy.ID] = &EnemyMemory{
			ID:           enemy.ID,
			Position:     enemy.Position,
			Kind:         enemy.Kind,
			UnitType:     enemy.UnitType,
			LastSeenTick: state.Tick,
		}
	}

	liveUnits := make(Set[string], len(state.Units))
	for _, unit := range state.Units {
		liveUnits.Add(unit.ID)
	}
	for unitID := range w.unitMemories {
		if !liveUnits.Contains(unitID) {
			delete(w.unitMemories, unitID)
		}
	}
	for unitID := range w.unitMoveFailures {
		if !liveUnits.Contains(unitID) {
			delete(w.unitMoveFailures, unitID)
		}
	}

	for key, memory := range w.resourceMemory {
		if memory.State != ResourceStateVisible && state.Tick-memory.LastSeenTick > ResourceMemoryTTLTicks {
			delete(w.resourceMemory, key)
			delete(w.failedCells, key)
		}
	}
}

// UnitMemory 返回单位的持久记忆，不存在时以初始巡逻方向创建
// （与 TS 版 World.unitMemory 同语义；返回指针可直接读写）。
func (w *World) UnitMemory(unitID string, initialPatrolDirection int) *UnitMemory {
	memory := w.unitMemories[unitID]
	if memory == nil {
		memory = &UnitMemory{
			WorkerMode:      WorkerModePatrol,
			PatrolDirection: initialPatrolDirection,
		}
		w.unitMemories[unitID] = memory
	}
	memory.LastTick = w.tick
	return memory
}

// Obstacles 返回障碍记忆与额外障碍的并集副本（与 TS 版 obstacles 同语义；
// extra 可为 nil）。
func (w *World) Obstacles(extra Set[string]) Set[string] {
	result := w.obstacleMemory.Clone()
	for cell := range extra {
		result.Add(cell)
	}
	return result
}

// MovementObstacles 返回单位级动态避让集合：服务端 MOVE_CONTESTED 等失败
// 不代表永久地形障碍，只在冷却内阻止同一 actor 重试同一目的格
// （与 TS 版 movementObstacles 同语义；cooldownTicks <= 0 用默认 3）。
func (w *World) MovementObstacles(unitID string, base Set[string], cooldownTicks int) Set[string] {
	if cooldownTicks <= 0 {
		cooldownTicks = DefaultMovementCooldownTicks
	}
	result := base.Clone()
	failures := w.unitMoveFailures[unitID]
	if failures == nil {
		return result
	}
	for cell, failedAt := range failures {
		if w.tick-failedAt < cooldownTicks {
			result.Add(cell)
		} else {
			delete(failures, cell)
		}
	}
	if len(failures) == 0 {
		delete(w.unitMoveFailures, unitID)
	}
	return result
}

// ResourceHints 返回资源格提示：可见优先，stale 按最近见过排序，最近
// 失败的格在冷却内排除（与 TS 版 resourceHints 同语义；maxAge <= 0 用
// 默认 8，failedCooldown <= 0 用默认 4）。
func (w *World) ResourceHints(maxAge, failedCooldown int) []Position {
	if maxAge <= 0 {
		maxAge = DefaultResourceMaxAge
	}
	if failedCooldown <= 0 {
		failedCooldown = DefaultFailedCooldown
	}
	visible := make([]*ResourceMemory, 0)
	recent := make([]*ResourceMemory, 0)
	for _, memory := range w.resourceMemory {
		failedAt, failed := w.failedCells[CellKey(memory.Cell[0], memory.Cell[1])]
		if failed && w.tick-failedAt < failedCooldown {
			continue
		}
		switch memory.State {
		case ResourceStateVisible:
			visible = append(visible, memory)
		case ResourceStateStale:
			if w.tick-memory.LastSeenTick <= maxAge {
				recent = append(recent, memory)
			}
		}
	}
	compare := func(a, b *ResourceMemory) bool {
		if a.LastSeenTick != b.LastSeenTick {
			return a.LastSeenTick > b.LastSeenTick
		}
		if a.Cell[0] != b.Cell[0] {
			return a.Cell[0] < b.Cell[0]
		}
		return a.Cell[1] < b.Cell[1]
	}
	sort.Slice(visible, func(i, j int) bool { return compare(visible[i], visible[j]) })
	sort.Slice(recent, func(i, j int) bool { return compare(recent[i], recent[j]) })
	hints := make([]Position, 0, len(visible)+len(recent))
	for _, memory := range visible {
		hints = append(hints, memory.Cell)
	}
	for _, memory := range recent {
		hints = append(hints, memory.Cell)
	}
	return hints
}

// EnemyHints 返回最近 maxAge ticks 内见过的敌方实体（按最近见过倒序，
// 同 tick 按 ID 升序；与 TS 版 enemyHints 同语义；maxAge <= 0 用默认 6）。
func (w *World) EnemyHints(maxAge int) []EnemyMemory {
	if maxAge <= 0 {
		maxAge = 6
	}
	hints := make([]EnemyMemory, 0)
	for _, memory := range w.enemyMemory {
		if w.tick-memory.LastSeenTick <= maxAge {
			hints = append(hints, *memory)
		}
	}
	sort.Slice(hints, func(i, j int) bool {
		if hints[i].LastSeenTick != hints[j].LastSeenTick {
			return hints[i].LastSeenTick > hints[j].LastSeenTick
		}
		return hints[i].ID < hints[j].ID
	})
	return hints
}

// Snapshot 返回世界记忆的确定性快照（与 TS 版 snapshot 同语义）。
func (w *World) Snapshot() WorldSnapshot {
	obstacles := make([]string, 0, w.obstacleMemory.Len())
	for cell := range w.obstacleMemory {
		obstacles = append(obstacles, cell)
	}
	sort.Strings(obstacles)

	resources := make([]ResourceSnapshot, 0, len(w.resourceMemory))
	for key, memory := range w.resourceMemory {
		resources = append(resources, ResourceSnapshot{
			Cell:          key,
			State:         memory.State,
			FirstSeenTick: memory.FirstSeenTick,
			LastSeenTick:  memory.LastSeenTick,
		})
	}
	sort.Slice(resources, func(i, j int) bool { return resources[i].Cell < resources[j].Cell })

	enemies := make([]EnemySnapshot, 0, len(w.enemyMemory))
	for _, memory := range w.enemyMemory {
		enemies = append(enemies, EnemySnapshot{
			ID:           memory.ID,
			Cell:         CellKey(memory.Position[0], memory.Position[1]),
			Kind:         memory.Kind,
			LastSeenTick: memory.LastSeenTick,
		})
	}
	sort.Slice(enemies, func(i, j int) bool { return enemies[i].ID < enemies[j].ID })

	unitModes := make(map[string]WorkerMode, len(w.unitMemories))
	for id, memory := range w.unitMemories {
		unitModes[id] = memory.WorkerMode
	}

	return WorldSnapshot{
		Tick:      w.tick,
		Obstacles: obstacles,
		Resources: resources,
		Enemies:   enemies,
		UnitModes: unitModes,
	}
}

// reset 是世界重置（tick 回退）：全清本地记忆并计数
// （与 TS 版 observe 内世界重置检测同语义）。
func (w *World) reset(tick int) {
	w.obstacleMemory = make(Set[string])
	w.resourceMemory = make(map[string]*ResourceMemory)
	w.enemyMemory = make(map[string]*EnemyMemory)
	w.failedCells = make(map[string]int)
	w.unitMoveFailures = make(map[string]map[string]int)
	w.unitMemories = make(map[string]*UnitMemory)
	w.WorldResetCount++
	tickCopy := tick
	w.LastWorldResetTick = &tickCopy
}
