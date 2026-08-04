package mapstore

// 存储核心 API 测试：ApplyMutations / GetSnapshot / revision 语义 /
// 幂等 / 校验与错误。

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// TestGetSnapshotEmptyDatabase 新库快照为空 map（非 nil）。
func TestGetSnapshotEmptyDatabase(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)
	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if snap == nil || len(snap) != 0 {
		t.Fatalf("snapshot = %v, want empty non-nil map", snap)
	}
}

// TestApplyMutationsAndGetSnapshot 一批混合 mutation 后快照内容正确，
// 且所有对象行都打上该批次 revision（=1）。
func TestApplyMutationsAndGetSnapshot(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	muts := []Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 2},
		{Op: OpUpsert, Kind: "resource", ID: "r1", X: 3, Y: 4, Data: []byte(`{"amount":5}`)},
		{Op: OpUpsert, Kind: "allied", ID: "a1", X: 5, Y: 6},
	}
	rev, err := store.ApplyMutations(muts)
	if err != nil {
		t.Fatalf("ApplyMutations: %v", err)
	}
	if rev != 1 {
		t.Fatalf("first batch revision = %d, want 1", rev)
	}

	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	want := map[string]Object{
		ObjectKey("obstacle", "o1"): {Kind: "obstacle", ID: "o1", X: 1, Y: 2, Revision: 1, Data: []byte{}},
		ObjectKey("resource", "r1"): {Kind: "resource", ID: "r1", X: 3, Y: 4, Revision: 1, Data: []byte(`{"amount":5}`)},
		ObjectKey("allied", "a1"):   {Kind: "allied", ID: "a1", X: 5, Y: 6, Revision: 1, Data: []byte{}},
	}
	if !reflect.DeepEqual(snap, want) {
		t.Fatalf("snapshot = %v, want %v", snap, want)
	}
}

// TestRevisionMonotonicAcrossBatches 连续批次 revision 严格 +1 递增，
// CurrentRevision 与最后批次一致。
func TestRevisionMonotonicAcrossBatches(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	revisions := make([]int64, 0, 5)
	for i := 1; i <= 5; i++ {
		rev, err := store.ApplyMutations([]Mutation{
			{Op: OpUpsert, Kind: "obstacle", ID: fmt.Sprintf("o%d", i), X: i, Y: i},
		})
		if err != nil {
			t.Fatalf("batch %d: ApplyMutations: %v", i, err)
		}
		revisions = append(revisions, rev)
	}
	for i := 1; i < len(revisions); i++ {
		if revisions[i] != revisions[i-1]+1 {
			t.Fatalf("revisions not strictly +1: %v", revisions)
		}
	}
	if revisions[0] != 1 || revisions[len(revisions)-1] != 5 {
		t.Fatalf("revision range = %v, want 1..5", revisions)
	}

	rev, err := store.CurrentRevision()
	if err != nil || rev != 5 {
		t.Fatalf("CurrentRevision() = %d, %v; want 5, nil", rev, err)
	}
}

// TestApplyMutationsIdempotentSameBatch 同一批次重复应用：内容收敛
// （UPSERT 语义，无重复行），revision 继续单调递增。
func TestApplyMutationsIdempotentSameBatch(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	batch := []Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1, Data: []byte("v1")},
		{Op: OpUpsert, Kind: "resource", ID: "r1", X: 2, Y: 2},
	}
	rev1, err := store.ApplyMutations(batch)
	if err != nil {
		t.Fatalf("first apply: %v", err)
	}
	snap1, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}

	rev2, err := store.ApplyMutations(batch)
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}
	snap2, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}

	if !reflect.DeepEqual(contentOnly(snap1), contentOnly(snap2)) {
		t.Fatalf("re-applying same batch must converge (UPSERT):\n first = %v\nsecond = %v", snap1, snap2)
	}
	if len(snap2) != 2 {
		t.Fatalf("expected no duplicate rows, got %d objects", len(snap2))
	}
	if rev2 <= rev1 {
		t.Fatalf("revision must stay monotonic: first %d, second %d", rev1, rev2)
	}
	for key, obj := range snap2 {
		if obj.Revision != rev2 {
			t.Fatalf("object %q revision = %d, want batch revision %d", key, obj.Revision, rev2)
		}
	}
}

// contentOnly 去掉 Revision 元数据，用于断言内容收敛（UPSERT 幂等）。
func contentOnly(snap map[string]Object) map[string]Object {
	out := make(map[string]Object, len(snap))
	for key, o := range snap {
		o.Revision = 0
		out[key] = o
	}
	return out
}

// TestApplyMutationsUpsertOverwritesExisting 同 (kind, id) 再次 UPSERT：
// 覆盖旧值，行数不变，revision 更新。
func TestApplyMutationsUpsertOverwritesExisting(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1, Data: []byte("old")},
	}); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	rev2, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 9, Y: 9, Data: []byte("new")},
	})
	if err != nil {
		t.Fatalf("second apply: %v", err)
	}

	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	want := Object{Kind: "obstacle", ID: "o1", X: 9, Y: 9, Revision: rev2, Data: []byte("new")}
	if len(snap) != 1 || !reflect.DeepEqual(snap[ObjectKey("obstacle", "o1")], want) {
		t.Fatalf("snapshot = %v, want single object %v", snap, want)
	}
}

// TestApplyMutationsDelete 删除对象；删除不存在的对象是 no-op 成功。
func TestApplyMutationsDelete(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1},
		{Op: OpUpsert, Kind: "resource", ID: "r1", X: 2, Y: 2},
	}); err != nil {
		t.Fatalf("upsert batch: %v", err)
	}
	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpDelete, Kind: "obstacle", ID: "o1"},
	}); err != nil {
		t.Fatalf("delete batch: %v", err)
	}

	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != 1 || snap[ObjectKey("resource", "r1")].ID != "r1" {
		t.Fatalf("snapshot after delete = %v, want only resource r1", snap)
	}

	// 删除不存在的对象：成功且不改变快照。
	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpDelete, Kind: "obstacle", ID: "never-existed"},
	}); err != nil {
		t.Fatalf("delete missing object: %v", err)
	}
	snap, err = store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != 1 {
		t.Fatalf("snapshot after delete-missing = %v, want unchanged", snap)
	}
}

// TestApplyMutationsEmptyBatchNoop 空批次不推进 revision，也不改变快照。
func TestApplyMutationsEmptyBatchNoop(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	rev, err := store.ApplyMutations(nil)
	if err != nil || rev != 0 {
		t.Fatalf("ApplyMutations(nil) = %d, %v; want 0, nil", rev, err)
	}

	if _, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "o1", X: 1, Y: 1},
	}); err != nil {
		t.Fatalf("upsert batch: %v", err)
	}

	rev, err = store.ApplyMutations([]Mutation{})
	if err != nil || rev != 1 {
		t.Fatalf("ApplyMutations(empty) = %d, %v; want 1, nil (no bump)", rev, err)
	}
	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != 1 {
		t.Fatalf("snapshot = %v, want unchanged", snap)
	}
}

// TestApplyMutationsValidationErrors 非法 mutation 返回清晰错误；
// 含非法项的整个批次被拒绝，且不产生任何副作用（revision 不动）。
func TestApplyMutationsValidationErrors(t *testing.T) {
	t.Parallel()
	store := openTestStore(t)

	cases := []struct {
		name    string
		mut     Mutation
		wantErr string
	}{
		{"invalid op", Mutation{Op: Op(99), Kind: "k", ID: "i"}, "invalid op"},
		{"zero value mutation", Mutation{}, "invalid op"},
		{"empty kind", Mutation{Op: OpUpsert, Kind: "", ID: "i"}, "kind must not be empty"},
		{"empty id", Mutation{Op: OpUpsert, Kind: "k", ID: ""}, "id must not be empty"},
		{"delete empty kind", Mutation{Op: OpDelete, Kind: "", ID: "i"}, "kind must not be empty"},
		{"delete empty id", Mutation{Op: OpDelete, Kind: "k", ID: ""}, "id must not be empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.ApplyMutations([]Mutation{tc.mut})
			if err == nil {
				t.Fatalf("ApplyMutations(%+v) succeeded, want error", tc.mut)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %q, want it to mention %q", err, tc.wantErr)
			}
		})
	}

	// 合法 + 非法的混合批次：整体拒绝（事务未提交）。
	_, err := store.ApplyMutations([]Mutation{
		{Op: OpUpsert, Kind: "obstacle", ID: "ok", X: 1, Y: 1},
		{Op: OpUpsert, Kind: "", ID: "bad"},
	})
	if err == nil {
		t.Fatalf("mixed batch succeeded, want error")
	}
	rev, err := store.CurrentRevision()
	if err != nil || rev != 0 {
		t.Fatalf("CurrentRevision() = %d, %v; want 0 (no side effects)", rev, err)
	}
	snap, err := store.GetSnapshot()
	if err != nil {
		t.Fatalf("GetSnapshot: %v", err)
	}
	if len(snap) != 0 {
		t.Fatalf("snapshot = %v, want empty (batch rejected atomically)", snap)
	}
}
