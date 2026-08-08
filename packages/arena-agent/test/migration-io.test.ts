/**
 * 迁移计划文件 IO 测试（migration-system-v1 §6.1）：
 * 原子写/读/清理；缺失与损坏 fail-closed。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  readMigrationPlan,
  writeMigrationPlanAtomic,
  clearMigrationPlan,
  migrationPlanPath,
} from "../src/migration/io.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

function validPlan(): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-test-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "PLAN",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: { untilTick: 74123, heartbeatAt: "2026-08-08T21:30:00.000Z" },
    target: { x: -20, y: 40, reason: "test" },
    path: { cells: [[-583, -111]], corridorWidth: 8, lookahead: 30 },
    legs: [
      {
        index: 0,
        from: { x: -583, y: -111 },
        to: { x: -450, y: -60 },
        audit: { ok: true, freshResources: 12, activeEnemyCores: 0 },
      },
    ],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: {
      policy: "adaptive",
      burstCells: 8,
      settleTarget: 60,
      minSettle: 30,
      maxSettle: 120,
      harvestRadius: 12,
    },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 12345 },
    updatedAt: "2026-08-08T21:30:00.000Z",
  };
}

function makePlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "arena-migration-io-"));
  const path = migrationPlanPath(dir, "t1");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

test("migration-io: 写→读 往返一致", () => {
  const path = makePlanPath();
  writeMigrationPlanAtomic(path, validPlan());
  const result = readMigrationPlan(path);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.operationId, "op-test-01");
    assert.equal(result.plan.state, "PLAN");
  }
  rmSync(path, { force: true, recursive: true });
});

test("migration-io: 覆盖写（revision 更新）成功", () => {
  const path = makePlanPath();
  writeMigrationPlanAtomic(path, validPlan());
  const updated = { ...validPlan(), revision: 2, state: "LEG_MOVE" as const };
  writeMigrationPlanAtomic(path, updated);
  const result = readMigrationPlan(path);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.revision, 2);
    assert.equal(result.plan.state, "LEG_MOVE");
  }
  rmSync(path, { force: true, recursive: true });
});

test("migration-io: 文件缺失 → missing（模块关闭语义）", () => {
  const path = makePlanPath();
  const result = readMigrationPlan(path);
  assert.deepEqual(result, { ok: false, reason: "missing" });
  rmSync(path, { force: true, recursive: true });
});

test("migration-io: 损坏 JSON → malformed（fail-closed）", () => {
  const path = makePlanPath();
  writeFileSync(path, "{ not json", "utf8");
  const result = readMigrationPlan(path);
  assert.deepEqual(result, { ok: false, reason: "malformed" });
  rmSync(path, { force: true, recursive: true });
});

test("migration-io: schema 不符 → malformed（不部分采纳）", () => {
  const path = makePlanPath();
  writeFileSync(path, JSON.stringify({ schema: "other", operationId: "x" }), "utf8");
  const result = readMigrationPlan(path);
  assert.deepEqual(result, { ok: false, reason: "malformed" });
  rmSync(path, { force: true, recursive: true });
});

test("migration-io: clear 幂等", () => {
  const path = makePlanPath();
  writeMigrationPlanAtomic(path, validPlan());
  clearMigrationPlan(path);
  assert.equal(readMigrationPlan(path).ok, false);
  clearMigrationPlan(path); // 二次清理不抛错
  rmSync(path, { force: true, recursive: true });
});
