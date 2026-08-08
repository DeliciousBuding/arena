/** 打转封锁（W5）消费接线测试（batch 2 接线）。
 *
 * W5 的封锁能力（WorkerLivenessTracker.blockCell/isCellBlocked/
 * clearPlannedMove/plannedMoves + WorkerTaskPlanner 的 BLOCKADE_PENALTY 消费）
 * 在 spin-blockade.test.ts 已验。本套件验证**接线层**：变体启用时调用方
 * 真正把 cellBlocker 传给 plan()、recordPlannedMove 登记目标、recoverWorker
 * 后 blockCell、UNIT_MOVE_SUCCEEDED 后 clearPlannedMove；变体关时全部
 * no-op（零回归）。
 *
 * 接线点：
 * 1. DeterministicPlanner.decide() → plan() options.cellBlocker（变体开→传 sink、
 *    关→undefined）+ GO_RESOURCE 分配后 recordPlannedMove（变体开→登记、关→不登记）。
 * 2. tenant-runtime.applyBlockadeBlocks（recoverWorker 后 blockCell，penalty 按 kind）。
 * 3. tenant-runtime.applyBlockadeClearPlannedMoves（UNIT_MOVE_SUCCEEDED 后清账）。
 *
 * 用 fake BlockadeSink / fake block-sink 验证（不依赖真实 WorkerLivenessTracker
 * 内部状态），保证接线层与能力层解耦。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, UnitAction } from "../src/domain/model.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import {
  DeterministicPlanner,
  type BlockadeSink,
  type DeterministicPlannerInput,
} from "../src/planning/deterministic-planner.ts";
import { DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import type { WorkerLivenessEvent, WorkerLivenessKind } from "../src/runtime/worker-liveness.ts";
import {
  MOVE_CONTESTED_BLOCK_PENALTY,
  OTHER_MOVE_FAIL_BLOCK_PENALTY,
} from "../src/runtime/worker-liveness.ts";
import {
  applyBlockadeBlocks,
  applyBlockadeClearPlannedMoves,
  blockadePenaltyTicksFor,
} from "../src/app/tenant-runtime.ts";

// ---- 夹具 ----

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function planWorker(id: string, x: number, y: number, cargo = 0) {
  return { id, position: [x, y] as const, hp: 5, unitType: "WORKER" as const, cargo };
}

function makeTurn(
  units: readonly ReturnType<typeof planWorker>[] = [],
  extra: Partial<TurnLike> = {},
): TurnLike {
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

function inputOf(turn: TurnLike): DeterministicPlannerInput {
  return { state: reduceTurn(turn) };
}

/** Fake BlockadeSink：记录 isCellBlocked / recordPlannedMove 调用，isCellBlocked
 *  可编程返回（默认 false = 不封锁，纯验证调用发生）。 */
class FakeBlockadeSink implements BlockadeSink {
  readonly isCellBlockedCalls: { target: Position; tick: number }[] = [];
  readonly recordPlannedMoveCalls: { unitId: string; target: Position; tick: number | undefined }[] = [];
  private readonly blockedCells: Set<string> = new Set();
  private blockReturn: boolean = false;

  markBlocked(cell: Position): void {
    this.blockedCells.add(`${cell[0]},${cell[1]}`);
    this.blockReturn = true;
  }

  isCellBlocked(target: Position, currentTick: number): boolean {
    this.isCellBlockedCalls.push({ target: [target[0], target[1]], tick: currentTick });
    return this.blockedCells.has(`${target[0]},${target[1]}`);
  }

  recordPlannedMove(unitId: string, target: Position, currentTick?: number): void {
    this.recordPlannedMoveCalls.push({
      unitId,
      target: [target[0], target[1]],
      tick: currentTick,
    });
  }
}

/** Fake block-sink（只记录 blockCell，供 applyBlockadeBlocks 验证）。 */
class FakeBlockCellSink {
  readonly blockCellCalls: { target: Position; tick: number; penalty: number }[] = [];
  blockCell(target: Position, currentTick: number, penaltyTicks: number): void {
    this.blockCellCalls.push({
      target: [target[0], target[1]],
      tick: currentTick,
      penalty: penaltyTicks,
    });
  }
}

/** Fake clear-sink（只记录 clearPlannedMove，供 applyBlockadeClearPlannedMoves 验证）。 */
class FakeClearPlannedMoveSink {
  readonly clearedUnitIds: string[] = [];
  clearPlannedMove(unitId: string): void {
    this.clearedUnitIds.push(unitId);
  }
}

/** 构造一个最小 WorkerLivenessEvent（只填接线测试需要的字段）。 */
function livenessEvent(overrides: Partial<WorkerLivenessEvent> & { unitId: string; tick: number; kind: WorkerLivenessKind }): WorkerLivenessEvent {
  const base = {
    streak: 1,
    position: [0, 0] as Position,
    cargo: 0,
    priorActionType: "MOVE" as UnitAction["type"],
    priorIntent: "patrol",
    recentPositions: [] as readonly Position[],
    uniqueRecentPositions: 0,
    explorationChunk: "0,0",
    knownExplorationChunks: 0,
    recoveryCount: 0,
  };
  return { ...base, ...overrides } as WorkerLivenessEvent;
}

// ===========================================================================
// 1. plan() cellBlocker 接线（DeterministicPlanner.decide → plan options.cellBlocker）
// ===========================================================================

test("接线 plan cellBlocker: 变体开 → plan() 收到 cellBlocker（isCellBlocked 被调）", () => {
  // 单 worker [0,0]、两可见矿 [2,0] / [2,4]。decide() 后 fakeSink 应被
  // isCellBlocked 询问候选格——证明 cellBlocker 透传到 Hungarian 候选排序。
  const sink = new FakeBlockadeSink();
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: true };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0", "2,4"]) });
  planner.decide(inputOf(turn));

  assert.ok(sink.isCellBlockedCalls.length > 0, "变体开时 plan() 应调用 sink.isCellBlocked 询问候选格");
});

test("接线 plan cellBlocker: 变体关 → plan() 不收到 cellBlocker（isCellBlocked 零调用）", () => {
  // 同场景，spinBlockade=false → cellBlocker=undefined → isCellBlocked 永不被调。
  const sink = new FakeBlockadeSink();
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: false };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0", "2,4"]) });
  planner.decide(inputOf(turn));

  assert.equal(sink.isCellBlockedCalls.length, 0, "变体关时 plan() 不应调用 sink.isCellBlocked（零回归）");
});

test("接线 plan cellBlocker: 未注入 sink 但变体开 → 仍零回归（cellBlocker=undefined）", () => {
  // sink=null + spinBlockade=true → plan() cellBlocker=undefined（不抛错、不封锁）。
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  // 不调 setBlockadeSink（sink=null）
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: true };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0"]) });
  // 不应抛错——sink 缺失时 plan() 用 undefined cellBlocker（零回归）
  const plan = planner.decide(inputOf(turn));
  assert.ok(plan.unitActions["w1"] !== undefined, "sink 缺失时仍正常分配（不抛错）");
});

// ===========================================================================
// 2. recordPlannedMove 接线（GO_RESOURCE 分配后登记目标格）
// ===========================================================================

test("接线 recordPlannedMove: 变体开 → GO_RESOURCE 分配后登记目标格 + tick", () => {
  // worker [0,0]、近矿 [2,0] 可见 → Hungarian 分配 GO_RESOURCE→[2,0]。
  // 变体开时 decide() 应调 sink.recordPlannedMove("w1", [2,0], tick=10)。
  const sink = new FakeBlockadeSink();
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: true };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0"]) });
  planner.decide(inputOf(turn));

  const recorded = sink.recordPlannedMoveCalls.find((call) => call.unitId === "w1");
  assert.ok(recorded !== undefined, "变体开时 GO_RESOURCE 分配应登记 recordPlannedMove");
  assert.deepEqual(recorded!.target, [2, 0], "登记的目标格应为 [2,0]");
  assert.equal(recorded!.tick, 10, "登记的 tick 应为 snapshot.tick=10");
});

test("接线 recordPlannedMove: 变体关 → 不登记 recordPlannedMove（零回归）", () => {
  const sink = new FakeBlockadeSink();
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: false };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0"]) });
  planner.decide(inputOf(turn));

  assert.equal(sink.recordPlannedMoveCalls.length, 0, "变体关时不应登记 recordPlannedMove（零回归）");
});

test("接线 recordPlannedMove: 封锁生效后 worker 改派远格（端到端 W5 闭环）", () => {
  // sink 标记 [2,0] 封锁 → Hungarian 应改派 worker 去远格 [2,4]。
  // 证明 cellBlocker 真正影响分配结果（不只是被调用）。方向由 pathing
  // tie-break 决定（可能 RIGHT 或 DOWN，均朝 [2,4]），故只验分配目标。
  const sink = new FakeBlockadeSink();
  sink.markBlocked([2, 0]);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  const safetyConfig: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, spinBlockade: true };
  planner.updateConfig(safetyConfig, {});

  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0", "2,4"]) });
  const plan = planner.decide(inputOf(turn));

  // worker 应被分配 GO_RESOURCE→[2,4]（远格），而非被封锁的近格 [2,0]
  const action = plan.unitActions["w1"];
  assert.ok(action !== undefined, "worker 应有动作");
  assert.equal(plan.intents?.["w1"], "GO_RESOURCE", "intent 应为 GO_RESOURCE");
  // recordPlannedMove 应登记 [2,4]（改派后的目标），不是被封锁的 [2,0]
  const recorded = sink.recordPlannedMoveCalls.find((call) => call.unitId === "w1");
  assert.ok(recorded !== undefined, "改派后仍应登记新目标");
  assert.deepEqual(recorded!.target, [2, 4], "登记的应是改派后的远格 [2,4]（避开封锁的 [2,0]）");
});

// ===========================================================================
// 3. recoverWorker → blockCell 接线（applyBlockadeBlocks）
// ===========================================================================

test("接线 blockCell: 变体开 + blockedTarget 存在 → blockCell 被调用", () => {
  // oscillation 事件带 blockedTarget=[5,5]、tick=20 → blockCell([5,5], 20, 16)
  const sink = new FakeBlockCellSink();
  const events = [
    livenessEvent({ unitId: "w1", tick: 20, kind: "oscillation", blockedTarget: [5, 5] }),
  ];
  applyBlockadeBlocks(events, sink, true);
  assert.equal(sink.blockCellCalls.length, 1, "变体开 + blockedTarget 存在 → 应调一次 blockCell");
  assert.deepEqual(sink.blockCellCalls[0]!.target, [5, 5], "封锁目标 = event.blockedTarget");
  assert.equal(sink.blockCellCalls[0]!.tick, 20, "tick = event.tick");
  assert.equal(sink.blockCellCalls[0]!.penalty, 16, "oscillation penalty=16");
});

test("接线 blockCell: 变体关 → blockCell 零调用（零回归）", () => {
  const sink = new FakeBlockCellSink();
  const events = [
    livenessEvent({ unitId: "w1", tick: 20, kind: "oscillation", blockedTarget: [5, 5] }),
  ];
  applyBlockadeBlocks(events, sink, false);
  assert.equal(sink.blockCellCalls.length, 0, "变体关 → 不调 blockCell");
});

test("接线 blockCell: blockedTarget 缺省（非 movement-failure 类）→ 不调 blockCell", () => {
  // economic_no_progress 不带 blockedTarget（computeBlockedTarget 返回 undefined）
  const sink = new FakeBlockCellSink();
  const events = [
    livenessEvent({ unitId: "w1", tick: 20, kind: "economic_no_progress" }),
  ];
  applyBlockadeBlocks(events, sink, true);
  assert.equal(sink.blockCellCalls.length, 0, "blockedTarget 缺省 → 不调 blockCell");
});

test("接线 blockCell: penalty 按 kind（oscillation=16 / move_no_effect=12 / 其他=4）", () => {
  assert.equal(blockadePenaltyTicksFor("oscillation"), 16, "oscillation=16（STUCK_TICKS 量级）");
  assert.equal(blockadePenaltyTicksFor("move_no_effect"), MOVE_CONTESTED_BLOCK_PENALTY, "move_no_effect=12（MOVE_CONTESTED）");
  assert.equal(blockadePenaltyTicksFor("economic_no_progress"), OTHER_MOVE_FAIL_BLOCK_PENALTY, "其他=4");
  assert.equal(MOVE_CONTESTED_BLOCK_PENALTY, 12, "常量校验");
  assert.equal(OTHER_MOVE_FAIL_BLOCK_PENALTY, 4, "常量校验");

  // 多事件混合：每个按各自 kind 的 penalty
  const sink = new FakeBlockCellSink();
  const events = [
    livenessEvent({ unitId: "w1", tick: 10, kind: "oscillation", blockedTarget: [1, 1] }),
    livenessEvent({ unitId: "w2", tick: 10, kind: "move_no_effect", blockedTarget: [2, 2] }),
  ];
  applyBlockadeBlocks(events, sink, true);
  assert.equal(sink.blockCellCalls.length, 2, "两事件各调一次");
  assert.equal(sink.blockCellCalls[0]!.penalty, 16, "oscillation→16");
  assert.equal(sink.blockCellCalls[1]!.penalty, 12, "move_no_effect→12");
});

// ===========================================================================
// 4. UNIT_MOVE_SUCCEEDED → clearPlannedMove 接线（applyBlockadeClearPlannedMoves）
// ===========================================================================

test("接线 clearPlannedMove: 变体开 + UNIT_MOVE_SUCCEEDED → clearPlannedMove 被调", () => {
  // 两个 UNIT_MOVE_SUCCEEDED 事件（actorId=w1 / w2）+ 一个 UNIT_MOVE_FAILED（应忽略）
  const sink = new FakeClearPlannedMoveSink();
  const events = [
    { eventType: "UNIT_MOVE_SUCCEEDED", actorId: "w1" },
    { eventType: "UNIT_MOVE_FAILED", actorId: "w3" },
    { eventType: "UNIT_MOVE_SUCCEEDED", actorId: "w2" },
  ];
  applyBlockadeClearPlannedMoves(events, sink, true);
  assert.deepEqual(sink.clearedUnitIds, ["w1", "w2"], "只清 UNIT_MOVE_SUCCEEDED 的 actorId");
});

test("接线 clearPlannedMove: 变体关 → 零调用（零回归）", () => {
  const sink = new FakeClearPlannedMoveSink();
  const events = [{ eventType: "UNIT_MOVE_SUCCEEDED", actorId: "w1" }];
  applyBlockadeClearPlannedMoves(events, sink, false);
  assert.equal(sink.clearedUnitIds.length, 0, "变体关 → 不调 clearPlannedMove");
});

test("接线 clearPlannedMove: actorId=null 的事件跳过（不调 clearPlannedMove(null)）", () => {
  const sink = new FakeClearPlannedMoveSink();
  const events = [
    { eventType: "UNIT_MOVE_SUCCEEDED", actorId: null },
    { eventType: "UNIT_MOVE_SUCCEEDED", actorId: "w1" },
  ];
  applyBlockadeClearPlannedMoves(events, sink, true);
  assert.deepEqual(sink.clearedUnitIds, ["w1"], "actorId=null 跳过，只清有效 actorId");
});

// ===========================================================================
// 5. 热加载：updateConfig 切换 spinBlockade 开关即生效
// ===========================================================================

test("接线 热加载: updateConfig 从 spinBlockade=false 切到 true → 下一 decide 消费 cellBlocker", () => {
  const sink = new FakeBlockadeSink();
  const planner = new DeterministicPlanner(new WorkerTaskPlanner());
  planner.setBlockadeSink(sink);
  // 初始关
  planner.updateConfig({ ...DEFAULT_SAFETY_CONFIG, spinBlockade: false }, {});
  const turn = makeTurn([planWorker("w1", 0, 0)], { resourceCells: new Set(["2,0"]) });
  planner.decide(inputOf(turn));
  assert.equal(sink.isCellBlockedCalls.length, 0, "初始关 → 不消费 cellBlocker");
  assert.equal(sink.recordPlannedMoveCalls.length, 0, "初始关 → 不登记 recordPlannedMove");

  // 热切到开
  planner.updateConfig({ ...DEFAULT_SAFETY_CONFIG, spinBlockade: true }, {});
  sink.isCellBlockedCalls.length = 0;
  sink.recordPlannedMoveCalls.length = 0;
  planner.decide(inputOf(turn));
  assert.ok(sink.isCellBlockedCalls.length > 0, "热切开后 → 消费 cellBlocker");
  assert.ok(sink.recordPlannedMoveCalls.length > 0, "热切开后 → 登记 recordPlannedMove");
});
