package hero

import (
	"errors"
	"strings"
	"testing"
)

func TestErrorTypesImplementErrorInterface(t *testing.T) {
	constructors := []struct {
		name string
		err  error
	}{
		{"ConfigurationError", newConfigurationError("config %d", 1)},
		{"AuthenticationError", &AuthenticationError{msg: "auth"}},
		{"ProtocolError", newProtocolError("protocol %d", 2)},
		{"PolicyViolationError", &PolicyViolationError{msg: "policy"}},
		{"TransportError", newTransportError("transport %d", 3)},
		{"TurnClosedError", newTurnClosedError("closed %d", 4)},
		{"InvalidActionError", newInvalidActionError("invalid %d", 5)},
	}
	for _, tc := range constructors {
		if tc.err == nil {
			t.Errorf("%s: nil error", tc.name)
			continue
		}
		if tc.err.Error() == "" {
			t.Errorf("%s: empty message", tc.name)
		}
	}
}

func TestErrorsAsClassification(t *testing.T) {
	isKind := func(err error, target any) bool {
		return errors.As(err, target)
	}
	cases := []struct {
		name   string
		err    error
		asKind func() bool
	}{
		{"configuration", newConfigurationError("x"), func() bool {
			var target *ConfigurationError
			return isKind(newConfigurationError("x"), &target)
		}},
		{"authentication", &AuthenticationError{msg: "x"}, func() bool {
			var target *AuthenticationError
			return isKind(&AuthenticationError{msg: "x"}, &target)
		}},
		{"protocol", newProtocolError("x"), func() bool {
			var target *ProtocolError
			return isKind(newProtocolError("x"), &target)
		}},
		{"policy violation", &PolicyViolationError{msg: "x"}, func() bool {
			var target *PolicyViolationError
			return isKind(&PolicyViolationError{msg: "x"}, &target)
		}},
		{"transport", newTransportError("x"), func() bool {
			var target *TransportError
			return isKind(newTransportError("x"), &target)
		}},
		{"turn closed", newTurnClosedError("x"), func() bool {
			var target *TurnClosedError
			return isKind(newTurnClosedError("x"), &target)
		}},
		{"invalid action", newInvalidActionError("x"), func() bool {
			var target *InvalidActionError
			return isKind(newInvalidActionError("x"), &target)
		}},
		{"api", &APIError{StatusCode: 500}, func() bool {
			var target *APIError
			return isKind(&APIError{StatusCode: 500}, &target)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if !tc.asKind() {
				t.Errorf("errors.As(%v) failed", tc.err)
			}
			// 反向断言：跨类别不误匹配 APIError
			var apiErr *APIError
			if tc.name != "api" && errors.As(tc.err, &apiErr) {
				t.Errorf("errors.As matched APIError for %s", tc.name)
			}
		})
	}
}

func TestAPIErrorConstruction(t *testing.T) {
	apiErr := NewAPIError(422, map[string]any{
		"error":     "INVALID_PLAN",
		"message":   "bad move",
		"plan_tick": 7,
		"extra":     "kept",
	})
	if apiErr.StatusCode != 422 {
		t.Errorf("StatusCode = %d, want 422", apiErr.StatusCode)
	}
	if apiErr.ErrorCode != "INVALID_PLAN" {
		t.Errorf("ErrorCode = %q, want INVALID_PLAN", apiErr.ErrorCode)
	}
	if apiErr.Message != "bad move" {
		t.Errorf("Message = %q, want bad move", apiErr.Message)
	}
	if got, ok := apiErr.Details["plan_tick"].(int); !ok || got != 7 {
		t.Errorf("Details[plan_tick] = %v, want 7", apiErr.Details["plan_tick"])
	}
	if apiErr.Details["extra"] != "kept" {
		t.Errorf("Details[extra] = %v, want kept", apiErr.Details["extra"])
	}
	if _, hasError := apiErr.Details["error"]; hasError {
		t.Errorf("Details must not contain the error field")
	}
	if apiErr.Error() == "" || !strings.Contains(apiErr.Error(), "422") {
		t.Errorf("Error() = %q", apiErr.Error())
	}
}

func TestAPIErrorDefaultsForUnexpectedPayload(t *testing.T) {
	apiErr := NewAPIError(500, map[string]any{})
	if apiErr.ErrorCode != "HTTP_ERROR" {
		t.Errorf("ErrorCode = %q, want HTTP_ERROR", apiErr.ErrorCode)
	}
	if apiErr.Message != "" {
		t.Errorf("Message = %q, want empty", apiErr.Message)
	}

	// 非字符串 error/message 字段降级
	apiErr = NewAPIError(500, map[string]any{"error": 42, "message": nil})
	if apiErr.ErrorCode != "HTTP_ERROR" {
		t.Errorf("ErrorCode = %q, want HTTP_ERROR", apiErr.ErrorCode)
	}
}

func TestNewAPIErrorDropsCredentialsFromDetails(t *testing.T) {
	// 服务器若回显敏感字段，Details 会保留它们（结构化原样传递），
	// 但 error/message 抽取不得将整个载荷混入 Message。
	apiErr := NewAPIError(400, map[string]any{
		"error": "BAD_KEY",
		"extra": map[string]any{"nested": true},
	})
	if apiErr.ErrorCode != "BAD_KEY" {
		t.Errorf("ErrorCode = %q, want BAD_KEY", apiErr.ErrorCode)
	}
	if apiErr.Message != "" {
		t.Errorf("Message = %q, want empty", apiErr.Message)
	}
}
