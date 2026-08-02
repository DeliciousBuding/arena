/** DecisionCoordinator 集成测试：16 暗卷（GPT 切片 3 清单）。
 *
 * 全部使用 FakeClock + FakeAgentRuntime（零真实 timer）：
 * 测试通过 clock.advance(ms) 确定性驱动 deadline。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { reduceTurn, type TurnLike } from "../src/domain/state-reducer.ts";
import { SafetyPlanner, DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import { validatePlan } from "../src/domain/plan-validator.ts";
import type { Plan, TickState } from "../src/domain/model.ts";
import { DecisionCoordinator } from "../src/runtime/decision-coordinator.ts";
import { LeaseRegistry } from "../src/runtime/lease-registry.ts";
import { PlanArbiter } from "../src/runtime/plan-arbiter.ts";
import { FakeAgentRuntime, FakeClock, type FakeRuntimeMode } from "../src/runtime/testing/fake-agent-runtime.ts";
import { emptyPlan } from "../src/domain/model.ts";
import type { AgentRunResult, CandidateEnvelope } from "../src/runtime/decision-types.ts";

const MIN_STATE: PlayerState = {
  status: "ACTIVE",
  respawn_at_tick: null,
  resources: 4,
  population: 1,
  population_tier: 0,
  upkeep_next_tick: 0,
  champion_beacon: { position: [0, 0], status: "GROUND", carrier_id: null },
  objects: [
    {
      kind: "CORE",
      id: "c1",
      controlled: true,
      owner_username: "fixture_user",
      position: [0, 0],
      hp: 5,
      shield: 5,
      state: "NORMAL",
      move_direction: null,
      move_progress: null,
      move_required_ticks: null,
      destination: null,
    },
    {
      kind: "UNIT",
      id: "u1",
      controlled: true,
      position: [0, 1],
      hp: 2,
      unit_type: "WORKER",
      cargo: 0,
    },
    {
      kind: "UNIT",
      id: "u2",
      controlled: true,
      position: [0, 2],
      hp: 2,
      unit_type: "WORKER",
      cargo: 0,
    },
  ],
  events: [],
};

const BUDGET = { agentSoftMs: 100, selectionMs: 200, submitMs: 300, hardMs: 400 };

interface Harness {
  clock: FakeClock;
  runtime: FakeAgentRuntime;
  registry: LeaseRegistry;
  coordinator: DecisionCoordinator;
  state: TickState;
}

function makeState(tick: number): TickState {
  const turn = new Turn(tick, MIN_STATE, (() => {}) as never);
  return reduceTurn(turn as unknown as TurnLike);
}

function makeHarness(mode: FakeRuntimeMode, plan?: Plan): Harness {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({
    sink: () => {},
    mode,
    clock,
    ...(plan !== undefined ? { plan } : {}),
  });
  const registry = new LeaseRegistry();
  const planner = new SafetyPlanner(DEFAULT_SAFETY_CONFIG);
  const coordinator = new DecisionCoordinator({
    runtime,
    planner,
    registry,
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (deadlineMs, c) =>
      new Promise<void>((resolve) => {
        (c as FakeClock).setTimeout(() => resolve(), Math.max(0, deadlineMs - c.now()));
      }),
  });
  return { clock, runtime, registry, coordinator, state: makeState(100) };
}

function agentPlan(tick: number, unitActions?: Plan["unitActions"]): Plan {
  return { tick, unitActions: unitActions ?? {}, coreAction: null, intents: {} };
}

// ---------- 1-3：基本路径 ----------

test("1. Agent 立即给出合法计划 → agent", async () => {
  const h = makeHarness("immediate-valid", agentPlan(100, {
    u1: { type: "MOVE", direction: "UP" },
    u2: { type: "MOVE", direction: "LEFT" },
  }));
  const result = await h.coordinator.decide(h.state);
  assert.equal(result.source, "agent");
  assert.equal(result.deadlineOutcome, "candidate");
  assert.ok(result.plan.unitActions.u1 !== undefined);
});

test("2. Agent 半合法计划 → hybrid", async () => {
  // u1/u2 合法（MOVE），ghost 非法（不存在）→ 2/3 合法 < 阈值 0.5 → hybrid
  const h = makeHarness("immediate-valid", agentPlan(100, {
    u1: { type: "MOVE", direction: "UP" },
    u2: { type: "MOVE", direction: "LEFT" },
    ghost: { type: "MOVE", direction: "RIGHT" },
  }));
  const result = await h.coordinator.decide(h.state);
  assert.equal(result.source, "hybrid");
  assert.ok(result.invalidAgentActionCount >= 1);
});

test("3. Agent 不返回 → soft deadline 时 safety", async () => {
  const h = makeHarness("never-settles");
  const pending = h.coordinator.decide(h.state);
  h.clock.advance(100); // 到 soft deadline
  const result = await pending;
  assert.equal(result.source, "safety");
  assert.equal(result.deadlineOutcome, "soft_deadline");
  assert.equal(result.abortRequested, true);
});

// ---------- 4-6：deadline 边界 ----------

test("4. 候选在 deadline 前 1ms 到达 → 可接受", async () => {
  const h = makeHarness("delayed-valid", agentPlan(100, { u1: { type: "MOVE", direction: "UP" } }));
  const pending = h.coordinator.decide(h.state);
  h.clock.advance(50); // 候选在 soft(100) 前 50ms 到达（delayMs 缺省 50）
  const result = await pending;
  assert.equal(result.source, "agent");
});

test("5. 候选恰好在 deadline 到达 → 拒绝（Lease now>=deadline 即过期）", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ sink: () => {}, mode: "never-settles", clock });
  const registry = new LeaseRegistry();
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry,
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) => new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  const pending = coordinator.decide(makeState(100));
  // 候选精确安排在 soft deadline(100) 时刻投递（经 sink → Lease 校验）
  clock.setTimeout(() => {
    coordinator.sink({
      protocolVersion: "1", runId: "t1-100-0", tenantId: "t1",
      tick: 100, stateHash: "h", plan: agentPlan(100), reason: "at-deadline", confidence: null,
    });
  }, 100);
  clock.advance(100); // 候选与 deadline 同时触发
  const result = await pending;
  assert.equal(result.source, "safety"); // 候选被 Lease 拒绝
});

test("6. Agent 在 deadline 后提交 → stale rejection", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({
    sink: () => {},
    mode: "delayed-valid",
    clock,
    delayMs: 150, // 提交在 soft(100) 之后
  });
  const registry = new LeaseRegistry();
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry,
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) => new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  const pending = coordinator.decide(makeState(100));
  clock.advance(150); // 越过 soft：先 expire，后候选到达 → 拒绝
  const result = await pending;
  assert.equal(result.source, "safety");
});

// ---------- 7-9：runId/tick/stateHash/重复 ----------

test("7. 旧 Tick tool call 在下一 Tick 到达 → 永不执行", async () => {
  const h = makeHarness("never-settles");
  const r1 = h.coordinator.decide(h.state);
  h.clock.advance(100);
  await r1; // tick 100 → safety
  const oldRunId = h.runtime.abortLog[0]?.runId ?? "t1-100-0";
  // 下一 Tick：旧 run 的迟到候选投递
  const state2 = makeState(101);
  const r2 = h.coordinator.decide(state2);
  // 旧 runId 候选 → registry 拒绝（该 lease 已 selected/expired）
  h.coordinator.sink({
    protocolVersion: "1", runId: oldRunId, tenantId: "t1",
    tick: 100, stateHash: "h", plan: agentPlan(100), reason: "late", confidence: null,
  });
  h.clock.advance(100);
  const result2 = await r2;
  assert.equal(result2.source, "safety"); // 旧候选未影响新 Tick
  assert.equal(result2.tick, 101);
});

test("8. 错误 runId/tick/stateHash → 拒绝", async () => {
  const h = makeHarness("submits-wrong-run", agentPlan(100));
  const p1 = h.coordinator.decide(h.state);
  h.clock.advance(100); // 错误 runId 候选被拒 → 等 soft deadline → safety
  const r1 = await p1;
  assert.equal(r1.source, "safety");
  const h2 = makeHarness("submits-wrong-tick", agentPlan(100));
  const p2 = h2.coordinator.decide(h2.state);
  h2.clock.advance(100);
  const r2 = await p2;
  assert.equal(r2.source, "safety");
  const h3 = makeHarness("submits-wrong-state", agentPlan(100));
  const p3 = h3.coordinator.decide(h3.state);
  h3.clock.advance(100);
  const r3 = await p3;
  assert.equal(r3.source, "safety");
});

test("9. 重复 arena_plan → 只接受第一次", async () => {
  const h = makeHarness("submits-twice", agentPlan(100, { u1: { type: "MOVE", direction: "UP" } }));
  const result = await h.coordinator.decide(h.state);
  assert.equal(result.source, "agent"); // 第一次 accepted
  assert.ok(result.plan.unitActions.u1 !== undefined);
});

// ---------- 10-12：异常/abort/重叠 ----------

test("10. Agent 抛异常 → safety", async () => {
  const h = makeHarness("throws");
  const pending = h.coordinator.decide(h.state);
  h.clock.advance(100); // throws 延时 settle，无候选 → soft deadline → safety
  const result = await pending;
  assert.equal(result.source, "safety");
});

test("11. Agent 无视 abort → 当前 Tick 仍正常返回", async () => {
  // submits-after-abort：abort 后才提交候选（无视取消信号）→ lease 已 expire → 拒绝；
  // 但当前 Tick 正常返回 safety，不卡死、不等待 abort settle
  const h = makeHarness("submits-after-abort", agentPlan(100, {
    u1: { type: "MOVE", direction: "UP" },
    u2: { type: "MOVE", direction: "LEFT" },
  }));
  const pending = h.coordinator.decide(h.state);
  h.clock.advance(100); // soft deadline → abort 发出（submits-after-abort 此时才提交 → 被拒）
  const result = await pending;
  assert.equal(result.source, "safety"); // abort 后提交被拒，safety 固定
  assert.equal(result.abortRequested, true);
  assert.ok(h.runtime.abortLog.length >= 1);
});

test("12. 上一 run 未 settle → 下一 Tick 拒绝重叠 → degraded safety", async () => {
  const h = makeHarness("never-settles");
  const r1 = h.coordinator.decide(h.state);
  h.clock.advance(100);
  await r1; // tick 100：safety，run 仍 active（never-settles）
  const r2 = h.coordinator.decide(makeState(101));
  h.clock.advance(100);
  const result2 = await r2;
  assert.equal(result2.source, "safety"); // 重叠拒绝 → 无 handle → safety
});

// ---------- 13-15：selection/repair/emergency ----------

test("13. 候选在 soft 前到达 → 计划在 selection deadline 前固定", async () => {
  const h = makeHarness("delayed-valid", agentPlan(100, { u1: { type: "MOVE", direction: "UP" } }));
  let resolved = false;
  const pending = h.coordinator.decide(h.state).then((r) => {
    resolved = true;
    return r;
  });
  h.clock.advance(50); // 候选到达 → 立即固定
  const result = await pending;
  assert.equal(resolved, true);
  assert.equal(result.source, "agent");
  assert.ok(result.selectionLatencyMs < BUDGET.selectionMs);
});

test("14. 最终计划必过 validator（即使 Safety 被 repair 仍标 safety）", async () => {
  const h = makeHarness("never-settles");
  const pending = h.coordinator.decide(h.state);
  h.clock.advance(100);
  const result = await pending;
  assert.equal(result.source, "safety");
  const validation = validatePlan(h.state, result.plan);
  assert.equal(validation.valid, true);
});

test("15. SafetyPlanner 抛异常 → emergency", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ sink: () => {}, mode: "never-settles", clock });
  const brokenPlanner = {
    decide: () => {
      throw new Error("planner exploded");
    },
  } as unknown as SafetyPlanner;
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: brokenPlanner,
    registry: new LeaseRegistry(),
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) => new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  const pending = coordinator.decide(makeState(100));
  clock.advance(100);
  const result = await pending;
  assert.equal(result.source, "emergency");
  assert.equal(validatePlan(makeState(100), result.plan).valid, true);
});

// ---------- 16：压力无泄漏 ----------

test("16. 1000 模拟 Tick：registry 有界 + 全部 settle", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ sink: () => {}, mode: "immediate-valid", clock });
  const registry = new LeaseRegistry();
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry,
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) => new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  for (let i = 0; i < 1000; i += 1) {
    const pending = coordinator.decide(makeState(1000 + i));
    clock.advance(150);
    await pending;
  }
  const stats = registry.stats();
  assert.ok(stats.total <= 1100, `registry 有界（实际 ${stats.total}）`);
  assert.equal(runtime.settleLog.length, 1000); // 全部 settle
});

// ---------- 17-20：3E 勘误（runId 单源 / 启动失败立即 Safety / selection deadline / settle telemetry） ----------

test("17. handle.runId ≠ request.runId → 立即 abort + Safety + violation（不等 deadline）", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({
    sink: () => {},
    mode: "never-settles",
    clock,
    handleRunId: () => "rogue-run",
  });
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry: new LeaseRegistry(),
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) =>
      new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  let resolved = false;
  const pending = coordinator.decide(makeState(100)).then((r) => {
    resolved = true;
    return r;
  });
  const result = await pending; // 不 advance：startDecision 返回后同步检测
  assert.equal(resolved, true);
  assert.equal(result.source, "safety");
  assert.equal(result.deadlineOutcome, "error");
  assert.ok(runtime.violationLog.some((v) => v.includes("run_id_mismatch")));
  assert.ok(runtime.abortLog.some((a) => a.reason.includes("run_id_mismatch")));
  assert.equal(runtime.health().ready, false); // runtime 标记 unhealthy
});

test("18. 上一 run active → startDecision 抛错 → 立即 Safety（不等 soft deadline）", async () => {
  const h = makeHarness("never-settles");
  const r1 = h.coordinator.decide(h.state);
  h.clock.advance(100);
  await r1; // tick 100 → safety，run 仍 active（never-settles）
  let resolved = false;
  const p2 = h.coordinator.decide(makeState(101)).then((r) => {
    resolved = true;
    return r;
  });
  const r2 = await p2; // 不 advance：startDecision 抛错 → 立即返回
  assert.equal(resolved, true);
  assert.equal(r2.source, "safety");
  assert.equal(r2.deadlineOutcome, "error");
  assert.equal(r2.tick, 101);
});

test("19. 选择过程超过 selection deadline → 弃候选，用已准备好的 SafetyPlan", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({
    sink: () => {},
    mode: "delayed-valid",
    clock,
    plan: agentPlan(100, { u1: { type: "MOVE", direction: "UP" } }),
  });
  const realArbiter = new PlanArbiter();
  // 注入慢 arbiter：arbitrate 期间推进时钟越过 selection deadline(200)
  const slowArbiter = {
    arbitrate: (input: Parameters<PlanArbiter["arbitrate"]>[0]) => {
      clock.advance(250);
      return realArbiter.arbitrate(input);
    },
    emergencyPlan: (s: TickState) => realArbiter.emergencyPlan(s),
  } as unknown as PlanArbiter;
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry: new LeaseRegistry(),
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    arbiter: slowArbiter,
    sleepUntil: (d, c) =>
      new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
  });
  const pending = coordinator.decide(makeState(100));
  clock.advance(100); // 候选 50ms 投递（accepted）；raceCandidate 在 soft(100) 取回候选
  const result = await pending; // 慢 arbiter 已把时钟推到 350（> selection 200）
  assert.equal(result.source, "safety"); // 候选被弃，SafetyPlan 固定
  assert.equal(result.deadlineOutcome, "selection_timeout");
  assert.ok(result.selectionLatencyMs >= BUDGET.selectionMs);
});

test("20. run 最终 settle 经 onRunSettled telemetry 上报（不阻塞决策路径）", async () => {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ sink: () => {}, mode: "submits-after-abort", clock });
  const settledEvents: Array<{ runId: string; result: AgentRunResult }> = [];
  const coordinator = new DecisionCoordinator({
    runtime,
    planner: new SafetyPlanner(DEFAULT_SAFETY_CONFIG),
    registry: new LeaseRegistry(),
    clock,
    budgetConfig: BUDGET,
    tenantId: "t1",
    rulesVersion: "v0.11",
    configHash: "test",
    sleepUntil: (d, c) =>
      new Promise<void>((r) => (c as FakeClock).setTimeout(() => r(), Math.max(0, d - c.now()))),
    onRunSettled: (info) => settledEvents.push(info),
  });
  const pending = coordinator.decide(makeState(100));
  clock.advance(100); // soft → abort → submits-after-abort 提交并 settle
  const result = await pending;
  assert.equal(result.source, "safety");
  assert.equal(result.abortRequested, true);
  await new Promise((r) => setTimeout(r, 0)); // 微任务 flush（后台观察）
  assert.ok(settledEvents.some((e) => e.runId === "t1-100-0" && e.result.outcome === "settled"));
});
