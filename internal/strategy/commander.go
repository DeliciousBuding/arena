package strategy

import (
	"github.com/deliciousbuding/arena/internal/domain"
)

// 指挥层（Command & Control，docs/go/08-command-design.md）：
// 观察全局经济态势（资源/工人/可见资源格/停滞计数），输出确定性
// 模式指令（Directive）。战术层（Planner）按指令调整行为。
// 设计原则：不接触游戏、无副作用、同输入序列同输出序列。

// DirectiveMode 是全局指挥模式。
type DirectiveMode string

// DirectiveMode 枚举。
const (
	ModeGrowth         DirectiveMode = "GROWTH"          // 正常扩张（默认）
	ModeExploreStarved DirectiveMode = "EXPLORE_STARVED" // 资源枯竭：集中扫掠
	ModeMigrateCand    DirectiveMode = "MIGRATE_CAND"    // 迁移候选（只评估不执行）
)

// 模式切换阈值（docs/go/08-command-design.md §2）。
const (
	starvedThresholdTicks = 30  // 无进展连续 tick 数 → EXPLORE_STARVED
	migrateCandidateTicks = 100 // EXPLORE_STARVED 持续 → MIGRATE_CAND
)

// Directive 是指挥层输出（每 tick 由 Loop 传递给 Planner）。
type Directive struct {
	Mode DirectiveMode
	// Focus 是探索焦点（EXPLORE_STARVED 时所有 worker 朝此方向扫掠；
	// 默认 Beacon 方位）。
	Focus domain.Position
}

// Commander 是指挥层（跨 tick 持久：停滞计数与最近指标）。
// 指标来源为 state 快照（resources/workers/ResourceCells），
// 重启后从零开始（与 planner 持久状态一致，不跨进程）。
type Commander struct {
	noProgressTicks int
	lastResources   int
	lastWorkers     int
}

// NewCommander 构造指挥层。
func NewCommander() *Commander {
	return &Commander{}
}

// Update 每 tick 调用：观察全局指标，返回当前指令。
// 无进展定义：资源未增 + 工人未增 + 零可见资源格（连续计数）。
// 任一进展出现即重置计数（回到 GROWTH）。
func (c *Commander) Update(state *domain.TickState) Directive {
	workers := len(state.Workers)
	if state.Resources > c.lastResources || workers > c.lastWorkers ||
		state.ResourceCells.Len() > 0 {
		c.noProgressTicks = 0
	} else {
		c.noProgressTicks++
	}
	c.lastResources = state.Resources
	c.lastWorkers = workers

	mode := ModeGrowth
	if c.noProgressTicks >= migrateCandidateTicks {
		mode = ModeMigrateCand
	} else if c.noProgressTicks >= starvedThresholdTicks {
		mode = ModeExploreStarved
	}
	return Directive{
		Mode:  mode,
		Focus: state.Beacon.Position,
	}
}

// Reset 重置指挥层（测试/运维用）。
func (c *Commander) Reset() {
	c.noProgressTicks = 0
	c.lastResources = 0
	c.lastWorkers = 0
}
