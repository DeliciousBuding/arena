// Package mapstore 实现跨进程增量同步的知识层（障碍/资源/盟友视野），
// 存储后端为 SQLite（WAL 模式，纯 Go 驱动 modernc.org/sqlite，无 CGO）。
//
// 设计要点：
//
//   - WAL 模式：读不阻塞写、写不阻塞读；写锁竞争由 busy_timeout 兜底，
//     默认 5s（DefaultBusyTimeout，可用 WithBusyTimeout 覆盖）。
//
//   - revision 语义：ApplyMutations 在单个事务内为整批 mutation 分配一个
//     全局单调递增的 revision（原子推进），该批写入/删除的对象行都打上
//     这个批次 revision。跨进程同步时，以“对象行 revision > 上次同步点”
//     比较增量。并发调用由 SQLite 写锁串行化：每个批次拿到的 revision
//     互不相同，不会出现 lost update。
//
//   - 幂等：对象以 (kind, id) 为复合主键 UPSERT，同一批次重复应用收敛到
//     相同状态（不产生重复行）。
//
//   - 本批只实现存储层 API；与主事件循环解耦的 goroutine + channel 封装
//     属于后续批次（见 docs/go/03-module-spec.md M9）。
package mapstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // 注册 "sqlite" 驱动（纯 Go，无 CGO，白名单依赖）
)

// DefaultBusyTimeout 是写锁等待的默认超时（规格 M9：5000ms）。
const DefaultBusyTimeout = 5 * time.Second

// Op 描述单条 mutation 的操作类型。
type Op uint8

const (
	// OpUpsert 按 (kind, id) 插入或覆盖对象。
	OpUpsert Op = iota + 1
	// OpDelete 删除对象；对象不存在时是 no-op（成功）。
	OpDelete
)

// Mutation 是一条对知识层的增量变更；同一批次内可混用 UPSERT 与 DELETE。
type Mutation struct {
	Op   Op
	Kind string // 对象类别（如 obstacle / resource / allied）
	ID   string // 类别内唯一标识
	X    int
	Y    int
	Data []byte // 可选负载（如 JSON 编码的附加字段）；nil 视为空
}

// Object 是知识层中的一个实体快照。
// Revision 是该对象最后一次被写入时的批次 revision。
type Object struct {
	Kind     string
	ID       string
	X        int
	Y        int
	Revision int64
	Data     []byte // 永不为 nil；空负载为 []byte{}
}

// ObjectKey 返回快照 map 的键（kind 与 id 的组合，避免跨类别 ID 冲突）。
func ObjectKey(kind, id string) string { return kind + "/" + id }

// Store 是 mapstore 的 SQLite 存储核心。
type Store struct {
	db          *sql.DB
	path        string
	busyTimeout time.Duration
}

// Option 定制 Open 的默认参数。
type Option func(*storeConfig)

type storeConfig struct {
	busyTimeout time.Duration
}

// WithBusyTimeout 覆盖写锁等待超时（默认 DefaultBusyTimeout）。
func WithBusyTimeout(d time.Duration) Option {
	return func(c *storeConfig) { c.busyTimeout = d }
}

// Open 打开（必要时创建）path 指向的 SQLite 数据库，初始化 schema 并返回
// Store。连接级参数（busy_timeout / foreign_keys / synchronous）通过 DSN
// 在每条池化连接上生效；WAL 是文件级持久属性，在此显式启用并校验结果，
// 失败时整体失败，不留下半配置的数据库。
func Open(path string, opts ...Option) (*Store, error) {
	cfg := storeConfig{busyTimeout: DefaultBusyTimeout}
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.busyTimeout <= 0 {
		return nil, fmt.Errorf("mapstore: open %q: busy timeout must be positive, got %v", path, cfg.busyTimeout)
	}

	dsn := fmt.Sprintf("%s?_busy_timeout=%d&_foreign_keys=on&_synchronous=NORMAL",
		path, cfg.busyTimeout.Milliseconds())
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("mapstore: open %q: %w", path, err)
	}
	store := &Store{db: db, path: path, busyTimeout: cfg.busyTimeout}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 建立真实连接，尽早暴露路径/权限/DSN 错误。
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("mapstore: open %q: %w", path, err)
	}

	var journalMode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&journalMode); err != nil {
		db.Close()
		return nil, fmt.Errorf("mapstore: open %q: set journal_mode=WAL: %w", path, err)
	}
	if journalMode != "wal" {
		db.Close()
		return nil, fmt.Errorf("mapstore: open %q: journal_mode = %q, want %q", path, journalMode, "wal")
	}

	for _, stmt := range []string{createRevisionsSQL, seedRevisionsSQL, createObjectsSQL} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("mapstore: open %q: init schema: %w", path, err)
		}
	}
	return store, nil
}

// Close 释放底层连接池。
func (s *Store) Close() error {
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("mapstore: close: %w", err)
	}
	return nil
}

// ApplyMutations 在单个事务内应用一批增量 mutation，并为该批分配一个新的
// 全局 revision（current+1，原子推进）。并发调用由 SQLite 写锁串行化，
// 每个批次拿到的 revision 互不相同、严格递增。
//
// 空批次是 no-op：不推进 revision，返回当前 revision。
// 同一内容批次重复应用是幂等的（UPSERT 收敛到相同状态）。
func (s *Store) ApplyMutations(muts []Mutation) (int64, error) {
	for i, m := range muts {
		if err := m.validate(); err != nil {
			return 0, fmt.Errorf("mapstore: apply mutations: mutation %d: %w", i, err)
		}
	}
	if len(muts) == 0 {
		rev, err := s.CurrentRevision()
		if err != nil {
			return 0, fmt.Errorf("mapstore: apply mutations: %w", err)
		}
		return rev, nil
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("mapstore: apply mutations: begin: %w", err)
	}
	defer tx.Rollback() // commit 成功后为 no-op

	// 原子分配批次 revision：单条 UPDATE 由 SQLite 写锁串行化，
	// 任何并发批次都只能拿到互不相同的值。
	var newRevision int64
	if err := tx.QueryRowContext(ctx, bumpRevisionSQL).Scan(&newRevision); err != nil {
		return 0, fmt.Errorf("mapstore: apply mutations: allocate revision: %w", err)
	}

	for i, m := range muts {
		var stmt string
		var args []any
		switch m.Op {
		case OpUpsert:
			stmt = upsertObjectSQL
			data := m.Data
			if data == nil {
				data = []byte{} // 绑定空 blob 而非 NULL（列 NOT NULL）
			}
			args = []any{m.Kind, m.ID, m.X, m.Y, newRevision, data}
		case OpDelete:
			stmt = deleteObjectSQL
			args = []any{m.Kind, m.ID}
		}
		if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
			return 0, fmt.Errorf("mapstore: apply mutations: mutation %d: %w", i, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("mapstore: apply mutations: commit: %w", err)
	}
	return newRevision, nil
}

// GetSnapshot 返回当前全量对象快照；键为 ObjectKey(kind, id)。
// 库为空时返回空 map（非 nil）。
func (s *Store) GetSnapshot() (map[string]Object, error) {
	ctx := context.Background()
	rows, err := s.db.QueryContext(ctx, selectAllObjectsSQL)
	if err != nil {
		return nil, fmt.Errorf("mapstore: get snapshot: %w", err)
	}
	defer rows.Close()

	snapshot := make(map[string]Object)
	for rows.Next() {
		var o Object
		if err := rows.Scan(&o.Kind, &o.ID, &o.X, &o.Y, &o.Revision, &o.Data); err != nil {
			return nil, fmt.Errorf("mapstore: get snapshot: %w", err)
		}
		if o.Data == nil {
			o.Data = []byte{}
		}
		snapshot[ObjectKey(o.Kind, o.ID)] = o
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mapstore: get snapshot: %w", err)
	}
	return snapshot, nil
}

// CurrentRevision 返回已分配的最大批次 revision（新库为 0）。
func (s *Store) CurrentRevision() (int64, error) {
	var rev int64
	err := s.db.QueryRowContext(context.Background(), currentRevisionSQL).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("mapstore: current revision: revisions row missing (schema corrupted?)")
	}
	if err != nil {
		return 0, fmt.Errorf("mapstore: current revision: %w", err)
	}
	return rev, nil
}

func (m Mutation) validate() error {
	switch {
	case m.Op != OpUpsert && m.Op != OpDelete:
		return fmt.Errorf("invalid op %d (want OpUpsert or OpDelete)", m.Op)
	case m.Kind == "":
		return errors.New("kind must not be empty")
	case m.ID == "":
		return errors.New("id must not be empty")
	}
	return nil
}

const (
	// revisions 是单行元数据表（id 恒为 1），记录已分配的最大批次 revision。
	createRevisionsSQL = `
CREATE TABLE IF NOT EXISTS revisions (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    current_revision INTEGER NOT NULL DEFAULT 0
);`

	seedRevisionsSQL = `
INSERT INTO revisions (id, current_revision) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;`

	// objects 是知识层实体表；(kind, id) 为复合主键，UPSERT 语义由
	// ON CONFLICT 保证。revision 列记录最后一次写入它的批次 revision。
	createObjectsSQL = `
CREATE TABLE IF NOT EXISTS objects (
    kind     TEXT    NOT NULL,
    id       TEXT    NOT NULL,
    x        INTEGER NOT NULL,
    y        INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    data     BLOB    NOT NULL DEFAULT (''),
    PRIMARY KEY (kind, id)
);`

	// bumpRevisionSQL 原子推进 revision；自带自愈：revisions 行被意外
	// 删除时自动重建（从 1 继续）。
	bumpRevisionSQL = `
INSERT INTO revisions (id, current_revision) VALUES (1, 1)
ON CONFLICT (id) DO UPDATE SET current_revision = current_revision + 1
RETURNING current_revision;`

	currentRevisionSQL = `SELECT current_revision FROM revisions WHERE id = 1;`

	upsertObjectSQL = `
INSERT INTO objects (kind, id, x, y, revision, data)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (kind, id) DO UPDATE SET
    x        = excluded.x,
    y        = excluded.y,
    revision = excluded.revision,
    data     = excluded.data;`

	deleteObjectSQL     = `DELETE FROM objects WHERE kind = ? AND id = ?;`
	selectAllObjectsSQL = `SELECT kind, id, x, y, revision, data FROM objects;`
)
