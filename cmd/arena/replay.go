package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/deliciousbuding/arena/internal/contracts"
	"github.com/deliciousbuding/arena/internal/domain"
	"github.com/deliciousbuding/arena/internal/strategy"
)

// replayResult 是一次 fixture 回放的汇总统计。
type replayResult struct {
	Records      int            `json:"records"`
	Units        int            `json:"units"`
	Actions      int            `json:"actions"`
	ValidPlans   int            `json:"valid_plans"`
	Repaired     int            `json:"repaired"`
	FailedReduce int            `json:"failed_reduce"`
	ActionKinds  map[string]int `json:"action_kinds"`
	CoreActions  map[string]int `json:"core_actions"`
}

// runReplayCmd 回放 fixture：decode → reduce → decide → validate，
// 输出汇总统计与动作分布（阶段 A 验收）。
func runReplayCmd(args []string) int {
	fs := flag.NewFlagSet("replay", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fixtureDir := fs.String("fixture-dir", "fixtures/differential/burnin-20260802-a", "fixture directory (manifest.json + tick JSONs)")
	verbose := fs.Bool("v", false, "print per-tick summaries")
	if err := fs.Parse(args); err != nil {
		return exitConfig
	}

	entries, err := os.ReadDir(*fixtureDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "arena replay: %v\n", err)
		return exitError
	}
	var ticks []int
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || name == "manifest.json" {
			continue
		}
		tick, err := strconv.Atoi(strings.TrimSuffix(name, ".json"))
		if err != nil {
			continue
		}
		ticks = append(ticks, tick)
	}
	sort.Ints(ticks)
	if len(ticks) == 0 {
		fmt.Fprintf(os.Stderr, "arena replay: no tick records found in %s\n", *fixtureDir)
		return exitError
	}

	planner := strategy.NewPlanner(strategy.DefaultConfig())
	result := replayResult{
		ActionKinds: make(map[string]int),
		CoreActions: make(map[string]int),
	}
	validatorIssues := make(map[string]int)

	for _, tick := range ticks {
		path := filepath.Join(*fixtureDir, fmt.Sprintf("%d.json", tick))
		record, err := contracts.ParseRecordFile(path)
		if err != nil {
			result.FailedReduce++
			fmt.Fprintf(os.Stderr, "arena replay: tick %d parse failed: %v\n", tick, err)
			continue
		}
		state, err := domain.Reduce(record, tick)
		if err != nil {
			result.FailedReduce++
			fmt.Fprintf(os.Stderr, "arena replay: tick %d reduce failed: %v\n", tick, err)
			continue
		}
		result.Records++
		result.Units += len(state.Units)

		plan := planner.Decide(state)
		validation := domain.ValidatePlan(state, *plan)
		result.Actions += len(validation.Plan.UnitActions)
		if validation.Valid {
			result.ValidPlans++
		}
		if validation.Repaired {
			result.Repaired++
		}
		for _, issue := range validation.Issues {
			validatorIssues[string(issue.Code)]++
		}
		for _, action := range validation.Plan.UnitActions {
			result.ActionKinds[string(action.Kind)]++
		}
		if validation.Plan.CoreAction != nil {
			result.CoreActions[string(validation.Plan.CoreAction.Kind)]++
		}
		if *verbose {
			fmt.Printf("tick %d: units=%d actions=%d valid=%v repaired=%v\n",
				tick, len(state.Units), len(validation.Plan.UnitActions), validation.Valid, validation.Repaired)
		}
	}

	output, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(output))
	if result.ValidPlans == result.Records && result.FailedReduce == 0 {
		fmt.Printf("REPLAY PASSED: %d/%d valid plans, 0 failures\n", result.ValidPlans, result.Records)
		return exitOK
	}
	fmt.Printf("REPLAY DEGRADED: %d/%d valid plans, %d reduce failures\n",
		result.ValidPlans, result.Records, result.FailedReduce)
	return exitError
}
