/** MapStore TS 测试：去重、跨实例共享、P0-A revision 语义。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MapStore } from "../src/map-store.ts";

/** 子进程 cwd 必须指向本仓库（勿硬编码别的仓库路径）。 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mapstore-"));
  return join(dir, "m.db");
}

function cells(...points: Array<[number, number]>): Set<string> {
  return new Set(points.map(([x, y]) => `${x},${y}`));
}

test("record 去重：重复观察不新增", () => {
  const ms = new MapStore(freshDb());
  assert.equal(ms.record(cells([5, 5], [6, 6]), "t1", 1), 2);
  assert.equal(ms.record(cells([5, 5], [7, 7]), "t1", 2), 1);
  assert.equal(ms.obstacleSet().size, 3);
  ms.close();
});

test("跨实例共享：新实例加载已有数据", () => {
  const db = freshDb();
  const ms1 = new MapStore(db);
  ms1.record(cells([1, 1], [2, 2]), "t1", 1);
  ms1.close();
  const ms2 = new MapStore(db);
  assert.equal(ms2.obstacleSet().size, 2);
  ms2.record(cells([3, 3]), "t2", 2);
  ms2.close();
  const ms3 = new MapStore(db);
  assert.equal(ms3.obstacleSet().size, 3);
  ms3.close();
});

test("live 跨实例可见性：进程不重启实时看到新写入（revision 增量）", () => {
  const db = freshDb();
  const ms1 = new MapStore(db);
  ms1.record(cells([1, 1]), "t1", 1);
  const ms2 = new MapStore(db);
  assert.equal(ms2.obstacleSet().size, 1);
  ms2.record(cells([50, 50], [51, 51]), "t2", 2);
  assert.equal(ms1.obstacleSet().size, 3); // ms1 无需重启即看到
  ms2.registerAlly("buding", "t2", 2);
  assert.equal(ms1.allySet().has("buding"), true);
  const r1 = ms1.stats().revision;
  ms2.record(cells([60, 60]), "t2", 3);
  assert.ok(ms1.stats().revision > r1);
  ms1.close();
  ms2.close();
});

test("P0-A：重复记录同批障碍 revision 不递增", () => {
  const ms = new MapStore(freshDb());
  const known = cells([1, 1], [2, 2], [3, 3]);
  assert.equal(ms.record(known, "t1", 1), 3);
  const r1 = ms.stats().revision;
  for (let i = 0; i < 100; i += 1) {
    assert.equal(ms.record(known, "t1", i + 2), 0);
  }
  assert.equal(ms.stats().revision, r1);
  assert.equal(ms.record(cells([4, 4]), "t1", 102), 1);
  assert.equal(ms.stats().revision, r1 + 1);
  ms.close();
});

test("P0-A：重复注册同一盟友 revision 不递增", () => {
  const ms = new MapStore(freshDb());
  assert.equal(ms.registerAlly("buding", "t1", 1), true);
  const r1 = ms.stats().revision;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(ms.registerAlly("buding", "t1", i + 2), false);
  }
  assert.equal(ms.stats().revision, r1);
  assert.equal(ms.registerAlly("delicious", "t1", 11), true);
  assert.equal(ms.stats().revision, r1 + 1);
  ms.close();
});

test("query：obstacles 排序 + bounds 过滤 + truncated", () => {
  const ms = new MapStore(freshDb());
  ms.record(cells([9, 9], [1, 1], [5, 5]), "t1", 1);
  const all = ms.query("obstacles");
  assert.deepEqual((all as { cells: Array<[number, number]> }).cells, [
    [1, 1],
    [5, 5],
    [9, 9],
  ]);
  const filtered = ms.query("obstacles", [0, 0, 6, 6]) as { cells: Array<[number, number]> };
  assert.deepEqual(filtered.cells, [
    [1, 1],
    [5, 5],
  ]);
  const limited = ms.query("obstacles", undefined, 2) as { cells: unknown[]; truncated: boolean };
  assert.equal(limited.cells.length, 2);
  assert.equal(limited.truncated, true);
  ms.close();
});

test("stats：chunks 聚合", () => {
  const ms = new MapStore(freshDb());
  ms.record(cells([0, 0], [1, 1], [40, 40]), "t1", 1);
  const stats = ms.stats();
  assert.equal(stats.obstacles_known, 3);
  assert.equal(stats.chunks_explored, 2); // chunk(0,0) + chunk(1,1)
  ms.close();
});

test("多进程并发写：子进程同时写不同障碍无锁冲突", async () => {
  const db = freshDb();
  const { spawn } = await import("node:child_process");
  const writer = (offset: number, n: number) =>
    new Promise<void>((resolve, reject) => {
      const script = `
        import { MapStore } from "./src/map-store.ts";
        const ms = new MapStore(${JSON.stringify(db)});
        const cells = new Set();
        for (let i = 0; i < ${n}; i += 1) cells.add(\`\${${offset} + i},\${${offset} + i}\`);
        ms.record(cells, "w${offset}", 1);
        ms.close();
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        cwd: PKG_ROOT,
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (d: Buffer) => stderr.push(d));
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`child exit ${code}: ${Buffer.concat(stderr).toString()}`)),
      );
      child.on("error", reject);
    });
  await Promise.all([writer(0, 40), writer(100, 40), writer(200, 40), writer(300, 40)]);
  const ms = new MapStore(db);
  assert.equal(ms.obstacleSet().size, 160);
  ms.close();
  rmSync(db, { force: true });
});
