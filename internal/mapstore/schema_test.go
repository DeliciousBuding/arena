package mapstore

// 表存在性 / 列约束错误的清晰错误断言：
// 破坏 schema 后，存储 API 与裸 SQL 都要返回可定位的错误信息。

import (
	"strings"
	"testing"
)

// TestSchemaErrorsAreClear 表被删除后，GetSnapshot / ApplyMutations 返回
// 带操作上下文与 SQLite 原始信息的错误；裸 SQL 的列约束违规同样清晰。
func TestSchemaErrorsAreClear(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1},
	}); err != nil {
		t.Fatalf("seed mutation: %v", err)
	}

	// 表存在性：删掉 objects 表后，读写都要报“no such table: objects”。
	if _, err := store.db.Exec("DROP TABLE objects"); err != nil {
		t.Fatalf("DROP TABLE objects: %v", err)
	}
	if _, err := store.GetSnapshot(); err == nil {
		t.Fatal("GetSnapshot after DROP TABLE succeeded, want error")
	} else if !strings.Contains(err.Error(), "no such table") || !strings.Contains(err.Error(), "objects") {
		t.Fatalf("GetSnapshot error = %q, want mention of no such table + objects", err)
	}
	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o2", X: 2, Y: 2},
	}); err == nil {
		t.Fatal("ApplyMutations after DROP TABLE succeeded, want error")
	} else if !strings.Contains(err.Error(), "no such table") || !strings.Contains(err.Error(), "objects") {
		t.Fatalf("ApplyMutations error = %q, want mention of no such table + objects", err)
	}

	// 重建 objects 表，继续验证列级约束错误。
	if _, err := store.db.Exec(createObjectsSQL); err != nil {
		t.Fatalf("recreate objects table: %v", err)
	}

	// 列约束：不存在的列名报“no such column”。
	if _, err := store.db.Exec(
		"INSERT INTO objects (kind, id, wrong_column) VALUES ('obstacle', 'x1', 1)",
	); err == nil {
		t.Fatal("INSERT with unknown column succeeded, want error")
	} else if !strings.Contains(err.Error(), "no column named") || !strings.Contains(err.Error(), "wrong_column") {
		t.Fatalf("unknown column error = %q, want mention of no column named + column name", err)
	}

	// 列约束：NOT NULL 违规报“NOT NULL constraint failed: objects.<列>”。
	if _, err := store.db.Exec(
		"INSERT INTO objects (id, x, y) VALUES ('x2', 1, 1)",
	); err == nil {
		t.Fatal("INSERT omitting NOT NULL column succeeded, want error")
	} else if !strings.Contains(err.Error(), "NOT NULL constraint failed") || !strings.Contains(err.Error(), "objects.kind") {
		t.Fatalf("NOT NULL error = %q, want mention of NOT NULL constraint failed + objects.kind", err)
	}

	// 列约束：主键重复报“UNIQUE constraint failed”。
	if _, err := store.db.Exec(
		"INSERT INTO objects (kind, id, x, y, revision) VALUES ('obstacle', 'dup', 0, 0, 1)",
	); err != nil {
		t.Fatalf("first raw insert: %v", err)
	}
	if _, err := store.db.Exec(
		"INSERT INTO objects (kind, id, x, y, revision) VALUES ('obstacle', 'dup', 1, 1, 1)",
	); err == nil {
		t.Fatal("duplicate primary key insert succeeded, want error")
	} else if !strings.Contains(err.Error(), "UNIQUE constraint failed") || !strings.Contains(err.Error(), "objects.kind") {
		t.Fatalf("unique error = %q, want mention of UNIQUE constraint failed + objects.kind", err)
	}
}

// TestCurrentRevisionCorruptionError revisions 单行表被删后，
// CurrentRevision 返回明确错误（而非静默 0）。
func TestCurrentRevisionCorruptionError(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	if _, err := store.db.Exec("DELETE FROM revisions"); err != nil {
		t.Fatalf("DELETE FROM revisions: %v", err)
	}
	_, err := store.CurrentRevision()
	if err == nil {
		t.Fatal("CurrentRevision after revisions row deleted succeeded, want error")
	}
	if !strings.Contains(err.Error(), "revisions row missing") {
		t.Fatalf("CurrentRevision error = %q, want mention of revisions row missing", err)
	}
}
