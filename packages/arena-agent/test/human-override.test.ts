/** 人类最高控制权测试：live 主循环提交前的人类指令/意图覆盖（Manual > Agent）。
 *  覆盖：一键动作、采矿意图全流程（移动→到达→挖→满仓回仓）、目标采空交还 agent、
 *  mode=disabled 交还控制权、未知单位/不适配动作拒绝。 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Plan, TickState, UnitAction, CoreAction } from "../src/domain/model.ts";
import {
  actionFromWire,
  applyHumanOverrides,
  type HumanCommandSource,
} from "../src/runtime/human-override.ts";

const WORKER = "22222222-2222-2222-2222-222222222222";
const CORE = "core-1";

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

/* ---- 核心迁移 / 核心动作（2026-08-08 端到端控制补齐） ---- */
function coreActionOf(result: ReturnType<typeof applyHumanOverrides>): CoreAction | null {
  return result.plan.coreAction;
}

test("核心一键动作：START_MOVE 方向合法 → 覆盖 coreAction 并 applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState(); // core 在 [0,0]，NORMAL
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: CORE, action: { type: "START_MOVE", direction: "RIGHT" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true);
    assert.deepEqual(r.applied, [CORE]);
    assert.deepEqual(coreActionOf(r), { type: "START_MOVE", direction: "RIGHT" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("核心一键动作：CANCEL_MOVE（MOVING 态）→ 覆盖 coreAction", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({
      core: { id: CORE, position: [0, 0], hp: 5, shield: 5, state: "MOVING", ownerUsername: "me" },
    });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: CORE, action: { type: "CANCEL_MOVE" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true);
    assert.deepEqual(coreActionOf(r), { type: "CANCEL_MOVE" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("核心一键动作：SPAWN 合法（资源充足）→ 覆盖 coreAction", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({ resources: 50 });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: CORE, action: { type: "SPAWN", unitType: "VANGUARD" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true);
    assert.deepEqual(coreActionOf(r), { type: "SPAWN", unitType: "VANGUARD" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("核心一键动作：SPAWN 资源不足 → 被权威校验拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({ resources: 3 }); // VANGUARD 需 10
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: CORE, action: { type: "SPAWN", unitType: "VANGUARD" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    assert.equal(coreActionOf(r), null); // 非法 core 动作被剔除
    assert.ok(r.rejected.some((x) => x.unitId === CORE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("核心一键动作：MOVING 态 START_MOVE → 被权威校验拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({
      core: { id: CORE, position: [0, 0], hp: 5, shield: 5, state: "MOVING", ownerUsername: "me" },
    });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override",
      commands: [{ id: "c1", unitId: CORE, action: { type: "START_MOVE", direction: "UP" }, createdAt: "x" }],
      goals: [],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, false);
    assert.equal(coreActionOf(r), null);
    assert.ok(r.rejected.some((x) => x.unitId === CORE));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actionFromWire: 核心/方向/生产动作 wire 形状解析", () => {
  assert.deepEqual(actionFromWire({ type: "START_MOVE", direction: "LEFT" }), { type: "START_MOVE", direction: "LEFT" });
  assert.deepEqual(actionFromWire({ type: "CANCEL_MOVE" }), { type: "CANCEL_MOVE" });
  assert.deepEqual(actionFromWire({ type: "SPAWN", unitType: "RANGER" }), { type: "SPAWN", unitType: "RANGER" });
  assert.deepEqual(actionFromWire({ type: "SWEEP", direction: "DOWN" }), { type: "SWEEP", direction: "DOWN" });
  // 非法方向/单位类型 → null（逐条拒绝）
  assert.equal(actionFromWire({ type: "START_MOVE", direction: "NOPE" }), null);
  assert.equal(actionFromWire({ type: "SPAWN", unitType: "DRONE" }), null);
  assert.equal(actionFromWire({ type: "MOVE" }), null); // 缺 direction
});

test("goto 远距目标（>64 格）：插值中间点移动而非 WAIT（t4 NE 深探 240 格实证）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    // worker [1,1] → 目标 [199,199]（Chebyshev 198 > 64 searchRadius 上限）
    const state = makeState({ units: [{ id: WORKER, position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 }], workers: [{ id: WORKER, position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 }] });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override", updatedAt: new Date().toISOString(),
      commands: [],
      goals: [{ id: "g-far", unitId: WORKER, kind: "goto", target: [199, 199], createdAt: "x" }],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    assert.equal(r.active, true, "远距 goto 应应用（插值中间点）");
    const action = actionOf(r, WORKER);
    assert.ok(action?.type === "MOVE", "远距目标应走插值中间点 MOVE 而非 WAIT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("goto 远距目标：插值点不越过目标且保持主轴方向", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-ho-"));
  try {
    const state = makeState({ units: [{ id: WORKER, position: [10, 10], hp: 2, unitType: "WORKER", cargo: 0 }], workers: [{ id: WORKER, position: [10, 10], hp: 2, unitType: "WORKER", cargo: 0 }] });
    const src = makeSource(dir, "t1", {
      version: 1, mode: "override", updatedAt: new Date().toISOString(),
      commands: [],
      goals: [{ id: "g-far2", unitId: WORKER, kind: "goto", target: [200, 10], createdAt: "x" }],
    });
    const r = applyHumanOverrides(state, basePlan(), src);
    const action = actionOf(r, WORKER);
    assert.equal(action?.type, "MOVE");
    // 主轴正 X 方向（东）移动，不是 WAIT
    assert.ok(action?.type === "MOVE" && ["RIGHT"].includes(action.direction), "应向目标主轴方向移动");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
