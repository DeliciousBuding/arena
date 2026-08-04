// Package ops 是 Arena Go 版的运维原语：单写者锁（本文件），supervisor 与
// doctor 在后续阶段加入。
//
// 锁语义（docs/go/03-module-spec.md M11 + docs/go/00-intent.md 红线 1：
// 同一租户只能一个 live writer，拿不到锁直接失败退出，不降级）：
//   - 唯一互斥源是文件系统 O_CREATE|O_EXCL 原子创建，进程内不引入任何
//     内存锁——竞争进程与竞争 goroutine 由同一机制串行化；
//   - 锁内容 = 一行 JSON {"pid":..,"startedAt":"RFC3339","owner":".."}，
//     startedAt 与锁文件 mtime 共同构成 PID 复用陷阱防护；
//   - stale 锁（持有者已死）只报告 StaleLockError，绝不自动删除；由调用方
//     显式调用 BreakStale() 清理——安全优先，宁可拒启也不误删活锁；
//   - 无法读取/解析的锁一律 fail-closed：不判活、不判死、不清理。
//
// 进程存活检测：Unix 用 os.FindProcess + signal 0（ESRCH=已死，EPERM 等
// 权限错误保守视为存活）；Windows 标准库无可靠 PID 探测手段（os.FindProcess
// 不校验存在性、signal 0 是 POSIX 专属、OpenProcess 权限不足会误报"不存在"
// ——那是危险的误判方向），因此退化为纯 age 策略：锁文件 age > 10 分钟才
// 视为 stale（见 windowsStaleAge）。
package ops

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"
)

// 哨兵错误：配合 errors.Is / errors.As 使用；结构化错误类型携带持有者信息。
var (
	// ErrLockHeld 表示锁文件已存在且被判定为活锁。
	ErrLockHeld = errors.New("ops: lock file is held by a live owner")
	// ErrStaleLock 表示锁文件已存在但持有者已死（Windows 上为 age 超阈值），
	// 需调用方显式 BreakStale() 清理后重试。
	ErrStaleLock = errors.New("ops: lock file is stale (owner no longer alive)")
	// ErrLockTooFresh 表示锁文件太新，拒绝 stale 清理（防 PID 复用误判）。
	ErrLockTooFresh = errors.New("ops: lock file too young for stale cleanup")
	// ErrLockNotOurs 表示锁文件当前属于其他 PID，拒绝删除。
	ErrLockNotOurs = errors.New("ops: lock file is owned by a different pid")
	// ErrLockUnreadable 表示锁文件存在但无法读取/解析，fail-closed。
	ErrLockUnreadable = errors.New("ops: lock file exists but is unreadable or corrupt")

	// errPidProbeUnsupported 标记无法用 signal 0 探测 PID 的平台（Windows）。
	errPidProbeUnsupported = errors.New("ops: pid liveness probe unsupported on this platform")
)

// LockHeldError 携带活锁持有者信息，供调用方诊断与日志。
type LockHeldError struct {
	Path      string
	PID       int
	Owner     string
	StartedAt time.Time
}

func (e *LockHeldError) Error() string {
	return fmt.Sprintf("ops: lock %s held by live pid %d (owner %q, startedAt %s)",
		e.Path, e.PID, e.Owner, e.StartedAt.Format(time.RFC3339))
}

func (e *LockHeldError) Unwrap() error { return ErrLockHeld }

// StaleLockError 携带 stale 锁信息；Age 为检测时的锁文件 age。
type StaleLockError struct {
	Path      string
	PID       int
	Owner     string
	StartedAt time.Time
	Age       time.Duration
}

func (e *StaleLockError) Error() string {
	return fmt.Sprintf("ops: lock %s is stale (pid %d, owner %q, startedAt %s, age %s)",
		e.Path, e.PID, e.Owner, e.StartedAt.Format(time.RFC3339), e.Age)
}

func (e *StaleLockError) Unwrap() error { return ErrStaleLock }

// LockTooFreshError 表示 stale 清理被 age 防护拒绝。
type LockTooFreshError struct {
	Path   string
	Age    time.Duration
	MinAge time.Duration
}

func (e *LockTooFreshError) Error() string {
	return fmt.Sprintf("ops: lock %s too young for stale cleanup (age %s, min %s)",
		e.Path, e.Age, e.MinAge)
}

func (e *LockTooFreshError) Unwrap() error { return ErrLockTooFresh }

// LockNotOursError 表示释放时锁文件已属于其他 PID。
type LockNotOursError struct {
	Path     string
	FoundPID int
	OwnPID   int
}

func (e *LockNotOursError) Error() string {
	return fmt.Sprintf("ops: lock %s belongs to pid %d, not %d; refusing to delete",
		e.Path, e.FoundPID, e.OwnPID)
}

func (e *LockNotOursError) Unwrap() error { return ErrLockNotOurs }

// SingleWriterLock 是租户级单写者锁：同一路径同一时刻只允许一个 writer。
// 无内部状态，并发安全完全依赖文件系统 O_EXCL 原子创建，不使用任何
// 进程内锁——竞争进程与竞争 goroutine 由同一机制串行化。
type SingleWriterLock struct{}

// New 返回一个 SingleWriterLock。持有者标识 owner 在 Acquire 时传入并
// 写入锁文件，便于跨进程诊断持有者身份（如 "t3-live"）。
func New() *SingleWriterLock {
	return &SingleWriterLock{}
}

// maxAcquireAttempts 限制 O_EXCL 竞争窗口内的重试次数（对齐 TS 版 3 次
// 尝试语义）：仅当锁文件在"创建失败"与"检查"之间被他人移除（即锁已被
// 释放，检查时读到 ENOENT）才重试；业务错误（活锁/stale/不可读）一律
// 直接返回，不重试。
const maxAcquireAttempts = 3

// Acquire 以 O_CREATE|O_EXCL|O_WRONLY 原子创建锁文件 path，成功时返回
// 已持有锁的 *Lock（err 为 nil）。owner（如 "t3-live"）作为持有者标识
// 写入锁文件，供跨进程诊断。
//
// 失败分类：
//   - 锁已存在且判定为活锁 → *LockHeldError；
//   - 锁已存在但判定为 stale → *StaleLockError。
//
// 上述两类失败会返回非 nil 的 *Lock（未持有），供调用方对 stale 结果调用
// BreakStale() 清理后重试；其余错误（目录缺失、锁不可读等）一律返回 nil
// *Lock 并 fail-closed。锁模块从不自动删除任何锁文件——stale 清理必须由
// 调用方显式触发。
func (l *SingleWriterLock) Acquire(path, owner string) (*Lock, error) {
	for attempt := 0; ; attempt++ {
		lock, err := l.tryAcquire(path, owner)
		if err == nil || !errors.Is(err, os.ErrNotExist) || attempt == maxAcquireAttempts-1 {
			return lock, err
		}
	}
}

// tryAcquire 执行一次原子创建尝试。
func (l *SingleWriterLock) tryAcquire(path, owner string) (*Lock, error) {
	content := lockContent{
		PID:       os.Getpid(),
		StartedAt: time.Now().UTC().Format(time.RFC3339),
		Owner:     owner,
	}
	payload, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("ops: marshal lock content for %s: %w", path, err)
	}
	payload = append(payload, '\n')

	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return l.inspectExisting(path)
		}
		return nil, fmt.Errorf("ops: acquire lock %s: %w", path, err)
	}
	_, err = f.Write(payload)
	if err == nil {
		err = f.Close()
	}
	if err != nil {
		f.Close()
		removeLockFile(path)
		return nil, fmt.Errorf("ops: persist lock %s: %w", path, err)
	}
	return &Lock{path: path, pid: content.PID}, nil
}

// inspectExisting 解析已存在的锁文件并分类：活锁 / stale / fail-closed。
// 返回的 *Lock 未持有（pid 为 0），仅用于后续显式 BreakStale()。
func (l *SingleWriterLock) inspectExisting(path string) (*Lock, error) {
	existing, mtime, err := readLockFile(path)
	if err != nil {
		return nil, err // 无法读取 → fail-closed，不猜测死活
	}
	startedAt, _ := time.Parse(time.RFC3339, existing.StartedAt)
	age := time.Since(mtime)
	alive, known := pidAlive(existing.PID)
	if (known && alive) || (!known && age <= windowsStaleAge) {
		return &Lock{path: path}, &LockHeldError{
			Path: path, PID: existing.PID, Owner: existing.Owner, StartedAt: startedAt,
		}
	}
	return &Lock{path: path}, &StaleLockError{
		Path: path, PID: existing.PID, Owner: existing.Owner, StartedAt: startedAt, Age: age,
	}
}

// Lock 是一次 Acquire 的句柄。Acquire 成功时 pid 为本进程 PID；Acquire
// 因活锁/stale 失败时 pid 为 0（未持有），句柄只用于显式 BreakStale()。
type Lock struct {
	path string
	pid  int
}

// Release 释放锁：仅当锁文件内容仍是我们自己的 PID 才删除，防止误删他人
// 新建立的锁。文件已不存在 → 幂等成功；内容被他人接管 → *LockNotOursError
// 且文件保留；内容无法解析 → fail-closed 保留文件。未持有过锁的句柄调用
// Release 是安全的 no-op，绝不删除任何文件。
func (l *Lock) Release() error {
	if l.pid <= 0 {
		return nil
	}
	existing, _, err := readLockFile(l.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if existing.PID != l.pid {
		return &LockNotOursError{Path: l.path, FoundPID: existing.PID, OwnPID: l.pid}
	}
	if err := removeLockFile(l.path); err != nil {
		return fmt.Errorf("ops: release lock %s: %w", l.path, err)
	}
	return nil
}

// BreakStale 显式清理 stale 锁文件（调用方收到 StaleLockError 后调用）。
// 防护（安全优先，宁可拒删不可误删）：
//   - 锁文件 age 低于平台最小阈值 → *LockTooFreshError（Unix 60s 防误判
//     刚崩溃的进程，即 PID 复用窗口；Windows 10min，见 minStaleAge）；
//   - Unix 上再次探测持有 PID：若已复活（PID 被复用）→ *LockHeldError；
//   - 文件已不存在 → 幂等成功；无法解析 → fail-closed 保留文件。
func (l *Lock) BreakStale() error {
	existing, mtime, err := readLockFile(l.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	age := time.Since(mtime)
	minAge := minStaleAge()
	if age < minAge {
		return &LockTooFreshError{Path: l.path, Age: age, MinAge: minAge}
	}
	alive, known := pidAlive(existing.PID)
	if known && alive {
		startedAt, _ := time.Parse(time.RFC3339, existing.StartedAt)
		return &LockHeldError{
			Path: l.path, PID: existing.PID, Owner: existing.Owner, StartedAt: startedAt,
		}
	}
	if err := removeLockFile(l.path); err != nil {
		return fmt.Errorf("ops: remove stale lock %s: %w", l.path, err)
	}
	return nil
}

// removeLockFile 删除锁文件并容忍 Windows 的 sharing violation：文件仍被
// 并发读取方打开时 os.Remove 会短暂失败（Unix 的 unlink 不受已打开句柄
// 影响），因此短促重试数次以消除与并发读方的竞争窗口。重试只发生在删除
// 这一瞬态路径，不影响任何死活判定；最终仍失败则返回最后一次错误。
func removeLockFile(path string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		err = os.Remove(path)
		if err == nil || errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	return err
}

// 平台相关时间阈值。
const (
	// unixMinStaleAge：Unix 上 BreakStale 允许清理的最小锁文件 age。
	// 进程崩溃后 60s 内禁止清理，防止把刚崩溃的进程误判为可回收
	// （PID 复用窗口）。
	unixMinStaleAge = 60 * time.Second
	// windowsStaleAge：Windows 上视为 stale 的锁文件 age。Windows 标准库
	// 无法可靠探测任意 PID 存活（os.FindProcess 不校验存在性、signal 0
	// 是 POSIX 专属，OpenProcess 权限不足还会误报"不存在"——即把活锁误判
	// 成死锁，方向危险），因此退化为纯 age 策略：> 10 分钟才视为 stale。
	windowsStaleAge = 10 * time.Minute
)

// minStaleAge 返回当前平台 BreakStale 允许清理的最小锁文件 age。
func minStaleAge() time.Duration {
	if runtime.GOOS == "windows" {
		return windowsStaleAge
	}
	return unixMinStaleAge
}

// lockContent 是锁文件单行 JSON 内容，字段顺序 pid/startedAt/owner 固定。
type lockContent struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"startedAt"` // RFC3339（秒精度）
	Owner     string `json:"owner"`
}

// readLockFile 读取并解析锁文件，返回内容与文件 mtime（age 校验用）。
// 文件不存在 → 透传 os.ErrNotExist；存在但无法读取/解析/pid 非法 →
// 包装 ErrLockUnreadable（fail-closed：调用方不得据此判定活或死）。
func readLockFile(path string) (lockContent, time.Time, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return lockContent{}, time.Time{}, err
		}
		return lockContent{}, time.Time{}, fmt.Errorf("%w (%s): %v", ErrLockUnreadable, path, err)
	}
	var content lockContent
	if err := json.Unmarshal(bytes.TrimSpace(data), &content); err != nil || content.PID <= 0 {
		if err == nil {
			err = errors.New("missing or invalid pid field")
		}
		return lockContent{}, time.Time{}, fmt.Errorf("%w (%s): %v", ErrLockUnreadable, path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return lockContent{}, time.Time{}, err
		}
		return lockContent{}, time.Time{}, fmt.Errorf("%w (%s): %v", ErrLockUnreadable, path, err)
	}
	return content, info.ModTime(), nil
}

// probePid 平台相关的 PID 存活探测：Unix 用 os.FindProcess + signal 0；
// Windows 返回 errPidProbeUnsupported（无可靠标准库手段，见包文档）。
func probePid(pid int) error {
	if runtime.GOOS == "windows" {
		return errPidProbeUnsupported
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.Signal(0))
}

// pidAlive 判定 pid 是否存活：
//   - alive=true, known=true：确证存活（signal 0 成功，或 EPERM 等权限类
//     错误——进程存在只是无权限，保守视为存活）；
//   - alive=false, known=true：确证不存在（ESRCH / 句柄获取失败）；
//   - known=false：平台无法探测（Windows），调用方须回退 age 策略。
//
// 分类原则：任何不确定都向"活"倾斜（fail-closed），绝不把无法确证的
// 进程当作死锁回收。
func pidAlive(pid int) (alive, known bool) {
	probeErr := probePid(pid)
	if errors.Is(probeErr, errPidProbeUnsupported) {
		return false, false
	}
	if probeErr == nil {
		return true, true
	}
	if errors.Is(probeErr, os.ErrProcessDone) || errors.Is(probeErr, syscall.ESRCH) {
		return false, true
	}
	return true, true
}
