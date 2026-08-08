import { test } from "node:test";
import assert from "node:assert/strict";
import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import type { TickState } from "../src/domain/model.ts";
import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number, objects: PlayerState["objects"], resources = 20): TickState {
  const turn = new Turn(tick, {
    status: "ACTIVE",
    respawn_at_tick: null,
    resources,
    population: objects.filter((o) => o.kind === "UNIT").length,
    population_tier: 0,
    upkeep_next_tick: 0,
    champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
    objects,
    events: [],
  }, (() => {}) as never);
  return reduceTurn(turn as unknown as TurnLike);
}

function worker(id: string, x: number, y: number): PlayerState["objects"][number] {
  return { kind: "UNIT", id, controlled: true, position: [x, y], hp: 2, unit_type: "WORKER", cargo: 0 };
}

function core(x = 0, y = 0): PlayerState["objects"][number] {
  return {
    kind: "CORE", id: "core-1", controlled: true, owner_username: "fixture",
    position: [x, y], hp: 5, shield: 5, state: "NORMAL",
    move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
  };
}

test("记忆矿：自然节点按采集吞吐 1 slot 分配，不按实体格容量 2 分配", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true });
  planner.world.seedResourceMemory([[8, 0]], 0);
  const state = makeState(100, [core(), worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 1, 0)]);
  const plan = planner.decide({ state });
  const memoryMiners = Object.entries(plan.intents ?? {}).filter(([, intent]) => intent === "go_harvest_mem");
  assert.equal(memoryMiners.length, 1, `同一自然资源节点只能有 1 个记忆矿 worker，实际=${JSON.stringify(plan.intents)}`);
});

test("记忆矿：跨 tick 已污染的重复 sticky target 会重新抢槽并自动分流", () => {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true });
  planner.world.seedResourceMemory([[8, 0]], 0);
  for (const id of ["w1", "w2", "w3"]) {
    const memory = planner.world.unitMemory(id);
    memory.workerMode = "go_harvest";
    memory.harvestTarget = [8, 0];
  }
  const state = makeState(100, [core(), worker("w1", 0, 0), worker("w2", 0, 1), worker("w3", 1, 0)]);
  const plan = planner.decide({ state });
  const sticky = Object.entries(plan.intents ?? {}).filter(([, intent]) => intent === "go_harvest_mem");
  assert.equal(sticky.length, 1, `重复 sticky target 必须收敛成 1 个 owner，实际=${JSON.stringify(plan.intents)}`);
  const activeTargets = ["w1", "w2", "w3"].filter((id) => planner.world.unitMemory(id).harvestTarget !== null);
  assert.equal(activeTargets.length, 1);
});

test("deterministic：全局唯一资源分配回写 Safety memory，避免下一 tick 记忆重新扎堆", () => {
  const fallback = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const patrol = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const planner = new DeterministicPlanner(new WorkerTaskPlanner(), fallback, patrol);
  const base = makeState(100, [core(50, 50), worker("w1", 0, 0), worker("w2", 1, 0)]);
  const state: TickState = { ...base, resourceCells: new Set(["3,0", "0,4"]) };
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w1"], "GO_RESOURCE");
  assert.equal(plan.intents["w2"], "GO_RESOURCE");

  const targets = [fallback.world.unitMemory("w1").harvestTarget, fallback.world.unitMemory("w2").harvestTarget]
    .map((target) => target === null ? "null" : `${target[0]},${target[1]}`)
    .sort();
  assert.deepEqual(targets, ["0,4", "3,0"], "fallback memory 必须和实际 unique assignment 同步");
});
