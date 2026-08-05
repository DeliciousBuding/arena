package domain

import (
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

func TestManhattanAndChebyshev(t *testing.T) {
	if got := Manhattan(Position{0, 0}, Position{3, 4}); got != 7 {
		t.Errorf("manhattan = %d, want 7", got)
	}
	if got := Manhattan(Position{-2, 5}, Position{1, 1}); got != 7 {
		t.Errorf("manhattan negative = %d, want 7", got)
	}
	if got := Chebyshev(Position{0, 0}, Position{3, 4}); got != 4 {
		t.Errorf("chebyshev = %d, want 4", got)
	}
}

func TestMoveDirections(t *testing.T) {
	cases := []struct {
		direction Direction
		want      Position
	}{
		{DirectionUp, Position{5, 4}},
		{DirectionDown, Position{5, 6}},
		{DirectionLeft, Position{4, 5}},
		{DirectionRight, Position{6, 5}},
	}
	for _, tc := range cases {
		if got := Move(Position{5, 5}, tc.direction); got != tc.want {
			t.Errorf("move %s = %v, want %v", tc.direction, got, tc.want)
		}
	}
	if got := Move(Position{5, 5}, Direction("DIAGONAL")); got != (Position{5, 5}) {
		t.Errorf("unknown direction must not move, got %v", got)
	}
}

func TestDirectionToAdjacent(t *testing.T) {
	cases := []struct {
		to    Position
		want  Direction
		valid bool
	}{
		{Position{1, 0}, DirectionRight, true},
		{Position{-1, 0}, DirectionLeft, true},
		{Position{0, 1}, DirectionDown, true},
		{Position{0, -1}, DirectionUp, true},
		{Position{1, 1}, "", false},
		{Position{2, 0}, "", false},
		{Position{0, 0}, "", false},
	}
	for _, tc := range cases {
		got, ok := DirectionToAdjacent(Position{0, 0}, tc.to)
		if ok != tc.valid || (tc.valid && got != tc.want) {
			t.Errorf("directionToAdjacent(%v) = %s/%v, want %s/%v", tc.to, got, ok, tc.want, tc.valid)
		}
	}
}

func TestLineBlocked(t *testing.T) {
	obstacles := NewSet(CellKey(3, 0), CellKey(0, 2))
	if !LineBlocked(Position{0, 0}, Position{5, 0}, obstacles) {
		t.Error("straight line through obstacle must be blocked")
	}
	if LineBlocked(Position{0, 0}, Position{2, 0}, obstacles) {
		t.Error("short line without obstacle must be clear")
	}
	if LineBlocked(Position{2, 0}, Position{3, 0}, obstacles) {
		t.Error("adjacent cells are always clear")
	}
	if LineBlocked(Position{0, 0}, Position{2, 2}, NewSet[string]()) {
		t.Error("clean diagonal must be clear")
	}
	if !LineBlocked(Position{0, 0}, Position{2, 1}, NewSet[string]()) {
		t.Error("non-colinear step must be treated as blocked (TS semantics)")
	}
	if LineBlocked(Position{0, 0}, Position{0, 4}, NewSet(CellKey(1, 1), CellKey(-1, 2))) {
		t.Error("unrelated obstacles must not block")
	}
}

func TestShortestPathSimple(t *testing.T) {
	path, err := ShortestPath(Position{0, 0}, Position{3, 0}, nil, 4)
	if err != nil {
		t.Fatalf("shortest path: %v", err)
	}
	if len(path) != 4 {
		t.Fatalf("path length = %d, want 4", len(path))
	}
	want := []Position{{0, 0}, {1, 0}, {2, 0}, {3, 0}}
	for i := range want {
		if path[i] != want[i] {
			t.Errorf("path[%d] = %v, want %v", i, path[i], want[i])
		}
	}
	if direction, ok := ShortestPathFirstStep(Position{0, 0}, Position{3, 0}, nil, 4); !ok || direction != DirectionRight {
		t.Errorf("first step = %s/%v, want RIGHT/true", direction, ok)
	}
}

func TestShortestPathFromToEqual(t *testing.T) {
	path, err := ShortestPath(Position{3, 3}, Position{3, 3}, nil, 4)
	if err != nil {
		t.Fatalf("trivial path: %v", err)
	}
	if len(path) != 1 || path[0] != (Position{3, 3}) {
		t.Errorf("trivial path = %v", path)
	}
	if _, ok := StepToward(Position{3, 3}, Position{3, 3}, nil); ok {
		t.Error("stepToward at target must return ok=false")
	}
}

// TestShortestPathAvoidsObstacle 验证绕障路径不穿墙且长度不小于曼哈顿下界。
func TestShortestPathAvoidsObstacle(t *testing.T) {
	wall := make(Set[string])
	for x := 1; x <= 5; x++ {
		wall.Add(CellKey(x, 0))
	}
	path, err := ShortestPath(Position{0, 0}, Position{6, 0}, wall, 4)
	if err != nil {
		t.Fatalf("shortest path: %v", err)
	}
	if err := validatePath(Position{0, 0}, Position{6, 0}, path, wall); err != nil {
		t.Fatalf("invalid path: %v", err)
	}
	if len(path)-1 < Manhattan(Position{0, 0}, Position{6, 0}) {
		t.Errorf("path %v shorter than Manhattan lower bound", path)
	}
	if len(path)-1 != 8 {
		t.Errorf("detour length = %d, want 8 (up 1, right 6, down 1)", len(path)-1)
	}
}

// TestShortestPathUnreachable 验证被包围目标返回 ErrNoPath。
func TestShortestPathUnreachable(t *testing.T) {
	ring := keySet(Position{1, 0}, Position{-1, 0}, Position{0, 1}, Position{0, -1})
	path, err := ShortestPath(Position{10, 0}, Position{0, 0}, ring, 4)
	if !errors.Is(err, ErrNoPath) {
		t.Fatalf("err = %v, want ErrNoPath (path=%v)", err, path)
	}
	if _, ok := ShortestPathFirstStep(Position{10, 0}, Position{0, 0}, ring, 4); ok {
		t.Error("first step must fail for enclosed target")
	}
}

// TestShortestPathMargins 验证长墙场景下 margin 不足不可达、扩大后可达
// （绕长墙防振荡语义）。
func TestShortestPathMargins(t *testing.T) {
	wall := make(Set[string])
	for y := -20; y <= 29; y++ {
		wall.Add(CellKey(5, y))
	}
	from := Position{4, 0}
	to := Position{6, 0}
	for _, margin := range []int{4, 8, 16} {
		if _, err := ShortestPath(from, to, wall, margin); !errors.Is(err, ErrNoPath) {
			t.Errorf("margin %d: err = %v, want ErrNoPath", margin, err)
		}
	}
	path, err := ShortestPath(from, to, wall, 32)
	if err != nil {
		t.Fatalf("margin 32 must route around the wall: %v", err)
	}
	if err := validatePath(from, to, path, wall); err != nil {
		t.Fatalf("invalid path: %v", err)
	}
}

// TestStepTowardFailsafe 验证所有 margin 失败后的 fail-safe 步进与全堵 WAIT。
func TestStepTowardFailsafe(t *testing.T) {
	// 目标被 4 格环包围：BFS 全部失败，fail-safe 走一个朝向目标的空格。
	ring := keySet(Position{9, 0}, Position{11, 0}, Position{10, 1}, Position{10, -1})
	direction, ok := StepToward(Position{0, 0}, Position{10, 0}, ring)
	if !ok {
		t.Fatal("fail-safe must move when a free cell exists")
	}
	if direction != DirectionRight {
		t.Errorf("fail-safe direction = %s, want RIGHT", direction)
	}
	// 四周全堵：返回 ok=false（调用方 WAIT）。
	boxed := keySet(Position{1, 0}, Position{-1, 0}, Position{0, 1}, Position{0, -1})
	if _, ok := StepToward(Position{0, 0}, Position{10, 0}, boxed); ok {
		t.Error("fully boxed unit must get ok=false (WAIT)")
	}
}

// TestStepTowardDirect 验证无障碍时的首选方向与遇墙绕行第一步。
func TestStepTowardDirect(t *testing.T) {
	if direction, ok := StepToward(Position{0, 0}, Position{3, 3}, nil); !ok || direction != DirectionRight {
		t.Errorf("diagonal first step = %s/%v, want RIGHT/true (x-major)", direction, ok)
	}
	wall := NewSet(CellKey(1, 0))
	if direction, ok := StepToward(Position{0, 0}, Position{3, 0}, wall); !ok || direction != DirectionDown {
		t.Errorf("detour first step = %s/%v, want DOWN/true", direction, ok)
	}
}

// TestStepTowardFastPathMatchesBFS：快速路径（主轴向 L 形无墙直走）
// 结果必须与 BFS 一致——随机障碍场景下，当 BFS 成功时 StepToward
// 的第一步必须等于 BFS 第一步（确定性验证：快速路径不漂移语义）。
// BFS 失败时 StepToward 允许走 fail-safe 方向（契约如此），不比较。
func TestStepTowardFastPathMatchesBFS(t *testing.T) {
	const iterations = 5000
	random := rand.New(rand.NewSource(20260805))
	compared := 0
	for iteration := 0; iteration < iterations; iteration++ {
		obstacles := make(Set[string])
		// 稀疏障碍（0-8 个）：覆盖快速路径命中（开阔）与回退（绕障）两态。
		for i := 0; i < random.Intn(9); i++ {
			obstacles.Add(CellKey(random.Intn(21)-10, random.Intn(21)-10))
		}
		from := Position{random.Intn(21) - 10, random.Intn(21) - 10}
		to := Position{random.Intn(21) - 10, random.Intn(21) - 10}
		if from == to {
			continue
		}
		fast, fastOK := StepToward(from, to, obstacles)
		if !fastOK {
			continue // 全堵：BFS 同样失败，跳过
		}
		// BFS 参考：margin 32（覆盖 21×21 网格内全部）。
		bfsDirection, bfsOK := ShortestPathFirstStep(from, to, obstacles, 32)
		if !bfsOK {
			continue // BFS 失败（目标不可达/被围）：fail-safe 方向合法，不比较
		}
		compared++
		if fast != bfsDirection {
			t.Fatalf("iteration %d: fast path %s != BFS %s (%v -> %v, obstacles=%v)",
				iteration, fast, bfsDirection, from, to, obstacles)
		}
	}
	if compared < 2000 {
		t.Fatalf("too few comparable cases: %d/5000", compared)
	}
	t.Logf("fast-path consistency: %d cases match BFS", compared)
}

// TestShortestPathInvariant 10,000 条随机路径：可达路径必须合法
// （端点正确、逐格相邻、不穿墙、不越 margin 边界框、长度不小于曼哈顿
// 下界）。种子固定，结果确定性。
func TestShortestPathInvariant(t *testing.T) {
	const (
		iterations     = 10_000
		gridHalf       = 10
		obstacleChance = 0.25
	)
	random := rand.New(rand.NewSource(20260802))
	reachable := 0
	for iteration := 0; iteration < iterations; iteration++ {
		obstacles := make(Set[string])
		for x := -gridHalf; x <= gridHalf; x++ {
			for y := -gridHalf; y <= gridHalf; y++ {
				if random.Float64() < obstacleChance {
					obstacles.Add(CellKey(x, y))
				}
			}
		}
		from := Position{
			random.Intn(2*gridHalf+1) - gridHalf,
			random.Intn(2*gridHalf+1) - gridHalf,
		}
		to := Position{
			random.Intn(2*gridHalf+1) - gridHalf,
			random.Intn(2*gridHalf+1) - gridHalf,
		}
		margin := pathMargins[random.Intn(len(pathMargins))]
		path, err := ShortestPath(from, to, obstacles, margin)
		if err != nil {
			continue
		}
		reachable++
		if err := validatePath(from, to, path, obstacles); err != nil {
			t.Fatalf("iteration %d (%v -> %v, margin %d): %v",
				iteration, from, to, margin, err)
		}
		if len(path)-1 < Manhattan(from, to) {
			t.Fatalf("iteration %d: path length %d below Manhattan lower bound %d",
				iteration, len(path)-1, Manhattan(from, to))
		}
	}
	if reachable < 1000 {
		t.Fatalf("too few reachable paths checked: %d/10000", reachable)
	}
	t.Logf("random invariant: %d reachable / %d iterations", reachable, iterations)
}

// validatePath 校验路径合法性：端点、逐格相邻、不穿墙、不越边界框。
func validatePath(from, to Position, path []Position, obstacles Set[string]) error {
	if len(path) == 0 {
		return fmt.Errorf("empty path")
	}
	if path[0] != from {
		return fmt.Errorf("path starts at %v, want %v", path[0], from)
	}
	if path[len(path)-1] != to {
		return fmt.Errorf("path ends at %v, want %v", path[len(path)-1], to)
	}
	minX := min(from[0], to[0]) - 32
	maxX := max(from[0], to[0]) + 32
	minY := min(from[1], to[1]) - 32
	maxY := max(from[1], to[1]) + 32
	for i := 1; i < len(path); i++ {
		if Manhattan(path[i-1], path[i]) != 1 {
			return fmt.Errorf("non-adjacent steps at %d: %v -> %v", i, path[i-1], path[i])
		}
		if obstacles.Contains(CellKey(path[i][0], path[i][1])) {
			return fmt.Errorf("path crosses obstacle at %v", path[i])
		}
		if path[i][0] < minX || path[i][0] > maxX || path[i][1] < minY || path[i][1] > maxY {
			return fmt.Errorf("path escapes search box at %v", path[i])
		}
	}
	return nil
}

func TestExploreRadiusForRing(t *testing.T) {
	cases := []struct {
		base, ring, want int
	}{
		{8, 0, 8}, {8, 1, 16}, {8, 2, 24}, {8, 3, 32},
		{8, 4, 8}, {8, 7, 32}, {8, -1, 32},
	}
	for _, tc := range cases {
		got, err := ExploreRadiusForRing(tc.base, tc.ring)
		if err != nil {
			t.Fatalf("ring %d: %v", tc.ring, err)
		}
		if got != tc.want {
			t.Errorf("radius(ring %d) = %d, want %d", tc.ring, got, tc.want)
		}
	}
	if _, err := ExploreRadiusForRing(0, 0); err == nil {
		t.Error("zero base radius must error")
	}
	if _, err := ExploreRadiusForRing(-3, 0); err == nil {
		t.Error("negative base radius must error")
	}
}

func TestExploreTarget(t *testing.T) {
	home := Position{0, 0}
	if got := ExploreTarget(home, Position{1, 0}, 0, 10); got != (Position{10, 0}) {
		t.Errorf("east target = %v, want [10 0]", got)
	}
	if got := ExploreTarget(home, Position{1, 0}, 2, 10); got != (Position{0, 10}) {
		t.Errorf("south target = %v, want [0 10]", got)
	}
	if got := ExploreTarget(home, Position{-1, 0}, 0, 5); got != (Position{-5, 0}) {
		t.Errorf("west target = %v, want [-5 0]", got)
	}
	if got := ExploreTarget(home, home, 0, 5); got != (Position{5, 0}) {
		t.Errorf("same-cell fallback target = %v, want [5 0]", got)
	}
}

func TestNearest(t *testing.T) {
	targets := []Position{{10, 10}, {1, 2}, {1, 1}}
	got := Nearest(targets, Position{0, 0})
	if got == nil || *got != (Position{1, 1}) {
		t.Errorf("nearest = %v, want [1 1]", got)
	}
	// 同距离按 x 小优先。
	tie := []Position{{5, 0}, {0, 5}}
	if got := Nearest(tie, Position{0, 0}); got == nil || *got != (Position{0, 5}) {
		t.Errorf("nearest tie = %v, want [0 5]", got)
	}
	if got := Nearest(nil, Position{0, 0}); got != nil {
		t.Errorf("nearest empty = %v, want nil", got)
	}
}
