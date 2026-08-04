package telemetry

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/deliciousbuding/arena/internal/version"
)

// RunManifest 描述一次进程运行（process run）的固定属性；JSON 字段名与 TS 版
// runs/<processRunId>/manifest.json 逐项兼容（不含 TS 版 piVersion 字段）。
type RunManifest struct {
	ProcessRunID  string `json:"processRunId"`
	GitSHA        string `json:"gitSha"`
	SDKVersion    string `json:"sdkVersion"`
	TenantID      string `json:"tenantId"`
	DecisionMode  string `json:"decisionMode"`
	SubmitEnabled bool   `json:"submitEnabled"`
	ModelID       string `json:"modelId"`
	Provider      string `json:"provider"`
	RulesVersion  string `json:"rulesVersion"`
	ConfigHash    string `json:"configHash"`
	StartedAt     string `json:"startedAt"`
}

// ManifestOptions 是 BuildManifest 的输入；ProcessRunID 为空时自动生成 UUID v4。
type ManifestOptions struct {
	ProcessRunID  string
	TenantID      string
	DecisionMode  string
	SubmitEnabled bool
	ModelID       string
	Provider      string
	RulesVersion  string
	ConfigHash    string
	StartedAt     time.Time // 零值 → time.Now().UTC()
}

// startedAtFormat 与 TS 版 toISOString() 对齐：UTC 毫秒精度。
const startedAtFormat = "2006-01-02T15:04:05.000Z"

// BuildManifest 组装运行 manifest；gitSha/sdkVersion 取自 version.Info()
// （-ldflags 注入，未注入时为 "unknown"）。
func BuildManifest(opts ManifestOptions) (RunManifest, error) {
	info := version.Info()
	processRunID := opts.ProcessRunID
	if processRunID == "" {
		id, err := newProcessRunID()
		if err != nil {
			return RunManifest{}, err
		}
		processRunID = id
	}
	startedAt := opts.StartedAt
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	return RunManifest{
		ProcessRunID:  processRunID,
		GitSHA:        info.SHA,
		SDKVersion:    info.Tag,
		TenantID:      opts.TenantID,
		DecisionMode:  opts.DecisionMode,
		SubmitEnabled: opts.SubmitEnabled,
		ModelID:       opts.ModelID,
		Provider:      opts.Provider,
		RulesVersion:  opts.RulesVersion,
		ConfigHash:    opts.ConfigHash,
		StartedAt:     startedAt.UTC().Format(startedAtFormat),
	}, nil
}

// WriteManifest 以 2 空格缩进格式化 JSON 写入 path（与 TS 版 writeRunManifest
// 一致），父目录自动创建，文件尾部带换行。
func WriteManifest(path string, m RunManifest) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("telemetry: marshal manifest: %w", err)
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("telemetry: create manifest dir: %w", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("telemetry: write manifest %s: %w", path, err)
	}
	return nil
}

// newProcessRunID 生成 UUID v4：crypto/rand 16 字节 + 手工格式化
// （不引第三方 UUID 库，任务书允许的简单方案）。
func newProcessRunID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("telemetry: generate process run id: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
