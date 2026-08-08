/**
 * W54 spawn-profile + slot 轮换测试（2026-08-09）：
 *  - rolesFor/profileForRole：角色分配与出生档案（reference 对齐）；
 *  - buildSpawnScenario：场景合法（worldFromScenario + assertWorldInvariants 过）、
 *    单位构成与角色一致、被测者站点轮换（rotatedSlot = (mySlot + seed) % n）；
 *  - NoOpPlanner：返回 emptyPlan（挂机死 Core）；
 *  - rotateTenantsForSlot：循环移位 + id 集合不变（不变量保持）；
 *  - runEpisode rotateSlot=true：跑通且 finalWorldHash 非空（slot 轮换不破世界）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyPlan } from "../src/domain/model.ts";
import {
  buildSpawnScenario,
  findSubjectSlot,
  NoOpPlanner,
  profileForRole,
  rolesFor,
  SPAWN_SITES,
  subjectProfile,
  type SpawnParticipant,
  type SpawnProfile,
} from "../src/sim/opponent/spawn-profile.ts";
import {
  rotateTenantsForSlot,
  runEpisode,
  type EpisodeTenant,
} from "../src/sim/harness/episode.ts";
import { worldFromScenario } from "../src/sim/world/loaders.ts";
import { assertWorldInvariants } from "../src/sim/world/world.ts";
import type { SimWorld } from "../src/sim/world/types.ts";
import type { UnitType } from "../src/domain/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "src", "sim", "contracts", "rules-v0.14.json");

function makeTenants(ids: readonly string[]): EpisodeTenant[] {
  return ids.map((id) => ({
    id,
    planner: "safety" as const,
    plannerConfig: {},
  }));
}

function scenarioPlayers(scenario: unknown): {
  id: string;
  units: { id: string; unitType: UnitType; hp: number }[];
  resources: number;
  core: { id: string; position: readonly [number, number] };
}[] {
  const root = scenario as {
    players: {
      id: string;
      resources: number;
      core: { id: string; position: readonly [number, number] };
      units: { id: string; unitType: UnitType; hp: number }[];
    }[];
  };
  return root.players;
}

test("rolesFor：6 玩家 = 2 老 + 2 挂 + 1 新；8 玩家 = 3 老 + 2 挂 + 2 新", () => {
  const r6 = rolesFor(6);
  assert.equal(r6.length, 5);
  assert.equal(r6.filter((r) => r === "OLD_BALANCED").length, 1);
  assert.equal(r6.filter((r) => r === "OLD_AGGRESSIVE").length, 1);
  assert.equal(r6.filter((r) => r === "STATIC").length, 2);
  assert.equal(r6.filter((r) => r === "NEW_WEAK").length, 1);

  const r8 = rolesFor(8);
  assert.equal(r8.length, 7);
  assert.equal(r8.filter((r) => r === "OLD_BALANCED").length, 1);
  assert.equal(r8.filter((r) => r === "OLD_AGGRESSIVE").length, 2);
  assert.equal(r8.filter((r) => r === "STATIC").length, 2);
  assert.equal(r8.filter((r) => r === "NEW_WEAK").length, 2);
});

test("rolesFor：<2 抛错", () => {
  assert.throws(() => rolesFor(1), /numPlayers must be >= 2/);
});

test("profileForRole：老玩家 7W/6R/6V；挂机 2W；新生弱号无单位", () => {
  const old = profileForRole("OLD_BALANCED", [10, 20]);
  assert.deepEqual(old.units, { WORKER: 7, RANGER: 6, VANGUARD: 6 });
  assert.equal(old.res, 20);

  const agg = profileForRole("OLD_AGGRESSIVE", [10, 20]);
  assert.equal(agg.res, 10);
  assert.deepEqual(agg.units, { WORKER: 7, RANGER: 6, VANGUARD: 6 });

  const stat = profileForRole("STATIC", [10, 20]);
  assert.equal(stat.res, 5);
  assert.deepEqual(stat.units, { WORKER: 2, RANGER: 0, VANGUARD: 0 });

  const weak = profileForRole("NEW_WEAK", [10, 20]);
  assert.equal(weak.res, 5);
  assert.deepEqual(weak.units, {});
});

test("subjectProfile：newborn = 1 Worker + 5 资源（官方起点 v0.14）", () => {
  const subject = subjectProfile([5, 5]);
  assert.equal(subject.res, 5);
  assert.deepEqual(subject.units, { WORKER: 1, RANGER: 0, VANGUARD: 0 });
});

test("NoOpPlanner：返回 emptyPlan(tick)（挂机死 Core，无 coreAction/unitActions）", () => {
  const planner = new NoOpPlanner();
  const plan = planner.decide({
    state: { tick: 42 } as never,
  });
  assert.deepEqual(plan, emptyPlan(42));
  assert.equal(plan.coreAction, null);
  assert.deepEqual(plan.unitActions, {});
  assert.deepEqual(plan.intents, {});
});

test("SPAWN_SITES：8 个站点（reference 校准），坐标均为 safe integer", () => {
  assert.equal(SPAWN_SITES.length, 8);
  for (const site of SPAWN_SITES) {
    assert.equal(Number.isSafeInteger(site[0]), true);
    assert.equal(Number.isSafeInteger(site[1]), true);
  }
});

test("buildSpawnScenario：场景过 worldFromScenario + assertWorldInvariants", () => {
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp-old-balanced-0", role: "OLD_BALANCED" },
    { id: "opp-old-aggressive-1", role: "OLD_AGGRESSIVE" },
    { id: "opp-static-2", role: "STATIC" },
    { id: "opp-static-3", role: "STATIC" },
    { id: "opp-new-weak-4", role: "NEW_WEAK" },
  ];
  const { scenario, rotatedSlot } = buildSpawnScenario(participants, 0, 1);
  assert.equal(rotatedSlot, 1); // (0 + 1) % 6 = 1
  const world: SimWorld = worldFromScenario(scenario);
  assertWorldInvariants(world); // 不抛错 = 全部不变量通过
  assert.equal(world.players.size, 6);
  assert.equal(world.rulesVersion, "v0.14");
});

test("buildSpawnScenario：单位构成与角色一致（老玩家 19 兵 / 挂机 2W / 弱号 0）", () => {
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp-old-balanced-0", role: "OLD_BALANCED" },
    { id: "opp-static-2", role: "STATIC" },
    { id: "opp-new-weak-4", role: "NEW_WEAK" },
  ];
  const { scenario } = buildSpawnScenario(participants, 0, 0);
  const players = scenarioPlayers(scenario);
  assert.equal(players.length, 4);

  const byId = new Map(players.map((p) => [p.id, p]));
  const subject = byId.get("subject")!;
  assert.equal(subject.units.length, 1); // newborn = 1 Worker
  assert.equal(subject.units[0]!.unitType, "WORKER");

  const oldPlayer = byId.get("opp-old-balanced-0")!;
  const byType = countByType(oldPlayer.units);
  assert.equal(byType.WORKER, 7);
  assert.equal(byType.RANGER, 6);
  assert.equal(byType.VANGUARD, 6);
  assert.equal(oldPlayer.resources, 20);

  const staticPlayer = byId.get("opp-static-2")!;
  assert.equal(staticPlayer.units.length, 2);
  assert.equal(staticPlayer.units.every((u) => u.unitType === "WORKER"), true);
  assert.equal(staticPlayer.resources, 5);

  const weak = byId.get("opp-new-weak-4")!;
  assert.equal(weak.units.length, 0);
  assert.equal(weak.resources, 5);
});

test("buildSpawnScenario：所有单位/core id 为 canonical UUID（assertCanonicalUuid 不抛）", () => {
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp-a", role: "OLD_BALANCED" },
    { id: "opp-b", role: "STATIC" },
    { id: "opp-c", role: "NEW_WEAK" },
  ];
  const { scenario } = buildSpawnScenario(participants, 0, 0);
  const players = scenarioPlayers(scenario);
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const player of players) {
    assert.match(player.core.id, uuidRe);
    for (const unit of player.units) assert.match(unit.id, uuidRe);
  }
});

test("buildSpawnScenario：slot 轮换——被测者站点 = (mySlot + seed) % numPlayers", () => {
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp-a", role: "OLD_BALANCED" },
    { id: "opp-b", role: "OLD_AGGRESSIVE" },
    { id: "opp-c", role: "STATIC" },
    { id: "opp-d", role: "STATIC" },
    { id: "opp-e", role: "NEW_WEAK" },
  ];
  // seed=0 → site 0；seed=1 → site 1；...；seed=5 → site 5；seed=6 → site 0
  for (let seed = 0; seed < 12; seed += 1) {
    const { rotatedSlot } = buildSpawnScenario(participants, 0, seed);
    assert.equal(rotatedSlot, seed % 6);
  }
  // 被测者核心位置 = SPAWN_SITES[rotatedSlot]
  for (let seed = 0; seed < 6; seed += 1) {
    const { scenario, rotatedSlot } = buildSpawnScenario(participants, 0, seed);
    const players = scenarioPlayers(scenario);
    const subject = players.find((p) => p.id === "subject")!;
    const expected = SPAWN_SITES[rotatedSlot]!;
    assert.deepEqual([...subject.core.position], [...expected]);
  }
});

test("buildSpawnScenario：mySlot 非 0 时被测者站点仍 = (mySlot + seed) % n", () => {
  const participants: SpawnParticipant[] = [
    { id: "opp-a", role: "OLD_BALANCED" },
    { id: "subject", role: "SUBJECT" }, // mySlot=1
    { id: "opp-b", role: "STATIC" },
    { id: "opp-c", role: "NEW_WEAK" },
  ];
  const mySlot = findSubjectSlot(participants);
  assert.equal(mySlot, 1);
  for (let seed = 0; seed < 4; seed += 1) {
    const { rotatedSlot } = buildSpawnScenario(participants, mySlot, seed);
    assert.equal(rotatedSlot, (1 + seed) % 4);
  }
});

test("buildSpawnScenario：<2 或 >8 抛错；mySlot 越界抛错", () => {
  const one: SpawnParticipant[] = [{ id: "x", role: "SUBJECT" }];
  assert.throws(() => buildSpawnScenario(one, 0, 1), /participants must be 2..8/);
  const nine: SpawnParticipant[] = Array.from({ length: 9 }, (_, i) => ({
    id: `p${i}`,
    role: i === 0 ? "SUBJECT" as const : "STATIC" as const,
  }));
  assert.throws(() => buildSpawnScenario(nine, 0, 1), /participants must be 2..8/);

  const two: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp", role: "STATIC" },
  ];
  assert.throws(() => buildSpawnScenario(two, 5, 1), /mySlot out of range/);
});

test("buildSpawnScenario：participants[mySlot] 非 SUBJECT 抛错", () => {
  const participants: SpawnParticipant[] = [
    { id: "opp-a", role: "OLD_BALANCED" }, // 非 SUBJECT
    { id: "opp-b", role: "STATIC" },
  ];
  assert.throws(() => buildSpawnScenario(participants, 0, 1), /must be SUBJECT/);
});

test("rotateTenantsForSlot：rotate=false 原样返回（零回归）", () => {
  const tenants = makeTenants(["a", "b", "c"]);
  const rotated = rotateTenantsForSlot(tenants, 0, 1, false);
  assert.deepEqual(rotated.map((t) => t.id), ["a", "b", "c"]);
  // 不应 mutate 输入
  assert.deepEqual(tenants.map((t) => t.id), ["a", "b", "c"]);
});

test("rotateTenantsForSlot：被测者（mySlot）移到 rotatedSlot = (mySlot+seed)%n", () => {
  const tenants = makeTenants(["a", "b", "c", "d"]); // 已 id-sorted
  const subjectId = tenants[1]!.id; // mySlot=1 → "b"
  for (let seed = 0; seed < 4; seed += 1) {
    const rotated = rotateTenantsForSlot(tenants, 1, seed, true);
    const expectedSlot = (1 + seed) % 4;
    assert.equal(rotated[expectedSlot]!.id, subjectId, `seed=${seed}`);
  }
});

test("rotateTenantsForSlot：id 集合不变（不变量保持——validateConfig 仍过）", () => {
  const tenants = makeTenants(["a", "b", "c", "d", "e"]);
  for (let seed = 0; seed < 5; seed += 1) {
    const rotated = rotateTenantsForSlot(tenants, 2, seed, true);
    const sorted = [...rotated.map((t) => t.id)].sort();
    assert.deepEqual(sorted, ["a", "b", "c", "d", "e"], `seed=${seed}`);
  }
});

test("rotateTenantsForSlot：mySlot 越界抛错", () => {
  const tenants = makeTenants(["a", "b"]);
  assert.throws(() => rotateTenantsForSlot(tenants, 5, 1, true), /mySlot out of range/);
});

test("runEpisode rotateSlot=true：spawn 场景跑通且世界不变量保持", () => {
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp-old-balanced-0", role: "OLD_BALANCED" },
    { id: "opp-static-2", role: "STATIC" },
    { id: "opp-new-weak-4", role: "NEW_WEAK" },
  ];
  const mySlot = findSubjectSlot(participants);
  const { scenario } = buildSpawnScenario(participants, mySlot, 3);
  const tenants: EpisodeTenant[] = participants.map((p) => ({
    id: p.id,
    planner: "safety" as const,
    plannerConfig: {},
  }));
  // plannerFactory：SUBJECT → NoOp（避免跑真实策略，只验 slot 轮换不破世界）；
  // 对手 → NoOp（全挂机，纯结构验证）
  const factory = (_tenant: EpisodeTenant) => new NoOpPlanner();
  const result = runEpisode({
    scenario,
    rulesPath: MANIFEST_PATH,
    seed: 3,
    ticks: 3,
    tenants,
    plannerFactory: factory,
    rotateSlot: true,
    mySlot,
    validatePlans: false, // NoOp 产 emptyPlan，无需校验
  } as never);
  assert.equal(result.metrics.ticks, 3);
  assert.equal(result.finalWorldHash.length > 0, true);
  // 全员 NoOp → 无事件（emptyPlan 不产事件）；illegalPlans=0
  assert.equal(result.metrics.illegalPlans, 0);
  // 世界不变量在每 tick settlement 内部维护，跑通即不破
  assert.equal(result.finalWorld.players.size, 4);
});

test("runEpisode rotateSlot 缺省 false：零回归（与历史行为一致——不读 mySlot）", () => {
  // 不传 rotateSlot = undefined → 当 false 处理；mySlot 也不读
  const participants: SpawnParticipant[] = [
    { id: "subject", role: "SUBJECT" },
    { id: "opp", role: "STATIC" },
  ];
  const { scenario } = buildSpawnScenario(participants, 0, 1);
  const tenants: EpisodeTenant[] = participants.map((p) => ({
    id: p.id,
    planner: "safety" as const,
    plannerConfig: {},
  }));
  const result = runEpisode({
    scenario,
    rulesPath: MANIFEST_PATH,
    seed: 1,
    ticks: 2,
    tenants,
    plannerFactory: () => new NoOpPlanner(),
    validatePlans: false,
  } as never);
  assert.equal(result.metrics.ticks, 2);
  assert.equal(result.finalWorld.players.size, 2);
});

function countByType(units: { unitType: UnitType }[]): Record<string, number> {
  const out: Record<string, number> = { WORKER: 0, RANGER: 0, VANGUARD: 0 };
  for (const u of units) out[u.unitType] = (out[u.unitType] ?? 0) + 1;
  return out;
}
