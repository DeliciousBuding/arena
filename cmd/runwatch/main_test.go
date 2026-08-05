package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseMemUsageKB(t *testing.T) {
	cases := map[string]int64{
		"15,664 K":    15664,
		"1,234,567 K": 1234567,
		"1024":        1024,
		"   512 K":    512,
	}
	for in, want := range cases {
		got, err := parseMemUsageKB(in)
		if err != nil || got != want {
			t.Errorf("parseMemUsageKB(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := parseMemUsageKB("abc"); err == nil {
		t.Error("parseMemUsageKB(abc) 应当报错")
	}
}

func TestParseCPUTime(t *testing.T) {
	cases := map[string]time.Duration{
		"0:00:15":  15 * time.Second,
		"1:02:03":  time.Hour + 2*time.Minute + 3*time.Second,
		"12:00:00": 12 * time.Hour,
	}
	for in, want := range cases {
		got, err := parseCPUTime(in)
		if err != nil || got != want {
			t.Errorf("parseCPUTime(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := parseCPUTime("15"); err == nil {
		t.Error("parseCPUTime(15) 应当报错")
	}
}

func TestDecodeWindowsOutput(t *testing.T) {
	// UTF-16LE（tasklist 重定向输出，带 BOM）。
	raw := []byte{0xFF, 0xFE, 'a', 0, ',', 0, 'b', 0}
	if got := decodeWindowsOutput(raw); got != "a,b" {
		t.Errorf("UTF-16LE 解码 = %q; want a,b", got)
	}
	// 纯 ASCII 直通。
	if got := decodeWindowsOutput([]byte("a,b")); got != "a,b" {
		t.Errorf("ASCII 直通 = %q; want a,b", got)
	}
}

func TestParseTasklistCSV(t *testing.T) {
	// 模拟 tasklist 重定向输出：UTF-16LE + 带千分位逗号的内存字段。
	raw := []byte{0xFF, 0xFE}
	for _, r := range "\"arena.exe\",\"12345\",\"Console\",\"1\",\"15,664 K\",\"Running\",\"Ding\",\"0:00:15\",\"N/A\"\r\n" {
		raw = append(raw, byte(r), 0)
	}
	records, err := parseTasklistCSV(raw)
	if err != nil || len(records) != 1 || len(records[0]) < 8 {
		t.Fatalf("parseTasklistCSV = %v, %v", records, err)
	}
	row := records[0]
	if got := row[1]; got != "12345" {
		t.Errorf("PID 字段 = %q; want 12345", got)
	}
	if got := row[4]; got != "15,664 K" {
		t.Errorf("Mem 字段 = %q; want 15,664 K", got)
	}
	if got := row[7]; got != "0:00:15" {
		t.Errorf("CPU 字段 = %q; want 0:00:15", got)
	}
}

func TestTailLevelCounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.log")
	var lines []string
	for i := 1; i <= 210; i++ {
		switch i {
		case 5:
			lines = append(lines, `time=... level=ERROR msg="窗口外"`)
		case 205:
			lines = append(lines, `time=... level=ERROR msg="窗口内"`)
		case 208:
			lines = append(lines, `time=... level=WARN msg="警告"`)
		default:
			lines = append(lines, `time=... level=INFO msg="ok"`)
		}
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	errCnt, warnCnt, lastErr, lastWarn, err := tailLevelCounts(path)
	if err != nil {
		t.Fatal(err)
	}
	if errCnt != 1 || warnCnt != 1 {
		t.Errorf("err=%d warn=%d; want 1,1（第 5 行在 200 行窗口外）", errCnt, warnCnt)
	}
	if !strings.Contains(lastErr, "窗口内") {
		t.Errorf("lastErr = %q; want 含 窗口内", lastErr)
	}
	if !strings.Contains(lastWarn, "警告") {
		t.Errorf("lastWarn = %q; want 含 警告", lastWarn)
	}
}

func TestCountLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.jsonl")
	if err := os.WriteFile(path, []byte("a\nb\nc\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := countLines(path)
	if err != nil || got != 3 {
		t.Errorf("countLines = %d, %v; want 3", got, err)
	}
}

func TestFindDecisionLog(t *testing.T) {
	root := t.TempDir()
	// tenant 目录场景：runs/run-B 有 decision.jsonl → 取最新 run。
	runB := filepath.Join(root, "runs", "run-B")
	if err := os.MkdirAll(runB, 0o755); err != nil {
		t.Fatal(err)
	}
	decision := filepath.Join(runB, "decision.jsonl")
	if err := os.WriteFile(decision, []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := findDecisionLog(root); err != nil || got != decision {
		t.Errorf("findDecisionLog(root) = %q, %v; want %q", got, err, decision)
	}
	// run 目录场景：目录自身有 decision.jsonl → 直接命中。
	runA := filepath.Join(root, "runs", "run-A")
	if err := os.MkdirAll(runA, 0o755); err != nil {
		t.Fatal(err)
	}
	direct := filepath.Join(runA, "decision.jsonl")
	if err := os.WriteFile(direct, []byte("y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, err := findDecisionLog(runA); err != nil || got != direct {
		t.Errorf("findDecisionLog(runA) = %q, %v; want %q", got, err, direct)
	}
	// 空目录 → 报错。
	if _, err := findDecisionLog(filepath.Join(root, "empty")); err == nil {
		t.Error("findDecisionLog(空目录) 应当报错")
	}
}

func TestSummary(t *testing.T) {
	// pid 模式：平均/峰值 RSS 汇总。
	m := &monitor{pidMode: true, pid: 12345, rssSum: 300, rssCount: 3, rssPeak: 120}
	var buf bytes.Buffer
	m.summary(&buf)
	out := buf.String()
	for _, want := range []string{"平均 100.0 MB", "峰值 120.0 MB", "3 次采样"} {
		if !strings.Contains(out, want) {
			t.Errorf("pid 汇总缺 %q：\n%s", want, out)
		}
	}

	// log 模式：tick 速率与尾部事件汇总。
	m2 := &monitor{
		logDir: "x", baselineLines: 10, finalLines: 25,
		finalErrCnt: 1, finalWarnCnt: 2,
		lastErrLine: `time=... level=ERROR msg="boom"`,
	}
	buf.Reset()
	m2.summary(&buf)
	out = buf.String()
	for _, want := range []string{"10 → 25 行", "ERROR 1", "WARN 2", `最近 ERROR: time=... level=ERROR msg="boom"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log 汇总缺 %q：\n%s", want, out)
		}
	}
	// tick 速率：15 行增长 / 300 秒 = 0.050 行/秒。
	m2.start = time.Now().Add(-300 * time.Second)
	buf.Reset()
	m2.summary(&buf)
	if !strings.Contains(buf.String(), "0.050") {
		t.Errorf("tick 速率计算错误：\n%s", buf.String())
	}
}
