/**
 * 迁移战术小队 + receive-mode 测试（migration-system-v1 §5.1/§5.2/§5.4，评审 P1）：
 * 退化表逐档精确匹配、sticky assignment 确定性、四角色接敌包络边界、
 * 双 tenant plan 关联（receive 配对）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assignSquadRoles,
  canEngage,
  degradationTable,
  engageEnvelope,
  type EngageParams,
  type RosterUnit,
  type SquadRole,
} from "../src/migration/squads.ts";
import { isReceiveMode, receivePartnerPlan, type PartnerPlanRef } from "../src/migration/receive.ts";

test("退化表：1..6 档编成逐档精确匹配", () => {
  const cases: Array<[number, readonly SquadRole[], Readonly<Partial<Record<SquadRole, number>>>]> = [
    [1, ["ES"], { ES: 1 }],
    [2, ["ES", "SC"], { ES: 1, SC: 1 }],
    [3, ["ES", "SC", "SW"], { ES: 1, SC: 1, SW: 1 }],
    [4, ["ES", "ES", "SC", "SW"], { ES: 2, SC: 1, SW: 1 }],
    [5, ["ES", "ES", "SC", "SW", "RG"], { ES: 2, SC: 1, SW: 1, RG: 1 }],
    [6, ["ES", "ES", "SW", "SW", "SC", "RG"], { ES: 2, SW: 2, SC: 1, RG: 1 }],
  ];
  for (const [count, roles, composition] of cases) {
    const table = degradationTable(count);
    assert.deepEqual([...table.roles], roles, `count=${count} roles`);
    assert.deepEqual(table.composition, composition, `count=${count} composition`);
  }
});

test("退化表：7+ 余量进 ES/SW（按 40:30 配额分配）", () => {
  assert.deepEqual(degradationTable(7).composition, { ES: 3, SW: 2, SC: 1, RG: 1 });
  assert.deepEqual(degradationTable(8).composition, { ES: 3, SW: 3, SC: 1, RG: 1 });
  assert.deepEqual(degradationTable(9).composition, { ES: 4, SW: 3, SC: 1, RG: 1 });
  assert.deepEqual(degradationTable(10).composition, { ES: 4, SW: 4, SC: 1, RG: 1 });
  assert.deepEqual(degradationTable(12).composition, { ES: 5, SW: 5, SC: 1, RG: 1 });
  // roles 顺序与设计表展开一致（ES 组 / SW 组 / SC / RG）
  assert.deepEqual(
    [...degradationTable(7).roles],
    ["ES", "ES", "ES", "SW", "SW", "SC", "RG"],
  );
});

test("退化表：RG 最先削、SC 始终保留；0 档为空编成", () => {
  assert.equal(degradationTable(4).composition.RG, undefined, "4 个单位时 RG 已削");
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { composition } = degradationTable(count);
    if (count >= 2) assert.equal(composition.SC, 1, `count=${count} SC 保留`);
    if (count >= 5) assert.equal(composition.RG, 1, `count=${count} RG 恢复`);
  }
  assert.deepEqual(degradationTable(0), { roles: [], composition: {} });
  assert.deepEqual(degradationTable(-2), { roles: [], composition: {} });
});

test("sticky：同 roster 重复调用结果全同（确定性）", () => {
  const roster: readonly RosterUnit[] = [
    { unitId: "u-1", militaryRank: 3 },
    { unitId: "u-2", militaryRank: 2 },
    { unitId: "u-3" },
    { unitId: "u-4", militaryRank: 1 },
    { unitId: "u-5" },
  ];
  const first = assignSquadRoles(roster, 5, 20260808);
  const second = assignSquadRoles(roster, 5, 20260808);
  assert.deepEqual([...first.entries()], [...second.entries()], "同输入同输出");

  // 编成与退化表 5 档一致
  const composition = new Map<SquadRole, number>();
  for (const role of first.values()) {
    composition.set(role, (composition.get(role) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(composition), { ES: 2, SC: 1, SW: 1, RG: 1 });
});

test("sticky：新增 1 单位后既有单位角色不变", () => {
  const roster5: readonly RosterUnit[] = [
    { unitId: "u-1" },
    { unitId: "u-2" },
    { unitId: "u-3" },
    { unitId: "u-4" },
    { unitId: "u-5" },
  ];
  const assigned5 = assignSquadRoles(roster5, 5, 42);
  const assigned6 = assignSquadRoles([...roster5, { unitId: "u-6" }], 6, 42, assigned5);
  for (const unit of roster5) {
    assert.equal(
      assigned6.get(unit.unitId),
      assigned5.get(unit.unitId),
      `${unit.unitId} 角色保持`,
    );
  }
  // 新单位拿到 6 档新增的 SW 槽位
  assert.equal(assigned6.get("u-6"), "SW");
});

test("sticky：编成不变时新增单位只填空位（3→4，新单位拿第二个 ES）", () => {
  const roster3: readonly RosterUnit[] = [{ unitId: "a" }, { unitId: "b" }, { unitId: "c" }];
  const assigned3 = assignSquadRoles(roster3, 3, 7);
  const assigned4 = assignSquadRoles([...roster3, { unitId: "d" }], 4, 7, assigned3);
  for (const unit of roster3) {
    assert.equal(assigned4.get(unit.unitId), assigned3.get(unit.unitId));
  }
  assert.equal(assigned4.get("d"), "ES");
});

test("sticky：角色被削（RG 在 4 档消失）时仅该单位受影响，其余保持", () => {
  const roster5: readonly RosterUnit[] = [
    { unitId: "a" },
    { unitId: "b" },
    { unitId: "c" },
    { unitId: "d" },
    { unitId: "e" },
  ];
  const assigned5 = assignSquadRoles(roster5, 5, 9);
  const rgUnitId = [...assigned5.entries()].find(([, role]) => role === "RG")?.[0];
  assert.ok(rgUnitId !== undefined, "5 档必有 RG");

  const assigned4 = assignSquadRoles(roster5, 4, 9, assigned5);
  for (const [unitId, role] of assigned5) {
    if (unitId !== rgUnitId) {
      assert.equal(assigned4.get(unitId), role, `${unitId} 保持`);
    }
  }
  // 原 RG 单位失去角色（4 档无 RG 且槽位已被既有编成占满）
  assert.equal(assigned4.has(rgUnitId), false);
  const composition = new Map<SquadRole, number>();
  for (const role of assigned4.values()) {
    composition.set(role, (composition.get(role) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(composition), { ES: 2, SC: 1, SW: 1 });
});

test("sticky：不同 seed 影响新单位填空（多空缺竞争时）", () => {
  // 4 档既有编成（ES2/SC/SW）升 6 档 → 新增 SW/RG 两个空缺，两个新单位竞争
  const roster4: readonly RosterUnit[] = [{ unitId: "a" }, { unitId: "b" }, { unitId: "c" }, { unitId: "d" }];
  const assigned4 = assignSquadRoles(roster4, 4, 11);
  const roster6 = [...roster4, { unitId: "e" }, { unitId: "f" }];

  const rolesPerSeed = new Map<number, Map<string, SquadRole>>();
  for (const seed of [1, 2, 3, 4, 5]) {
    const assigned = assignSquadRoles(roster6, 6, seed, assigned4);
    // 编成不变：两新单位恰好分走 SW/RG；既有单位全部保持
    assert.deepEqual([assigned.get("e"), assigned.get("f")].sort(), ["RG", "SW"], `seed=${seed}`);
    for (const unit of roster4) {
      assert.equal(assigned.get(unit.unitId), assigned4.get(unit.unitId), `seed=${seed}`);
    }
    rolesPerSeed.set(seed, assigned);
  }
  // 至少两种 seed 的填空不同（哈希序不同 → 谁拿 SW/RG 不同）
  const eRoles = new Set([...rolesPerSeed.values()].map((map) => map.get("e")));
  assert.ok(eRoles.size >= 2, "seed 变化应影响新单位填空");
});

test("sticky：无上次角色时全部按 seed 哈希分配，编成仍符合退化表", () => {
  const roster: readonly RosterUnit[] = [{ unitId: "x1" }, { unitId: "x2" }, { unitId: "x3" }, { unitId: "x4" }];
  const maps = [1, 2, 3, 4, 5].map((seed) => assignSquadRoles(roster, 4, seed));
  for (const map of maps) {
    const composition = new Map<SquadRole, number>();
    for (const role of map.values()) {
      composition.set(role, (composition.get(role) ?? 0) + 1);
    }
    assert.deepEqual(Object.fromEntries(composition), { ES: 2, SC: 1, SW: 1 });
  }
  // 不同 seed 至少产生两种不同的角色映射
  const signatures = new Set(
    maps.map((map) => [...map.entries()].map(([id, role]) => `${id}:${role}`).join(",")),
  );
  assert.ok(signatures.size >= 2, "不同 seed 应产生不同分配");
});

function engageParams(overrides: Partial<EngageParams> = {}): EngageParams {
  return {
    targetDistance: 5,
    targetInCorridor: true,
    localForceRatio: 2.0,
    coreDistance: 6,
    moving: false,
    corridorWidth: 8,
    ...overrides,
  };
}

test("接敌包络：SC 任何情况拒绝接战", () => {
  const scenarios: EngageParams[] = [
    engageParams(), // 走廊内、兵力比充足、近距离——依然拒绝
    engageParams({ targetDistance: 2, localForceRatio: 5 }),
    engageParams({ targetInCorridor: false }),
    engageParams({ targetDistance: 30, coreDistance: 30, moving: true }),
  ];
  for (const params of scenarios) {
    const result = canEngage("SC", params);
    assert.equal(result.allow, false);
    assert.match(result.reason ?? "", /不接战|探路/);
  }
});

test("接敌包络：SW 仅走廊内且兵力比达标才接战", () => {
  assert.equal(
    canEngage("SW", engageParams({ targetInCorridor: false, localForceRatio: 3 })).allow,
    false,
    "走廊外拒绝（chase 出走廊 → 放弃）",
  );
  assert.equal(
    canEngage("SW", engageParams({ targetInCorridor: true, localForceRatio: 1.49 })).allow,
    false,
    "兵力比不足拒绝",
  );
  assert.equal(
    canEngage("SW", engageParams({ targetInCorridor: true, localForceRatio: 1.5 })).allow,
    true,
    "等于下限放行",
  );
  assert.equal(canEngage("SW", engageParams({ localForceRatio: 2 })).allow, true);
  // 自定义兵力比下限
  assert.equal(
    canEngage("SW", engageParams({ localForceRatio: 1.5 }), { minForceRatio: 2 }).allow,
    false,
  );
  assert.equal(
    canEngage("SW", engageParams({ localForceRatio: 2 }), { minForceRatio: 2 }).allow,
    true,
  );
});

test("接敌包络：ES 仅核心受威胁时近距响应", () => {
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 20, coreDistance: 6 })).allow,
    false,
    "远距目标不追",
  );
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 4, coreDistance: 9 })).allow,
    false,
    "离核过远不脱环位接战",
  );
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 4, coreDistance: 6, moving: false })).allow,
    true,
    "NORMAL 贴身半径内响应",
  );
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 8, coreDistance: 6, moving: true })).allow,
    true,
    "MOVING 松散环内响应",
  );
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 8, coreDistance: 6, moving: false })).allow,
    false,
    "NORMAL 超出贴身半径",
  );
  assert.equal(
    canEngage("ES", engageParams({ targetDistance: 5, coreDistance: 8, moving: true })).allow,
    true,
    "环外界处仍可近距响应",
  );
});

test("接敌包络：RG 仅尾随带内（≤10）接战顶住", () => {
  assert.equal(canEngage("RG", engageParams({ targetDistance: 10 })).allow, true, "带内放行");
  assert.equal(canEngage("RG", engageParams({ targetDistance: 11 })).allow, false, "带外放弃");
  assert.equal(
    canEngage("RG", engageParams({ targetDistance: 3, localForceRatio: 0.5 })).allow,
    true,
    "兵力劣势也顶住等支援",
  );
});

test("接敌包络：engageEnvelope 返回硬边界常量", () => {
  assert.deepEqual(engageEnvelope("SC", 8), { role: "SC", engages: false, corridorWidth: 8 });
  assert.deepEqual(engageEnvelope("SW", 8), { role: "SW", corridorWidth: 8, minForceRatio: 1.5 });
  const es = engageEnvelope("ES", 8);
  assert.equal(es.role, "ES");
  assert.equal(es.looseRingMin, 5);
  assert.equal(es.looseRingMax, 8);
  assert.equal(es.closeRadius, 4);
  assert.equal(es.protectRadius, 8);
  assert.deepEqual(engageEnvelope("RG", 8), {
    role: "RG",
    corridorWidth: 8,
    trailBand: 10,
    engageRadius: 10,
  });
  // 选项覆写生效
  assert.deepEqual(engageEnvelope("SW", 10, { minForceRatio: 2 }), {
    role: "SW",
    corridorWidth: 10,
    minForceRatio: 2,
  });
  assert.deepEqual(engageEnvelope("ES", 8, { escortLooseRingMax: 10 }).looseRingMax, 10);
});

test("receive：同 operationId 双 plan（migrate + receive）关联成功", () => {
  const plans: readonly PartnerPlanRef[] = [
    { tenant: "t1", operationId: "op-1", mode: "migrate" },
    { tenant: "t2", operationId: "op-1", mode: "receive" },
    { tenant: "t3", operationId: "op-2", mode: "migrate" },
  ];
  assert.deepEqual(receivePartnerPlan("op-1", plans), {
    tenant: "t2",
    operationId: "op-1",
    mode: "receive",
  });
});

test("receive：找不到完整配对 → null（无对应 tenant plan = 零影响）", () => {
  const migrateOnly: readonly PartnerPlanRef[] = [{ tenant: "t1", operationId: "op-1", mode: "migrate" }];
  assert.equal(receivePartnerPlan("op-none", migrateOnly), null, "operationId 无匹配");
  assert.equal(receivePartnerPlan("op-1", migrateOnly), null, "只有一份 migrate");
  assert.equal(
    receivePartnerPlan("op-1", [{ tenant: "t2", operationId: "op-1", mode: "receive" }]),
    null,
    "只有一份 receive",
  );
  assert.equal(
    receivePartnerPlan("op-1", [
      { tenant: "t1", operationId: "op-1", mode: "migrate" },
      { tenant: "t3", operationId: "op-1", mode: "migrate" },
    ]),
    null,
    "两份都是 migrate（无 receive 方）",
  );
  assert.equal(
    receivePartnerPlan("op-1", [
      { tenant: "t1", operationId: "op-1", mode: "receive" },
      { tenant: "t3", operationId: "op-1", mode: "receive" },
    ]),
    null,
    "两份都是 receive（无 migrate 方）",
  );
  assert.equal(
    receivePartnerPlan("op-1", [
      { tenant: "t1", operationId: "op-1", mode: "migrate" },
      { tenant: "t2", operationId: "op-1", mode: "receive" },
      { tenant: "t3", operationId: "op-1", mode: "migrate" },
    ]),
    null,
    "三份同 operationId（超配对，fail-closed）",
  );
  assert.equal(receivePartnerPlan("op-1", []), null, "空列表");
});

test("receive：isReceiveMode 判定", () => {
  assert.equal(isReceiveMode({ mode: "receive" }), true);
  assert.equal(isReceiveMode({ mode: "migrate" }), false);
  assert.equal(isReceiveMode({ mode: "hold" }), false);
  assert.equal(isReceiveMode({ mode: "" }), false);
  assert.equal(isReceiveMode(undefined), false);
});
