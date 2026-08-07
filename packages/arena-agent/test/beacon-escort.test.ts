/**
 * 信标护送测试（2026-08-08，beacon-escort，军事负责人信标预案）：
 * beaconGrab 开启时，除取标设计者外最近的 Vanguard 担任护送者贴身影护
 * （≤2 格）；设计者本人不护送；beaconGrab 关闭零回归；单 Vanguard 无护送。
 * A/B 证据（scripts/beacon-escort-ab.mts）：护送让载者阵亡 2/3→0、
 * 军事阵亡 35→27、被射 8→5。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];
const BEACON: Position = [10, 0]; // 距 Core 10 ≤24，可抢

function makeState(
  tick: number,
  opts: {
    vanguards?: Position[];
    rangers?: Position[];
    beacon?: { position: Position; status: "GROUND" | "CARRIED"; carrierId: string | null };
    enemies?: TickState["visibleEnemies"];
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

const GRAB_CONFIG = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const, beaconGrab: true, beaconGrabMaxDist: 24 };

test("beaconEscort 默认关闭：beaconGrab 关闭时不产生护送意图（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const });
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.equal(Object.values(plan.intents).some((i) => i.includes("beacon_escort")), false);
});

test("beaconEscort 开启：设计者外的最近 Vanguard 获得护送意图", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 [12,0] 距信标 2（设计者 fetch）；v1 [20,0] 距信标 10 且距设计者 8 → 护送
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch");
  assert.equal(plan.intents["v1"], "vanguard_beacon_escort");
});

test("beaconEscort 开启：护送者贴身影护（≤2 格）——远则靠近、近则待命", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // 设计者 v0 [12,0]，护送者 v1 [20,0] 距设计者 8 → 向设计者移动（LEFT）
  let plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.deepEqual(plan.unitActions["v1"], { type: "MOVE", direction: "LEFT" });
  // 护送者已贴近（v1 [13,0] 距设计者 [12,0] = 1）→ WAIT 影护不抢位
  plan = planner.decide({ state: makeState(2, { vanguards: [[12, 0], [13, 0]] }) });
  assert.deepEqual(plan.unitActions["v1"], { type: "WAIT" });
});

test("beaconEscort 开启：设计者本人不护送（fetch 优先）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0], [20, 0]] }) });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_escort");
});

test("beaconEscort 开启：仅一个 Vanguard 时不产生护送（无人可护）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  const plan = planner.decide({ state: makeState(1, { vanguards: [[12, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch");
  assert.equal(Object.values(plan.intents).filter((i) => i.includes("beacon_escort")).length, 0);
});

test("beaconEscort 开启：已持标回程不护送——载者持标盾 buff 抗揍，护送解散", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  // v0 已持标 [15,0]（CARRIED，载者 v0）；v1 [20,0] → 载者自己回家，无护送意图
  const plan = planner.decide({
    state: makeState(1, { vanguards: [[15, 0], [20, 0]], beacon: { position: [15, 0], status: "CARRIED", carrierId: "v0" } }),
  });
  assert.equal(plan.intents["v0"], "vanguard_beacon_return");
  assert.equal(Object.values(plan.intents).some((i) => i.includes("beacon_escort")), false);
});
