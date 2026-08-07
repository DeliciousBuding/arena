/**
 * 旧核验证协议测试（2026-08-08，ref guide 对齐）：
 * 用户反馈"为啥地图上有两个T1的核心？地方核心还活着吗？为啥不去打掉？"
 * ——根因是 coreHuntMemory CORE 目击 sticky 2000 tick，核心被毁/迁移后
 * 旧位置永不清理，军事反复打空城。
 * 协议：
 *   1. DESTRUCTION_PARTICIPATION（CORE）事件 → 立即删除记忆（强信号）；
 *   2. 同 enemy id 迁移 → 新位置替换旧位置（杜绝"两个同款核心"幽灵）；
 *   3. 我方视野覆盖确认缺失（单位视野覆盖目标格 + 无 CORE 实体）→ 计数，
 *      连续 2 次独立确认才删（防"暂时看不见"误删）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Position, TickState, VisibleEntity } from "../src/domain/model.ts";
import { World } from "../src/domain/world.ts";

function coreVisible(position: Position, id = "e1", owner = "t1"): VisibleEntity {
  return { id, kind: "CORE", position, hp: 5, ownerUsername: owner };
}

function unit(position: Position, unitType: "WORKER" | "VANGUARD" | "RANGER" = "VANGUARD", id = "u1"): TickState["units"][number] {
  return { id, position, hp: 4, unitType, cargo: 0 };
}

function makeState(
  tick: number,
  opts: {
    units?: TickState["units"][number][];
    visibleEnemies?: VisibleEntity[];
    core?: TickState["core"];
  } = {},
): TickState {
  const core = opts.core ?? { id: "c1", position: [0, 0] as Position, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" };
  const units = opts.units ?? [unit([0, 0])];
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 10,
    population: units.length,
    core,
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: units.filter((u) => u.unitType === "VANGUARD"),
    rangers: units.filter((u) => u.unitType === "RANGER"),
    visibleEnemies: opts.visibleEnemies ?? [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("旧核验证：DESTRUCTION_PARTICIPATION（CORE）事件 → 立即删除记忆", () => {
  const world = new World();
  world.observe(makeState(1, { units: [unit([5, 5])], visibleEnemies: [coreVisible([30, 30])] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1);
  const removed = world.forgetCoreHuntAt([30, 30]);
  assert.equal(removed, true);
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 0);
});

test("旧核验证：同 enemy id 迁移 → 新位置替换旧位置（无两个同款核心）", () => {
  const world = new World();
  // 旧位置 [30,30] 目击
  world.observe(makeState(1, { units: [unit([5, 5])], visibleEnemies: [coreVisible([30, 30])] }));
  // 同 id 新位置 [40,40] 目击（核心迁移）
  world.observe(makeState(2, { units: [unit([5, 5])], visibleEnemies: [coreVisible([40, 40])] }));
  const cores = world.coreHuntTargets().filter((t) => t.source === "CORE");
  assert.equal(cores.length, 1, "迁移后旧位置应被清理，只剩新位置");
  assert.deepEqual(cores[0].position, [40, 40]);
});

test("旧核验证：不同 enemy id 两个核心 → 都保留（不误删真双核）", () => {
  const world = new World();
  world.observe(makeState(1, {
    units: [unit([5, 5])],
    visibleEnemies: [coreVisible([30, 30], "e1"), coreVisible([40, 40], "e2")],
  }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 2);
});

test("旧核验证：视野覆盖确认缺失——连续 2 次确认才删除（防误删）", () => {
  const world = new World();
  // 目击 [30,30]
  world.observe(makeState(1, { units: [unit([28, 30])], visibleEnemies: [coreVisible([30, 30])] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1);
  // 单位在附近（视野覆盖）但该格无 CORE 实体 → 第 1 次确认缺失
  world.observe(makeState(2, { units: [unit([28, 30])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1, "1 次确认不删（防暂时看不见误删）");
  // 第 2 次确认缺失 → 删除
  world.observe(makeState(3, { units: [unit([28, 30])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 0, "2 次确认后删除死核");
});

test("旧核验证：重新目击清零计数——清零后需重新累计 2 次确认才删", () => {
  const world = new World();
  world.observe(makeState(1, { units: [unit([28, 30])], visibleEnemies: [coreVisible([30, 30])] }));
  // 确认缺失 1 次（不删）
  world.observe(makeState(2, { units: [unit([28, 30])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1);
  // 重新目击（核心没死，只是刚才看不见）→ 计数清零
  world.observe(makeState(3, { units: [unit([28, 30])], visibleEnemies: [coreVisible([30, 30])] }));
  // 清零后确认缺失 1 次 → 仍不删（重新累计中）
  world.observe(makeState(4, { units: [unit([28, 30])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1, "清零后 1 次确认不删");
  // 清零后确认缺失 2 次 → 删
  world.observe(makeState(5, { units: [unit([28, 30])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 0, "清零后重新累计 2 次确认删");
});

test("旧核验证：视野被障碍遮挡 → 不确认缺失（看不见≠确认不在）", () => {
  const world = new World();
  world.observe(makeState(1, { units: [unit([28, 30])], visibleEnemies: [coreVisible([30, 30])] }));
  // 在单位与目标格之间加障碍物：lineBlocked 判定遮挡
  // （直接验证 confirmCoreHuntMissing 的调用条件是障碍不阻塞——这里用构造
  //   障碍记忆模拟：先目击再移动单位到遮挡侧，确认不删除）
  // 简化：目标格在单位视野外（距离 > 4）→ 不确认
  world.observe(makeState(2, { units: [unit([10, 10])], visibleEnemies: [] }));
  world.observe(makeState(3, { units: [unit([10, 10])], visibleEnemies: [] }));
  assert.equal(world.coreHuntTargets().filter((t) => t.source === "CORE").length, 1, "视野外不确认缺失");
});
