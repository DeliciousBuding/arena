/**
 * 信标夺取测试（2026-08-07，官方 Champion Beacon 机制对齐）：beaconGrab——
 * 近距离（≤80）GROUND 信标由最近 Vanguard（无则 Ranger）拾取并带回守家；
 * 持标后回 Core 守位待命（不带着信标满图跑）；远距放弃；敌持标不争夺。
 * 默认关闭零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];
const BEACON: Position = [10, 0]; // 距 Core 10 ≤80，可抢

function makeState(
  tick: number,
  opts: {
    vanguards?: Position[];
    rangers?: Position[];
    beacon?: { position: Position; status: "GROUND" | "CARRIED"; carrierId: string | null };
    enemies?: VisibleEntity[];
  } = {},
): TickState {
  const vs = (opts.vanguards ?? []).map((p, i) => ({ id: `v${i}`, position: p, hp: 4, unitType: "VANGUARD" as const, cargo: 0 }));
  const rs = (opts.rangers ?? []).map((p, i) => ({ id: `r${i}`, position: p, hp: 2, unitType: "RANGER" as const, cargo: 0 }));
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: vs.length + rs.length,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [...vs, ...rs],
    workers: [],
    vanguards: vs,
    rangers: rs,
    visibleEnemies: opts.enemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: opts.beacon ?? { position: BEACON, status: "GROUND", carrierId: null },
    events: [],
  };
}

const GRAB_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, beaconGrab: true, beaconGrabMaxDist: 80 };

test("beaconGrab 默认关闭：Vanguard 距信标近也不去（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0]] }) });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch", "默认不主动抢信标");
});

test("beaconGrab 开启：最近 Vanguard 前往拾取（vanguard_beacon_fetch）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 [12,0] 距信标 2，v1 [20,0] 距信标 10 → v0 去抢
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch");
  assert.deepEqual(plan.unitActions["v0"], { type: "MOVE", direction: "LEFT" });
});

test("beaconGrab 开启：非最近单位不去（单设计者，防全军涌向信标）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.notEqual(plan.intents["v1"], "vanguard_beacon_fetch", "v1 更远，不抢");
});

test("beaconGrab 开启：信标超 maxDist → 放弃（远征送死）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // 信标 [100,0] 距 Core 100 >80 → 不抢
  const plan = planner.decide({
    state: makeState(1, { vanguards: [[12, 0]], beacon: { position: [100, 0], status: "GROUND", carrierId: null } }),
  });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch");
});

test("beaconGrab 开启：无 Vanguard 时最近 Ranger 担任载者", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  const plan = planner.decide({ state: makeState(1, { rangers: [[12, 0]] }) });
  assert.equal(plan.intents["r0"], "ranger_beacon_fetch");
});

test("beaconGrab 开启：持标后回 Core 守位（vanguard_beacon_return）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 [15,0] 已持标（carrierId=v0），距 Core 15 >4 → 回 Core
  const plan = planner.decide({
    state: makeState(1, { vanguards: [[15, 0]], beacon: { position: [15, 0], status: "CARRIED", carrierId: "v0" } }),
  });
  assert.equal(plan.intents["v0"], "vanguard_beacon_return");
  assert.deepEqual(plan.unitActions["v0"], { type: "MOVE", direction: "LEFT" });
});

test("beaconGrab 开启：持标到家 → 持标待命（不带着信标满图跑）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 [2,0] 已持标且距 Core 2 ≤4 → WAIT 持标待命
  const plan = planner.decide({
    state: makeState(1, { vanguards: [[2, 0]], beacon: { position: [2, 0], status: "CARRIED", carrierId: "v0" } }),
  });
  assert.equal(plan.intents["v0"], "vanguard_beacon_hold");
  assert.deepEqual(plan.unitActions["v0"], { type: "WAIT" });
});

test("beaconGrab 开启：敌持标 → 不争夺（敌标不打）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // 信标 CARRIED 但 carrier 不是我们（enemy）→ v0 正常攻坚，不去抢
  const plan = planner.decide({
    state: makeState(1, {
      vanguards: [[12, 0]],
      beacon: { position: [10, 0], status: "CARRIED", carrierId: "enemy-uuid" },
      enemies: [{ id: "ec", kind: "CORE", position: [30, 0], hp: 5, unitType: "VANGUARD" }],
    }),
  });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch");
});

test("beaconGrab 开启：返回途中邻接敌 → SWEEP 反击优先", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 [15,0] 持标返回，邻接敌 [14,0] → SWEEP
  const plan = planner.decide({
    state: makeState(1, {
      vanguards: [[15, 0]],
      beacon: { position: [15, 0], status: "CARRIED", carrierId: "v0" },
      enemies: [{ id: "e1", kind: "UNIT", position: [14, 0], hp: 4, unitType: "VANGUARD" }],
    }),
  });
  assert.deepEqual(plan.unitActions["v0"], { type: "SWEEP", direction: "LEFT" }, "邻接敌 SWEEP 优先于持标返回");
});

test("beaconGrab 开启：信标在已知敌核心旁（敌方基地）→ 不单独 fetch（防单骑送死）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // tick1：信标 [10,0] 旁可见敌 CORE [10,0]（jerkman 场景）→ 记入 coreHuntMemory
  const seen = makeState(1, {
    vanguards: [[12, 0]],
    beacon: { position: [10, 0], status: "GROUND", carrierId: null },
    enemies: [{ id: "ec", kind: "CORE", position: [10, 0], hp: 5, unitType: "VANGUARD" }],
  });
  planner.decide({ state: seen });
  // tick2：敌 CORE 不可见（消失），但记忆仍在信标旁 → 不 fetch（等军事攻坚）
  const after = makeState(2, { vanguards: [[12, 0]], beacon: { position: [10, 0], status: "GROUND", carrierId: null } });
  const plan = planner.decide({ state: after });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch", "信标旁有已知敌基地 → 不单独深入");
});

test("beaconGrab 开启：敌核心被摧毁后信标自然可拾取（主循环 PICKUP 接管）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 站在信标格（敌基地已被军事清除，无敌方核心记忆）→ 主循环自动 PICKUP_BEACON
  const plan = planner.decide({
    state: makeState(1, { vanguards: [[10, 0]], beacon: { position: [10, 0], status: "GROUND", carrierId: null } }),
  });
  assert.deepEqual(plan.unitActions["v0"], { type: "PICKUP_BEACON" }, "站在信标格由主循环 PICKUP 接管");
  assert.equal(plan.intents["v0"], "beacon", "主循环 beacon 拾取意图");
});

test("beaconGrab 开启：Core 被敌围攻（reinforce-home）→ 回援优先于抢信标", () => {
  const planner = new SafetyPlanner({ ...GRAB_CONFIG, remoteReinforce: true });
  // v0 [12,0] 是最近信标单位，但敌 Vanguard [9,0] 进 Core 防区（≤12）→
  // 远端回援优先（v0 距 Core 12 >4 守家圈，应回援而非抢信标）
  const plan = planner.decide({
    state: makeState(1, {
      vanguards: [[12, 0]],
      enemies: [{ id: "e1", kind: "UNIT", position: [9, 0], hp: 4, unitType: "VANGUARD" }],
    }),
  });
  assert.equal(plan.intents["v0"], "vanguard_reinforce", "家被围攻先回援，信标稍后再抢");
});
