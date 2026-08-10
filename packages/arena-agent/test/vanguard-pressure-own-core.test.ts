/**
 * GAP 5.2 测试（2026-08-10，t1 生产实证 tick 83782）：aggressive Vanguard
 * 无可见敌人 + 视野有资源 + 无敌核记忆时，不再以自家 Core 格为目标前压
 * （旧版 `?? state.core?.position` 回退 → 16+ Vanguard 全体 vanguard_pressure
 * /vanguard_pressure_spread 压向自家 Core 格，容量 2 被占互堵振荡）——
 * 目标回退到守家锚点（homeCell/coreGuardFallback）。Core 格在 militaryObstacles
 * 中是障碍（decideVanguard 显式加入），旧版 target=Core 时 stepToward 恒 null
 * → 单位原地站桩；新版 target=守家锚点 → 正常 MOVE。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, vanguardPosition: Position, resourceCells: Position[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "v1", position: vanguardPosition, hp: 4, unitType: "VANGUARD", cargo: 0 }],
    workers: [],
    vanguards: [{ id: "v1", position: vanguardPosition, hp: 4, unitType: "VANGUARD", cargo: 0 }],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(resourceCells.map(([x, y]) => `${x},${y}`)),
    // Core 格对军事单位是障碍（decideVanguard militaryObstacles 显式加入）
    obstacleCells: new Set(["0,0"]),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const AGGRESSIVE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 4,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: "core" as const,
};

const AGGRESSIVE = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const };

test("GAP 5.2: 无敌人 + 视野有资源 → Vanguard 走向守家锚点而非原地站桩", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  // Vanguard [1,0]（Core 东邻），index 0 → 守家锚点 [0,-1]（UP）。
  // 旧版 target=自家 Core [0,0]（障碍）→ stepToward 恒 null → 原地站桩
  // （pressure 互堵的起点）；新版 target=[0,-1] → 正常 MOVE（非 LEFT 压 Core）。
  const plan = planner.decide({ state: makeState(1, [1, 0], [[10, 10]]), policy: AGGRESSIVE_POLICY });
  const action = plan.unitActions["v1"];
  assert.equal(action?.type, "MOVE", `应走向守家锚点（实际 ${JSON.stringify(action)}）`);
  assert.notEqual(action?.direction, "LEFT", "不得压向自家 Core 格");
});

test("GAP 5.2: 无敌人 + 无资源 → 打野（scavenge），不压自家 Core", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const plan = planner.decide({ state: makeState(1, [5, 0], []), policy: AGGRESSIVE_POLICY });
  const intent = plan.intents["v1"];
  assert.ok(
    intent === "vanguard_scavenge" || intent === "vanguard_hunt" || intent === "vanguard_sector_sweep",
    `无资源时应打野而非压自家 Core（实际 intent=${intent}）`,
  );
});

test("GAP 5.2: 无敌人 + 有敌核记忆 → 前压记忆（不回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  // tick1：Vanguard 见敌 Core [40,0]（Chebyshev 40 ≤64）→ 记入 coreHuntMemory
  const seenState = makeState(1, [5, 0], []);
  planner.decide({
    state: { ...seenState, visibleEnemies: [{ id: "ec1", kind: "CORE", position: [40, 0], hp: 5, unitType: "VANGUARD" }] },
    policy: AGGRESSIVE_POLICY,
  });
  // tick2：敌消失，无资源 → 应向记忆敌核前压（vanguard_pressure_memory）
  const plan = planner.decide({ state: makeState(2, [5, 0], []), policy: AGGRESSIVE_POLICY });
  const intent = plan.intents["v1"];
  assert.equal(intent, "vanguard_pressure_memory", `应前压记忆敌核（实际 intent=${intent}）`);
});

test("GAP 5.2: 有可见敌人 → 正常前压敌人（不回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState(1, [5, 0], []);
  const withEnemy: TickState = {
    ...state,
    visibleEnemies: [{ id: "e1", kind: "UNIT", unitType: "WORKER", position: [8, 0], hp: 1 }],
  };
  const plan = planner.decide({ state: withEnemy, policy: AGGRESSIVE_POLICY });
  const intent = plan.intents["v1"];
  assert.ok(
    intent === "vanguard_pressure" || intent === "vanguard_pressure_spread" || intent === "SWEEP",
    `有敌人时应前压/攻击（实际 intent=${intent}）`,
  );
});
