package telemetry

import (
	"encoding/json"
	"reflect"
	"regexp"
	"testing"
)

// TestSanitizeSensitiveKeyNames 覆盖任务书规定的敏感键名集合。
func TestSanitizeSensitiveKeyNames(t *testing.T) {
	keys := []string{
		"token", "apiKey", "secret", "password",
		"api_key", "apikey", "authorization", "bearer",
	}
	for _, key := range keys {
		got := SanitizeValue(map[string]any{key: "plain-looking-value"})
		if got.(map[string]any)[key] != RedactedPlaceholder {
			t.Errorf("key %q: want %q, got %v", key, RedactedPlaceholder, got)
		}
	}
}

// TestSanitizeCaseInsensitiveKeys 键名大小写不敏感。
func TestSanitizeCaseInsensitiveKeys(t *testing.T) {
	keys := []string{"API_KEY", "ApiKey", "SECRET", "Token", "PASSWORD", "Authorization", "Bearer", "AccessToken", "X-Api-Key"}
	record := map[string]any{}
	for _, key := range keys {
		record[key] = "sensitive-value"
	}
	got := SanitizeValue(record).(map[string]any)
	for _, key := range keys {
		if got[key] != RedactedPlaceholder {
			t.Errorf("key %q: want %q, got %v", key, RedactedPlaceholder, got[key])
		}
	}
}

// TestSanitizeSecretValuePatterns 字符串值级模式：sk- 长 key、ghp_、Bearer、
// ah_live 前缀。
func TestSanitizeSecretValuePatterns(t *testing.T) {
	secrets := []string{
		"sk-" + "abcdefghijklmnopqrstuvwx",  // sk- + 24 字母
		"sk-" + "abcdefghijklmnopqrstuvwxy", // 25
		"sk-" + "0123456789abcdef01234567",  // 24 混合字母数字
		"ghp_abcdefghijklmnopqrstuvwxyz123456",
		"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
		"bearer token-value",
		"ah_live_abcdef1234567890",
		"AH_LIVE_abcdef1234567890",
	}
	for _, secret := range secrets {
		got := SanitizeValue(map[string]any{"value": secret})
		if got.(map[string]any)["value"] != RedactedPlaceholder {
			t.Errorf("value %q: want %q, got %v", secret, RedactedPlaceholder, got)
		}
	}
}

// TestSanitizeBenignValuesPreserved 非凭据字符串原样保留。
func TestSanitizeBenignValuesPreserved(t *testing.T) {
	benign := []string{
		"hello world",
		"sk-abc", // 长度不足 24，不匹配
		"9683013c-9d26-4135-a4c4-ccac385f37ed",
		"not_applicable",
		"2d5f9af4",
		"UNIT_MOVE_SUCCEEDED",
	}
	for _, value := range benign {
		got := SanitizeValue(map[string]any{"value": value})
		if got.(map[string]any)["value"] != value {
			t.Errorf("value %q: want preserved, got %v", value, got)
		}
	}
}

// TestSanitizeRecursiveStructures 嵌套 map/数组逐层递归。
func TestSanitizeRecursiveStructures(t *testing.T) {
	input := map[string]any{
		"processRunId": "9683013c-9d26-4135-a4c4-ccac385f37ed",
		"agent": map[string]any{
			"session": map[string]any{
				"apiKey": "sk-abcdefghijklmnopqrstuvwxyz",
			},
			"tools": []any{
				map[string]any{"name": "arena_plan", "auth": "Bearer 12345"},
				map[string]any{"name": "arena_map", "state": "visible"},
			},
		},
		"events": []any{"UNIT_MOVE_SUCCEEDED", map[string]any{"password": "hunter2"}},
	}
	got := SanitizeValue(input).(map[string]any)
	agent := got["agent"].(map[string]any)
	if agent["session"].(map[string]any)["apiKey"] != RedactedPlaceholder {
		t.Errorf("nested apiKey: want %q", RedactedPlaceholder)
	}
	tools := agent["tools"].([]any)
	if tools[0].(map[string]any)["auth"] != RedactedPlaceholder {
		t.Errorf("nested bearer in array: want %q", RedactedPlaceholder)
	}
	if tools[1].(map[string]any)["state"] != "visible" {
		t.Errorf("non-sensitive array element must be preserved")
	}
	if got["events"].([]any)[1].(map[string]any)["password"] != RedactedPlaceholder {
		t.Errorf("nested password in array: want %q", RedactedPlaceholder)
	}
	if got["processRunId"] != "9683013c-9d26-4135-a4c4-ccac385f37ed" {
		t.Errorf("processRunId must be preserved")
	}
}

// TestSanitizeScalarPassthrough 标量/空值原样返回。
func TestSanitizeScalarPassthrough(t *testing.T) {
	input := map[string]any{
		"tick":               int64(47542),
		"selectionLatencyMs": 6.6712,
		"abortRequested":     false,
		"agentLatencyMs":     nil,
		"emptyList":          []any{},
		"emptyMap":           map[string]any{},
		"nested":             map[string]any{"n": float64(3.5)},
		"workerMeanDistance": 7.625,
	}
	got := SanitizeValue(input).(map[string]any)
	want := map[string]any{
		"tick":               int64(47542),
		"selectionLatencyMs": 6.6712,
		"abortRequested":     false,
		"agentLatencyMs":     nil,
		"emptyList":          []any{},
		"emptyMap":           map[string]any{},
		"nested":             map[string]any{"n": float64(3.5)},
		"workerMeanDistance": 7.625,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("scalar passthrough mismatch:\n got=%v\nwant=%v", got, want)
	}
}

// secretScanPatterns 扫描序列化结果的凭据特征（正则），零命中即脱敏合格。
// 键值对模式用捕获组取回值；[REDACTED] 占位符不算泄漏。
var secretScanPatterns = []*regexp.Regexp{
	regexp.MustCompile(`sk-[A-Za-z0-9]{24,}`),
	regexp.MustCompile(`ghp_[A-Za-z0-9]+`),
	regexp.MustCompile(`[Bb]earer\s+\S+`),
	regexp.MustCompile(`ah_live\S+`),
	regexp.MustCompile(`"apiKey"\s*:\s*"([^"]*)"`),
	regexp.MustCompile(`"authorization"\s*:\s*"([^"]*)"`),
	regexp.MustCompile(`"password"\s*:\s*"([^"]*)"`),
}

// TestSanitizeSerializedOutputZeroSecrets 序列化后的 JSON 正则扫描零密钥。
func TestSanitizeSerializedOutputZeroSecrets(t *testing.T) {
	input := map[string]any{
		"processRunId": "9683013c-9d26-4135-a4c4-ccac385f37ed",
		"tenantId":     "t1",
		"apiKey":       "sk-abcdefghijklmnopqrstuvwxyz123",
		"token":        "ghp_abcdefghijklmnopqrstuvwxyz123456",
		"auth": map[string]any{
			"authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.payload",
			"ahLiveKey":     "ah_live_abcdef1234567890",
			"api_key":       "super-secret-value",
		},
		"agent": map[string]any{
			"password": "hunter2",
			"tools":    []any{"arena_plan", map[string]any{"accessToken": "sk-zzzzzzzzzzzzzzzzzzzzzzzzzz"}},
		},
	}
	serialized, err := json.Marshal(SanitizeValue(input))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	content := string(serialized)
	for _, pattern := range secretScanPatterns {
		for _, match := range pattern.FindAllStringSubmatch(content, -1) {
			leaked := match[0]
			if len(match) > 1 {
				leaked = match[1]
			}
			if leaked != RedactedPlaceholder {
				t.Errorf("secret pattern %s leaked in serialized output: %q", pattern, match[0])
			}
		}
	}
}

// TestSanitizeDoesNotMutateInput 脱敏是纯函数：输入结构不被修改。
func TestSanitizeDoesNotMutateInput(t *testing.T) {
	input := map[string]any{
		"apiKey": "sk-abcdefghijklmnopqrstuvwxyz",
		"agent": map[string]any{
			"session": map[string]any{"token": "secret-token"},
		},
		"events": []any{map[string]any{"authorization": "Bearer xyz"}},
	}
	before := cloneDeep(input)
	_ = SanitizeValue(input)
	if !reflect.DeepEqual(input, before) {
		t.Errorf("SanitizeValue mutated its input:\n got=%v\nwant=%v", input, before)
	}
}

// cloneDeep 深拷贝 map[string]any（测试辅助）。
func cloneDeep(v map[string]any) map[string]any {
	out := make(map[string]any, len(v))
	for key, item := range v {
		switch value := item.(type) {
		case map[string]any:
			out[key] = cloneDeep(value)
		case []any:
			items := make([]any, len(value))
			for i, element := range value {
				if nested, ok := element.(map[string]any); ok {
					items[i] = cloneDeep(nested)
				} else {
					items[i] = element
				}
			}
			out[key] = items
		default:
			out[key] = item
		}
	}
	return out
}
