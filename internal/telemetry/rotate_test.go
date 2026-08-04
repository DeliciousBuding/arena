package telemetry

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestRotationDefaultConstants 默认阈值 16 MiB、默认代数 5。
func TestRotationDefaultConstants(t *testing.T) {
	if DefaultRotationMaxBytes != 16<<20 {
		t.Errorf("DefaultRotationMaxBytes = %d, want %d", DefaultRotationMaxBytes, 16<<20)
	}
	if DefaultRotationGenerations != 5 {
		t.Errorf("DefaultRotationGenerations = %d, want 5", DefaultRotationGenerations)
	}
	cfg := DefaultRotationConfig()
	if cfg.MaxSizeBytes != 16<<20 || cfg.MaxGenerations != 5 {
		t.Errorf("DefaultRotationConfig = %+v, want 16MiB/5", cfg)
	}
}

// TestRotationBackupFilesCreated 小阈值下写入多行，产生 .1/.2 备份，
// 且每个文件（活动/备份）都只含完整 JSON 行。
func TestRotationBackupFilesCreated(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 1024, MaxGenerations: 3})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for i := 0; i < 30; i++ {
		if err := writer.WriteLine(paddedRecord(i, 200)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	for _, name := range []string{"runtime.jsonl", "runtime.jsonl.1", "runtime.jsonl.2"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("expected %s to exist", name)
			continue
		}
		records := readJSONLines(t, filepath.Join(dir, name))
		if len(records) == 0 {
			t.Errorf("%s is empty", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "runtime.jsonl.3")); !os.IsNotExist(err) {
		t.Errorf("backup .3 must not exist with MaxGenerations=3")
	}
}

// measureLineSize 写一行到探针文件，量出真实行大小（含换行符），
// 使轮转测试的代数容量可确定计算。探针记录与测试记录同形同大小
// （种子同为 0..N-1 单字符）。
func measureLineSize(t *testing.T, dir string, fillerLength int) int64 {
	t.Helper()
	probePath := filepath.Join(dir, "probe.jsonl")
	probe, err := Open(probePath)
	if err != nil {
		t.Fatalf("probe open: %v", err)
	}
	if err := probe.WriteLine(paddedRecord(0, fillerLength)); err != nil {
		t.Fatalf("probe write: %v", err)
	}
	if err := probe.Close(); err != nil {
		t.Fatalf("probe close: %v", err)
	}
	return int64(len(jsonLinesOf(t, probePath)[0]) + 1)
}

// TestRotationGenerationLimitDeletesOldest 超过代数限制后最旧备份被删除，
// 且保留内容为最新连续段。
func TestRotationGenerationLimitDeletesOldest(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	lineSize := measureLineSize(t, dir, 200)
	// 每代恰好 2 行；3 代容量 = 6 行，写 20 行必然触发删除。
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 2 * lineSize, MaxGenerations: 3})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	const total = 20
	for i := 0; i < total; i++ {
		if err := writer.WriteLine(paddedRecord(i, 200)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	var indexes []int
	for _, name := range []string{"runtime.jsonl.2", "runtime.jsonl.1", "runtime.jsonl"} {
		for _, record := range readJSONLines(t, filepath.Join(dir, name)) {
			indexes = append(indexes, int(record["index"].(float64)))
		}
	}
	if len(indexes) != 6 {
		t.Errorf("kept %d lines, want exactly 6 (2 per generation x 3)", len(indexes))
	}
	sort.Ints(indexes)
	for i, index := range indexes {
		if index != indexes[0]+i {
			t.Fatalf("kept indexes must be a contiguous suffix, got %v", indexes)
		}
	}
	if indexes[len(indexes)-1] != total-1 {
		t.Errorf("newest record must be preserved, got %v", indexes)
	}
}

// TestRotationAllLinesPreservedInOrder 代数未满时全部记录无丢失、无重复，
// 跨代顺序 = 写入顺序。
func TestRotationAllLinesPreservedInOrder(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	lineSize := measureLineSize(t, dir, 200)
	// 每代恰好 2 行；3 代容量 = 6 行，写 6 行恰好占满、无删除。
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 2 * lineSize, MaxGenerations: 3})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	const total = 6
	for i := 0; i < total; i++ {
		if err := writer.WriteLine(paddedRecord(i, 200)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	var indexes []int
	for _, name := range []string{"runtime.jsonl.2", "runtime.jsonl.1", "runtime.jsonl"} {
		for _, record := range readJSONLines(t, filepath.Join(dir, name)) {
			indexes = append(indexes, int(record["index"].(float64)))
		}
	}
	if len(indexes) != total {
		t.Fatalf("kept %d lines, want %d (no loss below capacity)", len(indexes), total)
	}
	for i, index := range indexes {
		if index != i {
			t.Fatalf("chronological order broken: %v", indexes)
		}
	}
}

// TestRotationSingleLineLargerThanThreshold 单条超过阈值的行必须完整写入
// （完整行优先于阈值），下一行写入时再轮转。
func TestRotationSingleLineLargerThanThreshold(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 64, MaxGenerations: 2})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.WriteLine(paddedRecord(1, 300)); err != nil {
		t.Fatalf("write big line: %v", err)
	}
	if err := writer.WriteLine(paddedRecord(2, 5)); err != nil {
		t.Fatalf("write small line: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	backup := readJSONLines(t, filepath.Join(dir, "runtime.jsonl.1"))
	if len(backup) != 1 || backup[0]["index"] != float64(1) {
		t.Fatalf("big line must be preserved whole in .1, got %v", backup)
	}
	active := readJSONLines(t, path)
	if len(active) != 1 || active[0]["index"] != float64(2) {
		t.Fatalf("active must contain only the new line, got %v", active)
	}
}

// TestRotationZeroConfigDefaults 零值配置归一为默认 16MiB/5。
func TestRotationZeroConfigDefaults(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := OpenRotating(path, RotationConfig{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() {
		_ = writer.Close()
	}()
	want := DefaultRotationConfig()
	if writer.cfg != want {
		t.Errorf("zero config = %+v, want %+v", writer.cfg, want)
	}

	custom := RotationConfig{MaxSizeBytes: 512, MaxGenerations: 2}
	writer2, err := OpenRotating(filepath.Join(t.TempDir(), "decision.jsonl"), custom)
	if err != nil {
		t.Fatalf("open custom: %v", err)
	}
	defer func() {
		_ = writer2.Close()
	}()
	if writer2.cfg != custom {
		t.Errorf("custom config = %+v, want %+v", writer2.cfg, custom)
	}
}

// TestRotationWriteAfterCloseFails close 后写入报错。
func TestRotationWriteAfterCloseFails(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 1024, MaxGenerations: 3})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(1)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("second close must be idempotent, got: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(2)); err == nil {
		t.Fatalf("write after close must fail")
	}
}

// TestRotationOpenEmptyPathFails 空路径拒绝。
func TestRotationOpenEmptyPathFails(t *testing.T) {
	t.Parallel()
	if _, err := OpenRotating("", RotationConfig{}); err == nil {
		t.Fatalf("OpenRotating with empty path must fail")
	}
}

// TestRotationMaxGenerationsOneNoBackups MaxGenerations=1 时轮转直接清空
// 活动文件（不产生备份）。
func TestRotationMaxGenerationsOneNoBackups(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "runtime.jsonl")
	writer, err := OpenRotating(path, RotationConfig{MaxSizeBytes: 64, MaxGenerations: 1})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for i := 0; i < 6; i++ {
		if err := writer.WriteLine(paddedRecord(i, 40)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "runtime.jsonl.1")); !os.IsNotExist(err) {
		t.Errorf("no backups expected with MaxGenerations=1")
	}
	records := readJSONLines(t, path)
	if len(records) == 0 {
		t.Fatalf("active file must contain the latest lines")
	}
	if int(records[len(records)-1]["index"].(float64)) != 5 {
		t.Errorf("newest line must be the last written")
	}
}
