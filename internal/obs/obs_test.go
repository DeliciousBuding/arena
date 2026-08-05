package obs

import (
	"bytes"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
)

// TestObsEventAttachesTraceFields：诊断事件自动携带 run_id/tenant/event。
func TestObsEventAttachesTraceFields(t *testing.T) {
	var buf bytes.Buffer
	o := New("run-1", "t3", &buf, slog.LevelDebug)
	o.Event(slog.LevelWarn, EventTickGapWarn, "tick", 42, "gap_ms", 50000)
	out := buf.String()
	for _, want := range []string{"run-1", "t3", EventTickGapWarn, "tick=42", "gap_ms=50000"} {
		if !strings.Contains(out, want) {
			t.Errorf("event output missing %q: %s", want, out)
		}
	}
}

// TestObsLoggerCarriesTraceFields：Logger 返回的日志器也带溯源字段。
func TestObsLoggerCarriesTraceFields(t *testing.T) {
	var buf bytes.Buffer
	o := New("run-9", "t4", &buf, slog.LevelInfo)
	o.Logger().Info("hello")
	if !strings.Contains(buf.String(), "run-9") || !strings.Contains(buf.String(), "t4") {
		t.Fatalf("logger output missing trace fields: %s", buf.String())
	}
}

// TestObsLevelFiltering：低于 level 的事件被过滤（Info level 下 debug 事件不出现）。
func TestObsLevelFiltering(t *testing.T) {
	var buf bytes.Buffer
	o := New("run-1", "t3", &buf, slog.LevelInfo)
	o.Event(slog.LevelDebug, "tick.processed", "tick", 1)
	if strings.Contains(buf.String(), "tick.processed") {
		t.Fatalf("debug event leaked at info level: %s", buf.String())
	}
	o.Event(slog.LevelWarn, EventIdleDump, "seq", 1)
	if !strings.Contains(buf.String(), EventIdleDump) {
		t.Fatalf("warn event missing: %s", buf.String())
	}
}

// TestMetricsCountersConcurrent：计数器并发自增不丢数。
func TestMetricsCountersConcurrent(t *testing.T) {
	m := newMetrics()
	const goroutines = 8
	const perGoroutine = 1000
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				m.TickProcessed()
				m.ErrorClass(ErrorClassTransport)
			}
		}()
	}
	wg.Wait()
	if got := m.Counts()["ticks_processed"]; got != goroutines*perGoroutine {
		t.Fatalf("ticks_processed = %d, want %d", got, goroutines*perGoroutine)
	}
	if got := m.Counts()["errors_transport"]; got != goroutines*perGoroutine {
		t.Fatalf("errors_transport = %d, want %d", got, goroutines*perGoroutine)
	}
}

// TestMetricsGauges：仪表读写。
func TestMetricsGauges(t *testing.T) {
	m := newMetrics()
	m.LastTickGapMS(12345)
	m.HandleStateMS(7)
	if got := m.Counts()["last_tick_gap_ms"]; got != 12345 {
		t.Fatalf("last_tick_gap_ms = %d, want 12345", got)
	}
	if got := m.Counts()["handle_state_ms"]; got != 7 {
		t.Fatalf("handle_state_ms = %d, want 7", got)
	}
}

// TestWriteStackDump：dump 文件写入且含头部。
func TestWriteStackDump(t *testing.T) {
	path, err := WriteStackDump(t.TempDir(), "run-1", 1, []byte("goroutine 1 ..."))
	if err != nil {
		t.Fatalf("WriteStackDump: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read dump: %v", err)
	}
	if !strings.Contains(string(data), "goroutine 1") {
		t.Fatalf("dump content missing stack: %s", data)
	}
}

// TestHeader：头部含原因与时间。
func TestHeader(t *testing.T) {
	h := Header("idle 30s no events")
	if !strings.Contains(h, "idle 30s no events") || !strings.Contains(h, "arena goroutine dump") {
		t.Fatalf("header malformed: %s", h)
	}
}
