// Package llm 提供统一 LLM 客户端：OpenAI-completions SSE 流式调用、
// 模型路由、指数退避重试与熔断器。仅依赖标准库（net/http、bufio），
// apiKey 只保存在内存中，绝不落盘。
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Options 配置 Client。
type Options struct {
	// APIKey 用于 Authorization: Bearer 头；由调用方传入，仅内存持有。
	APIKey string
	// HTTPClient 底层 HTTP 客户端；nil 时使用 http.DefaultClient。
	HTTPClient *http.Client
	// Circuit 熔断器；nil 时创建默认实例（连续失败阈值 3、冷却 30s）。
	Circuit *CircuitBreaker
	// MaxAttempts 单次 Complete 的最大尝试次数（含首次）；<=0 时默认 3。
	MaxAttempts int
	// BaseDelay 指数退避基础延迟；<=0 时默认 250ms。
	BaseDelay time.Duration
	// MaxDelay 退避上限；<=0 时默认 5s。
	MaxDelay time.Duration
	// Sleep 退避等待函数（测试可注入 no-op）；nil 时使用 context 感知睡眠。
	Sleep func(ctx context.Context, d time.Duration) error
}

// Client 是统一 LLM 流式客户端。
type Client struct {
	apiKey  string
	http    *http.Client
	circuit *CircuitBreaker
	retry   retryPolicy
}

// New 构建 Client。零值 Options 提供安全的默认行为。
func New(opts Options) *Client {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	circuit := opts.Circuit
	if circuit == nil {
		circuit = NewCircuit(CircuitOptions{})
	}
	policy := retryPolicy{
		maxAttempts: opts.MaxAttempts,
		baseDelay:   opts.BaseDelay,
		maxDelay:    opts.MaxDelay,
		sleep:       opts.Sleep,
	}
	policy.applyDefaults()
	return &Client{apiKey: opts.APIKey, http: httpClient, circuit: circuit, retry: policy}
}

// Complete 发起一次流式补全：POST {model.BaseURL}/chat/completions。
// 模型路由依据 ChatRequest.Model（provider/baseURL/id）。
// 仅对可重试错误（网络错误 / 429 / 5xx）指数退避重试；context 取消不重试。
// 熔断器放行时进入，流建立失败与流中错误会累计熔断失败。
// 返回的 Stream 在消费完或提前放弃后必须 Close。
func (c *Client) Complete(ctx context.Context, req ChatRequest) (Stream, error) {
	if err := req.validate(); err != nil {
		return nil, err
	}
	if !c.circuit.Allow() {
		return nil, fmt.Errorf("%w: 冷却中或探测在途", ErrCircuitOpen)
	}
	var lastErr error
	for attempt := 0; attempt < c.retry.maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		stream, err := c.attempt(ctx, req)
		if err == nil {
			return stream, nil
		}
		lastErr = err
		if !IsRetryable(err) || attempt >= c.retry.maxAttempts-1 {
			break
		}
		if err := c.retry.sleep(ctx, c.retry.backoff(attempt)); err != nil {
			return nil, err
		}
	}
	c.circuit.ReportFailure()
	return nil, lastErr
}

// attempt 执行一次 HTTP 请求；2xx 时返回流，否则返回分类错误。
func (c *Client) attempt(ctx context.Context, req ChatRequest) (Stream, error) {
	payload, err := buildCompletionBody(req)
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithCancel(ctx)
	endpoint, err := url.JoinPath(req.Model.BaseURL, "chat/completions")
	if err != nil {
		cancel()
		return nil, fmt.Errorf("llm: 无效 baseURL %q: %w", req.Model.BaseURL, err)
	}
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		cancel()
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(httpReq)
	if err != nil {
		cancel()
		return nil, &TransportError{Err: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpErr := parseHTTPError(resp)
		cancel()
		return nil, &httpError{HTTPError: *httpErr}
	}
	return newSSEStream(cancel, resp, c.circuit), nil
}

// ChatRequest 是一次补全请求。Stream 字段仅用于兼容表达；客户端恒以流式发送。
type ChatRequest struct {
	Model       Model
	Messages    []Message
	Temperature float64 // 0 = 不发送（服务端默认）
	MaxTokens   int     // 0 = 不发送
	Stream      bool    // 兼容字段：客户端始终以 stream=true 发送
}

// Message 是对话消息（OpenAI-completions 格式）。
type Message struct {
	Role       string     `json:"role"`                   // system / user / assistant / tool
	Content    string     `json:"content,omitempty"`      // 文本内容
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`   // assistant 消息回放的工具调用
	ToolCallID string     `json:"tool_call_id,omitempty"` // tool 消息关联的调用 ID
}

// ToolCall 是一次工具调用（SSE delta 与请求体共用同一 wire 格式）。
type ToolCall struct {
	Index    int              `json:"index,omitempty"`
	ID       string           `json:"id,omitempty"`
	Type     string           `json:"type,omitempty"` // 通常为 "function"
	Function ToolCallFunction `json:"function,omitempty"`
}

// ToolCallFunction 描述函数名与参数（arguments 为 JSON 片段）。
type ToolCallFunction struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

// validate 校验请求必填项与角色取值。
func (r ChatRequest) validate() error {
	if err := r.Model.Validate(); err != nil {
		return err
	}
	if len(r.Messages) == 0 {
		return errors.New("llm: messages 不能为空")
	}
	for i, m := range r.Messages {
		switch m.Role {
		case "system", "user", "assistant", "tool":
		default:
			return fmt.Errorf("llm: messages[%d] 非法 role %q", i, m.Role)
		}
	}
	return nil
}

// HTTPError 是 HTTP 非 2xx 响应的分类错误（结构对齐 OpenAI error 字段）。
// 字段 Error 与 error 接口方法同名，故 error 实现由 httpError 包装承载；
// 用 AsHTTPError 从错误链中提取本类型。
type HTTPError struct {
	StatusCode int    // 原始 HTTP 状态码
	Error      string // 服务端 error.code / error.type（或字符串形式的 error）
	Message    string // 服务端 error.message（或原始响应体摘要）
}

// httpError 是 HTTPError 的 error 接口实现（包装）。
type httpError struct{ HTTPError }

func (e *httpError) Error() string {
	switch {
	case e.HTTPError.Message != "":
		return fmt.Sprintf("llm: http %d: %s", e.HTTPError.StatusCode, e.HTTPError.Message)
	case e.HTTPError.Error != "":
		return fmt.Sprintf("llm: http %d: %s", e.HTTPError.StatusCode, e.HTTPError.Error)
	default:
		return fmt.Sprintf("llm: http %d", e.HTTPError.StatusCode)
	}
}

// AsHTTPError 从错误链中提取 HTTPError 详情。
func AsHTTPError(err error) (HTTPError, bool) {
	var he *httpError
	if errors.As(err, &he) {
		return he.HTTPError, true
	}
	return HTTPError{}, false
}

// completionBody 是 chat/completions 的请求体（客户端恒以流式发送）。
type completionBody struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature *float64  `json:"temperature,omitempty"`
	MaxTokens   *int      `json:"max_tokens,omitempty"`
	Stream      bool      `json:"stream"`
}

// buildCompletionBody 序列化请求体；Stream 字段被强制为 true。
func buildCompletionBody(req ChatRequest) ([]byte, error) {
	body := completionBody{Model: req.Model.ID, Messages: req.Messages, Stream: true}
	if req.Temperature != 0 {
		t := req.Temperature
		body.Temperature = &t
	}
	if req.MaxTokens > 0 {
		mt := req.MaxTokens
		body.MaxTokens = &mt
	}
	return json.Marshal(body)
}

// parseHTTPError 读取并解析非 2xx 响应体（限 64KiB，防异常放大）。
func parseHTTPError(resp *http.Response) *HTTPError {
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return parseErrorBody(resp.StatusCode, data)
}

// parseErrorBody 解析 OpenAI 风格 error 字段：
// 字符串形式（{"error":"..."}）、对象形式（{"error":{"message","type","code"}}）
// 或非 JSON 原始响应体（回退为 Message 摘要）。
func parseErrorBody(status int, data []byte) *HTTPError {
	var envelope struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err == nil && len(envelope.Error) > 0 {
		var message string
		if err := json.Unmarshal(envelope.Error, &message); err == nil {
			return &HTTPError{StatusCode: status, Error: message}
		}
		var obj struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		}
		if err := json.Unmarshal(envelope.Error, &obj); err == nil {
			code := obj.Code
			if code == "" {
				code = obj.Type
			}
			return &HTTPError{StatusCode: status, Error: code, Message: obj.Message}
		}
	}
	return &HTTPError{StatusCode: status, Message: strings.TrimSpace(string(data))}
}
