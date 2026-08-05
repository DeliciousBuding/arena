//go:build linux

// Linux 平台动态库加载（cgo dlopen/dlsym）。
// 内存契约同 windows 版：输入串 C.CBytes（cgo 保活）；返回串/err_out
// 经 `arena_string_free` 释放。

package strategy

/*
#cgo LDFLAGS: -ldl
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

typedef void* (*arena_new_fn)(const char*, char**);
typedef char* (*arena_decide_fn)(void*, const char*, char**);
typedef char* (*arena_directive_fn)(void*, const char*, char**);
typedef void (*arena_free_fn)(void*);
*/
import "C"

import "unsafe"

type ffiLibLinux struct {
	handle unsafe.Pointer // dlopen 句柄
	// 函数指针（dlsym 一次解析）。
	newPlannerFn   C.arena_new_fn
	decideFn       C.arena_decide_fn
	applyDirective C.arena_directive_fn
	freePlannerFn  C.arena_free_fn
	stringFreeFn   C.arena_free_fn
}

func openFFILib(path string) (*ffiLibLinux, error) {
	cPath := C.CString(path)
	defer C.free(unsafe.Pointer(cPath))
	handle := C.dlopen(cPath, C.RTLD_NOW|C.RTLD_LOCAL)
	if handle == nil {
		return nil, &libLoadError{msg: C.GoString(C.dlerror())}
	}
	lib := &ffiLibLinux{handle: handle}
	lib.newPlannerFn = C.arena_new_fn(C.dlsym(handle, C.CString("arena_planner_new")))
	lib.decideFn = C.arena_decide_fn(C.dlsym(handle, C.CString("arena_planner_decide")))
	lib.applyDirective = C.arena_directive_fn(C.dlsym(handle, C.CString("arena_planner_apply_directive")))
	lib.freePlannerFn = C.arena_free_fn(C.dlsym(handle, C.CString("arena_planner_free")))
	lib.stringFreeFn = C.arena_free_fn(C.dlsym(handle, C.CString("arena_string_free")))
	if lib.newPlannerFn == nil || lib.decideFn == nil || lib.freePlannerFn == nil || lib.stringFreeFn == nil {
		lib.close()
		return nil, &libLoadError{msg: C.GoString(C.dlerror())}
	}
	return lib, nil
}

type libLoadError struct{ msg string }

func (e *libLoadError) Error() string { return e.msg }

func (l *ffiLibLinux) newPlanner(configJSON []byte) (unsafe.Pointer, string) {
	cConfig := C.CBytes(append(append([]byte(nil), configJSON...), 0))
	defer C.free(cConfig)
	var errOut *C.char
	handle := l.newPlannerFn((*C.char)(cConfig), &errOut)
	if handle == nil {
		return nil, l.readErrString(errOut)
	}
	return handle, ""
}

func (l *ffiLibLinux) decide(handle unsafe.Pointer, stateJSON []byte) (unsafe.Pointer, string) {
	cState := C.CBytes(append(append([]byte(nil), stateJSON...), 0))
	defer C.free(cState)
	var errOut *C.char
	result := l.decideFn(handle, (*C.char)(cState), &errOut)
	if result == nil {
		return nil, l.readErrString(errOut)
	}
	return unsafe.Pointer(result), ""
}

func (l *ffiLibLinux) applyDirective(handle unsafe.Pointer, directiveJSON []byte) (unsafe.Pointer, string) {
	cDirective := C.CBytes(append(append([]byte(nil), directiveJSON...), 0))
	defer C.free(cDirective)
	var errOut *C.char
	result := l.applyDirective(handle, (*C.char)(cDirective), &errOut)
	if result == nil {
		return nil, l.readErrString(errOut)
	}
	l.stringFreeFn(result)
	return unsafe.Pointer(uintptr(1)), ""
}

func (l *ffiLibLinux) freePlanner(handle unsafe.Pointer) {
	if handle != nil {
		l.freePlannerFn(handle)
	}
}

func (l *ffiLibLinux) free(ptr unsafe.Pointer) {
	if ptr != nil {
		l.stringFreeFn(ptr)
	}
}

func (l *ffiLibLinux) close() {
	if l.handle != nil {
		C.dlclose(l.handle)
		l.handle = nil
	}
}

// 平台实现必须满足 ffiLib 接口（编译期断言）。
var _ ffiLib = (*ffiLibLinux)(nil)

func (l *ffiLibLinux) readErrString(errOut *C.char) string {
	if errOut == nil {
		return ""
	}
	msg := C.GoString(errOut)
	l.stringFreeFn(unsafe.Pointer(errOut))
	return msg
}
