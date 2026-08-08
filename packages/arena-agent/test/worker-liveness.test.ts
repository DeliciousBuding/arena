import assert from "node:assert/strict";
import { test } from "node:test";

import type { Position, UnitAction, UnitSnapshot } from "../src/domain/model.ts";
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
) {
  return tracker.onObservation({
    tick,
    workers: [worker("w1", position, cargo)],
    unitActions: { w1: action },
    intents: { w1: intent },
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

test("WorkerLiveness: 人类显式接管期间不自动恢复", () => {
  const tracker = new WorkerLivenessTracker({ graceTicks: 0 });
  const events = [];
  for (let tick = 1; tick <= 12; tick += 1) {
    events.push(...feed(tracker, tick, [9, 9], { type: "WAIT" }, "GO_RESOURCE", 0, true));
  }
  assert.equal(events.length, 0);
});
