package mapstore

// 并发与多进程测试：
//   - TestBusyTimeoutYieldsBusyError：写锁被占时 busy_timeout 生效（WAL 读不阻塞）；
//   - TestConcurrentWritersSameProcess：同进程多连接压力测试（无死锁/无数据丢失，
//     revision 全局唯一）；
//   - TestDualProcessConcurrency：os/exec 子进程 + 父进程对同一库文件并发读写
//     （含首开竞争），验证跨进程无死锁、无数据丢失。

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sqlite "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// TestBusyTimeoutYieldsBusyError 第二条连接持有写锁时，ApplyMutations
// 在 busy_timeout 到期后返回 SQLITE_BUSY；期间 WAL 读不受阻塞；
// 释放锁后重试成功。
func TestBusyTimeoutYieldsBusyError(t *testing.T) {
	store := openTestStore(t, WithBusyTimeout(50*time.Millisecond))

	holder, err := sql.Open("sqlite", store.path+"?_busy_timeout=50")
	if err != nil {
		t.Fatalf("open holder connection: %v", err)
	}
	defer holder.Close()
	holder.SetMaxOpenConns(1)

	tx, err := holder.Begin()
	if err != nil {
		t.Fatalf("holder Begin: %v", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE revisions SET current_revision = current_revision WHERE id = 1"); err != nil {
		t.Fatalf("holder write lock: %v", err)
	}

	// WAL 读快照不受写锁影响。
	if snap, err := store.GetSnapshot(); err != nil || len(snap) != 0 {
		t.Fatalf("GetSnapshot while lock held = %v, %v; want empty, nil", snap, err)
	}

	_, err = store.ApplyMutations([]Mutation{{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1}})
	var sqErr *sqlite.Error
	if !errors.As(err, &sqErr) || sqErr.Code() != sqlite3.SQLITE_BUSY {
		t.Fatalf("ApplyMutations while lock held: err = %v; want SQLITE_BUSY", err)
	}

	// 释放写锁后重试成功。
	if err := tx.Commit(); err != nil {
		t.Fatalf("holder Commit: %v", err)
	}
	rev, err := store.ApplyMutations([]Mutation{{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1}})
	if err != nil || rev != 1 {
		t.Fatalf("ApplyMutations after lock release = %d, %v; want 1, nil", rev, err)
	}
}

// TestConcurrentWritersSameProcess 8 个 goroutine 共享一个 Store 并发写入
// 200 个对象，再并发删除 100 个：无死锁、无数据丢失，且每个批次拿到
// 全局唯一的 revision（证明并发调用被 SQLite 事务串行化）。
func TestConcurrentWritersSameProcess(t *testing.T) {
	store := openTestStore(t)
	const workers, batchesPerWorker = 8, 25

	var (
		revMu     sync.Mutex
		revisions []int64
		errCh     = make(chan error, workers)
		wg        sync.WaitGroup
	)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for b := 0; b < batchesPerWorker; b++ {
				id := fmt.Sprintf("w%d-b%d", worker, b)
				rev, err := store.ApplyMutations([]Mutation{
					{Op: OpUpsert, Kind: "resource", ID: id, X: worker, Y: b},
				})
				if err != nil {
					errCh <- fmt.Errorf("worker %d batch %d: %w", worker, b, err)
					return
				}
				revMu.Lock()
				revisions = append(revisions, rev)
				revMu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Fatal(err)
	}

	const totalBatches = workers * batchesPerWorker
	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != totalBatches {
		t.Fatalf("data loss under concurrency: got %d objects, want %d", len(snap), totalBatches)
	}

	// 每个批次拿到的 revision 必须是 1..N 的排列（串行化分配）。
	seen := make(map[int64]bool, len(revisions))
	for _, rev := range revisions {
		if rev < 1 || rev > int64(len(revisions)) {
			t.Fatalf("revision %d out of range 1..%d", rev, len(revisions))
		}
		if seen[rev] {
			t.Fatalf("duplicate revision %d: concurrent batches were not serialized", rev)
		}
		seen[rev] = true
	}
	if len(seen) != len(revisions) {
		t.Fatalf("got %d distinct revisions, want %d", len(seen), len(revisions))
	}
	if rev, err := store.CurrentRevision(); err != nil || rev != totalBatches {
		t.Fatalf("CurrentRevision() = %d, %v; want %d, nil", rev, err, totalBatches)
	}

	// 阶段二：并发删除约一半对象。
	toDelete := make([]Mutation, 0, totalBatches/2)
	for w := 0; w < workers; w++ {
		for b := 0; b < batchesPerWorker; b++ {
			if (w+b)%2 == 0 {
				toDelete = append(toDelete, Mutation{Op: OpDelete, Kind: "resource", ID: fmt.Sprintf("w%d-b%d", w, b)})
			}
		}
	}
	deleteErrs := make(chan error, workers)
	chunk := (len(toDelete) + workers - 1) / workers
	deleteBatches := 0
	for i := 0; i < len(toDelete); i += chunk {
		end := i + chunk
		if end > len(toDelete) {
			end = len(toDelete)
		}
		batch := toDelete[i:end]
		deleteBatches++
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := store.ApplyMutations(batch); err != nil {
				deleteErrs <- err
			}
		}()
	}
	wg.Wait()
	close(deleteErrs)
	for err := range deleteErrs {
		t.Fatal(err)
	}

	snap, err = store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if want := totalBatches - len(toDelete); len(snap) != want {
		t.Fatalf("after concurrent deletes: got %d objects, want %d", len(snap), want)
	}
	// revision 按批次推进：删除阶段共 deleteBatches 个批次。
	if rev, err := store.CurrentRevision(); err != nil || rev != int64(totalBatches+deleteBatches) {
		t.Fatalf("CurrentRevision() = %d, %v; want %d, nil", rev, err, totalBatches+deleteBatches)
	}
}

// 双进程测试的子进程环境变量（仅在测试内部传递，不落盘任何凭据）。
const (
	childEnv = "ARENA_MAPSTORE_TEST_CHILD"
	childDB  = "ARENA_MAPSTORE_TEST_DB"
)

const (
	dualParentBatches = 20
	dualChildBatches  = 15
	dualPerBatch      = 10
)

// TestDualProcessConcurrency 通过 os/exec 重新执行当前测试二进制作为
// 子进程（-test.run 限定本测试 + 环境变量切换角色），父子进程对同一个
// 尚不存在的库文件并发首开、并发写入互不重叠的 ID 空间，最终断言：
// 无死锁、无数据丢失、revision 等于批次总数、WAL 依然生效。
func TestDualProcessConcurrency(t *testing.T) {
	if os.Getenv(childEnv) == "1" {
		runDualProcessChild(t)
		return
	}

	dbPath := filepath.Join(t.TempDir(), "shared.db")
	cmd := exec.Command(os.Args[0], "-test.run=^TestDualProcessConcurrency$", "-test.count=1")
	cmd.Env = append(os.Environ(), childEnv+"=1", childDB+"="+dbPath)
	var childOutput bytes.Buffer
	cmd.Stdout = &childOutput
	cmd.Stderr = &childOutput
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child process: %v", err)
	}

	// 让子进程先启动并（可能）先创建库文件，制造“并发首开”窗口。
	time.Sleep(1200 * time.Millisecond)
	store, err := Open(dbPath)
	if err != nil {
		cmd.Process.Kill()
		t.Fatalf("parent Open(%q): %v", dbPath, err)
	}
	defer store.Close()

	for b := 0; b < dualParentBatches; b++ {
		muts := make([]Mutation, dualPerBatch)
		for i := range muts {
			muts[i] = Mutation{Op: OpUpsert, Kind: "obstacle", ID: fmt.Sprintf("p-%d-%d", b, i), X: b, Y: i}
		}
		if _, err := store.ApplyMutations(muts); err != nil {
			t.Fatalf("parent batch %d: %v", b, err)
		}
		time.Sleep(2 * time.Millisecond)
	}

	waitCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var waitErr error
	select {
	case waitErr = <-done:
	case <-waitCtx.Done():
		cmd.Process.Kill()
		t.Fatalf("child process timed out; output:\n%s", childOutput.String())
	}
	if waitErr != nil {
		t.Fatalf("child process failed: %v\noutput:\n%s", waitErr, childOutput.String())
	}

	wantCount := (dualParentBatches + dualChildBatches) * dualPerBatch
	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != wantCount {
		t.Fatalf("cross-process data loss: got %d objects, want %d", len(snap), wantCount)
	}
	maxRev := int64(dualParentBatches + dualChildBatches)
	for key, obj := range snap {
		if !strings.Contains(key, "/") {
			t.Fatalf("object key %q does not encode kind/id", key)
		}
		if obj.Revision < 1 || obj.Revision > maxRev {
			t.Fatalf("object %q revision %d out of range 1..%d", key, obj.Revision, maxRev)
		}
	}
	if rev, err := store.CurrentRevision(); err != nil || rev != maxRev {
		t.Fatalf("CurrentRevision() = %d, %v; want %d, nil", rev, err, maxRev)
	}
	assertPragma(t, store.db, "journal_mode", "wal")
}

// runDualProcessChild 是双进程测试的子进程角色：与父进程并发写入独立
// ID 空间（resource 类），期间反复读快照（WAL 读不阻塞写），最后自检
// 自己的对象全部可读。
func runDualProcessChild(t *testing.T) {
	dbPath := os.Getenv(childDB)
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("child Open(%q): %v", dbPath, err)
	}
	defer store.Close()
	assertPragma(t, store.db, "journal_mode", "wal")

	for b := 0; b < dualChildBatches; b++ {
		muts := make([]Mutation, dualPerBatch)
		for i := range muts {
			muts[i] = Mutation{Op: OpUpsert, Kind: "resource", ID: fmt.Sprintf("c-%d-%d", b, i), X: b, Y: i}
		}
		if _, err := store.ApplyMutations(muts); err != nil {
			t.Fatalf("child batch %d: %v", b, err)
		}
		if _, err := store.GetSnapshot(); err != nil {
			t.Fatalf("child snapshot read: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("child final snapshot: %v", err)
	}
	for b := 0; b < dualChildBatches; b++ {
		for i := 0; i < dualPerBatch; i++ {
			id := fmt.Sprintf("c-%d-%d", b, i)
			obj, ok := snap[ObjectKey("resource", id)]
			if !ok {
				t.Fatalf("child: own object %q missing from snapshot", id)
			}
			if obj.X != b || obj.Y != i {
				t.Fatalf("child: object %q = %+v, want x=%d y=%d", id, obj, b, i)
			}
		}
	}
}
