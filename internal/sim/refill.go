package sim

import (
	"math"

	"github.com/deliciousbuding/arena/internal/domain"
)

// 资源 refill 规则（官方 v0.13 视野研究结论）：
//   - 资源每 4 tick 每个 chunk 配额补满：max(2, floor(128/(8+ring)))；
//   - chunk 大小 32×32（坐标按 chunk 原点对齐）；
//   - ring = chunk 距世界原点 Chebyshev 环（0,1,2,...）；
//   - 只有视野扫过的格才 reveal（进入 ResourceCells）；
//   - 采空格立即消失（harvest 成功后从 ResourceCells 移除）。
//
// sim 实现：Engine 可选挂载 RefillConfig（nil = 不启用，保持纯结算）；
// 潜在资源格池（服务器秘密）由调用方构造，settle 后执行 reveal/refill。
const (
	refillEveryTicks = 4
	chunkSize        = 32
)

// refillState 是潜在资源格的可见性状态。
type refillState string

const (
	refillActive refillState = "active" // 可被视野 reveal
	refillMined  refillState = "mined"  // 刚被采空，refill 前不可见
)

// refillCell 是潜在资源格（服务器秘密池的模拟条目）。
type refillCell struct {
	position domain.Position
	state    refillState
}

// RefillConfig 是资源 refill 引擎配置（跨 tick 有状态；单写者使用，
// 与 runtime Loop 一致）。NewEngine 默认不启用。
type RefillConfig struct {
	EveryTicks int // 补满周期（官方 4）
	ChunkSize  int // chunk 边长（官方 32）
	latent     map[string]*refillCell
	lastRefill int // 上次 refill 的 tick
}

// NewRefillConfig 构造 refill 配置：latentCells 是潜在资源格全集
// （模拟服务器秘密分布；通常按 chunk 配额构造）。
func NewRefillConfig(latentCells []domain.Position) *RefillConfig {
	config := &RefillConfig{
		EveryTicks: refillEveryTicks,
		ChunkSize:  chunkSize,
		latent:     make(map[string]*refillCell, len(latentCells)),
	}
	for _, pos := range latentCells {
		config.latent[domain.CellKey(pos[0], pos[1])] = &refillCell{position: pos, state: refillActive}
	}
	return config
}

// chunkOrigin 返回格所在 chunk 的原点（floor 对齐到 chunk 网格）。
func (c *RefillConfig) chunkOrigin(position domain.Position) domain.Position {
	origin := func(coord int) int {
		return int(math.Floor(float64(coord)/float64(c.ChunkSize))) * c.ChunkSize
	}
	return domain.Position{origin(position[0]), origin(position[1])}
}

// ring 返回 chunk 的 Chebyshev 环（距世界原点）。
func (c *RefillConfig) ring(origin domain.Position) int {
	ax := origin[0]
	if ax < 0 {
		ax = -ax
	}
	ay := origin[1]
	if ay < 0 {
		ay = -ay
	}
	ring := ax
	if ay > ring {
		ring = ay
	}
	return ring / c.ChunkSize
}

// chunkQuota 返回 chunk 的 refill 配额（官方公式）。
func (c *RefillConfig) chunkQuota(origin domain.Position) int {
	quota := int(math.Floor(128 / float64(8+c.ring(origin))))
	if quota < 2 {
		return 2
	}
	return quota
}

// reveal 把视野内的 active 潜在格加入 ResourceCells（视野揭示语义）。
func (c *RefillConfig) reveal(state *domain.TickState) {
	for key, cell := range c.latent {
		if cell.state != refillActive {
			continue
		}
		if !InUnionVision(state, cell.position) {
			continue
		}
		state.ResourceCells.Add(key)
	}
}

// refill 每 4 tick 把已采空格恢复为 active（chunk 配额内），
// 模拟服务器补满配额。
func (c *RefillConfig) refill(state *domain.TickState) {
	byChunk := make(map[domain.Position][]*refillCell)
	for _, cell := range c.latent {
		origin := c.chunkOrigin(cell.position)
		byChunk[origin] = append(byChunk[origin], cell)
	}
	for origin, cells := range byChunk {
		quota := c.chunkQuota(origin)
		activeCount := 0
		mined := make([]*refillCell, 0, len(cells))
		for _, cell := range cells {
			if cell.state == refillActive {
				activeCount++
			} else {
				mined = append(mined, cell)
			}
		}
		// 补到配额：mined 格按确定性顺序（坐标升序）恢复。
		for _, cell := range mined {
			if activeCount >= quota {
				break
			}
			cell.state = refillActive
			activeCount++
		}
	}
}

// markMined 记录采空格（harvest 成功后调用；服务器语义：采空格立即
// 消失，refill 前不可见）。
func (c *RefillConfig) markMined(position domain.Position) {
	if cell := c.latent[domain.CellKey(position[0], position[1])]; cell != nil {
		cell.state = refillMined
	}
}

// applyRefillAndReveal 是 Settle 末尾的资源刷新钩子：refill 每
// EveryTicks 执行（以 next.Tick 为当前 tick），reveal 每 tick 执行——
// 先补满再揭示：服务器补满配额的同 tick，视野内的格立即可见。
func (c *RefillConfig) applyRefillAndReveal(state *domain.TickState) {
	if c == nil {
		return
	}
	if state.Tick%c.EveryTicks == 0 && state.Tick > c.lastRefill {
		c.refill(state)
		c.lastRefill = state.Tick
	}
	c.reveal(state)
}
