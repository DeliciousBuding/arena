// Deadline 预算：把决策窗口切成四段严格递增的相对截止（对齐 TS 版
// deadline-budget.ts 的边界语义：now >= deadline 即过期；本层只提供
// 构造与截止查询，测试全用短时长，不 sleep 真实长等待）。
package runtime

import (
	"fmt"
	"time"
)

// DeadlineBudget 是决策窗口的四段相对截止预算。
// 校验不变量：0 < agentSoft < selection < submit < hard。
type DeadlineBudget struct {
	agentSoft time.Duration
	selection time.Duration
	submit    time.Duration
	hard      time.Duration
}

// NewDeadlineBudget 构造截止预算；顺序不满足严格递增（或存在非正段）
// 返回 error。
func NewDeadlineBudget(agentSoft, selection, submit, hard time.Duration) (*DeadlineBudget, error) {
	if !(agentSoft > 0 && selection > agentSoft && submit > selection && hard > submit) {
		return nil, fmt.Errorf(
			"DeadlineBudget: must satisfy 0 < agentSoft < selection < submit < hard, got (%v, %v, %v, %v)",
			agentSoft, selection, submit, hard,
		)
	}
	return &DeadlineBudget{
		agentSoft: agentSoft,
		selection: selection,
		submit:    submit,
		hard:      hard,
	}, nil
}

// AgentSoftDeadline 返回 agentSoft 截止（相对 from 的绝对时刻）。
func (b *DeadlineBudget) AgentSoftDeadline(from time.Time) time.Time {
	return from.Add(b.agentSoft)
}

// SelectionDeadline 返回 selection 截止。
func (b *DeadlineBudget) SelectionDeadline(from time.Time) time.Time {
	return from.Add(b.selection)
}

// SubmitDeadline 返回 submit 截止。
func (b *DeadlineBudget) SubmitDeadline(from time.Time) time.Time {
	return from.Add(b.submit)
}

// HardDeadline 返回 hard 截止。
func (b *DeadlineBudget) HardDeadline(from time.Time) time.Time {
	return from.Add(b.hard)
}
