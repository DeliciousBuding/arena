package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWriterWriteLinesAndClose 多行写入 + Close 后文件完整可读。
func TestWriterWriteLinesAndClose(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	wantTicks := []int{47542, 47543, 47544}
	for _, tick := range wantTicks {
		if err := writer.WriteLine(runtimeSample(tick)); err != nil {
			t.Fatalf("write tick %d: %v", tick, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != len(wantTicks) {
		t.Fatalf("got %d lines, want %d", len(records), len(wantTicks))
	}
	for i, record := range records {
		if record["tick"] != float64(wantTicks[i]) {
			t.Errorf("line %d: tick = %v, want %d", i, record["tick"], wantTicks[i])
		}
		if record["processRunId"] != "9683013c-9d26-4135-a4c4-ccac385f37ed" {
			t.Errorf("line %d: processRunId missing or changed", i)
		}
	}
}

// TestWriterAppendOnlyAcrossOpens 重新打开追加，不截断已有内容。
func TestWriterAppendOnlyAcrossOpens(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "decision.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for _, tick := range []int{1, 2} {
		if err := writer.WriteLine(runtimeSample(tick)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	writer, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(3)); err != nil {
		t.Fatalf("write after reopen: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != 3 {
		t.Fatalf("got %d lines, want 3 (append-only)", len(records))
	}
	for i, record := range records {
		if record["tick"] != float64(i+1) {
			t.Errorf("line %d: tick = %v, want %d", i, record["tick"], i+1)
		}
	}
}

// TestWriterSanitizesBeforeWrite 落盘内容必须已脱敏（键名 + 值模式）。
func TestWriterSanitizesBeforeWrite(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "outcome.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	record := runtimeSample(51346)
	record["apiKey"] = "sk-abcdefghijklmnopqrstuvwxyz"
	record["agent"] = map[string]any{"authorization": "Bearer hunter2-secret"}
	if err := writer.WriteLine(record); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	raw := jsonLinesOf(t, path)
	if len(raw) != 1 {
		t.Fatalf("got %d lines, want 1", len(raw))
	}
	line := raw[0]
	if strings.Contains(line, "sk-abcdefghijklmnopqrstuvwxyz") {
		t.Errorf("sk- secret leaked to disk: %s", line)
	}
	if strings.Contains(line, "hunter2-secret") {
		t.Errorf("bearer secret leaked to disk: %s", line)
	}
	if !strings.Contains(line, RedactedPlaceholder) {
		t.Errorf("expected %q on disk, got: %s", RedactedPlaceholder, line)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(line), &parsed); err != nil {
		t.Fatalf("line not valid JSON: %v", err)
	}
	if parsed["apiKey"] != RedactedPlaceholder {
		t.Errorf("apiKey on disk = %v, want %q", parsed["apiKey"], RedactedPlaceholder)
	}
}

// TestWriterEveryLineCompleteJSON 每行都是完整 JSON、行尾带换行。
func TestWriterEveryLineCompleteJSON(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	const count = 25
	for i := 0; i < count; i++ {
		if err := writer.WriteLine(paddedRecord(i, 80)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.HasSuffix(string(data), "\n") {
		t.Errorf("file must end with newline")
	}
	records := readJSONLines(t, path)
	if len(records) != count {
		t.Fatalf("got %d records, want %d", len(records), count)
	}
	for i, record := range records {
		if record["index"] != float64(i) {
			t.Errorf("record %d out of order or corrupted: index = %v", i, record["index"])
		}
	}
}

// TestWriterWriteAfterCloseFails close 后写入必须报错。
func TestWriterWriteAfterCloseFails(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
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

// TestWriterRepairsPartialTailOnOpen 崩溃残留的截断行在 Open 时被修复：
// 完整行保留，不完整尾部丢弃，后续写入不受影响。
func TestWriterRepairsPartialTailOnOpen(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")

	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	for _, tick := range []int{1, 2} {
		if err := writer.WriteLine(runtimeSample(tick)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// 模拟崩溃：向文件追加一条不完整行（无换行）。
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatalf("open partial: %v", err)
	}
	if _, err := file.WriteString(`{"tick":999`); err != nil {
		t.Fatalf("write partial: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close partial: %v", err)
	}

	writer, err = Open(path)
	if err != nil {
		t.Fatalf("reopen after partial tail: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(3)); err != nil {
		t.Fatalf("write after repair: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != 3 {
		t.Fatalf("got %d lines after repair, want 3 (partial tail must be dropped)", len(records))
	}
	for i, record := range records {
		if record["tick"] != float64(i+1) {
			t.Errorf("line %d: tick = %v, want %d", i, record["tick"], i+1)
		}
	}
}

// TestWriterRepairsFileWithoutAnyNewline 文件只有一条无换行记录时 Open 清空重来。
func TestWriterRepairsFileWithoutAnyNewline(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	if err := os.WriteFile(path, []byte(`{"tick":999`), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(7)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != 1 || records[0]["tick"] != float64(7) {
		t.Fatalf("got %v, want single clean record tick=7", records)
	}
}

// TestWriterCreatesParentDirectories Open 自动创建父目录。
func TestWriterCreatesParentDirectories(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runs", "some-run-id", "telemetry", "policy.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open nested path: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(1)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}
}

// TestWriterSyncThenRead Sync 后内容立即可读。
func TestWriterSyncThenRead(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(42)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != 1 || records[0]["tick"] != float64(42) {
		t.Fatalf("sync did not persist line: %v", records)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// TestWriterOpenEmptyPathFails 空路径拒绝。
func TestWriterOpenEmptyPathFails(t *testing.T) {
	t.Parallel()
	if _, err := Open(""); err == nil {
		t.Fatalf("Open with empty path must fail")
	}
}

// TestWriterOpenDirectoryFails 路径指向目录时打开失败。
func TestWriterOpenDirectoryFails(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if _, err := Open(dir); err == nil {
		t.Fatalf("Open on a directory must fail")
	}
}

// TestWriterWriteLineMarshalError 不可序列化值（chan）写入报错，且不落盘。
func TestWriterWriteLineMarshalError(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() {
		_ = writer.Close()
	}()
	record := runtimeSample(1)
	record["unsupported"] = make(chan int)
	if err := writer.WriteLine(record); err == nil {
		t.Fatalf("WriteLine with chan value must fail")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(data) != 0 {
		t.Fatalf("failed line must not be written, file has %d bytes", len(data))
	}
}

// TestWriterSyncSizeAfterCloseFails close 后 Sync/Size 报错。
func TestWriterSyncSizeAfterCloseFails(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := writer.Sync(); err == nil {
		t.Fatalf("Sync after close must fail")
	}
	if _, err := writer.Size(); err == nil {
		t.Fatalf("Size after close must fail")
	}
}

// TestWriterRepairsLargePartialTail 无换行内容超过单个扫描块（4096B）时，
// 逐块回扫后整文件清空（无完整行可保留）。
func TestWriterRepairsLargePartialTail(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "runtime.jsonl")
	blob := strings.Repeat("x", 5000) // 无任何换行
	if err := os.WriteFile(path, []byte(blob), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	writer, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := writer.WriteLine(runtimeSample(7)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	records := readJSONLines(t, path)
	if len(records) != 1 || records[0]["tick"] != float64(7) {
		t.Fatalf("got %v, want single clean record tick=7", records)
	}
}
