/** tickSummary 单测：测绘字段与 Python fork 载荷同构
 * （python-mapping-telemetry-v1 §2.1）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { tickSummary } from "../src/telemetry.ts";
import type { PlayerState } from "../src/types.ts";

function fixtureState(): PlayerState {
  return {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources: 120,
    population: 10,
    population_tier: null,
    upkeep_next_tick: null,
    champion_beacon: { position: [5, 5], status: "GROUND", carrier_id: null },
    objects: [
      { kind: "RESOURCE", positions: [[1, 1], [2, 2]] },
      { kind: "OBSTACLE", positions: [[3, 3]] },
      {
        kind: "UNIT",
        id: "u1",
        controlled: true,
        position: [4, 4],
        hp: 100,
        unit_type: "WORKER",
        cargo: null,
      },
      {
        kind: "UNIT",
        id: "u2",
        controlled: false,
        position: [6, 6],
        hp: 50,
        unit_type: "RANGER",
        cargo: null,
      },
      {
        kind: "CORE",
        id: "c1",
        controlled: true,
        owner_username: "me",
        position: [7, 7],
        hp: 500,
        shield: 100,
        state: "NORMAL",
        move_direction: null,
        move_progress: null,
        move_required_ticks: null,
        destination: null,
      },
      {
        kind: "CORE",
        id: "c2",
        controlled: false,
        owner_username: "enemy",
        position: [8, 8],
        hp: 400,
        shield: 50,
        state: "NORMAL",
        move_direction: null,
        move_progress: null,
        move_required_ticks: null,
        destination: null,
      },
    ],
    events: [],
  };
}

test("tickSummary 基础字段保持不变（向后兼容）", () => {
  const summary = tickSummary(79570, fixtureState());
  assert.equal(summary.event, "tick_summary");
  assert.equal(summary.tick, 79570);
  assert.equal(summary.status, "ACTIVE");
  assert.equal(summary.resources, 120);
  assert.equal(summary.population, 10);
  assert.deepEqual(summary.core, [7, 7]);
  assert.equal(summary.units, 2);
  assert.equal(summary.visible_enemies, 1);
});

test("tickSummary 测绘字段与 Python fork 载荷同构", () => {
  const summary = tickSummary(79570, fixtureState());
  assert.deepEqual(summary.resource_cells, [[1, 1], [2, 2]]);
  assert.deepEqual(summary.obstacle_cells, [[3, 3]]);
  assert.deepEqual(summary.units_seen, [
    ["u1", "WORKER", 1, 4, 4, 100],
    ["u2", "RANGER", 0, 6, 6, 50],
  ]);
  assert.deepEqual(summary.enemy_cores, [[8, 8, "enemy"]]);
});

test("tickSummary 无测绘对象时输出空数组", () => {
  const state = fixtureState();
  state.objects = [];
  const summary = tickSummary(79570, state);
  assert.deepEqual(summary.resource_cells, []);
  assert.deepEqual(summary.obstacle_cells, []);
  assert.deepEqual(summary.units_seen, []);
  assert.deepEqual(summary.enemy_cores, []);
  assert.equal(summary.core, null);
});
