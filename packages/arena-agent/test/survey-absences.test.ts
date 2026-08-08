import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSurveyDb, upsertResources, upsertResourceAbsences } from "../src/intel/survey-db.ts";
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
