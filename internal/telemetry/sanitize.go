package telemetry

import (
	"regexp"
	"strings"
)

// RedactedPlaceholder 是所有命中敏感键或敏感值的字段的替换值。
const RedactedPlaceholder = "[REDACTED]"

// sensitiveKeyWords 是键名大小写不敏感的子串匹配关键词；命中即把整个值替换。
var sensitiveKeyWords = []string{
	"token", "key", "secret", "password", "api_key", "apikey", "authorization", "bearer",
}

// skKeyPattern 匹配 OpenAI 风格密钥（sk- 后至少 24 位字母数字）。
var skKeyPattern = regexp.MustCompile(`sk-[A-Za-z0-9]{24,}`)

// sensitiveValuePrefixes 是值级凭据前缀（大小写不敏感）：
// GitHub PAT（ghp_）、Bearer 认证头、ah_live 前缀。
var sensitiveValuePrefixes = []string{"ghp_", "bearer", "ah_live"}

// SanitizeValue 递归脱敏任意 JSON 值：
//   - map[string]any：键名含 token/key/secret/password/api_key/apikey/
//     authorization/bearer（大小写不敏感）→ 整个值替换为 [REDACTED]；
//     其余键递归处理；
//   - []any：逐元素递归；
//   - string：命中 sk-[A-Za-z0-9]{24,}、ghp_/Bearer/ah_live 前缀 → 整个字符串
//     替换为 [REDACTED]；
//   - 其余标量原样返回。
//
// 返回全新结构，不修改输入。
func SanitizeValue(v any) any {
	switch value := v.(type) {
	case string:
		if isSensitiveValue(value) {
			return RedactedPlaceholder
		}
		return value
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			if isSensitiveKey(key) {
				out[key] = RedactedPlaceholder
			} else {
				out[key] = SanitizeValue(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = SanitizeValue(item)
		}
		return out
	default:
		return v
	}
}

// isSensitiveKey 判断键名是否命中敏感关键词（大小写不敏感子串匹配）。
func isSensitiveKey(key string) bool {
	lowered := strings.ToLower(key)
	for _, keyword := range sensitiveKeyWords {
		if strings.Contains(lowered, keyword) {
			return true
		}
	}
	return false
}

// isSensitiveValue 判断字符串值是否形如凭据。
func isSensitiveValue(s string) bool {
	if skKeyPattern.MatchString(s) {
		return true
	}
	lowered := strings.ToLower(s)
	for _, prefix := range sensitiveValuePrefixes {
		if strings.HasPrefix(lowered, prefix) {
			return true
		}
	}
	return false
}
