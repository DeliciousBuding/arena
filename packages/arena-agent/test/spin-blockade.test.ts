/** 打转封锁闭环（W5）——参考 arena_hero_strategy.py:1292-1293 / :5932 / :2557。
 *
 * WorkerLivenessTracker 检测 oscillation/move_no_effect 并经 safety-planner.recoverWorker
 * 恢复，但恢复不封锁目标格 → Hungarian 把打转 worker 重派回同一死目标（"检测→
 * 恢复→重派→再打转"循环）。W5 给 WorkerLivenessTracker 加 temporaryBlocks 状态
 * + blockCell/isCellBlocked API，worker-task-planner 在 Hungarian 候选排序时把
 * isCellBlocked 的死目标格排后（+BLOCKADE_PENALTY，不剔除防饥饿）。
 *
 * 本套件覆盖规格 6 例：封锁生效 / 过期释放 / 12 vs 4 penalty / 新鲜目标保护 /
 * 关零回归 / 到期自动清理。safety-planner 的消费接线（config.spinBlockade 开关 +
 * recoverWorker 调 blockCell）由 W6 收口统一做，这里只验 WorkerLivenessTracker
 * 的能力 + worker-task-planner 的消费。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, UnitAction, UnitSnapshot } from "../src/domain/model.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import { WorkerTaskPlanner, type Assignment } from "../src/planning/worker-task-planner.ts";
import {
  FRESH_TARGET_TICKS,
  MOVE_CONTESTED_BLOCK_PENALTY,
  OTHER_MOVE_FAIL_BLOCK_PENALTY,
  WorkerLivenessTracker,
} from "../src/runtime/worker-liveness.ts";

// ---- WorkerLivenessTracker 单元测试夹具 ----

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
) {
  return tracker.onObservation({
    tick,
    workers: [worker("w1", position, cargo)],
    unitActions: { w1: action },
    intents: { w1: intent },
  });
}

// ---- WorkerTaskPlanner 集成测试夹具（与 worker-task-planner.test.ts 同构） ----

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function planWorker(id: string, x: number, y: number, cargo = 0) {
  return { id, position: [x, y] as const, hp: 5, unitType: "WORKER" as const, cargo };
}

function makeTurn(units: readonly ReturnType<typeof planWorker>[] = [], extra: Partial<TurnLike> = {}): TurnLike {
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

function targetCellKeyOf(assignments: readonly Assignment[], unitId: string): string | undefined {
  return assignments.find((a) => a.unitId === unitId)?.task.targetCellKey;
}

// ===========================================================================
// 1. 封锁生效：打转 worker 恢复后不被重派回同一死目标
// ===========================================================================

test("spin-blockade: isCellBlocked 的死目标格在 Hungarian 候选排序里排后（封锁生效）", () => {
  // 单 worker、两格等可达：[2,0] 近（travel=2）、[2,4] 远（travel=6）。
  // 不封锁 → 选近格 [2,0]；封锁 [2,0] → 选远格 [2,4]（封锁格 +BLOCKADE_PENALTY
  // 后代价反超）。验证 Hungarian 不会把打转 worker 重派回死目标。
  const snap = snapshotOf(makeTurn([planWorker("w1", 0, 0)], {
    resourceCells: new Set(["2,0", "2,4"]),
  }));
  const tracker = new WorkerLivenessTracker();

  // 关零回归基线：未封锁 → 近格优先
  const baseline = new WorkerTaskPlanner().plan(snap, [], { cellBlocker: tracker });
  assert.equal(targetCellKeyOf(baseline.assignments, "w1"), "2,0", "未封锁时应选近格 [2,0]");

  // 封锁死目标 [2,0]（模拟 recoverWorker 收到 blockedTarget 后调 blockCell）
  tracker.blockCell([2, 0], snap.tick, MOVE_CONTESTED_BLOCK_PENALTY);
  assert.equal(tracker.isCellBlocked([2, 0], snap.tick), true, "[2,0] 应处于封锁冷却");
  assert.equal(tracker.isCellBlocked([2, 4], snap.tick), false, "[2,4] 未封锁");

  const blocked = new WorkerTaskPlanner().plan(snap, [], { cellBlocker: tracker });
  assert.equal(targetCellKeyOf(blocked.assignments, "w1"), "2,4", "封锁 [2,0] 后应改派远格 [2,4]");
});

test("spin-blockade: 全部候选都被封锁时仍能分配（防饥饿，不剔除）", () => {
  // 两格都被封锁：BLOCKADE_PENALTY 等量施加，相对代价不变 → 仍选较优的近格。
  // 证明封锁是"排后"而非"剔除"——否则 worker 会落 WAIT（饥饿）。
  const snap = snapshotOf(makeTurn([planWorker("w1", 0, 0)], {
    resourceCells: new Set(["2,0", "2,4"]),
  }));
  const tracker = new WorkerLivenessTracker();
  tracker.blockCell([2, 0], snap.tick, MOVE_CONTESTED_BLOCK_PENALTY);
  tracker.blockCell([2, 4], snap.tick, MOVE_CONTESTED_BLOCK_PENALTY);
  const plan = new WorkerTaskPlanner().plan(snap, [], { cellBlocker: tracker });
  assert.equal(targetCellKeyOf(plan.assignments, "w1"), "2,0", "全封锁时仍选相对较优的近格（不饥饿）");
});

// ===========================================================================
// 2. 封锁过期后释放（penalty 12/4 tick 后）
// ===========================================================================

test("spin-blockade: penalty=12 封锁在 tick+12 到期释放", () => {
  const tracker = new WorkerLivenessTracker();
  const target: Position = [5, 5];
  tracker.blockCell(target, 10, MOVE_CONTESTED_BLOCK_PENALTY);
  // blockCell(currentTick=10, penalty=12) → 到期 tick = 22（exclusive）
  for (let tick = 10; tick <= 21; tick += 1) {
    assert.equal(tracker.isCellBlocked(target, tick), true, `tick=${tick} 应封锁`);
  }
  assert.equal(tracker.isCellBlocked(target, 22), false, "tick=22 应释放（到期）");
  assert.equal(tracker.isCellBlocked(target, 100), false, "tick=100 远期不封锁");
});

test("spin-blockade: penalty=4 封锁在 tick+4 到期释放", () => {
  const tracker = new WorkerLivenessTracker();
  const target: Position = [6, 6];
  tracker.blockCell(target, 10, OTHER_MOVE_FAIL_BLOCK_PENALTY);
  for (let tick = 10; tick <= 13; tick += 1) {
    assert.equal(tracker.isCellBlocked(target, tick), true, `tick=${tick} 应封锁`);
  }
  assert.equal(tracker.isCellBlocked(target, 14), false, "tick=14 应释放");
});

// ===========================================================================
// 3. MOVE_CONTESTED 类封锁 12 tick、其他 4 tick
// ===========================================================================

test("spin-blockade: MOVE_CONTESTED_BLOCK_PENALTY=12 与 OTHER_MOVE_FAIL_BLOCK_PENALTY=4 区分", () => {
  assert.equal(MOVE_CONTESTED_BLOCK_PENALTY, 12, "强竞争类（目标实际被占）封锁 12 tick");
  assert.equal(OTHER_MOVE_FAIL_BLOCK_PENALTY, 4, "其他失败类（路径瞬时拥堵）封锁 4 tick");
  assert.ok(MOVE_CONTESTED_BLOCK_PENALTY > OTHER_MOVE_FAIL_BLOCK_PENALTY, "强竞争类封锁应更长");

  // 同一起点同 tick，不同 penalty → 到期 tick 不同
  const contested = new WorkerLivenessTracker();
  const other = new WorkerLivenessTracker();
  const cell: Position = [7, 7];
  contested.blockCell(cell, 100, MOVE_CONTESTED_BLOCK_PENALTY);
  other.blockCell(cell, 100, OTHER_MOVE_FAIL_BLOCK_PENALTY);
  // tick=104：contested(到期112)仍封锁；other(到期104)已释放
  assert.equal(contested.isCellBlocked(cell, 104), true, "contested@104 应封锁");
  assert.equal(other.isCellBlocked(cell, 104), false, "other@104 应释放");
  // tick=112：contested 到期释放
  assert.equal(contested.isCellBlocked(cell, 112), false, "contested@112 应释放");
});

// ===========================================================================
// 4. 目标龄 <8 tick 不被误清（新鲜目标保护，参考 :5932）
// ===========================================================================

test("spin-blockade: plannedMove 目标龄 >=FRESH_TARGET_TICKS 时 event.blockedTarget 上报", () => {
  // oscillation 检测（窗口 12）：record plannedMove@tick=1，检测@tick=12，age=11>=8 → 上报。
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, moveNoEffectTicks: 99 });
  const deadTarget: Position = [10, 10];
  tracker.recordPlannedMove("w1", deadTarget, 1);
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
  const oscEvents = events.filter((event) => event.kind === "oscillation");
  assert.equal(oscEvents.length, 1, "应触发一次 oscillation");
  const event = oscEvents[0]!;
  assert.deepEqual(event.blockedTarget, deadTarget, "老目标(age>=8) 应作为 blockedTarget 上报");
});

test("spin-blockade: 新鲜目标(age<FRESH_TARGET_TICKS) 不作 blockedTarget（误封锁保护）", () => {
  // record plannedMove@tick=6，检测@tick=12，age=6<8 → 不上报（新鲜目标保护）。
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, moveNoEffectTicks: 99 });
  const freshTarget: Position = [20, 20];
  // 先让 worker 存在并开始振荡，再在 tick=6 登记新鲜目标
  for (let tick = 1; tick <= 5; tick += 1) {
    const position: Position = tick % 2 === 0 ? [1, 0] : [0, 0];
    feed(
      tracker,
      tick,
      position,
      { type: "MOVE", direction: tick % 2 === 0 ? "LEFT" : "RIGHT" },
      tick % 2 === 0 ? "patrol" : "worker_clear_core_empty",
    );
  }
  tracker.recordPlannedMove("w1", freshTarget, 6); // 新鲜目标
  const events = [];
  for (let tick = 6; tick <= 12; tick += 1) {
    const position: Position = tick % 2 === 0 ? [1, 0] : [0, 0];
    events.push(...feed(
      tracker,
      tick,
      position,
      { type: "MOVE", direction: tick % 2 === 0 ? "LEFT" : "RIGHT" },
      tick % 2 === 0 ? "patrol" : "worker_clear_core_empty",
    ));
  }
  const oscEvents = events.filter((event) => event.kind === "oscillation");
  assert.equal(oscEvents.length, 1, "应触发一次 oscillation");
  assert.equal(oscEvents[0]!.blockedTarget, undefined, "新鲜目标(age<8) 不应被上报为 blockedTarget");
});

test("spin-blockade: 非移动失败类（economic_no_progress）不上报 blockedTarget", () => {
  // economic_no_progress 不是 movement-failure，不应触发封锁（封锁只对 oscillation/move_no_effect）。
  const tracker = new WorkerLivenessTracker({ graceTicks: 0 });
  tracker.recordPlannedMove("w1", [30, 30], 1); // 老 target
  const events = [];
  for (let tick = 1; tick <= 7; tick += 1) {
    events.push(...feed(tracker, tick, [40, 289], { type: "WAIT" }, "GO_RESOURCE"));
  }
  const econEvents = events.filter((event) => event.kind === "economic_no_progress");
  assert.equal(econEvents.length, 1, "应触发 economic_no_progress");
  assert.equal(econEvents[0]!.blockedTarget, undefined, "economic_no_progress 不上报 blockedTarget");
});

test("spin-blockade: FRESH_TARGET_TICKS=8 与参考 :5932 一致", () => {
  assert.equal(FRESH_TARGET_TICKS, 8, "新鲜目标阈值 = 8 tick（参考 :5932）");
});

// ===========================================================================
// 5. 变体关零回归（无封锁状态，行为不变）
// ===========================================================================

test("spin-blockade 关零回归: cellBlocker 未提供时 plan() 输出与无封锁完全一致", () => {
  const snap = snapshotOf(makeTurn([planWorker("w1", 0, 0), planWorker("w2", 4, 0)], {
    resourceCells: new Set(["2,0", "2,4"]),
  }));
  const planner = new WorkerTaskPlanner();
  const withoutBlocker = planner.plan(snap);
  // 提供一个从未 blockCell 的 tracker（isCellBlocked 恒 false）→ 行为应不变
  const emptyTracker = new WorkerLivenessTracker();
  const withEmptyBlocker = planner.plan(snap, [], { cellBlocker: emptyTracker });
  assert.deepEqual(
    withEmptyBlocker.assignments.map((a) => ({ id: a.unitId, key: a.task.targetCellKey })),
    withoutBlocker.assignments.map((a) => ({ id: a.unitId, key: a.task.targetCellKey })),
    "空 tracker 不改变分配",
  );
});

test("spin-blockade 关零回归: WorkerLivenessTracker 无 blockCell 时 onObservation 输出不变", () => {
  // 新增的 plannedMoves/temporaryBlocks 状态在未 record/block 时不影响检测。
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
  assert.equal(events.length, 1, "oscillation 检测不变");
  assert.equal(events[0]!.kind, "oscillation");
  assert.equal(events[0]!.blockedTarget, undefined, "未 record plannedMove → blockedTarget 缺省 undefined");
});

// ===========================================================================
// 6. isCellBlocked 到期自动清理（lazy eviction）
// ===========================================================================

test("spin-blockade: isCellBlocked 到期自动清理（lazy eviction，后续读不残留）", () => {
  const tracker = new WorkerLivenessTracker();
  const target: Position = [9, 9];
  tracker.blockCell(target, 10, MOVE_CONTESTED_BLOCK_PENALTY); // 到期 tick=22
  assert.equal(tracker.isCellBlocked(target, 21), true, "tick=21 仍封锁");
  assert.equal(tracker.isCellBlocked(target, 22), false, "tick=22 到期 → 返回 false 并清理");
  // 关键：到期清理后，即使回退到封锁期内的 tick 查询也返回 false（项已被删）
  assert.equal(tracker.isCellBlocked(target, 15), false, "清理后回查 tick=15 也 false（项已删）");
  assert.equal(tracker.isCellBlocked(target, 21), false, "清理后回查 tick=21 也 false");
});

test("spin-blockade: 重复封锁取较晚到期（max，短 penalty 不覆盖长 penalty）", () => {
  const tracker = new WorkerLivenessTracker();
  const target: Position = [3, 3];
  tracker.blockCell(target, 10, MOVE_CONTESTED_BLOCK_PENALTY); // 到期 22
  tracker.blockCell(target, 12, OTHER_MOVE_FAIL_BLOCK_PENALTY); // 到期 16（更早，不应覆盖）
  // tick=20：若 max 生效 → 仍封锁（到期 22）；若被覆盖 → 已释放（到期 16）
  assert.equal(tracker.isCellBlocked(target, 20), true, "短 penalty 不应覆盖长 penalty（取 max 到期）");
  assert.equal(tracker.isCellBlocked(target, 22), false, "tick=22 释放");
});

test("spin-blockade: clearPlannedMove 清除记账后 blockedTarget 不再上报", () => {
  // 登记老目标 → clearPlannedMove → 振荡检测时 blockedTarget=undefined（无 plannedMove）。
  const tracker = new WorkerLivenessTracker({ graceTicks: 0, moveNoEffectTicks: 99 });
  tracker.recordPlannedMove("w1", [11, 11], 1);
  tracker.clearPlannedMove("w1"); // 到达成功（UNIT_MOVE_SUCCEEDED 语义）
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
  const oscEvents = events.filter((event) => event.kind === "oscillation");
  assert.equal(oscEvents.length, 1);
  assert.equal(oscEvents[0]!.blockedTarget, undefined, "clearPlannedMove 后无记账 → 不上报");
});
