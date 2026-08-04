package llm

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
)

// Stream 是一次 LLM 流式响应。Next 返回下一个 Chunk；io.EOF 表示流正常结束。
// Close 可在任意时刻调用（未消费完即放弃时也必须调用）；Close 与 Next 可并发。
type Stream interface {
	Next() (Chunk, error)
	Close() error
}

// Chunk 是流解析出的一个事件块。
type Chunk struct {
	Delta        Delta
	FinishReason string // stop / tool_calls / length / …（透传服务端值）
	Usage        *Usage // 流末可选的 token 用量
}

// Delta 是逐块的增量内容；ToolCalls 为累积视图（arguments 为增量拼接后的完整值）。
type Delta struct {
	Content   string
	ToolCalls []ToolCall
}

// Usage 是流末可选的 token 用量统计。
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// TransportError 是传输层错误（连接建立失败、中段断流等）。
type TransportError struct {
	Err error
}

func (e *TransportError) Error() string {
	return fmt.Sprintf("llm: 传输错误: %v", e.Err)
}

func (e *TransportError) Unwrap() error {
	return e.Err
}

// streamErrorBody 是流错误段（event: error 或 data 中的 error 对象）的结构。
type streamErrorBody struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

// streamEvent 是 SSE data 行反序列化的目标结构（OpenAI-completions 流格式）。
type streamEvent struct {
	Choices []struct {
		Index        int    `json:"index"`
		Delta        Delta  `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *Usage           `json:"usage"`
	Error *streamErrorBody `json:"error"`
}

// sseStream 是手写 SSE 解析器实现的 Stream（零第三方依赖）。
type sseStream struct {
	body    io.ReadCloser
	br      *bufio.Reader
	cancel  context.CancelFunc
	circuit *CircuitBreaker

	mu        sync.Mutex
	done      bool              // 已见 [DONE]
	fatal     error             // 首次致命错误（粘性返回）
	reported  bool              // 已向熔断器上报终态
	eventName string            // 当前事件的 event 字段
	dataLines []string          // 当前事件的 data 行（多行以 \n 拼接）
	toolCalls map[int]*ToolCall // 工具调用增量累积器（按 index）
}

func newSSEStream(cancel context.CancelFunc, resp *http.Response, circuit *CircuitBreaker) *sseStream {
	return &sseStream{
		body:      resp.Body,
		br:        bufio.NewReader(resp.Body),
		cancel:    cancel,
		circuit:   circuit,
		toolCalls: make(map[int]*ToolCall),
	}
}

// Next 返回下一个 Chunk。io.EOF 表示流正常结束（[DONE] 或连接干净关闭）。
// 出现错误后，后续 Next 恒返回同一错误（粘性）。
func (s *sseStream) Next() (Chunk, error) {
	s.mu.Lock()
	fatal := s.fatal
	done := s.done
	s.mu.Unlock()
	if fatal != nil {
		return Chunk{}, fatal
	}
	if done {
		return Chunk{}, io.EOF
	}
	for {
		chunk, dispatched, err := s.readEvent()
		if err == io.EOF {
			return Chunk{}, io.EOF
		}
		if err != nil {
			s.onError(err)
			return Chunk{}, err
		}
		if dispatched {
			return chunk, nil
		}
	}
}

// readEvent 读取并派发一个完整 SSE 事件（以空行分隔）。
// 返回 (chunk, 是否派发, 错误)；注释行与空事件（如 event: ping）不派发，
// 由调用方继续读取。
func (s *sseStream) readEvent() (Chunk, bool, error) {
	for {
		line, ok, err := s.readLine()
		if !ok {
			if err == io.EOF {
				if len(s.dataLines) > 0 || s.eventName != "" {
					// 连接在事件中途干净关闭：处理残余事件
					// （宽松兼容不发 [DONE] 即关流的 provider）
					chunk, _, derr := s.dispatch()
					return chunk, true, derr
				}
				return Chunk{}, true, io.EOF
			}
			return Chunk{}, true, &TransportError{Err: err}
		}
		if line == "" {
			chunk, dispatched, err := s.dispatch()
			if err != nil {
				return chunk, true, err
			}
			if dispatched {
				return chunk, true, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue // SSE 注释行：忽略
		}
		field, value, ok := strings.Cut(line, ":")
		if !ok {
			continue // 非冒号分隔行：忽略（SSE 规范）
		}
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			s.eventName = value
		case "data":
			s.dataLines = append(s.dataLines, value)
		case "id", "retry":
			// 本客户端不需要，忽略
		}
	}
}

// readLine 读取一行（兼容 \n 与 \r\n），剥离行尾换行符。
// ok=false 且 err==io.EOF 表示流干净结束；err==io.EOF 但带残余行内容时
// 按完整行返回（末行无换行符的场景）。
func (s *sseStream) readLine() (line string, ok bool, err error) {
	raw, err := s.br.ReadString('\n')
	raw = strings.TrimSuffix(raw, "\n")
	raw = strings.TrimSuffix(raw, "\r")
	if err == io.EOF && raw != "" {
		return raw, true, nil
	}
	if err != nil {
		return "", false, err
	}
	return raw, true, nil
}

// dispatch 处理累积的 event/data 字段（以空行或流 EOF 触发）。
func (s *sseStream) dispatch() (Chunk, bool, error) {
	data := strings.Join(s.dataLines, "\n") // 多行 data 按 SSE 规范以 \n 拼接
	s.dataLines = nil
	eventName := s.eventName
	s.eventName = ""
	if data == "" {
		return Chunk{}, false, nil // 空事件：跳过
	}
	if data == "[DONE]" {
		s.markDone()
		return Chunk{}, true, io.EOF
	}
	if eventName == "error" {
		return Chunk{}, true, parseStreamError(data)
	}
	var ev streamEvent
	if err := json.Unmarshal([]byte(data), &ev); err != nil {
		return Chunk{}, true, fmt.Errorf("llm: 解析 SSE data 失败: %w", err)
	}
	if ev.Error != nil {
		return Chunk{}, true, streamErrorOf(ev.Error)
	}
	return s.buildChunk(&ev)
}

// buildChunk 将解析结果与工具调用累积器合并成 Chunk。
func (s *sseStream) buildChunk(ev *streamEvent) (Chunk, bool, error) {
	chunk := Chunk{Usage: ev.Usage}
	if len(ev.Choices) == 0 {
		return chunk, true, nil // 纯 usage 段
	}
	choice := ev.Choices[0]
	chunk.Delta = choice.Delta
	chunk.FinishReason = choice.FinishReason
	if len(choice.Delta.ToolCalls) > 0 {
		for _, tc := range choice.Delta.ToolCalls {
			acc := s.toolCalls[tc.Index]
			if acc == nil {
				acc = &ToolCall{Index: tc.Index}
				s.toolCalls[tc.Index] = acc
			}
			if tc.ID != "" {
				acc.ID = tc.ID
			}
			if tc.Type != "" {
				acc.Type = tc.Type
			}
			if tc.Function.Name != "" {
				acc.Function.Name = tc.Function.Name
			}
			acc.Function.Arguments += tc.Function.Arguments // 增量拼接
		}
		calls := make([]ToolCall, 0, len(s.toolCalls))
		for _, acc := range s.toolCalls {
			calls = append(calls, *acc)
		}
		sort.Slice(calls, func(i, j int) bool { return calls[i].Index < calls[j].Index })
		chunk.Delta.ToolCalls = calls
	}
	return chunk, true, nil
}

// streamErrorOf 将 data 中的 error 对象转成错误。
func streamErrorOf(body *streamErrorBody) error {
	message := body.Message
	if message == "" {
		message = body.Type
	}
	if message == "" {
		message = body.Code
	}
	return fmt.Errorf("llm: 流错误: %s", message)
}

// parseStreamError 解析 event: error 段的数据（可能是 JSON 或纯文本）。
func parseStreamError(data string) error {
	var body streamErrorBody
	if err := json.Unmarshal([]byte(data), &body); err == nil && body.Message != "" {
		return fmt.Errorf("llm: 流错误: %s", body.Message)
	}
	return fmt.Errorf("llm: 流错误: %s", strings.TrimSpace(data))
}

// onError 记录粘性错误并向熔断器上报终态（context 取消不算 provider 失败）。
func (s *sseStream) onError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reported {
		return
	}
	s.reported = true
	s.fatal = err
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		s.circuit.Release()
		return
	}
	s.circuit.ReportFailure()
}

// markDone 标记 [DONE] 并向熔断器上报成功。
func (s *sseStream) markDone() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.done = true
	if !s.reported {
		s.reported = true
		s.circuit.ReportSuccess()
	}
}

// Close 终止流（取消在途请求并关闭响应体）；可重复调用，可与 Next 并发。
func (s *sseStream) Close() error {
	s.mu.Lock()
	s.cancel()
	body := s.body
	s.body = nil
	if !s.reported {
		s.reported = true
		s.circuit.Release()
	}
	s.mu.Unlock()
	if body == nil {
		return nil
	}
	return body.Close()
}
