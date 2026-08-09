/** S7 planner 闭环 harness：replay、事件反馈、validator、tenant 隔离与 fail-closed。 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Plan, TickState } from "../src/domain/model.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { hashPlan, maxFailureStreak, runEpisode, type EpisodeConfig, type EpisodeRecord } from "../src/sim/harness/episode.ts";

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

function metricsWithoutWall(result: ReturnType<typeof runEpisode>): Omit<typeof result.metrics, "wallMs"> {
  const { wallMs: _wallMs, ...stable } = result.metrics;
  return stable;
}

test("S7: deterministic replay——world/records/稳定 metrics 逐字节等价", () => {
  const a = runEpisode(baseConfig());
  const b = runEpisode(baseConfig());
  assert.equal(a.finalWorldHash, b.finalWorldHash);
  assert.deepEqual(a.records, b.records);
  assert.deepEqual(metricsWithoutWall(a), metricsWithoutWall(b));
  assert.equal(a.finalWorld.seed, 42, "EpisodeConfig.seed 是唯一 episode seed");
});

test("S7: plan hash 是 canonical SHA-256，不受对象 key 插入顺序影响", () => {
  const a: Plan = {
    tick: 1,
    unitActions: {
      "22222222-2222-2222-2222-222222222222": { type: "WAIT" },
      "11111111-1111-1111-1111-111111111111": { type: "MOVE", direction: "UP" },
    },
    coreAction: null,
    intents: { b: "B", a: "A" },
  };
  const b: Plan = {
    tick: 1,
    unitActions: {
      "11111111-1111-1111-1111-111111111111": { type: "MOVE", direction: "UP" },
      "22222222-2222-2222-2222-222222222222": { type: "WAIT" },
    },
    coreAction: null,
    intents: { a: "A", b: "B" },
  };
  assert.equal(hashPlan(a), hashPlan(b));
  assert.match(hashPlan(a), /^[0-9a-f]{64}$/);
});

test("S7: 1000 Tick 闭环成功", () => {
  const result = runEpisode(baseConfig({ ticks: 1000 }));
  assert.equal(result.metrics.ticks, 1000);
  assert.equal(result.finalWorld.tick, 1001);
  assert.equal(result.finalWorld.resolvedTickCount, 1000);
  assert.equal(result.records.length, 1000);
  assert.ok(result.records.every((record) => /^[0-9a-f]{64}$/.test(record.aggregatePlanHash)));
  // 2026-08-10 sim 死锁检测：failedEventCounts 字段存在且是对象
  assert.ok(typeof result.records[0]!.failedEventCounts === "object", "failedEventCounts 字段应存在");
});

// ---------------------------------------------------------------------------
// 2026-08-10 sim 死锁检测：failedEventCounts + maxFailureStreak
// ---------------------------------------------------------------------------

test("S7: failedEventCounts 统计失败事件 + maxFailureStreak 检测连续死锁", () => {
  // 构造人工 records 验证 maxFailureStreak 纯函数逻辑
  const fakeRecords = [
    { failedEventCounts: { SHOT_MISSED: 3, UNIT_MOVE_FAILED: 1 } },
    { failedEventCounts: { SHOT_MISSED: 2, UNIT_MOVE_FAILED: 1 } },
    { failedEventCounts: { SHOT_MISSED: 1 } }, // UNIT_MOVE_FAILED 断了
    { failedEventCounts: {} }, // SHOT_MISSED 断了
    { failedEventCounts: { SHOT_MISSED: 2 } }, // 新 streak
  ] as unknown as EpisodeRecord[];
  const streaks = maxFailureStreak(fakeRecords);
  // SHOT_MISSED: streak 1-3 (3 ticks) + streak 5 (1 tick) → max = 3
  assert.equal(streaks.SHOT_MISSED, 3, "SHOT_MISSED max streak = 3");
  // UNIT_MOVE_FAILED: streak 1-2 (2 ticks) → max = 2
  assert.equal(streaks.UNIT_MOVE_FAILED, 2, "UNIT_MOVE_FAILED max streak = 2");
});

test("S7: 非法计划真实进入 validator 并被修复", () => {
  const wrongTickPlanner: PlanProvider = {
    decide: ({ state }) => ({
      tick: state.tick + 1,
      unitActions: {},
      coreAction: null,
      intents: {},
    }),
  };
  const result = runEpisode(
    baseConfig({ ticks: 1, plannerFactory: () => wrongTickPlanner }),
  );
  assert.equal(result.metrics.illegalPlans, 1);
  assert.equal(result.metrics.repairedPlans, 1);
  assert.deepEqual(result.records[0].validations.p1, {
    valid: false,
    repaired: true,
    issueCount: 1,
  });
  assert.equal(result.records[0].plans.p1.tick, 1);
});

test("S7: 上一 Tick 私有事件回灌 Planner", () => {
  const observed: TickState[] = [];
  const planner: PlanProvider = {
    decide: ({ state }) => {
      observed.push(state);
      const worker = state.workers[0];
      return {
        tick: state.tick,
        unitActions: {
          [worker.id]: state.tick === 1 ? { type: "HARVEST" } : { type: "WAIT" },
        },
        coreAction: null,
        intents: {},
      };
    },
  };
  const scenario = {
    ...SCENARIO,
    terrain: { obstacles: [], resources: [[1, 0]] },
  };
  runEpisode(baseConfig({ scenario, ticks: 2, plannerFactory: () => planner }));
  assert.equal(observed.length, 2);
  assert.ok(observed[1].events.some((event) => event.eventType === "HARVEST_SUCCEEDED"));
});

test("S7: two-tenant 计划/验证记录不互相覆盖", () => {
  const result = runEpisode(
    baseConfig({
      ticks: 50,
      tenants: [
        { id: "p2", planner: "safety" },
        { id: "p1", planner: "deterministic" },
      ],
      scenario: {
        ...SCENARIO,
        players: [
          ...SCENARIO.players,
          {
            id: "p2",
            username: "p2",
            resources: 5,
            core: {
              id: "33333333-3333-3333-3333-333333333333",
              position: [10, 0],
              hp: 5,
              shield: 5,
              state: "NORMAL",
            },
            units: [
              {
                id: "44444444-4444-4444-4444-444444444444",
                owner: "p2",
                position: [11, 0],
                hp: 2,
                unitType: "WORKER",
                cargo: 0,
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(result.finalWorld.players.size, 2);
  for (const record of result.records) {
    assert.deepEqual(Object.keys(record.plans), ["p1", "p2"]);
    assert.deepEqual(Object.keys(record.validations), ["p1", "p2"]);
    assert.match(record.planHashes.p1, /^[0-9a-f]{64}$/);
    assert.match(record.planHashes.p2, /^[0-9a-f]{64}$/);
  }
});

test("S7: planner memory reset——独立 episode 无状态泄漏", () => {
  const first = runEpisode(baseConfig({ ticks: 50 }));
  const second = runEpisode(baseConfig({ ticks: 50 }));
  assert.equal(first.finalWorldHash, second.finalWorldHash);
  assert.deepEqual(first.records, second.records);
});

test("S7: safety planner 可闭环", () => {
  const result = runEpisode(
    baseConfig({ tenants: [{ id: "p1", planner: "safety" }], ticks: 200 }),
  );
  assert.equal(result.metrics.ticks, 200);
  assert.equal(result.metrics.illegalPlans, 0);
});

test("S7: tenant/rules/beacon 契约 fail closed", () => {
  assert.throws(
    () => runEpisode(baseConfig({ tenants: [] })),
    /tenants must exactly match players/,
  );
  assert.throws(
    () => runEpisode(baseConfig({ tenants: [
      { id: "p1", planner: "safety" },
      { id: "p1", planner: "safety" },
    ] })),
    /duplicate tenant id/,
  );
  assert.throws(
    () => runEpisode(baseConfig({ scenario: { ...SCENARIO, rulesVersion: "v0.10" } })),
    /scenario rules v0.10 != manifest v0.11/,
  );
  const { beacon: _beacon, ...withoutBeacon } = SCENARIO;
  assert.throws(
    () => runEpisode(baseConfig({ scenario: withoutBeacon })),
    /beacon state is required/,
  );
});

/* ------------------------------------------------------------------ *
 * P4g 决策流水线（pipeline=true）
 * ------------------------------------------------------------------ */

/** 带 prefetch/decideCached 的测试 provider：记录调用序列并缓存 prefetch 结果。 */
class CountingPipelinePlanner implements PlanProvider {
  readonly prefetchCalls: number[] = [];
  readonly decideCalls: number[] = [];
  readonly cachedTicks: number[] = [];
  private cached: Plan | null = null;

  decide(input: { readonly state: TickState }): Plan {
    this.decideCalls.push(input.state.tick);
    return { tick: input.state.tick, unitActions: {}, coreAction: null, intents: {} };
  }

  prefetch(input: { readonly state: TickState }): void {
    this.prefetchCalls.push(input.state.tick);
    this.cached = this.decide(input);
  }

  decideCached(): Plan {
    const plan = this.cached;
    this.cached = null;
    if (plan === null) {
      throw new Error("pipeline test: decideCached without prefetch");
    }
    this.cachedTicks.push(plan.tick);
    return plan;
  }
}

test("S7 P4g: 流水线模式与串行模式结果逐字节一致（内置 planner 同步 prefetch）", () => {
  const serial = runEpisode(baseConfig({ ticks: 60 }));
  const pipelined = runEpisode(baseConfig({ ticks: 60, pipeline: true }));
  assert.equal(pipelined.finalWorldHash, serial.finalWorldHash);
  assert.deepEqual(pipelined.records, serial.records);
  assert.deepEqual(metricsWithoutWall(pipelined), metricsWithoutWall(serial));
});

test("S7 P4g: prefetch/decideCached 成对调用——tick 序列与串行一致且无悬空缓存", () => {
  const planner = new CountingPipelinePlanner();
  const result = runEpisode(
    baseConfig({
      ticks: 40,
      pipeline: true,
      plannerFactory: () => planner,
    }),
  );
  // 预取 tick 1..ticks（tick 1 循环外预取；tick N 预取在 tick N-1 结算后）——
  // 与串行模式的 decide tick 序列完全一致。
  const expectedTicks = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.deepEqual(planner.prefetchCalls, expectedTicks);
  assert.deepEqual(planner.decideCalls, expectedTicks);
  assert.deepEqual(planner.cachedTicks, expectedTicks);
  assert.equal(result.metrics.ticks, 40);
  assert.equal(result.finalWorld.tick, 41);
});

test("S7 P4g: 无 prefetch 的 provider 在流水线模式下退回同步 decide（行为不变）", () => {
  const emptyPlanner: PlanProvider = {
    decide: (input: { readonly state: TickState }) => ({
      tick: input.state.tick,
      unitActions: {},
      coreAction: null,
      intents: {},
    }),
  };
  const serial = runEpisode(baseConfig({ ticks: 30, plannerFactory: () => emptyPlanner }));
  const pipelined = runEpisode(
    baseConfig({
      ticks: 30,
      pipeline: true,
      plannerFactory: () => emptyPlanner,
    }),
  );
  assert.deepEqual(pipelined.records, serial.records);
  assert.deepEqual(metricsWithoutWall(pipelined), metricsWithoutWall(serial));
});
