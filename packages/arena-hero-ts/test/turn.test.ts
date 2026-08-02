/** Turn 控制器测试：builder 模式、动作收集、seal、计划排序。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn, Worker, Vanguard, Ranger, Core } from "../src/turn.ts";
import type { PlayerState } from "../src/types.ts";
import { TurnClosedError } from "../src/errors.ts";

function makeState(objects: unknown[]): PlayerState {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources: 4,
    population: 2,
    population_tier: 0,
    upkeep_next_tick: 0,
    champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
    objects: objects as PlayerState["objects"],
    events: [],
  };
}

const workerView = {
  kind: "UNIT",
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  controlled: true,
  position: [0, 1] as const,
  hp: 2,
  unit_type: "WORKER",
  cargo: 0,
};
const coreView = {
  kind: "CORE",
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  controlled: true,
  owner_username: "buding",
  position: [0, 0] as const,
  hp: 5,
  shield: 5,
  state: "NORMAL",
};

test("Turn 拆分 units/workers/core/terrain/enemies", () => {
  const turn = new Turn(1, makeState([workerView, coreView, { kind: "RESOURCE", positions: [[5, 0]] }]), async () => {
    throw new Error("unused");
  });
  assert.equal(turn.workers.length, 1);
  assert.equal(turn.units.length, 1);
  assert.ok(turn.core instanceof Core);
  assert.equal(turn.resourceCells.has("5,0"), true);
  assert.equal(turn.resources, 4);
  assert.equal(turn.resourceCapacity, 10);
});

test("Worker 采集→回家→交付动作序列", () => {
  const turn = new Turn(2, makeState([workerView, coreView]), async () => {
    throw new Error("unused");
  });
  const worker = turn.unit(workerView.id) as Worker;
  worker.harvest();
  let plan = turn.plan;
  assert.deepEqual(plan.unit_actions[workerView.id], { type: "HARVEST" });

  worker.clearAction();
  worker.move("UP");
  plan = turn.plan;
  assert.deepEqual(plan.unit_actions[workerView.id], { type: "MOVE", direction: "UP" });
});

test("计划构建按 unit id 排序（与上游 sorted(str) 一致）", () => {
  const turn = new Turn(3, makeState([workerView, coreView]), async () => {
    throw new Error("unused");
  });
  const w2 = {
    kind: "UNIT",
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    controlled: true,
    position: [1, 1] as const,
    hp: 2,
    unit_type: "VANGUARD",
    cargo: null,
  };
  // 需要重建 turn 包含两个单位
  const turn2 = new Turn(3, makeState([workerView, w2, coreView]), async () => {
    throw new Error("unused");
  });
  turn2.unit(w2.id).wait();
  turn2.unit(workerView.id).wait();
  const plan = turn2.plan;
  const keys = Object.keys(plan.unit_actions);
  assert.equal(keys[0], workerView.id); // aaaa < bbbb
  assert.equal(keys[1], w2.id);
});

test("submit 提交当前排队计划", async () => {
  let submitted: unknown = null;
  const turn = new Turn(4, makeState([workerView, coreView]), async (plan) => {
    submitted = plan;
    return { accepted: true, tick: 4, source: "AGENT", received_at: "2026-08-02T12:00:00Z" };
  });
  (turn.unit(workerView.id) as Worker).harvest();
  turn.core?.spawn("WORKER");
  const result = await turn.submit();
  assert.equal(result.accepted, true);
  assert.deepEqual(submitted, {
    tick: 4,
    unit_actions: { [workerView.id]: { type: "HARVEST" } },
    core_action: { type: "SPAWN", unit_type: "WORKER" },
  });
});

test("replace 用外部计划整体替换排队计划（编排层决策注入）", async () => {
  let submitted: unknown = null;
  const turn = new Turn(4, makeState([workerView, coreView]), async (plan) => {
    submitted = plan;
    return { accepted: true, tick: 4, source: "AGENT", received_at: "2026-08-02T12:00:00Z" };
  });
  (turn.unit(workerView.id) as Worker).harvest(); // 先排动作
  turn.replace({
    tick: 4,
    unit_actions: { [workerView.id]: { type: "MOVE", direction: "UP" } },
    core_action: null,
  });
  await turn.submit();
  assert.deepEqual(submitted, {
    tick: 4,
    unit_actions: { [workerView.id]: { type: "MOVE", direction: "UP" } },
    core_action: null,
  });
});

test("seal 后动作与提交被拒", async () => {
  const turn = new Turn(5, makeState([workerView, coreView]), async () => {
    throw new Error("unused");
  });
  turn._seal();
  assert.throws(() => (turn.unit(workerView.id) as Worker).harvest(), TurnClosedError);
  await assert.rejects(turn.submit(), TurnClosedError);
});

test("Ranger.shoot 从可见目标推导字段", () => {
  const enemyView = {
    kind: "UNIT",
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    controlled: false,
    position: [3, 0] as const,
    hp: 1,
    unit_type: "RANGER",
    cargo: null,
  };
  const rangerView = {
    kind: "UNIT",
    id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    controlled: true,
    position: [0, 0] as const,
    hp: 2,
    unit_type: "RANGER",
    cargo: null,
  };
  const turn = new Turn(6, makeState([rangerView, enemyView, coreView]), async () => {
    throw new Error("unused");
  });
  const ranger = turn.unit(rangerView.id) as Ranger;
  const enemy = turn.visibleEnemies[0];
  ranger.shoot(enemy);
  const plan = turn.plan;
  assert.deepEqual(plan.unit_actions[rangerView.id], {
    type: "SHOOT",
    target_id: enemyView.id,
    expected_cell: [3, 0],
  });
});
