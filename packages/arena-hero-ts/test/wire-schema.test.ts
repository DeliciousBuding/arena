/** W1 wire schema 测试：TypeBox 单源校验（数值拒绝/判别/契约生成）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";

import {
  PlayerStateSchema,
  CommandPlanSchema,
  AcceptedSchema,
  StreamEnvelopeSchema,
  toJsonSchema,
} from "../src/wire-schema.ts";
import { parseStreamMessage } from "../src/protocol.ts";
import { ProtocolError } from "../src/errors.ts";

const stateValidator = Compile(PlayerStateSchema);

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources: 0,
    population: 0,
    population_tier: 0,
    upkeep_next_tick: 0,
    champion_beacon: { position: [0, 0] },
    objects: [],
    events: [],
    ...overrides,
  };
}

test("wire: 数值字段拒绝字符串/NaN/负数/小数（GPT P1 清单）", () => {
  assert.equal(stateValidator.Check(makeState({ resources: "5" })), false);
  assert.equal(stateValidator.Check(makeState({ resources: NaN })), false);
  assert.equal(stateValidator.Check(makeState({ resources: -1 })), false);
  assert.equal(stateValidator.Check(makeState({ resources: 1.5 })), false);
  assert.equal(stateValidator.Check(makeState({ population: -3 })), false);
  assert.equal(stateValidator.Check(makeState({ objects: [{ kind: "UNIT", id: "u1", controlled: true, position: [0.5, 0], hp: 2, unit_type: "WORKER" }] })), false);
  assert.equal(stateValidator.Check(makeState({ objects: [{ kind: "UNIT", id: "u1", controlled: true, position: [0, 0], hp: "2", unit_type: "WORKER" }] })), false);
  // 合法值通过
  assert.equal(stateValidator.Check(makeState({ resources: 5 })), true);
  assert.equal(stateValidator.Check(makeState({ objects: [{ kind: "UNIT", id: "u1", controlled: true, position: [0, 0], hp: 2, unit_type: "WORKER", cargo: 1 }] })), true);
});

test("wire: 未知字段拒绝（additionalProperties: false）", () => {
  assert.equal(stateValidator.Check(makeState({ hacker: true })), false);
});

test("wire: PlayerState 非法 status 拒绝", () => {
  assert.equal(stateValidator.Check(makeState({ status: "HACKER" })), false);
});

test("wire: StreamEnvelope 判别——未知 type 拒绝", () => {
  const v = Compile(StreamEnvelopeSchema);
  assert.equal(v.Check({ type: "hack", data: 1 }), false);
  assert.equal(v.Check({ type: "tick", data: 5 }), true);
});

test("wire: CommandPlan 动作判别——非法动作 type 拒绝", () => {
  const v = Compile(CommandPlanSchema);
  assert.equal(v.Check({ tick: 1, unit_actions: { u1: { type: "HACK" } } }), false);
  assert.equal(v.Check({ tick: 1, unit_actions: { u1: { type: "MOVE", direction: "UP" } } }), true);
  // SHOOT 需要 target_id + expected_cell
  assert.equal(v.Check({ tick: 1, unit_actions: { u1: { type: "SHOOT" } } }), false);
});

test("wire: Accepted source 枚举校验", () => {
  const v = Compile(AcceptedSchema);
  assert.equal(v.Check({ accepted: true, tick: 1, source: "AGENT", received_at: "x" }), true);
  assert.equal(v.Check({ accepted: true, tick: 1, source: "HACKER", received_at: "x" }), false);
  assert.equal(v.Check({ accepted: false, tick: 1, source: "AGENT", received_at: "x" }), false);
});

test("contracts: toJsonSchema 生成标准 JSON Schema 且可写盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-json-"));
  const path = join(dir, "player-state.schema.json");
  writeFileSync(path, toJsonSchema(PlayerStateSchema), "utf-8");
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed.type, "object");
  assert.equal(parsed.required.includes("objects"), true);
  assert.deepEqual(parsed.properties.status.enum, ["ACTIVE", "RESPAWNING"]);
  rmSync(dir, { recursive: true, force: true });
});

test("wire: parseStreamMessage 数值非法 → ProtocolError（端到端）", () => {
  const raw = JSON.stringify({ type: "state", data: makeState({ resources: "5" }) });
  assert.throws(() => parseStreamMessage(raw), ProtocolError);
});
