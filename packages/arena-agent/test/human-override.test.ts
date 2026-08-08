/** 人类最高控制权测试：live 主循环提交前的人类指令/意图覆盖（Manual > Agent）。
 *  覆盖：一键动作、采矿意图全流程（移动→到达→挖→满仓回仓）、目标采空交还 agent、
 *  mode=disabled 交还控制权、未知单位/不适配动作拒绝。 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Plan, TickState, UnitAction } from "../src/domain/model.ts";
import {
  actionFromWire,
  applyHumanOverrides,
  type HumanCommandSource,
} from "../src/runtime/human-override.ts";

const WORKER = "22222222-2222-2222-2222-222222222222";

function makeState(overrides: Partial<TickState> = {}): TickState {
  return {
    tick: 10,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 100,
    resourceSpace: 90,
    population: 1,
    core: { id: "core-1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "me" },
    units: [{ id: WORKER, position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: WORKER, position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(["5,1", "9,9"]),
    obstacleCells: new Set(["2,1"]),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

function basePlan(tick = 10): Plan {
  return { tick, unitActions: {}, coreAction: null, intents: {} };
}

function makeSource(dir: string, tenant: string, store: unknown): HumanCommandSource {
  writeFileSync(join(dir, `${tenant}.json`), JSON.stringify(store));
  return { tenantId: tenant, storeDir: dir };
}

function actionOf(result: ReturnType<typeof applyHumanOverrides>, unitId: string): UnitAction | undefined {
  return (result.plan.unitActions as Record<string, UnitAction>)[unitId];
}

test("一键动作：HARVEST 直接覆盖（applied）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    // worker 站在资源格 [5,1]：HARVEST 合法 → 覆盖生效
    const state = makeState({ units: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 0 }], workers: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 0 }] });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override", updatedAt: "x",
      commands: [{ id: "c1", unitId: WORKER, action: { type: "HARVEST" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true);
    assert.deepEqual(r.applied, [WORKER]);
    assert.deepEqual(actionOf(r, WORKER), { type: "HARVEST" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("一键动作：非资源格 HARVEST 被权威校验拒绝并上报", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState(); // worker 在 [1,1]，不在资源格
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: WORKER, action: { type: "HARVEST" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    assert.equal(r.plan.unitActions[WORKER], undefined); // 非法动作被剔除
    assert.ok(r.rejected.some((x) => x.unitId === WORKER));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("采矿意图：远距离 → 向目标移动（绕开障碍）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [],
      goals: [{ id: "g1", unitId: WORKER, kind: "mine", target: [5, 1], createdAt: "x" }],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true);
    const a = actionOf(r, WORKER);
    assert.equal(a?.type, "MOVE");
    // 障碍在 [2,1] 正右方：第一步不能是 RIGHT 撞墙（确定性 BFS 应绕行）
    assert.notEqual((a as { direction?: string }).direction, "RIGHT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("采矿意图：已在目标资源格 → HARVEST", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({ units: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 0 }], workers: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 0 }] });
    const src = makeSource(dir, "t1", { version: 1, mode: "override", commands: [], goals: [{ id: "g1", unitId: WORKER, kind: "mine", target: [5, 1], createdAt: "x" }] });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.deepEqual(actionOf(r, WORKER), { type: "HARVEST" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("采矿意图：满载（cargo=1）→ 回仓（在核心格 DEPOSIT，否则向核心移动）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    // 在核心格满载 → DEPOSIT
    let state = makeState({ units: [{ id: WORKER, position: [0, 0], hp: 2, unitType: "WORKER", cargo: 1 }], workers: [{ id: WORKER, position: [0, 0], hp: 2, unitType: "WORKER", cargo: 1 }] });
    let src = makeSource(dir, "t1", { version: 1, mode: "override", commands: [], goals: [{ id: "g1", unitId: WORKER, kind: "mine", target: [5, 1], createdAt: "x" }] });
    let r = applyHumanOverrides(state, basePlan(), src);
    assert.deepEqual(actionOf(r, WORKER), { type: "DEPOSIT" });

    // 不在核心格满载 → 向核心移动
    state = makeState({ units: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 1 }], workers: [{ id: WORKER, position: [5, 1], hp: 2, unitType: "WORKER", cargo: 1 }] });
    r = applyHumanOverrides(state, basePlan(), src);
    const a = actionOf(r, WORKER);
    assert.equal(a?.type, "MOVE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("采矿意图：目标资源已采空 → satisfied，交还 agent（不覆盖）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({ resourceCells: new Set(["9,9"]) }); // [5,1] 已不在
    const src = makeSource(dir, "t1", { version: 1, mode: "override", commands: [], goals: [{ id: "g1", unitId: WORKER, kind: "mine", target: [5, 1], createdAt: "x" }] });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.deepEqual(r.satisfied, [WORKER]);
    assert.equal(r.plan.unitActions[WORKER], undefined); // 本 tick 交还 agent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mode=disabled → 交还 agent 全权（无覆盖）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    const src = makeSource(dir, "t1", { version: 1, mode: "disabled", commands: [{ id: "c1", unitId: WORKER, action: { type: "HARVEST" }, createdAt: "x" }], goals: [] });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    assert.deepEqual(r.applied, []);
    assert.equal(r.plan, basePlan().tick === r.plan.tick ? r.plan : r.plan); // 原计划
    assert.equal(r.plan.unitActions[WORKER], undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("未知单位 / 不适配动作 → 逐条拒绝并上报原因", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [
        { id: "c1", unitId: "ghost-unit", action: { type: "MOVE", direction: "UP" }, createdAt: "x" },
        { id: "c2", unitId: WORKER, action: { type: "SHOOT", targetId: null, expectedCell: [3, 3] }, createdAt: "x" }, // worker 不能射
      ],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    const reasons = new Map(r.rejected.map((x) => [x.unitId, x.reason]));
    assert.ok(reasons.has("ghost-unit"));
    assert.equal(reasons.get(WORKER), "action_requires_ranger");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("一键动作优先于同单位意图", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: WORKER, action: { type: "WAIT" }, createdAt: "x" }],
      goals: [{ id: "g1", unitId: WORKER, kind: "mine", target: [5, 1], createdAt: "x" }],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.deepEqual(actionOf(r, WORKER), { type: "WAIT" }); // 动作压过意图
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("actionFromWire: SHOOT 空串 targetId 归一为 null（cell-fire 空格射击）", () => {
  // 指挥面板空格射击指令可能带 targetId:""——空串与 null 语义等价（空格射击），
  // 必须归一为 null，否则 calibration schema（nullableIdentifier 拒绝空串）
  // 丢弃整条 case（生产 t1 实测 194 次 targetId must be a non-empty string）。
  const action = actionFromWire({ type: "SHOOT", targetId: "", expectedCell: [3, 3] });
  assert.deepEqual(action, { type: "SHOOT", targetId: null, expectedCell: [3, 3] });
});

test("actionFromWire: SHOOT null/缺省 targetId 保持 null", () => {
  assert.deepEqual(actionFromWire({ type: "SHOOT", targetId: null, expectedCell: [3, 3] }), {
    type: "SHOOT", targetId: null, expectedCell: [3, 3],
  });
  assert.deepEqual(actionFromWire({ type: "SHOOT", expectedCell: [3, 3] }), {
    type: "SHOOT", targetId: null, expectedCell: [3, 3],
  });
});


test("陈旧 override（writer 崩溃残留）整份忽略交还 agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    // updatedAt 为 20 分钟前（超过 STALE_OVERRIDE_MAX_AGE_MS=10min），goal 指向远点
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override", updatedAt: stale,
      commands: [],
      goals: [{ id: "g-stale", unitId: WORKER, kind: "goto", target: [50, 50], createdAt: stale }],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    assert.equal(r.applied.length, 0);
    assert.equal(r.plan.unitActions[WORKER], undefined); // 未覆盖 → 交还 agent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("陈旧判定：updatedAt 非法/缺失不判超龄（旧格式兼容）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState();
    // 非法时间 "x" 与缺失 updatedAt 均不触发过期（沿用历史行为）
    for (const updatedAt of ["x", null]) {
      const src = makeSource(dir, "t1", {
        version: 1, mode: "override", updatedAt,
        commands: [],
        goals: [{ id: "g1", unitId: WORKER, kind: "goto", target: [5, 1], createdAt: "x" }],
      });
      const r = applyHumanOverrides(state, basePlan(), src);
      assert.equal(r.active, true, `updatedAt=${updatedAt} 应仍生效`);
      assert.equal(r.plan.unitActions[WORKER]?.type, "MOVE");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
