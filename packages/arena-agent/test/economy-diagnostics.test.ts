import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEconomyHealth, type EconomyOutcomeRow } from "../src/intel/economy-diagnostics.ts";

function row(overrides: Partial<EconomyOutcomeRow> = {}): EconomyOutcomeRow {
  return {
    tick: 72_700,
    coreResourcesBefore: 62,
    coreResourcesAfter: 62,
    coreResourceDelta: 0,
    coreState: "NORMAL",
    workersWithCargo: 0,
    events: [],
    ...overrides,
  };
}

function window(rows: Partial<EconomyOutcomeRow>[]): EconomyOutcomeRow[] {
  return rows.map((r, i) => row({ tick: 72_700 + i, ...r }));
}

test("满载持货 + 0 卸货 + 0 delta + 无豁免 → stall + 归因", () => {
  const rows = window(Array.from({ length: 12 }, () => ({
    workersWithCargo: 3,
    coreResourceDelta: 0,
    events: [],
  })));
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "stall");
  assert.equal(report.maxCargoWorkers, 3);
  assert.equal(report.depositSucceeded, 0);
  assert.equal(report.resDeltaSum, 0);
  assert.ok(report.causes.length >= 1, "stall 必须带归因");
});

test("迁移期 0 卸货 → 豁免，不误报 stall", () => {
  const rows = window(Array.from({ length: 12 }, () => ({
    workersWithCargo: 4,
    coreResourceDelta: 0,
    coreState: "MOVING",
    events: ["CORE_MOVING"],
  })));
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "ok");
  assert.ok(report.coreMovingRatio >= 0.9);
  assert.ok(report.causes.some((c) => c.includes("迁移占比")), "迁移过频应给提示归因");
});

test("容量满 0 卸货 → 豁免（CORE_RESOURCE_FULL）", () => {
  const rows = window(Array.from({ length: 12 }, () => ({
    workersWithCargo: 2,
    coreResourceDelta: 0,
    events: ["CORE_RESOURCE_FULL"],
  })));
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "ok");
});

test("正常经济（有 DEPOSIT_SUCCEEDED）→ ok", () => {
  const rows = window(Array.from({ length: 12 }, (_, i) => ({
    workersWithCargo: 1,
    coreResourceDelta: i % 2 === 0 ? 1 : 0,
    events: ["DEPOSIT_SUCCEEDED", "HARVEST_SUCCEEDED"],
  })));
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "ok");
  assert.ok(report.depositSucceeded > 0);
  assert.ok(report.resDeltaSum > 0);
});

test("DEPOSIT_FAILED 归因 + maxDist 外扩归因", () => {
  const rows = window(Array.from({ length: 12 }, (_, i) => ({
    workersWithCargo: 2,
    coreResourceDelta: 0,
    workerMaxDistanceFromCore: 45 + i * 2,
    events: ["DEPOSIT_FAILED", "DEPOSIT_FAILED"],
  })));
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "stall");
  assert.equal(report.depositFailed, 24);
  assert.equal(report.maxDistTrend, "rising");
  assert.ok(report.causes.some((c) => c.includes("DEPOSIT_FAILED")));
  assert.ok(report.causes.some((c) => c.includes("外扩")));
});

test("数据不足（<10 行）→ insufficient_data", () => {
  const rows = window([{ workersWithCargo: 3 }, { workersWithCargo: 3 }]);
  const report = analyzeEconomyHealth(rows, "t1", 60);
  assert.equal(report.verdict, "insufficient_data");
});
