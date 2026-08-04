// 决策租约 / 租约注册表 / 截止预算测试。
// 覆盖：正常接受、五类拒绝路径（runID/tick/stateHash/过期/closed，每类
// ≥2 用例）、校验顺序语义、registry 有界淘汰、budget 校验、并发提交。
// 全部使用短 duration（ms 级），无 t.Skip、无真实长 sleep。
package runtime

import (
	"sync"
	"testing"
	"time"

	"github.com/deliciousbuding/arena/internal/domain"
)

func leasePlan(tick int) *domain.Plan {
	return &domain.Plan{Tick: tick}
}

// futureDeadline 是足够靠后的截止（无等待：测试不 sleep 到该时刻）。
func futureDeadline() time.Time {
	return time.Now().Add(100 * time.Millisecond)
}

// TestLeaseAcceptCandidate 正常路径：身份全对、未关闭、未过期 → accepted。
func TestLeaseAcceptCandidate(t *testing.T) {
	cases := []struct {
		name string
		tick int64
	}{
		{name: "tick42", tick: 42},
		{name: "tick43", tick: 43},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry := NewLeaseRegistry(4)
			lease := registry.StartDecision("run-"+tc.name, tc.tick, "hash-"+tc.name, futureDeadline())
			result := lease.SubmitCandidate(leasePlan(int(tc.tick)))
			if !result.Accepted {
				t.Fatalf("expected accepted, got %+v", result)
			}
			if result.Reason != "" {
				t.Fatalf("accepted result must have empty reason, got %q", result.Reason)
			}
		})
	}
}

// TestLeaseRejectRunID 越权：候选声明的 runID 与当前决策不符 → rejected_runid。
func TestLeaseRejectRunID(t *testing.T) {
	t.Run("superseded_run", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		stale := registry.StartDecision("run-A", 42, "hash-1", futureDeadline())
		registry.StartDecision("run-B", 42, "hash-1", futureDeadline()) // 新 run 取代
		result := stale.SubmitCandidate(leasePlan(42))
		if result.Accepted || result.Reason != ReasonRejectedRunID {
			t.Fatalf("expected rejected_runid, got %+v", result)
		}
	})
	t.Run("runid_precedes_tick", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		stale := registry.StartDecision("run-A", 42, "hash-1", futureDeadline())
		registry.StartDecision("run-B", 42, "hash-1", futureDeadline())
		// tick 也错时仍报 runID（顺序即安全语义：runID 最先校验）。
		result := stale.SubmitCandidate(leasePlan(99))
		if result.Accepted || result.Reason != ReasonRejectedRunID {
			t.Fatalf("expected rejected_runid (runID first), got %+v", result)
		}
	})
}

// TestLeaseRejectTick 迟到：计划 tick 与租约 tick 不符 → rejected_tick。
func TestLeaseRejectTick(t *testing.T) {
	registry := NewLeaseRegistry(4)
	lease := registry.StartDecision("run-tick", 42, "hash-tick", futureDeadline())
	cases := []struct {
		name string
		plan *domain.Plan
	}{
		{name: "tick_before", plan: leasePlan(41)},
		{name: "tick_after", plan: leasePlan(43)},
		{name: "nil_plan", plan: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := lease.SubmitCandidate(tc.plan)
			if result.Accepted || result.Reason != ReasonRejectedTick {
				t.Fatalf("expected rejected_tick, got %+v", result)
			}
		})
	}
}

// TestLeaseRejectStateHash stale：候选基于过期状态快照 → rejected_statehash。
func TestLeaseRejectStateHash(t *testing.T) {
	t.Run("world_reset_same_run", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		stale := registry.StartDecision("run-A", 42, "hash-1", futureDeadline())
		registry.StartDecision("run-A", 42, "hash-2", futureDeadline()) // 世界重置：同 run 新状态
		result := stale.SubmitCandidate(leasePlan(42))
		if result.Accepted || result.Reason != ReasonRejectedStateHash {
			t.Fatalf("expected rejected_statehash, got %+v", result)
		}
	})
	t.Run("second_tick", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		stale := registry.StartDecision("run-B", 43, "hash-3", futureDeadline())
		registry.StartDecision("run-B", 43, "hash-4", futureDeadline())
		result := stale.SubmitCandidate(leasePlan(43))
		if result.Accepted || result.Reason != ReasonRejectedStateHash {
			t.Fatalf("expected rejected_statehash, got %+v", result)
		}
	})
}

// TestLeaseRejectExpired 过期：deadline 1ms，真实短等待后提交 → rejected_expired。
func TestLeaseRejectExpired(t *testing.T) {
	cases := []struct {
		name string
		tick int64
	}{
		{name: "tick42", tick: 42},
		{name: "tick43", tick: 43},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry := NewLeaseRegistry(4)
			lease := registry.StartDecision("run-"+tc.name, tc.tick, "hash-"+tc.name, time.Now().Add(time.Millisecond))
			time.Sleep(5 * time.Millisecond)
			result := lease.SubmitCandidate(leasePlan(int(tc.tick)))
			if result.Accepted || result.Reason != ReasonRejectedExpired {
				t.Fatalf("expected rejected_expired, got %+v", result)
			}
		})
	}
}

// TestLeaseRejectClosed 已关闭：CloseLease 与淘汰（eviction）后提交 →
// rejected_closed。
func TestLeaseRejectClosed(t *testing.T) {
	t.Run("close_lease", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		lease := registry.StartDecision("run-close", 42, "hash-close", futureDeadline())
		registry.CloseLease(42)
		result := lease.SubmitCandidate(leasePlan(42))
		if result.Accepted || result.Reason != ReasonRejectedClosed {
			t.Fatalf("expected rejected_closed, got %+v", result)
		}
	})
	t.Run("evicted_lease", func(t *testing.T) {
		registry := NewLeaseRegistry(2)
		evicted := registry.StartDecision("run-e", 1, "hash-e", futureDeadline())
		registry.StartDecision("run-e", 2, "hash-e", futureDeadline())
		registry.StartDecision("run-e", 3, "hash-e", futureDeadline()) // 淘汰 tick 1
		result := evicted.SubmitCandidate(leasePlan(1))
		if result.Accepted || result.Reason != ReasonRejectedClosed {
			t.Fatalf("expected rejected_closed, got %+v", result)
		}
	})
}

// TestLeaseClosedOrder 顺序语义：closed 后即使 runID/tick/hash 全对也
// rejected_closed；身份校验仍优先于 closed（tick 错先报 rejected_tick）。
func TestLeaseClosedOrder(t *testing.T) {
	t.Run("closed_after_correct_identity", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		lease := registry.StartDecision("run-ord", 42, "hash-ord", futureDeadline())
		registry.CloseLease(42)
		result := lease.SubmitCandidate(leasePlan(42))
		if result.Accepted || result.Reason != ReasonRejectedClosed {
			t.Fatalf("expected rejected_closed, got %+v", result)
		}
	})
	t.Run("identity_precedes_closed", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		lease := registry.StartDecision("run-ord", 42, "hash-ord", futureDeadline())
		registry.CloseLease(42)
		result := lease.SubmitCandidate(leasePlan(99)) // tick 错
		if result.Accepted || result.Reason != ReasonRejectedTick {
			t.Fatalf("expected rejected_tick (identity first), got %+v", result)
		}
	})
	t.Run("closed_precedes_expired", func(t *testing.T) {
		registry := NewLeaseRegistry(4)
		lease := registry.StartDecision("run-ord", 42, "hash-ord", time.Now().Add(time.Millisecond))
		registry.CloseLease(42)
		time.Sleep(5 * time.Millisecond) // 已过期且已关闭 → 报 closed（顺序：closed 先于 expired）
		result := lease.SubmitCandidate(leasePlan(42))
		if result.Accepted || result.Reason != ReasonRejectedClosed {
			t.Fatalf("expected rejected_closed, got %+v", result)
		}
	})
}

// TestRegistryGetMissing Get 不存在（未注册）返回 nil。
func TestRegistryGetMissing(t *testing.T) {
	registry := NewLeaseRegistry(4)
	if lease := registry.Get(9999); lease != nil {
		t.Fatalf("expected nil for unregistered tick, got %v", lease)
	}
}

// TestRegistryEviction 有界清理：maxActive=2 时第 3 个 StartDecision 淘汰
// 第 1 个（变 closed，Get 返回 nil），其余租约不受影响。
func TestRegistryEviction(t *testing.T) {
	registry := NewLeaseRegistry(2)
	first := registry.StartDecision("run-ev", 1, "hash-1", futureDeadline())
	second := registry.StartDecision("run-ev", 2, "hash-2", futureDeadline())
	third := registry.StartDecision("run-ev", 3, "hash-3", futureDeadline())

	if lease := registry.Get(1); lease != nil {
		t.Fatalf("expected evicted tick 1 to be nil, got %v", lease)
	}
	if lease := registry.Get(2); lease != second {
		t.Fatalf("expected Get(2) to be the second lease, got %v", lease)
	}
	if lease := registry.Get(3); lease != third {
		t.Fatalf("expected Get(3) to be the third lease, got %v", lease)
	}
	if result := first.SubmitCandidate(leasePlan(1)); result.Accepted || result.Reason != ReasonRejectedClosed {
		t.Fatalf("expected evicted lease rejected_closed, got %+v", result)
	}
	if result := second.SubmitCandidate(leasePlan(2)); !result.Accepted {
		t.Fatalf("expected surviving lease accepted, got %+v", result)
	}
}

// TestRegistrySupersede 同 tick 重复 StartDecision：Get 返回最新租约，
// 旧租约被取代后按 runID 拒绝。
func TestRegistrySupersede(t *testing.T) {
	registry := NewLeaseRegistry(4)
	oldLease := registry.StartDecision("run-A", 42, "hash-1", futureDeadline())
	newLease := registry.StartDecision("run-B", 42, "hash-2", futureDeadline())

	if lease := registry.Get(42); lease != newLease {
		t.Fatalf("expected Get(42) to be the new lease, got %v", lease)
	}
	if result := newLease.SubmitCandidate(leasePlan(42)); !result.Accepted {
		t.Fatalf("expected current lease accepted, got %+v", result)
	}
	if result := oldLease.SubmitCandidate(leasePlan(42)); result.Accepted || result.Reason != ReasonRejectedRunID {
		t.Fatalf("expected superseded lease rejected_runid, got %+v", result)
	}
}

// TestRegistryMaxActiveInvalid maxActive < 1 为编程错误（panic）。
func TestRegistryMaxActiveInvalid(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for maxActive < 1")
		}
	}()
	NewLeaseRegistry(0)
}

// TestDeadlineBudgetInvalid 非法顺序 / 非正段 → error。
func TestDeadlineBudgetInvalid(t *testing.T) {
	cases := []struct {
		name                 string
		agentSoft, selection time.Duration
		submit, hard         time.Duration
	}{
		{name: "zero_soft", agentSoft: 0, selection: 10 * time.Millisecond, submit: 20 * time.Millisecond, hard: 30 * time.Millisecond},
		{name: "negative_selection", agentSoft: 5 * time.Millisecond, selection: -1, submit: 20 * time.Millisecond, hard: 30 * time.Millisecond},
		{name: "equal_soft_selection", agentSoft: 10 * time.Millisecond, selection: 10 * time.Millisecond, submit: 20 * time.Millisecond, hard: 30 * time.Millisecond},
		{name: "reversed_order", agentSoft: 30 * time.Millisecond, selection: 20 * time.Millisecond, submit: 10 * time.Millisecond, hard: 5 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if budget, err := NewDeadlineBudget(tc.agentSoft, tc.selection, tc.submit, tc.hard); err == nil {
				t.Fatalf("expected error for invalid budget, got %+v", budget)
			}
		})
	}
}

// TestDeadlineBudgetValid 合法顺序 → 四个截止相对 from 严格递增。
func TestDeadlineBudgetValid(t *testing.T) {
	cases := []struct {
		name                 string
		agentSoft, selection time.Duration
		submit, hard         time.Duration
	}{
		{name: "ms_scale", agentSoft: 5 * time.Millisecond, selection: 10 * time.Millisecond, submit: 15 * time.Millisecond, hard: 20 * time.Millisecond},
		{name: "different_from", agentSoft: 1 * time.Millisecond, selection: 2 * time.Millisecond, submit: 3 * time.Millisecond, hard: 4 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			budget, err := NewDeadlineBudget(tc.agentSoft, tc.selection, tc.submit, tc.hard)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			from := time.Now()
			soft := budget.AgentSoftDeadline(from)
			selection := budget.SelectionDeadline(from)
			submit := budget.SubmitDeadline(from)
			hard := budget.HardDeadline(from)
			if !soft.After(from) || !selection.After(soft) || !submit.After(selection) || !hard.After(submit) {
				t.Fatalf("expected strictly increasing deadlines, got soft=%v selection=%v submit=%v hard=%v",
					soft, selection, submit, hard)
			}
			if want := from.Add(tc.agentSoft); !soft.Equal(want) {
				t.Fatalf("agentSoft deadline: got %v, want %v", soft, want)
			}
			if want := from.Add(tc.hard); !hard.Equal(want) {
				t.Fatalf("hard deadline: got %v, want %v", hard, want)
			}
		})
	}
}

// TestLeaseConcurrentSubmit 并发：10 goroutine 并发 SubmitCandidate 无 panic
// （-race 覆盖数据竞争），全部 accepted（无人关闭/过期）。
func TestLeaseConcurrentSubmit(t *testing.T) {
	registry := NewLeaseRegistry(4)
	lease := registry.StartDecision("run-conc", 42, "hash-conc", time.Now().Add(time.Minute))

	const goroutines = 10
	const iterations = 50
	var wg sync.WaitGroup
	results := make(chan LeaseResult, goroutines*iterations)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				results <- lease.SubmitCandidate(leasePlan(42))
			}
		}()
	}
	wg.Wait()
	close(results)

	count := 0
	for result := range results {
		count++
		if !result.Accepted {
			t.Fatalf("expected all concurrent submits accepted, got %+v", result)
		}
	}
	if count != goroutines*iterations {
		t.Fatalf("expected %d results, got %d", goroutines*iterations, count)
	}
}
