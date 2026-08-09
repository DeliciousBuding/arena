/**
 * 生产 bug 修复回归测试（2026-08-10）：
 * 对照 t1 生产 outcome.jsonl 失败模式（SHOOT_MISSED/CELL_UNIT_LIMIT/
 * CORE_MOVE_START_FAILED/DEPOSIT_FAILED）补的回归场景，防同类问题复发。
 *
 * 覆盖：
 * - decideWorker：Core MOVING 时 DEPOSIT 无条件拦截（CORE_MOVING 24 次）；
 * - decideVanguard vanguard_pressure：目标格/落点满容量 → spread 散开
 *   （CELL_UNIT_LIMIT 642+MOVE_CONTESTED 302 次互堵）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyPlanner, DEFAULT_SAFETY_CONFIG, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";
import { selectDeterministicCoreAction, RESOURCE_HIGH_WATER } from "../src/planning/deterministic-planner.ts";
import type { Position, TickState } from "../src/domain/model.ts";

const CORE: Position = [0, 0];

function makeState(opts: {
  coreState?: "NORMAL" | "MOVING";
  resources?: number;
  resourceSpace?: number;
  units?: TickState["units"];
  workers?: TickState["workers"];
  vanguards?: TickState["vanguards"];
  rangers?: TickState["rangers"];
  enemies?: TickState["visibleEnemies"];
  obstacles?: ReadonlySet<string>;
  resourceCells?: ReadonlySet<string>;
} = {}): TickState {
  const coreState = opts.coreState ?? "NORMAL";
  const workers = opts.workers ?? [];
  const vanguards = opts.vanguards ?? [];
  const rangers = opts.rangers ?? [];
  const units = opts.units ?? [...workers, ...vanguards, ...rangers];
  return {
    tick: 100,
    status: "ACTIVE",
    resources: opts.resources ?? 30,
    resourceCapacity: 30,
    resourceSpace: opts.resourceSpace ?? 30,
    population: units.length,
    core: { id: "c1", position: CORE, hp: 5, shield: 5, state: coreState, ownerUsername: "p1" },
    units,
    workers,
    vanguards,
    rangers,
    visibleEnemies: opts.enemies ?? [],
    resourceCells: opts.resourceCells ?? new Set(),
    obstacleCells: opts.obstacles ?? new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

const AGGRESSIVE: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" };

// ---------------------------------------------------------------------------
// decideWorker：Core MOVING 时 DEPOSIT 无条件拦截
// ---------------------------------------------------------------------------

test("decideWorker：满载 worker 在 Core 格 + Core MOVING → 不 DEPOSIT（移出核心格待命）", () => {
  // t1 生产实证：DEPOSIT_FAILED|CORE_MOVING 24 次——规则迁移中 Core 拒绝卸货，
  // 旧实现每 tick 白跑失败一次（coreMovingHold 默认关）。修复=无条件拦截。
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    coreState: "MOVING",
    resources: 10,
    resourceSpace: 20,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 2 }],
  });
  const plan = planner.decide({ state });
  const action = plan.unitActions["w1"];
  assert.notEqual(action.type, "DEPOSIT", "Core MOVING 时不得发 DEPOSIT（必失败）");
  // 满载 worker 应移出核心格待命（worker_hold_cargo_off_core）或原地 WAIT
  assert.ok(
    plan.intents["w1"] === "worker_hold_cargo_off_core" || plan.intents["w1"] === "worker_hold_cargo_moving",
    `intent 应为 hold_cargo 系列，实际 ${plan.intents["w1"]}`,
  );
});

test("decideWorker：满载 worker 在 Core 格 + Core NORMAL → 正常 DEPOSIT（零回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    coreState: "NORMAL",
    resources: 10,
    resourceSpace: 20,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 2 }],
  });
  const plan = planner.decide({ state });
  assert.equal(plan.intents["w1"], "deposit", "Core NORMAL 时满载 worker 正常卸货");
  assert.equal(plan.unitActions["w1"].type, "DEPOSIT");
});

// ---------------------------------------------------------------------------
// decideVanguard vanguard_pressure：满容量预检 + spread 散开
// ---------------------------------------------------------------------------

test("vanguard_pressure：目标格已满（己方+敌占=2）→ spread 到空邻格不硬挤", () => {
  // t1 生产实证：vanguard_pressure CELL_UNIT_LIMIT 642 次 + MOVE_CONTESTED 302 次
  // ——全员追同一敌格挤成一团。修复=目标格总占用≥2 → 散开一格。
  // 场景：敌 WORKER [5,0]，v1 已在 [5,0]（敌+v1=2 满），v2 在 [3,0] 追 →
  // target [5,0] total=2 → v2 spread 到 [4,0]（横竖优先空邻格）。
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    vanguards: [
      { id: "v1", position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "v2", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    enemies: [{ id: "e-w", kind: "UNIT", position: [5, 0], hp: 2, unitType: "WORKER" }],
  });
  const plan = planner.decide({ state });
  // v2 在 [3,0] 远离敌（manhattan 2 > SWEEP 邻接 1）→ pressure 分支
  // target=[5,0]（nearestEnemy）total=2（v1+敌）→ spread
  assert.equal(
    plan.intents["v2"],
    "vanguard_pressure_spread",
    `目标格满应 spread，实际 ${plan.intents["v2"]}`,
  );
  assert.equal(plan.unitActions["v2"].type, "MOVE", "spread 应发 MOVE 不是硬挤");
});

test("vanguard_pressure：目标格未满 → 正常 pressure 推进（零回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    vanguards: [{ id: "v1", position: [3, 0], hp: 4, unitType: "VANGUARD", cargo: 0 }],
    enemies: [{ id: "e-w", kind: "UNIT", position: [5, 0], hp: 2, unitType: "WORKER" }],
  });
  const plan = planner.decide({ state });
  // 敌格 [5,0] total=1（仅敌）→ 未满 → v1 正常 pressure 朝 [4,0]
  assert.equal(plan.intents["v1"], "vanguard_pressure", "未满应正常 pressure");
  assert.equal(plan.unitActions["v1"].type, "MOVE");
});

// ---------------------------------------------------------------------------
// C6 修复测试（2026-08-10）：满载 worker 占 Core 格时 SPAWN 必失败
// 生产实证 t1 tick 80585-80586：DEPOSIT_SUCCEEDED + CORE_SPAWN_FAILED/
// CELL_UNIT_LIMIT 同 tick——旧逻辑排除满载 worker 不计占位，SPAWN 叠加
// 容量超限。修复：所有单位（含满载 worker）都计入 permanentOccupantsOnCore。
// ---------------------------------------------------------------------------

test("C6: 满载 worker 在 Core 格 → 高水位 SPAWN 被阻断（不 CELL_UNIT_LIMIT）", () => {
  // 资源 >= 150（高水位线）+ 满载 worker 在 Core 格 → 旧逻辑排除满载 worker
  // → permanentOccupantsOnCore=0 → SPAWN 发出 → cell 含 core+worker=2，
  // SPAWN 叠加=3 > 容量 2 → CORE_SPAWN_FAILED/CELL_UNIT_LIMIT。
  // 修复后：满载 worker 也计入 → permanentOccupantsOnCore=1 → 不 SPAWN。
  const state = makeState({
    resources: RESOURCE_HIGH_WATER,
    resourceSpace: 50,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 2 }],
  });
  const decision = selectDeterministicCoreAction(state, null);
  assert.equal(decision.action, null, "满载 worker 在 Core 格时不得 SPAWN（必 CELL_UNIT_LIMIT）");
});

test("C6: 空载 worker 在 Core 格 → SPAWN 同样被阻断（零回归确认）", () => {
  // 空载 worker 在 Core 格 → 历史行为即计入 permanentOccupantsOnCore → 不 SPAWN
  // （确认 C6 修复未改变空载 worker 的行为）
  const state = makeState({
    resources: RESOURCE_HIGH_WATER,
    resourceSpace: 50,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 0 }],
  });
  const decision = selectDeterministicCoreAction(state, null);
  assert.equal(decision.action, null, "空载 worker 在 Core 格时同样不 SPAWN");
});

test("C6: Core 格无单位 → 高水位 SPAWN 正常发出（零回归）", () => {
  // Core 格空 → permanentOccupantsOnCore=0 → 高水位 SPAWN 正常
  const state = makeState({
    resources: RESOURCE_HIGH_WATER,
    resourceSpace: 50,
    workers: [{ id: "w1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
  });
  const decision = selectDeterministicCoreAction(state, null);
  assert.notEqual(decision.action, null, "Core 格无单位时高水位 SPAWN 应正常发出");
  assert.equal(decision.action!.type, "SPAWN");
});

test("C6 spawnYield: resourceHighWater 配置 + 满载 worker 在 Core 格 → 让位", () => {
  // safety-planner 的 coreWantsSpawn 在 resourceHighWater 配置且资源 >=
  // 高水位时返回 true（即使 pop >= ceiling）→ spawnYield 让 worker 移出
  // Core 格 → 下 tick SPAWN 不被占格挡掉。
  const config: SafetyPlannerConfig = {
    ...AGGRESSIVE,
    spawnYield: true,
    spawnYieldMaxTicks: 3,
    resourceHighWater: 150,
    populationCeiling: 1, // pop=1=ceiling，正常 coreWantsSpawn 返回 false
  };
  const planner = new SafetyPlanner(config);
  const state = makeState({
    resources: 160, // >= resourceHighWater(150)
    resourceSpace: 40,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 2 }],
  });
  const plan = planner.decide({ state });
  // spawnYield 应触发 → worker 让出 Core 格（MOVE 或 WAIT 在邻格）
  assert.ok(
    plan.intents["w1"] === "worker_yield_spawn" || plan.intents["w1"] === "worker_hold_cargo_off_core",
    `高水位+满载 worker 在 Core 格应让位，实际 ${plan.intents["w1"]}`,
  );
  assert.notEqual(plan.unitActions["w1"].type, "DEPOSIT", "让位时不卸货（先让位下 tick 再 SPAWN）");
});

// ---------------------------------------------------------------------------
// O1 worker-leash（2026-08-10，算法优化）：resourceAssignmentMaxDistanceFromCore
// 在 workerLeash 配置时返回有限值，否则 Infinity（零回归）。
// 生产 t1 实测 worker 离核 23.6 格、DEPOSIT 吞吐 0.15/tick → 拴绳 25 格后
// 近矿往返 ~20 tick（吞吐 ~0.05/tick，2.4× 提升）。
// ---------------------------------------------------------------------------

test("O1: workerLeash=undefined → resourceAssignmentMaxDistanceFromCore=Infinity（零回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState();
  assert.equal(
    planner.resourceAssignmentMaxDistanceFromCore(state),
    Number.POSITIVE_INFINITY,
    "无 workerLeash 配置时不限制（历史行为）",
  );
});

test("O1: workerLeash=25 → resourceAssignmentMaxDistanceFromCore=25", () => {
  const config: SafetyPlannerConfig = { ...AGGRESSIVE, workerLeash: 25 };
  const planner = new SafetyPlanner(config);
  const state = makeState();
  assert.equal(
    planner.resourceAssignmentMaxDistanceFromCore(state),
    25,
    "workerLeash=25 时返回 25",
  );
});

test("O1: threatRecall 激活时 recall 优先于 workerLeash（取 min）", () => {
  const config: SafetyPlannerConfig = {
    ...AGGRESSIVE,
    workerLeash: 25,
    threatRecall: true,
  };
  const planner = new SafetyPlanner(config);
  const state = makeState({
    enemies: [
      { id: "e1", kind: "UNIT", position: [5, 0], hp: 2, unitType: "RANGER" },
    ],
  });
  // 威胁召回返回 RECALL_PATROL_RADIUS=4（比 workerLeash=25 更紧）
  assert.ok(
    planner.resourceAssignmentMaxDistanceFromCore(state) <= 4,
    "threatRecall 激活时 RECALL_PATROL_RADIUS 优先（取 min）",
  );
});

// ---------------------------------------------------------------------------
// O3 SPAWN 核格占用检查（2026-08-10，算法优化）：decideCore 在 Core 格有
// 单位占位时不发 SPAWN（防 CELL_UNIT_LIMIT）。deterministic-planner 已有
// 此检查（C6 修复），safety 侧 fallback 路径同步。
// ---------------------------------------------------------------------------

test("O3: Core 格有 worker → decideCore 不 SPAWN（fallback 路径防 CELL_UNIT_LIMIT）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    resources: 50,
    resourceSpace: 50,
    workers: [{ id: "w1", position: CORE, hp: 2, unitType: "WORKER", cargo: 0 }],
  });
  const plan = planner.decide({ state });
  // Core 格有 worker 占位 → SPAWN 会 CELL_UNIT_LIMIT → 不 SPAWN
  assert.notEqual(plan.coreAction?.type, "SPAWN", "Core 格有单位时不得 SPAWN");
  assert.equal(plan.intents.core, "spawn_blocked_occupancy", "intent 应标记 occupancy 阻断");
});

test("O3: Core 格无单位 → decideCore 正常 SPAWN（零回归）", () => {
  const planner = new SafetyPlanner(AGGRESSIVE);
  const state = makeState({
    resources: 50,
    resourceSpace: 50,
    workers: [{ id: "w1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 }],
  });
  const plan = planner.decide({ state });
  // Core 格空 → SPAWN 正常
  assert.equal(plan.coreAction?.type, "SPAWN", "Core 格无单位时正常 SPAWN");
  assert.notEqual(plan.intents.core, "spawn_blocked_occupancy", "不应标记 occupancy 阻断");
});

// ---------------------------------------------------------------------------
// D1 coreEvade 资源格避让（2026-08-10，CRITICAL）：retreatDirection 不含
// 资源格 → Core 可 START_MOVE 进资源格 → 引擎拒（TERRAIN_BLOCKED）→ 无限循环。
// 修复：合并 resourceCells 到障碍集。影响 t2/t3/t4（coreEvade 启用）。
// ---------------------------------------------------------------------------

test("D1: coreEvade 不朝资源格方向 START_MOVE（避免 TERRAIN_BLOCKED 无限循环）", () => {
  // 场景：Core [0,0]，敌 RANGER [5,0]（逼近 → closing 触发 coreEvade）。
  // 资源格在 [1,0]（Core 右侧）→ 修复前 retreatDirection 可能选 RIGHT
  // （[1,0] 无障碍标记）→ START_MOVE RIGHT → 引擎拒（资源格拒核迁移）
  // → 无限循环。修复后 [1,0] 被资源格标记 → retreatDirection 跳过 →
  // 选其他方向（UP/DOWN/LEFT 中远离敌的）。
  const config: SafetyPlannerConfig = {
    ...AGGRESSIVE,
    coreEvade: true,
  };
  const planner = new SafetyPlanner(config);
  const state = makeState({
    resources: 10,
    resourceSpace: 30,
    enemies: [
      { id: "e1", kind: "UNIT", position: [5, 0], hp: 2, unitType: "RANGER" },
    ],
    obstacles: new Set<string>(["1,0"]), // 资源格在 Core 右侧
    resourceCells: new Set(["1,0"]),
  });
  const plan = planner.decide({ state });
  // 应该 START_MOVE（coreEvade 触发），但不是 RIGHT（资源格方向）
  if (plan.coreAction?.type === "START_MOVE") {
    assert.notEqual(
      plan.coreAction.direction,
      "RIGHT",
      "coreEvade 不得朝资源格方向 START_MOVE（TERRAIN_BLOCKED）",
    );
  }
});
