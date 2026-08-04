package llm

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestStreamTextAggregation(t *testing.T) {
	t.Parallel()
	events := []string{
		contentEvent("Hello", ""),
		contentEvent(", ", ""),
		contentEvent("world", ""),
		contentEvent("", "stop"),
		sseData("[DONE]"),
	}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	var got strings.Builder
	finishSeen := ""
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next 失败: %v", err)
		}
		got.WriteString(chunk.Delta.Content)
		if chunk.FinishReason != "" {
			if finishSeen != "" {
				t.Fatalf("finish_reason 出现多次: %q / %q", finishSeen, chunk.FinishReason)
			}
			finishSeen = chunk.FinishReason
		}
	}
	if got.String() != "Hello, world" {
		t.Fatalf("聚合文本 = %q, want %q", got.String(), "Hello, world")
	}
	if finishSeen != "stop" {
		t.Fatalf("finish_reason = %q, want stop", finishSeen)
	}
}

func TestStreamToolCallDeltaConcatenation(t *testing.T) {
	t.Parallel()
	events := []string{
		toolCallEvent(t, 0, "call_abc", "get_weather", `{"city":"`),
		toolCallEvent(t, 0, "", "", `Shenzhen`),
		toolCallEvent(t, 0, "", "", `"}`),
		contentEvent("", "tool_calls"),
		sseData("[DONE]"),
	}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	var last ToolCall
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next 失败: %v", err)
		}
		if len(chunk.Delta.ToolCalls) > 0 {
			last = chunk.Delta.ToolCalls[0]
		}
	}
	if last.ID != "call_abc" {
		t.Errorf("ID = %q, want call_abc", last.ID)
	}
	if last.Function.Name != "get_weather" {
		t.Errorf("Name = %q, want get_weather", last.Function.Name)
	}
	if want := `{"city":"Shenzhen"}`; last.Function.Arguments != want {
		t.Errorf("Arguments = %q, want %q", last.Function.Arguments, want)
	}
}

func TestStreamMultipleToolCallsInterleaved(t *testing.T) {
	t.Parallel()
	events := []string{
		toolCallEvent(t, 0, "call_0", "fn_a", `{"a":`),
		toolCallEvent(t, 1, "call_1", "fn_b", `{"b":`),
		toolCallEvent(t, 0, "", "", `1}`),
		toolCallEvent(t, 1, "", "", `2}`),
		sseData("[DONE]"),
	}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	var calls []ToolCall
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next 失败: %v", err)
		}
		if len(chunk.Delta.ToolCalls) > 0 {
			calls = chunk.Delta.ToolCalls
		}
	}
	if len(calls) != 2 {
		t.Fatalf("工具调用数 = %d, want 2", len(calls))
	}
	if calls[0].Index != 0 || calls[0].Function.Arguments != `{"a":1}` {
		t.Errorf("calls[0] = %+v", calls[0])
	}
	if calls[1].Index != 1 || calls[1].Function.Arguments != `{"b":2}` {
		t.Errorf("calls[1] = %+v", calls[1])
	}
}

func TestStreamDoneOnly(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("[DONE]")})
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("空流 Next = %v, want io.EOF", err)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("重复 Next = %v, want io.EOF", err)
	}
}

func TestStreamErrorEvent(t *testing.T) {
	t.Parallel()
	events := []string{
		contentEvent("partial", ""),
		sseEvent("error", `{"error":{"message":"上游故障","type":"server_error"}}`),
	}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	chunk, err := stream.Next()
	if err != nil {
		t.Fatalf("首个事件读取失败: %v", err)
	}
	if chunk.Delta.Content != "partial" {
		t.Fatalf("内容 = %q, want partial", chunk.Delta.Content)
	}
	_, err = stream.Next()
	if err == nil {
		t.Fatal("错误段应上抛")
	}
	if kind := KindOf(err); kind != KindStream {
		t.Fatalf("错误段 KindOf = %q, want stream", kind)
	}
	if !strings.Contains(err.Error(), "上游故障") {
		t.Fatalf("错误信息 = %q, want 含服务端消息", err.Error())
	}
	if _, err2 := stream.Next(); err2 == nil || !strings.Contains(err2.Error(), "上游故障") {
		t.Fatalf("错误应为粘性，第二次 Next = %v", err2)
	}
}

func TestStreamErrorDataObject(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData(`{"error":{"message":"rate limited","code":"rate_limit_exceeded"}}`)})
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()
	_, err = stream.Next()
	if err == nil {
		t.Fatal("data 中的 error 对象应上抛")
	}
	if kind := KindOf(err); kind != KindStream {
		t.Fatalf("KindOf = %q, want stream", kind)
	}
	if !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("错误信息 = %q, want 含 message", err.Error())
	}
}

func TestStreamErrorEventRawText(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseEvent("error", "raw failure text")})
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()
	_, err = stream.Next()
	if err == nil || !strings.Contains(err.Error(), "raw failure text") {
		t.Fatalf("非 JSON 错误段应透传原文，得到 %v", err)
	}
}

func TestStreamUsageChunk(t *testing.T) {
	t.Parallel()
	events := []string{
		contentEvent("hi", ""),
		sseData(`{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}`),
		sseData("[DONE]"),
	}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	var usage *Usage
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next 失败: %v", err)
		}
		if chunk.Usage != nil {
			usage = chunk.Usage
		}
	}
	if usage == nil {
		t.Fatal("未收到 usage 段")
	}
	if usage.PromptTokens != 10 || usage.CompletionTokens != 20 || usage.TotalTokens != 30 {
		t.Fatalf("usage = %+v, want 10/20/30", usage)
	}
}

func TestSSECommentsAndCRLF(t *testing.T) {
	t.Parallel()
	raw := ": ping keep-alive\r\n\r\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n\r\n" +
		": 注释行混在事件之间\r\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\r\n\r\n" +
		"data: [DONE]\r\n" // 末行无空行直接断流
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, raw)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	var got strings.Builder
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("Next 失败: %v", err)
		}
		got.WriteString(chunk.Delta.Content)
	}
	if got.String() != "ab" {
		t.Fatalf("聚合文本 = %q, want ab（注释/CRLF 不应干扰）", got.String())
	}
}

func TestSSEMultiLineData(t *testing.T) {
	t.Parallel()
	// 两条 data 行按 SSE 规范以 \n 拼接后整体 JSON 解析。
	// 注意：拼接后的 data 必须仍是合法 JSON（字符串内不能有真实换行）。
	raw := "data: {\"choices\":" + "\n" +
		"data: [{\"delta\":{\"content\":\"ab\"}}]}\n\n" +
		sseData("[DONE]")
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, raw)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	chunk, err := stream.Next()
	if err != nil {
		t.Fatalf("Next 失败: %v", err)
	}
	if chunk.Delta.Content != "ab" {
		t.Fatalf("多行 data 拼接内容 = %q, want %q", chunk.Delta.Content, "ab")
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 io.EOF，得到 %v", err)
	}
}

func TestMalformedSSEData(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("this is not json")})
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()
	_, err = stream.Next()
	if err == nil {
		t.Fatal("畸形 data 应报错")
	}
	if kind := KindOf(err); kind != KindStream {
		t.Fatalf("KindOf = %q, want stream", kind)
	}
}

func TestCleanEOFWithoutDone(t *testing.T) {
	t.Parallel()
	// 兼容不发 [DONE] 即关流的 provider
	events := []string{contentEvent("hi", ""), contentEvent("", "stop")}
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, events)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	chunks := 0
	for {
		chunk, err := stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("干净关流不应报错: %v", err)
		}
		chunks++
		if chunk.FinishReason != "" && chunk.FinishReason != "stop" {
			t.Fatalf("finish_reason = %q", chunk.FinishReason)
		}
	}
	if chunks != 2 {
		t.Fatalf("chunk 数 = %d, want 2", chunks)
	}
}

func TestCleanEOFWithPendingLine(t *testing.T) {
	t.Parallel()
	// 最后一条事件无空行即断流：应处理残余行后正常结束
	raw := "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n"
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, raw)
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()
	chunk, err := stream.Next()
	if err != nil {
		t.Fatalf("残余行应被处理: %v", err)
	}
	if chunk.Delta.Content != "x" {
		t.Fatalf("内容 = %q, want x", chunk.Delta.Content)
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("期望 io.EOF，得到 %v", err)
	}
}

func TestMidStreamTruncationClassified(t *testing.T) {
	t.Parallel()
	// 声明 Content-Length 但只写一部分 → 服务器中断连接 → 客户端读错误
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", "9999")
		io.WriteString(w, sseData(`{"choices":[{"delta":{"content":"partial"}}]}`))
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("建立流失败: %v", err)
	}
	defer stream.Close()

	var got strings.Builder
	for {
		chunk, err := stream.Next()
		if err == nil {
			got.WriteString(chunk.Delta.Content)
			continue
		}
		if errors.Is(err, io.EOF) {
			t.Fatalf("中段断流不应以 io.EOF 结束（已聚合 %q）", got.String())
		}
		if kind := KindOf(err); kind != KindNetwork {
			t.Fatalf("中段断流 KindOf = %q, want network（已聚合 %q）", kind, got.String())
		}
		break
	}
	if got.String() != "partial" {
		t.Fatalf("断流前聚合文本 = %q, want partial", got.String())
	}
}

func TestMidStreamResetRSTClassified(t *testing.T) {
	t.Parallel()
	// 真实 RST：SO_LINGER=0 后关闭连接。
	// RST 可能出现在响应头读取前（Complete 直接失败）或流中（Next 失败），
	// 两条路径都必须分类为 network。
	srv := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Error("Hijack 不可用")
			return
		}
		conn, buf, err := hijacker.Hijack()
		if err != nil {
			t.Errorf("Hijack 失败: %v", err)
			return
		}
		defer conn.Close()
		io.WriteString(buf, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
		io.WriteString(buf, sseData(`{"choices":[{"delta":{"content":"partial"}}]}`))
		buf.Flush()
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetLinger(0) // 立即 RST
		}
	})
	stream, err := srv.newClient(nil).Complete(context.Background(), srv.req())

	var gotErr error
	if err != nil {
		gotErr = err // RST 在响应头到达前生效
	} else {
		defer stream.Close()
		for {
			chunk, err := stream.Next()
			if err != nil {
				if errors.Is(err, io.EOF) {
					t.Fatalf("RST 断流不应以 io.EOF 结束（已收到 %q）", chunk.Delta.Content)
				}
				gotErr = err
				break
			}
		}
	}
	if gotErr == nil {
		t.Fatal("未收到断流错误")
	}
	if kind := KindOf(gotErr); kind != KindNetwork {
		t.Fatalf("RST 断流 KindOf = %q, want network", kind)
	}
}

func TestStreamCloseIdempotent(t *testing.T) {
	t.Parallel()
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		writeSSE(w, []string{sseData("[DONE]")})
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("首次 Close 失败: %v", err)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("重复 Close 失败: %v", err)
	}
	if _, err := stream.Next(); err == nil {
		t.Fatal("Close 后 Next 应返回错误")
	}
}

func TestStreamCloseMidStream(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	defer close(release) // defer 先于 t.Cleanup 执行，避免 srv.Close 阻塞在活跃连接上
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		io.WriteString(w, sseData(`{"choices":[{"delta":{"content":"a"}}]}`))
		if flusher != nil {
			flusher.Flush()
		}
		<-release // 挂起连接
	})
	stream, err := fp.newClient(nil).Complete(context.Background(), fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	if _, err := stream.Next(); err != nil {
		t.Fatalf("首块读取失败: %v", err)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("Close 失败: %v", err)
	}
	if _, err := stream.Next(); err == nil {
		t.Fatal("Close 后 Next 应返回错误")
	}
}

func TestAbortCancelsStreamFast(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	defer close(release) // defer 先于 t.Cleanup 执行，避免 srv.Close 阻塞在活跃连接上
	fp := newFakeProvider(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		io.WriteString(w, sseData(`{"choices":[{"delta":{"content":"a"}}]}`))
		if flusher != nil {
			flusher.Flush()
		}
		<-release // 挂起连接，模拟慢速 provider
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	stream, err := fp.newClient(nil).Complete(ctx, fp.req())
	if err != nil {
		t.Fatalf("Complete 失败: %v", err)
	}
	defer stream.Close()

	chunk, err := stream.Next()
	if err != nil {
		t.Fatalf("首块读取失败: %v", err)
	}
	if chunk.Delta.Content != "a" {
		t.Fatalf("首块内容 = %q, want a", chunk.Delta.Content)
	}
	cancel()
	start := time.Now()
	_, abortErr := stream.Next()
	if abortErr == nil {
		t.Fatal("取消后 Next 应返回错误")
	}
	if elapsed := time.Since(start); elapsed >= 100*time.Millisecond {
		t.Fatalf("取消后流关闭耗时 %v, want < 100ms", elapsed)
	}
	if kind := KindOf(abortErr); kind != KindCanceled && kind != KindNetwork {
		t.Fatalf("abort 错误分类 = %q, want canceled 或 network", kind)
	}
}
