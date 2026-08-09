/**
 * loadOverview 双源合并回归测试（2026-08-10，P1）：台账新鲜时 JSONL 独有
 * 丰富字段（resourceDelta/worker 距离/带货运工/可见资源/events）不再被
 * null/0 遮蔽（t1 客户端也走 ingest，台账先行二选一导致主指标行降级为空）。
 * 另验证 tick 容差护栏：JSONL 与台账 tick 差距过大（旧 run 残留）时不合并。
 *
 * 独立测试文件原因：fs-jsonl.ts 的 DATA_ROOT 在模块顶层按 ARENA_DATA_ROOT
 * 求值，同一进程内首次 import 后不可再改——本文件不静态 import streams，
 * 测试内先设 env 再动态 import（同 test/busy-timeout.test.ts 做法），
 * 避免触碰真实 data/runtime。两场景合一个 test：同进程内动态 import 只
 * 求值一次，第二个场景仅改写 outcome.jsonl 后重读。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** 覆盖 outcome.jsonl（台账保持同一份）。 */
function writeOutcome(dir: string, tick: number): void {
  const telemetryDir = join(dir, "runtime", "t1", "telemetry");
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(join(telemetryDir, "outcome.jsonl"), `${JSON.stringify({
    tick,
    coreResourcesAfter: 5,
    coreResourceDelta: 3,
    workerCount: 12,
    workersWithCargo: 4,
    workerMaxDistanceFromCore: 210.5,
    workerMeanDistanceFromCore: 87.3,
    visibleResourceCellCount: 14,
    events: [{ type: "harvest" }, { type: "attack" }],
  })}\n`, "utf8");
}

test("loadOverview: 台账新鲜 → latest = 台账基准 ∪ JSONL 丰富字段（tick 接近时）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-overview-"));
  process.env.ARENA_DATA_ROOT = dir;
  try {
    const { openAgentDb, applyAgentEvent } = await import("../lib/agent-ingest.ts");
    const db = openAgentDb("t1", true);
    applyAgentEvent(db, {
      tenant: "t1",
      instance: "vvnyxo",
      ts: Date.now() / 1000,
      event: "tick_summary",
      tick: 79865,
      resources: 5,
      population: 10,
      core: [-500, -300],
      units: 12,
      visible_enemies: 2,
    });
    db.close();

    const { loadOverview } = await import("../lib/streams.ts");
    const t1 = () => loadOverview(null).tenants.find((t) => t.tenant === "t1");
    assert.ok(t1(), "t1 租户应存在");
    assert.equal(t1()?.live, true, "台账新鲜 → live");

    // 场景 A：JSONL tick 接近（生产 t1 台账滞后 JSONL 约 150 tick）
    writeOutcome(dir, 79900); // 差 35 tick
    const merged = t1()?.latest;
    assert.ok(merged, "latest 应存在");
    // 台账字段为基准
    assert.equal(merged.tick, 79865);
    assert.equal(merged.resources, 5);
    assert.equal(merged.visibleEnemies, 2);
    assert.equal(merged.coreX, -500);
    assert.equal(merged.coreY, -300);
    // JSONL 独有丰富字段并入（t1 回归点）
    assert.equal(merged.resourceDelta, 3);
    assert.equal(merged.workerMaxDistance, 210.5);
    assert.equal(merged.workerMeanDistance, 87.3);
    assert.equal(merged.workersWithCargo, 4);
    assert.equal(merged.visibleResources, 14);
    assert.equal(merged.events, 2);
    // workers 语义：合并模式用 JSONL workerCount（自有 worker 数，t1 语义）
    assert.equal(merged.workers, 12);

    // 场景 B：JSONL tick 远离（旧 run 残留）→ 不合并，回落台账-only
    writeOutcome(dir, 30000);
    const base = t1()?.latest;
    assert.ok(base, "latest 应存在");
    assert.equal(base.tick, 79865, "台账 tick 为基准");
    assert.equal(base.resourceDelta, null, "旧 JSONL 不合并");
    assert.equal(base.workerMaxDistance, null);
    assert.equal(base.visibleResources, null);
    assert.equal(base.events, 0);
    assert.equal(base.workers, 12, "无 JSONL 时回落台账 units");
  } finally {
    delete process.env.ARENA_DATA_ROOT;
    cleanup(dir);
  }
});
