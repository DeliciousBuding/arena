/**
 * 激进 vs 保守策略 A/B 对抗（S7 harness 双玩家）：
 * - 行为合同：aggressive 下 Vanguard 前压攻坚（intent vanguard_pressure）、
 *   Ranger 优先射敌 WORKER（断经济）、计划全部合法；
 * - 对抗冒烟：aggressive vs defensive 对打 N tick，不抛错、无非法计划、
 *   且确实发生交战（damage/destroyed 事件 > 0）。
 *
 * 注意：断言只覆盖确定性可验证的性质，不断言具体 seed 的胜负（对局演化
 * 依赖 spawn 顺序与视野耦合，胜负结论应由多次 seed 的实验报告给出）。
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Plan, TickState } from "../src/domain/model.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { runEpisode, type EpisodeConfig } from "../src/sim/harness/episode.ts";
import { AGGRESSIVE_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

/** 双玩家近距场景：p1 Core [0,0] vs p2 Core [7,0]，互相在 Vanguard 前压可达范围。 */
const DUEL_SCENARIO = {
  rulesVersion: "v0.11",
  tick: 1,
  seed: 11,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 30,
      core: {
        id: "11111111-1111-1111-1111-111111111111",
        position: [0, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          owner: "p1",
          position: [1, 0],
          hp: 4,
          unitType: "VANGUARD",
          cargo: 0,
        },
        {
          id: "23333333-3333-3333-3333-333333333333",
          owner: "p1",
          position: [2, 0],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
    {
      id: "p2",
      username: "p2",
      resources: 30,
      core: {
        id: "44444444-4444-4444-4444-444444444444",
        position: [7, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [
        {
          id: "55555555-5555-5555-5555-555555555555",
          owner: "p2",
          position: [6, 0],
          hp: 4,
          unitType: "VANGUARD",
          cargo: 0,
        },
        {
          id: "66666666-6666-6666-6666-666666666666",
          owner: "p2",
          position: [8, 0],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
  ],
  terrain: {
    obstacles: [[3, 2]],
    resources: [[5, 1], [9, 1]],
  },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

function aggressivePlanner(): PlanProvider {
  return new SafetyPlanner(AGGRESSIVE_SAFETY_CONFIG);
}

function defensivePlanner(): PlanProvider {
  return new SafetyPlanner();
}

function duelConfig(ticks: number, p1: () => PlanProvider, p2: () => PlanProvider): EpisodeConfig {
  return {
    scenario: DUEL_SCENARIO,
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks,
    tenants: [
      { id: "p1", planner: "safety" },
      { id: "p2", planner: "safety" },
    ],
    plannerFactory: (tenant) => (tenant.id === "p1" ? p1() : p2()),
  };
}

test("S7 aggressive: Vanguard 前压敌 Core，Ranger 优先射敌 WORKER", () => {
  // 单边场景：aggressive 方视野里有敌人 Core 与敌人 WORKER
  const planner = aggressivePlanner();
  const state: TickState = {
    tick: 1,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 2,
    core: {
      id: "11111111-1111-1111-1111-111111111111",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      ownerUsername: "p1",
    },
    units: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        position: [2, 0],
        hp: 4,
        unitType: "VANGUARD",
        cargo: 0,
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        position: [3, 0],
        hp: 2,
        unitType: "RANGER",
        cargo: 0,
      },
    ],
    workers: [],
    vanguards: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        position: [2, 0],
        hp: 4,
        unitType: "VANGUARD",
        cargo: 0,
      },
    ],
    rangers: [
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        position: [3, 0],
        hp: 2,
        unitType: "RANGER",
        cargo: 0,
      },
    ],
    visibleEnemies: [
      {
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        kind: "CORE",
        position: [6, 0],
        hp: 5,
        ownerUsername: "p2",
      },
      {
        id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        kind: "UNIT",
        position: [5, 0],
        hp: 2,
        unitType: "WORKER",
      },
      {
        id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        kind: "UNIT",
        position: [4, 0],
        hp: 4,
        unitType: "VANGUARD",
      },
    ],
    resourceCells: new Set(["9,1"]),
    obstacleCells: new Set(["3,2"]),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };

  const plan = planner.decide({ state });
  // Vanguard 朝敌 Core 前压（intent vanguard_pressure，不留守）
  const vanguardAction = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.ok(vanguardAction !== undefined);
  assert.equal(vanguardAction.type, "MOVE");
  assert.equal(plan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], "vanguard_pressure");
  // Ranger 射程内 [4,0] VANGUARD 可射但 WORKER [5,0] 超出 3 格 → 无合法 precision 目标；
  // 此处验证优先级逻辑：把 WORKER 移到 [4,0] 后应优先射 WORKER。
  const closerPlan = planner.decide({
    state: {
      ...state,
      visibleEnemies: state.visibleEnemies.map((enemy) =>
        enemy.id === "dddddddd-dddd-dddd-dddd-dddddddddddd"
          ? { ...enemy, position: [4, 0] as const }
          : enemy,
      ),
    },
  });
  const rangerAction = closerPlan.unitActions["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"];
  assert.ok(rangerAction !== undefined);
  assert.equal(rangerAction.type, "SHOOT");
  assert.equal(rangerAction.targetId, "dddddddd-dddd-dddd-dddd-dddddddddddd", "Ranger 优先射敌 WORKER");

  const result = validatePlan(state, plan);
  assert.equal(result.valid, true);
});

test("S7 aggressive: 对打 200 Tick 无非法计划、确实交战", () => {
  const result = runEpisode(duelConfig(200, aggressivePlanner, defensivePlanner));
  assert.equal(result.metrics.illegalPlans, 0);
  assert.equal(result.metrics.repairedPlans, 0);
  assert.deepEqual(result.metrics.unsupported, []);

  const combatEvents = result.records.flatMap((record) =>
    record.events.filter((event) =>
      event.eventType === "UNIT_DAMAGED" ||
      event.eventType === "UNIT_DESTROYED" ||
      event.eventType === "CORE_DESTROYED" ||
      event.eventType === "CORE_DAMAGED",
    ),
  );
  assert.ok(combatEvents.length > 0, "双玩家对打 200 Tick 应发生交战");

  // 双方资源最终态可用于实验报告，但不做胜负断言（seed 依赖）
  const p1 = result.finalWorld.players.get("p1")!;
  const p2 = result.finalWorld.players.get("p2")!;
  assert.ok(p1.resources >= 0 && p2.resources >= 0);
});
