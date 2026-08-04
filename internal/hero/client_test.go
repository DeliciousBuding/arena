package hero

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// 测试统一使用假密钥（不落盘、不进日志；真密钥只从 env 读）。
const testAPIKey = "test-api-key-0123456789"

// ---- 消息构造（与服务器 wire 格式一致） ----

func tickMessage(tick int) []byte {
	return []byte(fmt.Sprintf(`{"type":"tick","data":%d}`, tick))
}

func stateMessage(tick int, resources int) []byte {
	payload := fmt.Sprintf(`{"status":"ACTIVE","resources":%d,"population":0,"population_tier":1,`+
		`"upkeep_next_tick":0,"champion_beacon":{"position":[%d,%d]},"objects":[],"events":[]}`,
		resources, tick, tick)
	return []byte(fmt.Sprintf(`{"type":"state","data":%s}`, payload))
}

func receivedMessage(tick int) []byte {
	return []byte(fmt.Sprintf(`{"type":"received","data":{"tick":%d,"source":"AGENT",`+
		`"received_at":"2026-08-05T00:00:00Z","plan":{"tick":%d,"unit_actions":{}}}}`, tick, tick))
}

// ---- fake WS server（黑盒外部边界：httptest + coder/websocket Accept） ----

type fakeWSServer struct {
	t            *testing.T
	apiKey       string
	onConn       func(t *testing.T, index int, conn *websocket.Conn)
	mu           sync.Mutex
	conns        int
	authFailures int
	srv          *httptest.Server
	done         chan struct{}
}

// newFakeWSServer 启动 fake WS server：握手校验 Authorization header
// （不匹配 → 401，计数 authFailures）；每次成功连接按序号调用 onConn。
func newFakeWSServer(t *testing.T, apiKey string, onConn func(t *testing.T, index int, conn *websocket.Conn)) *fakeWSServer {
	fs := &fakeWSServer{t: t, apiKey: apiKey, onConn: onConn, done: make(chan struct{})}
	fs.srv = httptest.NewServer(http.HandlerFunc(fs.serveHTTP))
	t.Cleanup(func() {
		close(fs.done)
		fs.srv.Close()
	})
	return fs
}

func (fs *fakeWSServer) url() string { return fs.srv.URL }

func (fs *fakeWSServer) connectionCount() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.conns
}

func (fs *fakeWSServer) authFailureCount() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.authFailures
}

func (fs *fakeWSServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+fs.apiKey {
		fs.mu.Lock()
		fs.authFailures++
		fs.mu.Unlock()
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		fs.t.Logf("fake ws accept: %v", err)
		return
	}
	fs.mu.Lock()
	fs.conns++
	index := fs.conns
	fs.mu.Unlock()
	go fs.runConn(index, conn)
}

// runConn 执行该连接的脚本，然后保持连接直到对端关闭或测试结束。
func (fs *fakeWSServer) runConn(index int, conn *websocket.Conn) {
	defer conn.CloseNow()
	if fs.onConn != nil {
		fs.onConn(fs.t, index, conn)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, _, _ = conn.Read(ctx)
}

func wsWrite(t *testing.T, conn *websocket.Conn, message []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, message); err != nil {
		t.Errorf("fake ws write: %v", err)
	}
}

// ---- fake command server（POST /api/v1/game/commands） ----

const acceptedBody = `{"accepted":true,"tick":7,"source":"AGENT","received_at":"2026-08-05T00:00:00Z"}`

type fakeCommandServer struct {
	t        *testing.T
	apiKey   string
	statuses []int
	mu       sync.Mutex
	requests int
	lastHdr  http.Header
	lastBody []byte
	srv      *httptest.Server
}

func newFakeCommandServer(t *testing.T, apiKey string, statuses ...int) *fakeCommandServer {
	fs := &fakeCommandServer{t: t, apiKey: apiKey, statuses: statuses}
	fs.srv = httptest.NewServer(http.HandlerFunc(fs.serveHTTP))
	t.Cleanup(fs.srv.Close)
	return fs
}

func (fs *fakeCommandServer) url() string { return fs.srv.URL }

func (fs *fakeCommandServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	fs.mu.Lock()
	fs.requests++
	index := (fs.requests - 1) % len(fs.statuses)
	status := fs.statuses[index]
	body, _ := io.ReadAll(r.Body)
	fs.lastHdr = r.Header.Clone()
	fs.lastBody = body
	fs.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	switch status {
	case http.StatusAccepted:
		fmt.Fprint(w, acceptedBody)
	case http.StatusInternalServerError:
		fmt.Fprint(w, `{"error":"INVALID_PLAN","message":"bad plan","plan_tick":7}`)
	default:
		fmt.Fprint(w, `{"error":"upstream"}`)
	}
}

func (fs *fakeCommandServer) requestCount() int {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.requests
}

func (fs *fakeCommandServer) lastHeaders() http.Header {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.lastHdr.Clone()
}

// ---- 测试基建 ----

func testConfig(baseURL string) Config {
	return Config{
		BaseURL:           baseURL,
		APIKey:            testAPIKey,
		RequestTimeout:    2 * time.Second,
		RequestRetries:    2,
		ReconnectMinDelay: 10 * time.Millisecond,
		ReconnectMaxDelay: 50 * time.Millisecond,
		HandshakeTimeout:  2 * time.Second,
		MaxMessageSize:    1 << 20,
	}
}

func samplePlan(tick int) contracts.CommandPlan {
	return contracts.CommandPlan{
		Tick: tick,
		UnitActions: map[string]contracts.WireAction{
			"unit-1": {Type: string(contracts.WireUnitWait)},
		},
		CoreAction: &contracts.WireAction{Type: string(contracts.WireCoreWait)},
	}
}

func asError(err error, target any) bool {
	return errors.As(err, target)
}

func nextEvent(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case event, ok := <-ch:
		if !ok {
			t.Fatalf("event stream closed unexpectedly")
		}
		return event
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for event")
		return Event{}
	}
}

func waitStreamClosed(t *testing.T, ch <-chan Event) {
	t.Helper()
	select {
	case _, ok := <-ch:
		if ok {
			t.Fatalf("event stream should be closed")
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for event stream close")
	}
}

// assertNoGoroutineLeak 轮询直到 goroutine 数回到基线（配合 -race）。
func assertNoGoroutineLeak(t *testing.T, base int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		runtime.GC()
		if runtime.NumGoroutine() <= base {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("goroutine leak detected: base=%d now=%d", base, runtime.NumGoroutine())
}

// ---- 配置校验 ----

func TestNewClientRejectsInvalidAPIKey(t *testing.T) {
	for _, apiKey := range []string{"", "  ", "has space", "tab\tkey", "non-ascii-\u00e9"} {
		if _, err := NewClient(Config{APIKey: apiKey}); err == nil {
			t.Errorf("apiKey %q: expected ConfigurationError", apiKey)
		} else {
			var confErr *ConfigurationError
			if !asError(err, &confErr) {
				t.Errorf("apiKey %q: expected ConfigurationError, got %T", apiKey, err)
			}
		}
	}
}

func TestNewClientRejectsInvalidBaseURL(t *testing.T) {
	for _, baseURL := range []string{
		"ftp://api.arenahero.io",
		"file:///tmp/x",
		"https://user:pass@api.arenahero.io",
		"https://api.arenahero.io?query=1",
		"https://api.arenahero.io#frag",
		"not-a-url",
	} {
		config := testConfig(baseURL)
		if _, err := NewClient(config); err == nil {
			t.Errorf("baseURL %q: expected ConfigurationError", baseURL)
		}
	}
}

func TestNewClientRejectsInvalidParameters(t *testing.T) {
	invalid := []Config{
		{APIKey: testAPIKey, RequestTimeout: -time.Second},
		{APIKey: testAPIKey, RequestRetries: -1},
		{APIKey: testAPIKey, ReconnectMinDelay: -time.Second},
		{APIKey: testAPIKey, ReconnectMaxDelay: time.Second, ReconnectMinDelay: 2 * time.Second},
		{APIKey: testAPIKey, HandshakeTimeout: -time.Second},
		{APIKey: testAPIKey, MaxMessageSize: -1},
	}
	for _, config := range invalid {
		if _, err := NewClient(config); err == nil {
			t.Errorf("config %+v: expected ConfigurationError", config)
		}
	}
}

func TestNewClientDerivesWebsocketURL(t *testing.T) {
	client, err := NewClient(testConfig("http://127.0.0.1:9999/base/path/"))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if want := "ws://127.0.0.1:9999/base/path/api/v1/game/ws"; client.wsURL != want {
		t.Errorf("wsURL = %q, want %q", client.wsURL, want)
	}
	if want := "http://127.0.0.1:9999/base/path/api/v1/game/commands"; client.commandURL != want {
		t.Errorf("commandURL = %q, want %q", client.commandURL, want)
	}

	client, err = NewClient(testConfig("https://api.arenahero.io"))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if want := "wss://api.arenahero.io/api/v1/game/ws"; client.wsURL != want {
		t.Errorf("wsURL = %q, want %q", client.wsURL, want)
	}
	if want := "https://api.arenahero.io/api/v1/game/commands"; client.commandURL != want {
		t.Errorf("commandURL = %q, want %q", client.commandURL, want)
	}
}

func TestDefaultConfigAppliesSDKDefaults(t *testing.T) {
	config := DefaultConfig(testAPIKey)
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient(DefaultConfig): %v", err)
	}
	if client.config.RequestTimeout != 5*time.Second ||
		client.config.RequestRetries != 2 ||
		client.config.ReconnectMinDelay != 250*time.Millisecond ||
		client.config.ReconnectMaxDelay != 5*time.Second ||
		client.config.HandshakeTimeout != 15*time.Second ||
		client.config.MaxMessageSize != 2*1024*1024 {
		t.Errorf("defaults not applied: %+v", client.config)
	}
}

// ---- 事件流 ----

func TestEventsParsesTickStateReceived(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(7))
		wsWrite(t, conn, stateMessage(7, 70))
		wsWrite(t, conn, receivedMessage(7))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	first := nextEvent(t, events)
	if first.Kind != TickEvent || first.Tick != 7 {
		t.Errorf("first event = %+v, want TickEvent tick=7", first)
	}
	second := nextEvent(t, events)
	if second.Kind != StateEvent || second.Tick != 7 || second.State.Resources != 70 {
		t.Errorf("second event = %+v, want StateEvent tick=7 resources=70", second)
	}
	third := nextEvent(t, events)
	if third.Kind != ReceivedEvent || third.Tick != 7 || third.Received.Source != contracts.CommandSourceAgent {
		t.Errorf("third event = %+v, want ReceivedEvent tick=7 AGENT", third)
	}

	cancel()
	waitStreamClosed(t, events)
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil", err)
	}
	if got := fs.connectionCount(); got != 1 {
		t.Errorf("connection count = %d, want 1", got)
	}
}

func TestEventsHandshakeRejectsBadAuthorization(t *testing.T) {
	fs := newFakeWSServer(t, "different-key-12345678", nil)
	config := testConfig(fs.url())
	config.APIKey = testAPIKey // 与服务器期望的 key 不匹配
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	waitStreamClosed(t, events)
	var authErr *AuthenticationError
	if !asError(client.Err(), &authErr) {
		t.Fatalf("Err() = %v, want AuthenticationError", client.Err())
	}
	if got := fs.authFailureCount(); got != 1 {
		t.Errorf("auth failures = %d, want 1", got)
	}
	if got := fs.connectionCount(); got != 0 {
		t.Errorf("connection count = %d, want 0 (no retry on 401)", got)
	}
}

func TestEventsReconnectsAfterAbruptClose(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		switch index {
		case 1:
			// 首连接：推 tick 后立即断线（1006），触发重连
			wsWrite(t, conn, tickMessage(1))
			conn.CloseNow()
		default:
			// 重连后：推新 tick 并保持连接
			wsWrite(t, conn, tickMessage(2))
		}
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	first := nextEvent(t, events)
	if first.Kind != TickEvent || first.Tick != 1 {
		t.Fatalf("first event = %+v, want tick=1", first)
	}
	second := nextEvent(t, events)
	if second.Kind != TickEvent || second.Tick != 2 {
		t.Fatalf("second event = %+v, want tick=2 (after reconnect)", second)
	}
	if got := fs.connectionCount(); got < 2 {
		t.Errorf("connection count = %d, want >= 2 (exponential backoff reconnect)", got)
	}
	cancel()
	waitStreamClosed(t, events)
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil", err)
	}
}

func TestEventsClose1000EndsStreamWithoutReconnect(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(5))
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	first := nextEvent(t, events)
	if first.Kind != TickEvent || first.Tick != 5 {
		t.Fatalf("first event = %+v, want tick=5", first)
	}
	waitStreamClosed(t, events)
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil for normal close 1000", err)
	}
	if got := fs.connectionCount(); got != 1 {
		t.Errorf("connection count = %d, want 1 (no reconnect on 1000)", got)
	}
}

func TestEventsClose1008PolicyViolationTerminates(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(5))
		_ = conn.Close(websocket.StatusPolicyViolation, "policy violation")
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	nextEvent(t, events)
	waitStreamClosed(t, events)
	var policyErr *PolicyViolationError
	if !asError(client.Err(), &policyErr) {
		t.Fatalf("Err() = %v, want PolicyViolationError", client.Err())
	}
	if got := fs.connectionCount(); got != 1 {
		t.Errorf("connection count = %d, want 1 (no reconnect on 1008)", got)
	}
}

func TestEventsProtocolErrorTerminatesWithoutReconnect(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, []byte(`{"type":"bogus","data":1}`))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	waitStreamClosed(t, events)
	var protoErr *ProtocolError
	if !asError(client.Err(), &protoErr) {
		t.Fatalf("Err() = %v, want ProtocolError", client.Err())
	}
	if got := fs.connectionCount(); got != 1 {
		t.Errorf("connection count = %d, want 1 (no reconnect on protocol error)", got)
	}
}

func TestEventsBinaryFrameIsProtocolError(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := conn.Write(ctx, websocket.MessageBinary, []byte("raw")); err != nil {
			t.Errorf("fake ws binary write: %v", err)
		}
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	waitStreamClosed(t, events)
	var protoErr *ProtocolError
	if !asError(client.Err(), &protoErr) {
		t.Fatalf("Err() = %v, want ProtocolError", client.Err())
	}
}

func TestEventsStateBeforeTickIsProtocolError(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, stateMessage(1, 10))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)

	waitStreamClosed(t, events)
	var protoErr *ProtocolError
	if !asError(client.Err(), &protoErr) {
		t.Fatalf("Err() = %v, want ProtocolError", client.Err())
	}
}

func TestEventsContextCancelEndsStreamWithoutLeak(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(3))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	events := client.Events(ctx)
	nextEvent(t, events)
	base := runtime.NumGoroutine()

	cancel()
	waitStreamClosed(t, events)
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil on ctx cancel", err)
	}
	assertNoGoroutineLeak(t, base)
	client.Close()
}

func TestEventsHandshakeTimeoutRetriesThenStopsWithoutLeak(t *testing.T) {
	// 原始 TCP 监听器：接受连接但永不完成 WS 握手（握手超时）。
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { listener.Close() })
	var accepts atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepts.Add(1)
			go func(conn net.Conn) {
				defer conn.Close()
				_, _ = io.Copy(io.Discard, conn)
			}(conn)
		}
	}()

	config := testConfig("http://" + listener.Addr().String())
	config.HandshakeTimeout = 50 * time.Millisecond
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	base := runtime.NumGoroutine()
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	events := client.Events(ctx)

	waitStreamClosed(t, events)
	if got := accepts.Load(); got < 2 {
		t.Errorf("handshake attempts = %d, want >= 2 (retry after handshake timeout)", got)
	}
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil on ctx deadline", err)
	}
	assertNoGoroutineLeak(t, base)
	client.Close()
}

func TestEventsSecondStreamRejected(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(1))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := client.Events(ctx)
	nextEvent(t, first)

	second := client.Events(ctx)
	waitStreamClosed(t, second)
	var confErr *ConfigurationError
	if !asError(client.Err(), &confErr) {
		t.Fatalf("Err() = %v, want ConfigurationError", client.Err())
	}
}

func TestEventsAfterCloseRejectedAndCloseIdempotent(t *testing.T) {
	client, err := NewClient(testConfig("http://127.0.0.1:1"))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	client.Close()
	client.Close() // 幂等：二次关闭无副作用

	events := client.Events(context.Background())
	waitStreamClosed(t, events)
	var confErr *ConfigurationError
	if !asError(client.Err(), &confErr) {
		t.Fatalf("Err() = %v, want ConfigurationError", client.Err())
	}
}

func TestCloseEndsActiveStreamWithoutLeak(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(1))
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := client.Events(ctx)
	nextEvent(t, events)
	base := runtime.NumGoroutine()

	client.Close()
	waitStreamClosed(t, events)
	if err := client.Err(); err != nil {
		t.Errorf("Err() = %v, want nil on Close", err)
	}
	assertNoGoroutineLeak(t, base)
}

func TestEventsRestartsAfterNormalEnd(t *testing.T) {
	fs := newFakeWSServer(t, testAPIKey, func(t *testing.T, index int, conn *websocket.Conn) {
		wsWrite(t, conn, tickMessage(index))
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	})
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	first := client.Events(ctx)
	event := nextEvent(t, first)
	if event.Tick != 1 {
		t.Errorf("first stream tick = %d, want 1", event.Tick)
	}
	waitStreamClosed(t, first)

	second := client.Events(ctx)
	event = nextEvent(t, second)
	if event.Tick != 2 {
		t.Errorf("second stream tick = %d, want 2", event.Tick)
	}
	waitStreamClosed(t, second)
	if got := fs.connectionCount(); got != 2 {
		t.Errorf("connection count = %d, want 2", got)
	}
}

// ---- 握手错误分类（直接覆盖 classifyHandshakeError 分支） ----

func TestClassifyHandshakeError(t *testing.T) {
	status := func(code int) *http.Response {
		return &http.Response{StatusCode: code}
	}
	cases := []struct {
		name         string
		resp         *http.Response
		wantTerminal bool
		wantKind     string
		wantOverride bool
	}{
		{"401 auth", status(401), true, "auth", false},
		{"403 auth", status(403), true, "auth", false},
		{"409 throttle", status(409), false, "", true},
		{"429 throttle", status(429), false, "", true},
		{"500 retry", status(500), false, "", false},
		{"503 retry", status(503), false, "", false},
		{"418 transport", status(418), true, "transport", false},
		{"no response retry", nil, false, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			terminal, override := classifyHandshakeError(fmt.Errorf("dial failed"), tc.resp)
			if tc.wantTerminal {
				if terminal == nil {
					t.Fatalf("want terminal error, got nil")
				}
				switch tc.wantKind {
				case "auth":
					var authErr *AuthenticationError
					if !asError(terminal, &authErr) {
						t.Errorf("terminal = %T, want AuthenticationError", terminal)
					}
				case "transport":
					var transportErr *TransportError
					if !asError(terminal, &transportErr) {
						t.Errorf("terminal = %T, want TransportError", terminal)
					}
				}
			} else if terminal != nil {
				t.Errorf("terminal = %v, want nil", terminal)
			}
			if tc.wantOverride != (override != nil) {
				t.Errorf("override = %v, want %v", override, tc.wantOverride)
			}
		})
	}
}

// ---- 幂等键 ----

var idempotencyKeyPattern = regexp.MustCompile(`^arena-\d+-[0-9a-f]{32}$`)

func TestValidateIdempotencyKeyGeneratesAndValidates(t *testing.T) {
	first, err := ValidateIdempotencyKey("", 42)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	second, err := ValidateIdempotencyKey("", 42)
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if !idempotencyKeyPattern.MatchString(first) {
		t.Errorf("generated key %q does not match %s", first, idempotencyKeyPattern)
	}
	if !idempotencyKeyPattern.MatchString(second) {
		t.Errorf("generated key %q does not match %s", second, idempotencyKeyPattern)
	}
	if first == second {
		t.Errorf("two generated keys are identical: %q", first)
	}

	explicit := "explicit-key-123"
	kept, err := ValidateIdempotencyKey(explicit, 7)
	if err != nil || kept != explicit {
		t.Errorf("explicit key = %q, %v; want %q", kept, err, explicit)
	}
}

func TestValidateIdempotencyKeyRejectsInvalid(t *testing.T) {
	invalid := []string{"short", strings.Repeat("x", 129), "has space", "non-ascii-\u00e9"}
	for _, key := range invalid {
		if _, err := ValidateIdempotencyKey(key, 1); err == nil {
			t.Errorf("key %q: expected ConfigurationError", key)
		} else {
			var confErr *ConfigurationError
			if !asError(err, &confErr) {
				t.Errorf("key %q: expected ConfigurationError, got %T", key, err)
			}
		}
	}
}

// ---- 提交 ----

func TestSubmitAcceptedWithIdempotencyKeyHeader(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	accepted, err := client.Submit(ctx, samplePlan(7), "")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if !accepted.Accepted || accepted.Tick != 7 || accepted.Source != contracts.CommandSourceAgent {
		t.Errorf("accepted = %+v", accepted)
	}
	if got := fs.requestCount(); got != 1 {
		t.Errorf("request count = %d, want 1", got)
	}
	headers := fs.lastHeaders()
	if got := headers.Get("Authorization"); got != "Bearer "+testAPIKey {
		t.Errorf("Authorization = %q", got)
	}
	if got := headers.Get("User-Agent"); got != userAgent {
		t.Errorf("User-Agent = %q, want %q", got, userAgent)
	}
	if got := headers.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := headers.Get("Idempotency-Key"); !idempotencyKeyPattern.MatchString(got) {
		t.Errorf("Idempotency-Key = %q, want pattern %s", got, idempotencyKeyPattern)
	}
}

func TestSubmitUsesExplicitIdempotencyKey(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const key = "explicit-key-123"
	if _, err := client.Submit(ctx, samplePlan(7), key); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if got := fs.lastHeaders().Get("Idempotency-Key"); got != key {
		t.Errorf("Idempotency-Key = %q, want %q", got, key)
	}
}

func TestSubmitRetriesOn502ThenSucceeds(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusBadGateway, http.StatusBadGateway, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	accepted, err := client.Submit(ctx, samplePlan(7), "")
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if accepted.Tick != 7 {
		t.Errorf("accepted tick = %d, want 7", accepted.Tick)
	}
	if got := fs.requestCount(); got != 3 {
		t.Errorf("request count = %d, want 3 (two 502 retries then 202)", got)
	}
}

func TestSubmitRetriesExhaustedReturnsTransportError(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusServiceUnavailable)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err = client.Submit(ctx, samplePlan(7), "")
	var transportErr *TransportError
	if !asError(err, &transportErr) {
		t.Fatalf("Submit err = %v, want TransportError", err)
	}
	if got := fs.requestCount(); got != 3 {
		t.Errorf("request count = %d, want 3 (all attempts exhausted)", got)
	}
}

func TestSubmitAPIErrorClassification(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusInternalServerError)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err = client.Submit(ctx, samplePlan(7), "")
	var apiErr *APIError
	if !asError(err, &apiErr) {
		t.Fatalf("Submit err = %v, want APIError", err)
	}
	if apiErr.StatusCode != 500 || apiErr.ErrorCode != "INVALID_PLAN" || apiErr.Message != "bad plan" {
		t.Errorf("api error = %+v", apiErr)
	}
	if got, ok := apiErr.Details["plan_tick"].(float64); !ok || got != 7 {
		t.Errorf("details[plan_tick] = %v, want 7", apiErr.Details["plan_tick"])
	}
	if got := fs.requestCount(); got != 1 {
		t.Errorf("request count = %d, want 1 (API error is not retried)", got)
	}
}

func TestSubmitRejectsInvalidPlan(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	invalid := samplePlan(0) // tick < 1
	_, err = client.Submit(ctx, invalid, "")
	var actionErr *InvalidActionError
	if !asError(err, &actionErr) {
		t.Fatalf("Submit err = %v, want InvalidActionError", err)
	}
	if got := fs.requestCount(); got != 0 {
		t.Errorf("request count = %d, want 0", got)
	}
}

func TestSubmitRejectsBadIdempotencyKey(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err = client.Submit(ctx, samplePlan(7), "short") // 5 字节 < 8
	var confErr *ConfigurationError
	if !asError(err, &confErr) {
		t.Fatalf("Submit err = %v, want ConfigurationError", err)
	}
	if got := fs.requestCount(); got != 0 {
		t.Errorf("request count = %d, want 0", got)
	}
}

func TestSubmitCancelledContext(t *testing.T) {
	fs := newFakeCommandServer(t, testAPIKey, http.StatusAccepted)
	client, err := NewClient(testConfig(fs.url()))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err = client.Submit(ctx, samplePlan(7), "")
	if err != context.Canceled {
		t.Errorf("Submit err = %v, want context.Canceled", err)
	}
	if got := fs.requestCount(); got != 0 {
		t.Errorf("request count = %d, want 0", got)
	}
}

func TestSubmitAfterCloseRejected(t *testing.T) {
	client, err := NewClient(testConfig("http://127.0.0.1:1"))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	client.Close()
	_, err = client.Submit(context.Background(), samplePlan(7), "")
	var confErr *ConfigurationError
	if !asError(err, &confErr) {
		t.Fatalf("Submit err = %v, want ConfigurationError", err)
	}
}

func TestSubmitInvalidAcceptedBodyRetriesThenTransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprint(w, `{"accepted":true}`) // 缺 tick/source/received_at，校验失败
	}))
	defer srv.Close()
	client, err := NewClient(testConfig(srv.URL))
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// 与 TS 版一致：202 但回执校验失败属协议错误，按安全重试语义重试，
	// 重试耗尽后归为 TransportError。
	_, err = client.Submit(ctx, samplePlan(7), "")
	var transportErr *TransportError
	if !asError(err, &transportErr) {
		t.Fatalf("Submit err = %v, want TransportError", err)
	}
}

func TestSubmitLargeResponseRejected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = fmt.Fprint(w, `{"accepted":true,"tick":7,"source":"AGENT","received_at":"2026-08-05T00:00:00Z","pad":"`+strings.Repeat("x", 4096)+`"}`)
	}))
	defer srv.Close()
	config := testConfig(srv.URL)
	config.MaxMessageSize = 64
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = client.Submit(ctx, samplePlan(7), "")
	var transportErr *TransportError
	if !asError(err, &transportErr) {
		t.Fatalf("Submit err = %v, want TransportError", err)
	}
}
