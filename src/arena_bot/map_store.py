"""共享地图存储：跨租户的障碍测绘（SQLite WAL，多进程安全）。

4 个账号并行巡逻 → 各租户观察实时落盘 → 任一租户可查询全量已知障碍。
障碍是永久地形（规则 v0.10），看过不会变 → 地图只增不改、不删。
协同价值：A 账号探索过的区域，B 账号的巡逻直接绕开已知障碍。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

CHUNK_SIZE = 32  # 规则：地图按 32x32 chunk 生成


class MapStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS obstacles ("
            "x INT NOT NULL, y INT NOT NULL, observer TEXT, seen_tick INT, "
            "PRIMARY KEY (x, y))")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS allies ("
            "username TEXT PRIMARY KEY, observer TEXT, seen_tick INT)")
        self._obstacles: set[tuple[int, int]] = set()
        self._allies: set[str] = set()
        self._load()

    def _load(self) -> None:
        for x, y in self._conn.execute("SELECT x, y FROM obstacles"):
            self._obstacles.add((x, y))
        for (username,) in self._conn.execute("SELECT username FROM allies"):
            self._allies.add(username)

    def record(self, cells, observer: str, tick: int) -> int:
        """落盘新观察到的障碍格（去重）。返回新增数量。"""
        new = [(x, y, observer, tick) for x, y in cells
               if (x, y) not in self._obstacles]
        if not new:
            return 0
        self._conn.executemany(
            "INSERT OR IGNORE INTO obstacles (x, y, observer, seen_tick) "
            "VALUES (?, ?, ?, ?)", new)
        self._conn.commit()
        self._obstacles.update((x, y) for x, y, *_ in new)
        return len(new)

    def obstacles(self) -> frozenset[tuple[int, int]]:
        """全量已知障碍（含本进程加载前其他租户记录的）。"""
        return frozenset(self._obstacles)

    def register_ally(self, username: str, observer: str, tick: int) -> bool:
        """注册盟友（我方账号的 Core username）。返回是否新增。"""
        if username in self._allies:
            return False
        self._conn.execute(
            "INSERT OR IGNORE INTO allies (username, observer, seen_tick) "
            "VALUES (?, ?, ?)", (username, observer, tick))
        self._conn.commit()
        self._allies.add(username)
        return True

    def allies(self) -> frozenset[str]:
        """已注册的盟友 username 集合（跨租户共享）。"""
        return frozenset(self._allies)

    def stats(self) -> dict:
        chunks = {(x // CHUNK_SIZE, y // CHUNK_SIZE)
                  for x, y in self._obstacles}
        return {
            "obstacles_known": len(self._obstacles),
            "chunks_explored": len(chunks),
        }

    def query(self, kind: str, bounds=None, limit: int = 200) -> dict:
        """只读查询（供 debug API / LLM arena_map 工具）。

        kind: stats / obstacles / resources / allies
        bounds: (x1, y1, x2, y2) 可选范围过滤（障碍/资源）
        obstacles 最多返回 limit 条（按行列序），超限带 truncated 标记。
        """
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
        self._conn.close()
