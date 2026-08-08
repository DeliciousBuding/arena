/**
 * 核心迁移目标军事审计测试（2026-08-08，migration-audit-v1）：
 * 生产实证 t1 危险迁移——[-619,-154]（227 资源/25 格）→ [-565,-95]
 * （1 资源/25 格 + 21 敌核 ≤80 格）应被拒绝；资源富足+无活跃敌核的目标
 * 应通过；活跃敌核贴脸应拒绝。纯函数无副作用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  auditMigrationTarget,
  type KnownResource,
  type EnemyCoreMemory,
} from "../src/domain/migration-audit.ts";

function res(x: number, y: number, lastSeenTick: number): KnownResource {
  return { x, y, lastSeenTick };
}
function core(x: number, y: number, lastSeenTick: number): EnemyCoreMemory {
  return { x, y, lastSeenTick };
}

const TICK = 70000;

test("migration-audit: 富矿区目标通过（资源达标 + 无活跃敌核）", () => {
  const audit = auditMigrationTarget(
    [-619, -154],
    [-618, -152],
    [
      res(-620, -155, TICK - 100),
      res(-618, -150, TICK - 200),
      res(-615, -158, TICK - 300),
      res(-622, -148, TICK - 400),
      res(-616, -151, TICK - 500),
      res(-621, -157, TICK - 600),
      res(-617, -149, TICK - 700),
      res(-619, -153, TICK - 800),
      res(-623, -156, TICK - 900),
      res(-614, -154, TICK - 1000),
    ],
    [core(-660, -100, TICK - 5000)],
    TICK,
  );
  assert.equal(audit.ok, true, `reasons: ${audit.reasons.join("; ")}`);
  assert.equal(audit.freshResourceCount, 10);
  assert.equal(audit.activeEnemyCoreCount, 0);
  assert.equal(audit.distance, 2);
});

test("migration-audit: 弃富投贫目标拒绝（t1 生产实证 [-565,-95] 仅 1 资源）", () => {
  const audit = auditMigrationTarget(
    [-619, -154],
    [-565, -95],
    [
      // 目标区几乎无资源（1 个已知，且陈旧）
      res(-564, -94, TICK - 9000),
      // 富矿区在出发地，不应计入目标区
      res(-620, -155, TICK - 100),
      res(-619, -154, TICK - 100),
    ],
    [],
    TICK,
  );
  assert.equal(audit.ok, false);
  assert.ok(audit.reasons.some((r) => r.includes("资源贫瘠")), audit.reasons.join("; "));
  assert.equal(audit.freshResourceCount, 0);
  assert.equal(audit.resourceCount, 1);
});

test("migration-audit: 活跃敌核贴脸目标拒绝（t3 [-524,258] 实证 969510853@3 格）", () => {
  const audit = auditMigrationTarget(
    [-537, 296],
    [-524, 258],
    // 资源达标
    [
      res(-524, 259, TICK - 100),
      res(-525, 257, TICK - 100),
      res(-523, 260, TICK - 100),
      res(-526, 258, TICK - 100),
      res(-522, 261, TICK - 100),
      res(-524, 256, TICK - 100),
      res(-525, 262, TICK - 100),
      res(-523, 255, TICK - 100),
      res(-527, 259, TICK - 100),
      res(-521, 258, TICK - 100),
    ],
    // 969510853@[-527,258] 近 3000 tick 活跃
    [core(-527, 258, TICK - 950)],
    TICK,
  );
  assert.equal(audit.ok, false);
  assert.ok(audit.reasons.some((r) => r.includes("活跃敌核")), audit.reasons.join("; "));
  assert.equal(audit.activeEnemyCoreCount, 1);
  assert.equal(audit.enemyCoreCount, 1);
});

test("migration-audit: 陈旧敌核不判活跃（敌核墓地可安全迁入）", () => {
  const audit = auditMigrationTarget(
    [-619, -154],
    [-565, -95],
    [
      res(-564, -94, TICK - 100),
      res(-566, -96, TICK - 100),
      res(-563, -93, TICK - 100),
      res(-567, -97, TICK - 100),
      res(-562, -92, TICK - 100),
      res(-568, -98, TICK - 100),
      res(-561, -91, TICK - 100),
      res(-569, -99, TICK - 100),
      res(-560, -90, TICK - 100),
      res(-570, -100, TICK - 100),
    ],
    // 全是 6000+ tick 前的旧记忆
    [core(-581, -96, TICK - 6000), core(-585, -120, TICK - 7000)],
    TICK,
  );
  assert.equal(audit.ok, true, `reasons: ${audit.reasons.join("; ")}`);
  assert.equal(audit.activeEnemyCoreCount, 0);
  assert.equal(audit.enemyCoreCount, 2);
});
