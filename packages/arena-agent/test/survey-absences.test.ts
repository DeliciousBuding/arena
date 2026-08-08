import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cooldownTierForAbsenceCount, knownResourceAbsenceCounts, knownResourceCooldownTiers, openSurveyDb, upsertResources, upsertResourceAbsences } from "../src/intel/survey-db.ts";
import { collectResourceAbsences } from "../src/intel/survey-sync.ts";
import type { DatabaseSync } from "node:sqlite";

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function baseObjects(): Parameters<typeof collectResourceAbsences>[1] {
  return { resources: [], obstacles: [], coreHunts: [], ourCores: [], unitSeen: [] };
}

test("survey-absences: 表结构 + upsert 幂等（重复写不重复计数）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-abs-")); 
  try {
    const db = openSurveyDb(dir, "t1", true);
    const has = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='resource_absences'").get() as { c: number };
    assert.equal(has.c, 1, "resource_absences 表存在");
    const n1 = upsertResourceAbsences(db, [{ cell: "1,1", tick: 100 }, { cell: "2,2", tick: 100 }]);
    assert.equal(n1, 2, "首写 2 行");
    const n2 = upsertResourceAbsences(db, [{ cell: "1,1", tick: 100 }, { cell: "3,3", tick: 200 }]);
    assert.equal(n2, 1, "重复 (1,1,100) 不重复计数，只新增 (3,3)");
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM resource_absences").get() as { c: number };
    assert.equal(cnt.c, 3);
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-absences: 视野覆盖内无矿 → 真实缺席；有矿/遮挡/视野外 → 不缺席", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-abs-vision-")); 
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertResources(db, [
      { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }, { x: 10, y: 10 },
    ], 1000);
    const objects = baseObjects();
    objects.resources = [{ x: 3, y: 0 }];
    objects.obstacles = [{ x: 0, y: 1 }, { x: 0, y: 2 }];
    objects.unitSeen = [{ x: 0, y: 0, unitType: "RANGER", controlled: true, id: "u1" }];
    const rows = collectResourceAbsences(db, objects, 2000);
    const cells = new Set(rows.map((r) => r.cell));
    assert.ok(cells.has("0,0"), "视野内无矿 A 记录缺席");
    assert.ok(!cells.has("3,0"), "视野内可见矿 B 不缺席");
    assert.ok(!cells.has("0,3"), "障碍遮挡 C 不缺席（不可见≠无矿）");
    assert.ok(!cells.has("10,10"), "视野外 D 不缺席（观测中断≠缺席）");
    assert.ok(rows.every((r) => r.tick === 2000), "缺席 tick 正确");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-absences: Core 视野覆盖内无矿 → 缺席（Core 是观察者）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-abs-core-")); 
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertResources(db, [{ x: 10, y: 10 }, { x: 14, y: 10 }, { x: 20, y: 20 }], 1000);
    const objects = baseObjects();
    objects.ourCores = [{ x: 10, y: 10 }];
    const rows = collectResourceAbsences(db, objects, 3000);
    const cells = new Set(rows.map((r) => r.cell));
    assert.ok(cells.has("14,10"), "Core 视野 5 内无矿缺席");
    assert.ok(cells.has("10,10"), "Core 脚下格被覆盖且本 case 无矿 → 缺席");
    assert.ok(!cells.has("20,20"), "Core 视野外不缺席");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("knownResourceAbsenceCounts: 窗口过滤 + 计数正确", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-abs-count-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertResourceAbsences(db, [
      { cell: "1,1", tick: 100 },
      { cell: "1,1", tick: 150 },
      { cell: "1,1", tick: 250 },
      { cell: "2,2", tick: 200 },
      { cell: "2,2", tick: 260 },
    ]);
    const counts = knownResourceAbsenceCounts(db, 200);
    assert.equal(counts.get("1,1"), 1, "tick>200 窗口内 1,1 仅 250 一次");
    assert.equal(counts.get("2,2"), 1, "tick>200 窗口内 2,2 仅 260 一次（200 不计数）");
    const wide = knownResourceAbsenceCounts(db, 0);
    assert.equal(wide.get("1,1"), 3, "全窗口 1,1 缺席 3 次");
    assert.equal(wide.get("2,2"), 2, "全窗口 2,2 缺席 2 次");
    assert.equal(wide.get("3,3"), undefined, "无缺席记录 = undefined（调用方按 0 处理）");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("knownResourceAbsenceCounts: 空表 = 空 Map（seed 过滤零回归）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-abs-empty-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    const counts = knownResourceAbsenceCounts(db, 0);
    assert.equal(counts.size, 0);
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("cooldownTierForAbsenceCount: 缺席次数分级", () => {
  assert.equal(cooldownTierForAbsenceCount(0), 32, "无缺席 = 默认 32");
  assert.equal(cooldownTierForAbsenceCount(127), 32, "<128 = 默认 32");
  assert.equal(cooldownTierForAbsenceCount(128), 96, "≥128 → 96");
  assert.equal(cooldownTierForAbsenceCount(511), 96, "512 前保持 96");
  assert.equal(cooldownTierForAbsenceCount(512), 192, "≥512 → 192");
  assert.equal(cooldownTierForAbsenceCount(2047), 192, "2048 前保持 192");
  assert.equal(cooldownTierForAbsenceCount(2048), 384, "≥2048 → 384");
  assert.equal(cooldownTierForAbsenceCount(10_000), 384, "上限封顶 384");
});

test("knownResourceCooldownTiers: 只返回升级格（≥128 缺席）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-tiers-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertResourceAbsences(db, [
      { cell: "1,1", tick: 100 },   // 缺席 1 次 → 默认
      { cell: "2,2", tick: 100 },
      { cell: "2,2", tick: 200 },
      { cell: "2,2", tick: 300 },
      { cell: "2,2", tick: 400 },   // 4 次仍 <128 → 不入表
    ]);
    // 128 次缺席需要大量行；用循环构造高频格。
    const many: { cell: string; tick: number }[] = [];
    for (let i = 0; i < 200; i += 1) many.push({ cell: "3,3", tick: 1000 + i });
    upsertResourceAbsences(db, many); // 200 次 → 96 档
    const tiers = knownResourceCooldownTiers(db, 0);
    assert.equal(tiers.get("1,1"), undefined, "缺席 1 次不升级");
    assert.equal(tiers.get("2,2"), undefined, "缺席 4 次不升级");
    assert.equal(tiers.get("3,3"), 96, "缺席 200 次 → 96 tick 冷却");
    // 600 次 → 192 档（跨档验证）
    const many2: { cell: string; tick: number }[] = [];
    for (let i = 0; i < 600; i += 1) many2.push({ cell: "4,4", tick: 2000 + i });
    upsertResourceAbsences(db, many2);
    const tiers2 = knownResourceCooldownTiers(db, 0);
    assert.equal(tiers2.get("4,4"), 192, "缺席 600 次 → 192 tick 冷却");
    db.close();
  } finally {
    cleanup(dir);
  }
});
