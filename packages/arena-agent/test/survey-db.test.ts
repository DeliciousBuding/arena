/**
 * 测绘数据库 + 增量同步 + 记忆矿种子测试（2026-08-08，survey-db 联动）：
 * - sqlite 测绘库 upsert/去重/状态累积；
 * - calibration case 物体解析（OBSTACLE/RESOURCE/CORE/UNIT）；
 * - 同步幂等（sync_meta 水位，重复执行只补增量）；
 * - World.seedResourceMemory：seed 恒进 hints（不受新鲜度窗口滤除），
 *   被确认耗尽（NOT_RESOURCE_CELL）后负记忆失效。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  coreSpendsSummary,
  knownObstacles,
  knownResources,
  markResourceState,
  openSurveyDb,
  recordCoreSpend,
  recordResourceEvent,
  recordUnitBirth,
  recordUnitDeath,
  resourceLifecycle,
  touchUnitSeen,
  unitLifecycleRows,
  upsertCoreHunt,
  upsertObstacles,
  upsertResources,
} from "../src/intel/survey-db.ts";
import { parseCaseLifecycle, parseCaseObjects, syncTenantSurvey } from "../src/intel/survey-sync.ts";
import type { TickState } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

function cleanup(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      cleanup(dir);
      return;
    } catch {
      // Windows 下 node:sqlite close 后句柄释放偶发延迟——短暂等待重试
      const end = Date.now() + 200;
      while (Date.now() < end) { /* busy-wait */ }
    }
  }
}
function makeState(tick: number, overrides: Partial<TickState> = {}): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 1,
    core: { id: "core-1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

test("survey-db: resources upsert 去重 + seen_count 累积 + 状态回写", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-db-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertResources(db, [{ x: 1, y: 2 }, { x: 3, y: 4 }], 100);
    upsertResources(db, [{ x: 1, y: 2 }], 101);
    const rows = knownResources(db);
    assert.equal(rows.length, 2, "两格矿去重累积");
    const first = rows.find((r) => r.x === 1 && r.y === 2)!;
    assert.equal(first.seenCount, 2, "seen_count 累积");
    assert.equal(first.lastSeenTick, 101);
    assert.equal(first.state, "visible");
    // 状态回写：标记 harvested → 默认查询排除
    markResourceState(db, "1,2", "harvested", 102);
    const active = knownResources(db);
    assert.equal(active.find((r) => r.x === 1 && r.y === 2), undefined, "harvested 默认排除");
    assert.equal(knownResources(db, { states: ["harvested"] }).length, 1);
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-db: obstacles + core_hunts upsert", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-db-"));
  try {
    const db = openSurveyDb(dir, "t2", true);
    upsertObstacles(db, [{ x: 5, y: 5 }], 10);
    upsertObstacles(db, [{ x: 5, y: 5 }], 11);
    assert.equal(knownObstacles(db).length, 1);
    assert.equal(knownObstacles(db)[0].lastSeenTick, 11);
    upsertCoreHunt(db, { x: -40, y: 20 }, "jerkman", "CORE", 50);
    upsertCoreHunt(db, { x: -40, y: 20 }, null, "CORE", 60);
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-sync: parseCaseObjects 解析四类物体（容错坏 case）", () => {
  const parsed = parseCaseObjects({
    before: {
      state: {
        objects: [
          { kind: "RESOURCE", positions: [[1, 2], [3, 4]] },
          { kind: "OBSTACLE", positions: [[9, 9]] },
          { kind: "CORE", position: [-40, 20], controlled: false, owner_username: "jerkman" },
          { kind: "CORE", position: [0, 0], controlled: true, owner_username: "me" },
          { kind: "UNIT", position: [-35, 22], unit_type: "VANGUARD", controlled: false },
        ],
      },
    },
  });
  assert.equal(parsed!.resources.length, 2);
  assert.equal(parsed!.obstacles.length, 1);
  assert.equal(parsed!.coreHunts.length, 1, "仅敌方 CORE 记录为敌核心基地");
  assert.equal(parsed!.coreHunts[0].owner, "jerkman");
  assert.equal(parsed!.unitSeen.length, 1);
  assert.equal(parseCaseObjects({ before: { state: null } }), null);
  assert.equal(parseCaseObjects(null), null);
});

test("survey-sync: 幂等——重复同步只补增量（sync_meta 水位）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-sync-"));
  try {
    const cal = join(dir, "runtime", "t1", "calibration", "runA", "cases");
    mkdirSync(cal, { recursive: true });
    writeFileSync(join(cal, "0000000100.json"), JSON.stringify({
      before: { state: { objects: [{ kind: "RESOURCE", positions: [[1, 2]] }] } },
    }));
    writeFileSync(join(cal, "0000000101.json"), JSON.stringify({
      before: { state: { objects: [{ kind: "RESOURCE", positions: [[3, 4]] }] } },
    }));
    const s1 = syncTenantSurvey(dir, "t1");
    assert.equal(s1.cases, 2, "首轮同步 2 case");
    const db1 = openSurveyDb(dir, "t1", false); assert.equal(knownResources(db1).length, 2); db1.close();
    // 追加新 case 后重跑 → 只补新增
    writeFileSync(join(cal, "0000000102.json"), JSON.stringify({
      before: { state: { objects: [{ kind: "RESOURCE", positions: [[5, 6]] }] } },
    }));
    const s2 = syncTenantSurvey(dir, "t1");
    assert.equal(s2.cases - s1.cases, 1, "增量只同步新 case（水位差 = 1）");
    const db2 = openSurveyDb(dir, "t1", false); assert.equal(knownResources(db2).length, 3); db2.close();
  } finally {
    cleanup(dir);
  }
});

test("World: seedResourceMemory 恒进 hints（不受新鲜度窗口滤除）", () => {
  const world = new World();
  // 现实：seed 在 tick 0 注入，首个真实 observe 在 68000——若受 maxAge 窗口
  // 限制 seed 永不提示；seeded 标记应让它持续可被记忆矿开采拾取。
  world.seedResourceMemory([[5, 5], [6, 6]], 0);
  world.observe(makeState(68000));
  const hints = world.resourceHints();
  assert.equal(hints.length, 2, "seeded 矿不受 32-tick 新鲜度窗口滤除");
  // 确认耗尽（NOT_RESOURCE_CELL）→ 负记忆失效
  world.observe(makeState(68001, {
    resourceCells: new Set(),
    events: [{
      eventId: "e1", tick: 68001, eventType: "HARVEST_FAILED", reasonCode: "NOT_RESOURCE_CELL",
      actorId: "w1", targetId: null, position: [5, 5], values: {},
    }],
  }));
  const remaining = world.resourceHints();
  assert.equal(remaining.some((p) => p[0] === 5 && p[1] === 5), false, "确认耗尽后不再提示");
  assert.equal(remaining.length, 1);
});





test("survey-db: 生命周期——单位出生/目击/死亡 + 矿采集事件 + 消费记账", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-lc-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    // 单位出生 + 目击 + 死亡
    recordUnitBirth(db, "u1", "WORKER", 100, { x: 1, y: 1 });
    touchUnitSeen(db, "u1", "WORKER", 150, { x: 2, y: 2 });
    recordUnitDeath(db, "u1", 200, { x: 5, y: 5 });
    const rows = unitLifecycleRows(db, { state: "dead" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].birthTick, 100);
    assert.equal(rows[0].deathTick, 200);
    assert.equal(rows[0].lastSeenTick, 150, "死亡后 last_seen 保留最近目击");
    // 矿采集事件 + 消费
    recordResourceEvent(db, "3,3", 120, "HARVEST_SUCCEEDED", null, 1, "u1");
    recordResourceEvent(db, "3,3", 121, "HARVEST_FAILED", "RESOURCE_DEPLETED", null, "u1");
    recordCoreSpend(db, "spawn", 100, 5, "WORKER", "u1");
    recordCoreSpend(db, "core_heal", 150, 3, null, null);
    const spends = coreSpendsSummary(db);
    assert.equal(spends.length, 2);
    const spawn = spends.find((s) => s.kind === "spawn")!;
    assert.equal(spawn.total, 5);
    const lc = resourceLifecycle(db);
    // 资源表没有该矿记录（recordResourceEvent 不建资源行）——事件已落库
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-sync: parseCaseLifecycle 提取出生/死亡/采集/消费", () => {
  const lc = parseCaseLifecycle({
    after: {
      state: {
        events: [
          { event_type: "CORE_SPAWN_SUCCEEDED", target_id: "u1", actor_id: "core1", position: [0, 0], values: { unit_type: "WORKER", cost: 5 } },
          { event_type: "UNIT_DESTROYED", actor_id: "u2", position: [9, 9], values: null },
          { event_type: "HARVEST_SUCCEEDED", actor_id: "u3", position: [3, 3], values: { amount: 1 } },
          { event_type: "HARVEST_FAILED", actor_id: "u3", position: [3, 3], reason_code: "RESOURCE_DEPLETED", values: null },
          { event_type: "CORE_HEAL_SUCCEEDED", actor_id: "core1", position: [0, 0], values: { cost: 3 } },
          { event_type: "UNIT_MOVE_SUCCEEDED", actor_id: "u4", position: [1, 1], values: null },
        ],
      },
    },
  }, 500);
  assert.equal(lc.births.length, 1);
  assert.equal(lc.births[0].unitType, "WORKER");
  assert.equal(lc.deaths.length, 1);
  assert.equal(lc.deaths[0].unitId, "u2");
  assert.equal(lc.harvests.length, 1);
  assert.equal(lc.harvestFails.length, 1);
  assert.equal(lc.harvestFails[0].reason, "RESOURCE_DEPLETED");
  assert.equal(lc.spends.length, 2, "spawn + core_heal 记账");
  assert.equal(lc.spends.find((s) => s.kind === "spawn")!.amount, 5);
});

test("World: seedObstacleMemory 注入障碍记忆（重启后导航直接准确）", () => {
  const world = new World();
  const n = world.seedObstacleMemory([[1, 1], [2, 2], [1, 1]]);
  assert.equal(n, 2, "重复注入去重：只计 1 次");
  const snap = world.snapshot();
  assert.ok(snap.obstacles.includes("1,1") && snap.obstacles.includes("2,2"), "障碍已入记忆");
});
