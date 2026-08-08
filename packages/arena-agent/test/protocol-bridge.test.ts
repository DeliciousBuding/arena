/**
 * 协议翻译层测试（2026-08-08，对抗测试平台）：
 * TickState → ProtoPlayerState → (bridge) → Plan 的无损翻译闭环。
 * 也验证 Plan → ProtoCommandPlan 反向翻译（供对手复制/评估预留）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  protoPlanToPlan,
  tickStateToProto,
  unitActionToProto,
  coreActionToProto,
  type ProtoCommandPlan,
} from "../src/sim/opponent/protocol-bridge.ts";
import type { TickState } from "../src/domain/model.ts";

const SELF = "player-a";

function makeState(overrides: Partial<TickState> = {}): TickState {
  return {
    tick: 10,
    status: "ACTIVE",
    resources: 12,
    resourceCapacity: 20,
    resourceSpace: 8,
    population: 2,
    core: {
      id: "11111111-1111-1111-1111-111111111111",
      position: [0, 0],
      hp: 5,
      shield: 4,
      state: "NORMAL",
      ownerUsername: SELF,
    },
    units: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 1 },
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", position: [3, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    workers: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    vanguards: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", position: [3, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    rangers: [],
    visibleEnemies: [
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", kind: "UNIT", position: [8, 0], hp: 2, unitType: "WORKER" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2", kind: "CORE", position: [20, 0], hp: 5, ownerUsername: "enemy-p" },
    ],
    resourceCells: new Set(["5,0", "0,5"]),
    obstacleCells: new Set(["9,0"]),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

test("tickStateToProto：可控/不可控/地形/beacon 全转换", () => {
  const proto = tickStateToProto(makeState(), SELF);
  assert.equal(proto.resources, 12);
  assert.equal(proto.population, 2);
  // 核心：可控
  const cores = proto.objects.filter((o): o is Extract<typeof o, { kind: "CORE" }> => o.kind === "CORE");
  const mineCore = cores.find((c) => c.controlled);
  assert.ok(mineCore, "应有受控核心");
  assert.equal(mineCore.owner_username, SELF);
  assert.equal(mineCore.state, "NORMAL");
  // 己方单位
  const units = proto.objects.filter((o): o is Extract<typeof o, { kind: "UNIT" }> => o.kind === "UNIT");
  const mine = units.filter((u) => u.controlled);
  assert.equal(mine.length, 2);
  const worker = mine.find((u) => u.unit_type === "WORKER");
  assert.equal(worker?.cargo, 1, "受控 worker 暴露 cargo");
  // 敌方 worker：受控为 false，cargo null
  const enemyWorker = units.find((u) => !u.controlled && u.unit_type === "WORKER");
  assert.equal(enemyWorker?.controlled, false);
  assert.equal(enemyWorker?.cargo, null);
  // 敌方核心：受控 false
  assert.equal(cores.filter((c) => !c.controlled).length, 1);
  // 地形
  assert.ok(proto.objects.some((o) => o.kind === "OBSTACLE"));
  assert.ok(proto.objects.some((o) => o.kind === "RESOURCE"));
  // beacon
  assert.equal(proto.champion_beacon.position[0], 100);
});

test("protoPlanToPlan：官方动作 ↔ 模拟器动作 无损往返", () => {
  const cmd: ProtoCommandPlan = {
    tick: 10,
    unit_actions: {
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1": { type: "MOVE", direction: "UP" },
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2": { type: "SWEEP", direction: "LEFT" },
    },
    core_action: { type: "SPAWN", unit_type: "WORKER" },
  };
  const plan = protoPlanToPlan(cmd, "ext");
  assert.equal(plan.tick, 10);
  const workerAction = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"];
  assert.deepEqual(workerAction, { type: "MOVE", direction: "UP" });
  const vanguardAction = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2"];
  assert.deepEqual(vanguardAction, { type: "SWEEP", direction: "LEFT" });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  // intent 标 external
  assert.equal(plan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1"], "ext");
});

test("反向：Plan → ProtoCommandPlan（封闭翻译面）", () => {
  const proto = unitActionToProto({ type: "SHOOT", targetId: "x", expectedCell: [1, 2] });
  assert.deepEqual(proto, { type: "SHOOT", target_id: "x", expected_cell: [1, 2] });
  const coreProto = coreActionToProto({ type: "START_MOVE", direction: "RIGHT" });
  assert.deepEqual(coreProto, { type: "START_MOVE", direction: "RIGHT" });
});