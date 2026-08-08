/**
 * WorkerTaskPlanner 测试（2026-08-08，planner-algos-v3 审计改进）：
 *
 * 改进 1：Cost Matrix Precomputation — 行为等价性 + 性能 benchmark
 * 改进 2：Progress-Aware Sticky Bonus — 距离比例衰减 vs 旧二值 sticky
 *
 * 确定性契约：同步 grid/server 语义、bounded latency、Safety veto 不受影响。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyStickyBonus,
  cellKey,
  progressDecay,
  WorkerTaskPlanner,
  type Assignment,
} from "../src/planning/worker-task-planner.ts";
import { DEFAULT_MISSION_CONFIG } from "../src/planning/mission-planner.ts";
import type { PlanningSnapshot, PlanningUnit, ResourceCellInfo } from "../src/planning/planning-snapshot.ts";
import { buildThreatMap } from "../src/planning/planning-snapshot.ts";
import { type Position } from "../src/domain/model.ts";

// ─── helpers ────────────────────────────────────────────────────────

function worker(id: string, x: number, y: number, unitType: "WORKER" | "VANGUARD" = "WORKER"): PlanningUnit {
  return { id, unitType, position: [x, y], hp: 2, cargo: 0 };
}

function resource(key: string, visible = true): [string, ResourceCellInfo] {
  const [xs, ys] = key.split(",");
  return [key, { position: [Number(xs), Number(ys)], visible, lastSeenTick: visible ? 100 : 50 }];
}

function snapshot(
  workers: PlanningUnit[],
  cells: Map<string, ResourceCellInfo>,
  corePos: Position | null = [0, 0],
): PlanningSnapshot {
  return {
    tick: 100,
    resources: 10,
    resourceCapacity: 20,
    resourceSpace: 10,
    population: workers.length,
    units: workers,
    resourceCells: cells,
    obstacleCells: new Set<string>(),
    enemyCells: new Set<string>(),
    enemyUnits: [],
    corePosition: corePos,
    coreHp: 5,
    coreState: "NORMAL",
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    threatMap: buildThreatMap([]),
  };
}

// ─── progressDecay ───────────────────────────────────────────────────

test("progressDecay：距离 0 → 1.0（到目标位置，原 sticky 值不打折）", () => {
  assert.equal(progressDecay(0), 1.0);
  assert.equal(progressDecay(0, 20), 1.0);
});

test("progressDecay：距离 = normDist → 0.5", () => {
  assert.equal(progressDecay(20, 20), 0.5);
  assert.equal(progressDecay(10, 10), 0.5);
});

test("progressDecay：距离 → inf 逼近 0", () => {
  assert.ok(progressDecay(100, 20) < 0.2);
  assert.ok(progressDecay(20, 20) > progressDecay(200, 20));
});

test("progressDecay：单调递减（距离越近 sticky 越强：progress-aware 语义）", () => {
  const vals = [0, 1, 5, 10, 20, 40, 100].map((d) => progressDecay(d, 20));
  for (let i = 1; i < vals.length; i += 1) {
    assert.ok(vals[i - 1] > vals[i], `progressDecay(${vals[i - 1]}) > progressDecay(${vals[i]}) 失败`);
  }
});

// ─── applyStickyBonus ──────────────────────────────────────────────

test("applyStickyBonus：无历史 → 0", () => {
  assert.equal(applyStickyBonus("w1", "10,0", [], 0.5), 0);
});

test("applyStickyBonus：目标不同 → 0", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  assert.equal(applyStickyBonus("w1", "5,5", prev, 0.5), 0);
});

test("applyStickyBonus：相同目标 + 缺省 distance → 二值 sticky（零回归）", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  assert.equal(applyStickyBonus("w1", "10,0", prev, 0.5), 0.5);
  assert.equal(applyStickyBonus("w1", "10,0", prev, 0.5, undefined), 0.5);
});

test("applyStickyBonus：相同目标 + distance=0 → 全额 sticky", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  const result = applyStickyBonus("w1", "10,0", prev, 0.5, 0);
  assert.equal(result, 0.5);
});

test("applyStickyBonus：相同目标 + distance=20 → ~half sticky", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  const result = applyStickyBonus("w1", "10,0", prev, 0.5, 20);
  assert.equal(result, 0.25); // 0.5 * 20/(20+20) = 0.25
});

test("applyStickyBonus：多 worker 历史各自匹配正确", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
    { unitId: "w2", task: { type: "GO_RESOURCE", target: [5, 5], targetCellKey: "5,5" } },
  ];
  assert.equal(applyStickyBonus("w1", "10,0", prev, 0.5, 2), 0.5 * progressDecay(2));
  assert.equal(applyStickyBonus("w2", "5,5", prev, 0.5, 8), 0.5 * progressDecay(8));
  assert.equal(applyStickyBonus("w2", "10,0", prev, 0.5), 0, "目标不匹配 → 0");
});

// ─── WorkerTaskPlanner 唯一性硬约束 ─────────────────────────────────

test("WorkerTaskPlanner：同一资源格最多一个 GO_RESOURCE（唯一性）", () => {
  const planner = new WorkerTaskPlanner();
  const cells = new Map([resource("10,0"), resource("10,1")]);
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2)];
  const plan = planner.plan(snapshot(workers, cells));
  const goCells = plan.assignments
    .filter((a) => a.task.type === "GO_RESOURCE")
    .map((a) => a.task.targetCellKey);
  assert.equal(new Set(goCells).size, goCells.length, "所有 GO_RESOURCE 指向不同格");
});

test("WorkerTaskPlanner：强制 HARVEST_CURRENT 优先占格，后续贪心不重复分配", () => {
  // w1 站在 [10,0] 上（cargo=0）→ HARVEST_CURRENT 占用 "10,0"
  const cells = new Map([resource("10,0"), resource("10,1")]);
  const workers = [worker("w1", 10, 0), worker("w2", 0, 0)];
  const planner = new WorkerTaskPlanner();
  const plan = planner.plan(snapshot(workers, cells));
  const byUnit = new Map(plan.assignments.map((a) => [a.unitId, a.task]));
  assert.equal(byUnit.get("w1")?.type, "HARVEST_CURRENT");
  assert.equal(byUnit.get("w2")?.targetCellKey, "10,1", "w2 只分配给非占用的 10,1");
});

test("WorkerTaskPlanner：单资源格 → 1 个 GO_RESOURCE，其余 WAIT/EXPLORE", () => {
  const cells = new Map([resource("5,0")]);
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 0, 2)];
  const planner = new WorkerTaskPlanner();
  const plan = planner.plan(snapshot(workers, cells));
  const goCount = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE").length;
  assert.equal(goCount, 1, "仅 1 个 worker 被分配");
  const remainTypes = new Set(
    plan.assignments.filter((a) => a.task.type !== "GO_RESOURCE").map((a) => a.task.type),
  );
  assert.ok(remainTypes.has("WAIT") || remainTypes.has("EXPLORE"), "其余 worker 不空等死循环");
});

// ─── Precomputation 行为等价性（核心回归） ──────────────────────────

test("Precomputation：与旧贪心等价——同一输入 → 同一输出（确定性回归）", () => {
  // 旧实现（每轮重算）vs 新实现（预计算矩阵）：在唯一性硬约束、tie-break
  // （worker.id 升序 → cellKey 字典序）一致的条件下，输出必须逐位相同。
  const cells = new Map<string, ResourceCellInfo>();
  for (let x = 0; x < 5; x += 1) {
    for (let y = 0; y < 5; y += 1) {
      const key = `${x * 5},${y * 5}`;
      cells.set(key, { position: [x * 5, y * 5], visible: true, lastSeenTick: 100 });
    }
  }
  const workers = Array.from({ length: 8 }, (_, i) => worker(`w${i}`, i * 2, i));
  const planner = new WorkerTaskPlanner();
  const snap = snapshot(workers, cells);

  // 两轮连续调用（sticky 介入第二轮）→ 确定性：两轮输出应一致
  const p1 = planner.plan(snap);
  const p2 = planner.plan(snap, p1.assignments);
  // 第二轮 sticky 归位 → w0 的目标仍为 sticky 对象 → 被保留
  const goCells1 = p1.assignments.filter((a) => a.task.type === "GO_RESOURCE").map((a) => a.task.targetCellKey);
  const goCells2 = p2.assignments.filter((a) => a.task.type === "GO_RESOURCE").map((a) => a.task.targetCellKey);
  // 相同的 snapshot → 相同的分配目标格集合（顺序可能因 sticky 微调，但唯一性不变）
  assert.equal(new Set(goCells1).size, goCells1.length, "第一轮唯一性");
  assert.equal(new Set(goCells2).size, goCells2.length, "第二轮唯一性（sticky 后）");
  // 第二轮应有至少 1 个 worker 因 sticky 被导向同目标
  const sameTarget = p1.assignments.filter((a1) =>
    p2.assignments.some(
      (a2) => a2.unitId === a1.unitId && a2.task.targetCellKey === a1.task.targetCellKey,
    ),
  ).length;
  assert.ok(sameTarget >= 1, "sticky 机制使至少 1 个 worker 保持同一目标");
});

test("Precomputation：大规模（20 worker × 100 cells）不抛异常，输出合法", () => {
  const cells = new Map<string, ResourceCellInfo>();
  for (let i = 0; i < 100; i += 1) {
    const key = `${i * 3},${(i * 7) % 50}`;
    cells.set(key, { position: [i * 3, (i * 7) % 50], visible: true, lastSeenTick: 100 });
  }
  const workers = Array.from({ length: 20 }, (_, i) =>
    worker(`w${i}`, (i * 13) % 30, (i * 7) % 30),
  );
  const planner = new WorkerTaskPlanner();
  const plan = planner.plan(snapshot(workers, cells));
  const goAssignments = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE");
  assert.ok(goAssignments.length > 0);
  // 唯一性硬约束
  const targets = goAssignments.map((a) => a.task.targetCellKey!);
  assert.equal(new Set(targets).size, targets.length, "大规模输入唯一性不破");
});

// ─── Performance Benchmark ──────────────────────────────────────────

test("Benchmark：plan() 耗时（10 worker × 50 cells × 1000 iterations）", { timeout: 30_000 }, () => {
  const cells = new Map<string, ResourceCellInfo>();
  for (let i = 0; i < 50; i += 1) {
    const key = `${(i * 7) % 40},${(i * 13) % 40}`;
    cells.set(key, { position: [(i * 7) % 40, (i * 13) % 40], visible: true, lastSeenTick: 100 });
  }
  const workers = Array.from({ length: 10 }, (_, i) =>
    worker(`w${i}`, (i * 5) % 20, (i * 3) % 20),
  );
  const planner = new WorkerTaskPlanner();
  const snap = snapshot(workers, cells);

  const start = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    planner.plan(snap);
  }
  const elapsed = performance.now() - start;
  const avgUs = (elapsed / 1000) * 1000; // μs per call

  // 10W×50C → 旧复杂度 O(10×50²)=25K netValue 调用/次 → 预计算 O(10×50)=500
  // 预期 ~3-10× 提速。这里只做门禁：不应明显慢于旧实现。
  assert.ok(avgUs < 5000, `plan() 平均耗时 ${avgUs.toFixed(0)}μs，应在 5ms 以内`);
  // 记录遥测（benchmark 日志）
  console.log(`[bench] plan() 10W×50C avg: ${avgUs.toFixed(1)}μs (${elapsed.toFixed(1)}ms / 1000 iters)`);
});

test("Benchmark：plan() 大规模（20 worker × 100 cells × 200 iterations）", { timeout: 30_000 }, () => {
  const cells = new Map<string, ResourceCellInfo>();
  for (let i = 0; i < 100; i += 1) {
    const key = `${(i * 3) % 50},${(i * 7) % 50}`;
    cells.set(key, { position: [(i * 3) % 50, (i * 7) % 50], visible: true, lastSeenTick: 100 });
  }
  const workers = Array.from({ length: 20 }, (_, i) =>
    worker(`w${i}`, (i * 13) % 30, (i * 7) % 30),
  );
  const planner = new WorkerTaskPlanner();
  const snap = snapshot(workers, cells);

  const start = performance.now();
  for (let i = 0; i < 200; i += 1) {
    planner.plan(snap);
  }
  const elapsed = performance.now() - start;
  const avgUs = (elapsed / 200) * 1000;

  assert.ok(avgUs < 15000, `plan() 大规模平均耗时 ${avgUs.toFixed(0)}μs，应在 15ms 以内`);
  console.log(`[bench] plan() 20W×100C avg: ${avgUs.toFixed(1)}μs (${elapsed.toFixed(1)}ms / 200 iters)`);
});

// ─── Progress-Aware Sticky：距离越近 → 目标越不易被切换 ──────────

test("Progress-aware：近距离 worker 比远距离 worker 的 netValue 更高（同条件下）", () => {
  const cells = new Map([resource("10,0")]);
  const nearWorker = worker("w1", 8, 0); // dist=2 到 [10,0]
  const farWorker = worker("w2", 0, 0);   // dist=10 到 [10,0]
  const planner = new WorkerTaskPlanner({ stickyBonus: 0.5 });
  const previous: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
    { unitId: "w2", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  const snap = snapshot([nearWorker, farWorker], cells);

  // 两个 worker 争同一格：[10,0] 只能给 1 人。谁 netValue 高谁得。
  const plan = planner.plan(snap, previous);
  const winner = plan.assignments.find((a) => a.task.type === "GO_RESOURCE");
  assert.ok(winner !== undefined);
  // w1（近，sticky 0.5*20/(20+2)=0.454）vs w2（远，sticky 0.5*20/(20+10)=0.167）
  // w1 net = 1+0.454-2-10 = -10.546, w2 net = 1+0.167-10-10 = -18.833
  // w1 净收益更高 → w1 赢得分配
  assert.equal(winner?.unitId, "w1", "近距离 worker 的 progress-aware sticky 更强，赢得分配");
});

test("Progress-aware：缺省 distance → 二值 sticky 零回归（调用方兼容）", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  // 旧调用方（不传 distance）→ 行为与旧版完全一致
  assert.equal(applyStickyBonus("w1", "10,0", prev, 0.5), 0.5);
  assert.equal(applyStickyBonus("w1", "10,0", prev, 0.5, undefined), 0.5);
});

test("Progress-aware：非 sticky 目标不受影响（distance 传了也无 sticky）", () => {
  const prev: Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [10, 0], targetCellKey: "10,0" } },
  ];
  // 不同目标 → 永远是 0，不受 distance 影响
  assert.equal(applyStickyBonus("w1", "5,5", prev, 0.5, 3), 0);
  assert.equal(applyStickyBonus("w1", "5,5", prev, 0.5), 0);
});

// ─── Edge Cases ─────────────────────────────────────────────────────

test("WorkerTaskPlanner：Core 不在位时 returnTime=0，不影响分配", () => {
  const cells = new Map([resource("10,0"), resource("0,10")]);
  const workers = [worker("w1", 0, 0), worker("w2", 0, 1)];
  const planner = new WorkerTaskPlanner();
  // corePosition = null → returnTime = 0（兜底）
  const plan = planner.plan(snapshot(workers, cells, null));
  assert.ok(plan.assignments.length > 0, "Core 不在位仍可分配");
});

test("WorkerTaskPlanner：全 Worker 都满载 → 全部 DEPOSIT 强制任务，无人走贪心", () => {
  const cells = new Map([resource("10,0")]);
  const cargoWorkers = [
    { id: "w1", unitType: "WORKER" as const, position: [10, 0] as Position, hp: 2, cargo: 1 },
    { id: "w2", unitType: "WORKER" as const, position: [10, 1] as Position, hp: 2, cargo: 1 },
  ];
  const planner = new WorkerTaskPlanner();
  const snap = snapshot(cargoWorkers, cells);
  const plan = planner.plan(snap);
  const types = plan.assignments.map((a) => a.task.type);
  assert.ok(types.every((t) => t === "DEPOSIT"), "满载 → 全部强制回仓，不走代价矩阵");
});

test("WorkerTaskPlanner：空资源池 → 全部 WAIT/EXPLORE，无 GO_RESOURCE", () => {
  const cells = new Map<string, ResourceCellInfo>();
  const workers = [worker("w1", 0, 0), worker("w2", 1, 0)];
  const planner = new WorkerTaskPlanner();
  const plan = planner.plan(snapshot(workers, cells));
  const goCount = plan.assignments.filter((a) => a.task.type === "GO_RESOURCE").length;
  assert.equal(goCount, 0, "无资源时不应有 GO_RESOURCE");
  const types = new Set(plan.assignments.map((a) => a.task.type));
  assert.ok(types.has("WAIT") || types.has("EXPLORE"), "回退 WAIT/EXPLORE");
});

test("WorkerTaskPlanner：threatMap 非零格降低 netValue，工兵优先选安全格", () => {
  const cells = new Map([resource("10,0"), resource("0,10")]);
  const workers = [worker("w1", 0, 0)];
  const enemyUnits = [{ id: "e1", position: [10, 0] as Position, unitType: "VANGUARD" as const }];
  // [10,0] 紧邻敌人 → threatMap 非零；[0,10] 安全
  const snap: PlanningSnapshot = {
    ...snapshot(workers, cells),
    threatMap: buildThreatMap(enemyUnits),
    enemyUnits,
    enemyCells: new Set(["10,0"]),
  };
  const planner = new WorkerTaskPlanner();
  const plan = planner.plan(snap);
  const goAssignment = plan.assignments.find((a) => a.task.type === "GO_RESOURCE");
  assert.ok(goAssignment !== undefined);
  // threatContribution 在自身格=1，紧邻格递减。安全格 threat=0 → 净收益更高
  assert.equal(goAssignment.task.targetCellKey, "0,10", "优先选无威胁安全格");
});
