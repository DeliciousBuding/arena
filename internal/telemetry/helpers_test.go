package telemetry

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// readJSONLines 读取文件并逐行解析为 JSON；空行（尾部换行符产生）被忽略，
// 任一行为非法 JSON 即测试失败（完整行不变式）。
func readJSONLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var records []map[string]any
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("line %q in %s is not complete JSON: %v", line, path, err)
		}
		records = append(records, record)
	}
	return records
}

// runtimeSample 构造与主工作区 runtime/t1/telemetry/runtime.jsonl 同字段名的
// 记录（格式事实源取样），用于验证写入层不破坏真实字段名。
func runtimeSample(tick int) map[string]any {
	return map[string]any{
		"processRunId":       "9683013c-9d26-4135-a4c4-ccac385f37ed",
		"tenantId":           "t1",
		"runId":              "9683013c-9d26-4135-a4c4-ccac385f37ed:t1:47542:0",
		"tick":               tick,
		"deadlineOutcome":    "not_applicable",
		"agentLatencyMs":     nil,
		"selectionLatencyMs": 6.6712,
		"abortRequested":     false,
		"rotationGeneration": 0,
		"submitResult":       "not_submitted",
		"notSubmittedReason": "disabled",
		"intentCounts":       map[string]any{"patrol": 7, "DEPOSIT": 1},
		"planHash":           "2d5f9af4",
		"workerMeanDistance": 7.625,
		"events":             []any{"UNIT_MOVE_SUCCEEDED", "UNIT_MOVE_SUCCEEDED"},
		"workerCargoTotal":   1,
	}
}

// paddedRecord 在 runtimeSample 上追加 index 与 filler 字段以控制行大小
// （轮转测试用）。
func paddedRecord(seed, fillerLength int) map[string]any {
	record := runtimeSample(seed)
	record["index"] = seed
	record["filler"] = strings.Repeat("x", fillerLength)
	return record
}

// jsonLinesOf 读取文件并返回原始行（含空尾行过滤）。
func jsonLinesOf(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	raw := strings.Split(string(data), "\n")
	var lines []string
	for _, line := range raw {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
