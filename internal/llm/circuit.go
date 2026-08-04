package llm

import (
	"errors"
	"sync"
	"time"
)

// ErrCircuitOpen 表示熔断器 open：请求被拒绝，不发起网络调用。
var ErrCircuitOpen = errors.New("llm: 熔断器 open")

// CircuitState 是熔断器状态。
type CircuitState int

const (
	// StateClosed 关闭：正常放行，累计连续失败。
	StateClosed CircuitState = iota
	// StateOpen 打开：拒绝请求，等待冷却。
	StateOpen
	// StateHalfOpen 半开：允许单个探测请求。
	StateHalfOpen
)

// CircuitOptions 配置熔断器。
type CircuitOptions struct {
	// OpenMs 冷却时长；<=0 时默认 30s。
	OpenMs time.Duration
	// Threshold 连续失败阈值；<=0 时默认 3。
	Threshold int
	// Now 时钟注入（测试用）；nil 时使用 time.Now。
	Now func() time.Time
}

// CircuitBreaker 是并发安全的熔断器，状态机：
// closed → open（连续失败 ≥ threshold）→ 冷却（OpenMs）→ half-open（单探测）
// → closed（探测成功）或再 open（探测失败）。
type CircuitBreaker struct {
	mu            sync.Mutex
	state         CircuitState
	failures      int
	openSince     time.Time
	openMs        time.Duration
	threshold     int
	now           func() time.Time
	probeInFlight bool
}

// NewCircuit 构建熔断器（零值选项提供默认行为：阈值 3、冷却 30s）。
func NewCircuit(opts CircuitOptions) *CircuitBreaker {
	openMs := opts.OpenMs
	if openMs <= 0 {
		openMs = 30 * time.Second
	}
	threshold := opts.Threshold
	if threshold <= 0 {
		threshold = 3
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &CircuitBreaker{openMs: openMs, threshold: threshold, now: now}
}

// Allow 判断是否放行请求；open 冷却期内拒绝，half-open 下仅放行单个探测。
func (c *CircuitBreaker) Allow() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch c.state {
	case StateClosed:
		return true
	case StateOpen:
		if c.now().Sub(c.openSince) >= c.openMs {
			c.state = StateHalfOpen
			c.probeInFlight = true
			return true
		}
		return false
	case StateHalfOpen:
		if c.probeInFlight {
			return false
		}
		c.probeInFlight = true
		return true
	}
	return false
}

// ReportFailure 上报一次失败：closed 下累计连续失败，达到阈值即 open；
// half-open 探测失败立即回到 open。
func (c *CircuitBreaker) ReportFailure() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probeInFlight = false
	switch c.state {
	case StateClosed:
		c.failures++
		if c.failures >= c.threshold {
			c.trip()
		}
	case StateHalfOpen:
		c.trip()
	case StateOpen:
		// 保持 open
	}
}

// ReportSuccess 上报成功：half-open 探测成功恢复为 closed；closed 下重置失败计数。
func (c *CircuitBreaker) ReportSuccess() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probeInFlight = false
	c.failures = 0
	if c.state == StateHalfOpen {
		c.state = StateClosed
	}
}

// Release 放弃在途调用（流被提前关闭、context 取消等）：
// 仅释放 half-open 的探测名额，不改变状态与失败计数。
func (c *CircuitBreaker) Release() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.probeInFlight = false
}

// State 返回当前状态（测试与遥测用）。
func (c *CircuitBreaker) State() CircuitState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Failures 返回当前连续失败计数（测试与遥测用）。
func (c *CircuitBreaker) Failures() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failures
}

// trip 进入 open 并记录冷却起点。
func (c *CircuitBreaker) trip() {
	c.state = StateOpen
	c.openSince = c.now()
	c.failures = 0
}
