/**
 * 迁移 overlay 测试（migration-system-v1 §1/§6.2，评审 P0-3）：
 * 无计划/关闭 = 零影响；lease 过期/epoch 错配/核心代际变化 = fail-closed；
 * LEG_MOVE burst 推进（enableCoreOrders）；LEG_SETTLE 不产迁移订单。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan } from "../src/domain/model.ts";
import {
  migrationOverlay,
  migrationContractValid,
  directionToNextPathCell,
  type MigrationOverlayContext,
} from "../src/migration/overlay.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG, type MigrationRuntimeConfig } from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

const NOW_MS = Date.parse("2026-08-08T22:00:00.000Z");
const HEARTBEAT = new Date(NOW_MS).toISOString();

function emptyPlan(tick: number): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

function plan(overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  return {
    schema: "migration-plan-v1",
    operationId: "op-test-01",
    revision: 1,
    conductorEpoch: 3,
    tenant: "t1",
    mode: "migrate",
    state: "LEG_MOVE",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: { untilTick: 75000, heartbeatAt: HEARTBEAT },
    target: { x: -20, y: 40, reason: "test" },
    path: {
      cells: [[0, 0], [0, -1], [0, -2], [0, -3]],
      corridorWidth: 8,
      lookahead: 30,
    },
    legs: [
      {
        index: 0,
        from: { x: 0, y: 0 },
        to: { x: 0, y: -10 },
        audit: { ok: true, freshResources: 12, activeEnemyCores: 0 },
      },
    ],
    legProgress: { legIndex: 0, cellsThisLeg: 2 },
    pace: {
      policy: "adaptive",
      burstCells: 8,
      settleTarget: 60,
      minSettle: 30,
      maxSettle: 120,
      harvestRadius: 12,
    },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 123 },
    updatedAt: HEARTBEAT,
    ...overrides,
  };
}

function enabledConfig(): MigrationRuntimeConfig {
  return {
    ...DEFAULT_MIGRATION_RUNTIME_CONFIG,
    enabled: true,
    overlay: { enableCoreOrders: true, recheckEpochEachTick: true },
  };
}

function context(overrides: Partial<MigrationOverlayContext> = {}): MigrationOverlayContext {
  return {
    state: { tick: 74000, core: { position: [0, 0], id: "uuid-A", state: "NORMAL" } },
    plan: emptyPlan(74000),
    migrationPlan: plan(),
    nowMs: NOW_MS,
    fileEpoch: 3,
    config: enabledConfig(),
    ...overrides,
  };
}

test("overlay: 模块关闭 → 零影响", () => {
  const result = migrationOverlay(context({ config: DEFAULT_MIGRATION_RUNTIME_CONFIG }));
  assert.equal(result.active, false);
  assert.equal(result.failClosed, false);
  assert.deepEqual(result.plan, context().plan);
});

test("overlay: 无计划（null）→ 零影响", () => {
  const result = migrationOverlay(context({ migrationPlan: null }));
  assert.equal(result.active, false);
  assert.equal(result.failClosed, false);
});

test("overlay: lease 过期 → fail-closed（不发迁移订单）", () => {
  const stale = plan({ lease: { untilTick: 73999, heartbeatAt: HEARTBEAT } });
  const result = migrationOverlay(context({ migrationPlan: stale }));
  assert.equal(result.active, false);
  assert.equal(result.failClosed, true);
  assert.ok(result.reasons.some((r) => r.includes("lease")), result.reasons.join("; "));
  assert.equal(result.coreOrder, null);
});

test("overlay: 心跳停止（超过 TTL）→ fail-closed", () => {
  const stale = plan({
    lease: { untilTick: 75000, heartbeatAt: new Date(NOW_MS - 2 * 60_000).toISOString() },
  });
  const result = migrationOverlay(context({ migrationPlan: stale }));
  assert.equal(result.failClosed, true);
});

test("overlay: conductorEpoch 错配（文件被新 conductor 改写）→ fail-closed", () => {
  const result = migrationOverlay(context({ fileEpoch: 4 }));
  assert.equal(result.failClosed, true);
  assert.ok(
    result.reasons.some((r) => r.toLowerCase().includes("epoch")),
    result.reasons.join("; "),
  );
});

test("overlay: 文件消失（fileEpoch=null）→ fail-closed", () => {
  const result = migrationOverlay(context({ fileEpoch: null }));
  assert.equal(result.failClosed, true);
});

test("overlay: 核心代际变化（currentCoreId ≠ originCoreId）→ fail-closed", () => {
  const result = migrationOverlay(
    context({ state: { tick: 74000, core: { position: [0, 0], id: "uuid-B", state: "NORMAL" } } }),
  );
  assert.equal(result.failClosed, true);
  assert.ok(result.reasons.some((r) => r.includes("代际")), result.reasons.join("; "));
});

test("overlay: fail-closed 时移除已有 START_MOVE（防御性）", () => {
  const ctx = context({ migrationPlan: plan({ lease: { untilTick: 1, heartbeatAt: HEARTBEAT } }) });
  const withMove: Plan = { ...ctx.plan, coreAction: { type: "START_MOVE", direction: "UP" } };
  const result = migrationOverlay({ ...ctx, plan: withMove });
  assert.equal(result.failClosed, true);
  assert.equal(result.plan.coreAction, null);
});

test("overlay: LEG_MOVE + NORMAL + burst 未达 → 生成 START_MOVE（沿路径）", () => {
  const result = migrationOverlay(context({}));
  assert.equal(result.active, true);
  assert.equal(result.coreOrder?.type, "START_MOVE");
  assert.equal(result.coreOrder?.direction, "UP"); // 路径 [0,0]→[0,-1]
  assert.equal(result.plan.coreAction?.type, "START_MOVE");
});

test("overlay: 核心 MOVING → 不生成新订单（wait_moving）", () => {
  const result = migrationOverlay(
    context({ state: { tick: 74000, core: { position: [0, -1], id: "uuid-A", state: "MOVING" } } }),
  );
  assert.equal(result.coreOrder, null);
});

test("overlay: LEG_SETTLE → 不生成迁移订单（经济恢复窗口）", () => {
  const result = migrationOverlay(context({ migrationPlan: plan({ state: "LEG_SETTLE" }) }));
  assert.equal(result.coreOrder, null);
  assert.equal(result.active, true);
});

test("overlay: enableCoreOrders=false → 只报告不产订单", () => {
  const config = { ...enabledConfig(), overlay: { enableCoreOrders: false, recheckEpochEachTick: true } };
  const result = migrationOverlay(context({ config }));
  assert.equal(result.active, true);
  assert.equal(result.coreOrder, null);
  assert.ok(result.reasons.some((r) => r.includes("未启用")), result.reasons.join("; "));
});

test("overlay: workerBand 透传（集结带配置）", () => {
  const result = migrationOverlay(context({}));
  assert.equal(result.workerBand, 15);
  const unset = migrationOverlay(context({ config: { ...enabledConfig(), workerBand: null } }));
  assert.equal(unset.workerBand, null);
});

test("migrationContractValid: 三条件全满足 → ok", () => {
  const check = migrationContractValid(plan(), { tick: 74000, core: { id: "uuid-A" } }, NOW_MS, 3);
  assert.equal(check.ok, true);
});

test("directionToNextPathCell: 沿路径找相邻格方向；不相邻返回 null", () => {
  const cells = [[0, 0], [0, -1], [1, -1]] as const;
  assert.deepEqual(directionToNextPathCell(cells, [0, 0], 0), { direction: "UP", nextIndex: 1 });
  assert.deepEqual(directionToNextPathCell(cells, [0, -1], 0), { direction: "RIGHT", nextIndex: 2 });
  assert.equal(directionToNextPathCell(cells, [5, 5], 0), null);
  assert.equal(directionToNextPathCell([[0, 0]], [0, 0], 0), null); // 无后续格
});
