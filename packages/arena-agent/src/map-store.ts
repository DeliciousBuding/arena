/** 共享地图存储：跨租户的障碍测绘（SQLite WAL，多进程安全）。
 *
 * 移植自 arena_bot/map_store.py（含 P0-A 修复）：
 * - 表 map_meta 维护单调 revision；仅当实际插入新行时 +1
 * - 各进程读前 refresh()：revision 未变走内存缓存；变了用隐式
 *   rowid 增量游标（rowid > last_seen_id）拉新行
 * - BEGIN IMMEDIATE 显式写事务 + busy_timeout：4 进程并发写安全
 * - node:sqlite 同步 API：进程内单线程，无需 RLock；跨进程由 SQLite 保证
 */

import { DatabaseSync } from "node:sqlite";

export const CHUNK_SIZE = 32; // 规则：地图按 32x32 chunk 生成
const REVISION_KEY = "revision";

const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS obstacles (
  x INT NOT NULL, y INT NOT NULL, observer TEXT, seen_tick INT,
  PRIMARY KEY (x, y)
);
CREATE TABLE IF NOT EXISTS allies (
  username TEXT PRIMARY KEY, observer TEXT, seen_tick INT
);
CREATE TABLE IF NOT EXISTS map_meta (
  key TEXT PRIMARY KEY, value INT NOT NULL
);
INSERT OR IGNORE INTO map_meta (key, value) VALUES ('${REVISION_KEY}', 0);
`;

export interface MapStats {
  obstacles_known: number;
  chunks_explored: number;
  allies: number;
  revision: number;
}

export type QueryBounds = readonly [number, number, number, number];

export class MapStore {
  readonly path: string;
  private db: DatabaseSync;
  // 内存缓存 + 增量游标
  private obstacles = new Set<string>();
  private allies = new Set<string>();
  private lastObstacleRowid = 0;
  private lastAllyRowid = 0;
  private lastRevision = -1;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    // busy_timeout 必须先于 WAL pragma：journal 切换需要独占锁，
    // 4 租户并发首开会锁，无超时则直接抛 "database is locked"
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.setupSchema();
    this.refresh();
  }

  /** 建表：显式写事务 + 重试（4 租户同时启动并发 DDL 会 locked）。 */
  private setupSchema(): void {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.exec(SETUP_SQL);
        this.db.exec("COMMIT");
        return;
      } catch (exc) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // 无活跃事务
        }
        if (isLocked(exc) && attempt < 4) {
          sleep(200 * (attempt + 1));
          continue;
        }
        throw exc;
      }
    }
  }

  private revision(): number {
    const row = this.db
      .prepare("SELECT value FROM map_meta WHERE key = ?")
      .get(REVISION_KEY) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  /** 读取前调用：revision 变了才增量拉取。 */
  private refresh(): void {
    const rev = this.revision();
    if (rev === this.lastRevision) {
      return;
    }
    this.loadIncremental();
    this.lastRevision = rev;
  }

  private loadIncremental(): void {
    const obstacles = this.db.prepare(
      "SELECT rowid, x, y FROM obstacles WHERE rowid > ? ORDER BY rowid",
    );
    for (const row of obstacles.all(this.lastObstacleRowid) as Array<{ rowid: number; x: number; y: number }>) {
      this.obstacles.add(`${row.x},${row.y}`);
      this.lastObstacleRowid = row.rowid;
    }
    const allies = this.db.prepare(
      "SELECT rowid, username FROM allies WHERE rowid > ? ORDER BY rowid",
    );
    for (const row of allies.all(this.lastAllyRowid) as Array<{ rowid: number; username: string }>) {
      this.allies.add(row.username);
      this.lastAllyRowid = row.rowid;
    }
  }

  /** 显式写事务 + 重试。bumpRevision：仅当首个 INSERT 实际插入 >0 才递增 revision（P0-A）。 */
  private write(bumpRevision: boolean, fn: () => number): number {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const inserted = fn();
        if (bumpRevision && inserted > 0) {
          this.db
            .prepare(
              "INSERT INTO map_meta (key, value) VALUES (?, 1) " +
                "ON CONFLICT(key) DO UPDATE SET value = value + 1",
            )
            .run(REVISION_KEY);
        }
        this.db.exec("COMMIT");
        if (bumpRevision && inserted > 0) {
          this.lastRevision = this.revision(); // 校准本地快照
        }
        return inserted;
      } catch (exc) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // 无活跃事务
        }
        if (isLocked(exc) && attempt < 4) {
          sleep(200 * (attempt + 1));
          continue;
        }
        throw exc;
      }
    }
    return 0; // 不可达
  }

  /** 落盘新观察到的障碍格（"x,y" 集合，去重）。返回实际新增数量。 */
  record(cells: ReadonlySet<string>, observer: string, tick: number): number {
    if (cells.size === 0) {
      return 0;
    }
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO obstacles (x, y, observer, seen_tick) VALUES (?, ?, ?, ?)",
    );
    const inserted = this.write(true, () => {
      let count = 0;
      for (const cell of cells) {
        const [x, y] = cell.split(",").map(Number);
        const result = stmt.run(x, y, observer, tick);
        count += Number(result.changes);
      }
      return count;
    });
    if (inserted > 0) {
      this.loadIncremental(); // 本进程立即看到
    }
    return inserted;
  }

  /** 注册盟友（我方账号的 Core username）。返回是否新增。 */
  registerAlly(username: string, observer: string, tick: number): boolean {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO allies (username, observer, seen_tick) VALUES (?, ?, ?)",
    );
    const inserted = this.write(true, () => Number(stmt.run(username, observer, tick).changes));
    if (inserted > 0) {
      this.loadIncremental();
      return true;
    }
    return false;
  }

  /** 全量已知障碍（"x,y" 集合，含其他进程刚写入的）。 */
  obstacleSet(): ReadonlySet<string> {
    this.refresh();
    return this.obstacles;
  }

  /** 已注册的盟友 username 集合（跨租户实时共享）。 */
  allySet(): ReadonlySet<string> {
    this.refresh();
    return this.allies;
  }

  stats(): MapStats {
    this.refresh();
    const chunks = new Set<string>();
    for (const cell of this.obstacles) {
      const [x, y] = cell.split(",").map(Number);
      chunks.add(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`);
    }
    return {
      obstacles_known: this.obstacles.size,
      chunks_explored: chunks.size,
      allies: this.allies.size,
      revision: this.lastRevision,
    };
  }

  /** 只读查询（供 debug API / LLM arena_map 工具）。 */
  query(
    kind: "stats" | "obstacles" | "allies",
    bounds?: QueryBounds,
    limit = 200,
  ): MapStats | { cells: Array<[number, number]>; count: number; truncated: boolean } | { usernames: string[] } | { error: string } {
    this.refresh();
    if (kind === "stats") {
      return this.stats();
    }
    if (kind === "obstacles") {
      const cells = [...this.obstacles]
        .map((cell) => cell.split(",").map(Number) as [number, number])
        .sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
      const filtered = bounds
        ? cells.filter(([x, y]) => x >= bounds[0] && x <= bounds[2] && y >= bounds[1] && y <= bounds[3])
        : cells;
      return { cells: filtered.slice(0, limit), count: filtered.length, truncated: filtered.length > limit };
    }
    if (kind === "allies") {
      return { usernames: [...this.allies].sort() };
    }
    return { error: `未知查询: ${String(kind)}` };
  }

  close(): void {
    this.db.close();
  }
}

function isLocked(exc: unknown): boolean {
  return exc instanceof Error && exc.message.toLowerCase().includes("locked");
}

function sleep(ms: number): void {
  const buffer = new Uint8Array(1);
  Atomics.wait(new Int32Array(buffer.buffer), 0, 0, ms);
}
