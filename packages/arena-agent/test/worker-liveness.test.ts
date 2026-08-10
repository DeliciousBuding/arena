import assert from "node:assert/strict";
import { test } from "node:test";

import type { Position, UnitAction, UnitSnapshot } from "../src/domain/model.ts";
import type { WorkerProgressExpectation } from "../src/planning/progress-contract.ts";
import { WorkerLivenessTracker } from "../src/runtime/worker-liveness.ts";

function worker(id: string, position: Position, cargo = 0): UnitSnapshot {
  return { id, position, hp: 2, unitType: "WORKER", cargo };
}

function feed(
  tracker: WorkerLivenessTracker,
  tick: number,
  position: Position,
  action: UnitAction,
  intent: string,
  cargo = 0,
  human = false,
  progressExpectation: WorkerProgressExpectation | null = null,
) {
  return tracker.onObservation({
    tick,
    workers: [worker("w1", position, cargo)],
    unitActions: { w1: action },
    intents: { w1: intent },
    progressExpectations: progressExpectation === null ? undefined : new Map([["w1", progressExpectation]]),
    humanControlledUnitIds: human ? new Set(["w1"]) : new Set(),
  });
}

test("WorkerLiveness: GO_RESOURCE+WAIT 连续 6 Tick 无进展 → economic_no_progress", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0 });
  const events = [];
  for (let tick = 1; tick <= 7; tick += 1) {
    events.push(...feed(tracker, tick, [40, 289], { type: "WAIT" }, "GO_RESOURCE"));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "economic_no_progress");
  assert.equal(events[0]?.unitId, "w1");
  assert.equal(events[0]?.uniqueRecentPositions, 1);
});

test("WorkerLiveness: MOVE 连续提交但位置不变 → move_no_effect", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, economicNoProgressTicks: 99 });
  const events = [];
  for (let tick = 1; tick <= 5; tick += 1) {
    events.push(...feed(tracker, tick, [5, 5], { type: "MOVE", direction: "RIGHT" }, "patrol"));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "move_no_effect");
});

test("WorkerLiveness: 12 Tick 两格来回 MOVE → oscillation（t3 生产模式）", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, moveNoEffectTicks: 99 });
  const events = [];
  for (let tick = 1; tick <= 12; tick += 1) {
    const position: Position = tick % 2 === 0 ? [1, 0] : [0, 0];
    events.push(...feed(
      tracker,
      tick,
      position,
      { type: "MOVE", direction: tick % 2 === 0 ? "LEFT" : "RIGHT" },
      tick % 2 === 0 ? "patrol" : "worker_clear_core_empty",
    ));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "oscillation");
  assert.equal(events[0]?.uniqueRecentPositions, 2);
});

test("WorkerLiveness: worker_hold_crowded 长等 → crowd_starvation", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, economicNoProgressTicks: 99 });
  const events = [];
  for (let tick = 1; tick <= 7; tick += 1) {
    events.push(...feed(tracker, tick, [2, 2], { type: "WAIT" }, "worker_hold_crowded"));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "crowd_starvation");
});

test("WorkerLiveness: Core moving / blockade 等合法 WAIT 不报警", () => {
  for (const intent of ["worker_hold_cargo_moving", "worker_yield_spawn", "worker_evade_cooldown", "worker_blockade"]) {
    const tracker = new WorkerLivenessTracker({ graceTicks: 0, economicNoProgressTicks: 99 });
    const events = [];
    for (let tick = 1; tick <= 20; tick += 1) {
      events.push(...feed(tracker, tick, [2, 2], { type: "WAIT" }, intent, intent === "worker_hold_cargo_moving" ? 1 : 0));
    }
    assert.equal(events.length, 0, `${intent} should be intentional wait`);
  }
});

test("WorkerLiveness: 正常探索移动大量不同格不报警", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0 });
  const events = [];
  for (let tick = 1; tick <= 30; tick += 1) {
    events.push(...feed(tracker, tick, [tick, 0], { type: "MOVE", direction: "RIGHT" }, "patrol"));
  }
  assert.equal(events.length, 0);
});

test("WorkerLiveness: survey 一直在同一已知 chunk 内移动 → exploration_no_novelty", () => {
  const tracker = new WorkerLivenessTracker({
    graceTicks: 0,
    explorationNoNoveltyTicks: 4,
    oscillationWindowTicks: 12,
    moveNoEffectTicks: 99,
  });
  tracker.seedKnownChunks(["0,0"]);
  const events = [];
  for (let tick = 1; tick <= 5; tick += 1) {
    events.push(...feed(
      tracker,
      tick,
      [tick - 1, 0],
      { type: "MOVE", direction: "RIGHT" },
      "worker_survey",
      0,
      false,
      { kind: "novel_coverage", taskType: "EXPLORE" },
    ));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "exploration_no_novelty");
  assert.equal(events[0]?.streak, 4);
  assert.equal(events[0]?.explorationChunk, "0,0");
  assert.equal(events[0]?.knownExplorationChunks, 1);
  assert.equal(events[0]?.uniqueRecentPositions, 5, "细粒度位置在变，但粗粒度覆盖没有扩张");
});

test("WorkerLiveness: 跨入另一个 chunk 算 coverage progress，不误伤补测/穿越", () => {
  const tracker = new WorkerLivenessTracker({
    graceTicks: 0,
    explorationNoNoveltyTicks: 3,
    oscillationWindowTicks: 12,
    moveNoEffectTicks: 99,
  });
  tracker.seedKnownChunks(["0,0"]);
  const positions: Position[] = [[13, 0], [14, 0], [15, 0], [16, 0], [17, 0], [18, 0]];
  const events = [];
  for (let index = 0; index < positions.length; index += 1) {
    events.push(...feed(
      tracker,
      index + 1,
      positions[index]!,
      { type: "MOVE", direction: "RIGHT" },
      "worker_survey",
      0,
      false,
      { kind: "novel_coverage", taskType: "EXPLORE" },
    ));
  }
  assert.equal(events.length, 0);
});

test("WorkerLiveness: 只有显式 EXPLORE 合同才检查 novelty，resurvey/普通 patrol 不靠 intent 猜", () => {
  const tracker = new WorkerLivenessTracker({
    graceTicks: 0,
    explorationNoNoveltyTicks: 3,
    moveNoEffectTicks: 99,
  });
  tracker.seedKnownChunks(["0,0"]);
  const events = [];
  for (let tick = 1; tick <= 8; tick += 1) {
    events.push(...feed(tracker, tick, [tick - 1, 0], { type: "MOVE", direction: "RIGHT" }, "worker_survey"));
  }
  assert.equal(events.length, 0, "intent 文本不能自动变成 novel-coverage 契约");
});

test("WorkerLiveness: GO_RESOURCE 虽持续 MOVE 但远离目标仍判 economic_no_progress", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, economicNoProgressTicks: 3, moveNoEffectTicks: 99 });
  const events = [];
  for (let tick = 1; tick <= 4; tick += 1) {
    events.push(...feed(
      tracker,
      tick,
      [tick - 1, 0],
      { type: "MOVE", direction: "RIGHT" },
      "GO_RESOURCE",
      0,
      false,
      { kind: "target", taskType: "GO_RESOURCE", target: [-10, 0] },
    ));
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "economic_no_progress");
});

test("WorkerLiveness: capacity_wait:DEPOSIT 计入经济无推进（GAP 1.2——入口满拒需恢复）", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, economicNoProgressTicks: 3, idleWaitTicks: 3 });
  const events = [];
  for (let tick = 1; tick <= 10; tick += 1) {
    events.push(...feed(
      tracker,
      tick,
      [2, 2],
      { type: "WAIT" },
      "capacity_wait:DEPOSIT",
      1,
      false,
      { kind: "target", taskType: "DEPOSIT", target: [0, 0] },
    ));
  }
  // GAP 1.2（2026-08-10）：满载 worker 被入口满拒（capacity_wait:DEPOSIT）
  // 时 cargo 不变 → economic_no_progress 累加 → 触发 recoverWorker。旧版
  // 只在 intentionalWait 豁免（不触发 idle_wait）但不在 ECONOMIC_INTENTS
  // → 无任何恢复路径（C7 只覆盖军事单位）。intentionalWait 豁免的是
  // idle_wait（等待本身不算闲置），不豁免 economic_no_progress（卸不了货
  // 是真问题，需恢复换路径）。10 tick 窗口只含首次触发（3 tick 触发 +
  // 8 tick 冷却 = 11 内不会二次触发）。
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "economic_no_progress");
});

test("WorkerLiveness: 人类显式接管期间不自动恢复", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0 });
  const events = [];
  for (let tick = 1; tick <= 12; tick += 1) {
    events.push(...feed(tracker, tick, [9, 9], { type: "WAIT" }, "GO_RESOURCE", 0, true));
  }
  assert.equal(events.length, 0);
});
