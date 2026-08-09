/**
 * 迁移助手与停滞检测测试（migration-assist-v1 §6 验收，M6，2026-08-09）。
 *
 * 覆盖：
 * - conductor：LEG_MOVE 停滞签名（NORMAL 未推进 ≥2 tick）→ clearRequests 生成；
 * - conductor：清空验证（clearRequests 格无我方单位 → 复位续走）；
 * - conductor：连续 3 次清路未果 → REPLAN（revision+1 回 PLAN）；
 * - conductor：MOVING/推进复位 stall 计数（不误判正常迁移）；
 * - assist：手动迁移检测（核心 MOVING 无计划）+ 手动窗口抑制；
 * - assist：失败签名（MOVING→NORMAL 位置未变）；
 * - assist：清路订单（clearRequests 格占用单位 → 让位 MOVE 方向）。
 * - plan：clearRequests/assist 可选字段（缺失 = 旧行为；非法值拒绝）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  conductorStep,
  INITIAL_CONDUCTOR_HELD_STATE,
  CONDUCTOR_LEASE_HORIZON_TICKS,
  type ConductorHeldState,
  type ConductorStepInput,
} from "../src/migration/conductor.ts";
import {
  migrationAssist,
  detectMigrationFailure,
  buildClearOrders,
  type AssistCoreSnapshot,
} from "../src/migration/assist.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationRuntimeConfig } from "../src/migration/config.ts";
import { parseMigrationPlan, type MigrationPlanV1 } from "../src/migration/plan.ts";

const NOW_BASE_MS = 1_800_000_000_000;
const TICK_MS = 1_000;

const RESOURCES: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] =
  (() => {
    const cells: { readonly x: number; readonly y: number; readonly lastSeenTick: number }[] = [];
    for (let x = 0; x <= 2; x += 1) {
      for (let y = 3; y <= 5; y += 1) {
        cells.push({ x, y, lastSeenTick: 0 });
      }
    }
    return cells;
  })();

/** LEG_MOVE 已审计计划：直线路径 (0,0) → (5,0)。 */
function makeMovingPlan(overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  const cells: readonly (readonly [number, number])[] = [
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
  ];
  return {
    schema: "migration-plan-v1",
    operationId: "op-m6-test-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "LEG_MOVE",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: {
      untilTick: 10_000 + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: new Date(NOW_BASE_MS + 10_000 * TICK_MS).toISOString(),
    },
    target: { x: 5, y: 0, reason: "M6 停滞检测测试目标" },
    path: { cells, corridorWidth: 8, lookahead: 30 },
    legs: [{ index: 0, from: { x: 0, y: 0 }, to: { x: 5, y: 0 }, audit: { ok: true, freshResources: 9, activeEnemyCores: 0 } }],
    legProgress: { legIndex: 0, cellsThisLeg: 0 },
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 4242 },
    updatedAt: new Date(NOW_BASE_MS).toISOString(),
    ...overrides,
  };
}

function step(
  plan: MigrationPlanV1,
  core: ConductorStepInput["core"],
  units: ConductorStepInput["units"],
  held: Readonly<ConductorHeldState> | null = INITIAL_CONDUCTOR_HELD_STATE,
  tick = 10_000,
  config: MigrationRuntimeConfig = DEFAULT_MIGRATION_RUNTIME_CONFIG,
) {
  return conductorStep({
    tick,
    nowMs: NOW_BASE_MS + tick * TICK_MS,
    core,
    events: [],
    units,
    survey: { resources: RESOURCES.map((r) => ({ ...r, lastSeenTick: tick })), enemyCores: [] },
    config,
    held,
    plan,
  });
}

// ---------------------------------------------------------------------------
// conductor：停滞 → clearRequests → 清空验证 → REPLAN
// ---------------------------------------------------------------------------

test("停滞 1 tick：不触发清路（stall<2 等待）", () => {
  const plan = makeMovingPlan();
  const result = step(plan, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, []);
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.equal(result.plan?.clearRequests, undefined, "stall<2 不得写清路请求");
  assert.equal(result.held.stallTicks, 1);
});

test("停滞 2 tick：迁移失败签名 → 写 clearRequests（destination + 前瞻）", () => {
  const plan = makeMovingPlan();
  // 第 1 tick：stall=1
  const first = step(plan, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, []);
  assert.equal(first.held.stallTicks, 1);
  assert.equal(first.held.stallRecordedTick, 10_000, "首次计数记录当前游戏 tick");
  // 第 2 个游戏 tick（run-conductor 同 tick 重复轮询去重后）：stall=2 → 写清路
  const second = step(first.plan!, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, [], first.held, 10_001);
  assert.ok(second.reasons.some((r) => r.includes("clearRequests")), `reasons 应含 clearRequests：${second.reasons.join("|")}`);
  assert.equal(second.plan?.clearRequests?.length, 2, "应清 destination [1,0] + 前瞻 [2,0]");
  assert.deepEqual(second.plan?.clearRequests?.[0], { x: 1, y: 0, reason: "destination" });
  assert.deepEqual(second.plan?.clearRequests?.[1], { x: 2, y: 0, reason: "ahead" });
  assert.equal(second.plan?.assist?.clearAheadReason, "blocked-retry");
  assert.equal(second.held.clearRetries, 1);
});

test("清空验证：clearRequests 格无单位 → 复位续走（stall/retries 清零、clearRequests 清除）", () => {
  const plan = makeMovingPlan({
    clearRequests: [{ x: 1, y: 0, reason: "destination" }, { x: 2, y: 0, reason: "ahead" }],
    assist: { clearAheadCells: 2, clearAheadReason: "blocked-retry" },
  });
  const result = step(
    plan,
    { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 },
    [{ id: "w1", unitType: "WORKER", cargo: 0, position: [3, 0] }], // 占用者已离开
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 3, clearRetries: 1 },
  );
  assert.equal(result.plan?.clearRequests, undefined, "清空后 clearRequests 必须移除");
  assert.equal(result.held.stallTicks, 0, "清空后 stall 复位");
  assert.equal(result.held.clearRetries, 0, "清空后重试计数复位");
  assert.ok(result.reasons.some((r) => r.includes("清路完成")), `reasons 应含清路完成：${result.reasons.join("|")}`);
});

test("清空未完成：单位仍在 destination → 重试计数累积；第 3 次 → REPLAN", () => {
  const plan = makeMovingPlan({
    clearRequests: [{ x: 1, y: 0, reason: "destination" }, { x: 2, y: 0, reason: "ahead" }],
    assist: { clearAheadCells: 2, clearAheadReason: "blocked-retry" },
  });
  const blocker: ConductorStepInput["units"] = [
    { id: "v1", unitType: "VANGUARD", cargo: 0, position: [1, 0] },
  ];
  // 重试 1
  const r1 = step(plan, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, blocker, {
    ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 2, clearRetries: 1,
  });
  assert.equal(r1.plan?.state, "LEG_MOVE", "重试 1 仍等待清路");
  assert.equal(r1.held.clearRetries, 2);
  // 重试 2（下一游戏 tick，累计第 3 次）→ REPLAN
  const r2 = step(r1.plan!, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, blocker, r1.held, 10_001);
  assert.equal(r2.plan?.state, "PLAN", "第 3 次清路未果 → REPLAN（回 PLAN）");
  assert.equal(r2.plan?.revision, 2, "REPLAN revision+1");
  assert.equal(r2.plan?.clearRequests, undefined, "REPLAN 清除旧清路请求（重生成路径）");
  assert.ok(r2.transitions.some((t) => t.event === "REPLAN_REQUESTED"), "应记录 REPLAN_REQUESTED");
});

test("MOVING 复位 stall：引擎正常推进不误判", () => {
  const plan = makeMovingPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [0, 0], state: "MOVING", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1 },
  );
  assert.equal(result.held.stallTicks, 0, "MOVING = 引擎推进中，stall 复位");
});

test("推进复位 stall：核心到达下一格不误判", () => {
  const plan = makeMovingPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1 },
  );
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.equal(result.held.stallTicks, 0, "推进后 stall 复位");
});

// ---------------------------------------------------------------------------
// conductor：中段停滞（M6 §4-D 扩展）—— 任意腿位置 NORMAL 未推进即计停滞
// ---------------------------------------------------------------------------

/** 中段计划：legProgress.cellsThisLeg=3（核心已越过腿起点 3 格），路径 6 格。 */
function makeMidLegPlan(overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  return makeMovingPlan({
    legProgress: { legIndex: 0, cellsThisLeg: 3 },
    ...overrides,
  });
}

test("中段停滞 1 tick：不触发清路（stall<2 等待）", () => {
  const plan = makeMidLegPlan();
  const result = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, []);
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.equal(result.plan?.clearRequests, undefined, "stall<2 不得写清路请求");
  assert.equal(result.held.stallTicks, 1, "腿中段 NORMAL 未推进应计停滞");
});

test("中段停滞 2 tick：迁移失败签名 → 写 clearRequests（当前格下一格 + 前瞻）", () => {
  const plan = makeMidLegPlan();
  const first = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, []);
  // 第 2 个游戏 tick（同 tick 重复轮询去重后）→ 触发
  const second = step(first.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], first.held, 10_001);
  assert.ok(second.reasons.some((r) => r.includes("clearRequests")), `reasons 应含 clearRequests：${second.reasons.join("|")}`);
  assert.equal(second.plan?.clearRequests?.length, 2, "应清当前格下一格 [4,0] + 前瞻 [5,0]");
  assert.deepEqual(second.plan?.clearRequests?.[0], { x: 4, y: 0, reason: "destination" });
  assert.deepEqual(second.plan?.clearRequests?.[1], { x: 5, y: 0, reason: "ahead" });
  assert.equal(second.plan?.assist?.clearAheadReason, "blocked-retry");
  assert.equal(second.held.clearRetries, 1);
});

// ---------------------------------------------------------------------------
// conductor：stall 按游戏 tick 去重（run-conductor 每 5s 轮询、游戏 tick 约 15s——
// 同一 input.tick 多次调用 conductorStep 不得累计计数）
// ---------------------------------------------------------------------------

test("同 tick 连续多次轮询：stall 不累计到 2（去重，不假触发清路）", () => {
  const plan = makeMidLegPlan();
  const first = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(first.held.stallTicks, 1);
  assert.equal(first.held.stallRecordedTick, 10_000, "首次计数记录当前游戏 tick");
  // 同游戏 tick 内 run-conductor 会多次轮询（5s 轮询 vs ~15s tick）
  const poll2 = step(first.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], first.held, 10_000);
  assert.equal(poll2.held.stallTicks, 1, "同 tick 第二次轮询不得累加");
  const poll3 = step(poll2.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], poll2.held, 10_000);
  assert.equal(poll3.held.stallTicks, 1, "同 tick 第三次轮询仍不得累加");
  assert.equal(poll3.plan?.clearRequests, undefined, "同 tick 重复轮询不得触发清路");
  assert.equal(poll3.plan?.state, "LEG_MOVE");
});

test("仅下一游戏 tick 才触发：tick+1 时 stall 到 2 → 写清路", () => {
  const plan = makeMidLegPlan();
  const first = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  const sameTick = step(first.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], first.held, 10_000);
  assert.equal(sameTick.held.stallTicks, 1, "同 tick 多次轮询 stall 保持 1");
  assert.equal(sameTick.plan?.clearRequests, undefined, "同 tick 不得触发清路");
  // 游戏 tick 前进 → 计数 +1 → 触发
  const nextTick = step(sameTick.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, [], sameTick.held, 10_001);
  assert.equal(nextTick.held.stallTicks, 2, "下一游戏 tick 才累计到 2");
  assert.equal(nextTick.held.stallRecordedTick, 10_001, "触发 tick 记录为当前游戏 tick");
  assert.ok(nextTick.reasons.some((r) => r.includes("clearRequests")), `reasons 应含 clearRequests：${nextTick.reasons.join("|")}`);
  assert.equal(nextTick.plan?.clearRequests?.length, 2, "仅下一游戏 tick 触发清路");
});

test("推进后同 tick 再轮询：不计停滞（stall 保持 0）", () => {
  const plan = makeMovingPlan();
  const progressed = step(plan, { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 }, [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(progressed.held.stallTicks, 0, "真实推进复位 stall");
  assert.equal(progressed.held.stallRecordedTick, 10_000, "推进复位同时记录当前 tick");
  assert.equal(progressed.plan?.legProgress.cellsThisLeg, 1, "推进写入持久化进度");
  // 同 tick 再次轮询（位置未再推进）→ 不得重新计 1
  const rePoll = step(progressed.plan!, { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 }, [], progressed.held, 10_000);
  assert.equal(rePoll.held.stallTicks, 0, "推进后同 tick 重复轮询不得计 1");
  assert.equal(rePoll.plan?.clearRequests, undefined, "推进后同 tick 不得触发清路");
  assert.equal(rePoll.plan?.state, "LEG_MOVE");
});

test("中段清空验证：clearRequests 格无单位 → 复位续走（stall/retries 清零、clearRequests 清除）", () => {
  const plan = makeMidLegPlan({
    clearRequests: [{ x: 4, y: 0, reason: "destination" }, { x: 5, y: 0, reason: "ahead" }],
    assist: { clearAheadCells: 2, clearAheadReason: "blocked-retry" },
  });
  const result = step(
    plan,
    { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 },
    [{ id: "w1", unitType: "WORKER", cargo: 0, position: [6, 0] }], // 占用者已离开
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 3, clearRetries: 1 },
  );
  assert.equal(result.plan?.clearRequests, undefined, "清空后 clearRequests 必须移除");
  assert.equal(result.held.stallTicks, 0, "清空后 stall 复位");
  assert.equal(result.held.clearRetries, 0, "清空后重试计数复位");
  assert.ok(result.reasons.some((r) => r.includes("清路完成")), `reasons 应含清路完成：${result.reasons.join("|")}`);
});

test("同 tick 已累计到 clear retry 2：不得立即误 REPLAN，下一游戏 tick 才执行第 3 次", () => {
  const plan = makeMidLegPlan({
    clearRequests: [{ x: 4, y: 0, reason: "destination" }, { x: 5, y: 0, reason: "ahead" }],
    assist: { clearAheadCells: 2, clearAheadReason: "blocked-retry" },
  });
  const blocker: ConductorStepInput["units"] = [
    { id: "v1", unitType: "VANGUARD", cargo: 0, position: [4, 0] },
  ];
  const held = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    stallTicks: 2,
    stallRecordedTick: 10_000,
    clearRetries: 2,
  };

  const sameTick = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, blocker, held, 10_000);
  assert.equal(sameTick.plan?.state, "LEG_MOVE", "同 tick 重复轮询不得把 retry 2 直接升级为 REPLAN");
  assert.equal(sameTick.held.clearRetries, 2, "同 tick retry 计数保持 2");

  const nextTick = step(sameTick.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, blocker, sameTick.held, 10_001);
  assert.equal(nextTick.plan?.state, "PLAN", "下一游戏 tick 才执行第 3 次失败并 REPLAN");
  assert.ok(nextTick.transitions.some((transition) => transition.event === "REPLAN_REQUESTED"));
});

test("中段清空未完成：单位仍在 destination → 重试计数累积；第 3 次 → REPLAN", () => {
  const plan = makeMidLegPlan({
    clearRequests: [{ x: 4, y: 0, reason: "destination" }, { x: 5, y: 0, reason: "ahead" }],
    assist: { clearAheadCells: 2, clearAheadReason: "blocked-retry" },
  });
  const blocker: ConductorStepInput["units"] = [
    { id: "v1", unitType: "VANGUARD", cargo: 0, position: [4, 0] },
  ];
  // 重试 1
  const r1 = step(plan, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, blocker, {
    ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 2, clearRetries: 1,
  });
  assert.equal(r1.plan?.state, "LEG_MOVE", "重试 1 仍等待清路");
  assert.equal(r1.held.clearRetries, 2);
  // 重试 2（下一游戏 tick，累计第 3 次）→ REPLAN
  const r2 = step(r1.plan!, { id: "uuid-A", position: [3, 0], state: "NORMAL", hp: 5 }, blocker, r1.held, 10_001);
  assert.equal(r2.plan?.state, "PLAN", "第 3 次清路未果 → REPLAN（回 PLAN）");
  assert.equal(r2.plan?.revision, 2, "REPLAN revision+1");
  assert.equal(r2.plan?.clearRequests, undefined, "REPLAN 清除旧清路请求（重生成路径）");
  assert.ok(r2.transitions.some((t) => t.event === "REPLAN_REQUESTED"), "应记录 REPLAN_REQUESTED");
});

test("中段 MOVING 复位 stall：引擎正常推进不误判", () => {
  const plan = makeMidLegPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [3, 0], state: "MOVING", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1 },
  );
  assert.equal(result.held.stallTicks, 0, "MOVING = 引擎推进中，stall 复位");
});

test("中段推进复位 stall：核心到达下一格不误判", () => {
  const plan = makeMidLegPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [4, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1 },
  );
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.equal(result.held.stallTicks, 0, "推进后 stall 复位");
});

// ---------------------------------------------------------------------------
// conductor：清路验证 fail-closed（position=null 单位不可观测 → 不得判 cleared）
// ---------------------------------------------------------------------------

test("清路验证 fail-closed：存在 position=null 单位 → 不得判 cleared（计入重试，最终 REPLAN）", () => {
  const plan = makeMovingPlan({
    clearRequests: [{ x: 1, y: 0, reason: "destination" }],
    assist: { clearAheadCells: 1, clearAheadReason: "blocked-retry" },
  });
  const nullPositionUnits: ConductorStepInput["units"] = [
    { id: "v1", unitType: "VANGUARD", cargo: 0, position: null },
  ];
  const first = step(
    plan,
    { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 },
    nullPositionUnits,
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 2, clearRetries: 0 },
    10_000,
  );
  assert.equal(first.plan?.clearRequests?.length, 1, "不可观测 → 不得清除 clearRequests");
  assert.equal(first.held.clearRetries, 1, "不可观测 → 计入一次重试");
  const sameTick = step(first.plan!, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, nullPositionUnits, first.held, 10_000);
  assert.equal(sameTick.held.clearRetries, 1, "同 tick 重复轮询不得累加重试");
  const nextTick = step(sameTick.plan!, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, nullPositionUnits, sameTick.held, 10_001);
  assert.equal(nextTick.held.clearRetries, 2, "下一游戏 tick 重试 +1");
  const replan = step(nextTick.plan!, { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 }, nullPositionUnits, nextTick.held, 10_002);
  assert.equal(replan.plan?.state, "PLAN", "连续 3 次不可观测 → REPLAN（fail-closed 不无限自清）");
});

test("清路验证：units=[]（确无单位可观察）→ 视为已清", () => {
  const plan = makeMovingPlan({
    clearRequests: [{ x: 1, y: 0, reason: "destination" }],
    assist: { clearAheadCells: 1, clearAheadReason: "blocked-retry" },
  });
  const result = step(
    plan,
    { id: "uuid-A", position: [0, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 2, clearRetries: 0 },
    10_000,
  );
  assert.equal(result.plan?.clearRequests, undefined, "无单位可观察 → 清路完成");
  assert.equal(result.held.clearRetries, 0);
  assert.equal(result.held.stallTicks, 0);
});

// ---------------------------------------------------------------------------
// conductor：clearRetries episode 复位（MOVING/推进/腿完成/burst 完成 → 清零）
// ---------------------------------------------------------------------------

test("MOVING 复位 stall 同时清 clearRetries：清路 episode 结束不跨 episode 继承", () => {
  const plan = makeMovingPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [0, 0], state: "MOVING", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1, clearRetries: 2 },
  );
  assert.equal(result.held.stallTicks, 0);
  assert.equal(result.held.clearRetries, 0, "MOVING = 引擎推进，清路 episode 结束");
});

test("推进复位 stall 同时清 clearRetries", () => {
  const plan = makeMovingPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1, clearRetries: 2 },
  );
  assert.equal(result.plan?.state, "LEG_MOVE");
  assert.equal(result.held.stallTicks, 0);
  assert.equal(result.held.clearRetries, 0, "真实推进 → 清路 episode 结束");
});

test("腿完成 → LEG_SETTLE 清 clearRetries", () => {
  const plan = makeMovingPlan();
  const result = step(
    plan,
    { id: "uuid-A", position: [5, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1, clearRetries: 2 },
  );
  assert.equal(result.plan?.state, "LEG_SETTLE", "到达腿终点 → 休整");
  assert.equal(result.held.clearRetries, 0, "腿完成 → 清路 episode 结束");
});

test("burst 达标 → LEG_SETTLE 清 clearRetries", () => {
  const plan = makeMovingPlan({
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace, burstCells: 2 },
  });
  const result = step(
    { ...plan, legProgress: { legIndex: 0, cellsThisLeg: 1 } },
    { id: "uuid-A", position: [2, 0], state: "NORMAL", hp: 5 },
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, stallTicks: 1, clearRetries: 2 },
  );
  assert.equal(result.plan?.state, "LEG_SETTLE", "burst 达标 → 休整");
  assert.equal(result.held.clearRetries, 0, "burst 完成 → 清路 episode 结束");
});

// ---------------------------------------------------------------------------
// conductor：SETTLE→LEG_MOVE 重入复位 stall（起步握手窗不计停滞）
// ---------------------------------------------------------------------------

test("SETTLE→LEG_MOVE：reset stall 并记录当前 tick（旧 burst 残留 stall 不继承）", () => {
  const plan = makeMovingPlan({
    state: "LEG_SETTLE" as const,
    legProgress: { legIndex: 0, cellsThisLeg: 1 },
  });
  const held: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    settleElapsed: 120, // 达到 maxSettle → 强制退出
    stallTicks: 3,
    stallRecordedTick: 9_000,
    clearRetries: 2,
  };
  const result = step(plan, { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 }, [], held, 10_000);
  assert.equal(result.plan?.state, "LEG_MOVE", "settle 强制退出 → 回 LEG_MOVE");
  assert.equal(result.held.stallTicks, 0, "SETTLE→LEG_MOVE 重入必须复位 stall");
  assert.equal(result.held.stallRecordedTick, 10_000, "复位记录当前游戏 tick（同 tick 轮询不重计）");
  assert.equal(result.held.clearRetries, 0, "episode 边界清 clearRetries");
  const sameTick = step(result.plan!, { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 }, [], result.held, 10_000);
  assert.equal(sameTick.held.stallTicks, 0, "复位 tick 内轮询不计停滞");
  const nextTick = step(sameTick.plan!, { id: "uuid-A", position: [1, 0], state: "NORMAL", hp: 5 }, [], sameTick.held, 10_001);
  assert.equal(nextTick.held.stallTicks, 1, "复位后首个新游戏 tick 才计停滞");
});

// ---------------------------------------------------------------------------
// assist：手动迁移检测 + 手动窗口抑制
// ---------------------------------------------------------------------------

test("手动迁移检测：核心 MOVING 且无计划 → manualMigration=true + suppressCoreOrder=true", () => {
  const result = migrationAssist({
    tick: 100,
    core: { position: [-35, 33], state: "MOVING", destination: [-36, 33], moveProgress: 3, moveRequiredTicks: 4 },
    units: [],
    plan: null,
    planActive: false,
  });
  assert.equal(result.manualMigration, true);
  assert.equal(result.suppressCoreOrder, true, "手动迁移期应抑制 planner 的 START_MOVE");
});

test("无迁移：核心 NORMAL 无计划 → 无抑制", () => {
  const result = migrationAssist({
    tick: 100,
    core: { position: [-35, 33], state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null },
    units: [],
    plan: null,
    planActive: false,
  });
  assert.equal(result.manualMigration, false);
  assert.equal(result.suppressCoreOrder, false);
});

test("自动迁移：计划生效时不清路抑制（overlay 自己发 START_MOVE）", () => {
  const plan = makeMovingPlan();
  const result = migrationAssist({
    tick: 100,
    core: { position: [0, 0], state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null },
    units: [],
    plan,
    planActive: true,
  });
  assert.equal(result.suppressCoreOrder, false);
});

// ---------------------------------------------------------------------------
// assist：失败签名 + 清路订单
// ---------------------------------------------------------------------------

test("失败签名：MOVING→NORMAL 位置未变 = 失败；位置变了 = 成功", () => {
  const moving: AssistCoreSnapshot = { position: [-35, 33], state: "MOVING", destination: null, moveProgress: null, moveRequiredTicks: null };
  assert.equal(
    detectMigrationFailure(moving, { position: [-35, 33], state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null }),
    true,
    "位置未变 = 失败签名",
  );
  assert.equal(
    detectMigrationFailure(moving, { position: [-36, 33], state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null }),
    false,
    "位置变化 = 迁移成功",
  );
  assert.equal(detectMigrationFailure(null, moving), false, "无 prev 不判定");
  assert.equal(detectMigrationFailure(moving, moving), false, "仍 MOVING 不判定");
});

test("清路订单：clearRequests 格占用单位 → 让位 MOVE（远离核心方向）", () => {
  const plan = makeMovingPlan({
    clearRequests: [{ x: 1, y: 0, reason: "destination" }],
  });
  const orders = buildClearOrders(
    plan,
    [{ id: "v1", unitType: "VANGUARD", position: [1, 0], cargo: 0 }],
    { position: [0, 0], state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null },
  );
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.unitId, "v1");
  assert.equal(orders[0]!.direction, "RIGHT", "单位在核心东侧 → 让位方向 RIGHT（远离核心）");
  assert.equal(orders[0]!.reason, "clear:destination");
});

test("清路订单：无 clearRequests / 无占用单位 → 空数组", () => {
  const plan = makeMovingPlan();
  assert.deepEqual(buildClearOrders(plan, [{ id: "v1", unitType: "VANGUARD", position: [1, 0], cargo: 0 }], null), []);
  const plan2 = makeMovingPlan({ clearRequests: [{ x: 1, y: 0, reason: "destination" }] });
  assert.deepEqual(buildClearOrders(plan2, [{ id: "v1", unitType: "VANGUARD", position: [5, 0], cargo: 0 }], null), []);
});

// ---------------------------------------------------------------------------
// plan：可选字段解析（向后兼容 + 非法拒绝）
// ---------------------------------------------------------------------------

test("plan 解析：无 clearRequests/assist → 旧行为通过", () => {
  const plan = makeMovingPlan();
  const raw = JSON.parse(JSON.stringify(plan));
  delete raw.clearRequests;
  delete raw.assist;
  const parsed = parseMigrationPlan(raw);
  assert.equal(parsed.ok, true, "旧计划（无 M6 字段）必须通过");
});

test("plan 解析：clearRequests 非法（>3 格 / 非格对象）→ 拒绝", () => {
  const plan = makeMovingPlan();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  raw.clearRequests = [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }];
  assert.equal(parseMigrationPlan(raw).ok, false, ">3 格必须拒绝");
  raw.clearRequests = [{ x: "bad" as unknown as number, y: 0 }];
  assert.equal(parseMigrationPlan(raw).ok, false, "非法格必须拒绝");
});

test("plan 解析：assist 非法（枚举错）→ 拒绝", () => {
  const plan = makeMovingPlan();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  raw.assist = { clearAheadCells: 2, clearAheadReason: "unknown-reason" };
  assert.equal(parseMigrationPlan(raw).ok, false, "assist 枚举非法必须拒绝");
});
