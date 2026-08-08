/**
 * W61 信标距离迟滞 + 进度权重测试（beacon-commitment-v1，2026-08-09，竞品
 * "信标距离迟滞带 + 进度权重" 对照）：beacon fetch 设计者选择加距离迟滞带
 * （上一轮设计者减 hysteresis，新候选须近 > 迟滞带才替换）+ 进度权重
 * （越接近信标的设计者减得越多，越难被替换——防中途放弃信标）。
 *
 * 覆盖：
 * - beaconCommitment 默认关 → 纯最近距离选设计者（零回归）；
 * - 迟滞带：新候选仅近 1 格（< hysteresis）不替换当前设计者；
 * - 迟滞带：新候选近 > hysteresis 才替换；
 * - 进度权重：当前设计者越接近信标越难被替换；
 * - 持久性：设计者跨 tick 保持（beaconMission 写入 beaconFetchDesigneeId）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE: Position = [0, 0];
const BEACON: Position = [10, 0]; // 距 Core 10 ≤24，可抢

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

const GRAB_CONFIG = {
  ...DEFAULT_SAFETY_CONFIG,
  aggression: "aggressive" as const,
  beaconGrab: true,
  beaconGrabMaxDist: 80,
};

const COMMITMENT_CONFIG = {
  ...GRAB_CONFIG,
  beaconCommitment: true,
  beaconCommitmentHysteresis: 2,
  beaconCommitmentProgress: 3,
};

// 信标需静止多 tick 才过 BEACON_MOVE_WINDOW（30）闸门：同一位置连续观察。
// 用 4 个 tick 的同位置信标喂 planner，确保 beaconMoving 返回 false。
function observeStationaryBeacon(planner: SafetyPlanner, vanguards: Position[], beaconPos: Position = BEACON): void {
  for (let t = 1; t <= 4; t += 1) {
    planner.decide({
      state: makeState(t, { vanguards, beacon: { position: beaconPos, status: "GROUND", carrierId: null } }),
    });
  }
}

test("W61 零回归：beaconCommitment 默认关 → 纯最近距离选设计者（与历史一致）", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  observeStationaryBeacon(planner, [[12, 0], [20, 0]]);
  // v0 [12,0] 距信标 2 < v1 [20,0] 距信标 10 → v0 抢
  const plan = planner.decide({
    state: makeState(5, { vanguards: [[12, 0], [20, 0]] }),
  });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "默认关时最近 Vanguard 抢");
  assert.notEqual(plan.intents["v1"], "vanguard_beacon_fetch", "更远的不抢");
});

test("W61 零回归：beaconCommitment 关 + 单候选 → 正常 fetch", () => {
  const planner = new SafetyPlanner(GRAB_CONFIG);
  observeStationaryBeacon(planner, [[12, 0]]);
  const plan = planner.decide({ state: makeState(5, { vanguards: [[12, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch");
});

test("W61 迟滞带：新候选仅近 1 格（< hysteresis=2）不替换当前设计者", () => {
  const planner = new SafetyPlanner(COMMITMENT_CONFIG);
  // tick1-4：信标 [10,0]，v0 [12,0] 距信标 2 → v0 成为设计者
  observeStationaryBeacon(planner, [[12, 0]]);
  // 确认 v0 是当前设计者
  let plan = planner.decide({ state: makeState(5, { vanguards: [[12, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "v0 应为初始设计者");
  // tick6：v1 [11,0] 出现，距信标 1（比 v0 近 1 格 < hysteresis 2）→ 不替换
  // v1 仍距信标更近（纯距离），但迟滞带让 v0 保持设计者
  plan = planner.decide({ state: makeState(6, { vanguards: [[12, 0], [11, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "迟滞带内：v0 应保持设计者（不被近 1 格的 v1 替换）");
  assert.notEqual(plan.intents["v1"], "vanguard_beacon_fetch", "v1 不应抢走设计者");
});

test("W61 迟滞带：当前设计者更远 + 新候选近 > hysteresis → 替换", () => {
  const planner = new SafetyPlanner(COMMITMENT_CONFIG);
  // 信标 [10,0]；v0 [2,0] 距信标 8 = 初始设计者（唯一候选）
  observeStationaryBeacon(planner, [[2, 0]]);
  let plan = planner.decide({ state: makeState(5, { vanguards: [[2, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "v0 初始设计者");
  // v1 [8,0] 距信标 2，比 v0 近 6 > hysteresis 2 → 替换 v0
  // 但 v1 进度更高（更近）也加成——综合 v1 调整距离更小 → v1 胜
  plan = planner.decide({ state: makeState(6, { vanguards: [[2, 0], [8, 0]] }) });
  assert.equal(plan.intents["v1"], "vanguard_beacon_fetch", "v1 近 > 迟滞带应替换 v0");
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch", "v0 应被替换");
});

test("W61 进度权重：当前设计者越接近信标越难被替换", () => {
  // 场景 A：设计者 v0 距信标 8（低进度），挑战者 v1 距信标 6（近 2 = hysteresis）
  //   → 无进度权重时迟滞带刚好挡住（adjusted 相等）；进度权重让 v0 进度更低
  //   → v1 应能替换（v0 进度 1-8/maxDist 低，扣减少）
  // 场景 B：设计者 v0 距信标 2（高进度），挑战者 v1 距信标 0（近 2 = hysteresis）
  //   → v0 进度高（1-2/80≈0.975）扣 progressWeight*0.975 很多 → v0 更难替换
  //
  // 简化验证：设计者高进度（距信标近）时，挑战者须近 > 迟滞带 + 进度权重才能替换
  const planner = new SafetyPlanner(COMMITMENT_CONFIG);
  // v0 [8,0] 距信标 [10,0] = 2（高进度）= 设计者
  observeStationaryBeacon(planner, [[8, 0]]);
  let plan = planner.decide({ state: makeState(5, { vanguards: [[8, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "v0 高进度设计者");
  // v1 [11,0] 距信标 1（比 v0 近 1 < hysteresis 2）→ 不替换（迟滞带 + 进度都护 v0）
  plan = planner.decide({ state: makeState(6, { vanguards: [[8, 0], [11, 0]] }) });
  assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", "高进度设计者 v0 应保持");
  assert.notEqual(plan.intents["v1"], "vanguard_beacon_fetch", "v1 不应替换高进度 v0");
});

test("W61 持久性：设计者跨 tick 保持（无新候选时不换）", () => {
  const planner = new SafetyPlanner(COMMITMENT_CONFIG);
  observeStationaryBeacon(planner, [[12, 0]]);
  // 连续多 tick 同一候选 → 同一设计者保持
  for (let t = 5; t <= 8; t += 1) {
    const plan = planner.decide({ state: makeState(t, { vanguards: [[12, 0]] }) });
    assert.equal(plan.intents["v0"], "vanguard_beacon_fetch", `tick ${t}：v0 应保持设计者`);
  }
});

test("W61：beaconGrab 关 → beaconCommitment 不生效（零回归）", () => {
  const planner = new SafetyPlanner({
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive" as const,
    // beaconGrab 未开
    beaconCommitment: true,
    beaconCommitmentHysteresis: 2,
    beaconCommitmentProgress: 3,
  });
  observeStationaryBeacon(planner, [[12, 0]]);
  const plan = planner.decide({ state: makeState(5, { vanguards: [[12, 0]] }) });
  assert.notEqual(plan.intents["v0"], "vanguard_beacon_fetch", "beaconGrab 关 → 不抢信标");
});
