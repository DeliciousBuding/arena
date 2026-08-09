/** GO_RESOURCE 领取租约（claim lease，2026-08-09，P0 采矿恢复延伸）。
 *
 * 背景：WorkerTaskPlanner 每 tick Hungarian 只保证"当 tick 一矿一 worker"，
 * previousAssignments + sticky/switchThreshold 是软滞回——新生/慢 worker 在
 * 路上（引擎慢，多 tick/格不动）时，目标格可能被更近的 worker 在下一 tick
 * 抢走，重新分配造成路程浪费与"有矿不采"观感。
 *
 * 本测试钉死租约契约：
 * 1. 同一资源格同时最多一个领取（跨 tick）；
 * 2. 空载 enroute worker 有效目标在短期无位置变化时保留（不被每 tick Hungarian 抢走）；
 * 3. 有真实距离推进时续租（lastProgressTick 更新）；
 * 4. worker 消失/目标消失/敌占/不可采/明确 block/无进展超时/recoverWorker 释放；
 * 5. forced DEPOSIT/HARVEST_CURRENT 优先且不双 claim；
 * 6. 无永久硬锁（无进展 TTL 有界、fail-open）、确定性、热载安全；
 * 7. 可见矿 floor 豁免语义不回退（见 worker-mining-visible-floor.test.ts 补充）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot, type PlanningUnit } from "../src/planning/planning-snapshot.ts";
import type { Position } from "../src/domain/model.ts";
import {
  WorkerTaskPlanner,
  type Assignment,
  type WorkerTaskPlan,
  type PlanOptions,
} from "../src/planning/worker-task-planner.ts";
import { DEFAULT_MISSION_CONFIG } from "../src/planning/mission-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, cargo = 0): PlanningUnit {
  return { id, unitType: "WORKER", position: [x, y], hp: 4, cargo };
}

function makeTurn(units: readonly PlanningUnit[], tick: number, extra: Partial<TurnLike> = {}): TurnLike {
  return {
    tick,
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

function goOf(plan: WorkerTaskPlan, unitId: string) {
  const assignment = plan.assignments.find((a) => a.unitId === unitId);
  return assignment?.task;
}

function assignmentsOf(plan: WorkerTaskPlan): ReadonlyArray<Assignment> {
  return plan.assignments;
}

/** 模拟 cellBlocker（W5 视图）：仅按集合判断。 */
class FakeBlocker {
  private readonly blocked = new Set<string>();
  block(key: string): void { this.blocked.add(key); }
  clear(key: string): void { this.blocked.delete(key); }
  isCellBlocked(target: Position, _tick: number): boolean {
    return this.blocked.has(`${target[0]},${target[1]}`);
  }
}

test("claim lease: 慢 worker 多 tick 同位置，目标不被近 worker 抢走（默认 TTL 内）", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "11,0";
  // T1：w1 领取唯一矿 [11,0]
  const snap1 = snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) }));
  const plan1 = planner.plan(snap1);
  assert.equal(goOf(plan1, "w1")?.type, "GO_RESOURCE", "T1 w1 应领取唯一矿");
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：更近的 w2 出现，w1 原地不动（引擎慢）→ w1 保留，w2 不得抢
  const snap2 = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 5, 0)], 1001, { resourceCells: new Set([mine]) }));
  const plan2 = planner.plan(snap2, assignmentsOf(plan1));
  assert.equal(goOf(plan2, "w1")?.type, "GO_RESOURCE", "T2 w1 应继续持有（租约）");
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine);
  const w2Task = goOf(plan2, "w2");
  assert.ok(!(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine), `w2 不得抢已领取矿，实际 ${JSON.stringify(w2Task)}`);
  // T3：w1 仍未移动 → 仍保留（默认 TTL=10 内）
  const snap3 = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 5, 0)], 1002, { resourceCells: new Set([mine]) }));
  const plan3 = planner.plan(snap3, assignmentsOf(plan2));
  assert.equal(goOf(plan3, "w1")?.targetCellKey, mine, "T3 w1 仍应持有");
  assert.ok(!(goOf(plan3, "w2")?.type === "GO_RESOURCE" && goOf(plan3, "w2")?.targetCellKey === mine), "w2 仍不得抢");
});

test("claim lease: 无进展 TTL 到期释放，近 worker 接替（fail-open）", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "11,0";
  const snap1 = snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) }));
  const plan1 = planner.plan(snap1);
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：无进展（1001-1000=1 < 2）→ 保留
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 5, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "TTL 内应保留");
  // T3：无进展满 TTL（1002-1000=2 >= 2）→ 释放，w2 接替
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 5, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  const w2Task = goOf(plan3, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `TTL 到期后 w2 应接替，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: 真实距离推进续租，超过原始 TTL 仍保留", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "11,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：w1 推进到 [1,0] → 续租（lastProgressTick=1002）
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 1, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "推进后续租");
  // T3：w1 原地（1003-1002=1 < 2），w2 出现 → 仍保留
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 1, 0), worker("w2", 5, 0)], 1003, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  assert.equal(goOf(plan3, "w1")?.targetCellKey, mine, "推进后 TTL 重新计时，应保留");
  assert.ok(!(goOf(plan3, "w2")?.type === "GO_RESOURCE" && goOf(plan3, "w2")?.targetCellKey === mine), "w2 不得抢");
});

test("claim lease: worker 阵亡 → 租约释放，其他 worker 接替（death handoff）", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "8,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：w1 消失（阵亡），w2 在 → w2 领取
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w2", 1, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.ok(goOf(plan2, "w2")?.type === "GO_RESOURCE" && goOf(plan2, "w2")?.targetCellKey === mine, "w1 阵亡后 w2 应接替");
});

test("claim lease: 目标格消失 → 释放（无人再锁）", () => {
  const planner = new WorkerTaskPlanner();
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set(["8,0"]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, "8,0");
  // T2：目标格消失 → 不产生 GO_RESOURCE（含 w2 也不能去）
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 2, 0)], 1001, { resourceCells: new Set() })),
    assignmentsOf(plan1),
  );
  assert.equal(plan2.assignments.filter((a) => a.task.type === "GO_RESOURCE").length, 0, "目标消失后无 GO_RESOURCE");
});

test("claim lease: 敌占目标 → 释放（不锁敌格）", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "8,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 2, 0)], 1001, {
      resourceCells: new Set([mine]),
      visibleEnemies: [{ id: "e1", position: [8, 0], kind: "UNIT", hp: 2 }],
    })),
    assignmentsOf(plan1),
  );
  const go = plan2.assignments.filter((a) => a.task.type === "GO_RESOURCE" && a.task.targetCellKey === mine);
  assert.equal(go.length, 0, "敌占格不得分配 GO_RESOURCE");
});

test("claim lease: 目标不可采（floor 拒 + 陈旧）→ 释放", () => {
  const planner = new WorkerTaskPlanner({ mission: { ...DEFAULT_MISSION_CONFIG, collectionValueFloor: -5, maxCollectionDistance: 24 } });
  const mine = "11,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine, "可见矿 T1 应领取");
  // T2：矿变为不可见 + 陈旧（age 100 + seeded）→ net 远低于 floor → 不可采 → 释放
  const snap2 = snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 5, 0)], 1100, { resourceCells: new Set() }));
  const invisible = new Map(snap2.resourceCells);
  invisible.set(mine, { position: [11, 0], visible: false, lastSeenTick: 1000, seeded: true });
  const plan2 = planner.plan({ ...snap2, resourceCells: invisible }, assignmentsOf(plan1));
  const w1Task = goOf(plan2, "w1");
  assert.ok(!(w1Task?.type === "GO_RESOURCE" && w1Task.targetCellKey === mine), `不可采目标不得继续锁定，实际 ${JSON.stringify(w1Task)}`);
  const w2Task = goOf(plan2, "w2");
  assert.ok(!(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine), "不可采目标 w2 也不得领取");
});

test("claim lease: 明确 block（cellBlocker）→ 释放，解封后他人可领取", () => {
  const planner = new WorkerTaskPlanner();
  const blocker = new FakeBlocker();
  const options: PlanOptions = { cellBlocker: blocker };
  const mine = "8,0";
  const plan1 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })),
    [],
    options,
  );
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：目标格被明确 block → 租约释放（w1 不再持锁）
  blocker.block(mine);
  planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
    options,
  );
  // T3：解封 + w2 更近 → w2 领取（证明 w1 租约已释放）
  blocker.clear(mine);
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 3, 0)], 1002, { resourceCells: new Set([mine]) })),
    [],
    options,
  );
  const w2Task = goOf(plan3, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `解封后 w2 应领取，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: recoverWorker 释放租约", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "8,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  planner.recoverWorker("w1");
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 1, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  const w2Task = goOf(plan2, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `recoverWorker 后 w2 应领取，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: forced DEPOSIT 优先且不双 claim（w2 可领取被释放矿）", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "6,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：w1 满载（cargo=1）→ 强制 DEPOSIT；w2 领取被释放的矿
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0, 1), worker("w2", 2, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.type, "DEPOSIT", "满载 w1 强制回仓");
  const w2Task = goOf(plan2, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `w1 回仓后 w2 应领取，实际 ${JSON.stringify(w2Task)}`);
  const goCount = plan2.assignments.filter((a) => a.task.type === "GO_RESOURCE").length;
  assert.equal(goCount, 1, "一矿一领取（无双 claim）");
});

test("claim lease: HARVEST_CURRENT 独占，无双 claim", () => {
  const planner = new WorkerTaskPlanner();
  const mine = "6,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2：w1 到矿格（cargo=0）→ 强制 HARVEST_CURRENT；w2 不得同格
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 6, 0), worker("w2", 0, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.type, "HARVEST_CURRENT", "w1 站矿应强制采集");
  const go = plan2.assignments.filter((a) => a.task.type === "GO_RESOURCE" && a.task.targetCellKey === mine);
  assert.equal(go.length, 0, "HARVEST_CURRENT 占用格不得再分配 GO_RESOURCE");
});

test("claim lease: 输入顺序确定性（units 逆序 + 跨 tick 租约，输出一致）", () => {
  const mine = "8,0";
  function run(order: "asc" | "desc") {
    const planner = new WorkerTaskPlanner();
    const u1 = worker("w1", 0, 0);
    const u2 = worker("w2", 3, 0);
    const units = order === "asc" ? [u1, u2] : [u2, u1];
    const plan1 = planner.plan(snapshotOf(makeTurn(units, 1000, { resourceCells: new Set([mine]) })));
    const plan2 = planner.plan(
      snapshotOf(makeTurn(units, 1001, { resourceCells: new Set([mine]) })),
      assignmentsOf(plan1),
    );
    return plan2.assignments.map((a) => `${a.unitId}:${a.task.type}:${a.task.targetCellKey ?? "-"}`).sort();
  }
  assert.deepEqual(run("asc"), run("desc"), "units 输入顺序不得影响分配（含跨 tick 租约）");
});

test("claim lease: 与 previous 不一致时不强制（sticky API 兼容，plan() 传自定义 previous）", () => {
  const planner = new WorkerTaskPlanner();
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set(["1,1", "2,0"]) }));
  // 首次调用无 previous：字典序选 "1,1"（并创建租约）
  const plan1 = planner.plan(snap);
  assert.equal(goOf(plan1, "w1")?.targetCellKey, "1,1");
  // 第二次调用传入与租约不一致的 previous（模拟外部喂入上一 tick 分配）：
  // 租约不得强制（无 agreement），sticky 语义保留 → 翻转 "2,0"
  const previous: readonly Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [2, 0], targetCellKey: "2,0" } },
  ];
  const plan2 = planner.plan(snap, previous);
  assert.equal(goOf(plan2, "w1")?.targetCellKey, "2,0", "previous 不一致时租约不强制，sticky 生效");
});

// ===========================================================================
// 续租语义收紧（2026-08-09 follow-up）：只有到 claim target 的 Manhattan
// 距离**严格下降**才算"真实推进"并续 lastProgressTick。侧移（同距）、远离、
// 两格振荡一律不续租——否则任意位置变化都无限续租，违背 bounded/fail-open。
// ===========================================================================

test("claim lease: 侧移同距不续租（TTL 照常到期释放）", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "10,0";
  // T1: w1 [0,0] -> dist 10，领取（lastProgressTick=1000, progressDistance=10）
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2: w1 侧移到 [5,5]（dist 10 不变，同距）-> 不续租；w2 [3,0] 出现仍被租约挡住
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 5, 5), worker("w2", 3, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "同距侧移不释放（租约未到期）");
  assert.ok(!(goOf(plan2, "w2")?.type === "GO_RESOURCE" && goOf(plan2, "w2")?.targetCellKey === mine), "w2 不得抢");
  // T3: tick 1002 - lastProgress 1000 = 2 >= 2 -> 释放，w2 接替
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 5, 5), worker("w2", 3, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  const w2Task = goOf(plan3, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `侧移不算推进，TTL 到期后 w2 应接替，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: 远离目标不续租（TTL 照常到期释放）", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "10,0";
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2: w1 远离到 [-5,0]（dist 15 > 10）-> 不续租
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", -5, 0), worker("w2", 3, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "远离不释放（租约未到期）");
  // T3: TTL 到期（1002-1000=2）-> 释放，w2 接替
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", -5, 0), worker("w2", 3, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  const w2Task = goOf(plan3, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `远离不算推进，TTL 到期后 w2 应接替，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: 两格振荡不续租（TTL 照常到期释放）", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "10,0";
  // T1: w1 [0,0] dist 10 -> 领取
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2: 靠近到 [1,0]（dist 9）-> 续租（lastProgressTick=1001, progressDistance=9）
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 1, 0), worker("w2", 3, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "首次靠近应续租");
  // T3: 振荡回 [0,0]（dist 10 > progressDistance 9）-> 不续租；租约未到期仍挡 w2
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 0, 0), worker("w2", 3, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  assert.equal(goOf(plan3, "w1")?.targetCellKey, mine, "振荡回远格不释放（TTL 内）");
  // T4: 再振荡到 [1,0]（dist 9，非严格下降）-> 不续租；1003-1001=2 >= 2 -> 释放
  const plan4 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 1, 0), worker("w2", 3, 0)], 1003, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan3),
  );
  const w2Task = goOf(plan4, "w2");
  assert.ok(w2Task?.type === "GO_RESOURCE" && w2Task.targetCellKey === mine, `两格振荡不得无限续租，TTL 到期后 w2 应接替，实际 ${JSON.stringify(w2Task)}`);
});

test("claim lease: 正常靠近仍续租（TTL 重新计时，不被近 worker 抢）", () => {
  const planner = new WorkerTaskPlanner({ claimNoProgressTtlTicks: 2 });
  const mine = "10,0";
  // T1: w1 [0,0] dist 10 -> 领取
  const plan1 = planner.plan(snapshotOf(makeTurn([worker("w1", 0, 0)], 1000, { resourceCells: new Set([mine]) })));
  assert.equal(goOf(plan1, "w1")?.targetCellKey, mine);
  // T2: 靠近 [1,0] dist 9 -> 续租（lastProgressTick=1001）
  const plan2 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 1, 0)], 1001, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan1),
  );
  assert.equal(goOf(plan2, "w1")?.targetCellKey, mine, "靠近应续租");
  // T3: 再靠近 [2,0] dist 8 -> 续租（lastProgressTick=1002）；w2 更近（dist 7）出现
  const plan3 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 2, 0), worker("w2", 3, 0)], 1002, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan2),
  );
  assert.equal(goOf(plan3, "w1")?.targetCellKey, mine, "持续靠近应续租并保留");
  // T4: 原地（1003-1002=1 < 2）-> 因 T3 续租而保留（若未续租此刻已释放）
  const plan4 = planner.plan(
    snapshotOf(makeTurn([worker("w1", 2, 0), worker("w2", 3, 0)], 1003, { resourceCells: new Set([mine]) })),
    assignmentsOf(plan3),
  );
  const w1Task = goOf(plan4, "w1");
  assert.equal(w1Task?.type, "GO_RESOURCE", "正常靠近续租，w1 应继续持有");
  assert.equal(w1Task?.targetCellKey, mine);
  assert.ok(!(goOf(plan4, "w2")?.type === "GO_RESOURCE" && goOf(plan4, "w2")?.targetCellKey === mine), "w2 不得抢（租约有效）");
});
