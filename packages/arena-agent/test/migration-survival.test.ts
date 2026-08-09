/**
 * 迁移生存性测试（migration-survival-v1 §3/§4/§5 验收，M8，2026-08-09）。
 *
 * 覆盖：
 * - conductor：THREAT_ESCALATED——SETTLE 中敌核贴脸持续 → REPLAN 换目的地；
 * - conductor：窗口内第 3 次升级 → ABORT（安全落）；
 * - conductor：敌核离开 → 贴脸计数复位；CORE_DAMAGED 优先于升级；
 * - conductor：DEFENSIVE_HOLD 中贴脸持续 → 升级；
 * - conductor：战损编成缺口（军事 <6 持续 ≥5 tick → plan.replenish；恢复 → 清除）；
 * - assist：卸货 wait-ring（核心格容量满 → 满载 worker 停邻格；空载不受影响）。
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
import { buildWaitRingOrders, type AssistCoreSnapshot } from "../src/migration/assist.ts";
import { DEFAULT_MIGRATION_RUNTIME_CONFIG } from "../src/migration/config.ts";
import type { MigrationRuntimeConfig } from "../src/migration/config.ts";
import type { MigrationPlanV1 } from "../src/migration/plan.ts";

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

function makeSettlePlan(overrides: Partial<MigrationPlanV1> = {}): MigrationPlanV1 {
  const cells: readonly (readonly [number, number])[] = [
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
  ];
  return {
    schema: "migration-plan-v1",
    operationId: "op-m8-survival-01",
    revision: 1,
    conductorEpoch: 0,
    tenant: "t1",
    mode: "migrate",
    state: "LEG_SETTLE",
    core: { originCoreId: "uuid-A", currentCoreId: "uuid-A", generation: 1 },
    lease: {
      untilTick: 10_000 + CONDUCTOR_LEASE_HORIZON_TICKS,
      heartbeatAt: new Date(NOW_BASE_MS + 10_000 * TICK_MS).toISOString(),
    },
    target: { x: 5, y: 0, reason: "M8 生存性测试目标" },
    path: { cells, corridorWidth: 8, lookahead: 30 },
    legs: [{ index: 0, from: { x: 0, y: 0 }, to: { x: 5, y: 0 }, audit: { ok: true, freshResources: 9, activeEnemyCores: 0 } }],
    legProgress: { legIndex: 0, cellsThisLeg: 5 },
    pace: { ...DEFAULT_MIGRATION_RUNTIME_CONFIG.pace },
    roles: { quotas: { escort: 40, sweep: 30, scout: 15, rear: 15 }, seed: 1 },
    conductor: { pid: 4242 },
    updatedAt: new Date(NOW_BASE_MS).toISOString(),
    ...overrides,
  };
}

interface EnemyCores {
  readonly x: number;
  readonly y: number;
  readonly lastSeenTick: number;
}

function step(
  plan: MigrationPlanV1,
  core: ConductorStepInput["core"],
  units: ConductorStepInput["units"],
  enemyCores: readonly EnemyCores[],
  held: Readonly<ConductorHeldState> | null = INITIAL_CONDUCTOR_HELD_STATE,
  tick = 10_000,
  config: MigrationRuntimeConfig = DEFAULT_MIGRATION_RUNTIME_CONFIG,
  events: readonly { readonly type?: string }[] = [],
) {
  return conductorStep({
    tick,
    nowMs: NOW_BASE_MS + tick * TICK_MS,
    core,
    events,
    units,
    survey: { resources: RESOURCES.map((r) => ({ ...r, lastSeenTick: tick })), enemyCores },
    config,
    held,
    plan,
  });
}

/** 活跃敌核 8 格外（默认 escalateRadius=12 内）：x=0,y=0 核心 → 敌核 (8,0) 距 8。 */
const NEAR_ENEMY: readonly EnemyCores[] = [{ x: 8, y: 0, lastSeenTick: 10_000 }];

// ---------------------------------------------------------------------------
// THREAT_ESCALATED：SETTLE 中敌核贴脸持续 → REPLAN / ABORT
// ---------------------------------------------------------------------------

test("威胁升级：贴脸 1-9 tick 计数中（不升级、不离开 SETTLE）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  for (let tick = 10_000; tick < 10_009; tick += 1) {
    const result = step(plan, core, [], NEAR_ENEMY, held, tick);
    held = result.held;
    assert.equal(result.plan?.state, "LEG_SETTLE", `tick ${tick} 贴脸计数中不得升级`);
    assert.equal(result.held.threatStallTicks, tick - 10_000 + 1, `tick ${tick} 贴脸计数应递增`);
  }
});

test("威胁升级：贴脸持续 10 tick → REPLAN_REQUESTED → PLAN（revision+1，换目的地）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  let current: MigrationPlanV1 = plan;
  for (let tick = 10_000; tick < 10_009; tick += 1) {
    const result = step(current, core, [], NEAR_ENEMY, held, tick);
    held = result.held;
    current = result.plan!;
  }
  const escalated = step(current, core, [], NEAR_ENEMY, held, 10_009);
  assert.equal(escalated.plan?.state, "PLAN", "贴脸 10 tick → REPLAN 回 PLAN");
  assert.equal(escalated.plan?.revision, 2, "REPLAN revision+1");
  assert.ok(escalated.transitions.some((t) => t.event === "REPLAN_REQUESTED"), "应记录 REPLAN_REQUESTED");
  assert.ok(escalated.reasons.some((r) => r.includes("换目的地")), `reasons 应说明换目的地：${escalated.reasons.join("|")}`);
});

test("威胁升级：敌核离开 → 贴脸计数复位（不误升级）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  let held: ConductorHeldState = { ...INITIAL_CONDUCTOR_HELD_STATE, threatStallTicks: 9, threatFirstTick: 10_000 };
  // 敌核目击陈旧（lastSeenTick 距今 > MIGRATION_ENEMY_ACTIVE_WINDOW=3000 → 离开警戒范围）
  const result = step(plan, core, [], [{ x: 8, y: 0, lastSeenTick: 6_000 }], held, 10_010);
  assert.equal(result.plan?.state, "LEG_SETTLE", "敌核离开不得升级");
  assert.equal(result.held.threatStallTicks, 0, "敌核离开 → 贴脸计数复位");
  assert.equal(result.held.threatReplanCount, 0, "未升级过 → 升级计数 0");
});

test("威胁升级：窗口内第 3 次 → THREAT_ESCALATED → ABORT（安全落）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  // 已升级 2 次（窗口内），当前贴脸计数满 10
  let held: ConductorHeldState = {
    ...INITIAL_CONDUCTOR_HELD_STATE,
    threatStallTicks: 10,
    threatFirstTick: 9_500,
    threatReplanCount: 2,
  };
  const result = step(plan, core, [], NEAR_ENEMY, held, 10_000);
  assert.equal(result.plan?.state, "ABORT", "窗口内第 3 次升级 → ABORT");
  assert.ok(result.transitions.some((t) => t.event === "THREAT_ESCALATED"), "应记录 THREAT_ESCALATED");
  assert.ok(result.reasons.some((r) => r.includes("安全落")), `reasons 应说明安全落：${result.reasons.join("|")}`);
});

test("威胁升级：DEFENSIVE_HOLD 中贴脸持续 → REPLAN（HOLD 不是敌占区长期驻留）", () => {
  const plan = makeSettlePlan({ state: "DEFENSIVE_HOLD" as const });
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 3 };
  let held: ConductorHeldState = { ...INITIAL_CONDUCTOR_HELD_STATE, holdTicks: 2, threatStallTicks: 9 };
  const result = step(plan, core, [], NEAR_ENEMY, held, 10_000);
  assert.equal(result.plan?.state, "PLAN", "HOLD 中贴脸 10 tick → REPLAN");
  assert.equal(result.plan?.revision, 2);
});

test("威胁升级：CORE_DAMAGED 优先于贴脸升级（被打先防御）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 3 };
  let held: ConductorHeldState = { ...INITIAL_CONDUCTOR_HELD_STATE, threatStallTicks: 9 };
  const result = step(plan, core, [], NEAR_ENEMY, held, 10_000, DEFAULT_MIGRATION_RUNTIME_CONFIG, [{ type: "CORE_DAMAGED" }]);
  assert.equal(result.plan?.state, "DEFENSIVE_HOLD", "受击事件 → 先防御（HOLD），不升级");
});

// ---------------------------------------------------------------------------
// 战损补员：编成缺口检测（SETTLE）
// ---------------------------------------------------------------------------

/** 军事单位数（VANGUARD/RANGER）；WORKER 不计。 */
function militaryUnits(count: number): ConductorStepInput["units"] {
  const units: {
    readonly id: string;
    readonly unitType: string;
    readonly cargo: number;
    readonly position: readonly [number, number] | null;
  }[] = [];
  for (let index = 0; index < count; index += 1) {
    units.push({
      id: `m${index}`,
      unitType: index % 2 === 0 ? "VANGUARD" : "RANGER",
      cargo: 0,
      position: null,
    });
  }
  return units;
}

test("编成缺口：军事 <6 持续 5 tick → plan.replenish 写入（gap + 缺口角色 + sinceTick）", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  let current: MigrationPlanV1 = plan;
  // 缺口前 4 tick：计数不写（防阵亡瞬间误报）
  for (let tick = 10_000; tick < 10_004; tick += 1) {
    const result = step(current, core, militaryUnits(4), [], held, tick);
    held = result.held;
    current = result.plan!;
    assert.equal(current.replenish, undefined, `tick ${tick} 缺口 <5 tick 不得写请求`);
  }
  // 第 5 tick：写请求（gap=6-4=2；4→5 退化表新增 RG）
  const confirmed = step(current, core, militaryUnits(4), [], held, 10_004);
  assert.equal(confirmed.plan?.replenish?.gap, 2, "gap = minMilitaryCount - military");
  assert.equal(confirmed.plan?.replenish?.missingRole, "RG", "4→5 档新增 RG（退化表推导）");
  assert.equal(confirmed.plan?.replenish?.sinceTick, 10_000, "sinceTick = 缺口首现 tick");
  assert.ok(confirmed.reasons.some((r) => r.includes("编成缺口确认")), `reasons 应确认缺口：${confirmed.reasons.join("|")}`);
});

test("编成缺口：满编（≥6）→ 无请求；恢复 → 请求清除", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  // 满编：不写
  const full = step(plan, core, militaryUnits(6), [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(full.plan?.replenish, undefined, "满编不得写缺口");
  // 已有请求 + 恢复满编 → 清除
  const withRequest = makeSettlePlan({ replenish: { gap: 2, missingRole: "RG", sinceTick: 10_000 } });
  const recovered = step(
    withRequest,
    core,
    militaryUnits(7),
    [],
    { ...INITIAL_CONDUCTOR_HELD_STATE, gapTicks: 3 },
    10_000,
  );
  assert.equal(recovered.plan?.replenish, undefined, "缺口恢复 → replenish 清除");
  assert.ok(recovered.reasons.some((r) => r.includes("恢复")), `reasons 应说明恢复：${recovered.reasons.join("|")}`);
});

test("编成缺口：已请求且缺口未恢复 → 保持（不重复写、sinceTick 不变）", () => {
  const plan = makeSettlePlan({ replenish: { gap: 1, missingRole: "ES", sinceTick: 10_000 } });
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  const result = step(plan, core, militaryUnits(5), [], INITIAL_CONDUCTOR_HELD_STATE, 10_010);
  assert.equal(result.plan?.replenish?.gap, 1, "请求保持");
  assert.equal(result.plan?.replenish?.sinceTick, 10_000, "sinceTick 不更新");
});

// ---------------------------------------------------------------------------
// per-game-tick 去重：run-conductor 5s 轮询 vs ~15s 游戏 tick（同 tick 不得 3x 压缩）
// ---------------------------------------------------------------------------

test("同 tick 3 次轮询：threatStallTicks 只按游戏 tick 增长", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  const first = step(plan, core, militaryUnits(6), NEAR_ENEMY, INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(first.held.threatStallTicks, 1, "首个游戏 tick 贴脸计数 1");
  const poll2 = step(first.plan!, core, militaryUnits(6), NEAR_ENEMY, first.held, 10_000);
  assert.equal(poll2.held.threatStallTicks, 1, "同 tick 第二次轮询不得累加");
  const poll3 = step(poll2.plan!, core, militaryUnits(6), NEAR_ENEMY, poll2.held, 10_000);
  assert.equal(poll3.held.threatStallTicks, 1, "同 tick 第三次轮询仍不得累加");
  const nextTick = step(poll3.plan!, core, militaryUnits(6), NEAR_ENEMY, poll3.held, 10_001);
  assert.equal(nextTick.held.threatStallTicks, 2, "下一游戏 tick 才累加");
});

test("同 tick 3 次轮询：settleElapsed 只按游戏 tick 增长", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  const first = step(plan, core, militaryUnits(6), [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(first.held.settleElapsed, 1);
  const poll2 = step(first.plan!, core, militaryUnits(6), [], first.held, 10_000);
  assert.equal(poll2.held.settleElapsed, 1, "同 tick 第二次轮询不得累加");
  const poll3 = step(poll2.plan!, core, militaryUnits(6), [], poll2.held, 10_000);
  assert.equal(poll3.held.settleElapsed, 1, "同 tick 第三次轮询仍不得累加");
  const nextTick = step(poll3.plan!, core, militaryUnits(6), [], poll3.held, 10_001);
  assert.equal(nextTick.held.settleElapsed, 2, "下一游戏 tick 才累加");
});

test("同 tick 3 次轮询：gapTicks 只按游戏 tick 增长", () => {
  const plan = makeSettlePlan();
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  const first = step(plan, core, militaryUnits(4), [], INITIAL_CONDUCTOR_HELD_STATE, 10_000);
  assert.equal(first.held.gapTicks, 1);
  const poll2 = step(first.plan!, core, militaryUnits(4), [], first.held, 10_000);
  assert.equal(poll2.held.gapTicks, 1, "同 tick 第二次轮询不得累加");
  const poll3 = step(poll2.plan!, core, militaryUnits(4), [], poll2.held, 10_000);
  assert.equal(poll3.held.gapTicks, 1, "同 tick 第三次轮询仍不得累加");
  const nextTick = step(poll3.plan!, core, militaryUnits(4), [], poll3.held, 10_001);
  assert.equal(nextTick.held.gapTicks, 2, "下一游戏 tick 才累加");
});

test("威胁升级：PLAN_AUDITED 保留威胁窗口（threatReplanCount/threatFirstTick）→ 窗口内第 3 次升级 → ABORT", () => {
  const core = { id: "uuid-A", position: [0, 0] as readonly [number, number], state: "NORMAL" as const, hp: 5 };
  // 第 1 次升级：SETTLE 贴脸 10 tick → REPLAN（威胁窗口开启，升级计数 1）
  let held: ConductorHeldState = INITIAL_CONDUCTOR_HELD_STATE;
  let current = makeSettlePlan();
  for (let tick = 10_000; tick < 10_009; tick += 1) {
    const result = step(current, core, [], NEAR_ENEMY, held, tick);
    held = result.held;
    current = result.plan!;
  }
  const firstEscalation = step(current, core, [], NEAR_ENEMY, held, 10_009);
  assert.equal(firstEscalation.plan?.state, "PLAN");
  assert.equal(firstEscalation.held.threatReplanCount, 1);
  held = firstEscalation.held;
  current = firstEscalation.plan!;

  // PLAN 审计（敌核暂时离开 → 审计通过）→ LEG_MOVE；威胁窗口必须跨 REPLAN 保留
  const audited = step(current, core, [], [], held, 10_010);
  assert.equal(audited.plan?.state, "LEG_MOVE");
  assert.equal(audited.held.threatReplanCount, 1, "PLAN_AUDITED 不得清空升级计数");
  assert.equal(audited.held.settleElapsed, 0, "episode 计数器仍清零");
  assert.equal(audited.held.stallTicks, 0);
  held = audited.held;

  // 回到 SETTLE 做第 2 次升级（窗口内）→ REPLAN
  current = makeSettlePlan({ revision: 3 });
  for (let tick = 10_011; tick < 10_020; tick += 1) {
    const result = step(current, core, [], NEAR_ENEMY, held, tick);
    held = result.held;
    current = result.plan!;
  }
  const secondEscalation = step(current, core, [], NEAR_ENEMY, held, 10_020);
  assert.equal(secondEscalation.plan?.state, "PLAN");
  assert.equal(secondEscalation.held.threatReplanCount, 2, "窗口内第 2 次升级 → REPLAN");
  held = secondEscalation.held;
  current = secondEscalation.plan!;

  // PLAN 审计（敌核离开）→ LEG_MOVE；升级计数保留到 2
  const audited2 = step(current, core, [], [], held, 10_021);
  assert.equal(audited2.plan?.state, "LEG_MOVE");
  assert.equal(audited2.held.threatReplanCount, 2);
  held = audited2.held;

  // 第 3 次升级（窗口内）→ THREAT_ESCALATED → ABORT（死路径修复）
  current = makeSettlePlan({ revision: 4 });
  for (let tick = 10_022; tick < 10_031; tick += 1) {
    const result = step(current, core, [], NEAR_ENEMY, held, tick);
    held = result.held;
    current = result.plan!;
  }
  const abort = step(current, core, [], NEAR_ENEMY, held, 10_031);
  assert.equal(abort.plan?.state, "ABORT", "窗口内第 3 次升级 → ABORT（死路径修复）");
  assert.ok(abort.transitions.some((t) => t.event === "THREAT_ESCALATED"), "应记录 THREAT_ESCALATED");
});

// ---------------------------------------------------------------------------
// 卸货 wait-ring：核心格容量纪律（assist）
// ---------------------------------------------------------------------------

const CORE_AT_ORIGIN: AssistCoreSnapshot = {
  position: [0, 0],
  state: "NORMAL",
  destination: null,
  moveProgress: null,
  moveRequiredTicks: null,
};

test("wait-ring：核心格被占（Vanguard）→ 邻格满载 worker 拦截（停邻格不挤核心格）", () => {
  const orders = buildWaitRingOrders(
    [
      { id: "v1", unitType: "VANGUARD", position: [0, 0], cargo: 0 },
      { id: "w1", unitType: "WORKER", position: [1, 0], cargo: 2 },
    ],
    CORE_AT_ORIGIN,
  );
  assert.equal(orders.length, 1, "满载 worker 应被拦截");
  assert.equal(orders[0]!.unitId, "w1");
  assert.ok(orders[0]!.reason.includes("容量满"), `reason 应说明容量满：${orders[0]!.reason}`);
});

test("wait-ring：核心格空 → 放行（满载 worker 进格卸货）", () => {
  const orders = buildWaitRingOrders(
    [{ id: "w1", unitType: "WORKER", position: [1, 0], cargo: 2 }],
    CORE_AT_ORIGIN,
  );
  assert.deepEqual(orders, [], "核心格无驻留单位 → 放行卸货");
});

test("wait-ring：空载 worker / 远距满载 worker / 已在核心格 → 不拦截", () => {
  // 空载在邻格：不拦截（照常采矿）
  const empty = buildWaitRingOrders(
    [
      { id: "v1", unitType: "VANGUARD", position: [0, 0], cargo: 0 },
      { id: "w1", unitType: "WORKER", position: [1, 0], cargo: 0 },
    ],
    CORE_AT_ORIGIN,
  );
  assert.deepEqual(empty, [], "空载 worker 不拦截");
  // 远距满载（>2 格）：不拦截（照常行进）
  const far = buildWaitRingOrders(
    [
      { id: "v1", unitType: "VANGUARD", position: [0, 0], cargo: 0 },
      { id: "w1", unitType: "WORKER", position: [5, 0], cargo: 2 },
    ],
    CORE_AT_ORIGIN,
  );
  assert.deepEqual(far, [], "远距满载 worker 不拦截");
  // 已在核心格（正在卸货）：放行
  const depositing = buildWaitRingOrders(
    [
      { id: "w1", unitType: "WORKER", position: [0, 0], cargo: 2 },
    ],
    CORE_AT_ORIGIN,
  );
  assert.deepEqual(depositing, [], "已在核心格 = 卸货中，放行");
});

test("wait-ring：核心位置未知 → 空数组（fail-closed 无动作）", () => {
  const orders = buildWaitRingOrders(
    [{ id: "w1", unitType: "WORKER", position: [1, 0], cargo: 2 }],
    { position: null, state: "NORMAL", destination: null, moveProgress: null, moveRequiredTicks: null },
  );
  assert.deepEqual(orders, [], "核心位置未知 → 不拦截");
});
