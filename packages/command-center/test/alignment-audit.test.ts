/**
 * 决策-分配对齐审计测试（2026-08-08）：
 * - grade：allocation_unfulfilled（分工 0 兑现）/ gap_widening（缺口高但采集占比低）/
 *   aligned / data_gap；
 * - reasons 中文归因 + 全局统计。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAlignment } from "../lib/alignment-audit.ts";

const dec = (harvest: number, move = 10, wait = 5) => ({
  decision: { records: harvest + move + wait, actionMix: { move, harvest, deposit: 0, wait, repair: 0 }, intentTop: [], planChurn: null, stallTicks: 0 },
}) as unknown as import("../lib/decision-audit.ts").DecisionAuditPayload;

test("alignment: 分工未兑现 + 缺口扩大分级", () => {
  const decisions = { t1: dec(5), t2: dec(0) };
  const mines = { t1: { visibleNever: 3 }, t2: { visibleNever: 55 } } as unknown as import("../lib/mine-utilization.ts").MineUtilizationPayload["tenants"];
  const effectiveness = {
    perTenant: {
      t1: { assigned: 3, open: 0, stale: 0, harvested: 3 },
      t2: { assigned: 53, open: 53, stale: 0, harvested: 0 },
    },
  } as unknown as import("../lib/mining-effectiveness.ts").MiningEffectivenessPayload;
  const trends = { t2: { visibleNever: 55, visibleNeverPrev: 13 } };

  const p = aggregateAlignment(decisions, mines, effectiveness, trends, { t1: 3, t2: 12 });
  const t1 = p.tenants.t1;
  assert.equal(t1.grade, "aligned", "已兑现 + 缺口小 → aligned");
  assert.ok(t1.reasons.some((r) => r.includes("采集占比")));
  const t2 = p.tenants.t2;
  assert.equal(t2.grade, "allocation_unfulfilled", "分工 53 全在途 → 未兑现优先");
  assert.ok(t2.reasons.some((r) => r.includes("分工 53 矿 0 兑现")), JSON.stringify(t2.reasons));
  assert.ok(t2.reasons.some((r) => r.includes("缺口较上窗口 +42")), JSON.stringify(t2.reasons));
  assert.ok(t2.reasons.some((r) => r.includes("采集动作占比")), "缺口 55 且采集占比低 → 决策脱节");
  assert.equal(t2.workers, 12);
  assert.ok(t2.reasons.some((r) => r.includes("有 12 个 worker 但采集占比")), "有 worker 不产采集 → 空闲铁证");
  assert.equal(p.global.misaligned, 1);
  assert.equal(p.global.unfulfilledAssignments, 1);
});

test("alignment: data_gap 兜底", () => {
  const p = aggregateAlignment({}, {}, null);
  assert.equal(p.tenants.t1.grade, "data_gap");
  assert.equal(p.global.dataGap, 4);
  assert.equal(p.global.misaligned, 0);
});
