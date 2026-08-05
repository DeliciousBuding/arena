// Package runtime 实现租户运行循环（纵向闭环最小版）。
// 阶段 B 语义：events → reduce → decide → validate → 提交（shadow/live 由提交模式决定）。
// 可观测性：统一经 obs.Obs（事件/metrics/卡顿与死锁检测，docs/go/07-observability.md）。
package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/hero"
	"github.com/deliciousbuding/arena/internal/obs"
	"github.com/deliciousbuding/arena/internal/strategy"
	"github.com/deliciousbuding/arena/internal/telemetry"
)

// SubmissionMode 是提交模式。
type SubmissionMode string

// SubmissionMode 枚举。
const (
	ModeShadow SubmissionMode = "shadow" // 只决策不提交
	ModeLive   SubmissionMode = "live"   // 提交真实计划
)

// 卡顿/死锁检测阈值（docs/go/07-observability.md §5）。
const (
	tickGapWarnThreshold  = 45 * time.Second // tick 间隔告警（服务器停顿或客户端卡）
	handleStateSlowMS     = 500              // handleState 慢告警（正常 0ms）
	idleDumpInterval      = 30 * time.Second // 静默栈 dump
	idleDumpEscalateAfter = 60 * time.Second // 静默升级（重复告警）
)

// TenantConfig 是租户运行配置（不包含密钥值）。
type TenantConfig struct {
	TenantID       string
	BaseURL        string
	DecisionMode   string
	SubmissionMode SubmissionMode
	MaxTicks       int    // 0 = 无限
	BaseDir        string // 运行时根目录（dump 文件落盘用）
}

// Stats 是运行统计。
type Stats struct {
	ProcessedTicks  atomic.Int64
	LiveSubmits     atomic.Int64
	RejectedSubmits atomic.Int64
	RepairedPlans   atomic.Int64
	LastTick        atomic.Int64
}

// GameClient 是 Loop 依赖的最小客户端接口（hero.ArenaHeroClient 天然实现；
// 测试注入桩以验证重复 tick/提交拒绝等行为）。
type GameClient interface {
	Events(ctx context.Context) <-chan hero.Event
	Err() error
	Submit(ctx context.Context, plan contracts.CommandPlan, idempotencyKey string) (*contracts.Accepted, error)
	Close()
}

// Planner 是决策器接口（strategy.Planner 天然实现）。
type Planner interface {
	Decide(state *domain.TickState) *domain.Plan
	ApplyDirective(directive strategy.Directive)
}

// tickOutcome 是上一 tick 的决策摘要（下一 state 到达时生成 outcome：
// 状态间延迟一 tick，结算结果只能在下一快照里观察）。
type tickOutcome struct {
	resources             int
	workers               int
	plannedSpawn          bool
	fullWorkerFingerprint map[string]domain.Position // 满载 worker ID → 位置
}

// Loop 是单租户运行循环。
type Loop struct {
	Client      GameClient
	Planner     Planner
	World       *domain.World // 跨 tick 世界记忆（nil 时跳过 Observe，测试兼容）
	Config      TenantConfig
	Obs         *obs.Obs // 统一可观测句柄（nil 时降级：仅 Logger）
	Logger      *slog.Logger
	RuntimeLog  *telemetry.JsonlWriter
	DecisionLog *telemetry.JsonlWriter
	Stats       Stats
	// Commander 是指挥层（nil 时跳过指令下发，GROWTH 语义）。
	Commander *strategy.Commander
	// lastDirective 是最近一次指挥指令（遥测用）。
	lastDirective strategy.Directive

	// lastHandledTick 记录最近已进入决策的 tick（exactly-once 语义）：
	// 重连后服务器会重放已处理过的 Tick，任何重复 state 必须在
	// Reduce/Plan/Telemetry/Submit 之前按 Tick 去重——否则会重复决策、
	// 重复记账并污染赛马数据（30 Tick 实测 409 冲突根因）。
	lastHandledTick atomic.Int64
	// lastSubmittedTick 记录最近已提交的 tick（live 每 tick 只提交一次：
	// 服务器同 tick 可能推送多个 state 更新，stateHash 变化会产生不同
	// 幂等键导致 409 IDEMPOTENCY_CONFLICT——真机 30t 递进发现）。
	lastSubmittedTick atomic.Int64
	// lastTickAt 记录最近 tick 事件的到达时间（gap 检测）。
	lastTickAt atomic.Int64
	// idleDumpSeq 是栈 dump 序号（文件命名）。
	idleDumpSeq atomic.Int64
	// prevOutcome 是上一 tick 摘要（outcome 计算，首 tick 为空）。
	prevOutcome *tickOutcome
}

// logger 返回有效日志器（Obs 优先；全空时兜底默认 logger）。
func (l *Loop) logger() *slog.Logger {
	if l.Obs != nil {
		return l.Obs.Logger()
	}
	if l.Logger != nil {
		return l.Logger
	}
	return slog.Default()
}

// event 发出诊断事件（Obs nil 时降级为 Debug 日志）。
func (l *Loop) event(level slog.Level, name string, attrs ...any) {
	if l.Obs != nil {
		l.Obs.Event(level, name, attrs...)
	} else if l.Logger != nil {
		l.Logger.Log(nil, level, name, attrs...)
	}
}

// metrics 返回指标（Obs nil 时返回 nil，调用方判空）。
func (l *Loop) metrics() *obs.Metrics {
	if l.Obs != nil {
		return l.Obs.Metrics()
	}
	return nil
}

// Run 运行循环直到 ctx 取消或达到 MaxTicks。
// 每收到 state 事件：reduce → world observe → decide → validate →
// （live 时）submit。事件流异常终止（携带错误）时向上返回错误。
// 静默 30s dump 全 goroutine 栈（写日志 + 独立文件）；60s 升级重复告警。
func (l *Loop) Run(ctx context.Context) error {
	events := l.Client.Events(ctx)
	logger := l.logger()
	idleDump := time.NewTimer(idleDumpInterval)
	defer idleDump.Stop()
	resetIdleDump := func() {
		if !idleDump.Stop() {
			select {
			case <-idleDump.C:
			default:
			}
		}
		idleDump.Reset(idleDumpInterval)
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-idleDump.C:
			l.dumpStacks("idle 30s no events")
			idleDump.Reset(idleDumpEscalateAfter)
		case event, ok := <-events:
			resetIdleDump()
			if !ok {
				if err := l.Client.Err(); err != nil {
					return fmt.Errorf("game event stream ended: %w", err)
				}
				return nil
			}
			switch event.Kind {
			case hero.TickEvent:
				l.trackTickGap(int64(event.Tick))
				l.Stats.LastTick.Store(int64(event.Tick))
				logger.Debug("tick", "tick", event.Tick)
			case hero.StateEvent:
				if err := l.handleState(ctx, &event.State); err != nil {
					l.event(slog.LevelError, "state.handle_failed", "tick", l.Stats.LastTick.Load(), "error", err)
					// 红线：deterministic repair / submit rejection 都立即停
					// 止本轮，不再继续消费后续 tick（30 Tick 实测 409 后
					// 继续运行会掩盖问题并污染赛马数据）。
					return err
				}
			case hero.ReceivedEvent:
				logger.Debug("received", "tick", event.Received.Tick, "source", event.Received.Source)
			}
			if l.Config.MaxTicks > 0 && l.Stats.ProcessedTicks.Load() >= int64(l.Config.MaxTicks) {
				return nil
			}
		}
	}
}

// trackTickGap 检测 tick 间隔：超过阈值发 gap 告警（区分服务器停顿/客户端卡）。
func (l *Loop) trackTickGap(tick int64) {
	now := time.Now().UnixNano()
	last := l.lastTickAt.Swap(now)
	if last == 0 {
		return
	}
	gapMS := (now - last) / int64(time.Millisecond)
	if m := l.metrics(); m != nil {
		m.LastTickGapMS(gapMS)
	}
	if gapMS > int64(tickGapWarnThreshold/time.Millisecond) {
		l.event(slog.LevelWarn, obs.EventTickGapWarn, "tick", tick, "gap_ms", gapMS, "since_ms", gapMS)
	}
}

// dumpStacks 全 goroutine 栈 dump：写日志 + 独立文件（可复现）。
func (l *Loop) dumpStacks(reason string) {
	buf := make([]byte, 64<<10)
	n := runtime.Stack(buf, true)
	seq := l.idleDumpSeq.Add(1)
	l.event(slog.LevelWarn, obs.EventIdleDump, "reason", reason, "seq", seq)
	if m := l.metrics(); m != nil {
		m.IdleDump()
	}
	if l.Obs != nil && l.Config.BaseDir != "" {
		header := obs.Header(reason)
		stack := append([]byte(header), buf[:n]...)
		if path, err := obs.WriteStackDump(l.dumpDir(), l.runID(), int(seq), stack); err != nil {
			l.event(slog.LevelWarn, obs.EventErrorClassified, "class", obs.ErrorClassConfig, "error", err)
		} else {
			l.event(slog.LevelDebug, "idle.dump_saved", "path", path)
		}
	}
}

// dumpDir 返回租户目录（Obs 无 tenantDir 信息时返回空）。
func (l *Loop) dumpDir() string {
	if l.Config.BaseDir == "" {
		return ""
	}
	return l.Config.BaseDir + "/" + l.Config.TenantID
}

// runID 返回溯源标识（Obs 内部不可读，此处用空字符串；文件命名由 tenant 层
// 传入的 runID 承担——tenant 层在 Obs 构造时已注入 run_id，dump 文件名用
// 时间戳兜底）。
func (l *Loop) runID() string {
	return time.Now().UTC().Format("20060102T150405")
}

func (l *Loop) handleState(ctx context.Context, state *contracts.PlayerState) error {
	tick := l.Stats.LastTick.Load()
	if tick < 1 {
		return nil // 尚未收到 tick 信封，等待
	}
	// exactly-once：重连重放或同 tick 多次 state 事件都在此处去重，
	// 之后的 Reduce/Plan/Telemetry/Submit 对同一 tick 只发生一次。
	if tick <= l.lastHandledTick.Load() {
		l.logger().Debug("duplicate state, skipping", "tick", tick)
		return nil
	}
	// 进入本 tick 决策后立即标记（防止 handleState 内部出错返回后，
	// 同一 tick 的重放被当作新 tick 再次处理）。
	l.lastHandledTick.Store(tick)

	stepStart := time.Now()
	step := func(name string) {
		l.logger().Debug("handleState step", "tick", tick, "step", name, "elapsed_ms", time.Since(stepStart).Milliseconds())
	}

	tickState, err := domain.Reduce(state, int(tick))
	if err != nil {
		return fmt.Errorf("reduce tick state: %w", err)
	}
	step("reduce")

	if l.World != nil {
		l.World.Observe(tickState)
	}
	step("observe")

	// 决策视图：合并世界记忆中的资源格（实时视野为空时 worker 朝记忆
	// 格采集/移动——真机 20t 资源枯竭根因：patrol 原地打转走不出视野，
	// 服务器不推送远处资源）。
	decideState := tickState
	if l.World != nil {
		if hints := l.World.ResourceHints(0, 0); len(hints) > 0 {
			decideState = tickState.WithResourceHints(hints)
		}
	}

	// 指挥层（Command & Control）：全局态势 → 模式指令 → 战术层。
	// 无进展（资源/工人/资源格）连续 tick 触发 EXPLORE_STARVED 集中
	// 扫掠、100 tick 触发 MIGRATE_CAND 迁移候选（只评估不执行）。
	if l.Commander != nil {
		directive := l.Commander.Update(decideState)
		l.Planner.ApplyDirective(directive)
		l.lastDirective = directive
		if directive.Mode == strategy.ModeExploreStarved {
			l.event(slog.LevelWarn, "economy.stagnant", "tick", tickState.Tick, "mode", string(directive.Mode))
		}
		if directive.Mode == strategy.ModeMigrateCand {
			l.event(slog.LevelWarn, "migration.candidate", "tick", tickState.Tick, "focus", directive.Focus)
		}
	}

	plan := l.Planner.Decide(decideState)
	step("decide")

	validation := domain.ValidatePlan(tickState, *plan)
	step("validate")
	if validation.Repaired {
		l.Stats.RepairedPlans.Add(1)
		l.event(slog.LevelError, obs.EventPlannerRepair, "tick", tickState.Tick, "issues", fmt.Sprintf("%v", validation.Issues))
		// 红线（赛马裁决）：deterministic 模式产出非法动作 = planner bug，
		// 立即停止并回 shadow，不提交任何 repair 后的计划。
		if l.Config.DecisionMode == "deterministic" {
			return fmt.Errorf("deterministic planner produced invalid actions at tick %d: %v", tickState.Tick, validation.Issues)
		}
	}

	elapsedMS := time.Since(stepStart).Milliseconds()
	if m := l.metrics(); m != nil {
		m.HandleStateMS(elapsedMS)
	}
	if elapsedMS > handleStateSlowMS {
		l.event(slog.LevelWarn, obs.EventHandleStateSlow, "tick", tickState.Tick, "elapsed_ms", elapsedMS)
	}

	if l.RuntimeLog != nil {
		record := map[string]any{
			"at":        time.Now().UTC().Format(time.RFC3339Nano),
			"tenant":    l.Config.TenantID,
			"type":      "runtime_tick",
			"tick":      tickState.Tick,
			"units":     len(tickState.Units),
			"resources": tickState.Resources,
		}
		if l.World != nil {
			snapshot := l.World.Snapshot()
			record["worldResources"] = len(snapshot.Resources)
			record["worldEnemies"] = len(snapshot.Enemies)
		}
		_ = l.RuntimeLog.WriteLine(record)
	}
	if l.DecisionLog != nil {
		l.writeDecisionRecord(tickState, &validation.Plan, validation.Valid, validation.Repaired)
	}

	l.Stats.ProcessedTicks.Add(1)
	if m := l.metrics(); m != nil {
		m.TickProcessed()
	}
	l.Stats.LastTick.Store(int64(tickState.Tick))

	if l.Config.SubmissionMode == ModeLive {
		// 每 tick 只提交一次：同 tick 多次 state 事件（服务器状态更新）
		// 不重复提交（幂等键含 stateHash，重复提交会 409）。
		if l.lastSubmittedTick.Load() >= int64(tickState.Tick) {
			l.logger().Debug("skip submit: tick already submitted", "tick", tickState.Tick)
			return nil
		}
		if err := l.submit(ctx, tickState, &validation.Plan); err != nil {
			l.Stats.RejectedSubmits.Add(1)
			if m := l.metrics(); m != nil {
				m.SubmitRejected()
				m.ErrorClass(obs.ErrorClassSubmitRejected)
			}
			l.event(slog.LevelWarn, obs.EventSubmitRejected, "tick", tickState.Tick, "error", err)
			return err
		}
		l.Stats.LiveSubmits.Add(1)
		if m := l.metrics(); m != nil {
			m.SubmitAccepted()
		}
		l.event(slog.LevelInfo, obs.EventSubmitAccepted, "tick", tickState.Tick)
		l.lastSubmittedTick.Store(int64(tickState.Tick))
	}
	return nil
}

// stableIdempotencyKey 生成跨进程稳定的幂等键：
// arena:<tenant>:<tick>:<stateHash 前 12 位>。同一租户同一 tick 同一状态
// 快照重启后仍一致（防重复提交的额外保险；live 不自动重启语义仍保留）。
func (l *Loop) stableIdempotencyKey(tickState *domain.TickState) string {
	prefix := tickState.StateHash
	if len(prefix) > 12 {
		prefix = prefix[:12]
	}
	return fmt.Sprintf("arena:%s:%d:%s", l.Config.TenantID, tickState.Tick, prefix)
}

func (l *Loop) submit(ctx context.Context, tickState *domain.TickState, plan *domain.Plan) error {
	commandPlan, err := hero.PlanToCommandPlan(plan)
	if err != nil {
		return fmt.Errorf("build command plan: %w", err)
	}
	// 提交体调试（排查"服务器接受但不结算"类问题：动作格式/单位 ID
	// 匹配一眼可见）。
	if encoded, err := json.Marshal(commandPlan); err == nil {
		l.logger().Debug("submit plan body", "tick", tickState.Tick, "plan", string(encoded))
	}
	key := l.stableIdempotencyKey(tickState)
	accepted, err := l.Client.Submit(ctx, *commandPlan, key)
	if err != nil {
		return err
	}
	l.logger().Info("submit accepted", "tick", accepted.Tick)
	return nil
}

// writeDecisionRecord 写决策遥测（含 outcome 证据：动作种类、意图计数、
// Core 动作、资源/worker/cargo 前后变化、planned_spawn_no_effect 与
// cargo_blocked 诊断）。状态间延迟一 tick：outcome 对比上一 tick 摘要。
func (l *Loop) writeDecisionRecord(tickState *domain.TickState, plan *domain.Plan, valid, repaired bool) {
	record := map[string]any{
		"at":       time.Now().UTC().Format(time.RFC3339Nano),
		"tenant":   l.Config.TenantID,
		"type":     "decision",
		"tick":     tickState.Tick,
		"actions":  len(plan.UnitActions),
		"valid":    valid,
		"repaired": repaired,
	}

	// 指挥模式遥测（诊断全局策略切换）。
	record["directiveMode"] = string(l.lastDirective.Mode)

	// 单位位置指纹（analyze 移动量指标：ID 短码 → 位置）。
	positions := make(map[string]string, len(tickState.Units))
	for _, unit := range tickState.Units {
		shortID := unit.ID
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}
		positions[shortID] = domain.CellKey(unit.Position[0], unit.Position[1])
	}
	record["unitPositions"] = positions

	// 动作种类与意图计数。
	actionKinds := make(map[string]int)
	intentCounts := make(map[string]int)
	for _, action := range plan.UnitActions {
		actionKinds[string(action.Kind)]++
	}
	for _, intent := range plan.Intents {
		intentCounts[intent]++
	}
	record["actionKinds"] = actionKinds
	record["intentCounts"] = intentCounts

	// Core 动作证据。
	if plan.CoreAction != nil {
		record["coreAction"] = string(plan.CoreAction.Kind)
		if plan.CoreAction.UnitType != nil {
			record["coreUnitType"] = string(*plan.CoreAction.UnitType)
		}
	} else {
		record["coreAction"] = "NONE"
	}

	// 结算 outcome（对比上一 tick 摘要）。
	workers := len(tickState.Workers)
	cargoTotal := 0
	for _, worker := range tickState.Workers {
		cargoTotal += worker.Cargo
	}
	record["workers"] = workers
	record["workerCargoTotal"] = cargoTotal

	eventReasons := make([]string, 0, 2)
	if prev := l.prevOutcome; prev != nil {
		record["resourcesBefore"] = prev.resources
		record["resourcesAfter"] = tickState.Resources
		record["workersBefore"] = prev.workers
		record["workersAfter"] = workers
		// planned_spawn_no_effect：上一 tick 计划 SPAWN 但 worker 数未增
		// （服务端未结算：Core 格被永久占位/资源被拒）。
		if prev.plannedSpawn && workers <= prev.workers {
			eventReasons = append(eventReasons, "planned_spawn_no_effect")
		}
		// cargo_blocked：满载 worker 位置连续不变（位置指纹停滞；
		// 长途回仓中的满载 worker 位置变化不误报）。
		for id, position := range prev.fullWorkerFingerprint {
			unit := findUnitSnapshotByID(tickState, id)
			if unit == nil || unit.Cargo <= 0 || unit.Position != position {
				continue
			}
			eventReasons = append(eventReasons, "cargo_blocked")
			break
		}
	} else {
		record["resourcesBefore"] = tickState.Resources
		record["resourcesAfter"] = tickState.Resources
		record["workersBefore"] = workers
		record["workersAfter"] = workers
	}
	record["eventReasons"] = eventReasons

	_ = l.DecisionLog.WriteLine(record)

	// 保存本 tick 摘要供下一 tick 生成 outcome。
	current := &tickOutcome{
		resources:             tickState.Resources,
		workers:               workers,
		plannedSpawn:          plan.CoreAction != nil && plan.CoreAction.Kind == domain.CoreSpawn,
		fullWorkerFingerprint: make(map[string]domain.Position, len(tickState.Workers)),
	}
	for _, worker := range tickState.Workers {
		if worker.Cargo > 0 {
			current.fullWorkerFingerprint[worker.ID] = worker.Position
		}
	}
	l.prevOutcome = current
}

// findUnitSnapshotByID 按 ID 查找单位（outcome 诊断用，位置指纹对比）。
func findUnitSnapshotByID(state *domain.TickState, unitID string) *domain.UnitSnapshot {
	for i := range state.Units {
		if state.Units[i].ID == unitID {
			return &state.Units[i]
		}
	}
	return nil
}

// Close 释放资源。
func (l *Loop) Close() {
	l.Client.Close()
	if l.RuntimeLog != nil {
		_ = l.RuntimeLog.Close()
	}
	if l.DecisionLog != nil {
		_ = l.DecisionLog.Close()
	}
}
