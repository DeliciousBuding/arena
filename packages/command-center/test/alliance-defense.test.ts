/**
 * 联盟联防圈兵力协同建议测试（2026-08-08，抱团 Phase 2 决策支持层）：
 * 濒危识别（重生/薄弱+威胁）、驰援推荐（最近军事冗余邻居）、阵型紧凑度。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDefenseCoordination, buildDefensePocketAdvice, buildDefensePockets, directionOf, ENDANGERED_COMBAT_MAX, suggestedRaidForce } from "../lib/alliance-defense.ts";
import type { DefenseMemberInput } from "../lib/alliance-defense.ts";

const member = (over: Partial<DefenseMemberInput> & { tenantId: string }): DefenseMemberInput => ({
  core: [0, 0],
  military: 3,
  status: "READY",
  threatScore: 0,
  ...over,
});

test("alliance-defense: 无濒危 → 仅阵型建议（FORMATION）", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0], military: 4 }),
    member({ tenantId: "t2", core: [50, 0], military: 3 }),
    member({ tenantId: "t3", core: [0, 50], military: 2 }),
  ]);
  assert.equal(p.endangered.length, 0);
  const kinds = p.advice.map((a) => a.category);
  assert.ok(kinds.includes("FORMATION"), "有阵型建议");
  assert.ok(!kinds.includes("ENDANGERED"));
  assert.ok(!kinds.includes("REINFORCE"));
});

test("alliance-defense: 军事薄弱+威胁高 → ENDANGERED + 最近邻居 REINFORCE", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0], military: 4 }),
    member({ tenantId: "t2", core: [300, 0], military: 0, threatScore: 8 }),
    member({ tenantId: "t3", core: [280, 0], military: 5 }), // 距 t2 20 格（最近冗余邻居）
    member({ tenantId: "t4", core: [700, 0], military: 6 }), // 太远不推荐
  ]);
  assert.deepEqual(p.endangered.map((e) => e.tenantId), ["t2"], "t2 濒危");
  const e = p.advice.find((a) => a.category === "ENDANGERED")!;
  assert.ok(e);
  assert.equal(e.severity, "CRITICAL", "零军事+威胁≥6 → CRITICAL");
  assert.ok(e.title.includes("T2"));
  const r = p.advice.find((a) => a.category === "REINFORCE")!;
  assert.ok(r, "有驰援建议");
  assert.equal(r.tenant, "t3", "最近冗余邻居 t3");
  assert.ok(r.relatedTenants.includes("t2"));
  assert.ok(r.detail.includes("20"), "核距 20 格");
  assert.ok(!r.detail.includes("t4"), "t4 太远不推荐");
});

test("alliance-defense: RESPAWNING → CRITICAL 濒危 + 无邻居可救时不推荐", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0], military: 0, status: "RESPAWNING" }),
    member({ tenantId: "t2", core: [900, 0], military: 0, status: "DEGRADED", threatScore: 9 }),
  ]);
  const e = p.advice.find((a) => a.category === "ENDANGERED")!;
  assert.ok(e, "有濒危建议");
  assert.equal(e.severity, "CRITICAL");
  assert.ok(e.title.includes("重生"));
  assert.equal(p.advice.filter((a) => a.category === "REINFORCE").length, 0, "邻居军事不足/太远 → 无驰援");
  assert.equal(p.endangered.length, 2, "t1 重生 + t2 零军事都濒危");
});

test("alliance-defense: 阵型离散 → MEDIUM 建议收缩三角态势", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0] }),
    member({ tenantId: "t2", core: [800, 0] }),
    member({ tenantId: "t3", core: [0, 900] }),
  ]);
  const f = p.advice.find((a) => a.category === "FORMATION")!;
  assert.ok(f);
  assert.equal(f.severity, "MEDIUM", "离散阵型 MEDIUM");
  assert.ok(f.detail.includes("收缩"), "建议收缩三角态势");
});

test("alliance-defense: 阵型紧凑 → INFO", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0] }),
    member({ tenantId: "t2", core: [50, 0] }),
    member({ tenantId: "t3", core: [0, 60] }),
  ]);
  const f = p.advice.find((a) => a.category === "FORMATION")!;
  assert.ok(f);
  assert.equal(f.severity, "INFO", "紧凑阵型 INFO");
  assert.ok(f.detail.includes("响应半径"), "联防响应可接受");
});

test("alliance-defense: 濒危阈值边界——军事=ENDANGERED_COMBAT_MAX 但无威胁 → 不濒危", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t1", core: [0, 0], military: ENDANGERED_COMBAT_MAX, threatScore: 2 }),
    member({ tenantId: "t2", core: [100, 0], military: 4 }),
  ]);
  assert.equal(p.endangered.length, 0, "军事薄弱但威胁低 → 不濒危");
});

test("alliance-defense: 零军事无条件濒危（无兵即无法防御，不能等威胁逼近）", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t3", core: [0, 0], military: 0, threatScore: 0 }),
    member({ tenantId: "t1", core: [50, 0], military: 8 }),
  ]);
  assert.deepEqual(p.endangered.map((e) => e.tenantId), ["t3"], "零军事即使威胁=0 也濒危");
  const e = p.advice.find((a) => a.category === "ENDANGERED")!;
  assert.ok(e.title.includes("零军事"), "标题标零军事");
  assert.equal(e.severity, "HIGH", "威胁=0 → HIGH（非 CRITICAL）");
  const r = p.advice.find((a) => a.category === "REINFORCE")!;
  assert.ok(r, "t1 可驰援 t3");
});

test("alliance-defense: 威胁方位投影——安全侧避开锋面被推荐 / 锋面侧更远不推荐", () => {
  // 坐标系 dy>0=北。t2 濒危（零军事），威胁来自 S（南）；t3 在 t2 北 80（安全侧、
  // 更近），t1 在 t2 南 150（锋面侧、更远）。
  const p = buildDefenseCoordination([
    member({ tenantId: "t2", core: [0, 0], military: 0, threatScore: 8, threatDirections: ["S"] }),
    member({ tenantId: "t3", core: [0, 80], military: 6 }),
    member({ tenantId: "t1", core: [0, -150], military: 6 }),
  ]);
  const rSafe = p.advice.find((a) => a.id === "defense:reinforce:t3:t2");
  assert.ok(rSafe, "安全侧近邻 t3 被推荐");
  assert.ok(rSafe.detail.includes("避开威胁锋面"), "t3 从 N 侧进入避开 S 锋面");
  const rFlank = p.advice.find((a) => a.id === "defense:reinforce:t1:t2");
  assert.ok(!rFlank, "锋面侧远邻 t1 不推荐（更远且危险）");
});

test("alliance-defense: 最近邻居在威胁锋面侧 → 推荐但标注需绕行", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t2", core: [0, 0], military: 0, threatScore: 8, threatDirections: ["S"] }),
    member({ tenantId: "t1", core: [0, -60], military: 6 }), // 南侧锋面，距 60（最近）
    member({ tenantId: "t3", core: [0, 200], military: 6 }), // 北侧安全，距 200
  ]);
  const r = p.advice.find((a) => a.category === "REINFORCE")!;
  assert.equal(r.tenant, "t1", "最近邻居 t1 仍被推荐（距离优先）");
  assert.ok(r.detail.includes("威胁锋面"), "标注位于威胁锋面侧");
  assert.ok(r.detail.includes("绕行"), "建议绕行或先清剿");
});

test("alliance-defense: directionOf 8 向扇区（dy>0=北，与 threat-summary 同构）", () => {
  assert.equal(directionOf([0, 0], [0, -100]), "S");
  assert.equal(directionOf([0, 0], [0, 100]), "N");
  assert.equal(directionOf([0, 0], [100, 0]), "E");
  assert.equal(directionOf([0, 0], [-100, 0]), "W");
  assert.equal(directionOf([0, 0], [100, 100]), "NE");
  assert.equal(directionOf([0, 0], [-100, -100]), "SW");
  assert.equal(directionOf([0, 0], [0, 0]), "C");
});

test("alliance-defense: suggestedRaidForce 编成量化", () => {
  assert.deepEqual(suggestedRaidForce(0, 5), { vanguard: 2, ranger: 0 }, "敌 0 → 至少 2 Vanguard");
  assert.deepEqual(suggestedRaidForce(4, 10), { vanguard: 4, ranger: 2 }, "敌 4 ×1.5=6 → 4V+2R");
  assert.deepEqual(suggestedRaidForce(2, 1), { vanguard: 1, ranger: 0 }, "冗余 1 → 1 单位");
  assert.equal(suggestedRaidForce(2, 0), null, "无冗余 → null");
  assert.equal(suggestedRaidForce(0, 0), null, "零冗余零敌 → null");
});

test("alliance-defense: REINFORCE 建议带编成量化", () => {
  const p = buildDefenseCoordination([
    member({ tenantId: "t2", core: [0, 0], military: 0, threatScore: 8, threatCount: 4 }),
    member({ tenantId: "t1", core: [100, 0], military: 10 }),
  ]);
  const r = p.advice.find((a) => a.category === "REINFORCE")!;
  assert.ok(r, "有驰援建议");
  assert.ok(r.detail.includes("建议编成 4 Vanguard + 2 Ranger"), `detail 含编成: ${r.detail}`);
  const ev = r.evidence.find((e) => e.label === "建议编成");
  assert.ok(ev && ev.value.includes("4V"), "evidence 含编成");
});

test("alliance-defense: POCKET 聚类——敌核群威胁 ≥2 租户 → 联防圈", () => {
  const members = [
    { tenantId: "t1", core: [0, 0] as [number, number] },
    { tenantId: "t2", core: [150, 0] as [number, number] },
    { tenantId: "t3", core: [800, 0] as [number, number] }, // 远，不受威胁
  ];
  const enemyCores = [
    { key: "CORE:alpha", owner: "alpha", position: [60, 0] as [number, number], lastSeenTick: 100 },
    { key: "CORE:beta", owner: "beta", position: [70, 5] as [number, number], lastSeenTick: 100 },
    { key: "CORE:gamma", owner: "gamma", position: [80, -5] as [number, number], lastSeenTick: 100 },
  ];
  const pockets = buildDefensePockets(members, enemyCores);
  assert.equal(pockets.length, 1, "一个联防圈");
  assert.deepEqual([...pockets[0].threatenedTenants].sort(), ["t1", "t2"], "威胁 t1/t2");
  assert.equal(pockets[0].enemyCores.length, 3);
  assert.ok(pockets[0].minDistance <= 60, "最近核距");
  const advice = buildDefensePocketAdvice(members, enemyCores);
  assert.equal(advice.length, 1);
  assert.equal(advice[0].category, "POCKET");
  assert.ok(advice[0].title.includes("T1/T2"), "标题含威胁租户");
  assert.ok(advice[0].detail.includes("协同设防"), "建议协同设防");
});

test("alliance-defense: POCKET 聚类——单敌核或威胁 <2 租户 → 无联防圈", () => {
  const members = [
    { tenantId: "t1", core: [0, 0] as [number, number] },
    { tenantId: "t2", core: [800, 0] as [number, number] },
  ];
  // 单敌核（不构成群）
  const single = buildDefensePockets(members, [
    { key: "CORE:alpha", owner: "alpha", position: [60, 0] as [number, number], lastSeenTick: 100 },
  ]);
  assert.equal(single.length, 0, "单敌核无联防圈");
  // 敌核群但只威胁 1 个租户（t2 太远）
  const far = buildDefensePockets(members, [
    { key: "CORE:alpha", owner: "alpha", position: [60, 0] as [number, number], lastSeenTick: 100 },
    { key: "CORE:beta", owner: "beta", position: [70, 5] as [number, number], lastSeenTick: 100 },
  ]);
  assert.equal(far.length, 0, "威胁 <2 租户无联防圈");
});

test("alliance-defense: POCKET 聚类——敌核群分散不成簇 → 无联防圈", () => {
  const members = [
    { tenantId: "t1", core: [0, 0] as [number, number] },
    { tenantId: "t2", core: [150, 0] as [number, number] },
  ];
  // 两个敌核相距 400 > 120，各自威胁单租户
  const pockets = buildDefensePockets(members, [
    { key: "CORE:alpha", owner: "alpha", position: [60, 0] as [number, number], lastSeenTick: 100 },
    { key: "CORE:beta", owner: "beta", position: [200, 0] as [number, number], lastSeenTick: 100 },
  ]);
  assert.equal(pockets.length, 0, "不成簇且各自单威胁 → 无联防圈");
});