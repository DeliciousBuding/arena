// Package domain 是 Arena 领域逻辑层：state-reducer（raw-state → 规范化
// TickState）、nav（有界 BFS 最短路）、world（跨 tick 世界记忆）、
// phase-machine（阶段机）、plan-validator（语义校验 + repair）、
// state-hash（canonical sha256 内容哈希）。
//
// 语义以 TS 版 packages/arena-agent/src/domain/ 为参照（同构移植，
// 非逐字拷贝），字段名与 TS 版 model.ts 一致；障碍/资源格集合使用
// cell-key 字符串（"x,y"），与 TS 版 ReadonlySet<string> 一致。
//
// 分层约定（docs/go/02-contracts.md §1.3）：本包不直接 import
// encoding/json，wire 数据一律经 internal/contracts 转换。
package domain

import (
	"fmt"
	"strconv"
	"strings"
)

// Position 是网格坐标 [x, y]，与 contracts.Position 同构。领域层独立定义，
// 保持领域与 wire 布局解耦（与 TS 版 model.ts Position 一致）。
type Position [2]int

// CellKey 返回稳定格键 "x,y"（与 TS 版 cellKey 同格式）。
func CellKey(x, y int) string {
	return strconv.Itoa(x) + "," + strconv.Itoa(y)
}

// ParseCellKey 解析 "x,y" 格键（与 TS 版 parseCellKey 同语义，
// Go 版返回 error 而非 panic）。
func ParseCellKey(value string) (Position, error) {
	parts := strings.Split(value, ",")
	if len(parts) != 2 {
		return Position{}, fmt.Errorf("invalid cell key: %s", value)
	}
	x, errX := strconv.Atoi(parts[0])
	y, errY := strconv.Atoi(parts[1])
	if errX != nil || errY != nil {
		return Position{}, fmt.Errorf("invalid cell key: %s", value)
	}
	return Position{x, y}, nil
}

// Direction 是移动/横扫方向（与 TS 版 Direction 一致）。
type Direction string

const (
	DirectionUp    Direction = "UP"
	DirectionDown  Direction = "DOWN"
	DirectionLeft  Direction = "LEFT"
	DirectionRight Direction = "RIGHT"
)

// ValidDirection 报告方向是否在枚举内。
func ValidDirection(direction Direction) bool {
	switch direction {
	case DirectionUp, DirectionDown, DirectionLeft, DirectionRight:
		return true
	}
	return false
}

// UnitType 是单位类型（与 TS 版 UnitType 一致）。
type UnitType string

const (
	UnitWorker   UnitType = "WORKER"
	UnitVanguard UnitType = "VANGUARD"
	UnitRanger   UnitType = "RANGER"
)

// ValidUnitType 报告类型是否在枚举内。
func ValidUnitType(unitType UnitType) bool {
	switch unitType {
	case UnitWorker, UnitVanguard, UnitRanger:
		return true
	}
	return false
}

// CoreState 是 Core 的移动状态（与 TS 版 CoreState 一致）。
type CoreState string

const (
	CoreNormal CoreState = "NORMAL"
	CoreMoving CoreState = "MOVING"
)

// PlayerStatus 是玩家生命周期状态（与 TS 版 PlayerStatus 一致）。
type PlayerStatus string

const (
	PlayerStatusActive     PlayerStatus = "ACTIVE"
	PlayerStatusRespawning PlayerStatus = "RESPAWNING"
)

// BeaconStatus 是 Champion Beacon 状态（与 TS 版 BeaconSnapshot.status 一致）。
// 空值表示服务器未报告状态（fixture 中常缺省）。
type BeaconStatus string

const (
	BeaconGround  BeaconStatus = "GROUND"
	BeaconCarried BeaconStatus = "CARRIED"
)

// UnitSnapshot 是受控单位快照（TS 版 UnitSnapshot）。immutable 语义：
// reducer 产出后调用方不得修改。
type UnitSnapshot struct {
	ID       string
	Position Position
	HP       int
	UnitType UnitType
	Cargo    int
}

// Core 是受控 Core 快照（TS 版 CoreSnapshot）。
type Core struct {
	ID            string
	Position      Position
	HP            int
	Shield        int
	State         CoreState
	OwnerUsername string
}

// VisibleEntity 是可见敌方实体（TS 版 VisibleEntity）：Kind 为 "UNIT" 或
// "CORE"；UnitType/OwnerUsername 缺失时为空指针。
type VisibleEntity struct {
	ID            string
	Kind          string
	Position      Position
	HP            int
	UnitType      *UnitType
	OwnerUsername *string
}

// Beacon 是 Champion Beacon 快照（TS 版 BeaconSnapshot）。Status 空值表示
// 服务器未报告（与 TS 版透传 null 语义一致）；CarrierID 缺失为 nil。
type Beacon struct {
	Position  Position
	Status    BeaconStatus
	CarrierID *string
}

// Event 是单个结算事件快照（TS 版 ResolutionEventSnapshot）。
type Event struct {
	EventID    string
	Tick       int
	EventType  string
	ReasonCode *string
	ActorID    *string
	TargetID   *string
	Position   *Position
	Values     map[string]any
}

// TickState 是规范化后的不可变游戏状态（reducer 输出，TS 版 TickState
// 同构）：
//   - Units 及分列 Workers/Vanguards/Rangers 按 ID 升序；
//   - VisibleEnemies 按 ID 升序；
//   - ResourceCells/ObstacleCells 为 cell-key（"x,y"）只读约定集合
//     （与 TS 版 ReadonlySet<string> 一致；需要副本时用 Clone）；
//   - StateHash 由 HashState 计算（内容哈希，不含 StateHash 自身）。
type TickState struct {
	Tick             int
	Status           PlayerStatus
	Resources        int
	ResourceCapacity int
	ResourceSpace    int
	Population       int
	PopulationTier   int
	UpkeepNextTick   int
	Core             *Core
	Units            []UnitSnapshot
	Workers          []UnitSnapshot
	Vanguards        []UnitSnapshot
	Rangers          []UnitSnapshot
	VisibleEnemies   []VisibleEntity
	ResourceCells    Set[string]
	ObstacleCells    Set[string]
	Beacon           Beacon
	Events           []Event
	StateHash        string
}

// Set 是领域层集合（map 封装）。TickState 中的集合按只读约定使用；
// 需要可写副本时调用 Clone。
type Set[T comparable] map[T]struct{}

// WithResourceHints 返回合并世界记忆资源格后的决策视图（浅拷贝）：
// 实时 ResourceCells 为空或不足时，把跨 tick 记忆中的资源格并入
// 候选集合，让 worker 朝记忆格采集/移动（真机视野外资源格依赖此链路，
// 否则 worker 原地打转、经济枯竭）。无 hints 时返回原 state。
func (s *TickState) WithResourceHints(hints []Position) *TickState {
	if len(hints) == 0 {
		return s
	}
	clone := *s
	cells := s.ResourceCells.Clone()
	for _, cell := range hints {
		cells.Add(CellKey(cell[0], cell[1]))
	}
	clone.ResourceCells = cells
	return &clone
}

// NewSet 从元素构造集合。
func NewSet[T comparable](items ...T) Set[T] {
	set := make(Set[T], len(items))
	for _, item := range items {
		set[item] = struct{}{}
	}
	return set
}

// Contains 报告元素是否在集合中。
func (s Set[T]) Contains(item T) bool {
	_, ok := s[item]
	return ok
}

// Len 返回集合大小。
func (s Set[T]) Len() int {
	return len(s)
}

// Add 向集合加入元素（仅内部构造/World 记忆使用；TickState 集合不增删）。
func (s Set[T]) Add(item T) {
	s[item] = struct{}{}
}

// Remove 从集合删除元素（sim 结算用：采空格立即消失；World 清理用）。
func (s Set[T]) Remove(item T) {
	delete(s, item)
}

// Clone 返回集合的独立副本（避免别名共享）。
func (s Set[T]) Clone() Set[T] {
	clone := make(Set[T], len(s))
	for item := range s {
		clone[item] = struct{}{}
	}
	return clone
}
