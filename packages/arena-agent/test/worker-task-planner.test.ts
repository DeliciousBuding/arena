/** WorkerTaskPlanner progress-aware sticky + 性能基准（生产回流 99b4ba2/d2fe2f6 +
 *  planner-algos-v3 progress-aware sticky 吸收）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import {
  applyStickyBonus,
  progressDecay,
  WorkerTaskPlanner,
  type Assignment,
} from "../src/planning/worker-task-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, hp = 5, cargo = 0) {
  return { id, position: [x, y] as const, hp, unitType: "WORKER" as const, cargo };
}

function makeTurn(units: readonly ReturnType<typeof worker>[] = [], extra: Partial<TurnLike> = {}): TurnLike {
  return {
    tick: 10,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: [],
    rangers: [],
    core: CORE,
    visibleEnemies: [],
    obstacleCells: new Set(),
    resourceCells: new Set(),
    beacon: { position: [8, 8] as const, status: "GROUND" as const, carrier_id: null },
    events: [],
    state: { status: "ACTIVE" as const, population: units.length, objects: [] },
    ...extra,
  };
}

function snapshotOf(turn: TurnLike): PlanningSnapshot {
  return extractPlanningSnapshot(reduceTurn(turn));
}

test("progressDecay: 数学性质（0→1.0、norm→0.5、单调递减）", () => {
  assert.equal(progressDecay(0), 1.0);
  assert.equal(progressDecay(20), 0.5);
  assert.equal(progressDecay(1000), 20 / (20 + 1000));
  // 单调性（数值扫描）
  let prev = 1;
  for (let d = 0; d <= 200; d += 1) {
    const v = progressDecay(d);
    assert.ok(v <= prev + 1e-12, `progressDecay 不单调: d=${d} v=${v} prev=${prev}`);
    prev = v;
  }
});

test("applyStickyBonus: distance 缩放（progress-aware）", () => {
  const previous: readonly Assignment[] = [{ unitId: "w1", task: { type: "GO_RESOURCE", target: [2, 0], targetCellKey: "2,0" } }];
  // 同目标 + dist=2 → amount × 20/22
  assert.equal(applyStickyBonus("w1", "2,0", previous, 0.5, 2), 0.5 * progressDecay(2));
  // 同目标 + dist 缺省 → 二值回退（零回归）
  assert.equal(applyStickyBonus("w1", "2,0", previous, 0.5), 0.5);
  // 同目标 + dist=0 → 全量
  assert.equal(applyStickyBonus("w1", "2,0", previous, 0.5, 0), 0.5);
  // 不同目标 → 0（不论距离）
  assert.equal(applyStickyBonus("w1", "9,9", previous, 0.5, 2), 0);
  // 无历史 → 0
  assert.equal(applyStickyBonus("w2", "2,0", previous, 0.5, 2), 0);
});

test("applyStickyBonus: 远目标 sticky 弱于近目标（progress-aware 的价值）", () => {
  const previous: readonly Assignment[] = [{ unitId: "w1", task: { type: "GO_RESOURCE", target: [20, 0], targetCellKey: "20,0" } }];
  const near = applyStickyBonus("w1", "20,0", previous, 0.5, 2);
  const far = applyStickyBonus("w1", "20,0", previous, 0.5, 40);
  assert.ok(near > far, `近目标 sticky ${near} 应大于远目标 ${far}`);
  assert.ok(far < 0.5, "远目标加成应显著低于全量");
});

test("plan: progress-aware sticky 与 Hungarian 共存（确定性、全局最优不被 sticky 破坏）", () => {
  // 对称场景：两个 worker 对两格的总代价无 sticky 时平局（行序打破）；
  // progress-aware sticky 使"各拿各的在途目标"严格更优（两个 sticky 都兑现），
  // Hungarian 确定性地选出该组合——sticky 作为代价项不破坏求解器全局最优性。
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 4, 0)], {
    resourceCells: new Set(["2,0", "2,4"]),
  }));
  const previous: readonly Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [2, 0], targetCellKey: "2,0" } },
    { unitId: "w2", task: { type: "GO_RESOURCE", target: [2, 4], targetCellKey: "2,4" } },
  ];
  const plan = new WorkerTaskPlanner().plan(snap, previous);
  const byWorker = new Map(plan.assignments.map((a) => [a.unitId, a.task] as const));
  assert.equal(byWorker.get("w1")?.targetCellKey, "2,0", "w1 在途目标（sticky 兑现）");
  assert.equal(byWorker.get("w2")?.targetCellKey, "2,4", "w2 在途目标（sticky 兑现）");
  // 无 sticky 时的确定性平局打破（行序）与 sticky 结果一致 → 零回归
  const plain = new WorkerTaskPlanner().plan(snap);
  const plainByWorker = new Map(plain.assignments.map((a) => [a.unitId, a.task] as const));
  assert.equal(plainByWorker.get("w1")?.targetCellKey, "2,0");
  assert.equal(plainByWorker.get("w2")?.targetCellKey, "2,4");
});

// ---- 性能基准（确定性构造，bounded 断言） ----

interface BenchResult {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function benchPlan(
  workerCount: number,
  resourceCount: number,
  obstacleCount: number,
  iterations: number,
): BenchResult {
  // 确定性构造：worker 在 x=0..n 排开，资源在 x=10..10+n，竖墙在 x=6（y 覆盖），
  // 强制 route-aware BFS 走绕行路径（每个 worker 一次距离场 + core 一次回程场）。
  const units = Array.from({ length: workerCount }, (_, i) => worker(`w${i}`, i * 2, 0));
  const resourceCells = new Set<string>();
  for (let i = 0; i < resourceCount; i += 1) {
    resourceCells.add(`${10 + i},${i % 5}`);
  }
  const obstacleCells = new Set<string>();
  for (let i = 0; i < obstacleCount; i += 1) {
    obstacleCells.add(`6,${i - Math.floor(obstacleCount / 2)}`);
  }
  const snap = snapshotOf(makeTurn(units, { resourceCells, obstacleCells }));
  const planner = new WorkerTaskPlanner();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    planner.plan(snap);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!;
  return { p50Ms: p(0.5), p95Ms: p(0.95), maxMs: samples[samples.length - 1]!, meanMs: mean };
}

test("benchmark: 12 workers × 24 obstacles（含绕行），plan() bounded", { timeout: 60_000 }, () => {
  const r = benchPlan(12, 24, 24, 100);
  console.log(`[bench] 12W×24obs: p50=${r.p50Ms.toFixed(3)}ms p95=${r.p95Ms.toFixed(3)}ms max=${r.maxMs.toFixed(3)}ms mean=${r.meanMs.toFixed(3)}ms`);
  // 单跑 ~4ms；满载套件下放宽到 15ms——>3× 退化即触发（性能回归护栏）。
  assert.ok(r.meanMs < 15, `12W×24obs 均值超界: ${r.meanMs.toFixed(3)}ms`);
  assert.ok(r.maxMs < 200, `12W×24obs 最大值超界: ${r.maxMs.toFixed(3)}ms`);
});

test("benchmark: 20 workers × 100 resources，plan() bounded", { timeout: 60_000 }, () => {
  const r = benchPlan(20, 100, 40, 100);
  console.log(`[bench] 20W×100R: p50=${r.p50Ms.toFixed(3)}ms p95=${r.p95Ms.toFixed(3)}ms max=${r.maxMs.toFixed(3)}ms mean=${r.meanMs.toFixed(3)}ms`);
  // 单跑 ~9ms；满载套件下放宽到 50ms——>5× 退化即触发（性能回归护栏）。
  assert.ok(r.meanMs < 50, `20W×100R 均值超界: ${r.meanMs.toFixed(3)}ms`);
  assert.ok(r.maxMs < 400, `20W×100R 最大值超界: ${r.maxMs.toFixed(3)}ms`);
});
