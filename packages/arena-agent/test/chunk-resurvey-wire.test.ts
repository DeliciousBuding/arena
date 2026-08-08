/**
 * W7 chunk-resurvey-v1 消费接线测试（2026-08-09）。
 *
 * 覆盖 safety-planner.ts decideWorker 的 chunkResurvey 消费块：
 *  - worker 无可见资源 + 无活跃采集目标 + chunkResurvey=true + 已注入 refill
 *    预测 → 调用 planChunkResurvey 分配 worker 去即将刷新的空矿（intent
 *    "go_chunk_resurvey"，复用 go_harvest 采集态）；
 *  - 默认关闭 / 无注入 / 空预测 → 零回归（worker 走 patrol，不触发 resurvey）。
 *
 * 纯函数 planChunkResurvey 本身的契约由 chunk-resurvey.test.ts 覆盖；本测试只验
 * safety-planner 侧的"消费接线"——gate 条件、intent、零回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { RefillPrediction } from "../src/intel/refill-predictions.ts";
import type { TickState } from "../src/domain/model.ts";

/** 构造 RefillPrediction（planChunkResurvey 仅消费 predictedNextTick + cell）。 */
function prediction(cell: string, predictedNextTick: number): RefillPrediction {
  return {
    cell,
    windows: 3,
    avgGapTicks: 100,
    lastWindowStartTick: predictedNextTick - 100,
    predictedNextTick,
    dueInTicks: 0,
  };
}

function makeState(tick: number, workerPos: [number, number]): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: 1,
    core: { id: "c1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [{ id: "w1", position: workerPos, hp: 2, unitType: "WORKER", cargo: 0 }],
    workers: [{ id: "w1", position: workerPos, hp: 2, unitType: "WORKER", cargo: 0 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [101, 101], status: "GROUND", carrierId: null },
    events: [],
  };
}

// ── 零回归：默认关闭 → worker 走 patrol，无 resurvey ──────────────────────

test("chunkResurvey 默认关闭：worker 不触发 resurvey（零回归）", () => {
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  // 即使注入了预测，变体关闭也不消费
  const preds = new Map<string, RefillPrediction>([["4,0", prediction("4,0", 104)]]);
  planner.setRefillPredictions(preds);
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  assert.ok(plan.unitActions["w1"] !== undefined, "worker 有动作");
  assert.notEqual(plan.intents["w1"], "go_chunk_resurvey", "变体关闭不触发 resurvey");
});

// ── 开启但无注入 → 零回归 ─────────────────────────────────────────────────

test("chunkResurvey 开启但无注入预测 → 零回归（走 patrol）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  // 未调用 setRefillPredictions → refillPredictionsValue = null
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
  assert.notEqual(plan.intents["w1"], "go_chunk_resurvey");
});

// ── 开启但空预测 → 零回归 ─────────────────────────────────────────────────

test("chunkResurvey 开启 + 空预测 → 零回归（planChunkResurvey 返回 []）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  planner.setRefillPredictions(new Map());
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
  assert.notEqual(plan.intents["w1"], "go_chunk_resurvey");
});

// ── 开启 + 有预测 + 无可见资源 → 分配 resurvey ────────────────────────────

test("chunkResurvey 开启 + 有即将刷新预测 → worker 派去 resurvey（go_chunk_resurvey）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  // cell [4,0] predictedNextTick=104，4-tick 对齐后 dueInTicks=4（即将刷新）
  const preds = new Map<string, RefillPrediction>([["4,0", prediction("4,0", 104)]]);
  planner.setRefillPredictions(preds);
  // workerCount=1 → cap=min(3,1)=1 → 派去 [4,0]
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  assert.equal(plan.intents["w1"], "go_chunk_resurvey", "intent = go_chunk_resurvey");
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined && action.type === "MOVE", "MOVE 前往 resurvey 目标");
  assert.equal((action as { direction: string }).direction, "RIGHT", "向 [4,0] 前进 = RIGHT");
});

// ── 已过期预测（负 dueInTicks）不入计划 → 零回归 ──────────────────────────

test("chunkResurvey 开启 + 全部过期预测 → 不派 resurvey（零回归）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  // predictedNextTick=90 → 对齐 92 → dueInTicks = 92-100 = -8（过期，不入计划）
  const preds = new Map<string, RefillPrediction>([["4,0", prediction("4,0", 90)]]);
  planner.setRefillPredictions(preds);
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  assert.ok(plan.unitActions["w1"] !== undefined);
  assert.notEqual(plan.intents["w1"], "go_chunk_resurvey", "过期预测不派 resurvey");
});

// ── 多 worker 并发上限（min(3,(n+1)//2)）+ 一矿一 Worker ──────────────────

test("chunkResurvey 多 worker：并发上限 + 一矿一 Worker 吞吐约束", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  // 两个不同 chunk 的 cell 都即将刷新
  const preds = new Map<string, RefillPrediction>([
    ["4,0", prediction("4,0", 104)],
    ["40,0", prediction("40,0", 104)],
  ]);
  planner.setRefillPredictions(preds);
  // 2 worker → cap=min(3,1)=1 → 只 1 个 plan（[4,0]，dueInTicks 升序同值时按插入序）
  const state = makeState(100, [0, 0]);
  // 再加一个 worker
  const workers = [
    { id: "w1", position: [0, 0] as [number, number], hp: 2, unitType: "WORKER" as const, cargo: 0 },
    { id: "w2", position: [0, 0] as [number, number], hp: 2, unitType: "WORKER" as const, cargo: 0 },
  ];
  const multiState: TickState = { ...state, units: workers, workers, population: 2 };
  const plan = planner.decide({ state: multiState });
  // 至少一个 worker 派去 resurvey，另一个走 patrol（cap=1 → 只 1 个 plan）
  const resurveyWorkers = Object.entries(plan.intents)
    .filter(([, intent]) => intent === "go_chunk_resurvey")
    .map(([id]) => id);
  assert.equal(resurveyWorkers.length, 1, "2 worker / cap=1 → 只 1 个派去 resurvey");
});

// ── resurvey 与 patrol 正交：注入预测但不影响其他 worker 的 patrol ───────

test("chunkResurvey 注入预测不影响 patrol 行为类型（MOVE/WAIT 仍合法）", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  const preds = new Map<string, RefillPrediction>([["4,0", prediction("4,0", 104)]]);
  planner.setRefillPredictions(preds);
  const plan = planner.decide({ state: makeState(100, [0, 0]) });
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined, "worker 有动作");
  assert.ok(action!.type === "MOVE" || action!.type === "WAIT", "动作合法");
});

// ── setRefillPredictions 替换式（热刷新）──────────────────────────────────

test("setRefillPredictions 替换式：清空后不再触发 resurvey", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, chunkResurvey: true });
  const preds = new Map<string, RefillPrediction>([["4,0", prediction("4,0", 104)]]);
  planner.setRefillPredictions(preds);
  const planOn = planner.decide({ state: makeState(100, [0, 0]) });
  assert.equal(planOn.intents["w1"], "go_chunk_resurvey");
  // 清空 → 零回归
  planner.setRefillPredictions(null);
  const planOff = planner.decide({ state: makeState(101, [0, 0]) });
  assert.notEqual(planOff.intents["w1"], "go_chunk_resurvey");
});
