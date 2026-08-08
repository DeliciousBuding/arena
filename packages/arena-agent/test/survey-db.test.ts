/**
 * 测绘数据库 + 增量同步 + 记忆矿种子测试（2026-08-08，survey-db 联动）：
 * - sqlite 测绘库 upsert/去重/状态累积；
 * - calibration case 物体解析（OBSTACLE/RESOURCE/CORE/UNIT）；
 * - 同步幂等（sync_meta 水位，重复执行只补增量）；
 * - World.seedResourceMemory：seed 恒进 hints（不受新鲜度窗口滤除），
 *   被确认耗尽（NOT_RESOURCE_CELL）后负记忆失效。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  coreSpendsSummary,
  knownChunks,
  knownObstacles,
  knownResources,
  markResourceState,
  openSurveyDb,
  recordCoreSpend,
  recordResourceEvent,
  recordUnitBirth,
  recordUnitDeath,
  resourceLifecycle,
  syncMeta,
  touchUnitSeen,
  unitLifecycleRows,
  upsertChunk,
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

test("survey-sync: latestRunOnly 按目录 mtime 选最新 run（UUID 字典序 ≠ 时间序 bug）", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-sync-latest-"));
  try {
    const calBase = join(dir, "runtime", "t1", "calibration");
    // 旧实现 runDirs.sort() 取字符串最后（z-run），会跳过 mtime 最新的 a-run
    // （其 case tick 更高）→ survey-db 滞后。修复：按目录 mtime 选最新。
    for (const [run, tick, mtimeMs] of [
      ["a-run", 200, 2_000_000],
      ["z-run", 100, 1_000_000],
    ] as const) {
      const casesDir = join(calBase, run, "cases");
      mkdirSync(casesDir, { recursive: true });
      writeFileSync(join(casesDir, `0000000${tick}.json`), JSON.stringify({
        before: { state: { objects: [{ kind: "RESOURCE", positions: [[1, 2]] }] } },
      }));
      const runDir = join(calBase, run);
      const t = new Date(mtimeMs);
      utimesSync(runDir, t, t);
    }
    const s = syncTenantSurvey(dir, "t1", { latestRunOnly: true });
    assert.equal(s.cases, 1, "latestRunOnly 只同步最新 run");
    const db = openSurveyDb(dir, "t1", false);
    assert.equal(syncMeta(db, "a-run")?.lastTick, 200, "选中 mtime 最新的 a-run（tick 200）");
    assert.equal(syncMeta(db, "z-run"), null, "旧 run z-run 不被 latestRunOnly 同步");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("survey-sync: 矿生命周期状态回写——采集/耗尽事件 → harvested/empty，refill 恢复 visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-sync-lifecycle-"));
  try {
    const cal = join(dir, "runtime", "t1", "calibration", "runA", "cases");
    mkdirSync(cal, { recursive: true });
    // t100：矿可见（基础测绘）
    writeFileSync(join(cal, "0000000100.json"), JSON.stringify({
      before: { state: { objects: [{ kind: "RESOURCE", positions: [[1, 2]] }] } },
      after: { state: { events: [] } },
    }));
    // t101：矿被采（HARVEST_SUCCEEDED → harvested）
    writeFileSync(join(cal, "0000000101.json"), JSON.stringify({
      before: { state: { objects: [] } },
      after: { state: { events: [{ event_type: "HARVEST_SUCCEEDED", position: [1, 2], actor_id: "w1", values: { amount: 1 } }] } },
    }));
    // t102：他人采空（HARVEST_FAILED RESOURCE_DEPLETED → empty）
    writeFileSync(join(cal, "0000000102.json"), JSON.stringify({
      before: { state: { objects: [] } },
      after: { state: { events: [{ event_type: "HARVEST_FAILED", position: [1, 2], actor_id: "w2", reason_code: "RESOURCE_DEPLETED" }] } },
    }));
    syncTenantSurvey(dir, "t1");
    let db = openSurveyDb(dir, "t1", false);
    const row = knownResources(db, { states: ["harvested", "empty"] }).find((r) => r.x === 1 && r.y === 2);
    assert.ok(row, "采空矿进入 harvested/empty 集合");
    assert.ok(["harvested", "empty"].includes(row!.state), `状态为负态（实际 ${row!.state}）`);
    assert.equal(knownResources(db, { states: ["visible"] }).find((r) => r.x === 1 && r.y === 2), undefined, "负态矿默认不按 visible 返回");
    // t103：refill 后矿重新可见 → upsertResources 恢复 visible（生命周期闭环）
    writeFileSync(join(cal, "0000000103.json"), JSON.stringify({
      before: { state: { objects: [{ kind: "RESOURCE", positions: [[1, 2]] }] } },
      after: { state: { events: [] } },
    }));
    syncTenantSurvey(dir, "t1");
    db.close();
    db = openSurveyDb(dir, "t1", false);
    const revived = knownResources(db).find((r) => r.x === 1 && r.y === 2);
    assert.equal(revived?.state, "visible", "refill 后恢复 visible（发现→采→空→refill 闭环）");
    db.close();
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

test("survey-db: 探索分区——upsertChunk 只进不退 + knownChunks 过滤", () => {
  const dir = mkdtempSync(join(tmpdir(), "survey-chunk-"));
  try {
    const db = openSurveyDb(dir, "t1", true);
    upsertChunk(db, "-39,-10", 100);
    upsertChunk(db, "-39,-10", 50);
    upsertChunk(db, "-39,-10", 200);
    upsertChunk(db, "0,0", 150);
    const all = knownChunks(db, 0);
    assert.equal(all.length, 2, "两个 chunk");
    const c1 = all.find((c) => c.key === "-39,-10")!;
    assert.equal(c1.lastSeenTick, 200, "MAX 语义：只进不退");
    const recent = knownChunks(db, 160);
    assert.equal(recent.length, 1, "按最后探索 tick 过滤");
    assert.equal(recent[0].key, "-39,-10");
    db.close();
  } finally {
    cleanup(dir);
  }
});

test("World: seedChunkMemory 注入探索分区（跨重启 Fog 记忆）", () => {
  const world = new World();
  const n = world.seedChunkMemory([{ key: "-39,-10", lastSeenTick: 100 }, { key: "0,0", lastSeenTick: 50 }]);
  assert.equal(n, 2);
  // 更新鲜的覆盖，更旧的不覆盖
  const n2 = world.seedChunkMemory([{ key: "-39,-10", lastSeenTick: 80 }, { key: "0,0", lastSeenTick: 90 }]);
  assert.equal(n2, 1, "只覆盖更新的 tick");
});

test("survey-db: migrateResourceSanity——时间戳倒挂修复 + seen_count 重建（A10）", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-sync-res-migrate-"));
  const db = openSurveyDb(dir, "t1", true);
  // 无故意写倒挂行 + 污染 seen_count：用原始 SQL 插入
  db.exec("INSERT INTO resources (cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count) VALUES ('1,1', 1, 1, 800, 700, 'visible', 800, 50)");
  db.exec("INSERT INTO resources (cell, x, y, first_seen_tick, last_seen_tick, state, last_state_tick, seen_count) VALUES ('2,2', 2, 2, 100, 200, 'visible', 200, 3)");
  // resource_seen_history：1,1 真实观测 5 次（不同 tick）；2,2 观测 3 次
  for (const tick of [100, 110, 120, 130, 140]) db.exec(`INSERT INTO resource_seen_history (cell, tick) VALUES ('1,1', ${tick})`);
  for (const tick of [100, 200, 300]) db.exec(`INSERT INTO resource_seen_history (cell, tick) VALUES ('2,2', ${tick})`);
  db.close();
  // 重开 write 触发迁移
  const db2 = openSurveyDb(dir, "t1", true);
  const r1 = db2.prepare("SELECT first_seen_tick, last_seen_tick, seen_count FROM resources WHERE cell = '1,1'").get() as { first_seen_tick: number; last_seen_tick: number; seen_count: number };
  assert.equal(r1.first_seen_tick, 700, "first 修为 min(800,700)=700");
  assert.equal(r1.last_seen_tick, 800, "last 修为 max(800,700)=800");
  assert.equal(r1.seen_count, 5, "seen_count 重建为 hist 计数 5（污染的 50 被校正）");
  const r2 = db2.prepare("SELECT seen_count FROM resources WHERE cell = '2,2'").get() as { seen_count: number };
  assert.equal(r2.seen_count, 3, "正常 seen_count=3 不动");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("survey-db: upsertResources MAX 保护 last_seen 单调（A10）", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-sync-res-max-"));
  const db = openSurveyDb(dir, "t1", true);
  upsertResources(db, [{ x: 5, y: 5 }], 1000);
  // 处理顺序不一：后来更早 tick 的 case
  upsertResources(db, [{ x: 5, y: 5 }], 900);
  const r = db.prepare("SELECT first_seen_tick, last_seen_tick FROM resources WHERE cell = '5,5'").get() as { first_seen_tick: number; last_seen_tick: number };
  // MAX 保护：last_seen 不回退（旧无条件覆盖会变 900 导致 first=1000>last=900 倒挂）
  assert.equal(r.last_seen_tick, 1000, "last_seen 不回退（MAX 保护）");
  assert.ok(r.first_seen_tick <= r.last_seen_tick, "无倒挂（first<=last）");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("survey-db: migrateResourceSanity 修 obstacles 倒挂 + upsertObstacles MAX 保护（A10）", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-sync-obs-migrate-"));
  const db = openSurveyDb(dir, "t1", true);
  db.exec("INSERT INTO obstacles (cell, x, y, first_seen_tick, last_seen_tick) VALUES ('9,9', 9, 9, 800, 700)");
  db.close();
  // 重开 write 触发迁移：倒挂修复
  const db2 = openSurveyDb(dir, "t1", true);
  const r = db2.prepare("SELECT first_seen_tick, last_seen_tick FROM obstacles WHERE cell = '9,9'").get() as { first_seen_tick: number; last_seen_tick: number };
  assert.equal(r.first_seen_tick, 700, "obstacles first 修为 min(800,700)=700");
  assert.equal(r.last_seen_tick, 800, "obstacles last 修为 max(800,700)=800");
  // upsertObstacles MAX 保护
  upsertObstacles(db2, [{ x: 7, y: 7 }], 500);
  upsertObstacles(db2, [{ x: 7, y: 7 }], 400); // 后来更早 tick
  const r2 = db2.prepare("SELECT first_seen_tick, last_seen_tick FROM obstacles WHERE cell = '7,7'").get() as { first_seen_tick: number; last_seen_tick: number };
  assert.equal(r2.last_seen_tick, 500, "obstacles last_seen 不回退（MAX 保护）");
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
