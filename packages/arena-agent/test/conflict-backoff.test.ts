/**
 * W37 冲突退避时间窗兜底测试（2026-08-09，挂 W5，默认关）。
 *
 * 问题：两单位互挡且绕行格互占时无打破手段——我方"空间换路"哲学缺时间维兜底。
 * 参考 arena-evolve heuristic.py:519-533（MOVE_BLOCKED 连续 ≥3 → _move_backoff
 * = tick+2 短停 2 tick；MOVED 即清零）。
 *
 * 本变体（conflictBackoff，默认关闭零回归）：
 *  - safety-planner-config.ts 加 conflictBackoff/threshold(3)/ticks(2)；
 *  - safety-planner.ts moveFailedStreak 消费点（return_home / go_harvest）：
 *    连续 ≥3 次 MOVE_FAILED 且 detourDirection 无路 → 原地 WAIT 1-2 tick；
 *    MOVED（无 MOVE_FAILED 事件）即清零。
 *
 * 测试启用 moveFailedAvoidance 以使用 detourDirection（更可预测的绕行行为；
 * moveFailedAvoidance 关时走 stepToward BFS，路径绕行不返回 null 难以构造
 * backoff 触发场景）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TickState, ResolutionEventSnapshot } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

/** 满载 worker 在 [10,0] 回仓 [0,0]——主方向 LEFT 被争时 detourDirection
 *  取 UP/DOWN 垂直绕行；垂直全堵时 W37 短停 WAIT。 */
function makeWorkerReturnHomeState(
  tick: number,
  failedWorkerIds: string[] = [],
  obstacleCells: Set<string> = new Set(),
): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 2 }],
    workers: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 2 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells,
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: failedWorkerIds.map(
      (actorId): ResolutionEventSnapshot => ({
        eventId: `ev-${actorId}-${tick}`,
        tick: tick - 1,
        eventType: "UNIT_MOVE_FAILED",
        reasonCode: "MOVE_CONTESTED",
        actorId,
        targetId: null,
        values: {},
      }),
    ),
  };
}

const BACKOFF_CONFIG = {
  ...DEFAULT_SAFETY_CONFIG,
  conflictBackoff: true,
  moveFailedAvoidance: true,
};

// ── 零回归：默认关闭时不触发 backoff ─────────────────────────────────────

test("conflictBackoff 默认关闭：连续失败不触发 backoff（零回归）", () => {
  const planner = new SafetyPlanner();
  const obstacles = new Set(["9,0", "10,-1", "10,1"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  const plan = planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  assert.notEqual(plan.intents["w1"], "conflict_backoff");
});

// ── 连续失败 3 次 + detour 无路 → WAIT（conflict_backoff intent） ──────────

test("conflictBackoff 开启：连续失败 <3 次不触发（阈值 ≥3）", () => {
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  const obstacles = new Set(["9,0", "10,-1", "10,1"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  const plan = planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  assert.notEqual(plan.intents["w1"], "conflict_backoff");
});

test("conflictBackoff 开启：连续失败 ≥3 次且 detour 无路 → WAIT（conflict_backoff）", () => {
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  // worker 在 [10,0]，主方向 LEFT → [9,0] 是障碍；UP → [10,-1] 是障碍；
  // DOWN → [10,1] 是障碍；reverse RIGHT → [11,0] 不是障碍但远离 home。
  // detourDirection：horizontal=true → perpendicular=UP/DOWN 全堵 →
  // reverse=RIGHT 不堵 → 返回 RIGHT（远离目标但 detour 有路）。
  // 要让 detourDirection 返回 null，需要堵 LEFT/UP/DOWN/RIGHT 全部四向。
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  const plan = planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
  assert.equal(plan.intents["w1"], "conflict_backoff");
});

test("conflictBackoff 开启：detour 有路时不触发 backoff（仍走 detour）", () => {
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  // 只堵 LEFT/UP/DOWN，RIGHT（reverse）空闲 → detourDirection 返回 RIGHT
  const obstacles = new Set(["9,0", "10,-1", "10,1"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  const plan = planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  // detour 有路 → MOVE RIGHT（远离 home 但 detour 探路），不触发 backoff
  assert.notEqual(plan.intents["w1"], "conflict_backoff");
  assert.equal(plan.unitActions["w1"]?.type, "MOVE");
  assert.equal(plan.unitActions["w1"]?.direction, "RIGHT");
});

// ── MOVED 即清零：成功移动后失败计数重置 ──────────────────────────────────

test("conflictBackoff 开启：冷却过期后无失败 → 不再 backoff（streak 清零）", () => {
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  // 连续失败 3 次 → 触发 backoff（冷却 = tick 3 + 2 = 5）
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  // tick 4：冷却内 → WAIT
  planner.decide({ state: makeWorkerReturnHomeState(4, ["w1"], obstacles) });
  // tick 5：冷却过期（5 ≤ 5），但仍有 MOVE_FAILED → streak=5 ≥3 → 再次触发
  // 新冷却 = 5 + 2 = 7
  planner.decide({ state: makeWorkerReturnHomeState(5, ["w1"], obstacles) });
  // tick 6：无 MOVE_FAILED → streak 清零，但冷却 7 > 6 → 仍 WAIT
  planner.decide({ state: makeWorkerReturnHomeState(6, [], obstacles) });
  // tick 7：冷却过期（7 ≤ 7），streak 已清零（0 < 3）→ 不再 backoff
  const plan = planner.decide({ state: makeWorkerReturnHomeState(7, [], obstacles) });
  assert.notEqual(plan.intents["w1"], "conflict_backoff");
});

// ── 冷却窗口：触发后 conflictBackoffTicks 内保持 WAIT ────────────────────

test("conflictBackoff 开启：触发后冷却期内保持 WAIT", () => {
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  // tick 4：冷却内（3+2=5 > 4）→ WAIT
  const plan = planner.decide({ state: makeWorkerReturnHomeState(4, ["w1"], obstacles) });
  assert.equal(plan.intents["w1"], "conflict_backoff");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
});

// ── 自定义阈值/ticks ─────────────────────────────────────────────────────

test("conflictBackoff 自定义阈值：threshold=2 时连续 2 次即触发", () => {
  const customConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    conflictBackoff: true,
    moveFailedAvoidance: true,
    conflictBackoffThreshold: 2,
  };
  const planner = new SafetyPlanner(customConfig);
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  const plan = planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  assert.equal(plan.intents["w1"], "conflict_backoff");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
});

test("conflictBackoff 自定义 ticks：ticks=1 时冷却仅 1 tick", () => {
  const customConfig = {
    ...DEFAULT_SAFETY_CONFIG,
    conflictBackoff: true,
    moveFailedAvoidance: true,
    conflictBackoffTicks: 1,
  };
  const planner = new SafetyPlanner(customConfig);
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  // 连续失败 3 次 → 触发 backoff（冷却 = tick 3 + 1 = 4）
  planner.decide({ state: makeWorkerReturnHomeState(1, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(2, ["w1"], obstacles) });
  planner.decide({ state: makeWorkerReturnHomeState(3, ["w1"], obstacles) });
  // tick 4：冷却已过（3+1=4，4 ≤ 4 过期）→ 重新评估
  // streak 仍 ≥3（连续 4 次 MOVE_FAILED）且 detour 无路 → 再次触发 backoff
  const plan = planner.decide({ state: makeWorkerReturnHomeState(4, ["w1"], obstacles) });
  assert.equal(plan.intents["w1"], "conflict_backoff");
});

// ── go_harvest 消费点也支持 backoff ───────────────────────────────────────

test("conflictBackoff 开启：go_harvest 连续失败 ≥3 且无路 → WAIT", () => {
  const obstacles = new Set(["9,0", "10,-1", "10,1", "11,0"]);
  const resourceCells = new Set(["0,0"]);
  function makeHarvestState(tick: number, failedIds: string[] = []): TickState {
    return {
      tick,
      status: "ACTIVE",
      resources: 10,
      resourceCapacity: 10,
      resourceSpace: 10,
      population: 1,
      core: { id: "c1", position: [20, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
      units: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      workers: [{ id: "w1", position: [10, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
      vanguards: [],
      rangers: [],
      visibleEnemies: [],
      resourceCells,
      obstacleCells: obstacles,
      beacon: { position: [100, 100], status: "GROUND", carrierId: null },
      events: failedIds.map(
        (actorId): ResolutionEventSnapshot => ({
          eventId: `ev-${actorId}-${tick}`,
          tick: tick - 1,
          eventType: "UNIT_MOVE_FAILED",
          reasonCode: "MOVE_CONTESTED",
          actorId,
          targetId: null,
          values: {},
        }),
      ),
    };
  }
  const planner = new SafetyPlanner(BACKOFF_CONFIG);
  planner.decide({ state: makeHarvestState(1, ["w1"]) });
  planner.decide({ state: makeHarvestState(2, ["w1"]) });
  const plan = planner.decide({ state: makeHarvestState(3, ["w1"]) });
  assert.equal(plan.intents["w1"], "conflict_backoff");
  assert.equal(plan.unitActions["w1"]?.type, "WAIT");
});
