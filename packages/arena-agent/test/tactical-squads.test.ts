/** P1 战术小队最小编成测试（2026-08-09，tactical-squads-v1，默认关）。
 *
 * 目标：落一个最小真实小队概念——稳定 squad 身份（HOME_DEFENSE 2V+1R +
 * 多个 STRIKE 2V+1R + MOBILE 余量，复用 local-fleet 合约，跨 tick sticky），
 * 每 squad 独立 rally slot（不同小队不同集结位，杜绝全员共享单一 rally cell），
 * 家防不被借空（home squad 成员绝不流动到 strike/mobile）。默认关闭零回归
 * （关闭时编成为空 + 历史单一集结位行为逐 tick 不变）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cellKey, type Position, type TickState, type VisibleEntity } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import {
  rallyMemberSlot,
  rallyPointAtMemberSlot,
  rallyPointAtSlot,
  rallySlotForSquad,
  reconcileTacticalSquads,
  type SquadMembership,
  type SquadUnit,
} from "../src/strategies/tactical-squads.ts";
import type { CoreHuntTarget } from "../src/domain/world.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner-config.ts";

const TENANT = "t1";

function unit(id: string, unitType: "VANGUARD" | "RANGER", position?: Position): SquadUnit {
  return position === undefined ? { id, unitType } : { id, unitType, position };
}

function sixV3R(): SquadUnit[] {
  return [
    unit("v0", "VANGUARD"), unit("v1", "VANGUARD"), unit("v2", "VANGUARD"),
    unit("v3", "VANGUARD"), unit("v4", "VANGUARD"), unit("v5", "VANGUARD"),
    unit("r0", "RANGER"), unit("r1", "RANGER"), unit("r2", "RANGER"),
  ];
}

function ids(squad: { vanguardIds: readonly string[]; rangerIds: readonly string[] }): string[] {
  return [...squad.vanguardIds, ...squad.rangerIds].sort();
}

// ---------- 纯函数：编成 ----------

test("tactical-squads: 6V+3R → home + 2 strike（3 编队 2V+1R，全部分配一次）", () => {
  const m = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  assert.equal(m.squads.length, 3, `6V+3R 应成 home + 2 strike，实际 ${m.squads.length}`);
  assert.deepEqual(
    m.squads.map((s) => s.role),
    ["HOME_DEFENSE", "STRIKE", "STRIKE"],
  );
  for (const squad of m.squads) {
    assert.equal(squad.vanguardIds.length, 2, `${squad.id} 应 2 Vanguard`);
    assert.equal(squad.rangerIds.length, 1, `${squad.id} 应 1 Ranger`);
  }
  const all = m.squads.flatMap(ids);
  assert.equal(new Set(all).size, 9, "每个单位恰好分配一次");
  assert.ok(m.squads.some((s) => s.id.endsWith(":home:0")), "home id 遵循 local-fleet 命名");
  assert.ok(m.squads.some((s) => s.id.endsWith(":strike:0")), "strike id 遵循 local-fleet 命名");
  assert.ok(m.squads.some((s) => s.id.endsWith(":strike:1")), "第二个 strike id 遵循 local-fleet 命名");
});

test("tactical-squads: 2V+1R 兵力不足 → 仅 home（降级安全，无 strike 裸奔）", () => {
  const m = reconcileTacticalSquads(
    [unit("v0", "VANGUARD"), unit("v1", "VANGUARD"), unit("r0", "RANGER")],
    null, TENANT, { homeAnchor: [0, 0] },
  );
  assert.deepEqual(m.squads.map((s) => s.role), ["HOME_DEFENSE"]);
  assert.deepEqual(ids(m.squads[0]!), ["r0", "v0", "v1"]);
});

test("tactical-squads: 3V → home(2V) + mobile(1V)（local-fleet 结构一致）", () => {
  const m = reconcileTacticalSquads(
    [unit("v0", "VANGUARD"), unit("v1", "VANGUARD"), unit("v2", "VANGUARD")],
    null, TENANT, { homeAnchor: [0, 0] },
  );
  assert.deepEqual(m.squads.map((s) => s.role), ["HOME_DEFENSE", "MOBILE"]);
  assert.deepEqual(ids(m.squads[0]!), ["v0", "v1"]);
  assert.deepEqual(ids(m.squads[1]!), ["v2"]);
});

test("tactical-squads: 确定性——输入顺序无关", () => {
  const a = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  const reversed = [...sixV3R()].reverse();
  const b = reconcileTacticalSquads(reversed, null, TENANT, { homeAnchor: [0, 0] });
  assert.deepEqual(a.squads.map((s) => ({ id: s.id, members: ids(s) })), b.squads.map((s) => ({ id: s.id, members: ids(s) })));
});

test("tactical-squads: sticky——扩军后原 home 成员不流动到 strike", () => {
  const first = reconcileTacticalSquads(
    [unit("v0", "VANGUARD"), unit("v1", "VANGUARD"), unit("r0", "RANGER")],
    null, TENANT, { homeAnchor: [0, 0] },
  );
  assert.deepEqual(first.squads.map((s) => s.role), ["HOME_DEFENSE"]);
  const grown = reconcileTacticalSquads(sixV3R(), first.squadByUnit, TENANT, { homeAnchor: [0, 0] });
  const home = grown.squads.find((s) => s.role === "HOME_DEFENSE")!;
  assert.deepEqual(ids(home), ["r0", "v0", "v1"], "原 2V+1R 应保持 home（sticky）");
  for (const squad of grown.squads) {
    if (squad.role === "HOME_DEFENSE") continue;
    assert.ok(!squad.vanguardIds.includes("v0") && !squad.vanguardIds.includes("v1"), "home 成员绝不借调 strike/mobile");
    assert.ok(!squad.rangerIds.includes("r0"), "home Ranger 绝不借调 strike/mobile");
  }
});

test("tactical-squads: home guard 不被借空——任何兵力下 home 成员不出现在 strike/mobile", () => {
  // 12 单位（8V+4R）：home(2V1R) + 3 strike(2V1R) + mobile(余量 1V)。home 成员恒守家。
  const units = [
    unit("v0", "VANGUARD"), unit("v1", "VANGUARD"), unit("v2", "VANGUARD"), unit("v3", "VANGUARD"),
    unit("v4", "VANGUARD"), unit("v5", "VANGUARD"), unit("v6", "VANGUARD"), unit("v7", "VANGUARD"),
    unit("r0", "RANGER"), unit("r1", "RANGER"), unit("r2", "RANGER"), unit("r3", "RANGER"),
  ];
  const m = reconcileTacticalSquads(units, null, TENANT, { homeAnchor: [0, 0] });
  const home = m.squads.find((s) => s.role === "HOME_DEFENSE")!;
  const homeSet = new Set(ids(home));
  for (const squad of m.squads) {
    if (squad.role === "HOME_DEFENSE") continue;
    for (const id of ids(squad)) assert.ok(!homeSet.has(id), `${id} 是 home 成员却出现在 ${squad.id}`);
  }
  // 每个单位都被归属到某个 squad
  for (const u of units) {
    assert.ok(m.squadByUnit.has(u.id), `${u.id} 未被任何 squad 归属`);
  }
});

test("tactical-squads: 单位死亡后 squad 补员，存活成员身份保持", () => {
  const first = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  const homeFirst = first.squads.find((s) => s.role === "HOME_DEFENSE")!;
  const survived = homeFirst.vanguardIds.filter((id) => id !== "v0");
  const aliveUnits = sixV3R().filter((u) => u.id !== "v0");
  const second = reconcileTacticalSquads(aliveUnits, first.squadByUnit, TENANT, { homeAnchor: [0, 0] });
  const homeSecond = second.squads.find((s) => s.role === "HOME_DEFENSE")!;
  assert.equal(homeSecond.vanguardIds.length, 2, "home 补员回 2V");
  for (const id of survived) {
    assert.ok(homeSecond.vanguardIds.includes(id), `存活的 home 成员 ${id} 应保持守家`);
  }
});

// ---------- 纯函数：rally slot ----------

test("tactical-squads: rallySlotForSquad 不同编队不同 slot（home=0, strike:0=1, strike:1=2）", () => {
  const m = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  const slots = m.squads.map((s) => rallySlotForSquad(s.index));
  assert.equal(new Set(slots).size, slots.length, `slots 应互不相同，实际 ${JSON.stringify(slots)}`);
  const homeIdx = m.squads.find((s) => s.role === "HOME_DEFENSE")!.index;
  const strikeIdx = m.squads.find((s) => s.role === "STRIKE")!.index;
  assert.equal(rallySlotForSquad(homeIdx), 0);
  assert.equal(rallySlotForSquad(strikeIdx), 1);
});

test("tactical-squads: rallyPointAtSlot 不同 slot → 不同集结位；slot=0 = 历史首候选", () => {
  const target: Position = [49, 0];
  const home: Position = [0, 0];
  const obstacles = new Set<string>();
  const resources = new Set<string>();
  const p0 = rallyPointAtSlot(target, home, obstacles, resources, 0);
  const p1 = rallyPointAtSlot(target, home, obstacles, resources, 1);
  const p2 = rallyPointAtSlot(target, home, obstacles, resources, 2);
  assert.notDeepEqual(p1, p0, "slot1 应与 slot0 不同格");
  assert.notDeepEqual(p2, p0, "slot2 应与 slot0 不同格");
  assert.notDeepEqual(p2, p1, "slot1 与 slot2 应互不相同");
  // slot0 = 历史 rallyPoint 语义：距 home 最近的 8 方位候选首个可用格 = [44,0]
  assert.deepEqual(p0, [44, 0]);
});

// ---------- planner 集成：接线边界 ----------

function enemyCore(position: Position): VisibleEntity {
  return { id: "ec", kind: "CORE", position, hp: 5, unitType: "VANGUARD", ownerUsername: "jerkman" };
}

/** 构造战斗状态（vanguardPositions/rangerPositions 决定出发点）。 */
function makeState(
  tick: number,
  vanguardPositions: readonly Position[],
  rangerPositions: readonly Position[] = [],
  enemies: readonly VisibleEntity[] = [],
): TickState {
  const units = [];
  const vanguards = [];
  const rangers = [];
  for (let i = 0; i < vanguardPositions.length; i++) {
    const id = `v${String(i).padStart(2, "0")}`;
    const u = { id, position: [...vanguardPositions[i]] as Position, hp: 4, unitType: "VANGUARD" as const, cargo: 0 };
    units.push(u);
    vanguards.push(u);
  }
  for (let i = 0; i < rangerPositions.length; i++) {
    const id = `r${String(i).padStart(2, "0")}`;
    const u = { id, position: [...rangerPositions[i]] as Position, hp: 4, unitType: "RANGER" as const, cargo: 0 };
    units.push(u);
    rangers.push(u);
  }
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: units.length,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units,
    workers: [],
    vanguards,
    rangers,
    visibleEnemies: enemies,
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const PRESSURE_POLICY = {
  posture: "aggressive" as const,
  workerTarget: 6,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: "core" as const,
};

function squadConfig(overrides: Partial<SafetyPlannerConfig> = {}): SafetyPlannerConfig {
  return {
    ...DEFAULT_SAFETY_CONFIG,
    aggression: "aggressive",
    attackForce: 2,
    rallyAssault: true,
    militaryHunt: true,
    boundedRaid: true,
    enemyCoreMemoryTicks: 1200,
    ...overrides,
  } as SafetyPlannerConfig;
}

function seedCore(planner: SafetyPlanner): void {
  const targets: readonly CoreHuntTarget[] = [
    { position: [49, 0], lastSeenTick: 1, source: "CORE", owner: "jerkman" },
  ];
  planner.seedCoreHuntTargets(targets);
  planner.decide({ state: makeState(1, [], [], [enemyCore([49, 0])]), policy: PRESSURE_POLICY });
}

const HOME_SIDE: readonly Position[] = [
  [5, 0], [5, 1], [5, -1], [4, 0], [4, 1], [4, -1],
];

test("tactical-squads-v1 默认关：snapshot 空 + rally 历史单一集结位（零回归）", () => {
  const planner = new SafetyPlanner(squadConfig());
  seedCore(planner);
  assert.deepEqual(planner.tacticalSquadSnapshot(), [], "默认关闭应无编成");
  const plan = planner.decide({ state: makeState(2, HOME_SIDE), policy: PRESSURE_POLICY });
  const intents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    intents.length === 6 && intents.every((i) => i === "vanguard_rally"),
    `默认关应保持历史 rally 行为，实际 intents=${JSON.stringify(intents)}`,
  );
});

test("tactical-squads-v1 开启 + rally-assault：不同 squad 集结位不同（不复用单一 rally cell）", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  const plan = planner.decide({ state: makeState(2, HOME_SIDE, [[5, 2], [5, 3], [4, 2]]), policy: PRESSURE_POLICY });
  const snapshot = planner.tacticalSquadSnapshot();
  assert.equal(snapshot.length, 3, `6V+3R 应成 3 编队，实际 ${snapshot.length}`);
  const strikes = snapshot.filter((s) => s.role === "STRIKE");
  assert.equal(strikes.length, 2, "应有两个 strike 小队");
  // 不同 strike 小队 → 不同 rally slot → 不同集结位
  const home: Position = [0, 0];
  const target: Position = [49, 0];
  const points = strikes.map((s) => rallyPointAtSlot(target, home, new Set(), new Set(), rallySlotForSquad(s.index)));
  assert.equal(new Set(points.map((p) => p.join(","))).size, points.length, "strike 小队集结位应互不相同");
  // home squad 成员守家，不参与 rally
  const homeSquad = snapshot.find((s) => s.role === "HOME_DEFENSE")!;
  for (const id of homeSquad.vanguardIds) {
    assert.equal(plan.intents[id], "vanguard_home_guard", `${id} home Vanguard 应守家`);
  }
  for (const id of homeSquad.rangerIds) {
    assert.equal(plan.intents[id], "ranger_home_guard", `${id} home Ranger 应守家`);
  }
  // 非 home 成员全部 rally（wiring 生效：走 squad slot 集结位而非全局单点）
  for (const strike of strikes) {
    for (const id of [...strike.vanguardIds, ...strike.rangerIds]) {
      const intent = plan.intents[id] ?? "";
      assert.ok(intent === "vanguard_rally" || intent === "ranger_rally", `${id} 应 rally，实际 ${intent}`);
    }
  }
});

test("tactical-squads-v1：跨 tick 输入顺序变化 → 编成快照稳定", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  const orderA = [...HOME_SIDE];
  const orderB = [...HOME_SIDE].reverse();
  planner.decide({ state: makeState(2, orderA, [[5, 2], [5, 3], [4, 2]]), policy: PRESSURE_POLICY });
  const snapA = planner.tacticalSquadSnapshot();
  planner.decide({ state: makeState(3, orderB, [[4, 2], [5, 3], [5, 2]]), policy: PRESSURE_POLICY });
  const snapB = planner.tacticalSquadSnapshot();
  assert.deepEqual(
    snapB.map((s) => ({ id: s.id, role: s.role, members: [...s.vanguardIds, ...s.rangerIds].sort() })),
    snapA.map((s) => ({ id: s.id, role: s.role, members: [...s.vanguardIds, ...s.rangerIds].sort() })),
    "输入顺序变化不应改变 squad 编成",
  );
});

test("tactical-squads-v1：home guard 不被借空——扩军后原 home 成员恒守家", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  // tick2：2V+1R 全守家
  planner.decide({ state: makeState(2, [[5, 0], [5, 1]], [[4, 0]]), policy: PRESSURE_POLICY });
  const firstHome = planner.tacticalSquadSnapshot().find((s) => s.role === "HOME_DEFENSE")!;
  const firstHomeIds = new Set([...firstHome.vanguardIds, ...firstHome.rangerIds]);
  assert.equal(firstHomeIds.size, 3, "2V+1R 应全 home");
  // tick3：扩军 6V+3R → 原 home 成员不被借空
  planner.decide({ state: makeState(3, HOME_SIDE, [[5, 2], [5, 3], [4, 2]]), policy: PRESSURE_POLICY });
  const snapshot = planner.tacticalSquadSnapshot();
  const home = snapshot.find((s) => s.role === "HOME_DEFENSE")!;
  const homeIds = new Set([...home.vanguardIds, ...home.rangerIds]);
  for (const id of firstHomeIds) {
    assert.ok(homeIds.has(id), `原 home 成员 ${id} 应保持守家`);
  }
  for (const squad of snapshot) {
    if (squad.role === "HOME_DEFENSE") continue;
    for (const id of [...squad.vanguardIds, ...squad.rangerIds]) {
      assert.ok(!firstHomeIds.has(id), `home 成员 ${id} 被借调到 ${squad.id}`);
    }
  }
});

// ---------- planner 集成：热载关闭生命周期 ----------

test("tactical-squads-v1 热载关闭：updateConfig 后 snapshot 立即清空，下一 decide 仍空", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  // 开启形成 squad
  planner.decide({ state: makeState(2, HOME_SIDE, [[5, 2], [5, 3], [4, 2]]), policy: PRESSURE_POLICY });
  assert.equal(planner.tacticalSquadSnapshot().length, 3, "开启时应已形成 3 编队");
  // 热载关闭（tacticalSquads 缺省 = 未开）
  planner.updateConfig(squadConfig());
  assert.deepEqual(planner.tacticalSquadSnapshot(), [], "updateConfig 关闭后 snapshot 应立即为空");
  // 下一 decide 仍为空（关闭态不重建、不残留旧代）
  const plan = planner.decide({ state: makeState(3, HOME_SIDE, [[5, 2], [5, 3], [4, 2]]), policy: PRESSURE_POLICY });
  assert.deepEqual(planner.tacticalSquadSnapshot(), [], "关闭后下一 decide 仍无编成");
  // 关闭态回落历史 rally 单一集结位行为（零回归）
  const intents = Object.entries(plan.intents ?? {})
    .filter(([id]) => id.startsWith("v"))
    .map(([, intent]) => intent);
  assert.ok(
    intents.length === 6 && intents.every((i) => i === "vanguard_rally"),
    `关闭后应保持历史 rally 行为，实际 ${JSON.stringify(intents)}`,
  );
});

test("tactical-squads-v1：关闭后再开启 → 按当前 units 重建（不继承关闭前代际）", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  // tick2：形成 home(2V+1R)——v00/v01/r00（距锚点 [0,0] 最近）
  planner.decide({ state: makeState(2, [[1, 0], [1, 1]], [[1, -1]]), policy: PRESSURE_POLICY });
  const firstHome = planner.tacticalSquadSnapshot().find((s) => s.role === "HOME_DEFENSE")!;
  const staleHome = new Set([...firstHome.vanguardIds, ...firstHome.rangerIds]);
  assert.equal(staleHome.size, 3, "2V+1R 应全 home");
  assert.ok(staleHome.has("v00") && staleHome.has("v01") && staleHome.has("r00"), "home 应为 v00/v01/r00");
  // tick3：热载关闭 → snapshot 立即空，decide 后仍空
  planner.updateConfig(squadConfig());
  assert.deepEqual(planner.tacticalSquadSnapshot(), [], "updateConfig 关闭后 snapshot 应立即为空");
  planner.decide({ state: makeState(3, [[1, 0], [1, 1]], [[1, -1]]), policy: PRESSURE_POLICY });
  assert.deepEqual(planner.tacticalSquadSnapshot(), [], "关闭态 decide 不重建");
  // tick4：re-enable，原 home 成员 v01 已远离锚点（位置索引 1 = [49,0] 前压），且扩军
  planner.updateConfig(squadConfig({ tacticalSquads: true }));
  planner.decide({
    state: makeState(4, [[1, 1], [49, 0], [1, 0], [2, 0], [2, 1], [2, -1]], [[1, -1], [2, 2], [2, -2]]),
    policy: PRESSURE_POLICY,
  });
  const rebuilt = planner.tacticalSquadSnapshot();
  assert.ok(rebuilt.length >= 1, "re-enable 后应重建编成");
  const rebuiltHome = rebuilt.find((s) => s.role === "HOME_DEFENSE")!;
  const rebuiltHomeIds = new Set([...rebuiltHome.vanguardIds, ...rebuiltHome.rangerIds]);
  assert.ok(
    !rebuiltHomeIds.has("v01"),
    "远离锚点的 v01 不应因关闭前 sticky 留在 home（不继承关闭代际）",
  );
  // 重建完整性：每个单位恰好归属一次
  const allIds = rebuilt.flatMap((s) => [...s.vanguardIds, ...s.rangerIds]);
  assert.equal(new Set(allIds).size, allIds.length, "重建编成无重复单位");
  assert.equal(allIds.length, 9, "6V+3R 应全部分配");
});

// ---------- P1 战术小队：rally member slot（tactical-squad-rally-v1） ----------

test("tactical-squads: rallyMemberSlot 8 squad × 3 成员 slot 全唯一（24 不碰撞）", () => {
  const slots = new Set<number>();
  for (let s = 0; s < 8; s++) {
    for (let m = 0; m < 3; m++) slots.add(rallyMemberSlot(s, m));
  }
  assert.equal(slots.size, 24, `8×3 成员 slot 应全唯一，实际 ${slots.size}`);
  // 同 squad 成员连续（3i, 3i+1, 3i+2）
  assert.deepEqual(
    [rallyMemberSlot(1, 0), rallyMemberSlot(1, 1), rallyMemberSlot(1, 2)],
    [3, 4, 5],
  );
  // 第 9 个 squad 起取模回绕（超常规模，fail-safe）
  assert.equal(rallyMemberSlot(8, 0), rallyMemberSlot(0, 0));
});

test("tactical-squads: rallyPointAtMemberSlot 同 squad 成员不同格 / 跨 squad 不共用单格", () => {
  const target: Position = [49, 0];
  const home: Position = [0, 0];
  const obstacles = new Set<string>();
  const resources = new Set<string>();
  const m = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  const strikes = m.squads.filter((s) => s.role === "STRIKE");
  assert.equal(strikes.length, 2, "6V+3R 应有两个 strike 小队");
  const cells: string[] = [];
  for (const squad of strikes) {
    const members = [...squad.vanguardIds, ...squad.rangerIds];
    members.forEach((id, mi) => {
      const p = rallyPointAtMemberSlot(target, home, obstacles, resources, rallyMemberSlot(squad.index, mi));
      cells.push(`${squad.id}#${id}@${p.join(",")}`);
    });
  }
  const cellSet = new Set(cells.map((c) => c.split("@")[1]!));
  assert.equal(
    cellSet.size,
    cells.length,
    `两个 strike squad 6 成员集结位应全互异（不共用单格），实际 ${JSON.stringify(cells)}`,
  );
});

test("tactical-squads: rallyPointAtMemberSlot 障碍/资源 fail-safe（跳过占用格，全堵回退敌核）", () => {
  const target: Position = [49, 0];
  const home: Position = [0, 0];
  // squad index 1 成员 slot 3 → 名义格 [54,0]
  const slot = rallyMemberSlot(1, 0);
  assert.equal(slot, 3);
  const blocked = new Set([cellKey([54, 0])]);
  const p = rallyPointAtMemberSlot(target, home, blocked, new Set(), slot);
  assert.notDeepEqual(p, [54, 0], "成员集结位被占时应跳过占用格");
  assert.ok(!blocked.has(cellKey(p)), `返回格不应是障碍格，实际 ${JSON.stringify(p)}`);
  // 全堵 → 回退敌核格
  const ring0: Position[] = [[44, 0], [44, 5], [44, -5], [54, 0], [49, 5], [49, -5], [54, 5], [54, -5]];
  const allBlocked = new Set(ring0.map((c) => cellKey(c)));
  const fallback = rallyPointAtMemberSlot(target, home, allBlocked, new Set(), slot);
  assert.deepEqual(fallback, target, "8 方位全堵应回退敌核格");
});

test("tactical-squads: rally member slot 输入顺序无关（成员序号稳定）", () => {
  const a = reconcileTacticalSquads(sixV3R(), null, TENANT, { homeAnchor: [0, 0] });
  const b = reconcileTacticalSquads([...sixV3R()].reverse(), null, TENANT, { homeAnchor: [0, 0] });
  const slotsOf = (mem: SquadMembership) =>
    mem.squads.map((s) => ({
      id: s.id,
      slots: [...s.vanguardIds, ...s.rangerIds].map((_, mi) => rallyMemberSlot(s.index, mi)),
    }));
  assert.deepEqual(slotsOf(b), slotsOf(a), "输入顺序变化不应改变成员 slot 分配");
});

// ---------- P1 战术小队：per-squad rally gate（tactical-squad-rally-v1） ----------

test("tactical-squads-v1：一个 squad 到齐不放行另一个（strike:0 到齐压上，strike:1 继续集结）", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  // strike:0（v02/v03/r01）全员已在集结区 [44,0]（dist 5 ≤ 5+2）；strike:1（v04/v05/r02）仍在赶路。
  const plan = planner.decide({
    state: makeState(2, [[5, 0], [5, 1], [44, 0], [44, 0], [20, 0], [20, 1]], [[5, 2], [44, 0], [20, 2]]),
    policy: PRESSURE_POLICY,
  });
  assert.equal(plan.intents["v02"], "vanguard_pressure_memory", `strike:0 到齐应压上，实际=${plan.intents["v02"]}`);
  assert.equal(plan.intents["v03"], "vanguard_pressure_memory", `strike:0 到齐应压上，实际=${plan.intents["v03"]}`);
  assert.equal(plan.intents["r01"], "ranger_move", `strike:0 Ranger 到齐应前压，实际=${plan.intents["r01"]}`);
  assert.equal(plan.intents["v04"], "vanguard_rally", `strike:1 未到齐应继续集结，实际=${plan.intents["v04"]}`);
  assert.equal(plan.intents["v05"], "vanguard_rally", `strike:1 未到齐应继续集结，实际=${plan.intents["v05"]}`);
  assert.equal(plan.intents["r02"], "ranger_rally", `strike:1 Ranger 未到齐应继续集结，实际=${plan.intents["r02"]}`);
});

test("tactical-squads-v1：各 squad timeout 独立（strike:0 超时压上，strike:1 首到晚 20 tick 仍在集结）", () => {
  const planner = new SafetyPlanner(squadConfig({ tacticalSquads: true }));
  seedCore(planner);
  const baseV: Position[] = [[5, 0], [5, 1], [44, 0], [5, 2], [20, 0], [20, 1]];
  const baseR: Position[] = [[5, 3], [5, 4], [20, 2]];
  // tick2：strike:0 的 v02 首到集结区（firstArriveTick=2）；strike:1 无人到。
  planner.decide({ state: makeState(2, baseV, baseR), policy: PRESSURE_POLICY });
  // tick22：strike:1 的 v04 才首到（firstArriveTick=22）。
  const tick22V: Position[] = [...baseV];
  tick22V[4] = [44, 0];
  planner.decide({ state: makeState(22, tick22V, baseR), policy: PRESSURE_POLICY });
  // tick42：strike:0 首到 40 tick 超时 → 压上；strike:1 首到仅 20 tick → 仍集结。
  const plan = planner.decide({ state: makeState(42, tick22V, baseR), policy: PRESSURE_POLICY });
  assert.equal(plan.intents["v02"], "vanguard_pressure_memory", `strike:0 超时应压上，实际=${plan.intents["v02"]}`);
  assert.equal(plan.intents["v03"], "vanguard_pressure_memory", `strike:0 超时应压上，实际=${plan.intents["v03"]}`);
  assert.equal(plan.intents["r01"], "ranger_move", `strike:0 Ranger 超时应前压，实际=${plan.intents["r01"]}`);
  assert.equal(plan.intents["v04"], "vanguard_rally", `strike:1 未超时应继续集结，实际=${plan.intents["v04"]}`);
  assert.equal(plan.intents["v05"], "vanguard_rally", `strike:1 未超时应继续集结，实际=${plan.intents["v05"]}`);
  assert.equal(plan.intents["r02"], "ranger_rally", `strike:1 Ranger 未超时应继续集结，实际=${plan.intents["r02"]}`);
});
