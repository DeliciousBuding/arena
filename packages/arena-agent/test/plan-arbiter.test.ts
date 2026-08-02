/** runtime/plan-arbiter 测试：W4 最终计划合成（合法 Agent > Safety > 无动作）。 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Plan, TickState, UnitSnapshot } from "../src/domain/model.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import { PlanArbiter } from "../src/runtime/plan-arbiter.ts";

const CORE = {
  id: "c1",
  position: [0, 0] as const,
  hp: 5,
  shield: 5,
  state: "NORMAL" as const,
  ownerUsername: "buding",
};

function unit(
  id: string,
  unitType: UnitSnapshot["unitType"],
  position: readonly [number, number],
  options: { hp?: number; cargo?: number } = {},
): UnitSnapshot {
  return {
    id,
    unitType,
    position,
    hp: options.hp ?? (unitType === "VANGUARD" ? 4 : 2),
    cargo: options.cargo ?? 0,
  };
}

/** 默认 fixture：core c1 @[0,0]（hp5/shield5/NORMAL），资源 6（SPAWN WORKER=5 够，SPAWN RANGER=12 不够）。 */
function state(options: Partial<TickState> = {}): TickState {
  const units = options.units ?? [];
  return {
    tick: 42,
    status: "ACTIVE",
    resources: 6,
    resourceCapacity: 10,
    resourceSpace: 4,
    population: units.length,
    core: CORE,
    units,
    workers: units.filter((item) => item.unitType === "WORKER"),
    vanguards: units.filter((item) => item.unitType === "VANGUARD"),
    rangers: units.filter((item) => item.unitType === "RANGER"),
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
    ...options,
  };
}

const w1 = () => unit("w1", "WORKER", [0, 1]);
const r1 = () => unit("r1", "RANGER", [0, 0]);
const v1 = () => unit("v1", "VANGUARD", [0, 2]);
const v2 = () => unit("v2", "VANGUARD", [0, 3]);

test("无 Agent → 完整采用 safety（source=safety，统计 0）", () => {
  const current = state({ units: [w1(), r1()] });
  const safety: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "MOVE", direction: "DOWN" }, r1: { type: "WAIT" } },
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: { w1: "return_home" },
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: null,
  });

  assert.equal(result.source, "safety");
  assert.equal(result.agentActionCount, 0);
  assert.equal(result.safetyReplacementCount, 0);
  assert.equal(result.invalidAgentActionCount, 0);
  assert.equal(result.repairCount, 0);
  assert.deepEqual(result.plan, safety);
  assert.equal(validatePlan(current, result.plan).valid, true);
});

test("Agent 全合法 → agent（Agent 动作与 core 全部采用）", () => {
  const current = state({ units: [w1(), r1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "MOVE", direction: "DOWN" }, r1: { type: "WAIT" } },
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: { w1: "agent_intent" },
  };
  // safety 计划自身含非法 core 动作（shield 满仍 REPAIR_SHIELD）——不影响采用 agent
  const safety: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" }, r1: { type: "MOVE", direction: "UP" } },
    coreAction: { type: "REPAIR_SHIELD" },
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: agent,
  });

  assert.equal(result.source, "agent");
  assert.equal(result.agentActionCount, 3); // w1 + r1 + core
  assert.equal(result.safetyReplacementCount, 0);
  assert.equal(result.invalidAgentActionCount, 0);
  assert.equal(result.repairCount, 0);
  assert.deepEqual(result.plan, agent);
  assert.equal(validatePlan(current, result.plan).valid, true);
});

test("Agent 半合法 → hybrid（统计精确：1/3 非法）", () => {
  const current = state({ units: [w1(), r1(), v1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法：Worker 不在资源格
      r1: { type: "WAIT" }, // 合法
      v1: { type: "WAIT" }, // 合法
    },
    coreAction: { type: "SPAWN", unitType: "WORKER" }, // 合法：6 >= 5
    intents: {},
  };
  const safety: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "MOVE", direction: "DOWN" },
      r1: { type: "WAIT" },
      v1: { type: "WAIT" },
    },
    coreAction: null,
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: agent,
  });

  assert.equal(result.source, "hybrid");
  assert.equal(result.agentActionCount, 3); // r1 + v1 + core（w1 非法被替换）
  assert.equal(result.safetyReplacementCount, 1); // w1 ← safety MOVE DOWN
  assert.equal(result.invalidAgentActionCount, 1); // w1 HARVEST
  assert.equal(result.repairCount, 0);
  assert.deepEqual(result.plan.unitActions, {
    w1: { type: "MOVE", direction: "DOWN" },
    r1: { type: "WAIT" },
    v1: { type: "WAIT" },
  });
  assert.deepEqual(result.plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(validatePlan(current, result.plan).valid, true);
});

test("Agent 非法比例 ≥ 阈值 → 整单降级完整 safety（0.75 与精确 0.5 边界）", () => {
  const current = state({ units: [w1(), r1(), v1(), v2()] });
  const safety: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "WAIT" },
      r1: { type: "WAIT" },
      v1: { type: "WAIT" },
      v2: { type: "WAIT" },
    },
    coreAction: { type: "SPAWN", unitType: "WORKER" },
    intents: {},
  };
  const arbitrate = (agent: Plan) =>
    new PlanArbiter().arbitrate({ tick: current.tick, state: current, safetyPlan: safety, agentCandidate: agent });

  // 3/4 非法（0.75 >= 0.5）
  const mostlyInvalid: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法
      r1: { type: "SHOOT", targetId: "ghost", expectedCell: [5, 5] }, // 非法：目标不可见
      v1: { type: "WAIT" }, // 合法
      v2: { type: "WAIT" }, // 合法
    },
    coreAction: { type: "SPAWN", unitType: "RANGER" }, // 非法：6 < 12
    intents: {},
  };
  const result = arbitrate(mostlyInvalid);
  assert.equal(result.source, "safety");
  assert.equal(result.agentActionCount, 0);
  assert.equal(result.safetyReplacementCount, 0);
  assert.equal(result.invalidAgentActionCount, 3);
  assert.deepEqual(result.plan, safety);

  // 精确 0.5（2/4）→ 仍降级（>= 阈值）
  const halfInvalid: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法
      r1: { type: "SHOOT", targetId: "ghost", expectedCell: [5, 5] }, // 非法
      v1: { type: "WAIT" }, // 合法
      v2: { type: "WAIT" }, // 合法
    },
    coreAction: null,
    intents: {},
  };
  assert.equal(arbitrate(halfInvalid).source, "safety");
});

test("Core 动作合成：Agent core 非法 → Safety core；Safety core 也无 → null", () => {
  const current = state({ units: [w1(), v1()] });
  const arbitrate = (safetyCore: Plan["coreAction"]) => {
    const agent: Plan = {
      tick: current.tick,
      unitActions: { w1: { type: "WAIT" }, v1: { type: "WAIT" } }, // 合法
      coreAction: { type: "SPAWN", unitType: "RANGER" }, // 非法：6 < 12（1/3 < 0.5 → hybrid）
      intents: { core: "agent_spawn_ranger" },
    };
    const safety: Plan = {
      tick: current.tick,
      unitActions: { w1: { type: "WAIT" }, v1: { type: "WAIT" } },
      coreAction: safetyCore,
      intents: { core: "safety_core" },
    };
    return new PlanArbiter().arbitrate({
      tick: current.tick,
      state: current,
      safetyPlan: safety,
      agentCandidate: agent,
    });
  };

  // safety 有合法 core → 采用 safety core
  const replaced = arbitrate({ type: "SPAWN", unitType: "WORKER" });
  assert.equal(replaced.source, "hybrid");
  assert.equal(replaced.agentActionCount, 2); // w1 + v1
  assert.equal(replaced.safetyReplacementCount, 1); // core
  assert.equal(replaced.invalidAgentActionCount, 1);
  assert.deepEqual(replaced.plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(replaced.plan.intents.core, "safety_core"); // intent 跟随 safety

  // safety 也无 core 动作 → null
  const none = arbitrate(null);
  assert.equal(none.plan.coreAction, null);
  assert.equal(validatePlan(current, none.plan).valid, true);
});

test("emergencyPlan：最小合法计划（全部单位 WAIT + core null）", () => {
  const current = state({ units: [w1(), r1(), v1()] });
  const arbiter = new PlanArbiter();

  const emergency = arbiter.emergencyPlan(current);
  assert.deepEqual(emergency, {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" }, r1: { type: "WAIT" }, v1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  });
  const validation = validatePlan(current, emergency);
  assert.equal(validation.valid, true);
  assert.equal(validation.issues.length, 0);

  const result = arbiter.arbitrateEmergency(current);
  assert.equal(result.source, "emergency");
  assert.equal(result.agentActionCount, 0);
  assert.equal(result.safetyReplacementCount, 0);
  assert.equal(result.invalidAgentActionCount, 0);
  assert.equal(result.repairCount, 0);
  assert.deepEqual(result.plan, emergency);
});

test("safetyPlan 为 null → arbitrate 走 emergency（source=emergency）", () => {
  const current = state({ units: [w1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: null, // SafetyPlanner 异常
    agentCandidate: agent,
  });
  assert.equal(result.source, "emergency");
  assert.deepEqual(result.plan.unitActions, { w1: { type: "WAIT" } });
  assert.equal(result.plan.coreAction, null);
});

test("最终计划必须再过 validatePlan：Safety 替换动作非法 → 修复后输出（repairCount=1）", () => {
  const current = state({
    units: [w1(), r1(), v1()],
    obstacleCells: new Set(["0,2"]),
  });
  const agent: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法 → 走 safety
      r1: { type: "WAIT" }, // 合法
      v1: { type: "WAIT" }, // 合法
    },
    coreAction: null,
    intents: {},
  };
  const safety: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "MOVE", direction: "DOWN" }, // 非法：[0,2] 是障碍
      r1: { type: "WAIT" },
      v1: { type: "WAIT" },
    },
    coreAction: null,
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: agent,
  });

  assert.equal(result.source, "hybrid"); // 1/3 非法 < 0.5
  assert.equal(result.safetyReplacementCount, 1);
  assert.equal(result.invalidAgentActionCount, 1);
  assert.equal(result.repairCount, 1); // safety 的 MOVE DOWN 被最终 validate 修复
  assert.equal(result.plan.unitActions.w1, undefined); // 非法动作不残留
  assert.deepEqual(result.plan.unitActions, { r1: { type: "WAIT" }, v1: { type: "WAIT" } });
  assert.equal(validatePlan(current, result.plan).valid, true);
});

test("阈值可配置：同一场景 0.333 非法 → 0.4 阈值 hybrid / 0.2 阈值完整 safety", () => {
  const current = state({ units: [w1(), r1(), v1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法
      r1: { type: "WAIT" },
      v1: { type: "WAIT" },
    },
    coreAction: null,
    intents: {},
  };
  const safety: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" }, r1: { type: "WAIT" }, v1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
  const input = { tick: current.tick, state: current, safetyPlan: safety, agentCandidate: agent };

  const lenient = new PlanArbiter({ invalidRatioThreshold: 0.4 }).arbitrate(input);
  assert.equal(lenient.source, "hybrid"); // 1/3 ≈ 0.333 < 0.4

  const strict = new PlanArbiter({ invalidRatioThreshold: 0.2 }).arbitrate(input);
  assert.equal(strict.source, "safety"); // 0.333 >= 0.2
  assert.deepEqual(strict.plan, safety);
});

test("Agent 未提议任何动作（unitActions 空 + core null）→ 完整 safety", () => {
  const current = state({ units: [w1(), r1()] });
  const safety: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" }, r1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: { tick: current.tick, unitActions: {}, coreAction: null, intents: {} },
  });
  assert.equal(result.source, "safety");
  assert.deepEqual(result.plan, safety);
  assert.equal(result.agentActionCount, 0);
});

test("Agent 提议未知单位 → 计非法、不产出动作（unitActions 不含 ghost）", () => {
  const current = state({ units: [w1(), v1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "WAIT" },
      ghost: { type: "WAIT" }, // 不存在单位
      v1: { type: "WAIT" },
    },
    coreAction: null,
    intents: {},
  };
  const safety: Plan = {
    tick: current.tick,
    unitActions: { w1: { type: "WAIT" }, v1: { type: "WAIT" } },
    coreAction: null,
    intents: {},
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: agent,
  });
  assert.equal(result.source, "hybrid"); // 1/3 非法
  assert.equal(result.invalidAgentActionCount, 1);
  assert.equal(result.agentActionCount, 2);
  assert.deepEqual(result.plan.unitActions, { w1: { type: "WAIT" }, v1: { type: "WAIT" } });
});

test("intents 跟随动作来源：Agent 合法动作带 Agent intent，Safety 替换带 Safety intent", () => {
  const current = state({ units: [w1(), r1(), v1()] });
  const agent: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "HARVEST" }, // 非法
      r1: { type: "WAIT" }, // 合法
      v1: { type: "WAIT" }, // 合法（无 intent）
    },
    coreAction: null,
    intents: { w1: "agent_bad", r1: "agent_good" },
  };
  const safety: Plan = {
    tick: current.tick,
    unitActions: {
      w1: { type: "WAIT" },
      r1: { type: "MOVE", direction: "DOWN" },
      v1: { type: "WAIT" },
    },
    coreAction: null,
    intents: { w1: "safety_w1", r1: "safety_r1" },
  };
  const result = new PlanArbiter().arbitrate({
    tick: current.tick,
    state: current,
    safetyPlan: safety,
    agentCandidate: agent,
  });
  assert.deepEqual(result.plan.intents, { w1: "safety_w1", r1: "agent_good" });
});
