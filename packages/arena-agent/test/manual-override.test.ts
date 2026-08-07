/** 手操覆盖注入测试（2026-08-07）：模拟服务器侧 Manual > Agent 合并——
 * 人类玩家在同一租户槽位手操会覆盖本机 AGENT 计划；验证本机状态机
 * 自动吸收、不打断、不违反不变量。 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Plan, TickState } from "../src/domain/model.ts";
import { hashPlan, runEpisode, type EpisodeConfig } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");

/** 双玩家 v0.14 场景：p1 的 worker 紧邻障碍格（[2,0]），p2 远处。 */
const SCENARIO = {
  rulesVersion: "v0.14",
  tick: 1,
  seed: 7,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 10,
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
    {
      id: "p2",
      username: "p2",
      resources: 10,
      core: {
        id: "33333333-3333-3333-3333-333333333333",
        position: [9, 9],
        hp: 5,
        shield: 5,
        state: "NORMAL",
      },
      units: [
        {
          id: "44444444-4444-4444-4444-444444444444",
          owner: "p2",
          position: [8, 9],
          hp: 2,
          unitType: "WORKER",
          cargo: 0,
        },
      ],
    },
  ],
  terrain: {
    obstacles: [[2, 0]],
    resources: [[3, 0], [9, 8]],
  },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

function baseConfig(overrides: Partial<EpisodeConfig> = {}): EpisodeConfig {
  return {
    scenario: SCENARIO,
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks: 80,
    tenants: [
      { id: "p1", planner: "deterministic" },
      { id: "p2", planner: "deterministic" },
    ],
    ...overrides,
  };
}

/** 手操示例 1：每个 tick 都强令 worker 撞向障碍格（[2,0] 有障碍）——
 * 服务器按 Manual > Agent 合并后执行该命令，本机 planner 看不到。 */
function obstacleOverride(tenantId: string, _tick: number, _state: TickState, proposed: Plan): Plan | null {
  if (tenantId !== "p1") return null;
  return {
    ...proposed,
    tick: proposed.tick,
    unitActions: {
      ...proposed.unitActions,
      "22222222-2222-2222-2222-222222222222": {
        type: "MOVE",
        direction: "RIGHT",
      },
    },
  };
}

/** 手操示例 2：仅奇数 tick 覆盖一次（更接近真实手操频率）。 */
function intermittentOverride(
  tenantId: string,
  tick: number,
  _state: TickState,
  proposed: Plan,
): Plan | null {
  if (tenantId !== "p1") return null;
  if (tick % 2 !== 1) return null;
  return {
    ...proposed,
    tick: proposed.tick,
    unitActions: {
      ...proposed.unitActions,
      "22222222-2222-2222-2222-222222222222": {
        type: "MOVE",
        direction: "LEFT",
      },
    },
  };
}

test("manual override: 每 tick 撞障碍——episode 完整跑完、不变量保持、planner 计划仍全 valid", () => {
  const result = runEpisode(baseConfig({ manualOverrideProvider: obstacleOverride }));
  assert.equal(result.metrics.ticks, 80);
  // planner 本机计划不受手操影响：仍然全部合法、零修复
  assert.equal(result.metrics.illegalPlans, 0);
  assert.equal(result.metrics.repairedPlans, 0);
  // 撞障碍命令真实生效：存在 MOVE_FAILED 事件
  const allEvents = result.records.flatMap((record) => record.events);
  assert.ok(
    allEvents.some(
      (event) => event.eventType === "UNIT_MOVE_FAILED" || event.eventType === "MOVE_FAILED",
    ),
    "override into obstacle must produce a move-failed event",
  );
  // 每个 tick 的 records.plans 都记录的是合并后的计划（覆盖生效）
  const firstRecord = result.records[0];
  assert.equal(
    firstRecord.plans.p1.unitActions["22222222-2222-2222-2222-222222222222"]?.type,
    "MOVE",
  );
  // 确定性：同 seed 逐字节等价
  const again = runEpisode(baseConfig({ manualOverrideProvider: obstacleOverride }));
  assert.equal(again.finalWorldHash, result.finalWorldHash);
});

test("manual override: 与无手操基线世界分叉，但状态机持续决策不 stall", () => {
  const baseline = runEpisode(baseConfig());
  const overridden = runEpisode(baseConfig({ manualOverrideProvider: intermittentOverride }));
  assert.notEqual(overridden.finalWorldHash, baseline.finalWorldHash, "手操必须真实改变世界演化");
  // 手操下 planner 仍每个 tick 产出合法计划（无 stall、无非法计划）
  assert.equal(overridden.metrics.illegalPlans, 0);
  assert.equal(overridden.metrics.repairedPlans, 0);
  // 覆盖后的计划被记录为送入 settlement 的计划（records.plans 口径）
  const hashWithOverride = overridden.records.map((r) => r.planHashes.p1).join(",");
  const hashBaseline = baseline.records.map((r) => r.planHashes.p1).join(",");
  assert.notEqual(hashWithOverride, hashBaseline);
});

test("manual override: null 返回 = 不覆盖（与缺省完全一致）", () => {
  const baseline = runEpisode(baseConfig());
  const noop = runEpisode(baseConfig({ manualOverrideProvider: () => null }));
  assert.equal(noop.finalWorldHash, baseline.finalWorldHash);
  assert.deepEqual(noop.records, baseline.records);
  assert.equal(hashPlan(noop.records[0].plans.p1), hashPlan(baseline.records[0].plans.p1));
});
