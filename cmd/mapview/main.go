// mapview：ASCII 地图渲染（认知工具）——从 fixture/state JSON 或
// runtime 遥测渲染可见地图：障碍/资源/Core/己方单位/敌方。
// 用法：
//   go run ./cmd/mapview <fixture.json...>            渲染每个文件
//   go run ./cmd/mapview --live                       连接服务器渲染最新 state
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
func render(state *domain.TickState, size int) string {
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

	lines := make([]string, 0, size+2)
	lines = append(lines, fmt.Sprintf("=== map %dx%d around %v (tick %d) ===", size, size, center, state.Tick))
	for y := 0; y < size; y++ {
		lines = append(lines, string(grid[y]))
	}
	return "\n" + joinLines(lines)
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

func renderFile(path string, size int) error {
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
	fmt.Println(render(state, size))
	return nil
}

func main() {
	size := flag.Int("size", 25, "grid size (odd)")
	flag.Parse()
	paths := flag.Args()
	if len(paths) == 0 {
		fmt.Fprintln(os.Stderr, "usage: mapview <fixture.json...>")
		os.Exit(2)
	}
	sort.Strings(paths)
	for _, path := range paths {
		if err := renderFile(path, *size); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", path, err)
		}
	}
}
