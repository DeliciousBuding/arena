/** Core migration cancel candidate tests (B9, 2026-08-07). */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CoreAction, Direction, TickState } from "../src/domain/model.ts";
import {
  DEFAULT_SAFETY_CONFIG,
  SafetyPlanner,
  type SafetyPlannerConfig,
} from "../src/strategies/safety-planner.ts";

function makeTickState(overrides: Partial<TickState>): TickState {
  return {
    tick: 10,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 20,
    resourceSpace: 10,
    population: 1,
    core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "MOVING", ownerUsername: "p1" },
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...overrides,
  };
}

function decideCoreWith(
  config: Partial<SafetyPlannerConfig>,
  state: TickState,
  moveDirection: Direction | null,
): CoreAction | null {
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...config });
  // 通过核心迁移方向注入 MOVING 提交状态（decideCore 消费 this.coreMoveDirection）。
  (planner as unknown as { coreMoveDirection: Direction | null }).coreMoveDirection = moveDirection;
  const intents: Record<string, string> = {};
  // decideCore 是私有方法——通过 plan 入口驱动（aggressive 配置下核心迁移逻辑可达）。
  const plan = planner.decide({ state, sharedObstacles: new Set() });
  return plan.coreAction;
}

test("default: MOVING core returns null (zero regression)", () => {
  const state = makeTickState({});
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
  (planner as unknown as { coreMoveDirection: Direction | null }).coreMoveDirection = "RIGHT";
  const plan = planner.decide({ state, sharedObstacles: new Set() });
  assert.equal(plan.coreAction, null);
});

test("coreMigrationCancel: next cell blocked by obstacle cancels migration", () => {
  const state = makeTickState({
    obstacleCells: new Set(["1,0"]),
  });
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, coreMigrationCancel: true });
  (planner as unknown as { coreMoveDirection: Direction | null }).coreMoveDirection = "RIGHT";
  const plan = planner.decide({ state, sharedObstacles: new Set() });
  assert.equal(plan.coreAction?.type, "CANCEL_MOVE");
});

test("coreMigrationCancel: next cell occupied by enemy cancels migration", () => {
  const state = makeTickState({
    visibleEnemies: [
      { id: "22222222-2222-2222-2222-222222222222", kind: "UNIT", position: [1, 0], unitType: "VANGUARD", hp: 4 },
    ],
  });
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, coreMigrationCancel: true });
  (planner as unknown as { coreMoveDirection: Direction | null }).coreMoveDirection = "RIGHT";
  const plan = planner.decide({ state, sharedObstacles: new Set() });
  assert.equal(plan.coreAction?.type, "CANCEL_MOVE");
});

test("coreMigrationCancel: clear next cell keeps migration (no cancel)", () => {
  const state = makeTickState({});
  const planner = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, coreMigrationCancel: true });
  (planner as unknown as { coreMoveDirection: Direction | null }).coreMoveDirection = "RIGHT";
  const plan = planner.decide({ state, sharedObstacles: new Set() });
  assert.equal(plan.coreAction, null);
});
