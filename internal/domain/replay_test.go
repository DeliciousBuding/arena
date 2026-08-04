package domain

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// replayState 是 replay-ts.jsonl 中冻结的 TS 版回放 state（期望值）。
// 注意：录制器只序列化了部分字段（enemies 仅 id/position/unit_type，
// 无 status/tick/events/stateHash），比对范围与冻结格式一致。
type replayState struct {
	Resources        int           `json:"resources"`
	Population       int           `json:"population"`
	ResourceCapacity int           `json:"resource_capacity"`
	ResourceSpace    int           `json:"resource_space"`
	Core             *replayCore   `json:"core"`
	Units            []replayUnit  `json:"units"`
	Enemies          []replayEnemy `json:"enemies"`
	ResourceCells    [][2]int      `json:"resource_cells"`
	ObstacleCells    [][2]int      `json:"obstacle_cells"`
	Beacon           *replayBeacon `json:"beacon"`
}

type replayLine struct {
	Tick  int         `json:"tick"`
	State replayState `json:"state"`
}

type replayCore struct {
	ID       string `json:"id"`
	Position [2]int `json:"position"`
	HP       int    `json:"hp"`
	Shield   int    `json:"shield"`
	State    string `json:"state"`
}

type replayUnit struct {
	ID       string `json:"id"`
	Position [2]int `json:"position"`
	HP       int    `json:"hp"`
	Cargo    int    `json:"cargo"`
	UnitType string `json:"unit_type"`
}

type replayEnemy struct {
	ID       string  `json:"id"`
	Position [2]int  `json:"position"`
	UnitType *string `json:"unit_type"`
}

type replayBeacon struct {
	Position  [2]int  `json:"position"`
	Status    *string `json:"status"`
	CarrierID *string `json:"carrier_id"`
}

// loadReplayExpectations 解析冻结的 TS 回放期望（tick → state）。
func loadReplayExpectations(t *testing.T) map[int]replayState {
	t.Helper()
	file, err := os.Open(expectedReplayPath)
	if err != nil {
		t.Fatalf("open expected replay: %v", err)
	}
	defer file.Close()
	expectations := make(map[int]replayState)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry replayLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("parse replay line: %v", err)
		}
		expectations[entry.Tick] = entry.State
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan replay: %v", err)
	}
	return expectations
}

// TestReplayMatchesTSExpected 全量 100 tick 回放：reducer 输出与 TS 版冻结
// 期望逐字段一致（M3 验收：fixture 回放）。
func TestReplayMatchesTSExpected(t *testing.T) {
	expectations := loadReplayExpectations(t)
	if len(expectations) != 100 {
		t.Fatalf("expected 100 replay ticks, got %d", len(expectations))
	}
	ticks := make([]int, 0, len(expectations))
	for tick := range expectations {
		ticks = append(ticks, tick)
	}
	sort.Ints(ticks)
	for _, tick := range ticks {
		state := reduceFixture(t, tick)
		expected := expectations[tick]
		assertReplayState(t, tick, state, expected)
	}
}

// TestReplayAllTicksInvariants 全量回放不变量：全部 ACTIVE、分类计数自洽、
// 单位按 ID 升序、容量公式一致、stateHash 稳定。
func TestReplayAllTicksInvariants(t *testing.T) {
	ticks := sortedFixtureTicks(t)
	for _, tick := range ticks {
		state := reduceFixture(t, tick)
		if state.Status != PlayerStatusActive {
			t.Errorf("tick %d: status = %q, want ACTIVE", tick, state.Status)
		}
		if len(state.Units) != len(state.Workers)+len(state.Vanguards)+len(state.Rangers) {
			t.Errorf("tick %d: classification counts inconsistent", tick)
		}
		if len(state.Units) > 0 && state.Units[0].ID == "" {
			t.Errorf("tick %d: empty unit id", tick)
		}
		for i := 1; i < len(state.Units); i++ {
			if state.Units[i-1].ID >= state.Units[i].ID {
				t.Errorf("tick %d: units not sorted at %d", tick, i)
			}
		}
		expectedCapacity := 10
		if capacity := state.Population * 5; capacity > expectedCapacity {
			expectedCapacity = capacity
		}
		if state.ResourceCapacity != expectedCapacity {
			t.Errorf("tick %d: capacity = %d, want %d", tick, state.ResourceCapacity, expectedCapacity)
		}
		if state.ResourceSpace != state.ResourceCapacity-state.Resources {
			t.Errorf("tick %d: space = %d, want capacity - resources", tick, state.ResourceSpace)
		}
		reducedAgain, err := Reduce(parseFixtureRecord(t, tick), tick)
		if err != nil {
			t.Fatalf("tick %d: re-reduce: %v", tick, err)
		}
		if reducedAgain.StateHash != state.StateHash {
			t.Errorf("tick %d: state hash not deterministic", tick)
		}
	}
}

// assertReplayState 逐字段断言 reducer 输出与 TS 期望一致。
func assertReplayState(t *testing.T, tick int, state *TickState, expected replayState) {
	t.Helper()
	if state.Resources != expected.Resources {
		t.Errorf("tick %d: resources = %d, want %d", tick, state.Resources, expected.Resources)
	}
	if state.Population != expected.Population {
		t.Errorf("tick %d: population = %d, want %d", tick, state.Population, expected.Population)
	}
	if state.ResourceCapacity != expected.ResourceCapacity {
		t.Errorf("tick %d: capacity = %d, want %d", tick, state.ResourceCapacity, expected.ResourceCapacity)
	}
	if state.ResourceSpace != expected.ResourceSpace {
		t.Errorf("tick %d: space = %d, want %d", tick, state.ResourceSpace, expected.ResourceSpace)
	}
	if expected.Core == nil {
		if state.Core != nil {
			t.Errorf("tick %d: core = %+v, want nil", tick, state.Core)
		}
	} else {
		if state.Core == nil {
			t.Fatalf("tick %d: core is nil, want %+v", tick, expected.Core)
		}
		if state.Core.ID != expected.Core.ID ||
			state.Core.Position != (Position{expected.Core.Position[0], expected.Core.Position[1]}) ||
			state.Core.HP != expected.Core.HP ||
			state.Core.Shield != expected.Core.Shield ||
			string(state.Core.State) != expected.Core.State {
			t.Errorf("tick %d: core = %+v, want %+v", tick, state.Core, expected.Core)
		}
	}
	expectedUnits := make(map[string]replayUnit, len(expected.Units))
	for _, unit := range expected.Units {
		expectedUnits[unit.ID] = unit
	}
	if len(state.Units) != len(expectedUnits) {
		t.Fatalf("tick %d: units = %d, want %d", tick, len(state.Units), len(expectedUnits))
	}
	for _, unit := range state.Units {
		want, ok := expectedUnits[unit.ID]
		if !ok {
			t.Errorf("tick %d: unexpected unit %s", tick, unit.ID)
			continue
		}
		if unit.Position != (Position{want.Position[0], want.Position[1]}) ||
			unit.HP != want.HP || unit.Cargo != want.Cargo ||
			string(unit.UnitType) != want.UnitType {
			t.Errorf("tick %d: unit %s = %+v, want %+v", tick, unit.ID, unit, want)
		}
	}
	expectedEnemies := make(map[string]replayEnemy, len(expected.Enemies))
	for _, enemy := range expected.Enemies {
		expectedEnemies[enemy.ID] = enemy
	}
	if len(state.VisibleEnemies) != len(expectedEnemies) {
		t.Fatalf("tick %d: enemies = %d, want %d", tick, len(state.VisibleEnemies), len(expectedEnemies))
	}
	for _, enemy := range state.VisibleEnemies {
		want, ok := expectedEnemies[enemy.ID]
		if !ok {
			t.Errorf("tick %d: unexpected enemy %s", tick, enemy.ID)
			continue
		}
		if enemy.Position != (Position{want.Position[0], want.Position[1]}) {
			t.Errorf("tick %d: enemy %s position = %v, want %v", tick, enemy.ID, enemy.Position, want.Position)
		}
		gotType := ""
		if enemy.UnitType != nil {
			gotType = string(*enemy.UnitType)
		}
		wantType := ""
		if want.UnitType != nil {
			wantType = *want.UnitType
		}
		if gotType != wantType {
			t.Errorf("tick %d: enemy %s unit_type = %q, want %q", tick, enemy.ID, gotType, wantType)
		}
	}
	if !sameCellSet(state.ResourceCells, expected.ResourceCells) {
		t.Errorf("tick %d: resource cells = %v, want %v", tick, state.ResourceCells, expected.ResourceCells)
	}
	if !sameCellSet(state.ObstacleCells, expected.ObstacleCells) {
		t.Errorf("tick %d: obstacle cells mismatch (got %d, want %d)",
			tick, state.ObstacleCells.Len(), len(expected.ObstacleCells))
	}
	if expected.Beacon != nil {
		if state.Beacon.Position != (Position{expected.Beacon.Position[0], expected.Beacon.Position[1]}) {
			t.Errorf("tick %d: beacon position = %v, want %v",
				tick, state.Beacon.Position, expected.Beacon.Position)
		}
		wantStatus := ""
		if expected.Beacon.Status != nil {
			wantStatus = *expected.Beacon.Status
		}
		if string(state.Beacon.Status) != wantStatus {
			t.Errorf("tick %d: beacon status = %q, want %q", tick, state.Beacon.Status, wantStatus)
		}
		wantCarrier := ""
		if expected.Beacon.CarrierID != nil {
			wantCarrier = *expected.Beacon.CarrierID
		}
		gotCarrier := ""
		if state.Beacon.CarrierID != nil {
			gotCarrier = *state.Beacon.CarrierID
		}
		if gotCarrier != wantCarrier {
			t.Errorf("tick %d: beacon carrier = %q, want %q", tick, gotCarrier, wantCarrier)
		}
	}
}

// sameCellSet 比较 cell-key 集合与 [x,y] 数组列表（顺序无关）。
func sameCellSet(got Set[string], want [][2]int) bool {
	if got.Len() != len(want) {
		return false
	}
	for _, cell := range want {
		if !got.Contains(CellKey(cell[0], cell[1])) {
			return false
		}
	}
	return true
}

// sortedFixtureTicks 列出 fixture 目录中的 tick（升序）。
func sortedFixtureTicks(t *testing.T) []int {
	t.Helper()
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	ticks := make([]int, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		tick, err := strconv.Atoi(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			continue
		}
		ticks = append(ticks, tick)
	}
	sort.Ints(ticks)
	return ticks
}

// parseFixtureRecord 读取指定 tick 的 fixture record（未归约）。
func parseFixtureRecord(t *testing.T, tick int) *contracts.DifferentialRecord {
	t.Helper()
	path := filepath.Join(fixtureDir, strconv.Itoa(tick)+".json")
	record, err := contracts.ParseRecordFile(path)
	if err != nil {
		t.Fatalf("parse record %d: %v", tick, err)
	}
	return record
}
