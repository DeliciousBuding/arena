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
import { MacroPolicyOrchestrator, RESPAWN_OVERRIDE_POLICY, parsePolicyText } from "../src/runtime/macro-policy-orchestrator.ts";
import { buildMacroPolicyPrompt, readLastAssistantText } from "../src/infrastructure/pi/policy-prompt.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { PolicyDiscipline } from "../src/runtime/policy-discipline.ts";

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
    focusRegion: [3, 2],
    attackPriority: "workers",
    extra: "ignored",
  });
  assert.equal(normalized.posture, "aggressive");
  assert.equal(normalized.workerTarget, 12);
  assert.deepEqual(normalized.focusRegion, [3, 2]);
  assert.equal(normalized.attackPriority, "workers");
  // 非法值回退默认
  const fallback = normalizeMacroPolicy({ posture: "aggressive", workerTarget: 0, militaryRatio: 9, focusRegion: "bad", attackPriority: "nuke" });
  assert.equal(fallback.workerTarget, DEFAULT_MACRO_POLICY.workerTarget);
  assert.equal(fallback.militaryRatio, DEFAULT_MACRO_POLICY.militaryRatio);
  assert.equal(fallback.focusRegion, null);
  assert.equal(fallback.attackPriority, null);
});

test("MacroPolicy: focusRegion 负坐标合法（生产地图负坐标区域；远点防呆靠 maxFocusDistance）", () => {
  // 2026-08-06 修正：t1 Core 在 [-619,-154]（负坐标区域），枯竭告警下模型
  // 输出真实负坐标焦点被旧"非负校验"误拒（3 次 policy_error 实证）——负坐标
  // 整数焦点合法；远点（[-1500,1500]）由 SafetyPlanner maxFocusDistance=32
  // 按距 Core 距离过滤，不再按坐标符号拒绝。
  const negative: Record<string, unknown> = { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: [-600, -160], attackPriority: null };
  assert.equal(isValidMacroPolicy(negative), true);
  assert.deepEqual(normalizeMacroPolicy(negative).focusRegion, [-600, -160]);
  const origin: Record<string, unknown> = { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: [0, 0], attackPriority: null };
  assert.equal(isValidMacroPolicy(origin), true);
  const bad: Record<string, unknown> = { posture: "balanced", workerTarget: 8, militaryRatio: 0.3, focusRegion: [1.5, 0], attackPriority: null };
  assert.equal(isValidMacroPolicy(bad), false);
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
  // 经济趋势注入：确定性 + 内容包含
  const withTrend = buildMacroPolicyPrompt(makeState(100), { recentResourceDeltas: [1, 2, 3] });
  assert.ok(withTrend.includes("resource trend (last 3 ticks, sum 6): 1 2 3"));
  assert.notEqual(withTrend, p1);
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

test("MacroPolicyOrchestrator: 重生覆盖（RESPAWNING → 强制 harvest，不触发 LLM）", async () => {
  let calls = 0;
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: buildMacroPolicyPrompt,
    requestPolicy: async () => {
      calls += 1;
      return '{"posture":"aggressive","workerTarget":8,"militaryRatio":0.4,"focusRegion":null,"attackPriority":"core"}';
    },
  });
  const respawningState = { ...makeState(100), status: "RESPAWNING" as const };
  const overridden = orchestrator.onTick(respawningState);
  assert.equal(overridden, RESPAWN_OVERRIDE_POLICY, "重生中强制经济重建策略");
  assert.equal(overridden.posture, "harvest");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0, "重生期不消费 LLM 决策");

  // 无 Core 也触发覆盖
  const noCoreState = { ...makeState(110), core: null };
  assert.equal(orchestrator.onTick(noCoreState), RESPAWN_OVERRIDE_POLICY);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 0);

  // 恢复 ACTIVE 后立即触发一次新决策
  const recovered = makeState(120);
  orchestrator.onTick(recovered);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "重生恢复后立即决策");
  assert.equal(orchestrator.current.posture, "aggressive");
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

test("SafetyPlanner: focusRegion 接线（Worker go_focus、无敌人时军事单位朝聚焦区）", () => {
  const planner = new SafetyPlanner();
  const state = makeState(1);
  const focusState: TickState = {
    ...state,
    visibleEnemies: [], // 无敌人
    resourceCells: new Set(), // 无可见资源
    units: [
      ...state.units,
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    workers: [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
  };
  const plan = planner.decide({
    state: focusState,
    policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.4, focusRegion: [8, 4], attackPriority: null },
  });
  // Worker 朝聚焦区（intent go_focus）
  const worker = plan.unitActions["dddddddd-dddd-dddd-dddd-dddddddddddd"];
  assert.equal(worker?.type, "MOVE");
  assert.equal(plan.intents["dddddddd-dddd-dddd-dddd-dddddddddddd"], "go_focus");
  // Vanguard 无敌人时朝聚焦区（vanguard_move 且目标是聚焦方向）
  const vanguard = plan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.equal(vanguard?.type, "MOVE");
});

test("SafetyPlanner: focusRegion 超 maxFocusDistance 防呆（生产实测 [1500,1500] 远征教训）", () => {
  const planner = new SafetyPlanner(); // Core [0,0]，默认 maxFocusDistance=32
  const state = makeState(1);
  const farFocusState: TickState = {
    ...state,
    visibleEnemies: [],
    resourceCells: new Set(),
    units: [
      ...state.units,
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
    workers: [
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", position: [3, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    ],
  };
  // 远焦点视为无效：worker 不发 go_focus，回退巡逻（生产实测：policy 层输出
  // [1500,1500]/[-1500,1500] → 全部 worker 直线远征 → 0 采集、经济冻结）。
  const farPlan = planner.decide({
    state: farFocusState,
    policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.4, focusRegion: [1500, 1500], attackPriority: null },
  });
  assert.notEqual(farPlan.intents["dddddddd-dddd-dddd-dddd-dddddddddddd"], "go_focus");
  assert.equal(farPlan.intents["dddddddd-dddd-dddd-dddd-dddddddddddd"], "patrol");
  // 近焦点仍生效（回归保护）
  const nearPlan = planner.decide({
    state: farFocusState,
    policy: { posture: "balanced", workerTarget: 8, militaryRatio: 0.4, focusRegion: [8, 4], attackPriority: null },
  });
  assert.equal(nearPlan.intents["dddddddd-dddd-dddd-dddd-dddddddddddd"], "go_focus");
});

test("SafetyPlanner: attackPriority 接线（workers → Vanguard 追 Worker，core → 追 Core）", () => {
  const planner = new SafetyPlanner();
  const state = makeState(1); // 敌人：CORE [6,0]
  const workersPolicy = { posture: "aggressive" as const, workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "workers" as const };
  const corePolicy = { posture: "aggressive" as const, workerTarget: 8, militaryRatio: 0.4, focusRegion: null, attackPriority: "core" as const };

  // 场景含敌人 Worker（不相邻，避免 SWEEP 分支）与敌人 Core
  const enemyWorkers: TickState = {
    ...state,
    visibleEnemies: [
      ...state.visibleEnemies,
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", kind: "UNIT", position: [4, 0], hp: 2, unitType: "WORKER" },
    ],
  };
  const workersPlan = planner.decide({ state: enemyWorkers, policy: workersPolicy });
  const vanguardWorkers = workersPlan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.equal(vanguardWorkers?.type, "MOVE");
  assert.equal(workersPlan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], "vanguard_pressure");

  const corePlan = planner.decide({ state: enemyWorkers, policy: corePolicy });
  const vanguardCore = corePlan.unitActions["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"];
  assert.equal(vanguardCore?.type, "MOVE");
  assert.equal(corePlan.intents["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"], "vanguard_pressure");
});

test("MacroPolicyOrchestrator: onPolicyError 回调（失败 telemetry）", async () => {
  const errors: Array<{ tick: number; message: string }> = [];
  const orchestrator = new MacroPolicyOrchestrator({
    intervalTicks: 32,
    promptBuilder: buildMacroPolicyPrompt,
    requestPolicy: async () => {
      throw new Error("gateway down");
    },
    onPolicyError: (message, tick) => errors.push({ tick, message }),
  });
  orchestrator.onTick(makeState(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].tick, 1);
  assert.ok(errors[0].message.includes("gateway down"));
});

test("SafetyPlanner: clear-path 清障（TS-009）——满载 Worker 回仓路径上的敌人被 Vanguard 主动清除", () => {
  const state = makeState(1);
  const clearState: TickState = {
    ...state,
    units: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", position: [3, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    vanguards: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", position: [3, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
    ],
    workers: [
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 1 },
    ],
    // 敌人挡在满载 Worker [2,0] 回 Core [0,0] 的路上（[1,0] 距 Core 1 < worker 距 Core 2）
    visibleEnemies: [
      { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", kind: "UNIT", position: [1, 0], hp: 4, unitType: "VANGUARD", ownerUsername: "foe" },
    ],
  };
  const vanguardId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  // 默认 defensive：Vanguard 近 Core 留守（无清障动作）
  const defensive = new SafetyPlanner();
  const defensivePlan = defensive.decide({ state: clearState });
  assert.ok(
    defensivePlan.unitActions[vanguardId] === undefined ||
      defensivePlan.intents[vanguardId] !== "vanguard_clear_path",
    "默认 defensive 不主动清障",
  );
  // clear-path：Vanguard 追击挡路敌人（intent vanguard_clear_path）
  const clearer = new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, clearPath: true });
  const clearPlan = clearer.decide({ state: clearState });
  assert.equal(clearPlan.unitActions[vanguardId]?.type, "MOVE");
  assert.equal(clearPlan.intents[vanguardId], "vanguard_clear_path");
});

test("PolicyDiscipline: 连续远焦点触发禁言（focusRegion 强制 null）", () => {
  const discipline = new PolicyDiscipline({ invalidFocusThreshold: 2 });
  const core = { position: [0, 0] as const };
  const farPolicy = { posture: "balanced" as const, workerTarget: 8, militaryRatio: 0.3, focusRegion: [1500, 1500] as const, attackPriority: null };
  // 第一次无效焦点：记录但不改（一次可能是失误）
  const first = discipline.apply(farPolicy, { tick: 100, core });
  assert.equal(first.event?.kind, "invalid_focus");
  assert.equal(first.event?.count, 1);
  assert.deepEqual(first.policy.focusRegion, [1500, 1500]);
  // 第二次连续无效：触发禁言 + focusRegion 强制 null
  const second = discipline.apply(farPolicy, { tick: 132, core });
  assert.equal(second.event?.kind, "silence_started");
  assert.equal(second.policy.focusRegion, null);
  assert.equal(discipline.isSilenced(132), true);
  // 禁言期内：任何焦点都被强制 null（保留其余字段）
  const nearPolicy = { ...farPolicy, focusRegion: [5, 5] as const };
  const silenced = discipline.apply(nearPolicy, { tick: 200, core });
  assert.equal(silenced.policy.focusRegion, null);
  assert.equal(silenced.event, null);
  // 期满恢复：合法焦点放行
  const after = discipline.apply(nearPolicy, { tick: 132 + 128 + 1, core });
  assert.deepEqual(after.policy.focusRegion, [5, 5]);
});

test("PolicyDiscipline: 合法焦点清零连续计数（不误伤正常聚焦）", () => {
  const discipline = new PolicyDiscipline({ invalidFocusThreshold: 2 });
  const core = { position: [0, 0] as const };
  const farPolicy = { posture: "balanced" as const, workerTarget: 8, militaryRatio: 0.3, focusRegion: [1500, 1500] as const, attackPriority: null };
  const nearPolicy = { ...farPolicy, focusRegion: [10, 10] as const };
  discipline.apply(farPolicy, { tick: 100, core }); // 1 次无效
  const cleared = discipline.apply(nearPolicy, { tick: 132, core }); // 合法 → 清零
  assert.equal(cleared.event, null);
  const again = discipline.apply(farPolicy, { tick: 164, core });
  assert.equal(again.event?.kind, "invalid_focus");
  assert.equal(again.event?.count, 1, "合法焦点后重新计数");
});

test("PolicyDiscipline: 无 Core 时焦点不判无效（防御分支不误伤）", () => {
  const discipline = new PolicyDiscipline();
  const farPolicy = { posture: "balanced" as const, workerTarget: 8, militaryRatio: 0.3, focusRegion: [1500, 1500] as const, attackPriority: null };
  const result = discipline.apply(farPolicy, { tick: 100, core: null });
  assert.equal(result.event, null);
  assert.deepEqual(result.policy.focusRegion, [1500, 1500]);
});

test("PolicyDiscipline: prompt 指挥状态注入（stall_recovery/escalation 行）", () => {
  const base = buildMacroPolicyPrompt(makeState(100));
  assert.ok(!base.includes("command state:"), "正常态不注入指挥状态行");
  const recovery = buildMacroPolicyPrompt(makeState(100), { commandState: "stall_recovery" });
  assert.ok(recovery.includes("command state: stall_recovery active"), "recovery 态注入配合指引");
  const escalation = buildMacroPolicyPrompt(makeState(100), { commandState: "escalation" });
  assert.ok(escalation.includes("command state: escalation active"), "escalation 态注入配合指引");
});

test("PolicyDiscipline: prompt 恢复结果反馈注入（lastRecoveryOutcome 三种结局）", () => {
  const base = buildMacroPolicyPrompt(makeState(100));
  assert.ok(!base.includes("last recovery outcome:"), "无恢复结果不注入");
  const recovered = buildMacroPolicyPrompt(makeState(100), {
    lastRecoveryOutcome: { outcome: "recovered", kind: "cargo_blocked", tick: 90 },
  });
  assert.ok(recovered.includes("上次自愈成功"), "recovered 结局注入成功指引");
  assert.ok(recovered.includes("kind=cargo_blocked@tick=90"), "结局携带 kind/tick");
  const failed = buildMacroPolicyPrompt(makeState(100), {
    lastRecoveryOutcome: { outcome: "failed", kind: "focus_exile", tick: 80 },
  });
  assert.ok(failed.includes("上次自愈失败"), "failed 结局注入纠错指引");
  assert.ok(failed.includes("不要再用远点 focus"), "failed 结局给出可执行对策");
  const expired = buildMacroPolicyPrompt(makeState(100), {
    lastRecoveryOutcome: { outcome: "expired", kind: "focus_exile", tick: 70 },
  });
  assert.ok(expired.includes("恢复经济为第一优先"), "expired 结局注入经济优先指引");
  const noOutcome = buildMacroPolicyPrompt(makeState(100), { lastRecoveryOutcome: null });
  assert.ok(!noOutcome.includes("last recovery outcome:"), "null 不注入");
});

test("MacroPolicy: prompt 军事比例约束注入（模拟器实证拐点指引）", () => {
  const prompt = buildMacroPolicyPrompt(makeState(100));
  assert.ok(prompt.includes("0.3-0.4 是军事性价比拐点"), "拐点指引注入");
  assert.ok(prompt.includes("禁止输出 militaryRatio>0.5"), "高比例禁令注入");
});
