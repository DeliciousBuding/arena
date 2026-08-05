//go:build windows

// Windows 平台动态库加载（syscall.LazyDLL + NewProc）。
//
// 内存契约（fusion-line.md §2）：
// - 输入串：Go 堆分配 + runtime.KeepAlive（Rust 侧只读不 free）；
// - 返回串/err_out：Rust `CString::into_raw` 分配，一律经
//   `arena_string_free` 释放（跨分配器 free 是 UB，不得用 C.free）。

package strategy

import (
	"runtime"
	"syscall"
	"unsafe"
)

type ffiLibWindows struct {
	dll *syscall.LazyDLL
	// 过程句柄（懒解析一次）。
	newPlannerProc   *syscall.LazyProc
	decideProc       *syscall.LazyProc
	applyDirectivePc *syscall.LazyProc
	freePlannerProc  *syscall.LazyProc
	stringFreeProc   *syscall.LazyProc
}

func openFFILib(path string) (*ffiLibWindows, error) {
	dll := syscall.NewLazyDLL(path)
	lib := &ffiLibWindows{
		dll:              dll,
		newPlannerProc:   dll.NewProc("arena_planner_new"),
		decideProc:       dll.NewProc("arena_planner_decide"),
		applyDirectivePc: dll.NewProc("arena_planner_apply_directive"),
		freePlannerProc:  dll.NewProc("arena_planner_free"),
		stringFreeProc:   dll.NewProc("arena_string_free"),
	}
	// 触发加载（Find 失败 = dll 缺失/符号缺失）。
	if err := dll.Load(); err != nil {
		return nil, err
	}
	return lib, nil
}

func (l *ffiLibWindows) newPlanner(configJSON []byte) (unsafe.Pointer, string) {
	configPtr, keepAlive := bytesToCString(configJSON)
	defer runtime.KeepAlive(keepAlive)
	var errOut unsafe.Pointer
	handle, _, _ := l.newPlannerProc.Call(configPtr, uintptr(unsafe.Pointer(&errOut)))
	if handle == 0 {
		return nil, l.readErrString(errOut)
	}
	return unsafe.Pointer(handle), ""
}

func (l *ffiLibWindows) decide(handle unsafe.Pointer, stateJSON []byte) (unsafe.Pointer, string) {
	statePtr, keepAlive := bytesToCString(stateJSON)
	defer runtime.KeepAlive(keepAlive)
	var errOut unsafe.Pointer
	result, _, _ := l.decideProc.Call(
		uintptr(handle),
		statePtr,
		uintptr(unsafe.Pointer(&errOut)),
	)
	if result == 0 {
		return nil, l.readErrString(errOut)
	}
	return unsafe.Pointer(result), ""
}

func (l *ffiLibWindows) applyDirective(handle unsafe.Pointer, directiveJSON []byte) (unsafe.Pointer, string) {
	directivePtr, keepAlive := bytesToCString(directiveJSON)
	defer runtime.KeepAlive(keepAlive)
	var errOut unsafe.Pointer
	result, _, _ := l.applyDirectivePc.Call(
		uintptr(handle),
		directivePtr,
		uintptr(unsafe.Pointer(&errOut)),
	)
	if result == 0 {
		return nil, l.readErrString(errOut)
	}
	// 成功返回 "ok" 串（Rust 分配）→ 立即释放，返回标记。
	l.stringFreeProc.Call(result)
	return unsafe.Pointer(uintptr(1)), ""
}

func (l *ffiLibWindows) freePlanner(handle unsafe.Pointer) {
	if handle != nil {
		l.freePlannerProc.Call(uintptr(handle))
	}
}

func (l *ffiLibWindows) free(ptr unsafe.Pointer) {
	if ptr != nil {
		l.stringFreeProc.Call(uintptr(ptr))
	}
}

func (l *ffiLibWindows) close() {
	// LazyDLL 无显式卸载（进程退出回收）。
}

// readErrString 读取并释放 err_out 错误消息（Rust 分配，arena_string_free）。
func (l *ffiLibWindows) readErrString(errOut unsafe.Pointer) string {
	if errOut == nil {
		return ""
	}
	ptr := *(*unsafe.Pointer)(errOut)
	if ptr == nil {
		return ""
	}
	msg := cString(ptr)
	l.stringFreeProc.Call(uintptr(ptr))
	return msg
}

// 平台实现必须满足 ffiLib 接口（编译期断言）。
var _ ffiLib = (*ffiLibWindows)(nil)

func bytesToCString(data []byte) (uintptr, []byte) {
	buf := append(append([]byte(nil), data...), 0)
	return uintptr(unsafe.Pointer(&buf[0])), buf
}
