// Package strategy 的 shadow 双跑验证器（fusion-line.md §3 F3）：
// ShadowPlanner 在同一 tick 流上并行驱动 Go 原生 planner 与 Rust
// FFI planner，逐字段对比两份决策并落盘 decision.jsonl 差分报告。
// 生产决策不受影响：Decide 返回 Go 计划，Rust 计划仅观察对比。

package strategy

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"sync"

	"github.com/deliciousbuding/arena/internal/domain"
)

// rustDecider 是 ShadowPlanner 依赖的 Rust 侧决策接口（*FfiPlanner
// 实现；测试注入 mock 反向验证对比器会报警）。
type rustDecider interface {
	Decide(state *domain.TickState) *domain.Plan
	ApplyDirective(directive Directive)
	Close()
}

// ShadowPlanner 包装 Go 原生 planner + Rust FFI planner，实现
// runtime.Planner 接口（Decide/ApplyDirective）。
type ShadowPlanner struct {
	goPlanner   *Planner
	rustPlanner rustDecider
	logger      *slog.Logger

	mu                  sync.Mutex
	logFile             *os.File
	matchCount          int
	divergenceCount     int
	firstDivergenceTick int // 0 = 无差异
}

// NewShadowPlanner 构造 shadow 双跑验证器。logPath 为空时跳过
// decision.jsonl 落盘（仅保留统计）。
func NewShadowPlanner(goPlanner *Planner, rustPlanner *FfiPlanner, logPath string, logger *slog.Logger) *ShadowPlanner {
	return newShadowPlanner(goPlanner, rustPlanner, logPath, logger)
}

// newShadowPlanner 是接口注入版本（测试可注入 mock rust planner）。
func newShadowPlanner(goPlanner *Planner, rustPlanner rustDecider, logPath string, logger *slog.Logger) *ShadowPlanner {
	if logger == nil {
		logger = slog.Default()
	}
	shadow := &ShadowPlanner{
		goPlanner:   goPlanner,
		rustPlanner: rustPlanner,
		logger:      logger,
	}
	if logPath != "" {
		file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			logger.Warn("shadow decision log open failed", "path", logPath, "err", err)
		} else {
			shadow.logFile = file
		}
	}
	// 诚实性提示：rust 句柄为空 = FfiPlanner 已回退 Go planner，
	// 此时对比是 Go-vs-Go，diff 报告不构成 parity 证据。
	if ffi, ok := rustPlanner.(*FfiPlanner); ok && ffi.IsFallback() {
		logger.Warn("shadow: rust planner in Go fallback mode (FFI unavailable); comparison is Go-vs-Go")
	}
	return shadow
}

// Decide 先调 Go planner 得 goPlan，再调 Rust planner 得 rustPlan，
// 逐字段对比、写 decision.jsonl 一行，返回 goPlan（生产路径不受
// shadow 影响）。
func (p *ShadowPlanner) Decide(state *domain.TickState) *domain.Plan {
	goPlan := p.goPlanner.Decide(state)
	rustPlan := p.rustPlanner.Decide(state)
	matched, diff := comparePlans(goPlan, rustPlan)

	p.mu.Lock()
	if matched {
		p.matchCount++
	} else {
		p.divergenceCount++
		if p.firstDivergenceTick == 0 {
			p.firstDivergenceTick = state.Tick
		}
	}
	if p.logFile != nil {
		if line, err := json.Marshal(shadowRecord{
			Tick:  state.Tick,
			Match: matched,
			Go:    goPlan,
			Rust:  rustPlan,
			Diff:  diff,
		}); err == nil {
			if _, err := p.logFile.Write(append(line, '\n')); err != nil {
				p.logger.Warn("shadow decision log write failed", "tick", state.Tick, "err", err)
			}
		}
	}
	p.mu.Unlock()
	return goPlan
}

// ApplyDirective 把指挥层指令转发给两个 planner（顺序固定，双方
// 保持同输入序列）。
func (p *ShadowPlanner) ApplyDirective(directive Directive) {
	p.goPlanner.ApplyDirective(directive)
	p.rustPlanner.ApplyDirective(directive)
}

// Close 关闭 decision.jsonl 并释放 Rust planner 句柄。
func (p *ShadowPlanner) Close() {
	p.mu.Lock()
	if p.logFile != nil {
		p.logFile.Close()
		p.logFile = nil
	}
	p.mu.Unlock()
	p.rustPlanner.Close()
}

// ShadowStats 是 shadow 双跑统计（供 runner 汇总）。
type ShadowStats struct {
	MatchCount          int
	DivergenceCount     int
	FirstDivergenceTick int // 0 = 全程无差异
}

// Stats 返回当前统计。
func (p *ShadowPlanner) Stats() ShadowStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return ShadowStats{
		MatchCount:          p.matchCount,
		DivergenceCount:     p.divergenceCount,
		FirstDivergenceTick: p.firstDivergenceTick,
	}
}

// shadowRecord 是 decision.jsonl 单行结构。
type shadowRecord struct {
	Tick  int          `json:"tick"`
	Match bool         `json:"match"`
	Go    *domain.Plan `json:"go"`
	Rust  *domain.Plan `json:"rust"`
	Diff  []string     `json:"diff"`
}

// comparePlans 逐字段对比 Go/Rust 计划（fusion-line.md §2 契约字段）：
//   - 单位动作集合：unit ID 集合相等 + 每单位 Kind/Direction/TargetID；
//   - Core 动作：存在性与 Kind/UnitType；
//   - intents 相等；
//   - 计划 tick 一致性（双跑同 state 流基线）。
//
// 返回 match + 不一致项描述列表（nil = 一致）。
func comparePlans(goPlan, rustPlan *domain.Plan) (bool, []string) {
	var diff []string
	record := func(format string, args ...any) {
		diff = append(diff, fmt.Sprintf(format, args...))
	}

	if goPlan.Tick != rustPlan.Tick {
		record("tick: go=%d rust=%d", goPlan.Tick, rustPlan.Tick)
	}

	// 单位动作集合：ID 集合对称差 + 公共单位逐字段。
	goIDs := sortedPlanUnitIDs(goPlan)
	rustIDs := sortedPlanUnitIDs(rustPlan)
	for goIdx, rustIdx := 0, 0; goIdx < len(goIDs) || rustIdx < len(rustIDs); {
		switch {
		case goIdx >= len(goIDs):
			record("unit %s: go=absent rust=present", rustIDs[rustIdx])
			rustIdx++
		case rustIdx >= len(rustIDs):
			record("unit %s: go=present rust=absent", goIDs[goIdx])
			goIdx++
		case goIDs[goIdx] == rustIDs[rustIdx]:
			compareUnitAction(goIDs[goIdx], goPlan.UnitActions[goIDs[goIdx]], rustPlan.UnitActions[rustIDs[rustIdx]], record)
			goIdx++
			rustIdx++
		case goIDs[goIdx] < rustIDs[rustIdx]:
			record("unit %s: go=present rust=absent", goIDs[goIdx])
			goIdx++
		default:
			record("unit %s: go=absent rust=present", rustIDs[rustIdx])
			rustIdx++
		}
	}

	// Core 动作：存在性 + Kind/UnitType。
	compareCoreAction(goPlan.CoreAction, rustPlan.CoreAction, record)

	// intents：完整 map 相等。
	compareIntents(goPlan.Intents, rustPlan.Intents, record)

	return len(diff) == 0, diff
}

// compareUnitAction 对比单个单位的动作（Kind/Direction/TargetID）。
func compareUnitAction(unitID string, goAction, rustAction domain.UnitAction, record func(string, ...any)) {
	if goAction.Kind != rustAction.Kind {
		record("unit %s: kind go=%s rust=%s", unitID, goAction.Kind, rustAction.Kind)
	}
	goDir := directionString(goAction.Direction)
	rustDir := directionString(rustAction.Direction)
	if goDir != rustDir {
		record("unit %s: direction go=%s rust=%s", unitID, goDir, rustDir)
	}
	if !equalStringPtr(goAction.TargetID, rustAction.TargetID) {
		record("unit %s: targetID go=%s rust=%s", unitID, stringPtrOrNil(goAction.TargetID), stringPtrOrNil(rustAction.TargetID))
	}
}

// compareCoreAction 对比 Core 动作（存在性 + Kind/UnitType）。
func compareCoreAction(goAction, rustAction *domain.CoreAction, record func(string, ...any)) {
	switch {
	case goAction == nil && rustAction == nil:
	case goAction == nil:
		record("core: go=absent rust=%s", rustAction.Kind)
	case rustAction == nil:
		record("core: go=%s rust=absent", goAction.Kind)
	case goAction.Kind != rustAction.Kind:
		record("core: kind go=%s rust=%s", goAction.Kind, rustAction.Kind)
	case !equalStringPtr(goAction.UnitType, rustAction.UnitType):
		record("core: unitType go=%s rust=%s", unitTypeOrNil(goAction.UnitType), unitTypeOrNil(rustAction.UnitType))
	}
}

// compareIntents 对比 intents map（完整相等，含 core 键）。
func compareIntents(goIntents, rustIntents map[string]string, record func(string, ...any)) {
	goKeys := sortedMapKeys(goIntents)
	rustKeys := sortedMapKeys(rustIntents)
	for goIdx, rustIdx := 0, 0; goIdx < len(goKeys) || rustIdx < len(rustKeys); {
		switch {
		case goIdx >= len(goKeys):
			record("intent %s: go=absent rust=%s", rustKeys[rustIdx], rustIntents[rustKeys[rustIdx]])
			rustIdx++
		case rustIdx >= len(rustKeys):
			record("intent %s: go=%s rust=absent", goKeys[goIdx], goIntents[goKeys[goIdx]])
			goIdx++
		case goKeys[goIdx] == rustKeys[rustIdx]:
			if goIntents[goKeys[goIdx]] != rustIntents[rustKeys[rustIdx]] {
				record("intent %s: go=%s rust=%s", goKeys[goIdx], goIntents[goKeys[goIdx]], rustIntents[rustKeys[rustIdx]])
			}
			goIdx++
			rustIdx++
		case goKeys[goIdx] < rustKeys[rustIdx]:
			record("intent %s: go=%s rust=absent", goKeys[goIdx], goIntents[goKeys[goIdx]])
			goIdx++
		default:
			record("intent %s: go=absent rust=%s", rustKeys[rustIdx], rustIntents[rustKeys[rustIdx]])
			rustIdx++
		}
	}
}

// sortedPlanUnitIDs 返回 UnitActions 的 key 列表（确定性排序）。
func sortedPlanUnitIDs(plan *domain.Plan) []string {
	ids := make([]string, 0, len(plan.UnitActions))
	for id := range plan.UnitActions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// sortedMapKeys 返回 map 的 key 列表（确定性排序）。
func sortedMapKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// directionString 解引用方向指针（nil → "<nil>"）。
func directionString(direction *domain.Direction) string {
	if direction == nil {
		return "<nil>"
	}
	return string(*direction)
}

// stringPtrOrNil 解引用字符串指针（nil → "<nil>"）。
func stringPtrOrNil(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

// unitTypeOrNil 解引用单位类型指针（nil → "<nil>"）。
func unitTypeOrNil(value *domain.UnitType) string {
	if value == nil {
		return "<nil>"
	}
	return string(*value)
}

// equalStringPtr 比较两个字符串指针的值（nil 与 nil 相等）。
func equalStringPtr[T ~string](a, b *T) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
