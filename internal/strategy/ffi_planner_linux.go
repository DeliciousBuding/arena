//go:build linux

// Linux 平台动态库加载（cgo dlopen/dlsym）。
// 内存契约同 Windows 版：输入串由 Go/C 临时分配并在调用返回后释放；
// 返回串与 err_out 必须经 Rust 导出的 arena_string_free 释放。

package strategy

/*
#cgo LDFLAGS: -ldl
#include <dlfcn.h>
#include <stdlib.h>

typedef void* (*arena_new_fn)(const char*, char**);
typedef char* (*arena_decide_fn)(void*, const char*, char**);
typedef char* (*arena_directive_fn)(void*, const char*, char**);
typedef void (*arena_free_fn)(void*);

// cgo 不能直接调用保存在 Go 字段里的 C 函数指针；所有间接调用必须
// 经过静态 C trampoline。
static void* arena_call_new(void *fn, const char *config, char **err_out) {
	return ((arena_new_fn)fn)(config, err_out);
}

static char* arena_call_decide(void *fn, void *handle, const char *state, char **err_out) {
	return ((arena_decide_fn)fn)(handle, state, err_out);
}

static char* arena_call_directive(void *fn, void *handle, const char *directive, char **err_out) {
	return ((arena_directive_fn)fn)(handle, directive, err_out);
}

static void arena_call_free(void *fn, void *value) {
	((arena_free_fn)fn)(value);
}
*/
import "C"

import "unsafe"

type ffiLibLinux struct {
	handle unsafe.Pointer // dlopen 句柄
	// dlsym 返回的函数地址。使用 unsafe.Pointer 保存，由上面的 C trampoline 调用。
	newPlannerFn     unsafe.Pointer
	decideFn         unsafe.Pointer
	applyDirectiveFn unsafe.Pointer
	freePlannerFn    unsafe.Pointer
	stringFreeFn     unsafe.Pointer
}

func openFFILib(path string) (*ffiLibLinux, error) {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))

	handle := C.dlopen(cPath, C.RTLD_NOW|C.RTLD_LOCAL)
	if handle == nil {
		return nil, &libLoadError{msg: dlError("dlopen failed")}
	}

	lib := &ffiLibLinux{handle: handle}
	lib.newPlannerFn = lookupSymbol(handle, "arena_planner_new")
	lib.decideFn = lookupSymbol(handle, "arena_planner_decide")
	lib.applyDirectiveFn = lookupSymbol(handle, "arena_planner_apply_directive")
	lib.freePlannerFn = lookupSymbol(handle, "arena_planner_free")
	lib.stringFreeFn = lookupSymbol(handle, "arena_string_free")

	if lib.newPlannerFn == nil ||
		lib.decideFn == nil ||
		lib.applyDirectiveFn == nil ||
		lib.freePlannerFn == nil ||
		lib.stringFreeFn == nil {
		message := dlError("required arena-sim-ffi symbol missing")
		lib.close()
		return nil, &libLoadError{msg: message}
	}
	return lib, nil
}

func lookupSymbol(handle unsafe.Pointer, name string) unsafe.Pointer {
	// 清掉上一次 dlerror；dlsym 返回 nil 时再由调用方读取最新错误。
	C.dlerror()
	cName := C.CString(name)
	defer C.free(unsafe.Pointer(cName))
	return C.dlsym(handle, cName)
}

func dlError(fallback string) string {
	if message := C.dlerror(); message != nil {
		return C.GoString(message)
	}
	return fallback
}

type libLoadError struct{ msg string }

func (e *libLoadError) Error() string { return e.msg }

func (l *ffiLibLinux) newPlanner(configJSON []byte) (unsafe.Pointer, string) {
	cConfig := C.CBytes(append(append([]byte(nil), configJSON...), 0))
	defer C.free(cConfig)

	var errOut *C.char
	handle := C.arena_call_new(l.newPlannerFn, (*C.char)(cConfig), &errOut)
	if handle == nil {
		return nil, l.readErrString(errOut)
	}
	// Rust promises err_out == null on success. Release a defensive stray error
	// rather than leaking it, but treat the successful handle as authoritative.
	if errOut != nil {
		_ = l.readErrString(errOut)
	}
	return handle, ""
}

func (l *ffiLibLinux) decide(handle unsafe.Pointer, stateJSON []byte) (unsafe.Pointer, string) {
	cState := C.CBytes(append(append([]byte(nil), stateJSON...), 0))
	defer C.free(cState)

	var errOut *C.char
	result := C.arena_call_decide(l.decideFn, handle, (*C.char)(cState), &errOut)
	if result == nil {
		return nil, l.readErrString(errOut)
	}
	if errOut != nil {
		message := l.readErrString(errOut)
		C.arena_call_free(l.stringFreeFn, unsafe.Pointer(result))
		return nil, message
	}
	return unsafe.Pointer(result), ""
}

func (l *ffiLibLinux) applyDirective(handle unsafe.Pointer, directiveJSON []byte) (unsafe.Pointer, string) {
	cDirective := C.CBytes(append(append([]byte(nil), directiveJSON...), 0))
	defer C.free(cDirective)

	var errOut *C.char
	result := C.arena_call_directive(
		l.applyDirectiveFn,
		handle,
		(*C.char)(cDirective),
		&errOut,
	)
	if result == nil {
		return nil, l.readErrString(errOut)
	}
	if errOut != nil {
		message := l.readErrString(errOut)
		C.arena_call_free(l.stringFreeFn, unsafe.Pointer(result))
		return nil, message
	}
	// Rust returns a heap-owned JSON string (currently "ok"); the Go interface
	// only needs success/failure, so release it immediately. The interface caller
	// ignores the success pointer and keys exclusively on errOut.
	C.arena_call_free(l.stringFreeFn, unsafe.Pointer(result))
	return nil, ""
}

func (l *ffiLibLinux) freePlanner(handle unsafe.Pointer) {
	if handle != nil && l.freePlannerFn != nil {
		C.arena_call_free(l.freePlannerFn, handle)
	}
}

func (l *ffiLibLinux) free(ptr unsafe.Pointer) {
	if ptr != nil && l.stringFreeFn != nil {
		C.arena_call_free(l.stringFreeFn, ptr)
	}
}

func (l *ffiLibLinux) close() {
	if l.handle != nil {
		C.dlclose(l.handle)
		l.handle = nil
	}
	l.newPlannerFn = nil
	l.decideFn = nil
	l.applyDirectiveFn = nil
	l.freePlannerFn = nil
	l.stringFreeFn = nil
}

// 平台实现必须满足 ffiLib 接口（编译期断言）。
var _ ffiLib = (*ffiLibLinux)(nil)

func (l *ffiLibLinux) readErrString(errOut *C.char) string {
	if errOut == nil {
		return ""
	}
	msg := C.GoString(errOut)
	if l.stringFreeFn != nil {
		C.arena_call_free(l.stringFreeFn, unsafe.Pointer(errOut))
	}
	return msg
}
