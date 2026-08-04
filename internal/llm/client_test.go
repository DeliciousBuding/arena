package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCompleteRequestShape(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("[DONE]")})
	})
	req := fp.req()
	req.Model.BaseURL = strings.TrimSuffix(fp.srv.URL, "/") + "/" // 带尾斜杠的 baseURL
	req.Temperature = 0.7
	req.MaxTokens = 512
	req.Messages = []Message{
		{Role: "system", Content: "你是策略助手"},
		{Role: "user", Content: "hi"},
		{Role: "assistant", ToolCalls: []ToolCall{{
			ID: "call_1", Type: "function",
			Function: ToolCallFunction{Name: "arena_plan", Arguments: `{"a":1}`},
		}}},
		{Role: "tool", ToolCallID: "call_1", Content: `{"ok":true}`},
	}
	stream, err := fp.newClient(nil).Complete(context.Background(), req)
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 [DONE] 后 io.EOF，得到 %v", err)
	}
	stream.Close()

	got := fp.takeRequests()
	if len(got) != 1 {
		t.Fatalf("请求数 = %d, want 1", len(got))
	}
	r := got[0]
	if r.method != http.MethodPost {
		t.Errorf("method = %q, want POST", r.method)
	}
	if r.path != "/chat/completions" {
		t.Errorf("path = %q, want /chat/completions（尾斜杠 baseURL 应被 JoinPath 处理）", r.path)
	}
	if r.auth != "Bearer test-key-12345" {
		t.Errorf("Authorization = %q, want Bearer test-key-12345", r.auth)
	}
	if r.contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", r.contentType)
	}
	if r.accept != "text/event-stream" {
		t.Errorf("Accept = %q, want text/event-stream", r.accept)
	}
	var body completionBody
	if err := json.Unmarshal(r.body, &body); err != nil {
		t.Fatalf("请求体解析失败: %v", err)
	}
	if body.Model != "fake-model" {
		t.Errorf("body.Model = %q, want fake-model", body.Model)
	}
	if !body.Stream {
		t.Error("body.Stream 应为 true（客户端恒流式）")
	}
	if body.Temperature == nil || *body.Temperature != 0.7 {
		t.Errorf("temperature = %v, want 0.7", body.Temperature)
	}
	if body.MaxTokens == nil || *body.MaxTokens != 512 {
		t.Errorf("max_tokens = %v, want 512", body.MaxTokens)
	}
	if len(body.Messages) != 4 {
		t.Fatalf("messages 数量 = %d, want 4", len(body.Messages))
	}
	if body.Messages[2].Role != "assistant" || len(body.Messages[2].ToolCalls) != 1 ||
		body.Messages[2].ToolCalls[0].Function.Name != "arena_plan" {
		t.Errorf("assistant tool_calls 未按 wire 格式序列化: %+v", body.Messages[2])
	}
	if body.Messages[3].Role != "tool" || body.Messages[3].ToolCallID != "call_1" {
		t.Errorf("tool 消息未按 wire 格式序列化: %+v", body.Messages[3])
	}
}

func TestHTTPErrorClassification(t *testing.T) {
	t.Parallel()
	table := []struct {
		name      string
		status    int
		body      string
		wantKind  ErrorKind
		wantCode  string
		wantMsg   string
		retryable bool
	}{
		{"401", 401, `{"error":{"message":"Unauthorized","type":"invalid_request_error"}}`,
			KindAuth, "invalid_request_error", "Unauthorized", false},
		{"429", 429, `{"error":{"message":"rate limited","type":"rate_limit_error","code":"insufficient_quota"}}`,
			KindRateLimit, "insufficient_quota", "rate limited", true},
		{"500", 500, `{"error":{"message":"boom","type":"server_error"}}`,
			KindServer, "server_error", "boom", true},
	}
	for _, tc := range table {
		t.Run(tc.name, func(t *testing.T) {
			fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			})
			_, err := fp.newClient(nil).Complete(context.Background(), fp.req())
			if err == nil {
				t.Fatal("期望错误，得到 nil")
			}
			he, ok := AsHTTPError(err)
			if !ok {
				t.Fatalf("期望 HTTPError，得到 %T: %v", err, err)
			}
			if he.StatusCode != tc.status {
				t.Errorf("StatusCode = %d, want %d", he.StatusCode, tc.status)
			}
			if he.Error != tc.wantCode {
				t.Errorf("Error = %q, want %q", he.Error, tc.wantCode)
			}
			if he.Message != tc.wantMsg {
				t.Errorf("Message = %q, want %q", he.Message, tc.wantMsg)
			}
			if got := KindOf(err); got != tc.wantKind {
				t.Errorf("KindOf = %q, want %q", got, tc.wantKind)
			}
			if got := IsRetryable(err); got != tc.retryable {
				t.Errorf("IsRetryable = %v, want %v", got, tc.retryable)
			}
		})
	}
}

func TestHTTPErrorBodyVariants(t *testing.T) {
	t.Parallel()
	t.Run("字符串 error 字段", func(t *testing.T) {
		fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(502)
			io.WriteString(w, `{"error":"bad gateway upstream"}`)
		})
		_, err := fp.newClient(nil).Complete(context.Background(), fp.req())
		he, ok := AsHTTPError(err)
		if !ok || he.Error != "bad gateway upstream" {
			t.Fatalf("期望 Error 取自字符串 error 字段，得到 %v", err)
		}
	})
	t.Run("非 JSON 响应体", func(t *testing.T) {
		fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(503)
			io.WriteString(w, "service unavailable")
		})
		_, err := fp.newClient(nil).Complete(context.Background(), fp.req())
		he, ok := AsHTTPError(err)
		if !ok || !strings.Contains(he.Message, "service unavailable") {
			t.Fatalf("期望 Message 含原始响应体，得到 %v", err)
		}
	})
}

func TestRetry429ThenSuccess(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	attempt := 0
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempt++
		shouldRetry := attempt <= 2
		mu.Unlock()
		if shouldRetry {
			w.WriteHeader(429)
			io.WriteString(w, `{"error":{"message":"slow down"}}`)
			return
		}
		writeSSE(w, []string{sseData("[DONE]")})
	})
	stream, err := fp.newClient(func(o *Options) { o.MaxAttempts = 3 }).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("429 重试后应成功: %v", err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 io.EOF: %v", err)
	}
	stream.Close()
	if got := len(fp.takeRequests()); got != 3 {
		t.Fatalf("请求数 = %d, want 3（两次 429 后成功）", got)
	}
}

func TestRetry500ThenSuccess(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	attempt := 0
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempt++
		shouldRetry := attempt <= 1
		mu.Unlock()
		if shouldRetry {
			w.WriteHeader(500)
			io.WriteString(w, `{"error":{"message":"boom"}}`)
			return
		}
		writeSSE(w, []string{sseData("[DONE]")})
	})
	stream, err := fp.newClient(func(o *Options) { o.MaxAttempts = 3 }).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("500 重试后应成功: %v", err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 io.EOF: %v", err)
	}
	stream.Close()
	if got := len(fp.takeRequests()); got != 2 {
		t.Fatalf("请求数 = %d, want 2（一次 500 后成功）", got)
	}
}

func TestRetryExhaustedOn500(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	})
	_, err := fp.newClient(func(o *Options) { o.MaxAttempts = 3 }).Complete(context.Background(), fp.req())
	he, ok := AsHTTPError(err)
	if !ok || he.StatusCode != 500 {
		t.Fatalf("重试耗尽后应返回 500 HTTPError，得到 %v", err)
	}
	if got := len(fp.takeRequests()); got != 3 {
		t.Fatalf("请求数 = %d, want 3（重试耗尽）", got)
	}
}

func TestNoRetryOn400(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		io.WriteString(w, `{"error":{"message":"bad request"}}`)
	})
	_, err := fp.newClient(func(o *Options) { o.MaxAttempts = 3 }).Complete(context.Background(), fp.req())
	if err == nil {
		t.Fatal("期望错误")
	}
	if got := KindOf(err); got != KindHTTP {
		t.Fatalf("KindOf = %q, want http", got)
	}
	if got := len(fp.takeRequests()); got != 1 {
		t.Fatalf("400 不应重试，请求数 = %d, want 1", got)
	}
}

func TestRetryNetworkError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	baseURL := srv.URL
	srv.Close() // 连接被拒

	transport := &countingTransport{rt: http.DefaultTransport}
	client := New(Options{
		APIKey:      "test-key-12345",
		HTTPClient:  &http.Client{Transport: transport},
		MaxAttempts: 3,
		Sleep:       noSleep,
	})
	req := ChatRequest{
		Model:    Model{ID: "fake-model", BaseURL: baseURL},
		Messages: []Message{{Role: "user", Content: "hi"}},
	}
	_, err := client.Complete(context.Background(), req)
	if err == nil {
		t.Fatal("期望网络错误")
	}
	if got := KindOf(err); got != KindNetwork {
		t.Fatalf("KindOf = %q, want network", got)
	}
	if got := transport.Count(); got != 3 {
		t.Fatalf("尝试次数 = %d, want 3", got)
	}
}

func TestPreCanceledContext(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("[DONE]")})
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := fp.newClient(nil).Complete(ctx, fp.req())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("期望 context.Canceled，得到 %v", err)
	}
	if got := KindOf(err); got != KindCanceled {
		t.Fatalf("KindOf = %q, want canceled", got)
	}
	if got := len(fp.takeRequests()); got != 0 {
		t.Fatalf("取消后不应发起请求，得到 %d", got)
	}
}

func TestCancelDuringBackoff(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	})
	client := fp.newClient(func(o *Options) {
		o.MaxAttempts = 3
		o.Sleep = func(ctx context.Context, d time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() {
		_, err := client.Complete(ctx, fp.req())
		done <- err
	}()
	<-fp.requests // 第一次 500 已响应，客户端进入退避
	cancel()
	err := <-done
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("退避期间取消应返回 context.Canceled，得到 %v", err)
	}
	if got := len(fp.takeRequests()); got != 0 {
		t.Fatalf("取消后不应重试，得到 %d 个请求", got)
	}
}

func TestValidationErrors(t *testing.T) {
	t.Parallel()
	client := New(Options{APIKey: "test-key-12345"})
	table := []struct {
		name string
		req  ChatRequest
	}{
		{"空模型 ID", ChatRequest{Model: Model{BaseURL: "http://x"}, Messages: []Message{{Role: "user"}}}},
		{"空 baseURL", ChatRequest{Model: Model{ID: "m"}, Messages: []Message{{Role: "user"}}}},
		{"空 messages", ChatRequest{Model: Model{ID: "m", BaseURL: "http://x"}}},
		{"非法 role", ChatRequest{Model: Model{ID: "m", BaseURL: "http://x"}, Messages: []Message{{Role: "system2"}}}},
	}
	for _, tc := range table {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := client.Complete(context.Background(), tc.req); err == nil {
				t.Fatal("期望校验错误，得到 nil")
			}
		})
	}
}

func TestCircuitIntegrationOpenAfterThreeFailures(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	circuit := NewCircuit(CircuitOptions{Now: clock.Now})
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	})
	client := fp.newClient(func(o *Options) { o.Circuit = circuit })
	for i := 0; i < 3; i++ {
		if _, err := client.Complete(context.Background(), fp.req()); err == nil {
			t.Fatalf("第 %d 次调用应失败", i+1)
		}
	}
	if got := circuit.State(); got != StateOpen {
		t.Fatalf("3 连败后 State = %v, want open", got)
	}
	_, err := client.Complete(context.Background(), fp.req())
	if !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("熔断后应返回 ErrCircuitOpen，得到 %v", err)
	}
	if got := len(fp.takeRequests()); got != 3 {
		t.Fatalf("熔断后不应发网络请求，请求数 = %d, want 3", got)
	}
}

func TestCircuitIntegrationHalfOpenProbeSuccess(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	circuit := NewCircuit(CircuitOptions{Now: clock.Now})
	bad := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	})
	badClient := bad.newClient(func(o *Options) { o.Circuit = circuit })
	for i := 0; i < 3; i++ {
		badClient.Complete(context.Background(), bad.req())
	}
	if got := circuit.State(); got != StateOpen {
		t.Fatalf("前置条件失败: State = %v", got)
	}
	clock.Advance(31 * time.Second) // 冷却结束

	ok := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("[DONE]")})
	})
	okClient := ok.newClient(func(o *Options) { o.Circuit = circuit })
	stream, err := okClient.Complete(context.Background(), ok.req())
	if err != nil {
		t.Fatalf("half-open 探测应放行: %v", err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 io.EOF: %v", err)
	}
	stream.Close()
	if got := circuit.State(); got != StateClosed {
		t.Fatalf("探测成功后 State = %v, want closed", got)
	}
}

func TestCircuitIntegrationHalfOpenProbeFailureReopens(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	circuit := NewCircuit(CircuitOptions{Now: clock.Now})
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		io.WriteString(w, `{"error":{"message":"boom"}}`)
	})
	client := fp.newClient(func(o *Options) { o.Circuit = circuit })
	for i := 0; i < 3; i++ {
		client.Complete(context.Background(), fp.req())
	}
	clock.Advance(31 * time.Second)
	_, err := client.Complete(context.Background(), fp.req())
	if err == nil {
		t.Fatal("探测调用应失败")
	}
	if got := circuit.State(); got != StateOpen {
		t.Fatalf("探测失败后 State = %v, want open", got)
	}
}

func TestCircuitIntegrationMidStreamFailuresTrip(t *testing.T) {
	t.Parallel()
	clock := newFakeClock()
	circuit := NewCircuit(CircuitOptions{Now: clock.Now})
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		// 中段断流：声明长 Content-Length 但只写一小段
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", "9999")
		io.WriteString(w, sseData(`{"choices":[{"delta":{"content":"partial"}}]}`))
	})
	client := fp.newClient(func(o *Options) { o.Circuit = circuit })
	for i := 0; i < 3; i++ {
		stream, err := client.Complete(context.Background(), fp.req())
		if err != nil {
			t.Fatalf("第 %d 次建立流失败: %v", i+1, err)
		}
		sawError := false
		for {
			_, err := stream.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				sawError = true
				break
			}
		}
		if !sawError {
			t.Fatalf("第 %d 次流应中段报错", i+1)
		}
		stream.Close()
	}
	if got := circuit.State(); got != StateOpen {
		t.Fatalf("3 次中段断流后 State = %v, want open", got)
	}
}
