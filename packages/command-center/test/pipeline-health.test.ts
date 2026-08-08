/**
 * 数据管线健康测试（2026-08-08）：computeSourceFreshness 数据源新鲜度——
 * 临时数据根下各源文件年龄 + 陈旧标记 + 缺失兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSourceFreshness, computeLifecycleFlow, TICK_SECONDS, type PipelineTenantHealth } from "../lib/pipeline-health.ts";

test("pipeline-health: 数据源新鲜度（world/surveyDb/leaderboard/shop/humanAudit）", () => {
  const root = mkdtempSync(join(tmpdir(), "arena-ph-"));
  try {
    // 新鲜 world case
    const t1 = join(root, "runtime", "t1", "calibration", "r1", "cases");
    mkdirSync(t1, { recursive: true });
    writeFileSync(join(t1, "c-1000.json"), "{}");
    // 新鲜 survey-db
    mkdirSync(join(root, "runtime", "survey"), { recursive: true });
    writeFileSync(join(root, "runtime", "survey", "t1.db"), "db");
    // 老 leaderboard 快照（stale）
    mkdirSync(join(root, "leaderboard"), { recursive: true });
    const lb = join(root, "leaderboard", "leaderboard-2026-08-01-00-00-00.json");
    writeFileSync(lb, "{}");
    const old = new Date(Date.now() - 3600_000);
    utimesSync(lb, old, old); // 1 小时前 → stale
    // shop / humanAudit 缺失
    const s = computeSourceFreshness(root);
    const byName = new Map(s.map((x) => [x.name, x]));
    assert.equal(s.length, 5);
    assert.ok((byName.get("world")?.ageSeconds ?? 999) < 60, "world 新鲜");
    assert.equal(byName.get("world")?.stale, false);
    assert.equal(byName.get("surveyDb")?.stale, false);
    assert.equal(byName.get("leaderboard")?.stale, true, "旧快照 stale");
    assert.equal(byName.get("shop")?.detail, "缺失");
    assert.equal(byName.get("humanAudit")?.detail, "缺失");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline-health: 矿生命周期闭环守卫——采集事件 + 负态 → OK", () => {
  const t = (harvest: number, neg: number): PipelineTenantHealth => ({
    tenant: "t1", dbExists: true, dbBytes: 1, syncTick: 1, liveTick: 1, lagTicks: 0, syncedCases: 1,
    counts: { resources: 10, obstacles: 1, cores: 0, unitsSeen: 1, chunks: 1, harvestEvents: harvest, spends: 0, lifecycleUnits: 1, lifecycleNegative: neg, lifecycleStates: null },
    surveyCachedAt: null, health: "OK",
  });
  assert.equal(computeLifecycleFlow([t(10, 3)]), "OK", "有采集事件且负态>0 → 回写生效");
  assert.equal(computeLifecycleFlow([t(10, 0)]), "STALLED", "有采集事件但负态=0 → 静默空跑（--data-root 类回归）");
  assert.equal(computeLifecycleFlow([t(0, 0)]), "NO_DATA", "无采集事件 → 数据不足不算故障");
  assert.equal(computeLifecycleFlow([]), "NO_DATA", "空租户 → NO_DATA");
});

test("pipeline-health: surveyDb detail 双指标（lag tick + 距上次同步秒）", () => {
  const root = mkdtempSync(join(tmpdir(), "arena-ph-lag-"));
  try {
    mkdirSync(join(root, "runtime", "survey"), { recursive: true });
    writeFileSync(join(root, "runtime", "survey", "t1.db"), "db");
    // 带 lag：detail 显示「lag N tick / Ns 前同步」
    const withLag = new Map(computeSourceFreshness(root, 16).map((x) => [x.name, x]));
    assert.match(withLag.get("surveyDb")?.detail ?? "", /^lag 16 tick \/ \d+s 前同步$/, "双指标格式");
    // 不带 lag：兼容旧调用，detail 仍是「Ns」
    const noLag = new Map(computeSourceFreshness(root).map((x) => [x.name, x]));
    assert.match(noLag.get("surveyDb")?.detail ?? "", /^\d+s$/, "无 lag 参数保持旧格式");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline-health: TICK_SECONDS 15s 换算决策数据滞后", () => {
  assert.equal(TICK_SECONDS, 15, "生产 tick 间隔 15s（与 world stale 90s/6 tick 同口径）");
});