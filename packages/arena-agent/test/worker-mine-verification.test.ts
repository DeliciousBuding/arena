/** 死矿证伪 + 供给缺口勘探 + 分配滞回（2026-08-08，t2 生产实证 osc=11/11 乒乓根治）。
 *
 * 场景还原（t2 实证）：
 * - 近核区域矿已采空：可见矿 0-8 格，561 个 survey-db 测绘种子全量入池；
 * - worker 被派往死种子（visible=false 记忆矿）→ 到达后无法 HARVEST → 被重排到
 *   相邻死种子 → 两格无限往返（planChurn=1.0、harvest≈0.18/tick、stallRate 0.83）。
 *
 * 三层修复：
 * A. World.markResourceFailed：到达死矿 → failedCells 冷却 → resourceCandidates 跳过
 *    （"追一次即证伪"）；refill 后重新可见自然恢复。
 * B. switchThreshold 滞回：上一 tick 目标仍可采时保持，不因微小净收益差翻转。
 * C. deterministic-planner 到达死矿 → 证伪 + 落巡逻勘探基线（worker_dead_mine_verify）。
 * D. surveyOnSupplyGap：候选可采格 < 空 worker 时缺口全部转勘探（不守家 WAIT）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/domain/world.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { extractPlanningSnapshot, type PlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import { WorkerTaskPlanner, type Assignment } from "../src/planning/worker-task-planner.ts";
import { DeterministicPlanner, type DeterministicPlannerInput } from "../src/planning/deterministic-planner.ts";
import { DEFAULT_MISSION_CONFIG, type MissionConfig } from "../src/planning/mission-planner.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";

const CORE = { id: "core-1", position: [0, 0] as const, hp: 5, shield: 4, ownerUsername: "buding" };

function worker(id: string, x: number, y: number, hp = 5, cargo = 0) {
  return { id, position: [x, y] as const, hp, unitType: "WORKER" as const, cargo };
}

function makeTurn(
  units: readonly ReturnType<typeof worker>[] = [],
  extra: Partial<TurnLike> = {},
): TurnLike {
  return {
    tick: 10,
    resources: 3,
    resourceCapacity: 10,
    resourceSpace: 7,
    units,
    workers: units.filter((u) => u.unitType === "WORKER"),
    vanguards: [],
    rangers: [],
    core: CORE,
    visibleEnemies: [],
    obstacleCells: new Set(),
    resourceCells: new Set(),
    beacon: { position: [8, 8] as const, status: "GROUND" as const, carrier_id: null },
    events: [],
    state: { status: "ACTIVE" as const, population: units.length, objects: [] },
    ...extra,
  };
}

function snapshotOf(turn: TurnLike): PlanningSnapshot {
  return extractPlanningSnapshot(reduceTurn(turn));
}

/** t2 实证场景的任务配置（worker-mission-v1 注册表默认 + 新开关）。 */
function t2Mission(overrides: Partial<MissionConfig> = {}): MissionConfig {
  return {
    ...DEFAULT_MISSION_CONFIG,
    collectionValueFloor: -30,
    maxCollectionDistance: 24,
    surveyWorkerCap: 3,
    surveyBurstTicks: 100,
    surveyWorkerFloor: 3,
    visibleBonus: 0.3,
    seedAgeDecay: 0.02,
    deadMineOverdueTicks: Number.POSITIVE_INFINITY,
    migrationScout: true,
    switchThreshold: 1.5,
    alwaysSurvey: true,
    ...overrides,
  };
}

// ---------------- A. World 死矿证伪 ----------------

test("markResourceFailed: 失败冷却期内 resourceCandidates 跳过该格", () => {
  const world = new World();
  // 用 seed 注入（等同 survey-db 种子，无视野干扰）
  world.observe(reduceTurn(makeTurn([], { tick: 100 })));
  world.seedResourceMemory([[4, 0]], 100);
  assert.ok(
    world.resourceCandidates().some((c) => c.cell[0] === 4 && c.cell[1] === 0),
    "seeded 记忆矿应在候选中",
  );
  // 实地到达证伪 → 冷却期内不再入池
  world.markResourceFailed([4, 0]);
  assert.ok(
    !world.resourceCandidates().some((c) => c.cell[0] === 4 && c.cell[1] === 0),
    "证伪后该格不应再出现在候选",
  );
});

test("markResourceFailed: 冷却期外自然恢复（不过期删除记忆）", () => {
  const world = new World();
  // seed 用 [10,0]（core [0,0] 视野半径 5 之外——避免视野确认直接 harvested，
  // 隔离验证"失败冷却"自身的过期恢复）
  world.observe(reduceTurn(makeTurn([], { tick: 100 })));
  world.seedResourceMemory([[10, 0]], 100);
  world.markResourceFailed([10, 0]);
  // 冷却默认 32 tick：tick 131 仍冷却（131-100=31<32），tick 132 恢复
  // （132-100=32 不再 <32；记忆 TTL 64 未到，seeded 永不过期）
  world.observe(reduceTurn(makeTurn([], { tick: 131 })));
  assert.ok(!world.resourceCandidates().some((c) => c.cell[0] === 10));
  world.observe(reduceTurn(makeTurn([], { tick: 132 })));
  assert.ok(
    world.resourceCandidates().some((c) => c.cell[0] === 10 && c.cell[1] === 0),
    "冷却结束后 stale 记忆矿恢复候选（等待 refill 重新可见）",
  );
});

test("markResourceFailed: 重新可见优先于失败冷却（真 refill 不拦）", () => {
  const world = new World();
  world.observe(reduceTurn(makeTurn([], { tick: 100 })));
  world.seedResourceMemory([[4, 0]], 100);
  world.markResourceFailed([4, 0]);
  // 下一 tick 矿重新可见（refill）→ visible 优先，候选恢复
  world.observe(reduceTurn(makeTurn([], { tick: 101, resourceCells: new Set(["4,0"]) })));
  assert.ok(
    world.resourceCandidates().some((c) => c.cell[0] === 4 && c.state === "visible"),
    "可见矿不受失败冷却压制",
  );
});

test("markResourceFailed: seeded 死种子证伪后不再无限循环（t2 osc=11/11 场景）", () => {
  const world = new World();
  // 模拟 survey-db 种子：两个相邻死矿格 (-33,37)/(-33,36)，age 巨大
  world.seedResourceMemory([[-33, 37], [-33, 36]], 0);
  const candidates = world.resourceCandidates();
  assert.ok(
    candidates.some((c) => c.cell[0] === -33 && c.cell[1] === 37),
    "seeded 死种子在候选（旧行为：永不过期 → 乒乓根因）",
  );
  // worker 实地到达 → 逐一证伪
  world.markResourceFailed([-33, 37]);
  world.markResourceFailed([-33, 36]);
  assert.equal(
    world.resourceCandidates().filter((c) => c.cell[0] === -33).length,
    0,
    "证伪后两个死种子都不再入池 → 乒乓断链",
  );
});

// ---------------- B. switchThreshold 滞回 ----------------

test("switchThreshold: 上一 tick 目标仍可采时保持（不因微小差翻转）", () => {
  const mission = t2Mission({ switchThreshold: 1.5 });
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], {
    resourceCells: new Set(["4,0", "4,2"]),
  }));
  // w1 在途目标 (4,0)，两个候选距离近似（净收益差 < 1.5）
  const previous: readonly Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [4, 0], targetCellKey: "4,0" } },
  ];
  const plan = new WorkerTaskPlanner({ mission }).plan(snap, previous);
  const task = plan.assignments.find((a) => a.unitId === "w1")!.task;
  assert.equal(task.targetCellKey, "4,0", "滞回：保持在途目标");
});

test("switchThreshold: 新目标显著更优时允许切换", () => {
  const mission = t2Mission({ switchThreshold: 1.5 });
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], {
    resourceCells: new Set(["4,0", "1,0"]),
  }));
  // (1,0) 距 1 格 vs 在途 (4,0) 距 4 格：净收益差 ≈ (4+4)-(1+1)=6 > 1.5 → 切换
  const previous: readonly Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [4, 0], targetCellKey: "4,0" } },
  ];
  const plan = new WorkerTaskPlanner({ mission }).plan(snap, previous);
  const task = plan.assignments.find((a) => a.unitId === "w1")!.task;
  assert.equal(task.targetCellKey, "1,0", "显著更优目标应切换");
});

test("switchThreshold: 缺省 0 = 零回归（行为与旧 sticky 一致）", () => {
  const snap = snapshotOf(makeTurn([worker("w1", 0, 0)], {
    resourceCells: new Set(["4,0", "4,2"]),
  }));
  const previous: readonly Assignment[] = [
    { unitId: "w1", task: { type: "GO_RESOURCE", target: [4, 0], targetCellKey: "4,0" } },
  ];
  const plan = new WorkerTaskPlanner().plan(snap, previous);
  const task = plan.assignments.find((a) => a.unitId === "w1")!.task;
  assert.equal(task.targetCellKey, "4,0", "默认 sticky 0.5 下仍选在途目标");
});

// ---------------- C. DeterministicPlanner 到达死矿证伪 ----------------

function plannerWithMission(mission: MissionConfig): DeterministicPlanner {
  return new DeterministicPlanner(
    new WorkerTaskPlanner(),
    undefined,
    undefined,
    undefined,
    0,
    2,
    [],
    new Map(),
    [],
    [],
    mission,
  );
}

function inputOf(turn: TurnLike): DeterministicPlannerInput {
  return { state: reduceTurn(turn) };
}

test("decide: 到达不可见死矿 → 证伪该格（不再被重派乒乓）", () => {
  // worker 站在死种子格 (-33,36) 上（seed 注入 → snapshot.resourceCells 有该格
  // 且 visible=false——格上无实体资源）。fallbackPlanner 需启用 harvestMemoryMine
  // （t2 生产配置含 harvest-memory-mine-v1）才会把记忆矿并入分配快照。
  const fallback = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, harvestMemoryMine: true });
  const seededPlanner = new DeterministicPlanner(
    new WorkerTaskPlanner(),
    fallback,
    undefined,
    undefined,
    0,
    2,
    [],
    new Map(),
    [[-33, 36], [-33, 37]],
    [],
    t2Mission(),
  );
  const turn = makeTurn([worker("w1", -33, 36)], { tick: 70000 });
  const plan = seededPlanner.decide(inputOf(turn));
  // 死矿格已证伪：next tick 不再作为候选（failedCells 冷却）
  // 本 tick worker 落巡逻勘探基线（EXPLORE 分支 → worker_survey），不再被派往
  // 相邻死种子继续乒乓
  const action = plan.unitActions["w1"];
  const intent = plan.intents["w1"];
  assert.ok(action !== undefined, "必须有动作");
  assert.ok(
    intent === "worker_survey" || intent === "GO_RESOURCE" || intent === "WAIT_UNCLAIMED" || intent === "WAIT",
    `动作应为勘探/合法基线，实际 ${intent}`,
  );
  // 关键断言：证伪已写入 World（fallbackPlanner 的 World 持有 resourceMemory）——
  // 下一 tick 该格从候选消失
  const fallbackWorld = (seededPlanner as unknown as { fallbackPlanner: { world: World } }).fallbackPlanner.world;
  const candidates = fallbackWorld.resourceCandidates();
  assert.ok(
    !candidates.some((c) => c.cell[0] === -33 && c.cell[1] === 36),
    "到达死矿后该格应被证伪（不再入池）",
  );
});

test("decide: 站在可见矿上正常 HARVEST（证伪不误伤真矿）", () => {
  const planner = plannerWithMission(t2Mission());
  const turn = makeTurn([worker("w1", 4, 0)], {
    tick: 100,
    resourceCells: new Set(["4,0"]),
  });
  const plan = planner.decide(inputOf(turn));
  assert.equal(plan.intents["w1"], "HARVEST_CURRENT", "可见矿应正常采集");
});

// ---------------- D. surveyOnSupplyGap 供给缺口勘探 ----------------

test("surveyOnSupplyGap: 可采格 < 空 worker 时缺口全部转勘探（不守家 WAIT）", () => {
  const mission = t2Mission({ alwaysSurvey: true });
  // 1 个可见矿 + 5 个空 worker → 1 人采矿、4 人缺口全转勘探
  const snap = snapshotOf(makeTurn([
    worker("w1", 1, 0),
    worker("w2", 0, 2),
    worker("w3", -1, 0),
    worker("w4", 0, -2),
    worker("w5", 2, 2),
  ], {
    resourceCells: new Set(["3,0"]),
  }));
  const plan = new WorkerTaskPlanner({ mission }).plan(snap);
  const tasks = plan.assignments.map((a) => a.task.type);
  assert.ok(tasks.includes("GO_RESOURCE"), "有矿可采的 worker 正常采矿");
  const explorers = tasks.filter((t) => t === "EXPLORE").length;
  assert.equal(explorers, 4, `供给缺口 4 个 worker 应全部转勘探，实际 ${explorers}`);
  assert.ok(!tasks.includes("WAIT"), "供给缺口下不应守家 WAIT");
});

test("surveyOnSupplyGap: 矿充足时不超过 cap（零回归）", () => {
  const mission = t2Mission({ alwaysSurvey: true });
  // 5 个空 worker + 5 个可见矿 → 全部采矿，无人转勘探（surveyWorkerCap 只影响 dummy）
  const snap = snapshotOf(makeTurn([
    worker("w1", 1, 0), worker("w2", 0, 2), worker("w3", -1, 0), worker("w4", 0, -2), worker("w5", 2, 2),
  ], {
    resourceCells: new Set(["3,0", "3,4", "-3,0", "0,-4", "5,5"]),
  }));
  const plan = new WorkerTaskPlanner({ mission }).plan(snap);
  const tasks = plan.assignments.map((a) => a.task.type);
  assert.equal(tasks.filter((t) => t === "GO_RESOURCE").length, 5);
  assert.ok(!tasks.includes("EXPLORE"), "矿充足时不强制勘探");
});

test("surveyOnSupplyGap: 缺省 false = 零回归（dummy 走 surveyWorkerCap 仲裁）", () => {
  const snap = snapshotOf(makeTurn([
    worker("w1", 1, 0), worker("w2", 0, 2), worker("w3", -1, 0), worker("w4", 0, -2), worker("w5", 2, 2),
  ], {
    resourceCells: new Set(["3,0"]),
  }));
  const plan = new WorkerTaskPlanner().plan(snap);
  const tasks = plan.assignments.map((a) => a.task.type);
  // 默认 surveyWorkerCap=0：1 人采矿、其余 WAIT（历史行为）
  assert.equal(tasks.filter((t) => t === "GO_RESOURCE").length, 1);
  assert.equal(tasks.filter((t) => t === "WAIT").length, 4);
});
