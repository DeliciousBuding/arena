package llm

import (
	"context"
	"errors"
	"time"
)

// ErrorKind 是错误分类，供调用方决策与遥测使用。
type ErrorKind string

const (
	KindHTTP        ErrorKind = "http"         // 其他非 2xx 状态
	KindAuth        ErrorKind = "auth"         // 401 / 403
	KindRateLimit   ErrorKind = "rate_limit"   // 429
	KindServer      ErrorKind = "server"       // 5xx
	KindNetwork     ErrorKind = "network"      // 传输层（连接失败/中段断流）
	KindStream      ErrorKind = "stream"       // SSE 流错误（错误段/畸形数据）
	KindCanceled    ErrorKind = "canceled"     // context 取消/超时
	KindCircuitOpen ErrorKind = "circuit_open" // 熔断器拒绝
)

// KindOf 返回错误的分类；未知/未分类错误归为 KindStream。
func KindOf(err error) ErrorKind {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return KindCanceled
	case errors.Is(err, ErrCircuitOpen):
		return KindCircuitOpen
	}
	var httpErr *httpError
	if errors.As(err, &httpErr) {
		return classifyHTTPStatus(httpErr.StatusCode)
	}
	var transportErr *TransportError
	if errors.As(err, &transportErr) {
		return KindNetwork
	}
	return KindStream
}

// classifyHTTPStatus 按 HTTP 状态码分类错误。
func classifyHTTPStatus(status int) ErrorKind {
	switch {
	case status == 401 || status == 403:
		return KindAuth
	case status == 429:
		return KindRateLimit
	case status >= 500:
		return KindServer
	default:
		return KindHTTP
	}
}

// IsRetryable 报告错误是否可重试（网络错误 / 429 / 5xx）。
// context 取消、认证失败与其他 4xx 不重试。
func IsRetryable(err error) bool {
	switch KindOf(err) {
	case KindRateLimit, KindServer, KindNetwork:
		return true
	default:
		return false
	}
}

// retryPolicy 是指数退避重试策略（仅在可重试错误上生效）。
type retryPolicy struct {
	maxAttempts int
	baseDelay   time.Duration
	maxDelay    time.Duration
	sleep       func(ctx context.Context, d time.Duration) error
}

// applyDefaults 为未配置项填充默认值。
func (p *retryPolicy) applyDefaults() {
	if p.maxAttempts <= 0 {
		p.maxAttempts = 3
	}
	if p.baseDelay <= 0 {
		p.baseDelay = 250 * time.Millisecond
	}
	if p.maxDelay <= 0 {
		p.maxDelay = 5 * time.Second
	}
	if p.sleep == nil {
		p.sleep = sleepCtx
	}
}

// backoff 返回第 attempt 次重试前的等待时长（指数增长，封顶 maxDelay）。
func (p retryPolicy) backoff(attempt int) time.Duration {
	delay := p.baseDelay
	for i := 0; i < attempt && delay < p.maxDelay; i++ {
		delay *= 2
		if delay <= 0 { // 溢出保护
			return p.maxDelay
		}
	}
	if delay > p.maxDelay {
		return p.maxDelay
	}
	return delay
}

// sleepCtx 是默认退避等待：context 感知的睡眠。
func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
