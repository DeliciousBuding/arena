/** 协议编解码测试：与上游 Python SDK 逐字节兼容（sort_keys + 紧凑 + exclude_none）。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodePlan, parseAccepted, parseStreamMessage } from "../src/protocol.ts";
import { coreResourceCapacity, CORE_RESOURCE_MINIMUM_CAPACITY } from "../src/rules.ts";
import { ProtocolError } from "../src/errors.ts";
import type { CommandPlan } from "../src/actions.ts";

test("encodePlan 与 Python sort_keys + exclude_none 输出一致", () => {
  const plan: CommandPlan = {
    tick: 42,
    unit_actions: {
      "11111111-1111-1111-1111-111111111111": { type: "MOVE", direction: "UP" },
      "22222222-2222-2222-2222-222222222222": { type: "HARVEST" },
    },
    core_action: { type: "SPAWN", unit_type: "WORKER" },
  };
  // 期望：键递归排序、null/undefined 剔除、无空白
  const expected =
    '{"core_action":{"type":"SPAWN","unit_type":"WORKER"},"tick":42,' +
    '"unit_actions":{"11111111-1111-1111-1111-111111111111":{"direction":"UP","type":"MOVE"},' +
    '"22222222-2222-2222-2222-222222222222":{"type":"HARVEST"}}}';
  assert.equal(encodePlan(plan), expected);
});

test("encodePlan 剔除 null 字段（exclude_none）", () => {
  const plan: CommandPlan = {
    tick: 1,
    unit_actions: {},
    core_action: null,
  };
  assert.equal(encodePlan(plan), '{"tick":1,"unit_actions":{}}');
});

test("parseStreamMessage: tick 信封", () => {
  const msg = parseStreamMessage('{"type":"tick","data":123}');
  assert.deepEqual(msg, { tick: 123 });
});

test("parseStreamMessage: 二进制消息拒绝", () => {
  assert.throws(() => parseStreamMessage(new Uint8Array([1, 2])), ProtocolError);
});

test("parseStreamMessage: 非法 JSON 拒绝", () => {
  assert.throws(() => parseStreamMessage("not json"), ProtocolError);
});

test("parseStreamMessage: state 信封解析 PlayerState", () => {
  const raw = JSON.stringify({
    type: "state",
    data: {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources: 5,
      population: 2,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: {
        position: [0, 0],
        status: "GROUND",
        carrier_id: null,
      },
      objects: [
        { kind: "UNIT", id: "u1", controlled: true, position: [0, 1], hp: 2, unit_type: "WORKER", cargo: 1 },
        { kind: "UNIT", id: "u2", controlled: false, position: [3, 3], hp: 1, unit_type: "RANGER" },
        { kind: "CORE", id: "c1", controlled: true, owner_username: "buding", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        { kind: "RESOURCE", positions: [[5, 0], [6, 0]] },
        { kind: "OBSTACLE", positions: [[9, 9]] },
      ],
      events: [
        { event_id: "e1", tick: 41, event_type: "HARVEST_SUCCEEDED", values: { amount: 1 } },
      ],
    },
  });
  const state = parseStreamMessage(raw);
  assert.ok("status" in state, "expected PlayerState");
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.resources, 5);
  assert.equal(state.objects.length, 5);
  const core = state.objects[2];
  assert.equal(core.kind, "CORE");
  if (core.kind === "CORE") {
    assert.equal(core.owner_username, "buding");
  }
  assert.equal(state.events[0].event_type, "HARVEST_SUCCEEDED");
});

test("parseStreamMessage: MOVING Core 缺字段拒绝", () => {
  const raw = JSON.stringify({
    type: "state",
    data: {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources: 0,
      population: 0,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
      objects: [
        { kind: "CORE", id: "c1", controlled: true, owner_username: "buding", position: [0, 0], hp: 5, shield: 5, state: "MOVING" },
      ],
      events: [],
    },
  });
  assert.throws(() => parseStreamMessage(raw), ProtocolError);
});

test("parseStreamMessage: cargo 只在受控 Worker 上", () => {
  const raw = JSON.stringify({
    type: "state",
    data: {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources: 0,
      population: 1,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
      objects: [
        { kind: "UNIT", id: "u1", controlled: false, position: [0, 1], hp: 2, unit_type: "WORKER", cargo: 1 },
      ],
      events: [],
    },
  });
  assert.throws(() => parseStreamMessage(raw), ProtocolError);
});

test("parseAccepted: 合法 202 应答", () => {
  const accepted = parseAccepted(
    new TextEncoder().encode('{"accepted":true,"tick":42,"source":"AGENT","received_at":"2026-08-02T12:00:00Z"}'),
  );
  assert.equal(accepted.tick, 42);
  assert.equal(accepted.source, "AGENT");
});

test("coreResourceCapacity: 10 资源下限 + 每人口 5", () => {
  assert.equal(coreResourceCapacity(0), CORE_RESOURCE_MINIMUM_CAPACITY);
  assert.equal(coreResourceCapacity(1), CORE_RESOURCE_MINIMUM_CAPACITY);
  assert.equal(coreResourceCapacity(2), CORE_RESOURCE_MINIMUM_CAPACITY);
  assert.equal(coreResourceCapacity(6), 30);
  assert.equal(coreResourceCapacity(10), 50);
  assert.throws(() => coreResourceCapacity(-1), RangeError);
});
