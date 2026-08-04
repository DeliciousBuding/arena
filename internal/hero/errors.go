// Package hero 是 Arena Go 版的游戏协议客户端（M2）：WS 事件流
// （连接/重连/退避/握手超时/消息上限）、Turn 构建器与计划提交
// （幂等键/安全重试/结构化 API 错误）。
//
// 错误分类与 TS 版 errors.ts 语义一致，消费者用 errors.As 判定：
//   - ConfigurationError：客户端配置或参数非法（构造期即失败）；
//   - AuthenticationError：服务器拒绝 API 密钥（WS 握手 401/403，
//     终止事件流，不重连）；
//   - ProtocolError：服务器消息违反公开协议（解析失败/二进制帧/
//     state 早于 tick），终止事件流，不重连；
//   - PolicyViolationError：WS 以 1008 关闭，终止事件流，不重连；
//   - TransportError：网络层失败且安全重试耗尽；
//   - APIError：命令 API 返回非 2xx（error/message/details 结构化）；
//   - TurnClosedError：对已关闭（被新 tick 取代）的 Turn 操作；
//   - InvalidActionError：动作无法用命令协议表示（校验失败）。
package hero

import (
	"fmt"
	"strings"
)

// ConfigurationError 表示客户端被用非法配置或参数初始化/调用
// （与 TS 版 ConfigurationError 对应）。
type ConfigurationError struct {
	msg string
}

func (e *ConfigurationError) Error() string { return e.msg }

func newConfigurationError(format string, args ...any) error {
	return &ConfigurationError{msg: fmt.Sprintf(format, args...)}
}

// AuthenticationError 表示服务器拒绝了 API 密钥（WS 握手 401/403）。
type AuthenticationError struct {
	msg string
}

func (e *AuthenticationError) Error() string { return e.msg }

// ProtocolError 表示服务器发送的消息违反公开协议
// （解析失败、二进制帧、state 早于 tick 等）。
type ProtocolError struct {
	msg string
}

func (e *ProtocolError) Error() string { return e.msg }

func newProtocolError(format string, args ...any) error {
	return &ProtocolError{msg: fmt.Sprintf(format, args...)}
}

// PolicyViolationError 表示 WS 连接以 1008 Policy Violation 关闭。
type PolicyViolationError struct {
	msg string
}

func (e *PolicyViolationError) Error() string { return e.msg }

// TransportError 表示网络操作在安全重试耗尽后仍然失败
// （与 TS 版 TransportError 对应）。
type TransportError struct {
	msg string
}

func (e *TransportError) Error() string { return e.msg }

func newTransportError(format string, args ...any) error {
	return &TransportError{msg: fmt.Sprintf(format, args...)}
}

// TurnClosedError 表示对已关闭（被新 tick 取代或显式 Close）的
// Turn 执行构建/提交操作。
type TurnClosedError struct {
	msg string
}

func (e *TurnClosedError) Error() string { return e.msg }

func newTurnClosedError(format string, args ...any) error {
	return &TurnClosedError{msg: fmt.Sprintf(format, args...)}
}

// InvalidActionError 表示动作无法用 Arena Hero 命令协议表示
// （校验失败，与 TS 版 InvalidActionError 对应）。
type InvalidActionError struct {
	msg string
}

func (e *InvalidActionError) Error() string { return e.msg }

func newInvalidActionError(format string, args ...any) error {
	return &InvalidActionError{msg: fmt.Sprintf(format, args...)}
}

// APIError 表示命令 API（POST /api/v1/game/commands）返回了非 2xx
// 且不可安全重试（非 502/503/504）的响应。字段与 TS 版 APIError
// 对应：ErrorCode 是服务器 error 字段（缺省 "HTTP_ERROR"），Message
// 是服务器 message 字段（缺省空串），Details 收集其余响应字段。
// 注：Go 禁止字段与方法同名，服务器 error 字段命名为 ErrorCode
// （JSON 标签仍为 "error"，wire 格式不变）。
type APIError struct {
	StatusCode int
	ErrorCode  string `json:"error"`
	Message    string `json:"message"`
	Details    map[string]any
}

func (e *APIError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "api error: status %d %s", e.StatusCode, e.ErrorCode)
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	return b.String()
}

// NewAPIError 从服务器响应构造结构化 API 错误（解析 error/message
// 字段，其余字段归入 Details；不可解析的载荷降级为 HTTP_ERROR）。
func NewAPIError(statusCode int, payload map[string]any) *APIError {
	errCode := "HTTP_ERROR"
	var message string
	details := make(map[string]any, len(payload))
	for key, value := range payload {
		switch key {
		case "error":
			if text, ok := value.(string); ok && text != "" {
				errCode = text
			}
		case "message":
			if text, ok := value.(string); ok {
				message = text
			}
		default:
			details[key] = value
		}
	}
	return &APIError{StatusCode: statusCode, ErrorCode: errCode, Message: message, Details: details}
}
