// mapview：ASCII 地图渲染（认知工具）——从 fixture/state JSON 或
// runtime 遥测渲染可见地图：障碍/资源/Core/己方单位/敌方。
// -vision 叠加视野圈（官方 v0.13 并集视野：Worker 3 / Core 5 /
// Vanguard 4 / Ranger 5）。
// 用法：
//
//	go run ./cmd/mapview <fixture.json...>            渲染每个文件
//	go run ./cmd/mapview -vision <fixture.json...>    叠加视野圈
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
)

// render 将 TickState 渲染为 ASCII 网格（以 Core 为中心，范围 size×size）。
// showVision 时叠加视野圈：* = 任一己方对象视野内。
func render(state *domain.TickState, size int, showVision bool) string {
	center := domain.Position{0, 0}
	if state.Core != nil {
		center = state.Core.Position
	}
	half := size / 2
	minX, minY := center[0]-half, center[1]-half

	grid := make([][]rune, size)
	for y := 0; y < size; y++ {
		grid[y] = make([]rune, size)
		for x := 0; x < size; x++ {
			grid[y][x] = '.'
		}
	}
	put := func(p domain.Position, r rune) {
		x, y := p[0]-minX, p[1]-minY
		if x >= 0 && x < size && y >= 0 && y < size {
			grid[y][x] = r
		}
	}
	put(center, 'C') // Core
	for cell := range state.ResourceCells {
		if p, err := domain.ParseCellKey(cell); err == nil {
			put(p, '$')
		}
	}
	for cell := range state.ObstacleCells {
		if p, err := domain.ParseCellKey(cell); err == nil {
			put(p, '#')
		}
	}
	for _, unit := range state.Units {
		marker := 'w'
		switch unit.UnitType {
		case domain.UnitVanguard:
			marker = 'v'
		case domain.UnitRanger:
			marker = 'r'
		}
		if unit.Cargo > 0 {
			marker = 'W' // 满载
		}
		put(unit.Position, marker)
	}
	for _, enemy := range state.VisibleEnemies {
		put(enemy.Position, 'E')
	}

	// 视野圈叠加：空格且任一己方对象视野内 → *（实体标记优先）。
	if showVision {
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				if grid[y][x] != '.' {
					continue
				}
				cell := domain.Position{minX + x, minY + y}
				if inVision(state, cell) {
					grid[y][x] = '*'
				}
			}
		}
	}

	lines := make([]string, 0, size+2)
	suffix := ""
	if showVision {
		suffix = " (*=vision)"
	}
	lines = append(lines, fmt.Sprintf("=== map %dx%d around %v (tick %d)%s ===", size, size, center, state.Tick, suffix))
	for y := 0; y < size; y++ {
		lines = append(lines, string(grid[y]))
	}
	return "\n" + joinLines(lines)
}

// inVision 报告格是否在任一己方对象视野内（并集视野，官方数值）。
func inVision(state *domain.TickState, cell domain.Position) bool {
	if state.Core != nil && chebyshev(state.Core.Position, cell) <= 5 {
		return true
	}
	for _, unit := range state.Units {
		radius := 0
		switch unit.UnitType {
		case domain.UnitWorker:
			radius = 3
		case domain.UnitVanguard:
			radius = 4
		case domain.UnitRanger:
			radius = 5
		}
		if radius > 0 && chebyshev(unit.Position, cell) <= radius {
			return true
		}
	}
	return false
}

func chebyshev(a, b domain.Position) int {
	dx := a[0] - b[0]
	if dx < 0 {
		dx = -dx
	}
	dy := a[1] - b[1]
	if dy < 0 {
		dy = -dy
	}
	if dx > dy {
		return dx
	}
	return dy
}

func joinLines(lines []string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}

func renderFile(path string, size int, showVision bool) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var record contracts.DifferentialRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return err
	}
	tick, err := strconv.Atoi(filepath.Base(path)[:5])
	if err != nil {
		tick = 0
	}
	state, err := domain.Reduce(&record, tick)
	if err != nil {
		return err
	}
	fmt.Println(render(state, size, showVision))
	return nil
}

func main() {
	size := flag.Int("size", 25, "grid size (odd)")
	showVision := flag.Bool("vision", false, "overlay vision circles")
	flag.Parse()
	paths := flag.Args()
	if len(paths) == 0 {
		fmt.Fprintln(os.Stderr, "usage: mapview [-vision] <fixture.json...>")
		os.Exit(2)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if err := renderFile(path, *size, *showVision); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
		}
	}
}
