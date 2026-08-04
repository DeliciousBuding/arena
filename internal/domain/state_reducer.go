package domain

import (
	"fmt"
	"sort"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// 资源容量公式（fixtures/differential/burnin-20260802-a/manifest.json
// rules.core：minCapacity=10、capacityPerUnit=5；与 TS 版
// sim/engine/economy.ts capacityOf 同语义）：
// resourceCapacity = max(minCapacity, population * capacityPerUnit)。
const (
	coreMinCapacity     = 10
	coreCapacityPerUnit = 5
)

// Reduce 将一条差分 fixture raw-state record 归约为规范化 TickState
// （与 TS 版 state-reducer.ts reduceTurn 同语义）：
//
//   - 受控单位按 ID 升序，按类型分列 workers/vanguards/rangers；
//   - cargo 仅 WORKER 有效（缺失记 0），其余类型恒为 0；
//   - 敌方实体取 objects 中 controlled=false 的 UNIT/CORE；
//   - obstacle/resource 格从 OBSTACLE/RESOURCE 对象的 positions 收集，
//     以 cell-key（"x,y"）入集合（与 TS 版 ReadonlySet<string> 一致）；
//   - Core 从受控 CORE 对象归约（state 非 "MOVING" 一律 NORMAL）；
//   - beacon 透传（status/carrier_id 允许缺失，Status 空值表示未报告）；
//   - resourceCapacity 由人口经核心容量公式计算；
//   - StateHash 由 HashState 计算。
//
// record 中不携带 tick 字段（fixture 由文件名/清单给出），故由调用方传入
// （生产路径来自服务器 turn 的 tick，与 TS 版 turn.tick 语义一致）。
func Reduce(record *contracts.DifferentialRecord, tick int) (*TickState, error) {
	if record == nil {
		return nil, fmt.Errorf("reduce: record is nil")
	}
	if tick < 1 {
		return nil, fmt.Errorf("reduce: invalid tick %d (must be >= 1)", tick)
	}

	units := make([]UnitSnapshot, 0, len(record.Objects))
	enemies := make([]VisibleEntity, 0)
	var core *Core
	resourceCells := make(Set[string])
	obstacleCells := make(Set[string])

	for i := range record.Objects {
		object := &record.Objects[i]
		switch object.Kind {
		case contracts.ObjectKindObstacle:
			for _, position := range object.Positions {
				obstacleCells.Add(CellKey(position[0], position[1]))
			}
		case contracts.ObjectKindResource:
			for _, position := range object.Positions {
				resourceCells.Add(CellKey(position[0], position[1]))
			}
		case contracts.ObjectKindCore:
			switch {
			case object.Controlled != nil && *object.Controlled && core == nil:
				core = reduceCore(object)
			case object.Controlled != nil && !*object.Controlled:
				enemies = append(enemies, reduceEnemy(object))
			}
		case contracts.ObjectKindUnit:
			if object.Controlled != nil && *object.Controlled {
				units = append(units, reduceUnit(object))
			} else if object.Controlled != nil {
				enemies = append(enemies, reduceEnemy(object))
			}
		}
	}

	sort.Slice(units, func(i, j int) bool { return units[i].ID < units[j].ID })
	sort.Slice(enemies, func(i, j int) bool { return enemies[i].ID < enemies[j].ID })

	capacity := resourceCapacity(record.Population)

	events := make([]Event, 0, len(record.Events))
	for index := range record.Events {
		events = append(events, reduceEvent(&record.Events[index], tick, index))
	}

	state := &TickState{
		Tick:             tick,
		Status:           PlayerStatus(record.Status),
		Resources:        record.Resources,
		ResourceCapacity: capacity,
		ResourceSpace:    capacity - record.Resources,
		Population:       record.Population,
		PopulationTier:   record.PopulationTier,
		UpkeepNextTick:   record.UpkeepNextTick,
		Core:             core,
		Units:            units,
		Workers:          classifyUnits(units, UnitWorker),
		Vanguards:        classifyUnits(units, UnitVanguard),
		Rangers:          classifyUnits(units, UnitRanger),
		VisibleEnemies:   enemies,
		ResourceCells:    resourceCells,
		ObstacleCells:    obstacleCells,
		Beacon: Beacon{
			Position:  toPosition(record.ChampionBeacon.Position),
			Status:    beaconStatusOf(record.ChampionBeacon.Status),
			CarrierID: record.ChampionBeacon.CarrierID,
		},
		Events: events,
	}
	state.StateHash = HashState(state)
	return state, nil
}

// resourceCapacity 计算资源容量（核心容量公式：见 Reduce 注释）。
func resourceCapacity(population int) int {
	capacity := population * coreCapacityPerUnit
	if capacity < coreMinCapacity {
		return coreMinCapacity
	}
	return capacity
}

// beaconStatusOf 转换可空 beacon status（缺失 → 空值，语义同 TS 透传 null）。
func beaconStatusOf(status *contracts.BeaconStatus) BeaconStatus {
	if status == nil {
		return ""
	}
	return BeaconStatus(*status)
}

// toPosition 转换 contracts.Position → domain.Position（同构拷贝）。
func toPosition(position contracts.Position) Position {
	return Position{position[0], position[1]}
}

// reduceUnit 从受控 UNIT 对象构造单位快照（cargo 仅 WORKER 有效）。
func reduceUnit(object *contracts.Object) UnitSnapshot {
	cargo := 0
	if contracts.UnitType(object.UnitType) == contracts.UnitTypeWorker && object.Cargo != nil {
		cargo = *object.Cargo
	}
	return UnitSnapshot{
		ID:       object.ID,
		Position: toPosition(*object.Position),
		HP:       *object.HP,
		UnitType: UnitType(object.UnitType),
		Cargo:    cargo,
	}
}

// reduceCore 从受控 CORE 对象构造 Core 快照（state 非 "MOVING" 一律
// NORMAL，与 TS 版 reduceCore 同语义）。
func reduceCore(object *contracts.Object) *Core {
	state := CoreNormal
	if object.State == string(contracts.CoreStateMoving) {
		state = CoreMoving
	}
	return &Core{
		ID:            object.ID,
		Position:      toPosition(*object.Position),
		HP:            *object.HP,
		Shield:        *object.Shield,
		State:         state,
		OwnerUsername: object.OwnerUsername,
	}
}

// reduceEnemy 从非受控 UNIT/CORE 对象构造敌方实体快照。
func reduceEnemy(object *contracts.Object) VisibleEntity {
	enemy := VisibleEntity{
		ID:       object.ID,
		Kind:     string(object.Kind),
		Position: toPosition(*object.Position),
		HP:       *object.HP,
	}
	if object.UnitType != "" {
		unitType := UnitType(object.UnitType)
		enemy.UnitType = &unitType
	}
	if object.OwnerUsername != "" {
		owner := object.OwnerUsername
		enemy.OwnerUsername = &owner
	}
	return enemy
}

// reduceEvent 规范化单个结算事件（缺失字段按 TS 版兜底：eventId 合成、
// tick 取当前 tick、eventType 记 UNKNOWN）。
func reduceEvent(event *contracts.Event, currentTick, index int) Event {
	eventID := event.EventID
	if eventID == "" {
		eventID = fmt.Sprintf("synthetic:%d:%d", currentTick, index)
	}
	eventTick := event.Tick
	if eventTick < 1 {
		eventTick = currentTick
	}
	eventType := event.EventType
	if eventType == "" {
		eventType = "UNKNOWN"
	}
	result := Event{
		EventID:    eventID,
		Tick:       eventTick,
		EventType:  eventType,
		ReasonCode: event.ReasonCode,
		ActorID:    event.ActorID,
		TargetID:   event.TargetID,
		Values:     copyValues(event.Values),
	}
	if event.Position != nil {
		position := toPosition(*event.Position)
		result.Position = &position
	}
	return result
}

// copyValues 拷贝事件 values（避免与契约记录共享可变 map）。
func copyValues(values map[string]any) map[string]any {
	if values == nil {
		return nil
	}
	copy := make(map[string]any, len(values))
	for key, value := range values {
		copy[key] = value
	}
	return copy
}

// classifyUnits 从已按 ID 排序的单位中筛选指定类型（保持升序，
// 与 TS 版 selectControllers 后排序的语义一致）。
func classifyUnits(units []UnitSnapshot, unitType UnitType) []UnitSnapshot {
	filtered := make([]UnitSnapshot, 0)
	for _, unit := range units {
		if unit.UnitType == unitType {
			filtered = append(filtered, unit)
		}
	}
	return filtered
}
