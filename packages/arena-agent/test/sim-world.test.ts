/**
 * S2 world invariants 测试（W47 新增）：
 * - [0,0] 恒 EMPTY（非障碍）：主干路径不得被围死（world-and-ticks.md:35-37）；
 * - 信标格非障碍：Beacon 不被围死，落地信标须可通行；
 * - validateWorld 对违规世界返回问题、assertWorldInvariants 抛错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey, type Position } from "../src/domain/model.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import type { SimWorld } from "../src/sim/world/types.ts";
import {
  assertWorldInvariants,
  validateWorld,
  WorldInvariantError,
} from "../src/sim/world/world.ts";

const P1_CORE = "11111111-1111-1111-1111-111111111111";

/** 合法基线世界：单玩家 Core[0,0]、无障碍、Beacon 在 [2,2] GROUND。 */
function baselineScenario(): unknown {
  return {
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1",
        username: "p1",
        resources: 5,
        core: { id: P1_CORE, position: [0, 0] as const, hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: { position: [2, 2] as const, status: "GROUND" as const, carrierId: null },
  };
}

/** 直接构造 SimWorld（绕过 worldFromScenario 的 invariants 校验）用于违规测试。 */
function constructWorldDirectly(overrides: {
  readonly obstacles?: readonly Position[];
  readonly beaconPosition?: Position;
  readonly beaconStatus?: "GROUND" | "CARRIED";
  readonly beaconCarrierId?: string | null;
}): SimWorld {
  const obstacles = new Set((overrides.obstacles ?? []).map((cell) => cellKey(cell)));
  const beaconPosition = overrides.beaconPosition ?? [2, 2];
  const beaconStatus = overrides.beaconStatus ?? "GROUND";
  const beaconCarrierId = overrides.beaconCarrierId ?? null;
  const players = new Map([
    [
      "p1",
      {
        id: "p1",
        username: "p1",
        status: "ACTIVE" as const,
        resources: 5,
        respawnAtTick: null,
        core: {
          id: P1_CORE,
          position: [0, 0] as const,
          hp: 5,
          shield: 5,
          state: "NORMAL" as const,
          moveDirection: null,
          moveProgress: null,
          moveRequiredTicks: null,
          destination: null,
        },
        units: [],
      },
    ],
  ]);
  return {
    tick: 1,
    resolvedTickCount: 0,
    rulesVersion: "v0.11",
    players,
    terrain: {
      obstacles,
      resources: new Map(),
      piles: new Map(),
    },
    beacon: { position: beaconPosition, status: beaconStatus, carrierId: beaconCarrierId },
    seed: 7,
    rngStreamPosition: 0,
    unsupportedFeatures: [],
    provenance: { scenario: null, sourceCaseHash: null },
  };
}

test("S2 (W47): 合法基线世界通过 validateWorld（无问题）", () => {
  const world = worldFromScenario(baselineScenario());
  const problems = validateWorld(world);
  assert.deepEqual(problems, [], "合法世界无 invariant 问题");
  assert.doesNotThrow(() => assertWorldInvariants(world));
});

test("S2 (W47): [0,0] 障碍 → 违反主干路径不变量", () => {
  // [0,0] 是 Core 主城与所有 chunk backbone 交集，恒须 EMPTY。
  const world = constructWorldDirectly({
    obstacles: [[0, 0]],
    beaconPosition: [2, 2],
  });
  const problems = validateWorld(world);
  assert.ok(
    problems.some((problem) => problem.includes("[0,0]") && problem.includes("backbone")),
    `[0,0] 障碍应触发 backbone 不变量问题，实际：${JSON.stringify(problems)}`,
  );
  assert.throws(
    () => assertWorldInvariants(world),
    WorldInvariantError,
    "assertWorldInvariants 应抛 WorldInvariantError",
  );
});

test("S2 (W47): [0,0] 非障碍 → 不报 backbone 违规（正向）", () => {
  // 障碍在 [1,1]（非 [0,0]）→ backbone 不变量不触发。
  const world = constructWorldDirectly({
    obstacles: [[1, 1]],
    beaconPosition: [2, 2],
  });
  const problems = validateWorld(world);
  assert.ok(
    !problems.some((problem) => problem.includes("backbone")),
    `[1,1] 障碍不应触发 backbone 问题，实际：${JSON.stringify(problems)}`,
  );
});

test("S2 (W47): 信标格为障碍 → 违反信标不被围死不变量", () => {
  // Beacon 在 [2,2]，[2,2] 同时是障碍 → 信标格非障碍不变量触发。
  const world = constructWorldDirectly({
    obstacles: [[2, 2]],
    beaconPosition: [2, 2],
    beaconStatus: "GROUND",
    beaconCarrierId: null,
  });
  const problems = validateWorld(world);
  assert.ok(
    problems.some((problem) => problem.includes("beacon position") && problem.includes("obstacle")),
    `信标格障碍应触发问题，实际：${JSON.stringify(problems)}`,
  );
  assert.throws(
    () => assertWorldInvariants(world),
    WorldInvariantError,
  );
});

test("S2 (W47): 信标格非障碍 → 不报信标违规（正向）", () => {
  // Beacon 在 [2,2]，[3,3] 是障碍（非信标格）→ 信标不变量不触发。
  const world = constructWorldDirectly({
    obstacles: [[3, 3]],
    beaconPosition: [2, 2],
  });
  const problems = validateWorld(world);
  assert.ok(
    !problems.some((problem) => problem.includes("beacon position")),
    `非信标格障碍不应触发信标问题，实际：${JSON.stringify(problems)}`,
  );
});
