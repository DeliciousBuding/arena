package runtime

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/hero"
	"github.com/deliciousbuding/arena/internal/telemetry"
)

// stubClient 是可注入的 GameClient：驱动事件流并记录提交。
type stubClient struct {
	events    chan hero.Event
	streamErr error
	submits   []string
	submitErr error
	mu        sync.Mutex
}

func (s *stubClient) Events(ctx context.Context) <-chan hero.Event { return s.events }
func (s *stubClient) Err() error                                   { return s.streamErr }
func (s *stubClient) Close()                                       {}

func (s *stubClient) Submit(_ context.Context, _ contracts.CommandPlan, key string) (*contracts.Accepted, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.submits = append(s.submits, key)
	if s.submitErr != nil {
		return nil, s.submitErr
	}
	return &contracts.Accepted{Accepted: true}, nil
}

func (s *stubClient) submitCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.submits)
}

// stubPlanner 按序返回注入的计划（决定计数可断言）；计划的 Tick 需与
// state 匹配（Validator tick_mismatch 校验）。
type stubPlanner struct {
	plans []*domain.Plan
}

func (p *stubPlanner) Decide(state *domain.TickState) *domain.Plan {
	plan := p.plans[0]
	plan.Tick = state.Tick
	if len(p.plans) > 1 {
		p.plans = p.plans[1:]
	}
	return plan
}

// validPlan 返回空计划（Validator 通过）。
func validPlan() *domain.Plan {
	return &domain.Plan{Tick: 1, UnitActions: map[string]domain.UnitAction{}}
}

// invalidPlan 返回 MOVE 缺 direction 的计划（Validator 必然 repair）。
func invalidPlan() *domain.Plan {
	return &domain.Plan{
		Tick: 1,
		UnitActions: map[string]domain.UnitAction{
			"u1": {Kind: domain.ActionMove}, // 缺 Direction = 非法
		},
	}
}

// emptyState 构造可 Reduce 的最小 state（无单位/资源）。
func emptyState() *contracts.PlayerState {
	return &contracts.PlayerState{Objects: []contracts.Object{}}
}

// newTestLoop 构造最小 Loop（live 模式 + 文件 telemetry）。
func newTestLoop(t *testing.T, client *stubClient, planner *stubPlanner) (*Loop, string) {
	t.Helper()
	decisionPath := t.TempDir() + "/decision.jsonl"
	decisionLog, err := telemetry.Open(decisionPath)
	if err != nil {
		t.Fatalf("open decision log: %v", err)
	}
	loop := &Loop{
		Client:  client,
		Planner: planner,
		Config: TenantConfig{
			TenantID:       "test",
			DecisionMode:   "deterministic",
			SubmissionMode: ModeLive,
		},
		DecisionLog: decisionLog,
	}
	return loop, decisionPath
}

// pushTickState 依次推送 tick 信封与 state。
func pushTickState(client *stubClient, tick int) {
	client.events <- hero.Event{Kind: hero.TickEvent, Tick: tick}
	client.events <- hero.Event{Kind: hero.StateEvent, State: *emptyState()}
}

// TestRunExactlyOnceOnReplayedTick：重连重放同一 tick 只产生一次
// 决策与一次提交（decision.jsonl 2 条、submit 2 次、ProcessedTicks 唯一计数）。
func TestRunExactlyOnceOnReplayedTick(t *testing.T) {
	client := &stubClient{events: make(chan hero.Event, 8)}
	loop, decisionPath := newTestLoop(t, client, &stubPlanner{plans: []*domain.Plan{validPlan()}})
	defer loop.Close()

	// tick 5 + state；然后重放 tick 5 + state（服务器重连语义）；再进 tick 6。
	pushTickState(client, 5)
	pushTickState(client, 5) // 重放
	pushTickState(client, 6)
	close(client.events)

	if err := loop.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := loop.Stats.ProcessedTicks.Load(); got != 2 {
		t.Errorf("ProcessedTicks = %d, want 2 (unique ticks 5,6)", got)
	}
	if got := client.submitCount(); got != 2 {
		t.Errorf("submits = %d, want 2", got)
	}
	loop.Close()
	if lines := jsonlLineCount(t, decisionPath); lines != 2 {
		t.Errorf("decision records = %d, want 2 (duplicate tick must not be re-decided)", lines)
	}
}

// TestRunStopsOnDeterministicRepair：deterministic planner 产出非法动作
// 时 Run 立即返回错误（不再继续消费后续 tick）。
func TestRunStopsOnDeterministicRepair(t *testing.T) {
	client := &stubClient{events: make(chan hero.Event, 8)}
	loop, _ := newTestLoop(t, client, &stubPlanner{plans: []*domain.Plan{invalidPlan()}})
	defer loop.Close()

	pushTickState(client, 7)
	close(client.events)

	err := loop.Run(context.Background())
	if err == nil {
		t.Fatal("Run = nil, want deterministic repair error")
	}
	if !containsRepair(err) {
		t.Errorf("Run error = %v, want deterministic repair error", err)
	}
	// 后续 tick 不再处理。
	if got := loop.Stats.ProcessedTicks.Load(); got != 0 {
		t.Errorf("ProcessedTicks = %d, want 0 (stop before any completion)", got)
	}
}

// TestRunStopsOnSubmitRejection：submit 被拒绝时 Run 立即返回错误。
func TestRunStopsOnSubmitRejection(t *testing.T) {
	client := &stubClient{events: make(chan hero.Event, 8), submitErr: errors.New("409 IDEMPOTENCY_CONFLICT")}
	loop, _ := newTestLoop(t, client, &stubPlanner{plans: []*domain.Plan{validPlan()}})
	defer loop.Close()

	pushTickState(client, 9)
	close(client.events)

	err := loop.Run(context.Background())
	if err == nil {
		t.Fatal("Run = nil, want submit rejection error")
	}
	if !containsSubmitReject(err) {
		t.Errorf("Run error = %v, want submit rejection error", err)
	}
	if got := loop.Stats.RejectedSubmits.Load(); got != 1 {
		t.Errorf("RejectedSubmits = %d, want 1", got)
	}
}

func jsonlLineCount(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read jsonl: %v", err)
	}
	return strings.Count(strings.TrimSpace(string(data)), "\n") + 1
}

func containsRepair(err error) bool {
	return err != nil && strings.Contains(err.Error(), "invalid actions")
}

func containsSubmitReject(err error) bool {
	return err != nil && strings.Contains(err.Error(), "409")
}
