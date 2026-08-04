package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// capturedRequest 记录 fake provider 收到的单个请求。
type capturedRequest struct {
	method      string
	path        string
	auth        string
	contentType string
	accept      string
	body        []byte
}

// fakeProvider 是 OpenAI-completions 的 httptest fake（外部边界，允许 mock）。
// 除响应逻辑外，还会捕获每个请求的报文供测试断言。
type fakeProvider struct {
	t        *testing.T
	srv      *httptest.Server
	requests chan capturedRequest
}

func newFakeProvider(t *testing.T, respond func(w http.ResponseWriter, r *http.Request)) *fakeProvider {
	t.Helper()
	fp := &fakeProvider{t: t, requests: make(chan capturedRequest, 32)}
	fp.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("读取请求体失败: %v", err)
		}
		fp.requests <- capturedRequest{
			method:      r.Method,
			path:        r.URL.Path,
			auth:        r.Header.Get("Authorization"),
			contentType: r.Header.Get("Content-Type"),
			accept:      r.Header.Get("Accept"),
			body:        body,
		}
		respond(w, r)
	}))
	t.Cleanup(fp.srv.Close)
	return fp
}

// newClient 构建指向 fake provider 的客户端（默认单次尝试、退避等待为 no-op）。
func (fp *fakeProvider) newClient(mut func(*Options)) *Client {
	fp.t.Helper()
	opts := Options{
		APIKey:      "test-key-12345",
		HTTPClient:  fp.srv.Client(),
		MaxAttempts: 1,
		Sleep:       noSleep,
	}
	if mut != nil {
		mut(&opts)
	}
	return New(opts)
}

// req 构造一个指向 fake provider 的默认请求。
func (fp *fakeProvider) req() ChatRequest {
	fp.t.Helper()
	return ChatRequest{
		Model: Model{
			Provider:  "fake",
			ID:        "fake-model",
			BaseURL:   fp.srv.URL,
			MaxTokens: 4096,
			Compat:    "openai-completions",
		},
		Messages: []Message{{Role: "user", Content: "hello"}},
	}
}

// takeRequests 非阻塞地取回已捕获的请求。
func (fp *fakeProvider) takeRequests() []capturedRequest {
	fp.t.Helper()
	var out []capturedRequest
	for {
		select {
		case req := <-fp.requests:
			out = append(out, req)
		default:
			return out
		}
	}
}

// writeSSE 按给定事件序列写 SSE 响应并逐条 flush。
func writeSSE(w http.ResponseWriter, events []string) {
	w.Header().Set("Content-Type", "text/event-stream")
	flusher, _ := w.(http.Flusher)
	for _, event := range events {
		io.WriteString(w, event)
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func sseData(data string) string {
	return "data: " + data + "\n\n"
}

func sseEvent(event, data string) string {
	return "event: " + event + "\ndata: " + data + "\n\n"
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// contentEvent 构造一个文本 delta 事件。
func contentEvent(text, finishReason string) string {
	return sseData(fmt.Sprintf(`{"choices":[{"delta":{"content":%s},"finish_reason":%s}]}`,
		jsonStr(text), jsonStr(finishReason)))
}

// toolCallEvent 构造一个工具调用 delta 事件。
func toolCallEvent(t *testing.T, index int, id, name, arguments string) string {
	t.Helper()
	payload := struct {
		Choices []struct {
			Delta Delta `json:"delta"`
		} `json:"choices"`
	}{Choices: []struct {
		Delta Delta `json:"delta"`
	}{{
		Delta: Delta{ToolCalls: []ToolCall{{
			Index:    index,
			ID:       id,
			Type:     "function",
			Function: ToolCallFunction{Name: name, Arguments: arguments},
		}}},
	}}}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("toolCallEvent 序列化失败: %v", err)
	}
	return sseData(string(data))
}

// countingTransport 统计 RoundTrip 调用次数（用于重试/无重试断言）。
type countingTransport struct {
	rt    http.RoundTripper
	mu    sync.Mutex
	count int
}

func (ct *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ct.mu.Lock()
	ct.count++
	ct.mu.Unlock()
	return ct.rt.RoundTrip(req)
}

func (ct *countingTransport) Count() int {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	return ct.count
}

func noSleep(ctx context.Context, d time.Duration) error { return nil }
