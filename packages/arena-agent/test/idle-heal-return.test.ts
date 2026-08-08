/** worker 空闲回血候选测试（2026-08-07，B13 idleHealReturn）：空 worker 带伤
 * 且 Core 资源足够补满时回 Core 补血（引擎 P11-unit-heal 结算）；优先级低于
 * 撤离/回仓、高于采集/巡逻。默认关 = 历史行为零回归。 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runEpisode, type EpisodeConfig, type EpisodeResult } from "../src/sim/harness/episode.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");

/** 双玩家 v0.14 场景：p1 Core [0,0]，worker A 在 [3,0] 带伤（hp1），worker B
 * [6,0] 满血；p2 远在 [9,9] 无威胁；资源放 p2 侧，p1 视野无矿（排除采集干扰）。 */
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
          id: "22222222-2222-2222-2222-222222222201",
          owner: "p1",
          position: [3, 0],
          hp: 1,
          unitType: "WORKER",
          cargo: 0,
        },
        {
          id: "22222222-2222-2222-2222-222222222202",
          owner: "p1",
          position: [6, 0],
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
          id: "44444444-4444-4444-4444-444444444401",
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
    obstacles: [],
    resources: [[9, 8], [8, 8]],
  },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

const WORKER_A = "22222222-2222-2222-2222-222222222201";

function baseConfig(overrides: Partial<EpisodeConfig> = {}): EpisodeConfig {
  return {
    scenario: SCENARIO,
    rulesPath: MANIFEST_PATH,
    seed: 42,
    ticks: 40,
    tenants: [
      { id: "p1", planner: "safety" },
      { id: "p2", planner: "safety" },
    ],
    ...overrides,
  };
}

function finalWorkerHp(result: EpisodeResult, id: string): number | null {
  const unit = [...result.finalWorld.players.get("p1")!.units].find((u) => u.id === id);
  return unit === undefined ? null : unit.hp;
}

test("idleHealReturn 默认关闭：带伤空闲 worker 不回 Core（历史行为零回归）", () => {
  const result = runEpisode(baseConfig());
  const hp = finalWorkerHp(result, WORKER_A);
  assert.equal(hp, 1, "no heal without the candidate flag");
  const healed = result.records.flatMap((r) => r.events).some(
    (e) => e.eventType === "UNIT_HEAL_SUCCEEDED" && e.actorId === WORKER_A,
  );
  assert.equal(healed, false);
});

test("idleHealReturn 开启：带伤空闲 worker 回 Core 补满血（UNIT_HEAL_SUCCEEDED）", () => {
  const result = runEpisode(baseConfig({ tenants: [{ id: "p1", planner: "safety", plannerConfig: { idleHealReturn: true } }, { id: "p2", planner: "safety" }] }));
  const healed = result.records.flatMap((r) => r.events).some(
    (e) => e.eventType === "UNIT_HEAL_SUCCEEDED" && e.actorId === WORKER_A,
  );
  assert.equal(healed, true, "worker A must heal at core");
  const hp = finalWorkerHp(result, WORKER_A);
  assert.equal(hp, 2, "worker A must end at full HP");
});

test("idleHealReturn 开启且资源不足：不回 Core（保持原空闲行为）", () => {
  const scarce = JSON.parse(JSON.stringify(SCENARIO));
  scarce.players[0].resources = 0;
  const result = runEpisode(
    baseConfig({
      scenario: scarce,
      tenants: [{ id: "p1", planner: "safety", plannerConfig: { idleHealReturn: true } }, { id: "p2", planner: "safety" }],
    }),
  );
  const healed = result.records.flatMap((r) => r.events).some(
    (e) => e.eventType === "UNIT_HEAL_SUCCEEDED" && e.actorId === WORKER_A,
  );
  assert.equal(healed, false, "insufficient resources must not trigger heal return");
});

test("idleHealReturn 开启：满载 worker 仍先回仓交付（cargo 优先于治疗）", () => {
  const loaded = JSON.parse(JSON.stringify(SCENARIO));
  loaded.players[0].resources = 4;
  loaded.players[0].units[0].cargo = 1;
  const result = runEpisode(
    baseConfig({
      scenario: loaded,
      ticks: 60,
      tenants: [{ id: "p1", planner: "safety", plannerConfig: { idleHealReturn: true } }, { id: "p2", planner: "safety" }],
    }),
  );
  const events = result.records.flatMap((r) => r.events);
  const deposited = events.some((e) => e.eventType === "DEPOSIT_SUCCEEDED" && e.actorId === WORKER_A);
  const healed = events.some((e) => e.eventType === "UNIT_HEAL_SUCCEEDED" && e.actorId === WORKER_A);
  assert.equal(deposited, true, "cargo worker must deposit first");
  assert.equal(healed, true, "then heal at core");
});

test("idleHealReturn 开启：确定性等价", () => {
  const cfg = () => baseConfig({ tenants: [{ id: "p1", planner: "safety", plannerConfig: { idleHealReturn: true } }, { id: "p2", planner: "safety" }] });
  const a = runEpisode(cfg());
  const b = runEpisode(cfg());
  assert.equal(b.finalWorldHash, a.finalWorldHash);
});
