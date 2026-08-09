/**
 * Hot-reload generation contract for the worker-mission-v1 mission surface.
 *
 * 2026-08-09 审计（R1）：热载从"含 worker-mission-v1 + mission"切到"不含该
 * variant/mission"时，DeterministicPlanner.updateConfig 的
 * `mission !== undefined` 守卫让旧 missionConfig 持续生效——旧代配置残留，
 * 最接近"旧 generation 持续运行"。本文件把该契约固化为红→绿测试：
 *
 * - updateConfig 的 deterministicConfig 是"完整新 deterministic 表面"：
 *   mission 缺省 = 明确清空（回 DEFAULT_MISSION_CONFIG），无 "undefined=保持旧值" 歧义。
 * - 合法新 mission 原子替换旧 mission（不合并、不残留）。
 * - 未知/非法变体在 compile 边界 fail-closed，旧 active config 不被触碰。
 * - variants+mission 仍是唯一热面：去掉 worker-mission-v1 是热操作（restartHash 不变），
 *   strategyHash 如实反映 mission 面的增删（policyOverride 等 restart_required 不变）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Turn } from "@arena/arena-hero-ts";

import type { TenantRuntimeConfig } from "../src/app/runtime-config.ts";
import {
  compileRuntimeStrategy,
  hotReloadCompatibility,
} from "../src/app/strategy-config.ts";
import { DEFAULT_MISSION_CONFIG, type MissionConfig } from "../src/planning/mission-planner.ts";
import { DeterministicPlanner } from "../src/planning/deterministic-planner.ts";
import { WorkerTaskPlanner } from "../src/planning/worker-task-planner.ts";
import { extractPlanningSnapshot } from "../src/planning/planning-snapshot.ts";
import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { PlayerState } from "@arena/arena-hero-ts";

function makeState(tick: number, objects: PlayerState["objects"]): ReturnType<typeof reduceTurn> {
  const turn = new Turn(
    tick,
    {
      status: "ACTIVE",
      respawn_at_tick: null,
      resources: 6,
      population: objects.filter((o) => o.kind === "UNIT").length,
      population_tier: 0,
      upkeep_next_tick: 0,
      champion_beacon: { position: [100, 100], status: "GROUND", carrier_id: null },
      objects,
      events: [],
    },
    (() => {}) as never,
  );
  return reduceTurn(turn as unknown as TurnLike);
}

function unit(id: string, x: number, y: number): PlayerState["objects"][number] {
  return { kind: "UNIT", id, controlled: true, position: [x, y], hp: 2, unit_type: "WORKER", cargo: 0 };
}

function core(x = 0, y = 0): PlayerState["objects"][number] {
  return {
    kind: "CORE", id: "c1", controlled: true, owner_username: "fixture_user",
    position: [x, y], hp: 5, shield: 5, state: "NORMAL",
    move_direction: null, move_progress: null, move_required_ticks: null, destination: null,
  };
}

/** 构造 DeterministicPlanner，mission 走第 11 个位置参数（与既有 migration-scout 测试同款）。 */
function plannerWithMission(mission: MissionConfig): DeterministicPlanner {
  return new DeterministicPlanner(
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, mission,
  );
}

const CUSTOM_MISSION = {
  ...DEFAULT_MISSION_CONFIG,
  alwaysSurvey: true,
  surveyWorkerCap: 3,
  surveyWorkerFloor: 3,
};

function base(overrides: Partial<TenantRuntimeConfig> = {}): TenantRuntimeConfig {
  return {
    tenantId: "t1",
    arenaTokenEnv: "ARENA_TEST_KEY",
    decisionMode: "deterministic",
    submitEnabled: false,
    model: { provider: "test", id: "test-model" },
    baseDir: "runtime",
    ...overrides,
  };
}

// ===========================================================================
// 1. 红测：去掉 worker-mission-v1 + mission → mission 行为恢复 DEFAULT_MISSION_CONFIG
// ===========================================================================

test("config-reload: 移除 worker-mission-v1/mission 后 DeterministicPlanner 不再保留旧 missionConfig（旧代残留修复）", () => {
  // 空资源格：alwaysSurvey=true（自定义 mission）→ EXPLORE / worker_survey；
  // DEFAULT_MISSION_CONFIG（alwaysSurvey=false, surveyWorkerCap=0）→ WAIT / patrol。
  const state = makeState(100, [core(0, 0), unit("w1", 0, 0)]);
  const snapshot = extractPlanningSnapshot(state);

  // 注入 WorkerTaskPlanner 以便直接断言底层 mission（匈牙利分配层，无 World 状态干扰）
  const workerPlanner = new WorkerTaskPlanner();
  const planner = new DeterministicPlanner(
    workerPlanner, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, CUSTOM_MISSION,
  );
  const before = planner.decide({ state });
  assert.equal(before.intents["w1"], "worker_survey", "自定义 mission 应先生效（EXPLORE 外出）");
  assert.equal(
    workerPlanner.plan(snapshot, []).assignments[0]?.task.type,
    "EXPLORE",
    "底层 WorkerTaskPlanner 应持自定义 mission",
  );

  // 模拟热载：新配置不含 worker-mission-v1 + 不含 mission 块 → deterministicOverrides 无 mission 键
  planner.updateConfig({ ...DEFAULT_SAFETY_CONFIG }, {});

  const after = planner.decide({ state });
  assert.notEqual(after.intents["w1"], "worker_survey", "移除 mission 后不得残留旧代 worker_survey");
  assert.equal(
    workerPlanner.plan(snapshot, []).assignments[0]?.task.type,
    "WAIT",
    "移除 mission 后底层 WorkerTaskPlanner 应回到 DEFAULT_MISSION_CONFIG（WAIT，非 EXPLORE）",
  );

  // intent 层面与全新 DEFAULT 基线一致（行动方向受 fallback World 状态影响，不逐字段比）
  const baseline = plannerWithMission(DEFAULT_MISSION_CONFIG).decide({ state });
  assert.deepEqual(after.intents, baseline.intents, "清空后 intent 应与 DEFAULT 基线一致");
});

// ===========================================================================
// 2. 合法新 mission 原子替换旧 mission
// ===========================================================================

test("config-reload: 合法新 mission 原子替换旧 mission（不合并、不残留）", () => {
  const state = makeState(100, [core(0, 0), unit("w1", 0, 0), unit("w2", 1, 0)]);
  const planner = new DeterministicPlanner(); // 默认 DEFAULT

  // mission A：surveyWorkerCap=1 → 只有 id 序第一个 worker 转 SURVEYOR
  planner.updateConfig(
    { ...DEFAULT_SAFETY_CONFIG },
    { mission: { ...DEFAULT_MISSION_CONFIG, alwaysSurvey: false, surveyWorkerCap: 1 } },
  );
  const planA = planner.decide({ state });
  assert.equal(planA.intents["w1"], "worker_survey", "mission A：w1 进入 SURVEYOR 名额");
  assert.notEqual(planA.intents["w2"], "worker_survey", "mission A：w2 超出名额不转 SURVEYOR");

  // mission B：surveyWorkerCap=2 → 两个 worker 全部转 SURVEYOR（B 替换 A，不是合并）
  planner.updateConfig(
    { ...DEFAULT_SAFETY_CONFIG },
    { mission: { ...DEFAULT_MISSION_CONFIG, alwaysSurvey: false, surveyWorkerCap: 2 } },
  );
  const planB = planner.decide({ state });
  assert.equal(planB.intents["w1"], "worker_survey", "mission B：w1 仍为 SURVEYOR");
  assert.equal(planB.intents["w2"], "worker_survey", "mission B：w2 进入 SURVEYOR 名额（B 已替换 A）");
});

// ===========================================================================
// 3. 未知/非法变体在 compile 边界 fail-closed，旧 active config 不被触碰
// ===========================================================================

test("config-reload: 未知变体 compile 失败，旧 active strategy 不被触碰（last-good）", () => {
  const active = compileRuntimeStrategy(
    base({ variants: ["worker-mission-v1"], mission: { collectionValueFloor: -12 } }),
  );
  const activeSnapshot = {
    configHash: active.configHash,
    strategyHash: active.strategyHash,
    restartHash: active.restartHash,
  };

  // 未知变体：compile 抛错（先于任何 planner/ownership 变更），active 快照不变
  assert.throws(
    () => compileRuntimeStrategy(base({ variants: ["worker-mission-v1", "not-a-real-variant-v1"] })),
    /unknown safety variant/,
  );

  // active strategy 对象本身不受失败候选编译影响（仍可复现同 hash = 幂等 last-good）
  const recompiled = compileRuntimeStrategy(
    base({ variants: ["worker-mission-v1"], mission: { collectionValueFloor: -12 } }),
  );
  assert.equal(recompiled.configHash, activeSnapshot.configHash);
  assert.equal(recompiled.strategyHash, activeSnapshot.strategyHash);
  assert.equal(recompiled.restartHash, activeSnapshot.restartHash);
});

// ===========================================================================
// 4. 去掉 worker-mission-v1 是热操作；strategy hash 如实反映 mission 面增删
// ===========================================================================

test("config-reload: 移除 worker-mission-v1/mission 是热操作，strategyHash 变而 restartHash 不变", () => {
  const withMission = compileRuntimeStrategy(
    base({ variants: ["worker-mission-v1"], mission: { collectionValueFloor: -12 } }),
  );
  const withoutMission = compileRuntimeStrategy(
    base({ variants: [] }),
  );

  // 编译面：无 mission 时 deterministicOverrides 不含 mission 键（updateConfig 收到的正是它）
  assert.equal(withMission.deterministicOverrides.mission?.collectionValueFloor, -12);
  assert.equal(withoutMission.deterministicOverrides.mission, undefined);

  // 热兼容：variants 变化是热面，无 restart 字段（policyOverride 等 restart_required 不变）
  const compatibility = hotReloadCompatibility(withMission.config, withoutMission.config);
  assert.equal(compatibility.compatible, true, "移除 worker-mission-v1 不应要求重启");
  assert.equal(compatibility.variantsChanged, true);
  assert.equal(compatibility.missionChanged, true);
  assert.deepEqual(compatibility.restartRequiredFields, []);

  // hash 契约：mission 面属于策略身份（strategyHash 变），但不属于重启面（restartHash 不变）
  assert.notEqual(withMission.strategyHash, withoutMission.strategyHash, "mission 移除应改变 strategyHash");
  assert.equal(withMission.restartHash, withoutMission.restartHash, "mission 移除不应改变 restartHash");
  assert.notEqual(withMission.configHash, withoutMission.configHash);
});
