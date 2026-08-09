/**
 * P4g-1 first-spawn 模拟路径（agent-ecosystem P4g，2026-08-09）：
 * 官方"新玩家激活首 spawn 走确定性 resolver"在模拟器的最小路径 = scenario
 * 预置初始 RESPAWNING + respawnAtTick（loaders.ts 载入即支持，无需预置
 * 实体），runEpisode 首 tick 由 P13 respawn resolver 放置（Core+Worker+
 * 资源、ACTIVE、合法位置、UUID 确定性）。
 *
 * settleTick 级 respawn 覆盖见 sim-respawn.test.ts；本文件覆盖完整 planner
 * 闭环——核心缺失（RESPAWNING）玩家在 tick 1 的决策/校验/结算循环正常走
 * 通，且裸 RESPAWNING（缺 respawnAtTick）在 episode 层 fail closed 为
 * unsupported。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACT_DIR = join(here, "..", "src", "sim", "contracts");
const RULES_PATH = join(CONTRACT_DIR, "rules-v0.14.json");

const rules = loadRulesManifest(RULES_PATH);

const P2_CORE = "33333333-3333-3333-3333-333333333333";

/** p1 初始 RESPAWNING（无 Core/Units，首 tick 到期），p2 活 Core 作距离参照。 */
const FIRST_SPAWN_SCENARIO = {
  rulesVersion: "v0.14",
  tick: 1,
  seed: 7,
  players: [
    {
      id: "p1",
      username: "p1",
      resources: 0,
      status: "RESPAWNING",
      respawnAtTick: 1,
      core: null,
      units: [],
    },
    {
      id: "p2",
      username: "p2",
      resources: 5,
      core: { id: P2_CORE, position: [50, 50], hp: 5, shield: 5, state: "NORMAL" },
      units: [],
    },
  ],
  terrain: { obstacles: [], resources: [], piles: [] },
  beacon: { position: [100, 100], status: "GROUND", carrierId: null },
};

const TENANTS: readonly EpisodeTenant[] = [
  { id: "p1", planner: "deterministic" },
  { id: "p2", planner: "deterministic" },
];

function runFirstSpawn(seed: number) {
  return runEpisode({
    scenario: FIRST_SPAWN_SCENARIO,
    rulesPath: RULES_PATH,
    seed,
    ticks: 1,
    tenants: TENANTS,
  });
}

test("P4g-1: 初始 RESPAWNING + respawnAtTick=1 → runEpisode 首 tick 正常重生", () => {
  const result = runFirstSpawn(7);

  // 完整 planner 闭环（核心缺失玩家 tick 1 决策/校验/结算）不抛错
  assert.equal(result.metrics.illegalPlans, 0);
  assert.ok(!result.metrics.unsupported.includes("respawn"), `unsupported=${result.metrics.unsupported}`);

  const p1 = result.finalWorld.players.get("p1")!;
  assert.equal(p1.status, "ACTIVE");
  assert.equal(p1.respawnAtTick, null);
  assert.ok(p1.core !== null);
  assert.equal(p1.core.hp, rules.rules.core.maxHp);
  assert.equal(p1.core.shield, rules.rules.core.maxShield);
  assert.equal(p1.resources, rules.rules.core.startingResources);
  assert.equal(p1.units.length, rules.rules.core.startingWorkerCount);
  const worker = p1.units[0];
  assert.equal(worker.unitType, "WORKER");
  assert.equal(worker.hp, rules.rules.units.workerHp);
  assert.deepEqual(worker.position, p1.core.position, "worker spawns on core cell");

  // 合法位置：距 p2 活 Core 20-30 Manhattan（确定性环带字典序最小格）
  const [cx, cy] = p1.core.position;
  const distance = Math.abs(cx - 50) + Math.abs(cy - 50);
  assert.ok(distance >= 20 && distance <= 30, `distance ${distance}`);
  assert.deepEqual(p1.core.position, [20, 50], "deterministic spawn cell (density 0, min x)");
});

test("P4g-1: 首 tick 事件与 W51 账本——CORE_RESPAWNED、无 DELAYED、respawnCount=1", () => {
  const result = runFirstSpawn(7);
  const record = result.records[0]!;
  const p1 = result.finalWorld.players.get("p1")!;

  const respawned = record.events.find((event) => event.eventType === "CORE_RESPAWNED");
  assert.ok(respawned !== undefined, "CORE_RESPAWNED missing");
  assert.equal(respawned!.targetId, p1.core!.id);
  assert.deepEqual(respawned!.position, p1.core!.position);
  assert.deepEqual(respawned!.values, {
    resources: rules.rules.core.startingResources,
    workers: rules.rules.core.startingWorkerCount,
  });
  assert.ok(!record.events.some((event) => event.eventType === "RESPAWN_DELAYED"));

  // W51 per-player cost ledger：重生计入 respawnCount
  assert.equal(result.metrics.perPlayer["p1"]!.respawnCount, 1);
});

test("P4g-1: UUID 确定性——同 seed 全同、异 seed 不同（且均 canonical）", () => {
  const a = runFirstSpawn(7);
  const b = runFirstSpawn(7);
  const c = runFirstSpawn(8);

  const uuidA = a.finalWorld.players.get("p1")!.core!.id;
  const uuidB = b.finalWorld.players.get("p1")!.core!.id;
  const uuidC = c.finalWorld.players.get("p1")!.core!.id;

  assert.equal(a.finalWorldHash, b.finalWorldHash, "same seed must be fully deterministic");
  assert.equal(uuidA, uuidB);
  assert.notEqual(uuidA, uuidC, "seed feeds deterministic respawn UUID");
  for (const uuid of [uuidA, uuidB, uuidC]) {
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test("P4g-1: 裸 RESPAWNING（缺 respawnAtTick）→ episode 层 fail closed 为 unsupported", () => {
  const result = runEpisode({
    scenario: {
      ...FIRST_SPAWN_SCENARIO,
      players: [
        {
          id: "p1",
          username: "p1",
          resources: 0,
          status: "RESPAWNING",
          respawnAtTick: null,
          core: null,
          units: [],
        },
        FIRST_SPAWN_SCENARIO.players[1],
      ],
    },
    rulesPath: RULES_PATH,
    seed: 7,
    ticks: 1,
    tenants: TENANTS,
  });

  assert.ok(result.metrics.unsupported.includes("respawn"), `unsupported=${result.metrics.unsupported}`);
  const p1 = result.finalWorld.players.get("p1")!;
  assert.equal(p1.status, "RESPAWNING", "bare state untouched");
  assert.equal(p1.respawnAtTick, null);
  assert.equal(p1.core, null);
  assert.ok(!result.records[0]!.events.some((event) => event.eventType === "CORE_RESPAWNED"));
});
