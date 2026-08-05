// analyze：run 实验结果自动分析（decision.jsonl + runtime.jsonl）——
// 一键生成摘要：模式分布/资源趋势/动作统计/停滞诊断/事件。
// 用法：go run ./cmd/analyze <run-dir>
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// decisionRecord 是 decision.jsonl 行的子集（未知字段忽略）。
type decisionRecord struct {
	Tick             int            `json:"tick"`
	ActionKinds      map[string]int `json:"actionKinds"`
	IntentCounts     map[string]int `json:"intentCounts"`
	CoreAction       string         `json:"coreAction"`
	CoreUnitType     string         `json:"coreUnitType"`
	ResourcesBefore  int            `json:"resourcesBefore"`
	ResourcesAfter   int            `json:"resourcesAfter"`
	WorkersBefore    int            `json:"workersBefore"`
	WorkersAfter     int            `json:"workersAfter"`
	WorkerCargoTotal int            `json:"workerCargoTotal"`
	EventReasons     []string       `json:"eventReasons"`
	DirectiveMode    string         `json:"directiveMode"`
	Valid            bool           `json:"valid"`
	Repaired         bool           `json:"repaired"`
}

// runtimeRecord 是 runtime.jsonl 行的子集。
type runtimeRecord struct {
	Tick           int `json:"tick"`
	Resources      int `json:"resources"`
	WorldResources int `json:"worldResources"`
	WorldEnemies   int `json:"worldEnemies"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: analyze <run-dir>")
		os.Exit(2)
	}
	dir := os.Args[1]

	var decisions []decisionRecord
	if data, err := readJSONL(filepath.Join(dir, "decision.jsonl")); err == nil {
		for _, line := range data {
			var record decisionRecord
			if json.Unmarshal(line, &record) == nil {
				decisions = append(decisions, record)
			}
		}
	}
	var runtimeRows []runtimeRecord
	if data, err := readJSONL(filepath.Join(dir, "runtime.jsonl")); err == nil {
		for _, line := range data {
			var record runtimeRecord
			if json.Unmarshal(line, &record) == nil {
				runtimeRows = append(runtimeRows, record)
			}
		}
	}

	fmt.Printf("=== run analysis: %s ===\n", dir)
	fmt.Printf("ticks: %d (decision) / %d (runtime)\n", len(decisions), len(runtimeRows))
	if len(decisions) == 0 {
		return
	}

	// 模式分布。
	modes := map[string]int{}
	for _, d := range decisions {
		if d.DirectiveMode == "" {
			modes["GROWTH(默认)"]++
		} else {
			modes[d.DirectiveMode]++
		}
	}
	modeKeys := make([]string, 0, len(modes))
	for mode := range modes {
		modeKeys = append(modeKeys, mode)
	}
	sort.Strings(modeKeys)
	fmt.Print("directive modes:")
	for _, mode := range modeKeys {
		fmt.Printf(" %s=%d", mode, modes[mode])
	}
	fmt.Println()

	// 资源/工人趋势。
	first, last := decisions[0], decisions[len(decisions)-1]
	fmt.Printf("resources: %d → %d (delta %+d)\n", first.ResourcesBefore, last.ResourcesAfter, last.ResourcesAfter-first.ResourcesBefore)
	fmt.Printf("workers: %d → %d\n", first.WorkersBefore, last.WorkersAfter)

	// 动作意图汇总。
	actionTotal := map[string]int{}
	intentTotal := map[string]int{}
	spawnPlans, deposits, harvests, yields := 0, 0, 0, 0
	stagnantEvents := 0
	for _, d := range decisions {
		for kind, count := range d.ActionKinds {
			actionTotal[kind] += count
		}
		for intent, count := range d.IntentCounts {
			intentTotal[intent] += count
		}
		if d.CoreAction == "SPAWN" {
			spawnPlans++
		}
		deposits += d.IntentCounts["deposit"]
		harvests += d.IntentCounts["harvest"]
		yields += d.IntentCounts["yield_full_core"]
		for _, reason := range d.EventReasons {
			if reason == "planned_spawn_no_effect" {
				stagnantEvents++
			}
		}
	}
	fmt.Printf("spawn plans: %d, deposits: %d, harvests: %d, yields: %d, spawn_no_effect: %d\n",
		spawnPlans, deposits, harvests, yields, stagnantEvents)
	fmt.Print("actions:", formatCounts(actionTotal))
	fmt.Print("intents:", formatCounts(intentTotal))

	// 世界记忆（资源/敌方可见性）。
	if len(runtimeRows) > 0 {
		worldRes, worldEnemies := 0, 0
		for _, r := range runtimeRows {
			worldRes += r.WorldResources
			worldEnemies += r.WorldEnemies
		}
		fmt.Printf("world memory (avg/tick): resources=%.1f enemies=%.1f\n",
			float64(worldRes)/float64(len(runtimeRows)), float64(worldEnemies)/float64(len(runtimeRows)))
	}
}

func readJSONL(path string) ([][]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var lines [][]byte
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		if line := scanner.Bytes(); len(line) > 0 {
			lines = append(lines, append([]byte(nil), line...))
		}
	}
	return lines, scanner.Err()
}

func formatCounts(counts map[string]int) string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := " {"
	for i, key := range keys {
		if i > 0 {
			out += ", "
		}
		out += fmt.Sprintf("%s:%d", key, counts[key])
	}
	return out + "}\n"
}
