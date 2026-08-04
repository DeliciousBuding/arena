package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/deliciousbuding/arena/internal/version"
)

// manifestFieldOrder 与主工作区真实样本 runs/<runId>/manifest.json 的字段顺序
// 一致（任务书字段清单，不含 TS 版 piVersion）。
var manifestFieldOrder = []string{
	"processRunId", "gitSha", "sdkVersion", "tenantId", "decisionMode",
	"submitEnabled", "modelId", "provider", "rulesVersion", "configHash", "startedAt",
}

// fixedManifestOptions 构造确定性 manifest 输入。
func fixedManifestOptions() ManifestOptions {
	return ManifestOptions{
		ProcessRunID:  "aa39ea1a-4fef-48c9-82ff-3de70a17b9b6",
		TenantID:      "t1",
		DecisionMode:  "deterministic",
		SubmitEnabled: false,
		ModelID:       "deepseek-v4-flash",
		Provider:      "openai",
		RulesVersion:  "v0.11",
		ConfigHash:    "sha256:cedeb016cf2c8a310aa8080bae5504b2a6760772d192a2759cca61055683a29c",
		StartedAt:     time.Date(2026, 8, 4, 13, 50, 44, 448_000_000, time.UTC),
	}
}

// TestBuildManifestFieldsComplete 11 个字段完整、gitSha 非空、startedAt 为
// TS toISOString() 对齐格式（UTC 毫秒）。
func TestBuildManifestFieldsComplete(t *testing.T) {
	manifest, err := BuildManifest(fixedManifestOptions())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if manifest.ProcessRunID != "aa39ea1a-4fef-48c9-82ff-3de70a17b9b6" {
		t.Errorf("ProcessRunID = %q", manifest.ProcessRunID)
	}
	if manifest.GitSHA == "" {
		t.Errorf("gitSha must be non-empty")
	}
	if manifest.GitSHA != version.Info().SHA {
		t.Errorf("gitSha = %q, want version.Info().SHA = %q", manifest.GitSHA, version.Info().SHA)
	}
	if manifest.SDKVersion != version.Info().Tag {
		t.Errorf("sdkVersion = %q, want version.Info().Tag = %q", manifest.SDKVersion, version.Info().Tag)
	}
	if manifest.TenantID != "t1" {
		t.Errorf("TenantID = %q", manifest.TenantID)
	}
	if manifest.DecisionMode != "deterministic" {
		t.Errorf("DecisionMode = %q", manifest.DecisionMode)
	}
	if manifest.SubmitEnabled {
		t.Errorf("SubmitEnabled must be false")
	}
	if manifest.ModelID != "deepseek-v4-flash" {
		t.Errorf("ModelID = %q", manifest.ModelID)
	}
	if manifest.Provider != "openai" {
		t.Errorf("Provider = %q", manifest.Provider)
	}
	if manifest.RulesVersion != "v0.11" {
		t.Errorf("RulesVersion = %q", manifest.RulesVersion)
	}
	if manifest.ConfigHash == "" {
		t.Errorf("ConfigHash must be non-empty")
	}
	if manifest.StartedAt != "2026-08-04T13:50:44.448Z" {
		t.Errorf("StartedAt = %q, want %q", manifest.StartedAt, "2026-08-04T13:50:44.448Z")
	}
}

// TestBuildManifestGeneratesRunID ProcessRunID 为空时自动生成 UUID v4。
func TestBuildManifestGeneratesRunID(t *testing.T) {
	opts := fixedManifestOptions()
	opts.ProcessRunID = ""
	manifest, err := BuildManifest(opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !uuidV4Pattern.MatchString(manifest.ProcessRunID) {
		t.Errorf("ProcessRunID = %q, want UUID v4 format", manifest.ProcessRunID)
	}
}

// uuidV4Pattern 8-4-4-4-12 十六进制、version 位 = 4、variant 位 = 8/9/a/b。
var uuidV4Pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// TestNewProcessRunIDFormatAndUniqueness 生成 50 个 ID：格式全部合法且互不重复。
func TestNewProcessRunIDFormatAndUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		id, err := newProcessRunID()
		if err != nil {
			t.Fatalf("newProcessRunID: %v", err)
		}
		if !uuidV4Pattern.MatchString(id) {
			t.Fatalf("id %q is not a valid UUID v4", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}

// TestBuildManifestZeroStartedAt StartedAt 为零值时取当前时间（UTC 毫秒格式）。
func TestBuildManifestZeroStartedAt(t *testing.T) {
	opts := fixedManifestOptions()
	opts.StartedAt = time.Time{}
	manifest, err := BuildManifest(opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if _, err := time.Parse(startedAtFormat, manifest.StartedAt); err != nil {
		t.Errorf("StartedAt = %q, want %q format: %v", manifest.StartedAt, startedAtFormat, err)
	}
	if !strings.HasSuffix(manifest.StartedAt, "Z") {
		t.Errorf("StartedAt = %q, want UTC (Z suffix)", manifest.StartedAt)
	}
}

// TestWriteManifestFormattedJSON 写出的 manifest 是 2 空格缩进 + 尾部换行，
// 可解析且字段与输入一致。
func TestWriteManifestFormattedJSON(t *testing.T) {
	manifest, err := BuildManifest(fixedManifestOptions())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	path := filepath.Join(t.TempDir(), "runs", manifest.ProcessRunID, "manifest.json")
	if err := WriteManifest(path, manifest); err != nil {
		t.Fatalf("write: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	content := string(data)
	if !strings.HasSuffix(content, "\n") {
		t.Errorf("manifest must end with newline")
	}
	if !strings.Contains(content, "\n  \"processRunId\"") {
		t.Errorf("manifest must be 2-space indented, got:\n%s", content)
	}
	var readBack RunManifest
	if err := json.Unmarshal(data, &readBack); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if readBack != manifest {
		t.Errorf("round-trip mismatch:\n got=%+v\nwant=%+v", readBack, manifest)
	}
}

// TestManifestJSONFieldNamesAndOrder 字段名与顺序和真实 TS 样本逐项一致。
func TestManifestJSONFieldNamesAndOrder(t *testing.T) {
	manifest, err := BuildManifest(fixedManifestOptions())
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	content := string(data)
	lastIndex := -1
	for _, field := range manifestFieldOrder {
		quoted := `"` + field + `"`
		index := strings.Index(content, quoted)
		if index < 0 {
			t.Errorf("field %q missing from serialized manifest: %s", field, content)
			continue
		}
		if index < lastIndex {
			t.Errorf("field order broken: %q appears before an earlier field in %s", field, content)
		}
		lastIndex = index
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(fields) != len(manifestFieldOrder) {
		t.Errorf("manifest has %d fields, want %d: %v", len(fields), len(manifestFieldOrder), fields)
	}
	for _, field := range manifestFieldOrder {
		if _, ok := fields[field]; !ok {
			t.Errorf("field %q missing", field)
		}
	}
}
