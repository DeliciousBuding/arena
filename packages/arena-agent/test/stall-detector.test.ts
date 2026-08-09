/**
 * StallDetector 单元测试：多模式死循环检测（cargo_blocked/no_production/
 * patrol_only/focus_exile/capacity_wait_loop）+ 阈值边界 + 宽限期 + 恢复重计数。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StallDetector, type StallEvent, type StallObservation } from "../src/runtime/stall-detector.ts";

const TICK = 1000; // 超过默认 warmupTicks=256

function observe(
  detector: StallDetector,
  overrides: Partial<StallObservation> = {},
): readonly StallEvent[] {
  return detector.onObservation({
    tick: TICK,
    coreResourceDelta: 0,
    workerCount: 5,
    workerCargoTotal: 0,
    workerMeanDistanceFromCore: 10,
    harvestCount: 0,
    depositCount: 0,
    moveCount: 0,
    waitCount: 0,
    intentCounts: {},
    cargoWorkerFingerprint: null,
    ...overrides,
  });
}

function runTicks(
  detector: StallDetector,
  count: number,
  overrides: Partial<StallObservation> = {},
): readonly StallEvent[] {
  const events: StallEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push(...observe(detector, overrides));
  }
  return events;
}

test("StallDetector: cargo_blocked 触发（满载滞留 + delta=0 + 指纹不变）", () => {
  const detector = new StallDetector();
  // 首个 tick 只建立指纹基线（无历史不判定"滞留"），故需 17 tick 累计 16 次命中
  const events = runTicks(detector, 17, {
    workerCargoTotal: 10,
    cargoWorkerFingerprint: "3,4|5,6",
  });
  assert.equal(events.filter((e) => e.kind === "cargo_blocked").length, 1);
  const event = events.find((e) => e.kind === "cargo_blocked");
  assert.equal(event?.streak, 16);
  const alternating = new StallDetector();
  const altEvents: Array<{ kind: string }> = [];
  for (let index = 0; index < 32; index += 1) {
    altEvents.push(...observe(alternating, {
      workerCargoTotal: 10,
      cargoWorkerFingerprint: index % 2 === 0 ? "3,4" : "5,6",
    }));
  }
  assert.equal(altEvents.filter((e) => e.kind === "cargo_blocked").length, 0, "指纹交替变化不算滞留");
});

test("StallDetector: no_production 触发（有 worker 但 0 产出）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, { moveCount: 5, intentCounts: { patrol: 5 } });
  assert.equal(events.some((e) => e.kind === "no_production"), true);
  const event = events.find((e) => e.kind === "no_production");
  assert.equal(event?.streak, 16);
});

test("StallDetector: patrol_only 触发（全部巡逻且 0 产出）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    moveCount: 5,
    intentCounts: { patrol: 4, "capacity_reroute:patrol": 1 },
  });
  assert.equal(events.some((e) => e.kind === "patrol_only"), true);
  assert.equal(events.some((e) => e.kind === "no_production"), true, "同 tick 可命中多个模式");
});

test("StallDetector: focus_exile 触发（go_focus 远征 + 离家远 + 0 产出）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    moveCount: 5,
    intentCounts: { go_focus: 5 },
    workerMeanDistanceFromCore: 25,
  });
  assert.equal(events.some((e) => e.kind === "focus_exile"), true);
  // 离家近的 go_focus 不算远征
  const near = new StallDetector();
  const nearEvents = runTicks(near, 16, {
    moveCount: 5,
    intentCounts: { go_focus: 5 },
    workerMeanDistanceFromCore: 8,
  });
  assert.equal(nearEvents.some((e) => e.kind === "focus_exile"), false);
});

test("StallDetector: capacity_wait_loop 触发（容量互堵占主导）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    waitCount: 4,
    intentCounts: { "capacity_wait:DEPOSIT": 3, "capacity_wait:go_focus": 1, patrol: 1 },
  });
  assert.equal(events.some((e) => e.kind === "capacity_wait_loop"), true);
});

test("StallDetector: 宽限期（tick < 256 不触发慢速类；cargo_blocked 不受影响）", () => {
  const detector = new StallDetector();
  const events: Array<{ kind: string }> = [];
  for (let index = 0; index < 16; index += 1) {
    events.push(...detector.onObservation({
      tick: 100, // 宽限期内
      coreResourceDelta: 0,
      workerCount: 5,
      workerCargoTotal: 0,
      workerMeanDistanceFromCore: 10,
      harvestCount: 0,
      depositCount: 0,
      moveCount: 5,
      waitCount: 0,
      intentCounts: { patrol: 5 },
      cargoWorkerFingerprint: null,
    }));
  }
  assert.equal(events.length, 0, "开局探索期不报警");

  const cargo = new StallDetector();
  const cargoEvents: Array<{ kind: string }> = [];
  for (let index = 0; index < 17; index += 1) {
    cargoEvents.push(...cargo.onObservation({
      tick: 100,
      coreResourceDelta: 0,
      workerCount: 5,
      workerCargoTotal: 10,
      workerMeanDistanceFromCore: 10,
      harvestCount: 0,
      depositCount: 0,
      moveCount: 0,
      waitCount: 0,
      intentCounts: {},
      cargoWorkerFingerprint: "3,4",
    }));
  }
  assert.equal(cargoEvents.filter((e) => e.kind === "cargo_blocked").length, 1, "cargo_blocked 不受宽限期影响");
});

test("StallDetector: 阈值边界 + 恢复后重新计数", () => {
  const detector = new StallDetector();
  const first15 = runTicks(detector, 15, { moveCount: 5, intentCounts: { patrol: 5 } });
  assert.equal(first15.length, 0, "15 tick 不达阈值");
  const at16 = observe(detector, { moveCount: 5, intentCounts: { patrol: 5 } });
  assert.ok(at16.length >= 1, "第 16 tick 触发（可能同时命中多模式）");

  // 恢复（delta>0）→ streak 清零 → 重新累计再触发
  const afterRecovery = observe(detector, {
    coreResourceDelta: 2,
    moveCount: 0,
    intentCounts: { deposit: 1 },
  });
  assert.equal(afterRecovery.length, 0);
  const secondRound = runTicks(detector, 16, { moveCount: 5, intentCounts: { patrol: 5 } });
  assert.ok(secondRound.length >= 1, "恢复后重新累计 16 tick 再次触发");
});

// ---------------------------------------------------------------------------
// 2026-08-10 新增 4 模式：军事互堵 / 空枪空转 / 迁移卡死 / 产兵饿死
// （与 noProduction 解耦——经济正常也报；数据源 = 结算侧 failedEventCounts）
// ---------------------------------------------------------------------------

test("StallDetector: military_interlock 触发（军事 MOVE_FAILED 过半 + 无战斗进展，经济正常）", () => {
  // 生产实证：vanguard_pressure 642 次互堵，经济正常时既有 5 模式全不命中。
  const detector = new StallDetector();
  // 4 军事单位，2 个 UNIT_MOVE_FAILED（=ceil(4/2)=2 过半），有 harvest（经济正常），
  // 无 SHOT_HIT/UNIT_DAMAGED。
  const events = runTicks(detector, 16, {
    coreResourceDelta: 2,
    harvestCount: 1,
    militaryCount: 4,
    failedEventCounts: { UNIT_MOVE_FAILED: 2 },
    shotHitCount: 0,
  });
  const interlock = events.filter((e) => e.kind === "military_interlock");
  assert.equal(interlock.length, 1, "经济正常时军事互堵也应报警");
  assert.equal(interlock[0]?.streak, 16);
});

test("StallDetector: military_interlock 不触发（有 SHOT_HIT = 战斗有进展，非死锁）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    militaryCount: 4,
    failedEventCounts: { UNIT_MOVE_FAILED: 2 },
    shotHitCount: 1, // 有命中 = 游侠在有效输出，不是纯互堵
  });
  assert.equal(events.filter((e) => e.kind === "military_interlock").length, 0, "有战斗进展不算死锁");
});

test("StallDetector: shot_missed_spiral 触发（游侠连发空枪无命中）", () => {
  // 生产实证：shoot_cell 1530 次 + ranger_memory_shot 338 次空枪。
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    coreResourceDelta: 2,
    harvestCount: 1,
    failedEventCounts: { SHOT_MISSED: 3 },
    shotHitCount: 0,
  });
  const spiral = events.filter((e) => e.kind === "shot_missed_spiral");
  assert.equal(spiral.length, 1, "持续空枪无命中应报警");
  assert.equal(spiral[0]?.streak, 16);
});

test("StallDetector: shot_missed_spiral 不触发（有 SHOT_HIT = 有效压制）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    failedEventCounts: { SHOT_MISSED: 3, SHOT_HIT: 1 },
    shotHitCount: 1,
  });
  assert.equal(events.filter((e) => e.kind === "shot_missed_spiral").length, 0, "有命中不算空转");
});

test("StallDetector: migration_stall 触发（CORE_MOVE_START_FAILED 连续）", () => {
  // 生产实证：139 次 TERRAIN_BLOCKED + 248 次 CELL_UNIT_LIMIT。
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    coreResourceDelta: 2,
    failedEventCounts: { CORE_MOVE_START_FAILED: 1 },
  });
  assert.equal(events.filter((e) => e.kind === "migration_stall").length, 1);
});

test("StallDetector: spawn_stall 触发（CORE_SPAWN_FAILED 连续）", () => {
  // 生产实证：34 次 spawn 失败（核心格被占/资源不足）。
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    coreResourceDelta: 2,
    harvestCount: 1,
    failedEventCounts: { CORE_SPAWN_FAILED: 1 },
  });
  assert.equal(events.filter((e) => e.kind === "spawn_stall").length, 1);
});

test("StallDetector: 新 4 模式零回归——failedEventCounts 未提供时不判定", () => {
  const detector = new StallDetector();
  // 经济正常 + 无 failedEventCounts（旧调用方）→ 新 4 模式不应触发
  const events = runTicks(detector, 16, {
    coreResourceDelta: 2,
    harvestCount: 1,
    moveCount: 3,
  });
  assert.equal(events.filter((e) =>
    e.kind === "military_interlock" || e.kind === "shot_missed_spiral" ||
    e.kind === "migration_stall" || e.kind === "spawn_stall").length, 0,
    "未提供 failedEventCounts 时新 4 模式不判定（零回归）");
});
