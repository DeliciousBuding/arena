/**
 * 分工矿兑现校验测试（2026-08-08）：
 * - 状态判定：harvested / harvestedByOther / open / stale；
 * - 汇总：resolvedRate / progressRate / avgTimeToHarvest；
 * - 空数据兜底 + 首采耗时钳制（≥0）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAllocationEffectiveness, type CellHarvestStat } from "../lib/mining-effectiveness.ts";

const H = (ok: number, first: number | null, last: number | null, fail = 0, amount = 0): CellHarvestStat =>
  ({ ok, fail, amount, first, last });

const assign = (cell: string, assignedTenant: string, lastSeenTick: number | null, x = 0, y = 0) => ({
  cell, x, y, assignedTenant, distanceToCore: 5, lastSeenTick,
});

test("mining-effectiveness: 四态判定 + 汇总", () => {
  // currentTick=5000 → 新鲜 cutoff=3000
  const assignments = [
    assign("1,1", "t1", 4800), // t1 采到 → harvested
    assign("2,2", "t2", 4700), // t1 采到（跨租户）→ harvestedByOther
    assign("3,3", "t3", 4500), // 无人采且新鲜 → open
    assign("4,4", "t4", 2500), // 无人采且过时 → stale
  ];
  const harvestByTenantCell: Record<string, Record<string, CellHarvestStat>> = {
    t1: { "1,1": H(2, 4810, 4830), "2,2": H(1, 4690, 4690) },
    t2: {}, t3: {}, t4: {},
  };
  const p = aggregateAllocationEffectiveness(assignments, harvestByTenantCell, 5000);
  const byCell = Object.fromEntries(p.items.map((i) => [i.cell, i]));
  assert.equal(byCell["1,1"].status, "harvested");
  assert.equal(byCell["1,1"].timeToHarvest, 10, "首采 4810 - 末见 4800 = 10");
  assert.equal(byCell["2,2"].status, "harvestedByOther", "t2 分工但 t1 采到");
  assert.equal(byCell["3,3"].status, "open");
  assert.equal(byCell["4,4"].status, "stale");

  assert.equal(p.global.assigned, 4);
  assert.equal(p.global.harvested, 1);
  assert.equal(p.global.harvestedByOther, 1);
  assert.equal(p.global.open, 1);
  assert.equal(p.global.stale, 1);
  // effectiveRate = harvested/(harvested+stale) = 1/2
  assert.equal(p.global.effectiveRate, 0.5);
  // progressRate = harvested/assigned = 1/4
  assert.equal(p.global.progressRate, 0.25);
  // t1: 1/1 closed resolved → 1；t4: stale → 0
  assert.equal(p.perTenant.t1.resolvedRate, 1);
  assert.equal(p.perTenant.t4.resolvedRate, 0);
  assert.equal(p.perTenant.t1.avgTimeToHarvest, 10);
});

test("mining-effectiveness: 空数据 + 首采耗时钳制", () => {
  const a = aggregateAllocationEffectiveness([], {}, null);
  assert.equal(a.items.length, 0);
  assert.equal(a.global.assigned, 0);
  assert.equal(a.global.effectiveRate, null);
  assert.equal(a.global.progressRate, null);

  // 首采早于末见（观测前就采过）→ 钳制为 0，不算负值
  const b = aggregateAllocationEffectiveness(
    [assign("5,5", "t1", 5000)],
    { t1: { "5,5": H(1, 3000, 3000) }, t2: {}, t3: {}, t4: {} },
    5000,
  );
  assert.equal(b.items[0].status, "harvested");
  assert.equal(b.items[0].timeToHarvest, 0);
  assert.equal(b.perTenant.t1.resolvedRate, 1);
});
