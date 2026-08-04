/**
 * MacroPolicy 单元测试：规范化/序列化确定性、LLM 输出解析、orchestrator 周期
 * 与 sticky 语义、SafetyPlanner policy 消费映射。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { TickState } from "../src/domain/model.ts";
import {
  DEFAULT_MACRO_POLICY,
  aggressionOf,
  isValidMacroPolicy,
  normalizeMacroPolicy,
  serializeMacroPolicy,
} from "../src/runtime/macro-policy.ts";
import { MacroPolicyOrchestrator, parsePolicyText } from "../src/runtime/macro-policy-orchestrator.ts";
import { buildMacroPolicyPrompt, readLastAssistantText } from "../src/infrastructure/pi/policy-prompt.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";

function makeState(tick: number): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 10,
    resourceCapacity: 10,
    resourceSpace: 0,
    population: 2,
    core: {
      id: "11111111-1111-1111-1111-111111111111",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      ownerUsername: "p1",
    },
    units: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", position: [2, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    workers: [],
    vanguards: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", position: [2, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    rangers: [],
    visibleEnemies: [
      {
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        kind: "CORE",
        position: [6, 0],
        hp: 5,
        ownerUsername: "foe",
      },
    ],
    resourceCells: new Set(["9,1"]),
    obstacleCells: new Set(["3,2"]),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

test("MacroPolicy: 默认策略序列化确定性 + 值域校验", () => {
  const a = serializeMacroPolicy(DEFAULT_MACRO_POLICY);
  const b = serializeMacroPolicy(DEFAULT_MACRO_POLICY);
  assert.equal(a, b);
  assert.ok(a.includes('"posture":"balanced"'));
  assert.equal(isValidMacroPolicy(DEFAULT_MACRO_POLICY), true);
  assert.equal(isValidMacroPolicy({ posture: "nuke", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: null }), false);
  assert.equal(isValidMacroPolicy({ posture: "aggressive", workerTarget: 0, militaryRatio: 0.4, focusRegion: null, attackPriority: null }), false);
});

test("MacroPolicy: normalize 剔除未知字段并回退非法值", () => {
  const normalized = normalizeMacroPolicy({
    posture: "aggressive",
    workerTarget: 12,
    militaryRatio: 0.6,
    focusRegion: [3, -2],
    attackPriority: "workers",
    extra: "ignored",
  });
  assert.equal(normalized.posture, "aggressive");
  assert.equal(normalized.workerTarget, 12);
  assert.deepEqual(normalized.focusRegion, [3, -2]);
  assert.equal(normalized.attackPriority, "workers");
  // 非法值回退默认
  const fallback = normalizeMacroPolicy({ posture: "aggressive", workerTarget: 0, militaryRatio: 9, focusRegion: "bad", attackPriority: "nuke" });
  assert.equal(fallback.workerTarget, DEFAULT_MACRO_POLICY.workerTarget);
  assert.equal(fallback.militaryRatio, DEFAULT_MACRO_POLICY.militaryRatio);
  assert.equal(fallback.focusRegion, null);
  assert.equal(fallback.attackPriority, null);
});

test("MacroPolicy: aggressionOf 映射（aggressive → aggressive，其余 defensive）", () => {
  assert.equal(aggressionOf(normalizeMacroPolicy({ posture: "aggressive" })), "aggressive");
  assert.equal(aggressionOf(normalizeMacroPolicy({ posture: "harvest" })), "defensive");
  assert.equal(aggressionOf(DEFAULT_MACRO_POLICY), "defensive");
});

test("MacroPolicy: parsePolicyText 剥 markdown 围栏 + 非法抛错", () => {
  const policy = parsePolicyText('```json\n{"posture":"aggressive","workerTarget":10,"militaryRatio":0.5,"focusRegion":[1,2],"attackPriority":"core"}\n```');
  assert.equal(policy.posture, "aggressive");
  assert.equal(policy.workerTarget, 10);
  assert.throws(() => parsePolicyText("no json here"), /no JSON object/);
  assert.throws(() => parsePolicyText('{"posture":"aggressive","workerTarget":0,"militaryRatio":0.5,"focusRegion":null,"attackPriority":null}'), /out of domain/);
});

test("MacroPolicy: prompt 构建确定性 + readLastAssistantText 提取文本", () => {
  const p1 = buildMacroPolicyPrompt(makeState(100));
  const p2 = buildMacroPolicyPrompt(makeState(100));
  assert.equal(p1, p2);
  assert.ok(p1.includes("posture"));
  const session = {
    state: {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: '{"posture":"harvest","workerTarget":6}' }, { type: "text", text: '"militaryRatio":0.3,"focusRegion":null,"attackPriority":null}' }],
          stopReason: "end_turn",
        },
      ],
    },
  };
  const text = readLastAssistantText(session);
  assert.equal(text, '{"posture":"harvest","workerTarget":6}"militaryRatio":0.3,"focusRegion":null,"attackPriority":null}');
  assert.throws(() => readLastAssistantText({ state: { messages: [{ role: "user", content: [] }] } }), /not assistant/);
  assert.throws(() => readLastAssistantText({ state: { messages: [{ role: "assistant", content: [], stopReason: "error" }] } }), /stopReason is error/);
});

test("MacroPolicyOrchestrator: 周期触发 + sticky 失败保持 + 不阻塞", async () => {
  let calls = 0;
  const updates: Array<{ tick: number; posture: string }> = [];
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: buildMacroPolicyPrompt,
    requestPolicy: async () => {
      calls += 1;
      return '{"posture":"aggressive","workerTarget":8,"militaryRatio":0.4,"focusRegion":null,"attackPriority":"core"}';
    },
    onPolicyUpdate: (policy, tick) => updates.push({ tick, posture: policy.posture }),
  });

  // 首个 tick 触发（异步），返回默认策略（不阻塞）
  const first = orchestrator.onTick(makeState(1));
  assert.equal(first, DEFAULT_MACRO_POLICY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(orchestrator.current.posture, "aggressive");
  assert.deepEqual(updates, [{ tick: 1, posture: "aggressive" }]);

  // 周期内不重复触发
  orchestrator.onTick(makeState(10));
  orchestrator.onTick(makeState(31));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);

  // 到周期（tick 33）再次触发
  orchestrator.onTick(makeState(33));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 2);
});

test("MacroPolicyOrchestrator: 决策失败 sticky 保持上次策略", async () => {
  let fail = true;
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: buildMacroPolicyPrompt,
    requestPolicy: async () => {
      if (fail) throw new Error("gateway down");
      return '{"posture":"harvest","workerTarget":6,"militaryRatio":0.3,"focusRegion":null,"attackPriority":null}';
    },
  });
  orchestrator.onTick(makeState(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.current, DEFAULT_MACRO_POLICY, "失败后 sticky 默认策略");
  assert.ok(orchestrator.lastDecisionError !== null);

  fail = false;
  orchestrator.onTick(makeState(33));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(orchestrator.current.posture, "harvest", "恢复后更新策略");
});

test("SafetyPlanner: policy.posture=aggressive 覆盖 config（Vanguard 前压）", () => {
  const planner = new SafetyPlanner(); // 默认 defensive config
  const state = makeState(1);
  const plan = planner.decide({ state, policy: { posture: "aggressive", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" } });
  const vanguard = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.equal(vanguard?.type, "MOVE");
  assert.equal(plan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], "vanguard_pressure");
});

test("SafetyPlanner: policy.posture=harvest 强制 defensive（不改历史行为）", () => {
  const planner = new SafetyPlanner();
  const state = makeState(1);
  const plan = planner.decide({ state, policy: { posture: "harvest", workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: null } });
  const vanguard = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.ok(vanguard === undefined || vanguard.type !== "MOVE" || plan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"] !== "vanguard_pressure");
});
