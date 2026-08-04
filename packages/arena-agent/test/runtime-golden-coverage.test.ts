/**
 * runtime-golden-coverage 工具测试：构造合成 dataset，验证四类专项事件覆盖检测。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

function makeState(events: string[]): Record<string, unknown> {
  return {
    tick: 1,
    objects: [],
    events: events.map((event_type) => ({ event_type })),
  };
}

function makeCase(tick: number, beforeEvents: string[], afterEvents: string[]): string {
  return JSON.stringify({
    schema: "sim-calibration-case-v1",
    caseId: `test:${tick}`,
    tenantId: "t1",
    rulesVersion: "v0.11",
    seed: 0,
    metadata: {
      source: "live-recorder",
      opponentPlans: "absent",
      recordedAt: "2026-08-04T00:00:00.000Z",
      sourceCommit: "abc1234",
      runId: "test-run",
    },
    before: { tick, state: makeState(beforeEvents) },
    plan: { unitActions: {}, coreAction: null, intents: {} },
    after: { tick: tick + 1, state: makeState(afterEvents) },
  });
}

function buildSyntheticDataset(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "golden-coverage-"));
  const casesDir = join(dir, "cases");
  mkdirSync(casesDir, { recursive: true });

  // combat + beacon case
  writeFileSync(
    join(casesDir, "0000000100.json"),
    makeCase(100, [], ["SWEEP_RESOLVED", "SHOT_HIT", "BEACON_DROPPED"]),
    "utf-8",
  );
  // core-migration case
  writeFileSync(
    join(casesDir, "0000000200.json"),
    makeCase(200, ["CORE_MOVE_STARTED"], ["CORE_MOVE_SUCCEEDED"]),
    "utf-8",
  );
  // respawn case
  writeFileSync(
    join(casesDir, "0000000300.json"),
    makeCase(300, ["UNIT_SELF_DESTRUCTED"], ["CORE_RESPAWNED", "RESPAWN_DELAYED"]),
    "utf-8",
  );

  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schema: "runtime-golden-dataset-v1",
      datasetId: "test-dataset",
      tenantId: "t1",
      rulesVersion: "v0.11",
      sourceCommit: "abc1234",
      configHash: "cfg-hash",
      startedAt: "2026-08-04T00:00:00.000Z",
      completedAt: "2026-08-04T00:01:00.000Z",
      caseCount: 3,
      skippedRejected: 0,
      droppedPending: 0,
      errorCount: 0,
      cases: [],
      errors: [],
    }),
    "utf-8",
  );

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("coverage: 四类专项事件全部被合成 dataset 覆盖", async () => {
  const { dir, cleanup } = buildSyntheticDataset();
  try {
    const { buildReport } = await import("../scripts/runtime-golden-coverage.ts");
    const report = buildReport(dir);
    assert.equal(report.caseCount, 3);
    assert.equal(report.coveredCases, 3, "三个 case 都应含专项事件");
    assert.equal(report.summary.combat, true);
    assert.equal(report.summary.coreMigration, true);
    assert.equal(report.summary.beacon, true);
    assert.equal(report.summary.respawn, true);
    assert.equal(report.summary.allCovered, true);
    // 具体事件 tick 归属
    const combatEvents = report.groupCoverage.combat.events;
    const sweep = combatEvents.find((event) => event.eventType === "SWEEP_RESOLVED");
    assert.ok(sweep?.triggered, "SWEEP_RESOLVED 应触发");
    assert.deepEqual(sweep?.ticks, [100]);
  } finally {
    cleanup();
  }
});

test("coverage: 缺 respawn 事件时明确报 NOT COVERED", async () => {
  const { dir, cleanup } = buildSyntheticDataset();
  try {
    // 删除 respawn case，使 respawn 组无任何事件
    const { rmSync: rm } = await import("node:fs");
    rm(join(dir, "cases", "0000000300.json"));
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(manifestPath, "utf-8")));
    manifest.caseCount = 2;
    await import("node:fs/promises").then((m) => m.writeFile(manifestPath, JSON.stringify(manifest), "utf-8"));

    const { buildReport } = await import("../scripts/runtime-golden-coverage.ts");
    const report = buildReport(dir);
    assert.equal(report.summary.respawn, false);
    assert.equal(report.summary.allCovered, false);
    const respawnEvents = report.groupCoverage.respawn.events;
    assert.ok(respawnEvents.every((event) => !event.triggered), "respawn 组应全部未触发");
    assert.ok(report.uncovered.some((event) => event.group === "respawn"));
  } finally {
    cleanup();
  }
});
