package domain

import (
	"errors"
	"fmt"
	"math"
)

// 路径搜索常量（与 TS 版 nav.ts 一致）。
const (
	// exploreDirectionCount 是探索方位数（顺时针 8 方位）。
	exploreDirectionCount = 8
	// exploreRingCount 是探索扩圈层级数。
	exploreRingCount = 4
	// maxVisitedNodes 是单次 BFS 的访问上限（TS 版 visited.size <= 20_000，
	// 有界搜索防振荡：超限即放弃，由调用方扩大 margin 或走 fail-safe）。
	maxVisitedNodes = 20_000
)

// directionOrder 是 orderedDirections 的补齐顺序（与 TS 版一致）。
var directionOrder = []Direction{DirectionRight, DirectionDown, DirectionLeft, DirectionUp}

// pathMargins 是 stepToward 逐级扩大的搜索边界（与 TS 版一致）。
var pathMargins = []int{4, 8, 16, 32}

// exploreDeltas 是顺时针 8 方位：东、东南、南、西南、西、西北、北、东北。
var exploreDeltas = []Position{
	{1, 0}, {1, 1}, {0, 1}, {-1, 1}, {-1, 0}, {-1, -1}, {0, -1}, {1, -1},
}

// directionDelta 是四向移动的坐标增量。
var directionDelta = map[Direction]Position{
	DirectionUp:    {0, -1},
	DirectionDown:  {0, 1},
	DirectionLeft:  {-1, 0},
	DirectionRight: {1, 0},
}

// ErrNoPath 表示在给定边界内无可达路径（目标被障碍包围或超出搜索框）。
var ErrNoPath = errors.New("no path within margin bounds")

// Manhattan 返回曼哈顿距离（TS 版 manhattan）。
func Manhattan(a, b Position) int {
	return abs(a[0]-b[0]) + abs(a[1]-b[1])
}

// Chebyshev 返回切比雪夫距离（TS 版 chebyshev）。
func Chebyshev(a, b Position) int {
	return max(abs(a[0]-b[0]), abs(a[1]-b[1]))
}

// Move 返回从 position 沿 direction 移动一格后的坐标（未知方向原样返回，
// 调用方应先用 ValidDirection 校验）。
func Move(position Position, direction Direction) Position {
	delta, ok := directionDelta[direction]
	if !ok {
		return position
	}
	return Position{position[0] + delta[0], position[1] + delta[1]}
}

// DirectionToAdjacent 返回从 from 到相邻格 to 的方向；不相邻返回 ok=false
// （TS 版 directionToAdjacent）。
func DirectionToAdjacent(from, to Position) (Direction, bool) {
	dx := to[0] - from[0]
	dy := to[1] - from[1]
	if abs(dx)+abs(dy) != 1 {
		return "", false
	}
	switch {
	case dx == 1:
		return DirectionRight, true
	case dx == -1:
		return DirectionLeft, true
	case dy == 1:
		return DirectionDown, true
	default:
		return DirectionUp, true
	}
}

// LineBlocked 报告 a→b 视线是否被障碍遮挡（与 TS 版 lineBlocked 同语义：
// 相邻恒畅通；非整步长（不共线）视为遮挡）。obstacles 为 cell-key
// （"x,y"）集合。
func LineBlocked(a, b Position, obstacles Set[string]) bool {
	dx := b[0] - a[0]
	dy := b[1] - a[1]
	steps := max(abs(dx), abs(dy))
	if steps <= 1 {
		return false
	}
	sx := 0
	if dx != 0 {
		sx = dx / steps
	}
	sy := 0
	if dy != 0 {
		sy = dy / steps
	}
	if sx*steps != dx || sy*steps != dy {
		return true
	}
	for step := 1; step < steps; step++ {
		if obstacles.Contains(CellKey(a[0]+sx*step, a[1]+sy*step)) {
			return true
		}
	}
	return false
}

// ShortestPath 返回 from→to 的最短路（含两端，逐格相邻），障碍视为永久
// 阻塞。有界搜索与 ShortestPathFirstStep 同边界：margin 边界框 +
// 20,000 访问上限；框内不可达返回 ErrNoPath。from==to 返回单元素路径。
// obstacles 为 cell-key（"x,y"）集合。
func ShortestPath(from, to Position, obstacles Set[string], margin int) ([]Position, error) {
	if from == to {
		return []Position{from}, nil
	}
	minX, maxX, minY, maxY := searchBounds(from, to, margin)
	queue := make([]bfsNode, 0, 64)
	queue = append(queue, bfsNode{position: from, parentIndex: -1})
	visited := map[Position]int{from: 0}
	head := 0
	for head < len(queue) && len(visited) <= maxVisitedNodes {
		current := queue[head]
		head++
		for _, direction := range orderedDirections(current.position, to) {
			next := Move(current.position, direction)
			if next[0] < minX || next[0] > maxX || next[1] < minY || next[1] > maxY {
				continue
			}
			if _, seen := visited[next]; seen {
				continue
			}
			if obstacles.Contains(CellKey(next[0], next[1])) {
				continue
			}
			if next == to {
				return reconstructPath(queue, head-1, next), nil
			}
			visited[next] = len(queue)
			queue = append(queue, bfsNode{position: next, parentIndex: head - 1})
		}
	}
	return nil, ErrNoPath
}

// ShortestPathFirstStep 在 margin 边界框内做有界 BFS，返回 from→to 最短路
// 的第一步（与 TS 版 shortestPathFirstStep 同语义）。不可达返回 ok=false。
// obstacles 为 cell-key（"x,y"）集合。
func ShortestPathFirstStep(from, to Position, obstacles Set[string], margin int) (Direction, bool) {
	minX, maxX, minY, maxY := searchBounds(from, to, margin)
	type firstStepNode struct {
		position       Position
		firstDirection Direction
	}
	queue := make([]firstStepNode, 0, 64)
	queue = append(queue, firstStepNode{position: from})
	visited := NewSet(from)
	head := 0
	for head < len(queue) && visited.Len() <= maxVisitedNodes {
		current := queue[head]
		head++
		for _, direction := range orderedDirections(current.position, to) {
			next := Move(current.position, direction)
			if next[0] < minX || next[0] > maxX || next[1] < minY || next[1] > maxY {
				continue
			}
			if visited.Contains(next) || obstacles.Contains(CellKey(next[0], next[1])) {
				continue
			}
			firstDirection := direction
			if current.firstDirection != "" {
				firstDirection = current.firstDirection
			}
			if next == to {
				return firstDirection, true
			}
			visited.Add(next)
			queue = append(queue, firstStepNode{position: next, firstDirection: firstDirection})
		}
	}
	return "", false
}

// StepToward 返回朝 target 的最短路径第一步（与 TS 版 stepToward 同语义）：
// 依次尝试 margin 4/8/16/32 的有界 BFS；全部失败时 fail-safe 走一个不撞墙
// 且尽量朝向目标的格（绕长墙防振荡）；四周全堵或已在目标格返回 ok=false
// （调用方应 WAIT）。obstacles 为 cell-key（"x,y"）集合。
func StepToward(position, target Position, obstacles Set[string]) (Direction, bool) {
	if position == target {
		return "", false
	}
	for _, margin := range pathMargins {
		if direction, ok := ShortestPathFirstStep(position, target, obstacles, margin); ok {
			return direction, true
		}
	}
	for _, direction := range orderedDirections(position, target) {
		if !obstacles.Contains(CellKey(Move(position, direction)[0], Move(position, direction)[1])) {
			return direction, true
		}
	}
	return "", false
}

// bfsNode 是 BFS 队列节点（parentIndex 指向队列中父节点，-1 为起点）。
type bfsNode struct {
	position    Position
	parentIndex int
}

// reconstructPath 沿父索引回溯重建 from→to 完整路径（含两端）。
func reconstructPath(queue []bfsNode, targetIndex int, target Position) []Position {
	path := make([]Position, 0, len(queue))
	path = append(path, target)
	for index := targetIndex; index != -1; index = queue[index].parentIndex {
		path = append(path, queue[index].position)
	}
	for left, right := 0, len(path)-1; left < right; left, right = left+1, right-1 {
		path[left], path[right] = path[right], path[left]
	}
	return path
}

// searchBounds 返回 margin 边界框（TS 版 shortestPathFirstStep 同式）。
func searchBounds(from, to Position, margin int) (minX, maxX, minY, maxY int) {
	minX = min(from[0], to[0]) - margin
	maxX = max(from[0], to[0]) + margin
	minY = min(from[1], to[1]) - margin
	maxY = max(from[1], to[1]) + margin
	return minX, maxX, minY, maxY
}

// orderedDirections 返回确定性方向顺序（与 TS 版同语义）：优先主轴向
// （|dx| >= |dy| 时 x 优先），再按 RIGHT/DOWN/LEFT/UP 补齐。
func orderedDirections(from, target Position) []Direction {
	dx := target[0] - from[0]
	dy := target[1] - from[1]
	preferred := make([]Direction, 0, 4)
	if abs(dx) >= abs(dy) {
		if dx > 0 {
			preferred = append(preferred, DirectionRight)
		} else if dx < 0 {
			preferred = append(preferred, DirectionLeft)
		}
		if dy > 0 {
			preferred = append(preferred, DirectionDown)
		} else if dy < 0 {
			preferred = append(preferred, DirectionUp)
		}
	} else {
		if dy > 0 {
			preferred = append(preferred, DirectionDown)
		} else if dy < 0 {
			preferred = append(preferred, DirectionUp)
		}
		if dx > 0 {
			preferred = append(preferred, DirectionRight)
		} else if dx < 0 {
			preferred = append(preferred, DirectionLeft)
		}
	}
	for _, direction := range directionOrder {
		if !containsDirection(preferred, direction) {
			preferred = append(preferred, direction)
		}
	}
	return preferred
}

func containsDirection(directions []Direction, target Direction) bool {
	for _, direction := range directions {
		if direction == target {
			return true
		}
	}
	return false
}

// ExploreRadiusForRing 返回指定环的探索半径：base、2×base、3×base、
// 4×base 循环（与 TS 版 exploreRadiusForRing 同语义；负索引循环回绕）。
func ExploreRadiusForRing(baseRadius, ringIndex int) (int, error) {
	if baseRadius < 1 {
		return 0, fmt.Errorf("baseRadius must be a positive integer: %d", baseRadius)
	}
	normalized := ((ringIndex % exploreRingCount) + exploreRingCount) % exploreRingCount
	return baseRadius * (normalized + 1), nil
}

// ExploreTarget 返回以 home 为圆心、beacon 方向为第 0 方位、index 偏移的
// 探索目标（与 TS 版 exploreTarget 同语义）。
func ExploreTarget(home, beacon Position, index, radius int) Position {
	dx := beacon[0] - home[0]
	dy := beacon[1] - home[1]
	base := exploreOctant(dx, dy)
	delta := exploreDeltas[(base+index)%exploreDirectionCount]
	return Position{home[0] + delta[0]*radius, home[1] + delta[1]*radius}
}

// exploreOctant 将方位角映射到 0..7 的八方位索引（与 TS 版同语义；
// Go 用 math.Round，与 JS Math.round 的差异仅出现在非整倍数 π/4 的
// 边界角，探索目标为启发式用途，不影响确定性）。
func exploreOctant(dx, dy int) int {
	if dx == 0 && dy == 0 {
		return 0
	}
	angle := math.Atan2(float64(dy), float64(dx))
	octant := int(math.Round(angle / (math.Pi / 4)))
	return (octant + exploreDirectionCount) % exploreDirectionCount
}

// Nearest 返回距 position 最近的目标（曼哈顿距离，同距离取 x 小再 y 小；
// 与 TS 版 nearest 同语义）。无目标返回 nil。
func Nearest(targets []Position, position Position) *Position {
	var best *Position
	bestKey := [3]int{}
	for _, target := range targets {
		key := [3]int{Manhattan(position, target), target[0], target[1]}
		if best == nil || compareTuple(key, bestKey) < 0 {
			copy := target
			best = &copy
			bestKey = key
		}
	}
	return best
}

func compareTuple(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			return a[i] - b[i]
		}
	}
	return 0
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
