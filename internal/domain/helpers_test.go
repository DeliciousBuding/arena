package domain

import (
	"path/filepath"
	"strconv"
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// fixtureDir 是差分 fixture 目录（测试运行目录 = internal/domain）。
const fixtureDir = "../../fixtures/differential/burnin-20260802-a"

// expectedReplayPath 是 TS 版回放期望（M3 验收：期望冻结于 testdata/expected/，
// 由 TS 版回放结果导出）。
const expectedReplayPath = "testdata/expected/replay-ts.jsonl"

// reduceFixture 读取并归约指定 tick 的 fixture record。
func reduceFixture(t *testing.T, tick int) *TickState {
	t.Helper()
	path := filepath.Join(fixtureDir, strconv.Itoa(tick)+".json")
	record, err := contracts.ParseRecordFile(path)
	if err != nil {
		t.Fatalf("parse record %d: %v", tick, err)
	}
	state, err := Reduce(record, tick)
	if err != nil {
		t.Fatalf("reduce %d: %v", tick, err)
	}
	return state
}

// keySet 从坐标构造 cell-key 集合。
func keySet(positions ...Position) Set[string] {
	set := make(Set[string], len(positions))
	for _, position := range positions {
		set.Add(CellKey(position[0], position[1]))
	}
	return set
}

func strPtr(value string) *string {
	return &value
}

func dirPtr(value Direction) *Direction {
	return &value
}

func posPtr(value Position) *Position {
	return &value
}

func unitTypePtr(value UnitType) *UnitType {
	return &value
}

// baseValidatorState 构造 plan-validator 测试用基础状态。
func baseValidatorState() *TickState {
	return &TickState{
		Tick:          1,
		Status:        PlayerStatusActive,
		Resources:     5,
		ResourceSpace: 10,
		Core: &Core{
			ID:       "core-1",
			Position: Position{0, 0},
			HP:       5,
			Shield:   5,
			State:    CoreNormal,
		},
		Units: []UnitSnapshot{
			{ID: "worker-1", Position: Position{0, 0}, HP: 1, UnitType: UnitWorker, Cargo: 1},
			{ID: "worker-2", Position: Position{3, 3}, HP: 2, UnitType: UnitWorker, Cargo: 0},
			{ID: "vanguard-1", Position: Position{5, 5}, HP: 4, UnitType: UnitVanguard},
			{ID: "ranger-1", Position: Position{0, 0}, HP: 2, UnitType: UnitRanger},
		},
		VisibleEnemies: []VisibleEntity{
			{ID: "enemy-1", Kind: "UNIT", Position: Position{0, 3}, HP: 2, UnitType: unitTypePtr(UnitVanguard)},
		},
		ResourceCells: NewSet(CellKey(3, 3)),
		ObstacleCells: NewSet(CellKey(0, -1)),
		Beacon: Beacon{
			Position: Position{5, 5},
			Status:   BeaconGround,
		},
	}
}
