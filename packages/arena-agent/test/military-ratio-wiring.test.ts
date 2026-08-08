/**
 * militaryRatio 接线测试（W52 GA 前置，2026-08-09，military-ratio-enabled-v1）：
 * SafetyPlanner.decideCore 产兵分支历史完全不读 policy.militaryRatio——GA 搜出
 * 的 MacroPolicy 5 维参数在生产只有 4 维生效。本变体开启后：workers ≥
 * effectiveWorkerTarget 且 policy.militaryRatio > 0 时按 militaryRatio 决定
 * VANGUARD vs RANGER（ratio 接近 1 多 Vanguard、接近 0 多 Ranger、0.5 交替）
 * ——augment 而非替换：是否产兵/产 Worker 仍由历史门控决定，仅 V/R 选择读
 * policy。默认关零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { resolveSafetyVariantConfig, isSafetyVariant } from "../src/strategies/variant-registry.ts";

/** 构造 TickState：workers/vanguards/rangers 可控，Core NORMAL 在 [0,0]，
 *  无可见敌人/障碍（隔离 militaryRatio 接线的产兵分支，排除威胁/迁移干扰）。 */
function makeState(workers: number, vanguards: number, rangers: number, resources: number): TickState {
  const units: Array<{
    id: string;
    position: Position;
    hp: number;
    unitType: "WORKER" | "VANGUARD" | "RANGER";
    cargo: number;
  }> = [];
  for (let i = 0; i < workers; i += 1) {
    units.push({ id: `w${i}`.padEnd(36, "0"), position: [5, 0], hp: 2, unitType: "WORKER", cargo: 0 });
  }
  for (let i = 0; i < vanguards; i += 1) {
    units.push({ id: `v${i}`.padEnd(36, "0"), position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 });
  }
  for (let i = 0; i < rangers; i += 1) {
    units.push({ id: `r${i}`.padEnd(36, "0"), position: [5, 0], hp: 2, unitType: "RANGER", cargo: 0 });
  }
  return {
    tick: 1,
    status: "ACTIVE",
    resources,
    resourceCapacity: 200,
    resourceSpace: 200 - resources,
    population: workers + vanguards + rangers,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const RATIO_HALF = {
  posture: "balanced" as const,
  workerTarget: 8,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: null,
};

const RATIO_HEAVY_VANGUARD = {
  posture: "balanced" as const,
  workerTarget: 8,
  militaryRatio: 0.8,
  focusRegion: null,
  attackPriority: null,
};

/** 启用 militaryRatio 接线的配置（militaryRatioEnabled=true）。 */
const RATIO_ENABLED_CONFIG = { ...DEFAULT_SAFETY_CONFIG, militaryRatioEnabled: true };

test("variant registry: military-ratio-enabled-v1 resolves militaryRatioEnabled", () => {
  assert.deepEqual(resolveSafetyVariantConfig("military-ratio-enabled-v1"), {
    militaryRatioEnabled: true,
  });
  assert.equal(isSafetyVariant("military-ratio-enabled-v1"), true);
});

test("militaryRatio 接线：ratio 0.5 + 变体开 + workers 达标 → V/R 交替", () => {
  const planner = new SafetyPlanner(RATIO_ENABLED_CONFIG);
  // 0V/0R：ceil((0+1)*0.5)=1, 0<1 → VANGUARD
  const first = planner.decide({ state: makeState(8, 0, 0, 30), policy: RATIO_HALF });
  assert.deepEqual(
    first.coreAction,
    { type: "SPAWN", unitType: "VANGUARD" },
    `0V/0R ratio 0.5 应产 VANGUARD（首个军事单位），实际 ${JSON.stringify(first.coreAction)}`,
  );
  // 1V/0R：ceil((1+1)*0.5)=1, 1<1 false → RANGER
  const second = planner.decide({ state: makeState(8, 1, 0, 30), policy: RATIO_HALF });
  assert.deepEqual(
    second.coreAction,
    { type: "SPAWN", unitType: "RANGER" },
    `1V/0R ratio 0.5 应产 RANGER（交替），实际 ${JSON.stringify(second.coreAction)}`,
  );
  // 1V/1R：ceil((2+1)*0.5)=2, 1<2 → VANGUARD
  const third = planner.decide({ state: makeState(8, 1, 1, 30), policy: RATIO_HALF });
  assert.deepEqual(
    third.coreAction,
    { type: "SPAWN", unitType: "VANGUARD" },
    `1V/1R ratio 0.5 应产 VANGUARD（交替回 Vanguard），实际 ${JSON.stringify(third.coreAction)}`,
  );
});

test("militaryRatio 接线：ratio 0.8 + 变体开 → 多 Vanguard（前 4 个全 Vanguard）", () => {
  const planner = new SafetyPlanner(RATIO_ENABLED_CONFIG);
  // 0V: ceil(0.8)=1, 0<1 → V
  // 1V: ceil(1.6)=2, 1<2 → V
  // 2V: ceil(2.4)=3, 2<3 → V
  // 3V: ceil(3.2)=4, 3<4 → V
  // 4V: ceil(4.0)=4, 4<4 false → R
  const expected = ["VANGUARD", "VANGUARD", "VANGUARD", "VANGUARD", "RANGER"];
  for (let i = 0; i < expected.length; i += 1) {
    const plan = planner.decide({
      state: makeState(8, i, 0, 30),
      policy: RATIO_HEAVY_VANGUARD,
    });
    assert.deepEqual(
      plan.coreAction,
      { type: "SPAWN", unitType: expected[i] },
      `ratio 0.8 第 ${i} 个军事单位应为 ${expected[i]}（多 Vanguard），实际 ${JSON.stringify(plan.coreAction)}`,
    );
  }
});

test("militaryRatio 接线：变体关 → 历史行为（nextMilitary 交替，不读 policy）", () => {
  // 变体关：militaryRatioEnabled 未设 → 历史行为。nextMilitary（vanguardRatio
  // undefined）= vanguards<=rangers ? VANGUARD : RANGER，与 militaryRatio 无关。
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  // 0V/0R：0<=0 → VANGUARD（历史交替）
  const first = planner.decide({ state: makeState(8, 0, 0, 30), policy: RATIO_HEAVY_VANGUARD });
  assert.deepEqual(
    first.coreAction,
    { type: "SPAWN", unitType: "VANGUARD" },
    `变体关 0V/0R 历史应产 VANGUARD，实际 ${JSON.stringify(first.coreAction)}`,
  );
  // 1V/0R：1<=0 false → RANGER（历史交替，与 ratio 0.8 无关）
  const second = planner.decide({ state: makeState(8, 1, 0, 30), policy: RATIO_HEAVY_VANGUARD });
  assert.deepEqual(
    second.coreAction,
    { type: "SPAWN", unitType: "RANGER" },
    `变体关 1V/0R 历史应产 RANGER（不读 ratio 0.8），实际 ${JSON.stringify(second.coreAction)}`,
  );
  // 2V/0R：2<=0 false → RANGER（历史交替——ratio 0.8 开时会产 VANGUARD，关时产 RANGER）
  const third = planner.decide({ state: makeState(8, 2, 0, 30), policy: RATIO_HEAVY_VANGUARD });
  assert.deepEqual(
    third.coreAction,
    { type: "SPAWN", unitType: "RANGER" },
    `变体关 2V/0R 历史应产 RANGER（零回归：不读 militaryRatio），实际 ${JSON.stringify(third.coreAction)}`,
  );
});

test("militaryRatio 接线：workers < target → 产 WORKER（militaryRatio 不激活）", () => {
  const planner = new SafetyPlanner(RATIO_ENABLED_CONFIG);
  // workers 6 < target 8 → nextSpawn 返回 WORKER；militaryRatio 块因 workers
  // < effectiveWorkerTarget 跳过（不覆盖 WORKER 选择）。
  const plan = planner.decide({ state: makeState(6, 0, 0, 30), policy: RATIO_HALF });
  assert.deepEqual(
    plan.coreAction,
    { type: "SPAWN", unitType: "WORKER" },
    `workers 未达标应产 WORKER（militaryRatio 不激活），实际 ${JSON.stringify(plan.coreAction)}`,
  );
});

test("militaryRatio 接线：policy.militaryRatio=0 → 不激活（历史行为）", () => {
  const planner = new SafetyPlanner(RATIO_ENABLED_CONFIG);
  const zeroRatioPolicy = { ...RATIO_HALF, militaryRatio: 0 };
  // workers 达标但 militaryRatio=0 → militaryRatioActive=false → 历史 nextMilitary
  // 交替（0V/0R → VANGUARD）。
  const plan = planner.decide({ state: makeState(8, 0, 0, 30), policy: zeroRatioPolicy });
  assert.deepEqual(
    plan.coreAction,
    { type: "SPAWN", unitType: "VANGUARD" },
    `militaryRatio=0 应走历史交替（VANGUARD），实际 ${JSON.stringify(plan.coreAction)}`,
  );
});

test("militaryRatio 接线：无 policy → 不激活（历史行为）", () => {
  const planner = new SafetyPlanner(RATIO_ENABLED_CONFIG);
  // 无 policy：effectivePolicy=null → militaryRatioActive=false → 历史交替。
  const plan = planner.decide({ state: makeState(8, 0, 0, 30) });
  assert.deepEqual(
    plan.coreAction,
    { type: "SPAWN", unitType: "VANGUARD" },
    `无 policy 应走历史交替（VANGUARD），实际 ${JSON.stringify(plan.coreAction)}`,
  );
});
