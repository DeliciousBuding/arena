// Package obs 是统一可观测性层：结构化日志 + 原子指标 + 诊断事件 +
// 卡顿/死锁检测（docs/go/07-observability.md）。
// 零外部依赖（仅 slog）；runID/tenantID 溯源字段自动注入每条日志。
package obs

import (
	"io"
	"log/slog"
)

// Obs 是聚合句柄：所有组件共用同一 Obs，保证溯源字段一致。
type Obs struct {
	log     *slog.Logger
	metrics *Metrics
}

// New 构造 Obs。sink 为日志输出（nil 时用 os.Stderr）。
// runID/tenantID 自动注入每条日志与诊断事件。
func New(runID, tenantID string, sink io.Writer, level slog.Level) *Obs {
	if sink == nil {
		sink = io.Discard
	}
	logger := slog.New(slog.NewTextHandler(sink, &slog.HandlerOptions{Level: level}))
	logger = logger.With("run_id", runID, "tenant", tenantID)
	return &Obs{log: logger, metrics: newMetrics()}
}

// Logger 返回带溯源字段的结构化日志器（组件日志统一入口）。
func (o *Obs) Logger() *slog.Logger { return o.log }

// Metrics 返回原子指标（组件自增）。
func (o *Obs) Metrics() *Metrics { return o.metrics }

// Event 发出诊断事件：事件名遵循 docs/go/07-observability.md §4 约定
// （小写 snake_case），自动附加 run_id/tenant/event 字段。
func (o *Obs) Event(level slog.Level, name string, attrs ...any) {
	fields := make([]any, 0, len(attrs)+1)
	fields = append(fields, "event", name)
	fields = append(fields, attrs...)
	o.log.Log(nil, level, name, fields...)
}
