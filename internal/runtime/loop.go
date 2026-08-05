// Package runtime 实现租户运行循环（纵向闭环最小版）。
// 阶段 B 语义：events → reduce → decide → validate → 提交（shadow/live 由提交模式决定）。
// 可观测性：统一经 obs.Obs（事件/metrics/卡顿与死锁检测，docs/go/07-observability.md）。
package runtime

import (
	"context"
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

// Loop 是单租户运行循环。
type Loop struct {
	Client      *hero.ArenaHeroClient
	Planner     *strategy.Planner
	World       *domain.World // 跨 tick 世界记忆（nil 时跳过 Observe，测试兼容）
	Config      TenantConfig
	Obs         *obs.Obs // 统一可观测句柄（nil 时降级：仅 Logger）
	Logger      *slog.Logger
	RuntimeLog  *telemetry.JsonlWriter
	DecisionLog *telemetry.JsonlWriter
	Stats       Stats

	// lastSubmittedTick 记录最近已提交的 tick（live 每 tick 只提交一次：
	// 服务器同 tick 可能推送多个 state 更新，stateHash 变化会产生不同
	// 幂等键导致 409 IDEMPOTENCY_CONFLICT——真机 30t 递进发现）。
	lastSubmittedTick atomic.Int64
	// lastTickAt 记录最近 tick 事件的到达时间（gap 检测）。
	lastTickAt atomic.Int64
	// idleDumpSeq 是栈 dump 序号（文件命名）。
	idleDumpSeq atomic.Int64
}

// logger 返回有效日志器（Obs 优先）。
func (l *Loop) logger() *slog.Logger {
	if l.Obs != nil {
		return l.Obs.Logger()
	}
	return l.Logger
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

	plan := l.Planner.Decide(tickState)
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
		spawnIntent := false
		if validation.Plan.CoreAction != nil && validation.Plan.CoreAction.Kind == domain.CoreSpawn {
			spawnIntent = true
		}
		_ = l.DecisionLog.WriteLine(map[string]any{
			"at":       time.Now().UTC().Format(time.RFC3339Nano),
			"tenant":   l.Config.TenantID,
			"type":     "decision",
			"tick":     tickState.Tick,
			"actions":  len(validation.Plan.UnitActions),
			"core":     validation.Plan.CoreAction != nil,
			"spawn":    spawnIntent,
			"repaired": validation.Repaired,
			"valid":    validation.Valid,
			"workers":  len(tickState.Workers),
		})
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
	key := l.stableIdempotencyKey(tickState)
	accepted, err := l.Client.Submit(ctx, *commandPlan, key)
	if err != nil {
		return err
	}
	l.logger().Info("submit accepted", "tick", accepted.Tick)
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
