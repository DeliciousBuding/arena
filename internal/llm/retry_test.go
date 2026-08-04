package llm

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

func TestBackoffExponential(t *testing.T) {
	t.Parallel()
	p := retryPolicy{maxAttempts: 5, baseDelay: 100 * time.Millisecond, maxDelay: time.Second}
	p.applyDefaults()
	wantMs := []time.Duration{100, 200, 400, 800, 1000}
	for attempt, want := range wantMs {
		if got := p.backoff(attempt); got != want*time.Millisecond {
			t.Fatalf("backoff(%d) = %v, want %v", attempt, got, want*time.Millisecond)
		}
	}
}

func TestBackoffOverflowCapped(t *testing.T) {
	t.Parallel()
	p := retryPolicy{maxAttempts: 70, baseDelay: time.Second, maxDelay: 5 * time.Second}
	p.applyDefaults()
	for attempt := 0; attempt < p.maxAttempts; attempt++ {
		if got := p.backoff(attempt); got > p.maxDelay || got <= 0 {
			t.Fatalf("backoff(%d) = %v 超出合理区间", attempt, got)
		}
	}
}

func TestIsRetryable(t *testing.T) {
	t.Parallel()
	httpErr := func(status int) error {
		return &httpError{HTTPError: HTTPError{StatusCode: status}}
	}
	table := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"400", httpErr(400), false},
		{"401", httpErr(401), false},
		{"404", httpErr(404), false},
		{"429", httpErr(429), true},
		{"500", httpErr(500), true},
		{"503", httpErr(503), true},
		{"network", &TransportError{Err: &net.OpError{}}, true},
		{"canceled", context.Canceled, false},
		{"deadline", context.DeadlineExceeded, false},
		{"circuit open", ErrCircuitOpen, false},
		{"stream error", errors.New("boom"), false},
	}
	for _, tc := range table {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsRetryable(tc.err); got != tc.want {
				t.Fatalf("IsRetryable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestKindOf(t *testing.T) {
	t.Parallel()
	httpErr := func(status int) error {
		return &httpError{HTTPError: HTTPError{StatusCode: status}}
	}
	table := []struct {
		name string
		err  error
		want ErrorKind
	}{
		{"nil", nil, ""},
		{"401", httpErr(401), KindAuth},
		{"403", httpErr(403), KindAuth},
		{"429", httpErr(429), KindRateLimit},
		{"500", httpErr(500), KindServer},
		{"400", httpErr(400), KindHTTP},
		{"network", &TransportError{Err: errors.New("x")}, KindNetwork},
		{"canceled", context.Canceled, KindCanceled},
		{"deadline wrapped", fmt.Errorf("wrap: %w", context.DeadlineExceeded), KindCanceled},
		{"circuit open", ErrCircuitOpen, KindCircuitOpen},
		{"stream error", errors.New("SSE 错误"), KindStream},
	}
	for _, tc := range table {
		t.Run(tc.name, func(t *testing.T) {
			if got := KindOf(tc.err); got != tc.want {
				t.Fatalf("KindOf(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

func TestSleepCtxWaits(t *testing.T) {
	t.Parallel()
	start := time.Now()
	if err := sleepCtx(context.Background(), 10*time.Millisecond); err != nil {
		t.Fatalf("sleepCtx: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 5*time.Millisecond {
		t.Fatalf("sleepCtx 未实际等待: %v", elapsed)
	}
}

func TestSleepCtxRespectsCancel(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	err := sleepCtx(ctx, time.Minute)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("期望 context.Canceled，得到 %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("取消后睡眠未及时返回: %v", elapsed)
	}
}
