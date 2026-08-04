package strategy

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
)

// fixtureDir 是差分 fixture 目录（测试运行目录 = internal/strategy，
// 相对仓库根 ../../fixtures/...，与 internal/domain 的定位方式一致）。
const fixtureDir = "../../fixtures/differential/burnin-20260802-a"

// fixtureTickCount 是 manifest.json segments[0].ticks 的期望数量。
const fixtureTickCount = 100

// fixtureTicks 列出 fixture 目录中的 record tick（升序，跳过 manifest）。
func fixtureTicks(t *testing.T) []int {
	t.Helper()
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir %s: %v", fixtureDir, err)
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

// reduceFixtureRecord 读取并归约指定 tick 的 fixture record（真实数据）。
func reduceFixtureRecord(t *testing.T, tick int) *domain.TickState {
	t.Helper()
	path := filepath.Join(fixtureDir, strconv.Itoa(tick)+".json")
	record, err := contracts.ParseRecordFile(path)
	if err != nil {
		t.Fatalf("parse record %d (%s): %v", tick, path, err)
	}
	state, err := domain.Reduce(record, tick)
	if err != nil {
		t.Fatalf("reduce tick %d: %v", tick, err)
	}
	return state
}

// marshalPlan 将计划序列化为确定性字节（encoding/json 对 map 键排序，
// 同输入两次调用输出字节相同）。
func marshalPlan(t *testing.T, plan *domain.Plan) []byte {
	t.Helper()
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	return data
}

// TestReplayAllTicksProduceValidPlans 全量 100 tick 回放（M4 核心验收）：
// ParseRecordFile → domain.Reduce → NewPlanner(DefaultConfig()).Decide，
// 每个 tick 产出合法计划（domain.ValidatePlan 复核 valid=true），不 panic。
// 单个 planner 实例跨 tick 复用，与 TS 版按 segment 重建决策链的语义一致。
func TestReplayAllTicksProduceValidPlans(t *testing.T) {
	ticks := fixtureTicks(t)
	if len(ticks) != fixtureTickCount {
		t.Fatalf("expected %d fixture ticks, got %d", fixtureTickCount, len(ticks))
	}

	planner := NewPlanner(DefaultConfig())
	for _, tick := range ticks {
		state := reduceFixtureRecord(t, tick)

		plan := planner.Decide(state)
		if plan == nil {
			t.Fatalf("tick %d: nil plan", tick)
		}
		if plan.Tick != tick {
			t.Errorf("tick %d: plan tick = %d", tick, plan.Tick)
		}
		result := domain.ValidatePlan(state, *plan)
		if !result.Valid {
			t.Errorf("tick %d: plan invalid (%d issues): %v", tick, len(result.Issues), result.Issues)
		}
	}
}

// TestReplayDeterministicAcrossFreshPlanners 确定性（M4 验收：同输入两次
// 调用输出字节相同）：每个 tick 用两个全新 planner 实例（exploreIndex 均
// 从 0 起）各自 Decide，序列化字节必须完全一致。
func TestReplayDeterministicAcrossFreshPlanners(t *testing.T) {
	for _, tick := range fixtureTicks(t) {
		state := reduceFixtureRecord(t, tick)

		planA := NewPlanner(DefaultConfig()).Decide(state)
		planB := NewPlanner(DefaultConfig()).Decide(state)

		bytesA := marshalPlan(t, planA)
		bytesB := marshalPlan(t, planB)
		if !bytes.Equal(bytesA, bytesB) {
			t.Errorf("tick %d: nondeterministic output:\nA=%s\nB=%s", tick, bytesA, bytesB)
		}
	}
}

// TestReplayActionDistribution 统计 100 tick 回放的 action 分布：
// 每类 UnitActionKind 计数 + Core 动作 tick 数，断言分布合理
// （必须有 MOVE；Core 动作数按实际输出记录）。
func TestReplayActionDistribution(t *testing.T) {
	counts := map[domain.UnitActionKind]int{}
	coreActionTicks := 0
	totalActions := 0

	planner := NewPlanner(DefaultConfig())
	for _, tick := range fixtureTicks(t) {
		state := reduceFixtureRecord(t, tick)
		plan := planner.Decide(state)
		for _, action := range plan.UnitActions {
			counts[action.Kind]++
			totalActions++
		}
		if plan.CoreAction != nil {
			coreActionTicks++
		}
	}

	distribution := make([]string, 0, len(counts))
	for kind, count := range counts {
		distribution = append(distribution, string(kind)+"="+strconv.Itoa(count))
	}
	sort.Strings(distribution)
	t.Logf("tick=%d unit actions: %d, distribution: %s, core action ticks: %d",
		fixtureTickCount, totalActions, strings.Join(distribution, " "), coreActionTicks)

	if totalActions == 0 {
		t.Fatal("expected at least one unit action across the replay")
	}
	if counts[domain.ActionMove] == 0 {
		t.Errorf("expected at least one MOVE action, got distribution %v", counts)
	}

	// 按实际输出记录：本 fixture 资源峰值 2 < WORKER 成本 5 且 Core 恒满血，
	// 因此回放不应出现 Core 动作（spawn/heal 均不触发）。
	if coreActionTicks != 0 {
		t.Errorf("expected 0 core action ticks (max resources 2 < spawn cost 5, core always full HP), got %d", coreActionTicks)
	}
}

// TestReplayActionsReferenceControlledUnits 健全性：每个 plan 的动作只
// 引用状态中实际存在的受控单位（validator 隐含覆盖，此处显式断言）。
func TestReplayActionsReferenceControlledUnits(t *testing.T) {
	planner := NewPlanner(DefaultConfig())
	for _, tick := range fixtureTicks(t) {
		state := reduceFixtureRecord(t, tick)
		plan := planner.Decide(state)

		controlled := make(map[string]bool, len(state.Units))
		for _, unit := range state.Units {
			controlled[unit.ID] = true
		}
		for unitID := range plan.UnitActions {
			if !controlled[unitID] {
				t.Errorf("tick %d: action for unknown unit %q", tick, unitID)
			}
		}
		if plan.CoreAction != nil && state.Core == nil {
			t.Errorf("tick %d: core action without controlled core", tick)
		}
	}
}

// TestReplayEveryTickProducesNonEmptyPlan 健全性：100 tick 中每个 tick 都
// 产出计划（tick 字段一致），且至少存在一个带动作的 tick（避免全空输出
// 的退化通过）。
func TestReplayEveryTickProducesNonEmptyPlan(t *testing.T) {
	planner := NewPlanner(DefaultConfig())
	ticksWithActions := 0
	for _, tick := range fixtureTicks(t) {
		state := reduceFixtureRecord(t, tick)
		plan := planner.Decide(state)
		if plan.Tick != tick {
			t.Errorf("tick %d: plan tick = %d", tick, plan.Tick)
		}
		if len(plan.UnitActions) > 0 {
			ticksWithActions++
		}
	}
	if ticksWithActions == 0 {
		t.Fatal("expected at least one tick with unit actions")
	}
}
