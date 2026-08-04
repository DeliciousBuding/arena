package mapstore

// 建库后 WAL 模式与连接级 PRAGMA 的直接断言（直接查库验证，不经过业务层）。

import (
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// openTestStore 在临时目录打开一个全新 Store，并注册清理。
func openTestStore(t *testing.T, opts ...Option) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mapstore.db")
	store, err := Open(path, opts...)
	if err != nil {
		t.Fatalf("Open(%q) error: %v", path, err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// assertPragma 断言连接上的 PRAGMA 字符串值。
func assertPragma(t *testing.T, db *sql.DB, name, want string) {
	t.Helper()
	var got string
	if err := db.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %q, want %q", name, got, want)
	}
}

// assertPragmaInt 断言连接上的 PRAGMA 整数值。
func assertPragmaInt(t *testing.T, db *sql.DB, name string, want int64) {
	t.Helper()
	var got int64
	if err := db.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
		t.Fatalf("PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %d, want %d", name, got, want)
	}
}

// TestOpenSetsWALModeAndConnectionPragmas 直接查库断言：建库后
// journal_mode=wal、busy_timeout=5000ms、foreign_keys=on、
// synchronous=NORMAL(1)，且 objects/revisions 两张表存在，revision 起点为 0。
func TestOpenSetsWALModeAndConnectionPragmas(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	assertPragma(t, store.db, "journal_mode", "wal")
	assertPragmaInt(t, store.db, "busy_timeout", int64(DefaultBusyTimeout.Milliseconds()))
	assertPragmaInt(t, store.db, "synchronous", 1) // NORMAL
	assertPragmaInt(t, store.db, "foreign_keys", 1)

	for _, table := range []string{"objects", "revisions"} {
		var name string
		err := store.db.QueryRow(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table,
		).Scan(&name)
		if err != nil {
			t.Fatalf("table %q missing after Open: %v", table, err)
		}
	}

	rev, err := store.CurrentRevision()
	if err != nil || rev != 0 {
		t.Fatalf("CurrentRevision() = %d, %v; want 0, nil", rev, err)
	}
}

// TestOpenReusesExistingDatabase 再次打开同一文件：数据与 revision 持久。
func TestOpenReusesExistingDatabase(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "persist.db")

	first, err := Open(path)
	if err != nil {
		t.Fatalf("first Open(%q): %v", path, err)
	}
	if _, err := first.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 3, Y: 4, Data: []byte("payload")},
	}); err != nil {
		t.Fatalf("ApplyMutations: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	second, err := Open(path)
	if err != nil {
		t.Fatalf("second Open(%q): %v", path, err)
	}
	defer second.Close()

	snap, err := second.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	want := map[string]Object{
		ObjectKey("obstacle", "o1"): {Kind: "obstacle", ID: "o1", X: 3, Y: 4, Revision: 1, Data: []byte("payload")},
	}
	if !reflect.DeepEqual(snap, want) {
		t.Fatalf("snapshot after reopen = %v, want %v", snap, want)
	}
	rev, err := second.CurrentRevision()
	if err != nil || rev != 1 {
		t.Fatalf("CurrentRevision() = %d, %v; want 1, nil", rev, err)
	}
}

// TestOpenRejectsNonDatabaseFile 非 SQLite 文件给出清晰错误。
func TestOpenRejectsNonDatabaseFile(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "garbage.db")
	if err := os.WriteFile(path, []byte("this is not a sqlite database"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	store, err := Open(path)
	if err == nil {
		store.Close()
		t.Fatalf("Open(garbage file) succeeded, want error")
	}
	if !strings.Contains(err.Error(), "not a database") {
		t.Fatalf("error = %q, want mention of \"not a database\"", err)
	}
}

// TestOpenRejectsNonPositiveBusyTimeout 非法 busy timeout 在 Open 阶段报错。
func TestOpenRejectsNonPositiveBusyTimeout(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "bad-option.db")
	store, err := Open(path, WithBusyTimeout(0))
	if err == nil {
		store.Close()
		t.Fatalf("Open with zero busy timeout succeeded, want error")
	}
	if !strings.Contains(err.Error(), "busy timeout") {
		t.Fatalf("error = %q, want mention of busy timeout", err)
	}
}
