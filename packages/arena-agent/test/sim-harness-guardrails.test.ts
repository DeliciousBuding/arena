/** P4e/P4f 护栏（agent-ecosystem，2026-08-09）：
 *  - P4e: per-tick 决策预算（decisionBudgetMs）——超预算丢弃 + lastPlan 重放 +
 *    strikes 连续超时降级（跳过 decide）+ decisionTimeouts 指标；
 *  - P4f: early-stop（earlyStop）——全员无存活提前终止 + endedEarly 记录；
 *    默认关 = 历史行为零回归。
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { runEpisode, type EpisodeConfig } from "../src/sim/harness/episode.ts";
import { summarizeEpisode } from "../src/sim/tools/experiments.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");

const SCENARIO = {
  rulesVersion: "v0.11",
  tick: 1,
  seed: 7,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 5,
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
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
  ],
  terrain: {
    obstacles: [[2, 0]],
    resources: [[3, 0]],
  },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

const TWO_PLAYER_SCENARIO = {
  ...SCENARIO,
  players: [
    ...SCENARIO.players,
    {
      id: "p2",
      username: "p2",
      resources: 5,
      core: {
        id: "33333333-3333-3333-3333-333333333333",
        position: [40, 0],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [],
    },
  ],
};

function baseConfig(overrides: Partial<EpisodeConfig> = {}): EpisodeConfig {
  return {
    scenario: SCENARIO,
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks: 100,
    tenants: [{ id: "p1", planner: "deterministic" }],
    ...overrides,
  };
}

/** 同步忙等：planner.decide 是同步调用，测试用 busy-wait 模拟慢决策。 */
function busySleep(ms: number): void {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    // busy-wait
  }
}

const WORKER_ID = "22222222-2222-2222-2222-222222222222";

/** 首 tick 快速产出 MOVE UP 计划（成为 lastPlan 重放源），之后每次都超预算。 */
function createSlowPlanner(decideCalls: { count: number }): PlanProvider {
  return {
    decide: ({ state }) => {
      decideCalls.count += 1;
      if (decideCalls.count === 1) {
        const worker = state.workers[0];
        return {
          tick: state.tick,
          unitActions: { [worker.id]: { type: "MOVE", direction: "UP" } },
          coreAction: null,
          intents: {},
        };
      }
      busySleep(30);
      return { tick: state.tick, unitActions: {}, coreAction: null, intents: {} };
    },
  };
}

/** 每次 decide 都超预算（无正常产出；验证无 lastPlan 时回退空计划）。 */
function createAlwaysSlowPlanner(decideCalls: { count: number }): PlanProvider {
  return {
    decide: ({ state }) => {
      decideCalls.count += 1;
      busySleep(30);
      return { tick: state.tick, unitActions: {}, coreAction: null, intents: {} };
    },
  };
}

test("P4e: 慢 planner 超预算 → 丢弃结果、重放上次计划、记 decisionTimeouts", () => {
  const decideCalls = { count: 0 };
  const result = runEpisode(
    baseConfig({
      ticks: 6,
      decisionBudgetMs: 5,
      decisionBudgetStrikes: 3,
      plannerFactory: () => createSlowPlanner(decideCalls),
    }),
  );
  // tick1 快（正常产出）；tick2-4 连续超时（strikes 1→3，tick4 后标记跳过）；tick5-6 跳过 decide
  assert.equal(decideCalls.count, 4);
  assert.equal(result.metrics.perPlayer.p1.decisionTimeouts, 3);
  assert.equal(result.metrics.endedEarly, false);
  assert.equal(result.metrics.endReason, null);
  assert.equal(result.metrics.endedAtTick, null);
  // 首 tick 正常计划 = MOVE UP（lastPlan 重放源）
  const firstActions = result.records[0]!.plans.p1.unitActions;
  assert.deepEqual(firstActions, { [WORKER_ID]: { type: "MOVE", direction: "UP" } });
  assert.deepEqual(result.records[0]!.decisionTimeouts, {});
  assert.deepEqual(result.records[0]!.decisionTimeoutSkipped, []);
  // tick2-4：超时丢弃，重放上次执行计划（MOVE UP）
  for (const record of result.records.slice(1, 4)) {
    assert.deepEqual(record.decisionTimeouts, { p1: 1 });
    assert.deepEqual(record.decisionTimeoutSkipped, []);
    assert.deepEqual(record.plans.p1.unitActions, firstActions);
  }
  // tick5-6：连续超时达标 → 跳过 decide，直接空计划 + DECISION_TIMEOUT_SKIPPED 记录
  for (const record of result.records.slice(4)) {
    assert.deepEqual(record.decisionTimeoutSkipped, ["p1"]);
    assert.deepEqual(record.decisionTimeouts, {});
    assert.deepEqual(record.plans.p1.unitActions, {});
  }
});

test("P4e: 每 tick 都慢 → strikes 默认 3、无 lastPlan 用空计划、跳过后续 decide", () => {
  const decideCalls = { count: 0 };
  const result = runEpisode(
    baseConfig({
      ticks: 6,
      decisionBudgetMs: 5,
      plannerFactory: () => createAlwaysSlowPlanner(decideCalls),
    }),
  );
  assert.equal(decideCalls.count, 3);
  assert.equal(result.metrics.perPlayer.p1.decisionTimeouts, 3);
  for (const record of result.records.slice(0, 3)) {
    assert.deepEqual(record.decisionTimeouts, { p1: 1 });
    assert.deepEqual(record.plans.p1.unitActions, {});
  }
  for (const record of result.records.slice(3)) {
    assert.deepEqual(record.decisionTimeoutSkipped, ["p1"]);
    assert.deepEqual(record.decisionTimeouts, {});
    assert.deepEqual(record.plans.p1.unitActions, {});
  }
});

test("P4e: summarizeEpisode 报告 per-player decisionTimeouts", () => {
  const decideCalls = { count: 0 };
  const config = baseConfig({
    ticks: 6,
    decisionBudgetMs: 5,
    plannerFactory: () => createAlwaysSlowPlanner(decideCalls),
  });
  const result = runEpisode(config);
  const summary = summarizeEpisode(config, result);
  assert.equal(summary.players.find((player) => player.playerId === "p1")?.decisionTimeouts, 3);
});

test("P4e: 快速 planner + 预算开启 → 零超时、与未开启逐字节一致（零回归）", () => {
  const baseline = runEpisode(baseConfig({ ticks: 20 }));
  const budgeted = runEpisode(baseConfig({ ticks: 20, decisionBudgetMs: 5 }));
  assert.equal(budgeted.metrics.perPlayer.p1.decisionTimeouts, 0);
  assert.deepEqual(budgeted.records, baseline.records);
  assert.equal(budgeted.finalWorldHash, baseline.finalWorldHash);
  const stableMetrics = (result: ReturnType<typeof runEpisode>) => {
    const { wallMs: _wallMs, ...stable } = result.metrics;
    return stable;
  };
  assert.deepEqual(stableMetrics(budgeted), stableMetrics(baseline));
});

function selfDestructPlanner(): PlanProvider {
  return {
    decide: ({ state }) => ({
      tick: state.tick,
      unitActions: {},
      coreAction: { type: "SELF_DESTRUCT" },
      intents: {},
    }),
  };
}

test("P4f: 单玩家 Core 自毁 → 全员无存活 → 提前终止 + endedEarly 记录", () => {
  const config = baseConfig({
    ticks: 50,
    earlyStop: true,
    plannerFactory: selfDestructPlanner,
  });
  const result = runEpisode(config);
  assert.equal(result.metrics.endedEarly, true);
  assert.equal(result.metrics.endReason, "all-dead");
  assert.equal(result.metrics.endedAtTick, 1);
  assert.equal(result.metrics.ticks, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.finalWorld.tick, 2);
  // 自毁后进入 RESPAWNING；无活 Core 时重生不可能（spawn 候选格依赖活 Core）
  assert.equal(result.finalWorld.players.get("p1")!.status, "RESPAWNING");
  assert.ok(result.records[0]!.events.some((event) => event.eventType === "CORE_DESTROYED"));
  // 不判胜负：无 winner/eliminated 语义，只记录资源护栏
  assert.equal(result.metrics.perPlayer.p1.decisionTimeouts, 0);
});

test("P4f: 默认关 → 全员死亡仍跑满 tick（历史行为零回归）", () => {
  const result = runEpisode(
    baseConfig({ ticks: 50, plannerFactory: selfDestructPlanner }),
  );
  assert.equal(result.metrics.endedEarly, false);
  assert.equal(result.metrics.endReason, null);
  assert.equal(result.metrics.endedAtTick, null);
  assert.equal(result.metrics.ticks, 50);
  assert.equal(result.records.length, 50);
});

test("P4f: 双玩家一人自毁 → RESPAWNING 不算全员死亡，episode 继续且重生", () => {
  const idlePlanner: PlanProvider = {
    decide: ({ state }) => ({
      tick: state.tick,
      unitActions: {},
      coreAction: null,
      intents: {},
    }),
  };
  const result = runEpisode(
    baseConfig({
      ticks: 30,
      earlyStop: true,
      tenants: [
        { id: "p1", planner: "deterministic" },
        { id: "p2", planner: "deterministic" },
      ],
      scenario: TWO_PLAYER_SCENARIO,
      plannerFactory: (tenant) => (tenant.id === "p2" ? selfDestructPlanner() : idlePlanner),
    }),
  );
  // p1 恒有 Core → 永不全员死亡 → 跑满 ticks
  assert.equal(result.metrics.endedEarly, false);
  assert.equal(result.metrics.ticks, 30);
  assert.equal(result.records.length, 30);
  // p2 每 tick 自毁后经 P13 重生（依赖 p1 的活 Core 提供 spawn 候选格）
  assert.ok(
    result.records.some((record) =>
      record.events.some((event) => event.eventType === "CORE_RESPAWNED"),
    ),
    "expected at least one CORE_RESPAWNED event",
  );
  assert.equal(result.finalWorld.players.get("p2")!.status, "ACTIVE");
});
