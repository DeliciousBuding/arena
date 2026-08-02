"""共享地图存储：跨租户的障碍测绘（SQLite WAL，多进程安全）。

4 个账号并行巡逻 → 各租户观察实时落盘 → 任一租户实时查询全量已知障碍。
障碍是永久地形（规则 v0.11），看过不会变 → 地图只增不改、不删。

跨进程实时一致性（P0-1 修复）：
- 表 map_meta 维护单调 revision；每次写入成功后 +1
- 各进程读前 refresh()：查 revision，未变直接用内存缓存；
  变了则用 SQLite 隐式 rowid 做增量游标（rowid > last_seen_id）拉新行
- 不依赖重启传播：t2 写入 → revision+1 → t1 下次读取自动看到
- PRAGMA busy_timeout 防并发写锁冲突

线程安全（P0-1 补充）：DebugServer（ThreadingHTTPServer）的请求线程
会跨线程查询——check_same_thread=False + 互斥锁串行化所有访问。
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

CHUNK_SIZE = 32  # 规则：地图按 32x32 chunk 生成

_REVISION_KEY = "revision"


class MapStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False：DebugServer 的请求线程会跨线程查询
        # （ThreadingHTTPServer），用可重入锁串行化保证安全
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(path, timeout=10.0, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS obstacles ("
            "x INT NOT NULL, y INT NOT NULL, observer TEXT, seen_tick INT, "
            "PRIMARY KEY (x, y))")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS allies ("
            "username TEXT PRIMARY KEY, observer TEXT, seen_tick INT)")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS map_meta ("
            "key TEXT PRIMARY KEY, value INT NOT NULL)")
        self._conn.execute(
            "INSERT OR IGNORE INTO map_meta (key, value) VALUES (?, 0)",
            (_REVISION_KEY,))
        self._conn.commit()
        # 内存缓存 + 增量游标（rowid > last_* 的行还没加载）
        self._obstacles: set[tuple[int, int]] = set()
        self._allies: set[str] = set()
        self._last_obstacle_rowid = 0
        self._last_ally_rowid = 0
        self._last_revision = -1
        self._refresh()

    # ---- 跨进程一致性 ----

    def _revision(self) -> int:
        row = self._conn.execute(
            "SELECT value FROM map_meta WHERE key = ?", (_REVISION_KEY,)
        ).fetchone()
        return int(row[0]) if row else 0

    def _refresh(self) -> None:
        """读取前调用：revision 变了才增量拉取（其余走内存缓存）。"""
        rev = self._revision()
        if rev == self._last_revision:
            return
        self._load_incremental()
        self._last_revision = rev

    def _load_incremental(self) -> None:
        """增量加载 rowid > 游标的新行（障碍/盟友），更新游标。"""
        for rowid, x, y in self._conn.execute(
                "SELECT rowid, x, y FROM obstacles WHERE rowid > ? "
                "ORDER BY rowid", (self._last_obstacle_rowid,)):
            self._obstacles.add((x, y))
            self._last_obstacle_rowid = rowid
        for rowid, username in self._conn.execute(
                "SELECT rowid, username FROM allies WHERE rowid > ? "
                "ORDER BY rowid", (self._last_ally_rowid,)):
            self._allies.add(username)
            self._last_ally_rowid = rowid

    def _bump_revision(self) -> None:
        self._conn.execute(
            "INSERT INTO map_meta (key, value) VALUES (?, 1) "
            "ON CONFLICT(key) DO UPDATE SET value = value + 1",
            (_REVISION_KEY,))

    # ---- 写入 ----

    def record(self, cells, observer: str, tick: int) -> int:
        """落盘新观察到的障碍格（INSERT OR IGNORE 去重）。返回实际新增数量。"""
        with self._lock:
            if not cells:
                return 0
            cur = self._conn.executemany(
                "INSERT OR IGNORE INTO obstacles (x, y, observer, seen_tick) "
                "VALUES (?, ?, ?, ?)",
                [(x, y, observer, tick) for x, y in cells])
            inserted = cur.rowcount  # OR IGNORE 下 = 实际插入行数（并发安全）
            if inserted > 0:
                self._conn.commit()
                self._bump_revision()
                self._conn.commit()
                self._load_incremental()  # 本进程立即看到（含 rowid 游标推进）
            return inserted

    def register_ally(self, username: str, observer: str, tick: int) -> bool:
        """注册盟友（我方账号的 Core username）。返回是否新增。"""
        with self._lock:
            cur = self._conn.execute(
                "INSERT OR IGNORE INTO allies (username, observer, seen_tick) "
                "VALUES (?, ?, ?)", (username, observer, tick))
            if cur.rowcount == 0:
                return False
            self._conn.commit()
            self._bump_revision()
            self._conn.commit()
            self._load_incremental()
            return True

    # ---- 读取（都先 refresh，实时含其他进程的新数据） ----

    def obstacles(self) -> frozenset[tuple[int, int]]:
        """全量已知障碍（含其他进程刚写入的）。"""
        with self._lock:
            self._refresh()
            return frozenset(self._obstacles)

    def allies(self) -> frozenset[str]:
        """已注册的盟友 username 集合（跨租户实时共享）。"""
        with self._lock:
            self._refresh()
            return frozenset(self._allies)

    def stats(self) -> dict:
        with self._lock:
            self._refresh()
            chunks = {(x // CHUNK_SIZE, y // CHUNK_SIZE)
                      for x, y in self._obstacles}
            return {
                "obstacles_known": len(self._obstacles),
                "chunks_explored": len(chunks),
                "allies": len(self._allies),
                "revision": self._last_revision,
            }

    def query(self, kind: str, bounds=None, limit: int = 200) -> dict:
        """只读查询（供 debug API / LLM arena_map 工具）。

        kind: stats / obstacles / resources / allies
        bounds: (x1, y1, x2, y2) 可选范围过滤（障碍/资源）
        obstacles 最多返回 limit 条（按行列序），超限带 truncated 标记。
        """
        with self._lock:
            self._refresh()
            if kind == "stats":
                return self.stats()
            if kind == "obstacles":
                rows = sorted(self._obstacles)  # (x, y) 有序
                if bounds:
                    x1, y1, x2, y2 = bounds
                    rows = [(x, y) for x, y in rows
                            if x1 <= x <= x2 and y1 <= y <= y2]
                truncated = len(rows) > limit
                return {"cells": rows[:limit], "count": len(rows),
                        "truncated": truncated}
            if kind == "resources":
                # 资源格目前不持久化（world 每 Tick 视野内重算），返回空结构
                return {"cells": [], "count": 0, "note": "资源格不持久化，见视野"}
            if kind == "allies":
                return {"usernames": sorted(self._allies)}
            return {"error": f"未知查询: {kind!r}"}

    def close(self) -> None:
        with self._lock:
            self._conn.close()
