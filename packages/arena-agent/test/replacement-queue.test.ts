/**
 * W12 按类型替补队列测试（replacement-queue-v1，2026-08-09，
 * algorithm-update-plan-v1 §4-W12）。
 *
 * 问题 A2 缺陷 4：阵亡只靠通用产兵，人口崩塌恢复慢。修复：阵亡军事单位按
 * 类型计数（VANGUARD/RANGER 各一计数器），产兵优先补缺口；价格窗口等待
 * （资源不足缺口兵种 → 等待，不产低档替代品）；worker 阵亡不入队；队列空
 * / 变体关 = 历史产兵顺序不变（零回归）。
 *
 * 参考定位 reference/arena-hero-clone-waaiging/arena_hero_strategy.py HEAD
 * 26675e36：replacement_queue: Counter[str]（:528），入队 :1157-1172
 * （set-difference + previous_labels），消费 _select_spawn :9605-9665
 * （MODE_AGGRESS：缺口优先 + 价格窗口等待 None）。
 *
 * 本测试覆盖三层：
 * 1. state-reducer 纯函数（入队 / 出队的状态转移）—— applyReplacementQueueDelta
 *    / consumeReplacementQueue。
 * 2. deterministic-planner selectDeterministicCoreAction 的产兵优先级 + 价格窗口。
 * 3. 零回归（队列空 / 变体关 = 历史产兵顺序不变）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, ResolutionEventSnapshot, TickState, UnitType } from "../src/domain/model.ts";
import {
  applyReplacementQueueDelta,
  consumeReplacementQueue,
  EMPTY_REPLACEMENT_QUEUE,
  type ReplacementQueue,
} from "../src/domain/state-reducer.ts";
import { selectDeterministicCoreAction } from "../src/planning/deterministic-planner.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────────────────────

const AGGRESSIVE = {
  posture: "aggressive" as const,
  workerTarget: 12,
  militaryRatio: 0.4,
  focusRegion: null as null,
  attackPriority: "core" as const,
};

function makeUnit(id: string, unitType: UnitType, position: Position = [5, 0]) {
  return {
    id,
    position,
    hp: unitType === "VANGUARD" ? 4 : unitType === "RANGER" ? 2 : 2,
    unitType,
    cargo: 0,
  };
}

function makeState(
  resources: number,
  workers: number,
  vanguards: number,
  rangers = 0,
  extra: { population?: number; events?: readonly ResolutionEventSnapshot[] } = {},
): TickState {
  const units = [
    ...Array.from({ length: workers }, (_, i) => makeUnit(`w${i}`.padEnd(36, "0"), "WORKER")),
    ...Array.from({ length: vanguards }, (_, i) => makeUnit(`v${i}`.padEnd(36, "0"), "VANGUARD")),
    ...Array.from({ length: rangers }, (_, i) => makeUnit(`r${i}`.padEnd(36, "0"), "RANGER")),
  ];
  return {
    tick: 1,
    status: "ACTIVE" as const,
    resources,
    resourceCapacity: 50,
    resourceSpace: 50 - resources,
    population: extra.population ?? units.length,
    core: {
      id: "c1",
      position: [0, 0] as Position,
      hp: 5,
      shield: 5,
      state: "NORMAL" as const,
      ownerUsername: "p1",
    },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND" as const, carrierId: null },
    events: extra.events ?? [],
  };
}

function makeDestroyedEvent(actorId: string): ResolutionEventSnapshot {
  return {
    eventId: `evt-${actorId}`,
    tick: 1,
    eventType: "UNIT_DESTROYED",
    reasonCode: null,
    actorId,
    targetId: null,
    values: {},
  };
}

/**
 * selectDeterministicCoreAction 形参顺序（13 个）：
 * state, fallback, policy, vanguardRatio, accumulateThreshold, surgeActive,
 * spawnReserve, populationCeiling, threatDefenseSpawn, recoveryEarlyMilitary,
 * homeDefenseBottom, replacementQueue, replacementQueueEnabled。
 */
function decide(
  state: TickState,
  replacementQueue: ReplacementQueue,
  replacementQueueEnabled: boolean,
): { readonly action: { type: string; unitType?: UnitType } | null; readonly intent: string | null } {
  return selectDeterministicCoreAction(
    state,
    null,
    AGGRESSIVE,
    undefined,
    0,
    false,
    2,
    Number.POSITIVE_INFINITY,
    false,
    false,
    false,
    replacementQueue,
    replacementQueueEnabled,
  );
}

const QUEUE_VANGUARD: ReplacementQueue = Object.freeze({ VANGUARD: 1, RANGER: 0 });
const QUEUE_RANGER: ReplacementQueue = Object.freeze({ VANGUARD: 0, RANGER: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 1. state-reducer 纯函数：入队
// ─────────────────────────────────────────────────────────────────────────────

test("W12 入队：Vanguard 阵亡 → replacement_queue[VANGUARD]=1", () => {
  const previousTypes = new Map<string, UnitType>([["v0".padEnd(36, "0"), "VANGUARD"]]);
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [makeDestroyedEvent("v0".padEnd(36, "0"))],
    previousTypes,
    true,
  );
  assert.equal(next.VANGUARD, 1);
  assert.equal(next.RANGER, 0);
});

test("W12 入队：Ranger 阵亡 → replacement_queue[RANGER]=1", () => {
  const previousTypes = new Map<string, UnitType>([["r0".padEnd(36, "0"), "RANGER"]]);
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [makeDestroyedEvent("r0".padEnd(36, "0"))],
    previousTypes,
    true,
  );
  assert.equal(next.VANGUARD, 0);
  assert.equal(next.RANGER, 1);
});

test("W12 入队：worker 阵亡 → 不入队（只军事单位）", () => {
  const workerId = "w0".padEnd(36, "0");
  const previousTypes = new Map<string, UnitType>([[workerId, "WORKER"]]);
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [makeDestroyedEvent(workerId)],
    previousTypes,
    true,
  );
  assert.deepEqual(next, EMPTY_REPLACEMENT_QUEUE, "worker 阵亡不入队");
});

test("W12 入队：敌方阵亡 → 不入队（previousUnitTypes 只含我方单位，自动过滤）", () => {
  const enemyId = "enemy-0";
  const previousTypes = new Map<string, UnitType>(); // 空（我方无此 id）
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [makeDestroyedEvent(enemyId)],
    previousTypes,
    true,
  );
  assert.deepEqual(next, EMPTY_REPLACEMENT_QUEUE, "敌方阵亡不入队");
});

test("W12 入队：多个兵种同时阵亡 → 各计数器独立累加", () => {
  const v1 = "v0".padEnd(36, "0");
  const v2 = "v1".padEnd(36, "0");
  const r1 = "r0".padEnd(36, "0");
  const previousTypes = new Map<string, UnitType>([
    [v1, "VANGUARD"],
    [v2, "VANGUARD"],
    [r1, "RANGER"],
  ]);
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [makeDestroyedEvent(v1), makeDestroyedEvent(v2), makeDestroyedEvent(r1)],
    previousTypes,
    true,
  );
  assert.equal(next.VANGUARD, 2);
  assert.equal(next.RANGER, 1);
});

test("W12 入队：变体关 → 恒空（enabled=false）", () => {
  const previousTypes = new Map<string, UnitType>([["v0".padEnd(36, "0"), "VANGUARD"]]);
  const next = applyReplacementQueueDelta(
    { VANGUARD: 5, RANGER: 3 } as ReplacementQueue,
    [makeDestroyedEvent("v0".padEnd(36, "0"))],
    previousTypes,
    false,
  );
  assert.deepEqual(next, EMPTY_REPLACEMENT_QUEUE, "变体关 → 恒空");
});

test("W12 入队：无阵亡事件 → 返回原队列（引用不变）", () => {
  const previous = Object.freeze({ VANGUARD: 2, RANGER: 1 });
  const previousTypes = new Map<string, UnitType>();
  const next = applyReplacementQueueDelta(previous, [], previousTypes, true);
  assert.equal(next, previous, "无变化时返回原对象");
});

test("W12 入队：非 UNIT_DESTROYED 事件 → 不入队", () => {
  const previousTypes = new Map<string, UnitType>([["v0".padEnd(36, "0"), "VANGUARD"]]);
  const otherEvent: ResolutionEventSnapshot = {
    eventId: "evt-other",
    tick: 1,
    eventType: "UNIT_DAMAGED",
    reasonCode: null,
    actorId: "v0".padEnd(36, "0"),
    targetId: null,
    values: {},
  };
  const next = applyReplacementQueueDelta(
    EMPTY_REPLACEMENT_QUEUE,
    [otherEvent],
    previousTypes,
    true,
  );
  assert.deepEqual(next, EMPTY_REPLACEMENT_QUEUE, "UNIT_DAMAGED 不入队");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. state-reducer 纯函数：出队（产后确认式）
// ─────────────────────────────────────────────────────────────────────────────

test("W12 出队：新 Vanguard 出现 → VANGUARD 计数 -1", () => {
  const queue: ReplacementQueue = Object.freeze({ VANGUARD: 1, RANGER: 0 });
  const previousIds = new Set<string>(["v_old"]);
  const currentUnits = [makeUnit("v_new", "VANGUARD")];
  const next = consumeReplacementQueue(queue, currentUnits, previousIds, true);
  assert.equal(next.VANGUARD, 0);
  assert.equal(next.RANGER, 0);
});

test("W12 出队：新 Ranger 出现 → RANGER 计数 -1", () => {
  const queue: ReplacementQueue = Object.freeze({ VANGUARD: 0, RANGER: 2 });
  const previousIds = new Set<string>(["r_old"]);
  const currentUnits = [makeUnit("r_new", "RANGER"), makeUnit("r_new2", "RANGER")];
  const next = consumeReplacementQueue(queue, currentUnits, previousIds, true);
  assert.equal(next.VANGUARD, 0);
  assert.equal(next.RANGER, 0, "两个新 Ranger 出队两次");
});

test("W12 出队：新 Worker 出现 → 不出队（只军事单位）", () => {
  const queue: ReplacementQueue = Object.freeze({ VANGUARD: 1, RANGER: 0 });
  const previousIds = new Set<string>(["w_old"]);
  const currentUnits = [makeUnit("w_new", "WORKER")];
  const next = consumeReplacementQueue(queue, currentUnits, previousIds, true);
  assert.equal(next.VANGUARD, 1, "worker 出现不出队");
});

test("W12 出队：已存在单位 → 不出队（只新 id 出队）", () => {
  const queue: ReplacementQueue = Object.freeze({ VANGUARD: 1, RANGER: 0 });
  const previousIds = new Set<string>(["v_persist"]);
  const currentUnits = [makeUnit("v_persist", "VANGUARD")];
  const next = consumeReplacementQueue(queue, currentUnits, previousIds, true);
  assert.equal(next.VANGUARD, 1, "已存在单位不出队");
});

test("W12 出队：变体关 → 恒空", () => {
  const queue: ReplacementQueue = Object.freeze({ VANGUARD: 1, RANGER: 0 });
  const previousIds = new Set<string>();
  const currentUnits = [makeUnit("v_new", "VANGUARD")];
  const next = consumeReplacementQueue(queue, currentUnits, previousIds, false);
  assert.deepEqual(next, EMPTY_REPLACEMENT_QUEUE, "变体关 → 恒空");
});

test("W12 出队：队列空 → 短路返回原对象", () => {
  const previousIds = new Set<string>(["v_old"]);
  const currentUnits = [makeUnit("v_new", "VANGUARD")];
  const next = consumeReplacementQueue(EMPTY_REPLACEMENT_QUEUE, currentUnits, previousIds, true);
  assert.equal(next, EMPTY_REPLACEMENT_QUEUE, "队列空时短路");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. deterministic-planner：产兵优先级 + 价格窗口
// ─────────────────────────────────────────────────────────────────────────────

test("W12 产兵：Vanguard 缺口 → 优先补 Vanguard（覆盖配比选 Ranger）", () => {
  // workers=12（=workerTarget）→ needMilitary 分支：2V+0R、ratio 0.4 →
  // nextMilitaryType 选 RANGER（ceil(3*0.4)=2，vanguards=2 不<2）。
  // 但队列 VANGUARD=1 → 替补优先 → 产 VANGUARD（覆盖配比）。
  const state = makeState(20, 12, 2, 0);
  const decision = decide(state, QUEUE_VANGUARD, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.equal(decision.intent, "spawn_vanguard_replacement");
});

test("W12 产兵：Ranger 缺口 → 优先补 Ranger（覆盖配比选 Vanguard）", () => {
  // workers=12 → needMilitary：0V+2R、ratio 0.4 → nextMilitaryType 选 VANGUARD
  // （ceil(3*0.4)=2，vanguards=0<2）。但队列 RANGER=1 → 替补优先 → 产 RANGER。
  const state = makeState(20, 12, 0, 2);
  const decision = decide(state, QUEUE_RANGER, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "RANGER" });
  assert.equal(decision.intent, "spawn_ranger_replacement");
});

test("W12 价格窗口：资源不足缺口兵种 → 等待，不产 Worker（价格档等待）", () => {
  // workers=3（< workerTarget=4 → 无队列时会产 Worker），res=8（< Ranger 12，>= Worker 5）。
  // 队列 RANGER=1 + 启用 → 价格窗口等待，不产 Worker。
  const state = makeState(8, 3, 0, 0);
  const decision = decide(state, QUEUE_RANGER, true);
  assert.equal(decision.action, null, "资源不足缺口兵种 → 等待（不产兵）");
  assert.equal(decision.intent, "replacement_price_window_ranger");
});

test("W12 价格窗口：资源够缺口兵种 → 产缺口兵种（豁免 reserve，纯成本门禁）", () => {
  // res=12（=Ranger 纯成本 12），spawnReserve=2 → cost+reserve=14 > 12。
  // 替补豁免 reserve（生存行为只看纯成本）→ res>=12 即产 Ranger。
  const state = makeState(12, 5, 0, 0);
  const decision = decide(state, QUEUE_RANGER, true);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "RANGER" });
  assert.equal(decision.intent, "spawn_ranger_replacement");
});

test("W12 价格窗口：资源不足 Vanguard（10）→ 等待，不产低档替代品", () => {
  // res=8（< Vanguard 10），队列 VANGUARD=1 → 等待。
  const state = makeState(8, 5, 0, 0);
  const decision = decide(state, QUEUE_VANGUARD, true);
  assert.equal(decision.action, null);
  assert.equal(decision.intent, "replacement_price_window_vanguard");
});

test("W12 优先级：经济地板未满足（workers<2）→ 不触发替补（emergency worker 优先）", () => {
  // workers=1（< WORKER_RECOVERY_FLOOR=2）→ emergency worker 扩编先于替补。
  // 队列 VANGUARD=1 但 workers<2 → 不触发替补分支，产 worker。
  const state = makeState(8, 1, 0, 0);
  const decision = decide(state, QUEUE_VANGUARD, true);
  assert.equal(decision.action?.type, "SPAWN");
  assert.equal(
    (decision.action as { unitType: UnitType }).unitType,
    "WORKER",
    "emergency worker 优先于替补",
  );
});

test("W12 优先级：militaryRatio=0 → 不触发替补（走 worker 扩编，纯经济）", () => {
  const noRatio = { ...AGGRESSIVE, militaryRatio: 0 };
  const state = makeState(20, 5, 0, 0);
  const decision = selectDeterministicCoreAction(
    state, null, noRatio, undefined, 0, false, 2,
    Number.POSITIVE_INFINITY, false, false, false,
    QUEUE_VANGUARD, true,
  );
  // militaryRatio=0 → 替补分支不触发 → worker 扩编（workers=5 < workerTarget=12）
  assert.equal(decision.action?.type, "SPAWN");
  assert.equal(
    (decision.action as { unitType: UnitType }).unitType,
    "WORKER",
    "militaryRatio=0 → 纯 worker 扩编，替补不触发",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 零回归
// ─────────────────────────────────────────────────────────────────────────────

test("W12 零回归：队列空 → 历史产兵顺序不变（配比选 Vanguard）", () => {
  // workers=12（=workerTarget）→ needMilitary 分支：0V+0R、ratio 0.4 →
  // nextMilitaryType 选 VANGUARD（ceil(1*0.4)=1，vanguards=0<1）。队列空 →
  // 替补分支跳过 → 走 needMilitary → VANGUARD（与无替补时一致）。
  const state = makeState(20, 12, 0, 0);
  const withEmptyQueue = decide(state, EMPTY_REPLACEMENT_QUEUE, true);
  const withoutFeature = decide(state, EMPTY_REPLACEMENT_QUEUE, false);
  assert.deepEqual(withEmptyQueue.action, withoutFeature.action, "队列空 → 行为与变体关一致");
  assert.deepEqual(withEmptyQueue.action, { type: "SPAWN", unitType: "VANGUARD" });
});

test("W12 零回归：变体关 → 不入队、产兵顺序不变（即使队列非空）", () => {
  // 队列有 VANGUARD 缺口但变体关 → 替补分支不触发 → 走 needMilitary → VANGUARD。
  const state = makeState(20, 12, 0, 0);
  const decision = decide(state, QUEUE_VANGUARD, false);
  assert.deepEqual(decision.action, { type: "SPAWN", unitType: "VANGUARD" });
  assert.notEqual(decision.intent, "spawn_vanguard_replacement", "变体关不产替补 intent");
  assert.equal(decision.intent, "spawn_vanguard_military_ratio");
});

test("W12 零回归：变体关 + 队列空 → 与既无队列又无关完全一致", () => {
  // workers=12、2V+0R：needMilitary → nextMilitaryType 选 RANGER
  // （ceil(3*0.4)=2，vanguards=2 不<2）。队列空 → 替补跳过 → RANGER。
  const state = makeState(20, 12, 2, 0);
  const enabled = decide(state, EMPTY_REPLACEMENT_QUEUE, true);
  const disabled = decide(state, EMPTY_REPLACEMENT_QUEUE, false);
  assert.deepEqual(enabled.action, disabled.action);
  assert.equal(enabled.intent, disabled.intent);
  assert.deepEqual(enabled.action, { type: "SPAWN", unitType: "RANGER" });
});
