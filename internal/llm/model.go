package llm

import "errors"

// Model 描述一个模型端点，用于请求路由与容量决策。
type Model struct {
	// Provider 提供方标识（newapi / openai / local …）。
	Provider string
	// ID 模型 ID，写入请求体 model 字段。
	ID string
	// BaseURL API 基础地址；请求为 POST {BaseURL}/chat/completions。
	BaseURL string
	// MaxTokens 该模型单次生成的最大输出 token 数（0 = 未配置）。
	MaxTokens int
	// Compat 兼容性标注（如 "openai-completions"）。
	Compat string
}

// Validate 校验模型必填字段（ID 与 BaseURL）。
func (m Model) Validate() error {
	if m.ID == "" {
		return errors.New("llm: model ID 不能为空")
	}
	if m.BaseURL == "" {
		return errors.New("llm: model BaseURL 不能为空")
	}
	return nil
}
