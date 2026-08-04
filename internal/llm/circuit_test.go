package llm

import (
	"sync"
	"testing"
	"time"
)

// fakeClock 是可手动拨动的注入时钟（熔断测试用）。
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *fakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

func TestCircuitDefaults(t *testing.T) {
	t.Parallel()
	c := NewCircuit(CircuitOptions{})
	if c.openMs != 30*time.Second {
		t.Fatalf("默认冷却 = %v, want 30s", c.openMs)
	}
	if c.threshold != 3 {
		t.Fatalf("默认阈值 = %d, want 3", c.threshold)
	}
	if got := c.State(); got != StateClosed {
		t.Fatalf("初始状态 = %v, want closed", got)
	}
	if !c.Allow() {
		t.Fatal("closed 状态应放行")
	}
}

func TestCircuitOpenAfterThreeFailures(t *testing.T) {
	t.Parallel()
	c := NewCircuit(CircuitOptions{Now: newFakeClock().Now})
	for i := 0; i < 2; i++ {
		c.ReportFailure()
		if got := c.State(); got != StateClosed {
			t.Fatalf("第 %d 次失败后状态 = %v, want closed", i+1, got)
		}
		if c.Failures() != i+1 {
			t.Fatalf("第 %d 次失败后计数 = %d", i+1, c.Failures())
		}
	}
	c.ReportFailure()
	if got := c.State(); got != StateOpen {
		t.Fatalf("3 连败后状态 = %v, want open", got)
	}
	if c.Allow() {
		t.Fatal("open 状态应拒绝请求")
	}
}

func TestCircuitCooldownToHalfOpenSingleProbe(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	c := NewCircuit(CircuitOptions{Now: clock.Now})
	for i := 0; i < 3; i++ {
		c.ReportFailure()
	}
	if c.Allow() {
		t.Fatal("冷却期内应拒绝")
	}
	clock.Advance(30 * time.Second)
	if !c.Allow() {
		t.Fatal("冷却结束后应放行单个探测")
	}
	if got := c.State(); got != StateHalfOpen {
		t.Fatalf("放行探测后状态 = %v, want half-open", got)
	}
	if c.Allow() {
		t.Fatal("half-open 探测在途时应拒绝第二个请求")
	}
}

func TestCircuitHalfOpenProbeSuccessCloses(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	c := NewCircuit(CircuitOptions{Now: clock.Now})
	for i := 0; i < 3; i++ {
		c.ReportFailure()
	}
	clock.Advance(31 * time.Second)
	if !c.Allow() {
		t.Fatal("探测应被放行")
	}
	c.ReportSuccess()
	if got := c.State(); got != StateClosed {
		t.Fatalf("探测成功后状态 = %v, want closed", got)
	}
	if c.Failures() != 0 {
		t.Fatalf("探测成功后失败计数 = %d, want 0", c.Failures())
	}
	if !c.Allow() {
		t.Fatal("恢复 closed 后应放行")
	}
}

func TestCircuitHalfOpenProbeFailureReopens(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	c := NewCircuit(CircuitOptions{Now: clock.Now})
	for i := 0; i < 3; i++ {
		c.ReportFailure()
	}
	clock.Advance(31 * time.Second)
	if !c.Allow() {
		t.Fatal("探测应被放行")
	}
	c.ReportFailure()
	if got := c.State(); got != StateOpen {
		t.Fatalf("探测失败后状态 = %v, want open", got)
	}
	if c.Allow() {
		t.Fatal("再次 open 后应拒绝")
	}
	clock.Advance(29 * time.Second)
	if c.Allow() {
		t.Fatal("重新冷却 29s 内应拒绝")
	}
	clock.Advance(2 * time.Second)
	if !c.Allow() {
		t.Fatal("冷却结束后应再次放行探测")
	}
}

func TestCircuitReleaseAllowsNextProbe(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	c := NewCircuit(CircuitOptions{Now: clock.Now})
	for i := 0; i < 3; i++ {
		c.ReportFailure()
	}
	clock.Advance(31 * time.Second)
	if !c.Allow() {
		t.Fatal("探测应被放行")
	}
	if c.Allow() {
		t.Fatal("探测在途时应拒绝")
	}
	c.Release() // 探测被放弃（如流提前关闭）
	if !c.Allow() {
		t.Fatal("放弃探测后应允许下一次探测")
	}
}

func TestCircuitSuccessResetsFailures(t *testing.T) {
	t.Parallel()
	c := NewCircuit(CircuitOptions{Now: newFakeClock().Now})
	c.ReportFailure()
	c.ReportFailure()
	c.ReportSuccess()
	if c.Failures() != 0 {
		t.Fatalf("成功后失败计数 = %d, want 0", c.Failures())
	}
	c.ReportFailure()
	c.ReportFailure()
	if got := c.State(); got != StateClosed {
		t.Fatalf("重置后再 2 连败状态 = %v, want closed（计数应已重置）", got)
	}
	c.ReportFailure()
	if got := c.State(); got != StateOpen {
		t.Fatalf("重置后 3 连败状态 = %v, want open", got)
	}
}

func TestCircuitConcurrentAccess(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	c := NewCircuit(CircuitOptions{Now: clock.Now})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				c.Allow()
				c.ReportFailure()
				c.ReportSuccess()
				c.Release()
				c.State()
				c.Failures()
			}
		}()
	}
	wg.Wait()
	// 只断言无数据竞争/死锁（-race 门禁兜底），状态终值不做确定性假设
}
