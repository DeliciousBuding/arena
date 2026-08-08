/**
 * 数据管线健康测试（2026-08-08）：computeSourceFreshness 数据源新鲜度——
 * 临时数据根下各源文件年龄 + 陈旧标记 + 缺失兜底。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSourceFreshness } from "../lib/pipeline-health.ts";

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
