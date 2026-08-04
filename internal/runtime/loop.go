// Package runtime 实现租户运行循环（纵向闭环最小版）。
// 阶段 B 语义：events → reduce → decide → validate → 提交（shadow/live 由提交模式决定）。
package runtime

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/hero"
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

// TenantConfig 是租户运行配置（不包含密钥值）。
type TenantConfig struct {
	TenantID       string
	BaseURL        string
	DecisionMode   string
	SubmissionMode SubmissionMode
	MaxTicks       int // 0 = 无限
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
	Logger      *slog.Logger
	RuntimeLog  *telemetry.JsonlWriter
	DecisionLog *telemetry.JsonlWriter
	Stats       Stats
}

// Run 运行循环直到 ctx 取消或达到 MaxTicks。
// 每收到 state 事件：reduce → world observe → decide → validate →
// （live 时）submit。事件流异常终止（携带错误）时向上返回错误。
func (l *Loop) Run(ctx context.Context) error {
	events := l.Client.Events(ctx)

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-events:
			if !ok {
				if err := l.Client.Err(); err != nil {
					return fmt.Errorf("game event stream ended: %w", err)
				}
				return nil
			}
			switch event.Kind {
			case hero.TickEvent:
				l.Stats.LastTick.Store(int64(event.Tick))
				l.Logger.Debug("tick", "tick", event.Tick)
			case hero.StateEvent:
				if err := l.handleState(ctx, &event.State); err != nil {
					l.Logger.Error("state handling failed", "tick", l.Stats.LastTick.Load(), "error", err)
				}
			case hero.ReceivedEvent:
				l.Logger.Debug("received", "tick", event.Received.Tick, "source", event.Received.Source)
			}
			if l.Config.MaxTicks > 0 && l.Stats.ProcessedTicks.Load() >= int64(l.Config.MaxTicks) {
				return nil
			}
		}
	}
}

func (l *Loop) handleState(ctx context.Context, state *contracts.PlayerState) error {
	tick := l.Stats.LastTick.Load()
	if tick < 1 {
		return nil // 尚未收到 tick 信封，等待
	}

	tickState, err := domain.Reduce(state, int(tick))
	if err != nil {
		return fmt.Errorf("reduce tick state: %w", err)
	}

	if l.World != nil {
		l.World.Observe(tickState)
	}

	plan := l.Planner.Decide(tickState)
	validation := domain.ValidatePlan(tickState, *plan)
	if validation.Repaired {
		l.Stats.RepairedPlans.Add(1)
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
		_ = l.DecisionLog.WriteLine(map[string]any{
			"at":       time.Now().UTC().Format(time.RFC3339Nano),
			"tenant":   l.Config.TenantID,
			"type":     "decision",
			"tick":     tickState.Tick,
			"actions":  len(validation.Plan.UnitActions),
			"core":     validation.Plan.CoreAction != nil,
			"repaired": validation.Repaired,
			"valid":    validation.Valid,
			"workers":  len(tickState.Workers),
		})
	}

	l.Stats.ProcessedTicks.Add(1)
	l.Stats.LastTick.Store(int64(tickState.Tick))

	if l.Config.SubmissionMode == ModeLive {
		if err := l.submit(ctx, tickState, &validation.Plan); err != nil {
			l.Stats.RejectedSubmits.Add(1)
			l.Logger.Warn("submit failed", "tick", tickState.Tick, "error", err)
			return err
		}
		l.Stats.LiveSubmits.Add(1)
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
	l.Logger.Info("submit accepted", "tick", accepted.Tick)
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
