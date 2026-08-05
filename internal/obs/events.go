package obs

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// 诊断事件名约定（docs/go/07-observability.md §4）。
const (
	EventWSConnected     = "ws.connected"
	EventWSReadEnded     = "ws.read_ended"
	EventWSReconnect     = "ws.reconnect"
	EventWSIdleTimeout   = "ws.idle_timeout"
	EventTickProcessed   = "tick.processed"
	EventTickGapWarn     = "tick.gap_warn"
	EventHandleStateSlow = "handle_state.slow"
	EventIdleDump        = "idle.dump"
	EventIdleDumpEsc     = "idle.dump_escalated"
	EventSubmitAccepted  = "submit.accepted"
	EventSubmitRejected  = "submit.rejected"
	EventPlannerRepair   = "planner.repair"
	EventErrorClassified = "error.classified"
)

// 错误分类（metrics 与事件共用）。
const (
	ErrorClassConfig         = "config"
	ErrorClassTransport      = "transport"
	ErrorClassProtocol       = "protocol"
	ErrorClassLease          = "lease"
	ErrorClassLock           = "lock"
	ErrorClassSubmitRejected = "submit_rejected"
)

// WriteStackDump 将 goroutine 栈写入 runtime/<tenant>/dumps/idle-<run>-<n>.stack，
// 返回文件路径（失败返回 error，调用方仍应记录日志）。
func WriteStackDump(dumpDir, runID string, sequence int, stack []byte) (string, error) {
	dir := filepath.Join(dumpDir, "dumps")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("obs: create dump dir: %w", err)
	}
	path := filepath.Join(dir, fmt.Sprintf("idle-%s-%d.stack", runID, sequence))
	if err := os.WriteFile(path, stack, 0o600); err != nil {
		return "", fmt.Errorf("obs: write stack dump: %w", err)
	}
	return path, nil
}

// Header 生成 dump 文件头（时间与触发原因，便于离线分析）。
func Header(reason string) string {
	return fmt.Sprintf("=== arena goroutine dump ===\nreason: %s\nat: %s\n\n",
		reason, time.Now().UTC().Format(time.RFC3339))
}
