/** FakeAgentRuntime + isCandidateEnvelope 测试（2026-08-03）。
 *
 * 验收口径：
 * - 每种模式确定性可复现（无真实 sleep，全部 FakeClock / 手动触发）；
 * - 候选确实经 sink 投递（不是 return 捷径）；
 * - 重叠 run 被拒；
 * - abort 语义按模式区分；
 * - 无 unhandled rejection（settled 永远 resolve；node:test 对未处理拒绝会直接报错）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { DecisionContext, AgentDecisionRequest, AgentRunResult, CandidateEnvelope } from "../src/runtime/decision-types.ts";
import { isCandidateEnvelope } from "../src/runtime/agent-runtime.ts";
import { FakeAgentRuntime, FakeClock, type FakeAgentRuntimeOptions, type FakeRuntimeMode, type FakeRuntimeModeSelector } from "../src/runtime/testing/fake-agent-runtime.ts";
import { emptyPlan, type Plan, type TickState } from "../src/domain/model.ts";
import { hashTickState } from "../src/runtime/state-hash.ts";

const CORE = {
  id: "core-1",
  position: [0, 0] as const,
  hp: 5,
  shield: 5,
  state: "NORMAL" as const,
  ownerUsername: "buding",
};

function makeState(tick: number): TickState {
  return {
    tick,
    status: "ACTIVE",
    resources: 6,
    resourceCapacity: 10,
    resourceSpace: 4,
    population: 0,
    core: CORE,
    units: [],
    workers: [],
    vanguards: [],
    rangers: [],
    visibleEnemies: [],
    resourceCells: new Set(),
    obstacleCells: new Set(),
    beacon: { position: [100, 100], status: "GROUND", carrierId: null },
    events: [],
  };
}

function request(tick: number, options: Partial<AgentDecisionRequest> = {}): AgentDecisionRequest {
  const state = makeState(tick);
  const stateHash = hashTickState(state);
  const context: DecisionContext = {
    tenantId: "tenant-1",
    tick,
    stateHash,
    mapRevision: null,
    rulesVersion: "rules-v1",
    configHash: "cfg-hash",
    receivedAtMonotonic: 0,
  };
  return {
    runId: `tenant-1-${tick}-0`, // 3E-1 单源：request 必须携带 coordinator 分配的 runId
    tenantId: "tenant-1",
    tick,
    state,
    stateHash,
    context,
    ...options,
  };
}

function makeRuntime(
  mode: FakeRuntimeModeSelector,
  options: Partial<FakeAgentRuntimeOptions> = {},
): { runtime: FakeAgentRuntime; envelopes: CandidateEnvelope[] } {
  const envelopes: CandidateEnvelope[] = [];
  const runtime = new FakeAgentRuntime({ sink: (envelope) => envelopes.push(envelope), mode, ...options });
  return { runtime, envelopes };
}

// ---------- 模式：确定性复现（无真实 timer） ----------

test("immediate-valid 经 sink 同步投递合法候选并 settle", async () => {
  const { runtime, envelopes } = makeRuntime("immediate-valid");
  const req = request(7);
  const handle = runtime.startDecision(req);

  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(envelopes.length, 1);
  const envelope = envelopes[0];
  assert.equal(envelope.protocolVersion, "1");
  assert.equal(envelope.runId, handle.runId);
  assert.equal(envelope.tenantId, req.tenantId);
  assert.equal(envelope.tick, req.tick);
  assert.equal(envelope.stateHash, req.stateHash);
  assert.equal(envelope.plan.tick, req.tick);
  assert.equal(envelope.reason, "fake runtime candidate");
  assert.equal(envelope.confidence, null);
  // 候选不是 return 的：runtime 不暴露任何 getCandidate() 读取口
  assert.deepEqual(runtime.submissions, envelopes);
  assert.equal(runtime.activeRunId, null);
});

test("delayed-valid 在 delayMs 之前不投递，推进时钟后投递并 settle", async () => {
  const { runtime, envelopes } = makeRuntime("delayed-valid", { delayMs: 100 });
  const handle = runtime.startDecision(request(3));

  assert.equal(envelopes.length, 0);
  runtime.clock.advance(99);
  assert.equal(envelopes.length, 0);
  assert.equal(runtime.activeRunId, handle.runId);

  runtime.clock.advance(1);
  assert.equal(envelopes.length, 1);
  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(runtime.activeRunId, null);
});

test("never-settles 推进时钟与 abort 均不结束 run", async () => {
  const { runtime, envelopes } = makeRuntime("never-settles");
  const handle = runtime.startDecision(request(1));

  let resolved: AgentRunResult | null = null;
  handle.settled.then((result) => {
    resolved = result;
  });

  runtime.clock.advance(10_000);
  handle.abort("deadline");
  runtime.clock.advance(10_000);
  await Promise.resolve();

  assert.equal(envelopes.length, 0);
  assert.equal(resolved, null, "never-settles 永不 settle");
  assert.equal(runtime.activeRunId, handle.runId);
  assert.deepEqual(runtime.abortLog, [{ runId: handle.runId, reason: "deadline" }]);
});

test("throws 以 error settle", async () => {
  const { runtime } = makeRuntime("throws", { delayMs: 10, failMessage: "agent exploded" });
  const handle = runtime.startDecision(request(4));

  let resolved: AgentRunResult | null = null;
  handle.settled.then((result) => {
    resolved = result;
  });
  await Promise.resolve();
  assert.equal(resolved, null, "throws 也要等时钟推进（无真实 timer）");

  runtime.clock.advance(10);
  await Promise.resolve();
  assert.deepEqual(resolved, { outcome: "error", message: "agent exploded" });
  assert.equal(runtime.activeRunId, null);
});

test("submits-wrong-run 投递 runId 错误的候选", async () => {
  const { runtime, envelopes } = makeRuntime("submits-wrong-run", { wrongRunId: "run-other" });
  const handle = runtime.startDecision(request(5));
  await handle.settled;

  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].runId, "run-other");
  assert.notEqual(envelopes[0].runId, handle.runId);
});

test("submits-wrong-tick 投递 tick 错误的候选", async () => {
  const { runtime, envelopes } = makeRuntime("submits-wrong-tick", { wrongTick: 99 });
  const req = request(5);
  const handle = runtime.startDecision(req);
  await handle.settled;

  assert.equal(envelopes[0].tick, 99);
  assert.notEqual(envelopes[0].tick, req.tick);
});

test("submits-wrong-state 投递 stateHash 错误的候选", async () => {
  const { runtime, envelopes } = makeRuntime("submits-wrong-state");
  const req = request(5);
  const handle = runtime.startDecision(req);
  await handle.settled;

  assert.equal(envelopes[0].stateHash, `wrong-${req.stateHash}`);
  assert.notEqual(envelopes[0].stateHash, req.stateHash);
});

test("submits-twice 按序投递两个候选（reason 可区分）", async () => {
  const { runtime, envelopes } = makeRuntime("submits-twice");
  const req = request(6);
  const handle = runtime.startDecision(req);
  await handle.settled;

  assert.equal(envelopes.length, 2);
  assert.deepEqual(
    envelopes.map((e) => e.reason),
    ["first", "second"],
  );
  assert.equal(envelopes[0].runId, handle.runId);
  assert.equal(envelopes[1].runId, handle.runId);
  assert.deepEqual(envelopes[1].plan, envelopes[0].plan);
});

test("submits-after-abort 不 abort 则永不 settle，abort 后提交并 settle", async () => {
  const { runtime, envelopes } = makeRuntime("submits-after-abort");
  const handle = runtime.startDecision(request(8));

  runtime.clock.advance(10_000);
  assert.equal(envelopes.length, 0);

  handle.abort("selection deadline hit");
  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].runId, handle.runId);
  assert.deepEqual(runtime.abortLog, [{ runId: handle.runId, reason: "selection deadline hit" }]);
});

test("ignores-abort 照常延时提交并 settle，abort 无效果", async () => {
  const { runtime, envelopes } = makeRuntime("ignores-abort", { delayMs: 100 });
  const handle = runtime.startDecision(request(2));
  handle.abort("cancel");
  runtime.clock.advance(100);

  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(envelopes.length, 1);
  assert.deepEqual(runtime.abortLog, [{ runId: handle.runId, reason: "cancel" }]);
});

// ---------- 生命周期硬规则 ----------

test("正常模式 abort 立即结束未 settle 的 run 且不再提交", async () => {
  const { runtime, envelopes } = makeRuntime("delayed-valid", { delayMs: 100 });
  const handle = runtime.startDecision(request(9));
  handle.abort("timeout");

  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(envelopes.length, 0);
  runtime.clock.advance(10_000);
  assert.equal(envelopes.length, 0, "abort 后延时任务被取消");
  assert.equal(runtime.activeRunId, null);
});

test("重叠 run 被拒：上一 run 未 settle 时 startDecision 同步抛错（任意模式）", () => {
  const { runtime } = makeRuntime("never-settles");
  const first = runtime.startDecision(request(1));
  assert.equal(runtime.activeRunId, first.runId);

  assert.throws(() => runtime.startDecision(request(2)), /overlapping run/);
});

test("rejects-overlap 模式显式表达重叠拒绝，行为同 immediate-valid", async () => {
  const { runtime, envelopes } = makeRuntime("rejects-overlap");
  const handle = runtime.startDecision(request(10));
  await handle.settled;
  assert.deepEqual(envelopes.map((e) => e.reason), ["fake runtime candidate"]);

  // settle 后可以再开新 run
  const second = runtime.startDecision(request(11));
  await second.settled;
  assert.equal(envelopes.length, 2);
});

test("abort 对已 settle 的 run 是 no-op", async () => {
  const { runtime } = makeRuntime("immediate-valid");
  const handle = runtime.startDecision(request(12));
  await handle.settled;

  handle.abort("late abort");
  assert.deepEqual(runtime.abortLog, []);
  assert.equal(runtime.settleLog.length, 1);
});

test("health 反映 active run；close 强制 settle 并拒绝新 run", async () => {
  const { runtime } = makeRuntime("never-settles");
  assert.deepEqual(runtime.health(), { ready: true, activeRunId: null });

  const handle = runtime.startDecision(request(13));
  assert.deepEqual(runtime.health(), { ready: true, activeRunId: handle.runId });

  await runtime.close();
  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.deepEqual(runtime.health(), { ready: false, activeRunId: null, reason: "closed" });
  assert.throws(() => runtime.startDecision(request(14)), /closed/);
});

// ---------- 候选路径：必须经 sink，无 return 捷径 ----------

test("sink 抛错 → run 以 error settle，不形成 unhandled rejection", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const runtime = new FakeAgentRuntime({
    sink: (envelope) => {
      envelopes.push(envelope);
      throw new Error("lease rejected");
    },
    mode: "immediate-valid",
  });
  const handle = runtime.startDecision(request(15));

  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "error", message: "sink rejected: lease rejected" });
  assert.equal(envelopes.length, 1, "投递尝试仍被记录");
  assert.equal(runtime.settleLog.length, 1);
  assert.equal(runtime.settleLog[0].result.outcome, "error");
});

test("候选 plan 可由选项定制（函数形式按请求生成）", async () => {
  const customPlan: Plan = { tick: 99, unitActions: {}, coreAction: null, intents: { hmm: "custom" } };
  const { runtime, envelopes } = makeRuntime("immediate-valid", {
    plan: (req) => (req.tick === 16 ? customPlan : emptyPlan(req.tick)),
  });
  const handle = runtime.startDecision(request(16));
  await handle.settled;
  assert.deepEqual(envelopes[0].plan, customPlan);
});

// ---------- 模式选择：按请求动态选 ----------

test("mode 函数按请求逐 tick 选择模式", async () => {
  const { runtime, envelopes } = makeRuntime((req) => (req.tick % 2 === 0 ? "immediate-valid" : "delayed-valid"), {
    delayMs: 100,
  });

  // tick 1（奇数）→ delayed-valid：先不投递
  const odd = runtime.startDecision(request(1));
  assert.equal(envelopes.length, 0);
  runtime.clock.advance(100);
  await odd.settled;
  assert.equal(envelopes.length, 1);

  // tick 2（偶数）→ immediate-valid：立即投递
  const even = runtime.startDecision(request(2));
  await even.settled;
  assert.equal(envelopes.length, 2);
});

// ---------- FakeClock 本身 ----------

test("FakeClock advance 按到期顺序触发，任务可再注册任务", () => {
  const clock = new FakeClock();
  const order: string[] = [];
  clock.setTimeout(() => order.push("a"), 10);
  clock.setTimeout(() => order.push("b"), 5);
  clock.setTimeout(() => {
    order.push("c");
    clock.setTimeout(() => order.push("c2"), 1);
  }, 5);
  clock.setTimeout(() => order.push("d"), 0);

  clock.advance(10);
  assert.deepEqual(order, ["d", "b", "c", "a"]);
  assert.equal(clock.now(), 10);
  // 触发中新注册的任务（dueAt=11）由下一次 advance 驱动
  clock.advance(1);
  assert.deepEqual(order, ["d", "b", "c", "a", "c2"]);
});

test("FakeClock setTimeout 返回的取消函数可撤销任务", () => {
  const clock = new FakeClock();
  const order: string[] = [];
  const cancel = clock.setTimeout(() => order.push("x"), 5);
  cancel();
  clock.advance(100);
  assert.deepEqual(order, []);
});

// ---------- isCandidateEnvelope 类型守卫 ----------

test("isCandidateEnvelope 接受合法信封", () => {
  const envelope: CandidateEnvelope = {
    protocolVersion: "1",
    runId: "fake-run-1",
    tenantId: "tenant-1",
    tick: 7,
    stateHash: "abc",
    plan: { tick: 7, unitActions: {}, coreAction: null, intents: {} },
    reason: "harvest",
    confidence: 0.9,
  };
  assert.equal(isCandidateEnvelope(envelope), true);
  // 窄化生效：守卫通过后可按 CandidateEnvelope 访问字段
  if (isCandidateEnvelope(envelope)) {
    assert.equal(envelope.protocolVersion, "1");
  }
});

test("isCandidateEnvelope 拒绝结构不合法输入", () => {
  const base: CandidateEnvelope = {
    protocolVersion: "1",
    runId: "fake-run-1",
    tenantId: "tenant-1",
    tick: 7,
    stateHash: "abc",
    plan: { tick: 7, unitActions: {}, coreAction: null, intents: {} },
    reason: "harvest",
    confidence: null,
  };
  assert.equal(isCandidateEnvelope(null), false);
  assert.equal(isCandidateEnvelope("1"), false);
  assert.equal(isCandidateEnvelope({}), false);
  assert.equal(isCandidateEnvelope({ ...base, protocolVersion: "2" }), false);
  assert.equal(isCandidateEnvelope({ ...base, runId: "" }), false);
  assert.equal(isCandidateEnvelope({ ...base, runId: undefined }), false);
  assert.equal(isCandidateEnvelope({ ...base, tenantId: "" }), false);
  assert.equal(isCandidateEnvelope({ ...base, tick: 1.5 }), false);
  assert.equal(isCandidateEnvelope({ ...base, tick: "7" }), false);
  assert.equal(isCandidateEnvelope({ ...base, stateHash: "" }), false);
  assert.equal(isCandidateEnvelope({ ...base, reason: 42 }), false);
  assert.equal(isCandidateEnvelope({ ...base, confidence: NaN }), false);
  assert.equal(isCandidateEnvelope({ ...base, confidence: "high" }), false);
  assert.equal(isCandidateEnvelope({ ...base, plan: null }), false);
  assert.equal(isCandidateEnvelope({ ...base, plan: { tick: 7, unitActions: {}, coreAction: null } }), false);
  assert.equal(isCandidateEnvelope({ ...base, plan: { tick: 7, unitActions: {}, coreAction: null, intents: [] } }), false);
});
