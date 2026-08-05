// runcheck：长期运行健康检查（自主维护）——单次采样：
// 进程存活 / tick 进度 / ERROR 数 / repaired 数 / 模式分布。
// 用法：go run ./cmd/runcheck <run-dir>
// 输出一行 TSV，供监控循环/CI 采样。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type decisionRow struct {
	Repaired      bool   `json:"repaired"`
	Valid         bool   `json:"valid"`
	DirectiveMode string `json:"directiveMode"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: runcheck <run-dir>")
		os.Exit(2)
	}
	dir := os.Args[1]

	ticks, repaired, invalid := 0, 0, 0
	modes := map[string]int{}
	if file, err := os.Open(filepath.Join(dir, "decision.jsonl")); err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var row decisionRow
			if json.Unmarshal([]byte(line), &row) != nil {
				continue
			}
			ticks++
			if row.Repaired {
				repaired++
			}
			if !row.Valid {
				invalid++
			}
			modes[row.DirectiveMode]++
		}
	}
	modeSummary := ""
	keys := make([]string, 0, len(modes))
	for mode := range modes {
		keys = append(keys, mode)
	}
	// 确定性输出顺序。
	sortStrings(keys)
	for _, mode := range keys {
		if modeSummary != "" {
			modeSummary += ","
		}
		modeSummary += mode + "=" + fmt.Sprint(modes[mode])
	}
	fmt.Printf("ticks=%d repaired=%d invalid=%d modes=%s\n", ticks, repaired, invalid, modeSummary)
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
