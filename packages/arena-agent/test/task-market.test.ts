import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateAllianceTaskMarket,
  allianceTaskBid,
  expandAllianceMarketTaskSlots,
  type AllianceMarketTask,
} from "../src/alliance/task-market.ts";
import type { AllianceMemberState } from "../src/alliance/types.ts";
import type { TenantThreatSummary } from "../src/alliance/threat-summary.ts";

function member(
  tenantId: string,
  opts: Partial<AllianceMemberState> & { military?: number; corePosition?: readonly [number, number] } = {},
): AllianceMemberState {
  const military = opts.military ?? 6;
  return {
    tenantId,
    tick: opts.tick ?? 80,
    observedAtMs: opts.observedAtMs ?? 80_000,
    core: {
      id: `${tenantId}-core`,
      position: opts.corePosition ?? [0, 0],
      hp: opts.core?.hp ?? 5,
      shield: opts.core?.shield ?? 5,
      moving: false,
    },
    resources: opts.resources ?? 10,
    resourceCapacity: opts.resourceCapacity ?? 50,
    population: opts.population ?? 8,
    workers: opts.workers ?? 4,
    vanguards: opts.vanguards ?? military,
    rangers: opts.rangers ?? 0,
    carriedResources: 0,
    activeFleetIds: opts.activeFleetIds ?? [],
    localThreat: opts.localThreat ?? 0,
    localHarvestRate: 0,
    status: opts.status ?? "READY",
  };
}

function task(
  id: string,
  kind: "RAID" | "ESCORT",
  target: readonly [number, number],
  opts: Partial<AllianceMarketTask> = {},
): AllianceMarketTask {
  return {
    id,
    kind,
    priority: opts.priority ?? 70,
    target,
    targetEntityKey: opts.targetEntityKey,
    defendTenant: opts.defendTenant,
    minMilitary: opts.minMilitary ?? 6,
    maxDistance: opts.maxDistance ?? 64,
    slotCount: opts.slotCount,
  };
}

const NO_SUMMARY = new Map<string, TenantThreatSummary>();

test("market: 每 tenant 至多一个任务（全局一对一清算）", () => {
  const members = [member("t1"), member("t2"), member("t3")];
  const tasks = [
    task("raid-A", "RAID", [20, 0]),
    task("raid-B", "RAID", [-20, 0]),
    task("raid-C", "RAID", [0, 20]),
  ];
  const result = allocateAllianceTaskMarket(members, tasks, NO_SUMMARY, "t4");
  assert.equal(result.assignments.length, 3);
  const tenants = new Set(result.assignments.map((a) => a.tenantId));
  assert.equal(tenants.size, 3);
  // 每个任务最多被一个 tenant 拿走
  const taskIds = new Set(result.assignments.map((a) => a.task.id));
  assert.equal(taskIds.size, 3);
});

test("market: 兵力不足/超距 → 不可行 bid 被跳过，不贪心抢任务", () => {
  const weak = member("t1", { military: 2, corePosition: [0, 0] });
  const strong = member("t2", { military: 10, corePosition: [100, 0] });
  const farTask = task("raid-far", "RAID", [0, 60], { minMilitary: 6 });
  const result = allocateAllianceTaskMarket([weak, strong], [farTask], NO_SUMMARY, "t3");
  // weak 兵力不足不 eligible；strong 超 maxDistance 不 eligible → 无分配
  assert.equal(result.assignments.length, 0);
  const bids = result.bids;
  assert.equal(bids.filter((b) => b.eligible).length, 0);
});

test("market: treasury 保留 penalty——非 treasury 同等条件优先中标", () => {
  const treasury = member("t1", { resources: 30, corePosition: [0, 0] });
  const other = member("t2", { resources: 30, corePosition: [0, 0] });
  const raid = task("raid-A", "RAID", [10, 0]);
  const result = allocateAllianceTaskMarket([treasury, other], [raid], NO_SUMMARY, "t1");
  // 两者除 treasuryPenalty(18) 外全同 → t2 中标
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0]?.tenantId, "t2");
});

test("market: defendTenant 自守排除——local defense 不进市场", () => {
  const members = [member("t1"), member("t2")];
  const escorts = [
    task("assist-t1", "ESCORT", [0, 0], { defendTenant: "t1", minMilitary: 2 }),
    task("assist-t2", "ESCORT", [0, 0], { defendTenant: "t2", minMilitary: 2 }),
  ];
  const result = allocateAllianceTaskMarket(members, escorts, NO_SUMMARY, "t3");
  // t1 不能自守 assist-t1，t2 不能自守 assist-t2 → 交叉支援
  const t1 = result.assignments.find((a) => a.tenantId === "t1");
  const t2 = result.assignments.find((a) => a.tenantId === "t2");
  assert.equal(t1?.task.id, "assist-t2");
  assert.equal(t2?.task.id, "assist-t1");
});

test("market: multi-slot RAID 展开为独立 slot，联合任务可多 tenant 中标", () => {
  const members = [member("t1"), member("t2"), member("t3")];
  const joint = task("raid-core", "RAID", [15, 15], { slotCount: 2, minMilitary: 5, priority: 72 });
  const expanded = expandAllianceMarketTaskSlots([joint]);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0]?.id, "raid-core#slot-1");
  assert.equal(expanded[0]?.baseTaskId, "raid-core");
  assert.equal(expanded[1]?.slotIndex, 1);

  const result = allocateAllianceTaskMarket(members, [joint], NO_SUMMARY, "t4");
  const raidAssignments = result.assignments.filter((a) => a.task.baseTaskId === "raid-core");
  // 两个 slot 各被不同 tenant 中标（3 个 eligible tenant → 2 slot 均填满）
  assert.equal(raidAssignments.length, 2);
  assert.equal(new Set(raidAssignments.map((a) => a.tenantId)).size, 2);
});

test("market: utility 确定性——同输入同输出", () => {
  const members = [member("t1"), member("t2")];
  const tasks = [task("raid-A", "RAID", [10, 0])];
  const first = allocateAllianceTaskMarket(members, tasks, NO_SUMMARY, "t3");
  const second = allocateAllianceTaskMarket(members, tasks, NO_SUMMARY, "t3");
  assert.deepEqual(first, second);
});

test("market: 单 bid 确定性成分——utility 由 priority/force/distance/threat 决定", () => {
  const bid = allianceTaskBid(
    member("t1", { military: 8, resources: 20, corePosition: [5, 0] }),
    task("raid-A", "RAID", [10, 0]),
    undefined,
    "t4",
  );
  assert.equal(bid.eligible, true);
  assert.equal(bid.military, 8);
  assert.equal(bid.distance, 5);
  assert.equal(bid.threatPenalty, 0);
  // utility = 70*2 + 8*8 + 3 - 5*0.75 - 0 - 0
  assert.equal(bid.utility, 140 + 64 + 3 - 3.75);
});
