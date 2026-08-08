/**
 * 联盟联防圈兵力协同建议测试（2026-08-08，抱团 Phase 2 决策支持层）：
 * 濒危识别（重生/薄弱+威胁）、驰援推荐（最近军事冗余邻居）、阵型紧凑度。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDefenseCoordination, ENDANGERED_COMBAT_MAX } from "../lib/alliance-defense.ts";
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
  assert.equal(e.severity, "HIGH");
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
  assert.equal(p.endangered.length, 2, "t2 薄弱+威胁也濒危");
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
