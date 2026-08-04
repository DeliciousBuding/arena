package ops

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// --- 测试辅助 ---

// writeLockFile 直接伪造锁文件（不经 Acquire），用于构造外部持有者、
// 死 PID、陈旧时间戳等测试场景。startedAt 只写入内容字段，不影响 mtime；
// 需要伪造 age 时用 ageFile 改 mtime。
func writeLockFile(t *testing.T, path string, pid int, startedAt time.Time, owner string) {
	t.Helper()
	content := lockContent{PID: pid, StartedAt: startedAt.UTC().Format(time.RFC3339), Owner: owner}
	data, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// ageFile 用 os.Chtimes 把锁文件 mtime 伪造成 age 之前（不依赖真实 sleep）。
func ageFile(t *testing.T, path string, age time.Duration) {
	t.Helper()
	old := time.Now().Add(-age)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

func waitForFile(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func waitForFileGone(t *testing.T, path string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s to disappear", path)
}

// --- 正常获取/释放/重取 ---

func TestAcquireReleaseReacquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t1.lock")
	swl := New()
	lock, err := swl.Acquire(path, "t1-live")
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("lock file must exist after acquire: %v", err)
	}
	if !bytes.Contains(data, []byte(strconv.Itoa(os.Getpid()))) {
		t.Fatalf("lock content must contain own pid, got %q", data)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file must disappear after release, stat err = %v", err)
	}
	again, err := swl.Acquire(path, "t1-live")
	if err != nil {
		t.Fatalf("re-acquire after release: %v", err)
	}
	if err := again.Release(); err != nil {
		t.Fatal(err)
	}
}

// --- 锁文件内容格式 ---

func TestLockContentFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fmt.lock")
	owner := "t3-live"
	lock, err := New().Acquire(path, owner)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	trimmed := bytes.TrimSpace(data)
	if bytes.ContainsAny(trimmed, "\r\n") {
		t.Fatalf("lock content must be a single line, got %q", data)
	}
	var raw map[string]any
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		t.Fatalf("lock content must be JSON: %v (%q)", err, data)
	}
	if len(raw) != 3 {
		t.Fatalf("lock content must have exactly pid/startedAt/owner, got %v", raw)
	}
	if pid, ok := raw["pid"].(float64); !ok || int(pid) != os.Getpid() {
		t.Fatalf("pid field must be own pid, got %v", raw["pid"])
	}
	startedAtStr, ok := raw["startedAt"].(string)
	if !ok {
		t.Fatalf("startedAt must be a string, got %v", raw["startedAt"])
	}
	startedAt, err := time.Parse(time.RFC3339, startedAtStr)
	if err != nil {
		t.Fatalf("startedAt must be RFC3339: %v", err)
	}
	if startedAt.IsZero() {
		t.Fatal("startedAt must not be zero")
	}
	if raw["owner"] != owner {
		t.Fatalf("owner field = %v, want %q", raw["owner"], owner)
	}
}

// --- 同进程二次 Acquire ---

func TestAcquireTwiceSameProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "twice.lock")
	swl := New()
	first, err := swl.Acquire(path, "twice-owner")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Release()

	_, err = swl.Acquire(path, "twice-owner")
	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("second acquire must fail with ErrLockHeld, got %v", err)
	}
	var held *LockHeldError
	if !errors.As(err, &held) {
		t.Fatalf("expected *LockHeldError, got %T", err)
	}
	if held.PID != os.Getpid() || held.Owner != "twice-owner" || held.Path != path {
		t.Fatalf("holder info mismatch: %+v", held)
	}
	if held.StartedAt.IsZero() {
		t.Fatal("holder info must include startedAt")
	}
	for _, want := range []string{path, strconv.Itoa(os.Getpid()), "twice-owner"} {
		if msg := held.Error(); !strings.Contains(msg, want) {
			t.Fatalf("LockHeldError message must mention %q, got %q", want, msg)
		}
	}
}

// --- 双进程（go test helper 子进程模式）---

const (
	helperEnvVar       = "GO_WANT_ARENA_OPS_HELPER"
	helperLockPathEnv  = "ARENA_OPS_HELPER_LOCK_PATH"
	helperOwnerEnvVar  = "ARENA_OPS_HELPER_OWNER"
	helperCmdRelease   = "release"
	helperMarkerLocked = "LOCKED"
	helperMarkerDone   = "RELEASED"
)

// TestHelperProcess 是子进程 helper 入口（go test 惯例的 TestHelperProcess
// 模式）：父测试通过 os/exec 以 -test.run=^TestHelperProcess$ 重新运行本
// 测试二进制并设置 helperEnvVar=1。helper 用真实 SingleWriterLock 拿到锁后
// 向 stdout 打印 LOCKED，随后阻塞等待 stdin 上的 release 命令，释放后打印
// RELEASED 并退出。正常测试运行（env 未设置）时立即返回，不执行任何逻辑。
func TestHelperProcess(t *testing.T) {
	if os.Getenv(helperEnvVar) != "1" {
		return
	}
	path := os.Getenv(helperLockPathEnv)
	lock, err := New().Acquire(path, os.Getenv(helperOwnerEnvVar))
	if err != nil {
		fmt.Fprintf(os.Stderr, "helper acquire %s: %v\n", path, err)
		os.Exit(1)
	}
	fmt.Println(helperMarkerLocked)
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() || scanner.Text() != helperCmdRelease {
		fmt.Fprintf(os.Stderr, "helper: expected %q command, got %q\n", helperCmdRelease, scanner.Text())
		os.Exit(2)
	}
	if err := lock.Release(); err != nil {
		fmt.Fprintf(os.Stderr, "helper release: %v\n", err)
		os.Exit(3)
	}
	fmt.Println(helperMarkerDone)
}

// TestHelperProcessLockHandover 双进程锁语义：子进程先拿锁 → 父进程
// Acquire 得到 LockHeldError（持有者信息 = 子进程 PID/owner）→ 子进程
// Release → 父进程 Acquire 成功。进程间协调用 stdin/stdout 命令握手，
// 父进程侧用轮询等待锁文件出现，不依赖真实 sleep。
func TestHelperProcessLockHandover(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "t3.lock")
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(),
		helperEnvVar+"=1",
		helperLockPathEnv+"="+lockPath,
		helperOwnerEnvVar+"=child-live",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})
	waitForFile(t, lockPath, 15*time.Second)

	swl := New()
	lock, err := swl.Acquire(lockPath, "parent-live")
	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("expected LockHeldError while child holds lock, got %v (child stderr: %s)", err, stderr.String())
	}
	var held *LockHeldError
	if !errors.As(err, &held) {
		t.Fatalf("expected *LockHeldError, got %T", err)
	}
	if held.PID != cmd.Process.Pid {
		t.Fatalf("holder pid = %d, want child pid %d", held.PID, cmd.Process.Pid)
	}
	if held.Owner != "child-live" {
		t.Fatalf("holder owner = %q, want child-live", held.Owner)
	}

	if _, err := io.WriteString(stdin, helperCmdRelease+"\n"); err != nil {
		t.Fatal(err)
	}
	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("child failed: %v (stderr: %s)", err, stderr.String())
	}
	waitForFileGone(t, lockPath, 15*time.Second)

	lock, err = swl.Acquire(lockPath, "parent-live")
	if err != nil {
		t.Fatalf("parent must acquire after child release: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

// --- BreakStale：age 防护与清理 ---

func TestBreakStaleFreshRefusedThenOldAllowed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stale.lock")
	swl := New()
	writeLockFile(t, path, 999999, time.Now(), "dead-owner")

	lock, err := swl.Acquire(path, "breaker")
	if err == nil {
		t.Fatal("acquire must fail on existing lock file")
	}
	if lock == nil {
		t.Fatal("expected non-nil lock handle on lock-file errors (for BreakStale)")
	}
	// 未持有的句柄 Release 必须是无害 no-op，文件保留。
	if err := lock.Release(); err != nil {
		t.Fatalf("release of unheld handle: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("release must not remove a lock we never held")
	}
	// 太新的锁拒绝 stale 清理（防误判刚崩溃的进程 / PID 复用窗口）。
	breakErr := lock.BreakStale()
	if !errors.Is(breakErr, ErrLockTooFresh) {
		t.Fatalf("fresh lock must refuse stale cleanup, got %v", breakErr)
	}
	var tooFresh *LockTooFreshError
	if !errors.As(breakErr, &tooFresh) {
		t.Fatalf("expected *LockTooFreshError, got %T", breakErr)
	}
	if tooFresh.Age >= tooFresh.MinAge {
		t.Fatalf("age %v must be below min %v", tooFresh.Age, tooFresh.MinAge)
	}
	if msg := tooFresh.Error(); !strings.Contains(msg, path) {
		t.Fatalf("LockTooFreshError message must mention the lock path, got %q", msg)
	}
	// mtime 伪造成 2 小时前 → 判定为 stale，且清理放行。
	ageFile(t, path, 2*time.Hour)
	if _, err := swl.Acquire(path, "breaker"); !errors.Is(err, ErrStaleLock) {
		t.Fatalf("dead owner with old lock must be stale, got %v", err)
	}
	if err := lock.BreakStale(); err != nil {
		t.Fatalf("BreakStale after aging: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("lock file must be gone after BreakStale")
	}
	got, err := swl.Acquire(path, "breaker")
	if err != nil {
		t.Fatalf("acquire after BreakStale: %v", err)
	}
	if err := got.Release(); err != nil {
		t.Fatal(err)
	}
}

// TestBreakStaleRechecksOwnerLiveness 验证 BreakStale 不会清理仍存活的
// 持有者：用我们自己的 PID（必然存活）伪造 2 小时前的锁。Unix 上再次探测
// PID 发现仍存活 → 拒绝（*LockHeldError）；Windows 无 PID 探测手段，age
// 超阈值即视为 stale（文档化平台局限），允许清理。
func TestBreakStaleRechecksOwnerLiveness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.lock")
	writeLockFile(t, path, os.Getpid(), time.Now(), "still-alive")
	ageFile(t, path, 2*time.Hour)

	err := (&Lock{path: path}).BreakStale()
	if runtime.GOOS == "windows" {
		if err != nil {
			t.Fatalf("windows age rule should allow cleanup, got %v", err)
		}
		if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatal("windows: lock file should have been removed")
		}
		return
	}
	if !errors.Is(err, ErrLockHeld) {
		t.Fatalf("live owner must block cleanup, got %v", err)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatal("lock file must survive BreakStale on a live owner")
	}
}

// --- Release 不误删 ---

func TestReleaseDoesNotDeleteForeignLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreign.lock")
	lock, err := New().Acquire(path, "me")
	if err != nil {
		t.Fatal(err)
	}
	// 锁文件内容被另一个进程接管。
	writeLockFile(t, path, 424242, time.Now(), "someone-else")

	err = lock.Release()
	if !errors.Is(err, ErrLockNotOurs) {
		t.Fatalf("release of foreign lock must fail with ErrLockNotOurs, got %v", err)
	}
	var notOurs *LockNotOursError
	if !errors.As(err, &notOurs) {
		t.Fatalf("expected *LockNotOursError, got %T", err)
	}
	if msg := notOurs.Error(); !strings.Contains(msg, path) {
		t.Fatalf("LockNotOursError message must mention the lock path, got %q", msg)
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("foreign lock file must be preserved, stat err = %v", statErr)
	}
}

// --- 路径不存在 ---

func TestAcquireMissingDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "no-such-dir", "t.lock")
	lock, err := New().Acquire(path, "x")
	if err == nil {
		t.Fatal("acquire into missing directory must fail")
	}
	if lock != nil {
		t.Fatal("lock must be nil on non-lock errors")
	}
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected ErrNotExist, got %v", err)
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("error must name the lock path, got %v", err)
	}
}

// --- fail-closed：不可读/损坏的锁 ---

func TestAcquireCorruptLockFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt.lock")
	// 非 JSON 内容。
	if err := os.WriteFile(path, []byte("not json at all\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lock, err := New().Acquire(path, "x")
	if err == nil {
		t.Fatal("corrupt lock must fail closed")
	}
	if lock != nil {
		t.Fatal("lock must be nil on unreadable-lock errors")
	}
	if !errors.Is(err, ErrLockUnreadable) {
		t.Fatalf("expected ErrLockUnreadable, got %v", err)
	}
	if errors.Is(err, ErrLockHeld) || errors.Is(err, ErrStaleLock) {
		t.Fatal("corrupt lock must not be classified as held or stale")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("error must name the lock path, got %v", err)
	}
	if data, readErr := os.ReadFile(path); readErr != nil || string(data) != "not json at all\n" {
		t.Fatal("corrupt lock file must remain untouched")
	}
	// BreakStale 同样 fail-closed：无法验证持有者，拒绝删除。
	if err := (&Lock{path: path}).BreakStale(); !errors.Is(err, ErrLockUnreadable) {
		t.Fatalf("BreakStale on corrupt lock must refuse, got %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("corrupt lock file must survive BreakStale")
	}

	// 合法 JSON 但 pid 非法（<= 0）同样 fail-closed。
	badPID := filepath.Join(t.TempDir(), "badpid.lock")
	writeLockFile(t, badPID, 0, time.Now(), "bad")
	if _, err := New().Acquire(badPID, "x"); !errors.Is(err, ErrLockUnreadable) {
		t.Fatalf("lock with invalid pid must fail closed, got %v", err)
	}
}

// TestReleaseCorruptLockFailsClosed 验证 Release 遇到损坏的锁内容时
// fail-closed：不删除文件，返回 ErrLockUnreadable。
func TestReleaseCorruptLockFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt-release.lock")
	lock, err := New().Acquire(path, "x")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); !errors.Is(err, ErrLockUnreadable) {
		t.Fatalf("release of corrupt lock must fail closed, got %v", err)
	}
	if data, readErr := os.ReadFile(path); readErr != nil || string(data) != "garbage" {
		t.Fatal("corrupt lock file must survive Release")
	}
}

// --- 幂等性 ---

func TestReleaseIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "idem.lock")
	lock, err := New().Acquire(path, "idem")
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("double release must be a no-op, got %v", err)
	}
	// 从未持锁的句柄 Release 也是 no-op。
	ghost := &Lock{path: filepath.Join(t.TempDir(), "ghost.lock")}
	if err := ghost.Release(); err != nil {
		t.Fatalf("release of never-held lock must be a no-op, got %v", err)
	}
}

func TestBreakStaleWithoutLockFile(t *testing.T) {
	lock := &Lock{path: filepath.Join(t.TempDir(), "missing.lock")}
	if err := lock.BreakStale(); err != nil {
		t.Fatalf("BreakStale without lock file must succeed, got %v", err)
	}
}

// --- 并发唯一性：文件系统原子性是唯一互斥源 ---

// TestConcurrentAcquireSingleWinner 用 8 个 goroutine 同时争抢同一锁路径
// （无任何进程内互斥），断言恰好一个成功、其余全部 LockHeldError。赢家
// 一直持有锁直到所有结果收齐（期间锁文件必然存在，检查方不会遇到
// ENOENT 竞争窗口），收齐后才 Release，避免 Windows 上删除与并发读取
// 的 sharing violation 干扰断言本身。
func TestConcurrentAcquireSingleWinner(t *testing.T) {
	type acquireResult struct {
		lock *Lock
		err  error
	}
	path := filepath.Join(t.TempDir(), "race.lock")
	const n = 8
	results := make(chan acquireResult, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		go func() {
			<-start
			lock, err := New().Acquire(path, "concurrent")
			results <- acquireResult{lock: lock, err: err}
		}()
	}
	close(start)

	var winner *Lock
	winners, held := 0, 0
	for i := 0; i < n; i++ {
		res := <-results
		switch {
		case res.err == nil:
			winners++
			winner = res.lock
		case errors.Is(res.err, ErrLockHeld):
			held++
		default:
			t.Fatalf("unexpected acquire result: %v", res.err)
		}
	}
	if winners != 1 || held != n-1 {
		t.Fatalf("want 1 winner and %d held losers, got %d winners / %d held", n-1, winners, held)
	}
	if winner == nil {
		t.Fatal("missing winner lock handle")
	}
	if err := winner.Release(); err != nil {
		t.Fatalf("winner release: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("winner must have released the lock")
	}
}

// --- 平台策略（stale 判定） ---

// TestStaleDetectionPlatformStrategy 断言各平台的 stale 判定策略：
// Unix 以 PID 存活为准（与锁文件 age 无关）；Windows 无标准库 PID 探测，
// 以锁文件 age > 10 分钟为准（新锁一律保守视为活锁）。
func TestStaleDetectionPlatformStrategy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "strategy.lock")
	swl := New()
	if runtime.GOOS == "windows" {
		writeLockFile(t, path, 999999, time.Now(), "dead-owner")
		if _, err := swl.Acquire(path, "strategy"); !errors.Is(err, ErrLockHeld) {
			t.Fatalf("windows: fresh lock must be presumed held, got %v", err)
		}
		ageFile(t, path, 2*time.Hour)
		lock, err := swl.Acquire(path, "strategy")
		if !errors.Is(err, ErrStaleLock) {
			t.Fatalf("windows: lock older than 10min must be stale, got %v", err)
		}
		var stale *StaleLockError
		if !errors.As(err, &stale) {
			t.Fatalf("expected *StaleLockError, got %T", err)
		}
		if stale.PID != 999999 || stale.Owner != "dead-owner" {
			t.Fatalf("stale error must carry holder info: %+v", stale)
		}
		if msg := stale.Error(); !strings.Contains(msg, strconv.Itoa(stale.PID)) {
			t.Fatalf("StaleLockError message must mention the owner pid, got %q", msg)
		}
		if stale.Age < 30*time.Minute {
			t.Fatalf("stale age must reflect aged mtime, got %v", stale.Age)
		}
		if err := lock.BreakStale(); err != nil {
			t.Fatalf("windows: BreakStale must follow the age rule: %v", err)
		}
		return
	}
	writeLockFile(t, path, 999999, time.Now(), "dead-owner")
	_, err := swl.Acquire(path, "strategy")
	if !errors.Is(err, ErrStaleLock) {
		t.Fatalf("unix: dead owner pid must be stale regardless of age, got %v", err)
	}
	var stale *StaleLockError
	if !errors.As(err, &stale) || stale.PID != 999999 {
		t.Fatalf("stale error must carry holder info: %v", err)
	}
	if msg := stale.Error(); !strings.Contains(msg, strconv.Itoa(stale.PID)) {
		t.Fatalf("StaleLockError message must mention the owner pid, got %q", msg)
	}
}

// TestRemoveLockFileBlockedByOpenHandle 验证删除锁文件时对并发打开句柄的
// 处理：Windows 上 os.Remove 在文件仍被读取句柄打开时因 sharing violation
// 失败（Unix 的 unlink 不受已打开句柄影响）。Windows 上 Release/BreakStale
// 应重试后报错且文件保留，句柄关闭后重试成功；Unix 上直接成功。该行为是
// removeLockFile 短促重试的实际依据（同进程并发测试曾真实触发此问题）。
func TestRemoveLockFileBlockedByOpenHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "blocked.lock")
	lock, err := New().Acquire(path, "blocked")
	if err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()

	err = lock.Release()
	if runtime.GOOS == "windows" {
		if err == nil {
			t.Fatal("windows: remove must fail while a read handle is open")
		}
		if _, statErr := os.Stat(path); statErr != nil {
			t.Fatal("blocked lock file must remain")
		}
		handle.Close()
		if err := lock.Release(); err != nil {
			t.Fatalf("release after handle close: %v", err)
		}
	} else {
		if err != nil {
			t.Fatalf("unix: unlink must succeed with open handles, got %v", err)
		}
		if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatal("lock file must be gone")
		}
	}

	// BreakStale 的删除路径同样依赖 removeLockFile 的重试语义。
	stalePath := filepath.Join(t.TempDir(), "blocked-stale.lock")
	writeLockFile(t, stalePath, 999999, time.Now(), "dead")
	ageFile(t, stalePath, 2*time.Hour)
	staleHandle, err := os.Open(stalePath)
	if err != nil {
		t.Fatal(err)
	}
	defer staleHandle.Close()

	err = (&Lock{path: stalePath}).BreakStale()
	if runtime.GOOS == "windows" {
		if err == nil {
			t.Fatal("windows: stale removal must fail while a read handle is open")
		}
		if _, statErr := os.Stat(stalePath); statErr != nil {
			t.Fatal("blocked stale lock must remain")
		}
		staleHandle.Close()
		if err := (&Lock{path: stalePath}).BreakStale(); err != nil {
			t.Fatalf("BreakStale after handle close: %v", err)
		}
	} else {
		if err != nil {
			t.Fatalf("unix: unlink must succeed with open handles, got %v", err)
		}
		if _, statErr := os.Stat(stalePath); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatal("stale lock file must be gone")
		}
	}
}
