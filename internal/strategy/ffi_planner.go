// Package strategy 的 FFI 融合适配器（fusion-line.md §2 契约）：
// FfiPlanner 实现 runtime.Planner 接口，通过 cdylib 调用 Rust 决策内核
// （arena-sim-ffi）。句柄化 planner 实例（跨 tick 巡逻记忆）。
//
// fail-safe：dll 加载失败 / 调用错误 → 自动回退 Go 原生 planner，
// tenant 不中断（fusion-line.md §5 风险缓解）。

package strategy

import (
	"encoding/json"
	"log/slog"
	"runtime"
	"sync"
	"unsafe"

	"github.com/deliciousbuding/arena/internal/domain"
)

// FfiPlanner 是 Go 宿主 → Rust 决策内核的适配器（runtime.Planner 实现）。
type FfiPlanner struct {
	mu       sync.Mutex
	lib      ffiLib
	handle   unsafe.Pointer // arena_planner_new 句柄（null = 未创建/已回退）
	fallback *Planner       // fail-safe 回退实例（加载失败/调用错误后接管）
	logger   *slog.Logger
}

// NewFfiPlanner 加载 cdylib 并创建 Rust planner 实例。libPath 为空时
// 尝试默认路径（与 tenant 二进制同目录的 arena-sim-ffi 动态库）。
// 加载失败不报错：Decide 时自动回退 Go 原生 planner（fail-safe）。
func NewFfiPlanner(config Config, libPath string, logger *slog.Logger) *FfiPlanner {
	p := &FfiPlanner{
		fallback: NewPlanner(config),
		logger:   logger,
	}
	if libPath == "" {
		libPath = defaultLibPath()
	}
	lib, err := openFFILib(libPath)
	if err != nil {
		logger.Warn("arena-sim-ffi load failed, falling back to Go planner", "lib", libPath, "err", err)
		return p
	}
	p.lib = lib
	p.handle = newPlannerHandle(lib, config, logger)
	if p.handle == nil {
		// 句柄创建失败（配置解析等）→ 回退。
		lib.close()
		p.lib = nil
	}
	return p
}

// Decide 调 Rust 决策内核（state JSON → plan JSON）；任何失败回退 Go
// planner（后续调用直接走 fallback，不再尝试 FFI）。
func (p *FfiPlanner) Decide(state *domain.TickState) *domain.Plan {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle != nil {
		plan, ok := p.decideRust(state)
		if ok {
			return plan
		}
		// 调用失败：释放句柄，永久回退（fusion-line.md fail-safe）。
		freePlannerHandle(p.lib, p.handle)
		p.handle = nil
		p.logger.Warn("arena-sim-ffi decide failed, falling back to Go planner")
	}
	return p.fallback.Decide(state)
}

// IsFallback 报告是否处于回退模式（dll 加载失败/句柄创建失败/调用失败后
// 永久回退 Go 原生 planner）。
func (p *FfiPlanner) IsFallback() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.handle == nil
}

// ApplyDirective 把指挥层指令下发到 Rust planner。
func (p *FfiPlanner) ApplyDirective(directive Directive) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle == nil {
		p.fallback.ApplyDirective(directive)
		return
	}
	applyDirective(p.lib, p.handle, directive, p.logger)
	// 指令失败不回退（非关键路径：下 tick decide 若仍失败再回退）。
}

// Close 释放 Rust 句柄与动态库（tenant 退出时调用）。
func (p *FfiPlanner) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.handle != nil {
		freePlannerHandle(p.lib, p.handle)
		p.handle = nil
	}
	if p.lib != nil {
		p.lib.close()
		p.lib = nil
	}
}

// decideRust 序列化 state → 调 decide → 反序列化 plan。
func (p *FfiPlanner) decideRust(state *domain.TickState) (*domain.Plan, bool) {
	stateJSON, err := json.Marshal(state)
	if err != nil {
		p.logger.Error("marshal state", "err", err)
		return nil, false
	}
	result, errOut := p.lib.decide(p.handle, stateJSON)
	if errOut != "" {
		p.logger.Error("arena-sim-ffi decide error", "err", errOut)
		return nil, false
	}
	if result == nil {
		p.logger.Error("arena-sim-ffi decide returned null without error")
		return nil, false
	}
	defer p.lib.free(result)
	var plan domain.Plan
	if err := json.Unmarshal([]byte(cString(result)), &plan); err != nil {
		p.logger.Error("unmarshal plan", "err", err)
		return nil, false
	}
	return &plan, true
}

// newPlannerHandle 创建 Rust planner 句柄（失败返回 nil）。
func newPlannerHandle(lib ffiLib, config Config, logger *slog.Logger) unsafe.Pointer {
	configJSON, err := json.Marshal(config)
	if err != nil {
		logger.Error("marshal config", "err", err)
		return nil
	}
	handle, errOut := lib.newPlanner(configJSON)
	if errOut != "" {
		logger.Error("arena-sim-ffi new error", "err", errOut)
		return nil
	}
	return handle
}

// applyDirective 下发指令（失败仅日志）。
func applyDirective(lib ffiLib, handle unsafe.Pointer, directive Directive, logger *slog.Logger) {
	directiveJSON, err := json.Marshal(directive)
	if err != nil {
		logger.Error("marshal directive", "err", err)
		return
	}
	_, errOut := lib.applyDirective(handle, directiveJSON)
	if errOut != "" {
		logger.Error("arena-sim-ffi directive error", "err", errOut)
	}
}

// freePlannerHandle 释放句柄。
func freePlannerHandle(lib ffiLib, handle unsafe.Pointer) {
	if lib != nil && handle != nil {
		lib.freePlanner(handle)
	}
}

// defaultLibPath 返回动态库默认路径（与运行平台对应的文件名）。
func defaultLibPath() string {
	if runtime.GOOS == "windows" {
		return "arena-sim-ffi.dll"
	}
	return "libarena_sim_ffi.so"
}

// cString 转换 C 字符串为 Go string。
func cString(ptr unsafe.Pointer) string {
	if ptr == nil {
		return ""
	}
	buf := (*[1 << 30]byte)(ptr)
	length := 0
	for buf[length] != 0 {
		length++
	}
	return string(buf[:length])
}

// ffiLib 抽象动态库句柄（平台实现见 ffi_planner_windows.go / _linux.go）。
type ffiLib interface {
	newPlanner(configJSON []byte) (unsafe.Pointer, string)
	decide(handle unsafe.Pointer, stateJSON []byte) (unsafe.Pointer, string)
	applyDirective(handle unsafe.Pointer, directiveJSON []byte) (unsafe.Pointer, string)
	freePlanner(handle unsafe.Pointer)
	free(ptr unsafe.Pointer)
	close()
}
