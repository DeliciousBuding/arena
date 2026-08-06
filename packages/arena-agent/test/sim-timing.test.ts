/**
 * S10 结算时序测试（2026-08-07，官方 combat.md 时序语义钉定）：
 * "fatal damage cannot be healed" / "a repaired shield cannot absorb
 * damage from the Tick that just ended" / "a newly spawned Unit cannot
 * be attacked during its birth Tick"——combat(P09) → unit-heal(P10) →
 * core-action(P11) 的顺序正确性（防未来重构破坏相位顺序）。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import type { CoreAction, Plan, UnitAction } from "../src/domain/model.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { settleTick } from "../src/sim/engine/settlement.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.11.json");
const rules = loadRulesManifest(MANIFEST_PATH);
const ctx = { rules, rng: null };

const P1_CORE = "11111111-1111-1111-1111-111111111111";
const P1_VANGUARD = "22222222-2222-2222-2222-222222222222";
const P2_CORE = "44444444-4444-4444-4444-444444444444";
const P2_VANGUARD = "55555555-5555-5555-5555-555555555555";
const P2_VANGUARD2 = "66666666-6666-6666-6666-666666666666";

function planOf(world: { tick: number }, unitActions: Record<string, UnitAction>, coreAction: CoreAction | null = null): Plan {
  return { tick: world.tick, unitActions, coreAction, intents: {} };
}

test("S10 时序：致命伤害不能被同 tick HEAL 救回（官方 fatal damage cannot be healed）", () => {
  // p1 Vanguard[0,0]（Core 格）hp1 + HEAL 请求；p2 Vanguard[1,0] SWEEP LEFT
  // → combat 致命 1 伤移除 v1 → P10 unit-heal 找不到死亡单位 → 不 heal
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P1_VANGUARD, owner: "p1", position: [0, 0], hp: 1, unitType: "VANGUARD", cargo: 0 }],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_VANGUARD, owner: "p2", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, { [P1_VANGUARD]: { type: "HEAL" } })],
      ["p2", planOf(world, { [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" } })],
    ]),
    ctx,
  );
  assert.ok(
    result.events.some((e) => e.eventType === "UNIT_DAMAGED" && e.targetId === P1_VANGUARD && e.values?.hp === 0),
    "combat 致命 1 伤",
  );
  assert.equal(
    result.world.players.get("p1")!.units.some((u) => u.id === P1_VANGUARD),
    false,
    "v1 已死亡（同 tick HEAL 不救回）",
  );
  assert.ok(
    !result.events.some((e) => e.eventType === "UNIT_HEAL_SUCCEEDED" && e.actorId === P1_VANGUARD),
    "无 UNIT_HEAL_SUCCEEDED（死亡单位不 heal）",
  );
});

test("S10 时序：本 tick 修复的护盾不吸收本 tick 伤害（官方 repaired shield cannot absorb）", () => {
  // p1 Core[0,0] shield1 hp1 + REPAIR_SHIELD；p2 双 Vanguard SWEEP Core 格（2 伤）
  // combat 先结算：shield1 吸收 1 → hp1-1=0 → CORE_DESTROYED；若 repair 提前吸收
  // （shield 2）则 Core 存活——断言摧毁证明时序正确
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 1, shield: 1, state: "NORMAL" },
        units: [],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [
          { id: P2_VANGUARD, owner: "p2", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
          { id: P2_VANGUARD2, owner: "p2", position: [-1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
        ],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, {}, { type: "REPAIR_SHIELD" })],
      [
        "p2",
        planOf(world, {
          [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" },
          [P2_VANGUARD2]: { type: "SWEEP", direction: "RIGHT" },
        }),
      ],
    ]),
    ctx,
  );
  assert.ok(
    result.events.some((e) => e.eventType === "CORE_DESTROYED" && e.targetId === P1_CORE),
    "Core 被本 tick 伤害摧毁（repair 不提前吸收）",
  );
});

test("S10 时序：新出生单位在其诞生 tick 不可被攻击（官方 cannot be attacked during birth）", () => {
  // p1 Core[0,0] SPAWN（新单位在 Core 格出生，P11）；p2 Vanguard[1,0] SWEEP [0,0]
  // combat 快照（P09）在 spawn（P11）之前 → 快照无新单位 → 不受伤（Core 仍受 1 伤）
  const world = worldFromScenario({
    rulesVersion: "v0.11",
    tick: 1,
    seed: 7,
    players: [
      {
        id: "p1", username: "p1", resources: 10,
        core: { id: P1_CORE, position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [],
      },
      {
        id: "p2", username: "p2", resources: 10,
        core: { id: P2_CORE, position: [6, 6], hp: 5, shield: 5, state: "NORMAL" },
        units: [{ id: P2_VANGUARD, owner: "p2", position: [1, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
      },
    ],
    terrain: { obstacles: [], resources: [] },
    beacon: null,
  });
  const result = settleTick(
    world,
    new Map([
      ["p1", planOf(world, {}, { type: "SPAWN", unitType: "WORKER" })],
      ["p2", planOf(world, { [P2_VANGUARD]: { type: "SWEEP", direction: "LEFT" } })],
    ]),
    ctx,
  );
  const spawn = result.events.find((e) => e.eventType === "CORE_SPAWN_SUCCEEDED");
  assert.ok(spawn !== undefined, "SPAWN 成功");
  const sweep = result.events.find((e) => e.eventType === "SWEEP_RESOLVED");
  assert.equal(sweep?.values?.targets_hit, 1, "SWEEP 只打中 Core（新单位不在 combat 快照）");
  const newUnit = result.world.players.get("p1")!.units.find((u) => u.id === spawn?.targetId);
  assert.ok(newUnit !== undefined, "新单位存在");
  assert.equal(newUnit.hp, 2, "新单位满血（诞生 tick 未受攻击）");
});
