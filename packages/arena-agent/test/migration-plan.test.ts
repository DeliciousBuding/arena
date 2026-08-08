/**
 * 迁移计划解析测试（migration-system-v1 §6.1）：
 * 合法计划通过；缺字段/类型错/枚举错一律 fail-closed 拒绝。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMigrationPlan, type MigrationPlanV1 } from "../src/migration/plan.ts";

function validPlan(): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-20260808-t1t2-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "LEG_MOVE",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: { untilTick: 74123, heartbeatAt: "2026-08-08T21:30:00.000Z" },
    target: { x: -20, y: 40, reason: "t1/t2 会合" },
    path: {
      cells: [
        [-583, -111],
        [-582, -111],
      ],
      corridorWidth: 8,
      lookahead: 30,
    },
    legs: [
      {
        index: 0,
        from: { x: -583, y: -111 },
        to: { x: -450, y: -60 },
        audit: { ok: true, freshResources: 12, activeEnemyCores: 0 },
      },
    ],
    legProgress: { legIndex: 0, cellsThisLeg: 3 },
    pace: {
      policy: "adaptive",
      burstCells: 8,
      settleTarget: 60,
      minSettle: 30,
      maxSettle: 120,
      harvestRadius: 12,
    },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 12345 },
    conductor: { pid: 12345 },
    updatedAt: "2026-08-08T21:30:00.000Z",
  };
}

test("migration-plan: 合法计划通过", () => {
  const result = parseMigrationPlan(validPlan());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.schema, "migration-plan-v1");
});

test("migration-plan: schema 不识别拒绝", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  plan.schema = "migration-plan-v0";
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason.includes("schema"));
});

test("migration-plan: 缺 lease 段拒绝（fail-closed）", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  delete plan.lease;
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
});

test("migration-plan: core 代际字段非法拒绝", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  plan.core = { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: -1 };
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason.includes("generation"));
});

test("migration-plan: pace.policy 枚举非法拒绝", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  (plan.pace as Record<string, unknown>).policy = "burst-only";
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reason.includes("pace.policy"));
});

test("migration-plan: path 含非法格拒绝", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  (plan.path as Record<string, unknown>).cells = [[-583, "x"]];
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
});

test("migration-plan: 非对象输入拒绝", () => {
  assert.equal(parseMigrationPlan(null).ok, false);
  assert.equal(parseMigrationPlan("text").ok, false);
  assert.equal(parseMigrationPlan([]).ok, false);
});

test("migration-plan: legProgress 非法拒绝（断点续传数据必须是可信的）", () => {
  const plan = validPlan() as unknown as Record<string, unknown>;
  plan.legProgress = { legIndex: 0, cellsThisLeg: "3" };
  const result = parseMigrationPlan(plan);
  assert.equal(result.ok, false);
});
