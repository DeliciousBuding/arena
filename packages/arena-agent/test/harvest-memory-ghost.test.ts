/** 复现+验证：t4 worker 幽灵矿追猎循环（harvest-memory-mine 追陈旧 seeded 矿）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Position, TickState, UnitSnapshot } from "../src/domain/model.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { resolveSafetyVariantConfig } from "../src/strategies/variant-registry.ts";
import { T4_POCKET_OBSTACLES } from "./t4-pocket-obstacles.ts";
import { T4_POCKET_RESOURCES } from "./t4-pocket-resources.ts";

const T4_VARIANTS = [
  "move-failed-avoidance-v1","threat-recall-v1","reinforce-home-v1","raid-defense-v1",
  "threat-adaptive-defense-v1","core-clearance-v1","worker-dense-scan-v1","frontier-priority-v1",
  "core-moving-hold-v1","vanguard-heavy-v1","harvest-memory-mine-v1","vanguard-prey-worker-v1",
  "core-threat-watch-v1","alliance-no-fire-v1","worker-mission-v1","recovery-early-military-v1",
];
const safetyOverrides = Object.assign({}, ...T4_VARIANTS.map((id) => resolveSafetyVariantConfig(id)));
const CONFIG = { ...DEFAULT_SAFETY_CONFIG, ...safetyOverrides };
const DELTA: Record<string, [number, number]> = { RIGHT:[1,0], DOWN:[0,1], LEFT:[-1,0], UP:[0,-1] };
const parse = (k: string): Position => { const [x,y] = k.split(",").map(Number); return [x!, y!]; };

function stateAt(core: Position, wpos: Position, tick: number): TickState {
  const worker: UnitSnapshot = { id: "w1", position: wpos, hp: 4, unitType: "WORKER", cargo: 0 };
  return {
    tick, status: "ACTIVE", resources: 5, resourceCapacity: 10, resourceSpace: 10, population: 1,
    core: { id: "c1", position: core, hp: 5, shield: 5, state: "NORMAL", ownerUsername: "p1" },
    units: [worker], workers: [worker], vanguards: [], rangers: [],
    visibleEnemies: [], resourceCells: new Set(), obstacleCells: new Set(T4_POCKET_OBSTACLES),
    beacon: { position: [53, 310], status: "GROUND", carrierId: null }, events: [],
  };
}

function run(planner: SafetyPlanner, seedTick: number, startTick: number, home: Position): { waits: number; moves: string[]; intents: string[] } {
  let pos: Position = [53, 297];
  const moves: string[] = []; const intents: string[] = []; let waits = 0;
  for (let t = 0; t < 40; t += 1) {
    const tick = startTick + t;
    const plan = planner.decide({ state: stateAt(home, pos, tick) });
    const action = plan.unitActions["w1"];
    const intent = plan.intents?.["w1"] ?? "?";
    intents.push(intent);
    if (action !== undefined && action.type === "MOVE") {
      const d = DELTA[action.direction]!;
      const next: Position = [pos[0]+d[0], pos[1]+d[1]];
      moves.push(`${pos}->${next}`);
      pos = next;
    } else { waits += 1; }
  }
  return { waits, moves, intents };
}

test("幽灵矿修复：陈旧 seeded 矿不再被追（worker 正常巡逻，无 go_harvest_mem 循环）", () => {
  const planner = new SafetyPlanner(CONFIG);
  planner.world.seedObstacleMemory(T4_POCKET_OBSTACLES.map(parse));
  // seedTick=1 远早于 startTick=100 → age 99 > 64 → 全部视为幽灵
  planner.world.seedResourceMemory(T4_POCKET_RESOURCES.map(parse), 1);
  const mem = planner.world.unitMemory("w1");
  mem.workerMode = "patrol"; mem.patrolStarted = true; mem.patrolRing = 1;
  const r = run(planner, 1, 100, [53, 310]);
  const ghost = r.intents.filter((i) => i === "go_harvest_mem").length;
  assert.ok(ghost === 0, `陈旧 seed 不应触发 go_harvest_mem（实际 ${ghost} 次）`);
  assert.ok(r.waits <= 8, `不应频繁 WAIT（${r.waits}/40）`);
});

test("幽灵矿修复：近期 seed（age<=64）仍可追（正常记忆矿行为保留）", () => {
  const planner = new SafetyPlanner(CONFIG);
  planner.world.seedObstacleMemory(T4_POCKET_OBSTACLES.map(parse));
  // seedTick=50, startTick=100 → age 50 <= 64 → 可追
  planner.world.seedResourceMemory(T4_POCKET_RESOURCES.map(parse), 50);
  const mem = planner.world.unitMemory("w1");
  mem.workerMode = "patrol"; mem.patrolStarted = true; mem.patrolRing = 1;
  const r = run(planner, 50, 100, [53, 310]);
  const ghost = r.intents.filter((i) => i === "go_harvest_mem").length;
  assert.ok(ghost > 0, `近期 seed 应仍被主动追（实际 ${ghost} 次）`);
});
