// runwatch 是 arena.exe（单租户运行进程）的运行性能监控工具（Windows + bash）。
//
// 用法（二选一，第一个参数自动识别：纯数字视为 pid，否则视为日志目录）：
//
//	runwatch <pid> <interval-seconds>          # 监控进程 RSS / CPU
//	runwatch <log-dir> <interval-seconds>      # 监控运行日志（tick 进度 / ERROR / WARN）
//
// 每 interval 秒向 stdout 输出一行 TSV（首行为表头），stdout 保持纯 TSV 便于管道消费：
//
//	time  rss_mb  cpu_pct  jsonl_lines  last_log_at  err_cnt  warn_cnt
//
// 取值说明：
//   - pid 模式只填 rss_mb / cpu_pct；log-dir 模式只填 jsonl 相关列；不可用列输出 "-"。
//   - 进程指标由 tasklist 采集（纯 stdlib + os/exec，零新依赖）：rss_mb 取
//     Working Set；cpu_pct 取累计 CPU Time 两次采样差值 / 墙钟差值
//     （tasklist 的 CPU Time 精度为 1 秒，短窗口下会有抖动）。
//   - tick 进度 = decision.jsonl 行数（runtime/<tenant>/runs/<run-id>/decision.jsonl）。
//   - err_cnt / warn_cnt 是日志尾部 tailLines 行内 level=ERROR / level=WARN 的条数。
//
// Ctrl+C 优雅退出，汇总（平均/峰值 RSS、运行时长、tick 速率）输出到 stderr。
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/csv"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// tailLines 是日志尾部统计窗口：只统计最新 *.log 最后 N 行的 ERROR / WARN。
const tailLines = 200

// timeFormat 是 TSV 时间列的格式（RFC3339 无小数秒，可排序、无歧义）。
const timeFormat = "2006-01-02T15:04:05Z07:00"

// 退出码：0 正常（含 Ctrl+C 优雅退出）；2 用法错误。
const (
	exitOK    = 0
	exitUsage = 2
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) != 2 {
		usage()
		return exitUsage
	}
	intervalSec, err := strconv.Atoi(args[1])
	if err != nil || intervalSec < 1 {
		fmt.Fprintln(os.Stderr, "runwatch: interval-seconds 必须是 >= 1 的整数")
		usage()
		return exitUsage
	}
	m := &monitor{interval: time.Duration(intervalSec) * time.Second, start: time.Now()}
	if pid, err := strconv.Atoi(args[0]); err == nil {
		// 第一个参数是纯数字 → pid 模式。
		if pid < 1 {
			fmt.Fprintln(os.Stderr, "runwatch: pid 必须是正整数")
			usage()
			return exitUsage
		}
		m.pidMode = true
		m.pid = pid
	} else {
		m.logDir = args[0]
	}

	// 基线采样：CPU% 与 tick 速率都需要与首次正式采样做差值。
	m.baseline()

	fmt.Println("time\trss_mb\tcpu_pct\tjsonl_lines\tlast_log_at\terr_cnt\twarn_cnt")
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt) // Windows Ctrl+C
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()
	for {
		select {
		case <-sigCh:
			m.summary(os.Stderr)
			return exitOK
		case <-ticker.C:
			m.sample()
		}
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `usage: runwatch <pid|log-dir> <interval-seconds>

  <pid>              监控进程（tasklist 采集 RSS / CPU，Windows）
  <log-dir>          监控运行日志目录（runtime/<tenant>/runs/<run-id> 或 runtime/<tenant>）
  <interval-seconds> 采样间隔秒数（>= 1）

示例：
  runwatch 12345 15         每 15 秒输出一行进程 RSS / CPU
  runwatch runtime/t3 5     每 5 秒输出 tick 进度与 ERROR / WARN 计数
`)
}

// monitor 维护采样状态与汇总统计：pid 模式（tasklist 两次采样差值）与
// log 模式（decision.jsonl 行数基线 + 日志尾部事件）。
type monitor struct {
	pidMode  bool
	pid      int
	logDir   string
	interval time.Duration
	start    time.Time

	// pid 模式状态：CPU 采样基线 + RSS 汇总。
	hasPrev     bool
	prevCPUTime time.Duration
	prevWall    time.Time
	rssSum      float64
	rssCount    int
	rssPeak     float64
	foundOnce   bool // 曾成功采样过（用于进程消失的一次性提示）

	// log 模式状态：jsonl 行数基线 + 最近日志事件。
	baselineLines int
	finalLines    int
	cachedPath    string // 行数缓存：同一文件 size 未变时跳过整文件重读
	cachedSize    int64
	cachedLines   int
	finalErrCnt   int
	finalWarnCnt  int
	lastErrLine   string
	lastWarnLine  string
}

// baseline 采集差值基线：pid 模式的累计 CPU 时间、log 模式的 jsonl 行数。
func (m *monitor) baseline() {
	if m.pidMode {
		if s, ok := queryProcess(m.pid); ok {
			m.prevCPUTime = s.cpuTime
			m.prevWall = time.Now()
			m.hasPrev = true
		}
		return
	}
	if path, err := findDecisionLog(m.logDir); err == nil {
		if lines, err := countLines(path); err == nil {
			m.baselineLines = lines
		}
	}
}

// sample 采样一次并输出一行 TSV；不可用列输出 "-"。
func (m *monitor) sample() {
	now := time.Now()
	rss, cpu := "-", "-"
	if m.pidMode {
		if s, ok := queryProcess(m.pid); ok {
			rss = fmt.Sprintf("%.1f", s.rssMB)
			if m.hasPrev {
				cpuSec := (s.cpuTime - m.prevCPUTime).Seconds() // Duration 纳秒 → 秒
				cpuPct := cpuSec / now.Sub(m.prevWall).Seconds() * 100
				cpu = fmt.Sprintf("%.1f", cpuPct)
			}
			m.rssSum += s.rssMB
			m.rssCount++
			if s.rssMB > m.rssPeak {
				m.rssPeak = s.rssMB
			}
			m.prevCPUTime, m.prevWall, m.hasPrev = s.cpuTime, now, true
			m.foundOnce = true
		} else if m.foundOnce {
			fmt.Fprintf(os.Stderr, "runwatch: pid %d 在 tasklist 中消失（进程可能已退出）\n", m.pid)
			m.foundOnce = false // 只提示一次，避免每 tick 重复刷屏
		}
	}

	lines, lastLogAt, errCnt, warnCnt := "-", "-", "-", "-"
	if !m.pidMode {
		lines, lastLogAt = m.sampleJsonl()
		errCnt, warnCnt = m.sampleLogTail()
	}

	fmt.Printf("%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
		now.Format(timeFormat), rss, cpu, lines, lastLogAt, errCnt, warnCnt)
}

// sampleJsonl 统计 decision.jsonl 行数（tick 进度）与最后写入时间（mtime）。
// 返回两个 "-" 表示当前没有可用 run（例如 run 目录尚未创建）。
func (m *monitor) sampleJsonl() (linesStr, lastLogAt string) {
	path, err := findDecisionLog(m.logDir)
	if err != nil {
		return "-", "-"
	}
	info, err := os.Stat(path)
	if err != nil {
		return "-", "-"
	}
	lines := 0
	if m.cachedPath == path && info.Size() == m.cachedSize {
		lines = m.cachedLines // 文件未增长，跳过整文件重读
	} else {
		n, err := countLines(path)
		if err != nil {
			return "-", "-"
		}
		lines = n
		m.cachedPath, m.cachedSize, m.cachedLines = path, info.Size(), n
	}
	m.finalLines = lines
	return strconv.Itoa(lines), info.ModTime().Format(timeFormat)
}

// sampleLogTail 统计最新 *.log 尾部 tailLines 行内的 ERROR / WARN 条数。
// 没有可用日志文件时返回两个 "-"。
func (m *monitor) sampleLogTail() (errCnt, warnCnt string) {
	path, err := newestLogFile(m.logDir)
	if err != nil {
		return "-", "-"
	}
	e, w, lastErr, lastWarn, err := tailLevelCounts(path)
	if err != nil {
		return "-", "-"
	}
	m.finalErrCnt, m.finalWarnCnt = e, w
	if lastErr != "" {
		m.lastErrLine = lastErr
	}
	if lastWarn != "" {
		m.lastWarnLine = lastWarn
	}
	return strconv.Itoa(e), strconv.Itoa(w)
}

// summary 在 Ctrl+C 后输出汇总（stdout 保持纯 TSV，汇总走 w=stderr）。
func (m *monitor) summary(w io.Writer) {
	fmt.Fprintf(w, "\nrunwatch: 停止，汇总（时长 %s）\n", time.Since(m.start).Round(time.Second))
	if m.pidMode {
		if m.rssCount == 0 {
			fmt.Fprintf(w, "  rss: 无有效采样（pid %d 始终未找到）\n", m.pid)
			return
		}
		fmt.Fprintf(w, "  rss: 平均 %.1f MB，峰值 %.1f MB（%d 次采样）\n",
			m.rssSum/float64(m.rssCount), m.rssPeak, m.rssCount)
		return
	}
	elapsed := time.Since(m.start).Seconds()
	growth := m.finalLines - m.baselineLines
	if growth < 0 {
		growth = 0 // 换 run 目录等边界情况，不输出负数
	}
	fmt.Fprintf(w, "  jsonl: %d → %d 行，tick 速率 %.3f 行/秒\n",
		m.baselineLines, m.finalLines, float64(growth)/elapsed)
	fmt.Fprintf(w, "  日志尾部 %d 行: ERROR %d，WARN %d\n", tailLines, m.finalErrCnt, m.finalWarnCnt)
	if m.lastErrLine != "" {
		fmt.Fprintf(w, "  最近 ERROR: %s\n", m.lastErrLine)
	}
	if m.lastWarnLine != "" {
		fmt.Fprintf(w, "  最近 WARN: %s\n", m.lastWarnLine)
	}
}

// ---------------------------------------------------------------------------
// 进程采集（tasklist，零新依赖）
// ---------------------------------------------------------------------------

// procSample 是一次 tasklist 采样：RSS（MB）与累计 CPU 时间。
type procSample struct {
	rssMB   float64
	cpuTime time.Duration
}

// queryProcess 通过 tasklist 查询 pid 的 Working Set 与累计 CPU Time。
// 进程不存在时（tasklist 返回空或 INFO 提示行）返回 false。
//
// 必须加 /V：tasklist 在管道重定向（非控制台）时默认只输出前 5 列
// （Image Name/PID/Session/Session#/Mem Usage），没有 CPU Time；/V 才输出
// 完整 9 列。实测：Windows 11 + Go 子进程管道下确认此行为。
func queryProcess(pid int) (procSample, bool) {
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH", "/V").Output()
	if err != nil {
		return procSample{}, false
	}
	records, err := parseTasklistCSV(out)
	if err != nil || len(records) == 0 {
		return procSample{}, false
	}
	row := records[0]
	// /V 列序：0 Image Name, 1 PID, 2 Session Name, 3 Session#,
	// 4 Mem Usage, 5 Status, 6 User Name, 7 CPU Time, 8 Window Title。
	if len(row) < 8 {
		return procSample{}, false
	}
	memKB, err := parseMemUsageKB(row[4])
	if err != nil {
		return procSample{}, false
	}
	cpu, err := parseCPUTime(row[7])
	if err != nil {
		return procSample{}, false
	}
	return procSample{rssMB: float64(memKB) / 1024, cpuTime: cpu}, true
}

// parseTasklistCSV 解析 tasklist 的 CSV 输出：管道重定向时输出 UTF-16LE
// （带 BOM），控制台直出为系统代码页（UTF-8/GBK）。统一解码为 UTF-8 后
// 交给 encoding/csv（数字字段均为 ASCII，编码差异不影响解析）。
func parseTasklistCSV(raw []byte) ([][]string, error) {
	r := csv.NewReader(strings.NewReader(decodeWindowsOutput(raw)))
	r.FieldsPerRecord = -1 // 列数不固定，按行容错
	return r.ReadAll()
}

// decodeWindowsOutput 把 Windows 命令行工具的输出统一转为 UTF-8 字符串。
func decodeWindowsOutput(raw []byte) string {
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
		return decodeUTF16LE(raw[2:])
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	// 非 UTF-8（GBK 等）：数字与逗号均为 ASCII，可直接按字节处理；
	// 仅去除 UTF-16 残留的 NUL 字节以防混合编码。
	return string(bytes.ReplaceAll(raw, []byte{0}, nil))
}

// decodeUTF16LE 将 UTF-16LE 字节流解码为字符串（tasklist 重定向输出的编码）。
func decodeUTF16LE(b []byte) string {
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return string(utf16.Decode(u))
}

// parseMemUsageKB 解析 tasklist 的 Mem Usage 字段（如 "15,664 K"）。
func parseMemUsageKB(s string) (int64, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, " K")
	s = strings.ReplaceAll(s, ",", "")
	return strconv.ParseInt(s, 10, 64)
}

// parseCPUTime 解析 tasklist 的 CPU Time 字段（H:MM:SS）。
func parseCPUTime(s string) (time.Duration, error) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 3 {
		return 0, fmt.Errorf("unexpected cpu time format %q", s)
	}
	h, errH := strconv.Atoi(parts[0])
	min, errM := strconv.Atoi(parts[1])
	sec, errS := strconv.Atoi(parts[2])
	if errH != nil || errM != nil || errS != nil {
		return 0, fmt.Errorf("unexpected cpu time format %q", s)
	}
	return time.Duration(h)*time.Hour + time.Duration(min)*time.Minute + time.Duration(sec)*time.Second, nil
}

// ---------------------------------------------------------------------------
// 日志采集（decision.jsonl tick 进度 + 日志尾部 ERROR / WARN）
// ---------------------------------------------------------------------------

// findDecisionLog 定位 decision.jsonl：
//   - 给定目录自身存在 decision.jsonl → 直接使用（run 目录场景）；
//   - 否则在 <dir>/runs/ 下取最新 run 子目录中的 decision.jsonl（tenant
//     目录场景；run-YYYYMMDDTHHMMSS 命名按字典序即时间序）。
func findDecisionLog(dir string) (string, error) {
	direct := filepath.Join(dir, "decision.jsonl")
	if info, err := os.Stat(direct); err == nil && !info.IsDir() {
		return direct, nil
	}
	runsDir := filepath.Join(dir, "runs")
	entries, err := os.ReadDir(runsDir)
	if err != nil {
		return "", fmt.Errorf("no decision.jsonl in %s (nor %s)", dir, runsDir)
	}
	var runDirs []string
	for _, e := range entries {
		if e.IsDir() {
			runDirs = append(runDirs, e.Name())
		}
	}
	sort.Strings(runDirs)
	for i := len(runDirs) - 1; i >= 0; i-- {
		p := filepath.Join(runsDir, runDirs[i], "decision.jsonl")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("no decision.jsonl under %s/runs", dir)
}

// newestLogFile 在 dir 自身及 <dir>/runs/* 下找修改时间最新的 *.log 文件
// （live 日志可能由 --log-file 写到 run 目录，也可能写到 tenant 目录）。
func newestLogFile(dir string) (string, error) {
	var best string
	var bestTime time.Time
	scan := func(parent string, d fs.DirEntry) {
		if d.IsDir() || filepath.Ext(d.Name()) != ".log" {
			return
		}
		info, err := d.Info()
		if err != nil {
			return
		}
		if best == "" || info.ModTime().After(bestTime) {
			best, bestTime = filepath.Join(parent, d.Name()), info.ModTime()
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		scan(dir, e)
	}
	runsDir := filepath.Join(dir, "runs")
	if entries, err := os.ReadDir(runsDir); err == nil {
		for _, run := range entries {
			if !run.IsDir() {
				continue
			}
			if inner, err := os.ReadDir(filepath.Join(runsDir, run.Name())); err == nil {
				for _, e := range inner {
					scan(filepath.Join(runsDir, run.Name()), e)
				}
			}
		}
	}
	if best == "" {
		return "", fmt.Errorf("no *.log file under %s", dir)
	}
	return best, nil
}

// tailLevelCounts 统计 path 最后 tailLines 行内 level=ERROR / level=WARN 的
// 条数，并返回最后一条 ERROR / WARN 行原文（汇总时展示最近事件）。
func tailLevelCounts(path string) (errCnt, warnCnt int, lastErr, lastWarn string, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, "", "", err
	}
	lines := bytes.Split(data, []byte("\n"))
	if len(lines) > tailLines {
		lines = lines[len(lines)-tailLines:]
	}
	for _, line := range lines {
		s := string(line)
		switch {
		case strings.Contains(s, "level=ERROR"):
			errCnt++
			lastErr = s
		case strings.Contains(s, "level=WARN"):
			warnCnt++
			lastWarn = s
		}
	}
	return errCnt, warnCnt, lastErr, lastWarn, nil
}

// countLines 返回文件行数（换行符个数；telemetry 每行必以 '\n' 结尾）。
func countLines(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return bytes.Count(data, []byte("\n")), nil
}
