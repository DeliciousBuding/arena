/**
 * Ranger 攻坚动量测试（2026-08-07，t2 jerkman 实证修复）：aggressive Ranger
 * 无可见敌人时，若已知敌核心（CORE 目击记忆）在 64 格有界范围内 → 前压到
 * 射程（ranger_move），而非回家守位——避免"打完遭遇战敌消失 → 全体回家 →
 * 攻坚脱节"。超 64 格不推（防远征）；defensive 不推。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function enemyCore(position: Position): VisibleEntity {
  return { id: "ec1", kind: "CORE", position, hp: 5, unitType: "VANGUARD" };
}

function makeState(tick: number, rangerPosition: Position, enemies: VisibleEntity[]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    workers: [],
    vanguards: [],
    rangers: [{ id: "r1", position: rangerPosition, hp: 2, unitType: "RANGER", cargo: 0 }],
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
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
const DEFENSIVE = { ...DEFAULT_SAFETY_CONFIG, aggression: "defensive" as const };

const DEFENSIVE_POLICY = {
  posture: "balanced" as const,
  workerTarget: 4,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: "core" as const,
};

test("aggressive Ranger 记忆敌核心（64 格内）→ 无可见敌人时前压而非回家", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  // tick1：Ranger [10,0] 见敌 Core [40,0]（Chebyshev 40 ≤64）→ 记入 coreHuntMemory
  planner.decide({ state: makeState(1, [10, 0], [enemyCore([40, 0])]), policy: AGGRESSIVE_POLICY });
  // tick2：敌消失 → Ranger 前压到射程（ranger_move RIGHT），不回家
  const plan = planner.decide({ state: makeState(2, [10, 0], []), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_move", "向记忆敌核心前压");
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "RIGHT" });
});

test("aggressive Ranger 已在射程内（≤3）→ 不移动（保持站位，记忆射击接管）", () => {
  const planner = new SafetyPlanner({ ...AGGRESSIVE, rangerMemoryShot: true });
  planner.decide({ state: makeState(1, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  planner.decide({ state: makeState(2, [6, 0], [enemyCore([8, 0])]), policy: AGGRESSIVE_POLICY });
  // tick3：敌消失，Ranger [6,0] 距记忆核心 [8,0] 2 格（射程内）→ 记忆射击，不移动
  const plan = planner.decide({ state: makeState(3, [6, 0], []), policy: AGGRESSIVE_POLICY });
  assert.equal(plan.intents["r1"], "ranger_memory_shot", "射程内打记忆格");
});

test("aggressive Ranger 记忆敌核心超 64 格 → 不前压（防远征）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  // tick1：Ranger [10,0] 见敌 Core [80,0]（Chebyshev 80 >64）→ 记忆
  planner.decide({ state: makeState(1, [10, 0], [enemyCore([80, 0])]), policy: AGGRESSIVE_POLICY });
  // tick2：敌消失 → 不推（回家守位）
  const plan = planner.decide({ state: makeState(2, [10, 0], []), policy: AGGRESSIVE_POLICY });
  // 不推（回家方向 LEFT，不是朝敌核心 RIGHT）
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" }, "超 64 格回家不远征");
});

test("defensive Ranger 记忆敌核心 → 不前压（守家锚点）", () => {
  const planner = new SafetyPlanner(DEFENSIVE);
  planner.decide({ state: makeState(1, [10, 0], [enemyCore([40, 0])]), policy: DEFENSIVE_POLICY });
  const plan = planner.decide({ state: makeState(2, [10, 0], []), policy: DEFENSIVE_POLICY });
  // defensive 回家守位（LEFT），不前压（RIGHT）
  assert.deepEqual(plan.unitActions["r1"], { type: "MOVE", direction: "LEFT" }, "defensive 回家守位不前压");
});
