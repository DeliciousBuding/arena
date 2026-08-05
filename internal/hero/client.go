package hero

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	mrand "math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/deliciousbuding/arena/internal/contracts"
)

// 协议常量（与 hero SDK client.ts 对齐）。
const (
	// DefaultBaseURL 是官方游戏服务器（HTTP 提交路径基址）。
	DefaultBaseURL = "https://api.arenahero.io"

	commandPath   = "/api/v1/game/commands"
	websocketPath = "/api/v1/game/ws"
	userAgent     = "arena-go/0.1.0"

	defaultRequestTimeout    = 5 * time.Second
	defaultRequestRetries    = 2
	defaultReconnectMinDelay = 250 * time.Millisecond
	defaultReconnectMaxDelay = 5 * time.Second
	defaultHandshakeTimeout  = 15 * time.Second
	defaultMaxMessageSize    = 2 * 1024 * 1024
	defaultIdleTimeout       = 60 * time.Second

	eventBufferSize = 16
)

// EventKind 是 WS 事件流的判别值（hero SDK GameEvent 三信封）。
type EventKind int

const (
	TickEvent EventKind = iota
	StateEvent
	ReceivedEvent
)

// Event 是 WS 事件流中的一条游戏事件：tick / state / received 信封
// 的解析产物（按 Kind 判别读取对应字段；State 在 StateEvent 时有效）。
// 事件是不可变快照，消费方不得回写。
type Event struct {
	Kind     EventKind
	Tick     int
	State    contracts.PlayerState
	Received contracts.Received
}

// Config 是 ArenaHeroClient 的构造参数。零值字段应用默认值：
// RequestTimeout 5s、RequestRetries 2、ReconnectMinDelay 0.25s、
// ReconnectMaxDelay 5s、HandshakeTimeout 15s、MaxMessageSize 2MiB。
// APIKey 只保存在内存（不落盘/不写日志）。
type Config struct {
	// BaseURL 是服务器基址（http(s) origin，可含路径；不含
	// 凭据/查询串/片段），WS 地址由它推导（https→wss）。
	BaseURL string
	// APIKey 是租户密钥，必须非空且只含可见 ASCII。
	APIKey string
	// RequestTimeout 是单次 HTTP 提交的超时。
	RequestTimeout time.Duration
	// RequestRetries 是 502/503/504 与网络失败的额外重试次数。
	RequestRetries int
	// ReconnectMinDelay / ReconnectMaxDelay 是 WS 断线重连的
	// 指数退避区间（x2 增长，0.8–1.2 抖动，上限 Max）。
	ReconnectMinDelay time.Duration
	ReconnectMaxDelay time.Duration
	// HandshakeTimeout 是 WS 握手上限；超时按连接失败进入重连。
	HandshakeTimeout time.Duration
	// MaxMessageSize 是 WS 单条消息与提交响应体的上限。
	MaxMessageSize int64
	// IdleTimeout 是事件流静默阈值：超过该时长未收到任何消息视为
	// 断流，强制关闭连接并进入重连（服务器可能停止推送但不关连接）。
	// 0 表示禁用 watchdog（测试/调试用）；默认 60s。
	IdleTimeout time.Duration
	// Logger 是可选的调试日志（nil 时静默）；用于观察连接/
	// 重连/断流事件，不影响任何行为语义。
	Logger *slog.Logger
}

// DefaultConfig 返回默认配置（与 hero SDK buildConfig 默认值一致）。
func DefaultConfig(apiKey string) Config {
	return Config{
		APIKey:            apiKey,
		BaseURL:           DefaultBaseURL,
		RequestTimeout:    defaultRequestTimeout,
		RequestRetries:    defaultRequestRetries,
		ReconnectMinDelay: defaultReconnectMinDelay,
		ReconnectMaxDelay: defaultReconnectMaxDelay,
		HandshakeTimeout:  defaultHandshakeTimeout,
		MaxMessageSize:    defaultMaxMessageSize,
		IdleTimeout:       defaultIdleTimeout,
	}
}

func applyConfigDefaults(config Config) Config {
	if config.BaseURL == "" {
		config.BaseURL = DefaultBaseURL
	}
	if config.RequestTimeout == 0 {
		config.RequestTimeout = defaultRequestTimeout
	}
	if config.RequestRetries == 0 {
		config.RequestRetries = defaultRequestRetries
	}
	if config.ReconnectMinDelay == 0 {
		config.ReconnectMinDelay = defaultReconnectMinDelay
	}
	if config.ReconnectMaxDelay == 0 {
		config.ReconnectMaxDelay = defaultReconnectMaxDelay
	}
	if config.HandshakeTimeout == 0 {
		config.HandshakeTimeout = defaultHandshakeTimeout
	}
	return config
}

func validateConfig(config Config) error {
	if config.APIKey == "" {
		return newConfigurationError("api_key must be a non-empty string")
	}
	for i := 0; i < len(config.APIKey); i++ {
		if config.APIKey[i] < 0x21 || config.APIKey[i] > 0x7E {
			return newConfigurationError("api_key must contain visible ASCII only")
		}
	}
	if config.RequestTimeout < 0 {
		return newConfigurationError("request_timeout must be positive")
	}
	if config.RequestRetries < 0 {
		return newConfigurationError("request_retries cannot be negative")
	}
	if config.ReconnectMinDelay < 0 {
		return newConfigurationError("reconnect_min_delay must be positive")
	}
	if config.ReconnectMaxDelay < config.ReconnectMinDelay {
		return newConfigurationError("reconnect_max_delay cannot be less than reconnect_min_delay")
	}
	if config.HandshakeTimeout < 0 {
		return newConfigurationError("handshake_timeout must be positive")
	}
	if config.MaxMessageSize <= 0 {
		return newConfigurationError("max_message_size must be positive")
	}
	return nil
}

// normalizeBaseURL 校验并规范化基址：http(s) origin、无凭据/查询串/
// 片段、去掉末尾斜杠（保留路径）。
func normalizeBaseURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("base_url must be an http(s) origin")
	}
	if parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("base_url must be an http(s) origin without credentials, query, or fragment")
	}
	path := strings.TrimRight(parsed.Path, "/")
	return parsed.Scheme + "://" + parsed.Host + path, nil
}

// deriveWebsocketURL 由基址推导 WS 地址：https→wss、http→ws，
// 路径为基址路径 + /api/v1/game/ws。
func deriveWebsocketURL(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	scheme := "ws"
	if parsed.Scheme == "https" {
		scheme = "wss"
	}
	path := strings.TrimRight(parsed.Path, "/") + websocketPath
	return scheme + "://" + parsed.Host + path, nil
}

// ArenaHeroClient 是 Arena Hero 游戏协议客户端：WS 事件流订阅
// （自动重连）与 HTTP 命令提交（幂等键 + 安全重试）。
// 并发安全：Events 流与 Submit 可并行；Close 幂等。
type ArenaHeroClient struct {
	config Config

	baseURL    string
	wsURL      string
	commandURL string

	httpClient *http.Client

	lifecycleCtx    context.Context
	lifecycleCancel context.CancelFunc

	mu        sync.Mutex
	closed    bool
	iterating bool
	conn      *websocket.Conn
	lastErr   error
}

// NewClient 构造客户端并校验配置（非法配置返回 ConfigurationError）。
func NewClient(config Config) (*ArenaHeroClient, error) {
	config = applyConfigDefaults(config)
	if err := validateConfig(config); err != nil {
		return nil, err
	}
	baseURL, err := normalizeBaseURL(config.BaseURL)
	if err != nil {
		return nil, newConfigurationError("%v", err)
	}
	wsURL, err := deriveWebsocketURL(baseURL)
	if err != nil {
		return nil, newConfigurationError("%v", err)
	}
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())
	return &ArenaHeroClient{
		config:          config,
		baseURL:         baseURL,
		wsURL:           wsURL,
		commandURL:      baseURL + commandPath,
		httpClient:      &http.Client{},
		lifecycleCtx:    lifecycleCtx,
		lifecycleCancel: lifecycleCancel,
	}, nil
}

// Err 返回事件流的终止错误：正常结束（close 1000 / ctx 取消 /
// Close）为 nil；协议违规/策略违规/认证失败等异常终止返回对应分类。
func (c *ArenaHeroClient) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastErr
}

// Events 订阅服务器事件流（tick/state/received），自动重连语义与
// hero SDK events() 一致：
//   - 连接成功前/断线后按 ReconnectMinDelay 起指数退避（x2，上限
//     ReconnectMaxDelay，0.8–1.2 抖动）；
//   - WS 正常关闭 1000 → 结束流（不再重连）；
//   - 1008 Policy Violation → PolicyViolationError 终止（不重连）；
//   - 握手 401/403 → AuthenticationError 终止；409/429 → 固定 1s 后
//     重试；其他 5xx → 正常退避重试；其余 HTTP 状态 → TransportError
//     终止；
//   - 消息解析失败/二进制帧/state 早于 tick → ProtocolError 终止；
//   - ctx 取消或 Close → 结束流（Err 为 nil）。
//
// 每个客户端同时只允许一个事件流；二次调用返回已关闭的 channel 并
// 置 Err 为 ConfigurationError。流结束后（未 Close）可再次调用。
func (c *ArenaHeroClient) Events(ctx context.Context) <-chan Event {
	ch := make(chan Event, eventBufferSize)
	c.mu.Lock()
	switch {
	case c.closed:
		c.lastErr = newConfigurationError("the client is closed")
		c.mu.Unlock()
		close(ch)
		return ch
	case c.iterating:
		c.lastErr = newConfigurationError("only one event stream may run per client")
		c.mu.Unlock()
		close(ch)
		return ch
	default:
		c.iterating = true
		c.lastErr = nil
		c.mu.Unlock()
	}
	go c.eventLoop(ctx, ch)
	return ch
}

func (c *ArenaHeroClient) eventLoop(ctx context.Context, ch chan<- Event) {
	streamCtx, streamCancel := context.WithCancel(c.lifecycleCtx)
	defer streamCancel()
	stop := context.AfterFunc(ctx, streamCancel)
	defer stop()
	defer close(ch)
	defer func() {
		c.mu.Lock()
		c.iterating = false
		c.mu.Unlock()
	}()

	delay := c.config.ReconnectMinDelay
	for {
		if streamCtx.Err() != nil {
			return
		}
		// 握手超时：超过 HandshakeTimeout 视为连接失败进入重连。
		dialCtx, dialCancel := context.WithTimeout(streamCtx, c.config.HandshakeTimeout)
		conn, resp, err := websocket.Dial(dialCtx, c.wsURL, &websocket.DialOptions{
			HTTPClient: c.httpClient,
			HTTPHeader: c.authHeaders(),
		})
		dialCancel()
		if err != nil {
			if streamCtx.Err() != nil {
				return
			}
			terminal, override := classifyHandshakeError(err, resp)
			if terminal != nil {
				c.setErr(terminal)
				return
			}
			sleepFor := delay
			if override != nil {
				sleepFor = *override
			} else {
				sleepFor = jitter(delay)
			}
			c.logDebug("ws.reconnect", "delay", sleepFor, "err", err)
			if !c.sleep(streamCtx, sleepFor) {
				return
			}
			delay = min(delay*2, c.config.ReconnectMaxDelay)
			continue
		}
		conn.SetReadLimit(c.config.MaxMessageSize)
		c.setConn(conn)
		delay = c.config.ReconnectMinDelay
		c.logDebug("ws.connected")

		closeStatus, readErr := c.readLoop(streamCtx, conn, ch)
		c.clearConn(conn)
		c.logDebug("ws.read_ended", "closeStatus", closeStatus, "err", readErr)
		if closeStatus == websocket.StatusNormalClosure {
			_ = conn.Close(websocket.StatusNormalClosure, "")
		} else {
			conn.CloseNow()
		}
		if streamCtx.Err() != nil {
			return
		}
		if readErr != nil {
			var protoErr *ProtocolError
			if errors.As(readErr, &protoErr) {
				c.setErr(protoErr)
				return
			}
		}
		switch closeStatus {
		case websocket.StatusNormalClosure:
			c.logDebug("ws.read_ended")
			return // 服务端正常结束：不重连
		case websocket.StatusPolicyViolation:
			c.setErr(&PolicyViolationError{msg: "WebSocket closed with 1008 Policy Violation"})
			return
		}
		// 其他关闭码（1001/1006/1011…）与网络错误：指数退避重连。
		if !c.sleep(streamCtx, jitter(delay)) {
			return
		}
		delay = min(delay*2, c.config.ReconnectMaxDelay)
	}
}

// logDebug 输出调试日志（Config.Logger 为 nil 时静默）。
func (c *ArenaHeroClient) logDebug(msg string, args ...any) {
	if c.config.Logger != nil {
		c.config.Logger.Debug(msg, args...)
	}
}

// readLoop 持续读取并解析服务器消息，直到连接关闭、协议违规或
// streamCtx 取消。返回服务器关闭码与终止错误。
func (c *ArenaHeroClient) readLoop(ctx context.Context, conn *websocket.Conn, ch chan<- Event) (websocket.StatusCode, error) {
	var currentTick int
	haveTick := false

	// idle watchdog：服务器可能停止推送但不关闭连接（真机观察到的
	// 现象），静默超过 IdleTimeout 视为断流，强制关闭连接触发重连。
	var lastReadAt atomic.Int64
	lastReadAt.Store(time.Now().UnixNano())
	if c.config.IdleTimeout > 0 {
		stopWatchdog := make(chan struct{})
		defer close(stopWatchdog)
		c.logDebug("ws.watchdog_armed", "idleTimeout", c.config.IdleTimeout)
		go func() {
			ticker := time.NewTicker(c.config.IdleTimeout / 4)
			defer ticker.Stop()
			for {
				select {
				case <-stopWatchdog:
					return
				case <-ticker.C:
					last := lastReadAt.Load()
					if last > 0 && time.Since(time.Unix(0, last)) > c.config.IdleTimeout {
						c.logDebug("ws.idle_timeout", "idleTimeout", c.config.IdleTimeout)
						_ = conn.CloseNow()
						return
					}
				}
			}
		}()
	}

	for {
		messageType, data, err := conn.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err), err
		}
		lastReadAt.Store(time.Now().UnixNano())
		c.logDebug("ws message", "type", messageType, "bytes", len(data))
		if messageType != websocket.MessageText {
			return websocket.StatusCode(-1), newProtocolError("the server sent a binary WebSocket message")
		}
		parsed, err := contracts.ParseStreamMessage(data)
		if err != nil {
			return websocket.StatusCode(-1), newProtocolError("invalid Arena Hero WebSocket message: %v", err)
		}
		var event Event
		switch msg := parsed.(type) {
		case *contracts.TickMessage:
			event = Event{Kind: TickEvent, Tick: msg.Data}
			currentTick = msg.Data
			haveTick = true
		case *contracts.StateMessage:
			if !haveTick {
				return websocket.StatusCode(-1), newProtocolError("state arrived before tick")
			}
			event = Event{Kind: StateEvent, Tick: currentTick, State: msg.Data}
		case *contracts.ReceivedMessage:
			event = Event{Kind: ReceivedEvent, Tick: msg.Data.Tick, Received: msg.Data}
		}
		select {
		case ch <- event:
		case <-ctx.Done():
			return websocket.StatusCode(-1), ctx.Err()
		}
	}
}

// classifyHandshakeError 按 hero SDK _classifyError 语义分类握手失败：
// 返回 (终止错误, 覆盖退避)。两者皆 nil 表示按正常指数退避重连。
func classifyHandshakeError(err error, resp *http.Response) (error, *time.Duration) {
	if resp != nil {
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return &AuthenticationError{msg: fmt.Sprintf("WebSocket authorization failed with HTTP %d", resp.StatusCode)}, nil
		case http.StatusConflict, http.StatusTooManyRequests:
			override := time.Second
			return nil, &override
		default:
			if resp.StatusCode >= 500 && resp.StatusCode <= 599 {
				return nil, nil
			}
			return newTransportError("WebSocket handshake failed with HTTP %d", resp.StatusCode), nil
		}
	}
	// 无 HTTP 响应（网络失败/握手超时）：按连接失败重连。
	return nil, nil
}

// jitter 按 0.8–1.2 随机系数缩放退避时长（hero SDK jitter）。
func jitter(delay time.Duration) time.Duration {
	factor := 0.8 + mrand.Float64()*0.4
	return time.Duration(float64(delay) * factor)
}

func (c *ArenaHeroClient) sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (c *ArenaHeroClient) authHeaders() http.Header {
	headers := make(http.Header, 2)
	headers.Set("Authorization", "Bearer "+c.config.APIKey)
	headers.Set("User-Agent", userAgent)
	return headers
}

func (c *ArenaHeroClient) setConn(conn *websocket.Conn) {
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
}

func (c *ArenaHeroClient) clearConn(conn *websocket.Conn) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	c.mu.Unlock()
}

func (c *ArenaHeroClient) setErr(err error) {
	c.mu.Lock()
	c.lastErr = err
	c.mu.Unlock()
}

// Close 幂等关闭客户端：取消事件流、中断当前连接并阻止后续
// Submit/Events。已结束或已关闭的客户端再次调用无副作用。
func (c *ArenaHeroClient) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	conn := c.conn
	c.mu.Unlock()
	c.lifecycleCancel()
	if conn != nil {
		conn.CloseNow()
	}
}

// ValidateIdempotencyKey 校验或生成幂等键（hero SDK
// validateIdempotencyKey）：key 为空时生成 arena-{tick}-{32 位 hex}
// （crypto/rand，16 随机字节）；显式 key 必须 8–128 个可见 ASCII
// 字节。非法 key 返回 ConfigurationError。
func ValidateIdempotencyKey(key string, tick int) (string, error) {
	if key == "" {
		var randomBytes [16]byte
		if _, err := crand.Read(randomBytes[:]); err != nil {
			return "", newTransportError("failed to generate idempotency key: %v", err)
		}
		return fmt.Sprintf("arena-%d-%x", tick, randomBytes), nil
	}
	if len(key) < 8 || len(key) > 128 {
		return "", newConfigurationError("idempotency_key must contain 8 to 128 visible ASCII bytes")
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7E {
			return "", newConfigurationError("idempotency_key must contain 8 to 128 visible ASCII bytes without spaces")
		}
	}
	return key, nil
}

// Submit 提交完整计划（hero SDK submit 语义）：编码 + 幂等键 +
// 安全重试。202 → 解析回执；502/503/504 与网络失败按
// 0.1s*2^n（上限 0.5s）退避重试（最多 RequestRetries 次额外尝试）；
// 其他非 2xx → APIError（error/message/details 结构化），不重试；
// 重试耗尽 → TransportError。ctx 取消返回 context 错误。
func (c *ArenaHeroClient) Submit(ctx context.Context, plan contracts.CommandPlan, idempotencyKey string) (*contracts.Accepted, error) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return nil, newConfigurationError("the client is closed")
	}
	body, err := contracts.MarshalCommandPlan(plan)
	if err != nil {
		return nil, newInvalidActionError("invalid command plan: %v", err)
	}
	key, err := ValidateIdempotencyKey(idempotencyKey, plan.Tick)
	if err != nil {
		return nil, err
	}

	attempts := c.config.RequestRetries + 1
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		requestCtx, cancel := context.WithTimeout(ctx, c.config.RequestTimeout)
		accepted, err := c.submitOnce(requestCtx, body, key)
		cancel()
		if err == nil {
			return accepted, nil
		}
		var apiErr *APIError
		if errors.As(err, &apiErr) {
			return nil, apiErr
		}
		lastErr = err
		if attempt+1 < attempts {
			backoff := time.Duration(100*(1<<attempt)) * time.Millisecond // 0.1s * 2^n
			if backoff > 500*time.Millisecond {
				backoff = 500 * time.Millisecond
			}
			if !c.sleep(ctx, backoff) {
				return nil, ctx.Err()
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return nil, newTransportError("command submission failed after safe retries: %v", lastErr)
}

func (c *ArenaHeroClient) submitOnce(ctx context.Context, body []byte, key string) (*contracts.Accepted, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.commandURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.config.APIKey)
	request.Header.Set("User-Agent", userAgent)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", key)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	content, err := readLimited(response.Body, c.config.MaxMessageSize)
	if err != nil {
		return nil, err
	}
	switch {
	case response.StatusCode == http.StatusAccepted:
		accepted, err := contracts.ParseAccepted(content)
		if err != nil {
			return nil, newProtocolError("invalid command acknowledgement: %v", err)
		}
		return accepted, nil
	case response.StatusCode == http.StatusBadGateway ||
		response.StatusCode == http.StatusServiceUnavailable ||
		response.StatusCode == http.StatusGatewayTimeout:
		return nil, newTransportError("command API temporarily unavailable (HTTP %d)", response.StatusCode)
	default:
		return nil, NewAPIError(response.StatusCode, parseJSONObject(content))
	}
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) > limit {
		return nil, newTransportError("response body exceeds %d bytes", limit)
	}
	return content, nil
}

// parseJSONObject 解析响应体为对象；不可解析/非对象降级为空对象
// （与 hero SDK apiError 的 payload 兜底语义一致）。
func parseJSONObject(data []byte) map[string]any {
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return map[string]any{}
	}
	return payload
}

// NewTurn 构造绑定本客户端的 Turn（Submit 经客户端发送）。
func (c *ArenaHeroClient) NewTurn(tick int) *Turn {
	turn := NewTurn(tick)
	turn.client = c
	return turn
}
