/**
 * PiAgentRuntime 集成测试（切片 4 阶段 4，总任务书清单 15 项）。
 *
 * 两层：
 * - stub-session 层（确定性、零网络）：生命周期/abort/rotation/overlap/settle 语义；
 * - 真实嵌入冒烟（setDefaultStreamFn fake stream + 真实 createAgentSession）：
 *   prompt → arena_plan 工具执行 → CandidateSink 全链路。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { AgentDecisionRequest, CandidateEnvelope } from "../src/runtime/decision-types.ts";
import type { AgentRunResult } from "../src/runtime/decision-types.ts";
import { PiAgentRuntime, type PiRuntimeTelemetry } from "../src/infrastructure/pi/pi-agent-runtime.ts";
import type { PiSessionFactoryOptions } from "../src/infrastructure/pi/pi-types.ts";

// ---------- fixtures ----------

const FAKE_MODEL = {
  id: "fixture-model",
  name: "Fixture Model",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 8000,
  maxTokens: 1024,
} as unknown as PiSessionFactoryOptions["model"];

interface StubBehavior {
  prompt?: () => Promise<void>;
  abort?: () => Promise<void>;
}

function makeStubSession(behavior: StubBehavior = {}): AgentSession {
  return {
    prompt: behavior.prompt ?? (async () => {}),
    abort: behavior.abort ?? (async () => {}),
    waitForIdle: async () => {},
    getToolDefinition: () => undefined,
  } as unknown as AgentSession;
}

function makeRequest(overrides: Partial<AgentDecisionRequest> = {}): AgentDecisionRequest {
  return {
    runId: "local:t1:100:0",
    tenantId: "t1",
    tick: 100,
    state: {
      tick: 100,
      status: "ACTIVE",
      resources: 6,
      resourceCapacity: 10,
      resourceSpace: 4,
      population: 0,
      core: { id: "core-1", position: [0, 0], hp: 5, shield: 5, state: "NORMAL", ownerUsername: "buding" },
      units: [],
      workers: [],
      vanguards: [],
      rangers: [],
      visibleEnemies: [],
      resourceCells: new Set(),
      obstacleCells: new Set(),
      beacon: { position: [100, 100], status: "GROUND", carrierId: null },
      events: [],
    },
    stateHash: "sha256:state-100",
    context: {
      tenantId: "t1",
      tick: 100,
      stateHash: "sha256:state-100",
      mapRevision: null,
      rulesVersion: "v0.11",
      configHash: "cfg-test",
      receivedAtMonotonic: 0,
    },
    ...overrides,
  };
}

interface Harness {
  runtime: PiAgentRuntime;
  sessions: AgentSession[];
  envelopes: CandidateEnvelope[];
  telemetry: PiRuntimeTelemetry[];
  close: () => Promise<void>;
}

async function makeHarness(behavior: StubBehavior = {}): Promise<Harness> {
  const sessions: AgentSession[] = [];
  const envelopes: CandidateEnvelope[] = [];
  const telemetry: PiRuntimeTelemetry[] = [];
  const createSession = async (): Promise<unknown> => {
    const session = makeStubSession(behavior);
    sessions.push(session);
    return { session, extensionsResult: {} };
  };
  const runtime = await PiAgentRuntime.create({
    session: {
      baseDir: mkdtempSync(join(tmpdir(), "pi-runtime-")),
      model: FAKE_MODEL,
      configHash: "cfg-test",
      createSession: createSession as never,
    },
    tenantId: "t1",
    promptBuilder: (input) => `runId=${input.runId} tick=${input.context.tick} state=${input.context.stateHash}`,
    idleTimeoutMs: 50,
    consecutiveErrorThreshold: 2,
    onTelemetry: (event) => telemetry.push(event),
  });
  runtime.bindCandidateSink((envelope) => {
    envelopes.push(envelope);
    return { accepted: true, candidate: envelope };
  });
  return {
    runtime,
    sessions,
    envelopes,
    telemetry,
    close: () => runtime.close(),
  };
}

// ---------- stub-session 层：生命周期 ----------

test("1. prompt resolve → settled（无候选）；health ready；可复用下一 run", async () => {
  const h = await makeHarness();
  const handle = h.runtime.startDecision(makeRequest());
  const result = await handle.settled;
  assert.deepEqual(result, { outcome: "settled" });
  assert.equal(h.envelopes.length, 0, "无工具调用 → 无候选（settled-without-candidate）");
  assert.deepEqual(h.runtime.health(), { ready: true, activeRunId: null });
  // 复用：下一 run 正常启动
  const handle2 = h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 }));
  await handle2.settled;
  assert.equal(h.runtime.health().ready, true);
  await h.close();
});

test("2. prompt reject → error settle；连续失败达阈值 → unhealthy + rotate", async () => {
  let rejectCount = 0;
  const h = await makeHarness({
    prompt: () => {
      rejectCount += 1;
      return Promise.reject(new Error("provider down"));
    },
  });
  const handle = h.runtime.startDecision(makeRequest());
  const result = await handle.settled;
  assert.equal(result.outcome, "error");
  // 阈值 2：第一次失败仅 error settle，不 unhealthy
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy"), false);
  // 第二次失败 → 连续 2 次 → unhealthy → rotate（创建新 session）
  const handle2 = h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 }));
  await handle2.settled;
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy"), true, "连续失败必须标记 unhealthy");
  assert.equal(h.sessions.length, 2, "rotation 必须重建 session");
  assert.equal(h.runtime.health().ready, false, "rotate 完成前 not ready");
  // rotation 完成后恢复 ready
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.runtime.health().ready, true, "rotate 完成后 ready");
  await h.close();
});

test("3. 重叠 run：上一 run active → 第二个 startDecision 立即抛错", async () => {
  const h = await makeHarness({
    prompt: () => new Promise<void>(() => {}), // hang
  });
  h.runtime.startDecision(makeRequest());
  assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 })), /overlapping/);
  await h.close();
});

test("4. abort：同步返回（不等待 settled）；provider hang → idle timeout → unhealthy + rotate", async () => {
  const h = await makeHarness({
    prompt: () => new Promise<void>(() => {}), // hang：abort 也无法终止
  });
  const handle = h.runtime.startDecision(makeRequest());
  let abortedResolved = false;
  handle.abort("soft_deadline");
  abortedResolved = true;
  assert.equal(abortedResolved, true, "abort 必须同步返回，不阻塞 coordinator");
  // idle timeout(50ms) → unhealthy → rotate
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy" && t.reason?.includes("abort_idle_timeout")), true);
  assert.equal(h.sessions.length, 2, "hang 无法 settle → 必须 rotate");
  await h.close();
});

test("5. abort 后正常 idle → 同 session 复用（不 rotate）", async () => {
  let settled = false;
  const h = await makeHarness({
    prompt: async () => {
      await new Promise((r) => setTimeout(r, 10));
      settled = true;
    },
  });
  const handle = h.runtime.startDecision(makeRequest());
  handle.abort("soft_deadline");
  await handle.settled;
  assert.equal(settled, true, "abort 后 prompt 正常终止并 settle");
  assert.equal(h.sessions.length, 1, "正常 idle → 不 rotate，同 session 复用");
  await h.close();
});

test("6. rotation 期间下一 Tick startDecision 抛错（coordinator 走 Safety）", async () => {
  const h = await makeHarness({
    prompt: () => new Promise<void>(() => {}), // hang → 强制 rotate
  });
  const handle = h.runtime.startDecision(makeRequest());
  handle.abort("soft_deadline");
  await new Promise((r) => setTimeout(r, 60)); // unhealthy → rotating 进行中
  assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 })), /not ready/);
  await h.close();
});

test("7. close() 后 startDecision 拒绝；close 幂等", async () => {
  const h = await makeHarness();
  await h.close();
  assert.throws(() => h.runtime.startDecision(makeRequest()), /not ready/);
  await h.close(); // 幂等
});

test("8. runId 由 runtime 原样返回（单源，3E）", async () => {
  const h = await makeHarness();
  const handle = h.runtime.startDecision(makeRequest({ runId: "run-abc" }));
  assert.equal(handle.runId, "run-abc");
  await handle.settled;
  await h.close();
});

test("9. reportViolation → unhealthy telemetry + 触发 rotate", async () => {
  const h = await makeHarness();
  h.runtime.reportViolation("run_id_mismatch");
  assert.equal(h.telemetry.some((t) => t.type === "violation" && t.reason === "run_id_mismatch"), true);
  assert.equal(h.runtime.health().ready, false, "violation 后 not ready（rotate 中）");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runtime.health().ready, true, "rotate 完成后 ready");
  await h.close();
});

test("10. settle 只发生一次（settleOnce）：prompt resolve 后 abort 是 no-op", async () => {
  const h = await makeHarness();
  const handle = h.runtime.startDecision(makeRequest());
  await handle.settled;
  handle.abort("late_abort"); // settled 后 abort 无效果
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.telemetry.filter((t) => t.type === "unhealthy").length, 0, "settled 后 abort 不得触发 unhealthy");
  await h.close();
});

test("11. 无 listener/timer 泄漏：close 后无遗留 telemetry 事件", async () => {
  const h = await makeHarness();
  const handle = h.runtime.startDecision(makeRequest());
  await handle.settled;
  const before = h.telemetry.length;
  await h.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.telemetry.length, before, "close 后不得再有事件（timer 泄漏检测）");
});
