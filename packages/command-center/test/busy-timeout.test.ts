/**
 * busy_timeout 双写竞争回归测试（2026-08-10，P1）：ingest（python 实时域，
 * 每 5s flush）与 survey:sync CLI（TS 回放域）并发写同一 survey/<tenant>.db，
 * node:sqlite 默认 busy_timeout=0ms 撞上即 "database is locked"，ingest 整批
 * 静默丢数据 / sync 整体失败。openAgentDb 必须设置 busy_timeout=5000 让等待
 * 替代失败（与 arena-agent map-store.ts 同参）。
 *
 * 独立测试文件原因：openAgentDb 的 DATA_ROOT 在模块顶层按 ARENA_DATA_ROOT
 * 求值（fs-jsonl.ts），同一进程内首次 import 后不可再改——本文件不静态
 * import agent-ingest，测试内先设 env 再动态 import（隔离进程内全新求值），
 * 避免触碰真实 data/runtime/survey 库。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Windows 下 node:sqlite close 后句柄释放偶发延迟——短暂等待重试（同
 *  arena-agent survey-db.test.ts cleanup）。 */
function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const end = Date.now() + 200;
      while (Date.now() < end) { /* busy-wait */ }
    }
  }
}

test("openAgentDb: PRAGMA busy_timeout=5000 生效（ingest/sync 双写竞争 P1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-busy-"));
  process.env.ARENA_DATA_ROOT = dir;
  try {
    const { openAgentDb } = await import("../lib/agent-ingest.ts");
    const db = openAgentDb("t1", true);
    // 列名是 timeout（SQLite 对 PRAGMA busy_timeout 查询的返回列）
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(row.timeout, 5000, "busy_timeout 生效：锁竞争时等待 5s 替代直接抛 database is locked");
    db.close();
  } finally {
    delete process.env.ARENA_DATA_ROOT;
    cleanup(dir);
  }
});
