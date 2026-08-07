/**
 * 桥接三件套（canonical-uuid / official-state / official-plan）单元测试：
 * - canonical_uuid 确定性（同 ID 恒同 UUID、跨 tick 稳定、格式合法）；
 * - official-state 形状（snake_case 顶层/objects 判别器/事件 UUID 化）；
 * - official-plan 解析（动作映射/uuid 反查/未知动作 fail-open/未知单位丢弃）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalUuid } from "../src/sim/bridge/canonical-uuid.ts";
import { stateToOfficialJson } from "../src/sim/bridge/official-state.ts";
import { planFromOfficialJson } from "../src/sim/bridge/official-plan.ts";
import type { TickState } from "../src/domain/model.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("canonical uuid: deterministic and format-valid", () => {
  assert.equal(canonicalUuid("w1"), canonicalUuid("w1"));
  assert.notEqual(canonicalUuid("w1"), canonicalUuid("w2"));
  assert.match(canonicalUuid("w1"), UUID_RE);
});

function sampleState(): TickState {
  return {
    tick: 42,
    status: "ACTIVE",
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    population: 2,
    core: {
      id: "core-1",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      ownerUsername: "test_player",
    },
    units: [],
    workers: [{ id: "w1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 1 }],
    vanguards: [],
    rangers: [],
    visibleEnemies: [{ id: "e1", kind: "UNIT", position: [10, 10], hp: 4, unitType: "VANGUARD" }],
    resourceCells: new Set(["5,5", "6,6"]),
    obstacleCells: new Set(["-1,-1"]),
    beacon: { position: [0, 0], status: "GROUND", carrierId: null },
    events: [
      {
        eventId: "sim:1:0:DEPOSIT_SUCCEEDED:w1",
        tick: 41,
        eventType: "DEPOSIT_SUCCEEDED",
        reasonCode: null,
        actorId: "w1",
        targetId: null,
        position: [0, 0],
        values: {},
      },
    ],
  };
}

test("official state: snake_case shape with kind discriminators", () => {
  const json = stateToOfficialJson(sampleState());
  assert.equal(json.status, "ACTIVE");
  assert.equal(json.resources, 3);
  assert.equal(json.population_tier, 0);
  const objects = json.objects as Array<Record<string, unknown>>;
  assert.equal(objects.length, 5); // CORE + worker + enemy + OBSTACLE + RESOURCE
  assert.equal(objects[0].kind, "CORE");
  assert.equal(objects[0].owner_username, "test_player");
  assert.equal(objects[1].kind, "UNIT");
  assert.equal(objects[1].cargo, 1);
  assert.equal(objects[2].controlled, false);
  assert.equal((objects[2] as Record<string, unknown>).cargo, undefined);
  assert.equal(objects[3].kind, "OBSTACLE");
  assert.deepEqual(objects[3].positions, [[-1, -1]]);
  assert.equal(objects[4].kind, "RESOURCE");
});

test("official state: event ids are uuid-ized (SDK requires)", () => {
  const json = stateToOfficialJson(sampleState());
  const events = json.events as Array<Record<string, unknown>>;
  assert.equal(events.length, 1);
  assert.match(String(events[0].event_id), UUID_RE);
  assert.match(String(events[0].actor_id), UUID_RE);
  assert.equal(events[0].event_type, "DEPOSIT_SUCCEEDED");
});

test("official plan: parses actions and remaps uuids to sim ids", () => {
  const state = sampleState();
  const { plan, warnings } = planFromOfficialJson(
    {
      tick: 42,
      unit_actions: {
        [canonicalUuid("w1")]: { type: "MOVE", direction: "UP" },
      },
      core_action: { type: "SPAWN", unit_type: "WORKER" },
    },
    ["w1", "core-1"],
  );
  assert.equal(warnings.length, 0);
  assert.deepEqual(plan.unitActions["w1"], { type: "MOVE", direction: "UP" });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  void state;
});

test("official plan: unknown unit dropped and unknown action warned (fail-open)", () => {
  const { plan, warnings } = planFromOfficialJson(
    {
      tick: 1,
      unit_actions: {
        [canonicalUuid("ghost")]: { type: "MOVE", direction: "UP" },
        [canonicalUuid("w1")]: { type: "TELEPORT" },
      },
      core_action: { type: "START_MOVE", direction: "UP" },
    },
    ["w1"],
  );
  assert.equal(Object.keys(plan.unitActions).length, 0);
  assert.equal(plan.coreAction, null);
  assert.equal(warnings.length, 3); // ghost + TELEPORT + START_MOVE
});

test("official plan: SHOOT 空串 target_id 归一为 null（cell-fire 空格射击）", () => {
  // 服务端回显 cell-fire 的 target_id 可能是空串 ""——空串与 null 语义等价
  // （空格射击），必须归一为 null，否则 calibration schema 丢弃 case。
  const { plan, warnings } = planFromOfficialJson(
    {
      tick: 1,
      unit_actions: {
        [canonicalUuid("w1")]: { type: "SHOOT", target_id: "", expected_cell: [3, 3] },
        [canonicalUuid("w2")]: { type: "SHOOT", target_id: null, expected_cell: [4, 4] },
      },
      core_action: null,
    },
    ["w1", "w2"],
  );
  assert.equal(warnings.length, 0);
  assert.deepEqual(plan.unitActions["w1"], { type: "SHOOT", targetId: null, expectedCell: [3, 3] });
  assert.deepEqual(plan.unitActions["w2"], { type: "SHOOT", targetId: null, expectedCell: [4, 4] });
});
