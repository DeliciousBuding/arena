/**
 * StallDetector 单元测试：多模式死循环检测（cargo_blocked/assigned_no_progress/
 * no_production/patrol_only/focus_exile/capacity_wait_loop）+ 阈值边界 + 宽限期 + 恢复重计数。
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

test("StallDetector: assigned_no_progress 捕获 GO_RESOURCE 假活（t4 300-tick 回归）", () => {
  const detector = new StallDetector();
  const events = runTicks(detector, 16, {
    workerCount: 2,
    waitCount: 2,
    moveCount: 0,
    economicWaitCount: 2,
    intentCounts: { GO_RESOURCE: 2 },
  });
  const event = events.find((e) => e.kind === "assigned_no_progress");
  assert.ok(event, "经济任务已分配但最终全 WAIT 必须被识别为假活");
  assert.equal(event.streak, 16);
  assert.equal(event.detail.economicWaitCount, 2);

  const healthy = new StallDetector();
  const healthyEvents = runTicks(healthy, 16, {
    workerCount: 2,
    moveCount: 2,
    waitCount: 0,
    economicWaitCount: 0,
    intentCounts: { GO_RESOURCE: 2 },
  });
  assert.equal(healthyEvents.some((e) => e.kind === "assigned_no_progress"), false);
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
