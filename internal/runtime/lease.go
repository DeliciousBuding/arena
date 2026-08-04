// 决策租约与租约注册表：tick 粒度的候选提交门禁。
//
// 语义对齐 TS 版暗卷（decision-coordinator / decision-lease /
// lease-registry）：stale/late/越权候选 100% 拒绝——runID 错（越权）、
// tick 错（迟到）、stateHash 错（stale）、过期（late）、租约已关闭。
package runtime

import (
	"fmt"
	"sync"
	"time"

	"github.com/deliciousbuding/arena/internal/domain"
)

// LeaseResult 是候选计划提交结果。
type LeaseResult struct {
	Accepted bool
	Reason   string
}

// 候选拒绝原因。顺序即安全语义，见 DecisionLease.SubmitCandidate。
const (
	ReasonRejectedRunID     = "rejected_runid"     // 越权：候选声明的 runID 与当前决策不符
	ReasonRejectedTick      = "rejected_tick"      // 迟到：计划 tick 与租约 tick 不符
	ReasonRejectedStateHash = "rejected_statehash" // stale：候选基于过期状态快照
	ReasonRejectedExpired   = "rejected_expired"   // 超过 deadline
	ReasonRejectedClosed    = "rejected_closed"    // 租约已关闭
)

// DecisionLease 是单个 tick 的决策租约（runID/tick/stateHash/deadline 门禁）。
//
// 身份字段（runID/tick/stateHash/deadline）创建后不可变，可无锁并发读；
// closed 是唯一可变状态，由租约自身互斥锁保护。registry 是权威身份来源：
// 候选身份声明绑定于租约（arena_plan 工具参数的 runId/tick/stateHash 经
// StartDecision 登记），权威身份 = registry 当前按 tick 注册的租约——被新
// 决策取代（世界重置/新 run）的旧租约提交精确拒绝为 runID/stateHash 错。
type DecisionLease struct {
	mu        sync.Mutex
	registry  *LeaseRegistry
	runID     string
	tick      int64
	stateHash string
	deadline  time.Time
	closed    bool
}

func newDecisionLease(registry *LeaseRegistry, runID string, tick int64, stateHash string, deadline time.Time) *DecisionLease {
	return &DecisionLease{
		registry:  registry,
		runID:     runID,
		tick:      tick,
		stateHash: stateHash,
		deadline:  deadline,
	}
}

// SubmitCandidate 提交候选计划。校验顺序即安全语义（对齐 TS 版暗卷
// stale/late/越权 100% 拒绝）：runID → tick → stateHash → closed → expired。
//
// 身份校验在锁外完成（身份字段不可变；权威身份经 registry 读取，不产生
// 锁嵌套）；closed/expired 在租约锁内校验。plan.Tick 是计划自身的 tick
// 声明；runID/stateHash 声明即租约绑定值。
func (l *DecisionLease) SubmitCandidate(plan *domain.Plan) LeaseResult {
	current := l.registry.currentLease(l.tick)
	if current != nil && l.runID != current.runID {
		return LeaseResult{Reason: ReasonRejectedRunID}
	}
	if plan == nil || int64(plan.Tick) != l.tick {
		return LeaseResult{Reason: ReasonRejectedTick}
	}
	if current != nil && l.stateHash != current.stateHash {
		return LeaseResult{Reason: ReasonRejectedStateHash}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return LeaseResult{Reason: ReasonRejectedClosed}
	}
	if time.Now().After(l.deadline) {
		return LeaseResult{Reason: ReasonRejectedExpired}
	}
	return LeaseResult{Accepted: true}
}

// markClosed 终结租约；此后所有提交返回 rejected_closed。
// 调用方（registry）持有注册表锁时调用，本方法自行获取租约锁。
func (l *DecisionLease) markClosed() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
}

// LeaseRegistry 是 tick 精确索引的租约注册表：持有每个 tick 的当前租约
// （权威身份），有界清理（超限淘汰最旧租约并关闭）。
type LeaseRegistry struct {
	mu        sync.Mutex
	leases    map[int64]*DecisionLease
	order     []int64 // FIFO 创建顺序（淘汰最旧）
	maxActive int
}

// NewLeaseRegistry 创建有界租约注册表；maxActive < 1 视为编程错误。
func NewLeaseRegistry(maxActive int) *LeaseRegistry {
	if maxActive < 1 {
		panic(fmt.Sprintf("LeaseRegistry: maxActive must be >= 1, got %d", maxActive))
	}
	return &LeaseRegistry{
		leases:    make(map[int64]*DecisionLease),
		maxActive: maxActive,
	}
}

// StartDecision 为 tick 开启决策租约并登记为当前权威。同 tick 已有租约时
// 被取代（权威身份切换；旧租约保持打开，其提交经身份校验拒绝）。
// 超过 maxActive 时淘汰最旧租约（关闭并移除）。
func (r *LeaseRegistry) StartDecision(runID string, tick int64, stateHash string, deadline time.Time) *DecisionLease {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i, existing := range r.order {
		if existing == tick {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
	lease := newDecisionLease(r, runID, tick, stateHash, deadline)
	r.leases[tick] = lease
	r.order = append(r.order, tick)

	for len(r.leases) > r.maxActive {
		oldestTick := r.order[0]
		r.order = r.order[1:]
		if evicted, ok := r.leases[oldestTick]; ok {
			delete(r.leases, oldestTick)
			evicted.markClosed()
		}
	}
	return lease
}

// Get 返回 tick 的当前租约；不存在（未注册或已被淘汰）返回 nil。
func (r *LeaseRegistry) Get(tick int64) *DecisionLease {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.leases[tick]
}

// CloseLease 关闭 tick 的当前租约；关闭后其 SubmitCandidate 返回
// rejected_closed（身份校验仍优先，顺序语义见 SubmitCandidate）。
func (r *LeaseRegistry) CloseLease(tick int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if lease, ok := r.leases[tick]; ok {
		lease.markClosed()
	}
}

// currentLease 返回 tick 当前注册的租约（权威身份来源）。
func (r *LeaseRegistry) currentLease(tick int64) *DecisionLease {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.leases[tick]
}
