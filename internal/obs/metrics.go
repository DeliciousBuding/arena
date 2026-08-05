package obs

import (
	"sync"
	"sync/atomic"
)

// Metrics 是原子指标集合（无锁并发安全；分类计数用互斥保护）。
// 计数器：Add/Inc；仪表：Set/Get。
type Metrics struct {
	ticksProcessed  atomic.Int64
	submitsAccepted atomic.Int64
	submitsRejected atomic.Int64
	reconnects      atomic.Int64
	idleDumps       atomic.Int64

	mu            sync.Mutex
	errorsByClass map[string]*atomic.Int64

	lastTickGapMS atomic.Int64
	handleStateMS atomic.Int64
}

func newMetrics() *Metrics {
	return &Metrics{errorsByClass: make(map[string]*atomic.Int64)}
}

// TickProcessed / SubmitAccepted / SubmitRejected / Reconnect / IdleDump 计数器。
func (m *Metrics) TickProcessed() int64  { return m.ticksProcessed.Add(1) }
func (m *Metrics) SubmitAccepted() int64 { return m.submitsAccepted.Add(1) }
func (m *Metrics) SubmitRejected() int64 { return m.submitsRejected.Add(1) }
func (m *Metrics) Reconnect() int64      { return m.reconnects.Add(1) }
func (m *Metrics) IdleDump() int64       { return m.idleDumps.Add(1) }

// Counts 返回计数快照（调试/doctor 用）。
func (m *Metrics) Counts() map[string]int64 {
	out := map[string]int64{
		"ticks_processed":  m.ticksProcessed.Load(),
		"submits_accepted": m.submitsAccepted.Load(),
		"submits_rejected": m.submitsRejected.Load(),
		"reconnects":       m.reconnects.Load(),
		"idle_dumps":       m.idleDumps.Load(),
		"last_tick_gap_ms": m.lastTickGapMS.Load(),
		"handle_state_ms":  m.handleStateMS.Load(),
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for class, counter := range m.errorsByClass {
		out["errors_"+class] = counter.Load()
	}
	return out
}

// ErrorClass 记录分类错误（class: config/transport/protocol/lease/lock/
// submit_rejected）。返回该类累计计数。
func (m *Metrics) ErrorClass(class string) int64 {
	m.mu.Lock()
	counter, ok := m.errorsByClass[class]
	if !ok {
		counter = &atomic.Int64{}
		m.errorsByClass[class] = counter
	}
	m.mu.Unlock()
	return counter.Add(1)
}

// LastTickGapMS 记录最近两 tick 间隔（毫秒）。
func (m *Metrics) LastTickGapMS(value int64) { m.lastTickGapMS.Store(value) }

// HandleStateMS 记录最近 handleState 耗时（毫秒）。
func (m *Metrics) HandleStateMS(value int64) { m.handleStateMS.Store(value) }
