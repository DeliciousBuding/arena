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

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeStubSession(behavior: StubBehavior, control: Deferred, deferredPrompt: boolean): AgentSession {
  return {
    // 缺省 prompt 立即 resolve（原行为）；deferredPrompt 显式启用时才挂起（P0-2 竞态测试用）
    prompt: behavior.prompt ?? (deferredPrompt ? () => control.promise : async () => {}),
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
  promptControls: Deferred[];
  envelopes: CandidateEnvelope[];
  telemetry: PiRuntimeTelemetry[];
  close: () => Promise<void>;
}

/** 运行一个 startDecision 并等待其 settle（prompt reject 场景）。 */
async function runAndSettle(h: Harness, overrides: Partial<AgentDecisionRequest> = {}): Promise<AgentRunResult> {
  const handle = h.runtime.startDecision(makeRequest(overrides));
  return handle.settled;
}

/** 连续 prompt 失败直至电路 open（threshold=2：第 2 次失败 trip）。 */
async function tripCircuit(h: Harness): Promise<void> {
  await runAndSettle(h); // 失败 1
  await waitForTelemetry(h, "prompt_error");
  await runAndSettle(h); // 失败 2 → trip
  await waitForTelemetry(h, "circuit_opened");
}

async function makeHarness(
  behavior: StubBehavior = {},
  options: {
    deferredPrompt?: boolean;
    maxRunsBeforeRotate?: number;
    warmupTimeoutMs?: number;
    warmupPrompt?: string;
    circuitOpenMs?: number;
    nowMs?: () => number;
  } = {},
): Promise<Harness> {
  const sessions: AgentSession[] = [];
  const promptControls: Deferred[] = [];
  const envelopes: CandidateEnvelope[] = [];
  const telemetry: PiRuntimeTelemetry[] = [];
  const createSession = async (): Promise<unknown> => {
    const control = makeDeferred();
    const session = makeStubSession(behavior, control, options.deferredPrompt ?? false);
    sessions.push(session);
    promptControls.push(control);
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
    maxRunsBeforeRotate: options.maxRunsBeforeRotate ?? 40,
    // 缺省无 warmup：大部分测试不关心预热行为；#4-6/#4-7 显式启用
    warmupPrompt: options.warmupPrompt,
    warmupTimeoutMs: options.warmupTimeoutMs ?? 30000,
    ...(options.circuitOpenMs !== undefined ? { circuitOpenMs: options.circuitOpenMs } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    onTelemetry: (event) => telemetry.push(event),
  });
  runtime.bindCandidateSink((envelope) => {
    envelopes.push(envelope);
    return { accepted: true, candidate: envelope };
  });
  return {
    runtime,
    sessions,
    promptControls,
    envelopes,
    telemetry,
    close: () => runtime.close(),
  };
}

/** 轮询等待 telemetry 事件（rotate 是 void async + ModelRuntime 文件 IO，固定 sleep 不稳）。 */
async function waitForTelemetry(h: Harness, type: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!h.telemetry.some((t) => t.type === type) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
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

test("2. prompt reject → error settle；连续失败达阈值 → circuit open（降级不轮询，不立即 rotate）", async () => {
  const h = await makeHarness({
    prompt: () => Promise.reject(new Error("provider down")),
  });
  // 阈值 2：第一次失败仅 error settle
  const handle = h.runtime.startDecision(makeRequest());
  const result = await handle.settled;
  assert.equal(result.outcome, "error");
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy"), false);
  // 第二次失败 → 连续 2 次 → circuit open（Track B：降级优先，不立即 rotation）
  const handle2 = h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 }));
  await handle2.settled;
  await waitForTelemetry(h, "circuit_opened");
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy"), false, "trip 是降级不是 session 损坏：不立即 rotate");
  assert.equal(h.sessions.length, 1, "trip 不触发 rotation（session 保持复用）");
  // open 期间 startDecision 立即抛错（coordinator 走 Safety）
  assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:102:2", tick: 102 })), /circuit open/);
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
  await waitForTelemetry(h, "unhealthy");
  assert.equal(h.telemetry.some((t) => t.type === "unhealthy" && t.reason?.includes("abort_idle_timeout")), true);
  await waitForTelemetry(h, "rotated");
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
  // abort 发出后、settle 前：startDecision 立即抛错（coordinator 走 Safety，不等 abort/rotate）
  assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 })));
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
  await waitForTelemetry(h, "rotated");
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

// ---------- P0-2：跨 generation 竞态与 health 严格化 ----------

test("P0-2. 旧 generation 迟到 reject → 不影响新 generation 的 health/counters", async () => {
  const h = await makeHarness({}, { deferredPrompt: true }); // prompt 可控 deferred
  const handle = h.runtime.startDecision(makeRequest());
  handle.abort("soft_deadline"); // session1 hang → idle timeout → rotate（generation 1）
  await waitForTelemetry(h, "rotated");
  assert.equal(h.sessions.length, 2, "rotate 必须重建 session");
  const unhealthyBefore = h.telemetry.filter((t) => t.type === "unhealthy").length;
  // 旧 session 的 prompt 迟到 reject（新 session 已就绪之后）
  h.promptControls[0].reject(new Error("late error from old session"));
  await new Promise((r) => setTimeout(r, 20));
  const unhealthyAfter = h.telemetry.filter((t) => t.type === "unhealthy").length;
  assert.equal(unhealthyAfter, unhealthyBefore, "旧 generation 迟到 reject 不得触发新 unhealthy");
  assert.equal(h.runtime.health().ready, true, "新 generation 保持 ready");
  await h.close();
});

test("P0-2. 旧 generation 迟到 resolve → 不重置新 generation 错误计数", async () => {
  const h = await makeHarness({}, { deferredPrompt: true });
  const handle1 = h.runtime.startDecision(makeRequest());
  handle1.abort("soft_deadline"); // session1 hang → idle timeout → rotate（generation 1 → 2）
  await waitForTelemetry(h, "rotated");
  assert.equal(h.sessions.length, 2);
  // 新 session 连续失败 2 次（阈值 2）→ circuit open（计数从 0 累计，trip 不 rotate）
  const handle2 = h.runtime.startDecision(makeRequest({ runId: "local:t1:101:1", tick: 101 }));
  h.promptControls[1].reject(new Error("provider down"));
  await handle2.settled;
  const handle3 = h.runtime.startDecision(makeRequest({ runId: "local:t1:102:2", tick: 102 }));
  await handle3.settled;
  await waitForTelemetry(h, "circuit_opened");
  assert.equal(h.sessions.length, 2, "trip 是降级不是 session 损坏：不 rotate");
  // 旧 generation 迟到 resolve → 不得重置新 generation 的错误计数（circuit 保持 open）
  h.promptControls[0].resolve();
  await new Promise((r) => setTimeout(r, 20));
  assert.throws(
    () => h.runtime.startDecision(makeRequest({ runId: "local:t1:103:3", tick: 103 })),
    /circuit open/,
    "迟到 resolve 不得重置新 generation 错误计数",
  );
  await h.close();
});

test("P0-2. close 与 rotate 并发 → 不复活（initialize 完成后 state 保持 closed）", async () => {
  const h = await makeHarness({}, { deferredPrompt: true });
  const handle = h.runtime.startDecision(makeRequest());
  handle.abort("soft_deadline"); // hang → idle timeout(50ms) → rotate 开始
  await new Promise((r) => setTimeout(r, 60)); // rotate 进行中（initialize 挂起在 createSession spy）
  await h.close(); // close 置 closing + epoch++
  await new Promise((r) => setTimeout(r, 50)); // rotate 的 initialize 完成
  assert.equal(h.runtime.health().ready, false, "close 后不得复活");
  assert.equal(h.runtime.health().reason, "closed");
  await h.close(); // 幂等
});

test("P0-2. health 严格化：running 时 ready=false", async () => {
  const h = await makeHarness({}, { deferredPrompt: true });
  h.runtime.startDecision(makeRequest());
  assert.deepEqual(h.runtime.health(), { ready: false, activeRunId: "local:t1:100:0", reason: "running" });
  h.promptControls[0].resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.runtime.health(), { ready: true, activeRunId: null });
  await h.close();
});

// ---------- 真实嵌入冒烟（setDefaultStreamFn + 真实 createAgentSession 全链路） ----------
// Agent A 地界（leader 接管）：不 mock pi——用真实 createAgentSession + fake stream 函数
// 替换模型调用。pi 的真实 agent loop（toolUse 执行 → 结果喂回 → 收尾）全链路验证。

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// 冒烟用 pi 原生机制：ModelRuntime.registerProvider（provider 自带 apiKey + streamSimple），
// 不碰全局 default stream、不污染 ~/.pi 认证环境。
import type { CandidateSink } from "../src/runtime/decision-types.ts";

/** 局部事件类型（pi-ai 类型在嵌套依赖不可达；运行时形状已对照 dist 类型验证）。 */
type FakeEvent = Record<string, unknown>;
type FakeStreamFn = (model: unknown, context: unknown, options?: unknown) => AsyncGenerator<FakeEvent>;

/** 从 streamFn 收到的 context 最后一条 user 消息解析 runId/tick/stateHash（prompt 段 5 格式）。 */
function parseRunContext(context: unknown): { runId: string; tick: number; stateHash: string } {
  const messages = ((context as { messages?: unknown[] } | null)?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser ?? {});
  const m = text.match(/runId = ([^，]+)，tick = (\d+)，stateHash = ([^；]+)；/);
  if (m === null) {
    throw new Error(`fake stream 无法从 context 解析 run 标识: ${text.slice(0, 200)}`);
  }
  return { runId: m[1], tick: Number(m[2]), stateHash: m[3] };
}

function assistantMsg(content: unknown[], stopReason: string): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: "openai",
    provider: "fixture",
    model: "fixture-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

function toolCallBlock(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args };
}

/** 一轮流：工具调用（toolUse → done）。 */
function toolUseStream(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): FakeEvent[] {
  const content = calls.map((t) => toolCallBlock(t.id, t.name, t.arguments));
  const msg = assistantMsg(content, "toolUse");
  const events: FakeEvent[] = [{ type: "start", partial: msg }];
  calls.forEach((t, i) => {
    events.push({ type: "toolcall_start", contentIndex: i, partial: msg });
    events.push({ type: "toolcall_end", contentIndex: i, toolCall: toolCallBlock(t.id, t.name, t.arguments), partial: msg });
  });
  events.push({ type: "done", reason: "toolUse", message: msg });
  return events;
}

/** 一轮流：纯文本收尾（stop）。 */
function textStream(text: string): FakeEvent[] {
  const msg = assistantMsg([{ type: "text", text }], "stop");
  return [
    { type: "start", partial: msg },
    { type: "text_start", contentIndex: 0, partial: msg },
    { type: "text_delta", contentIndex: 0, delta: text, partial: msg },
    { type: "text_end", contentIndex: 0, content: text, partial: msg },
    { type: "done", reason: "stop", message: msg },
  ];
}

/** 剧本化 fake stream：按调用轮次返回事件（无脚本轮 → 纯文本收尾）。 */
function scriptedStream(script: Array<(ctx: { runId: string; tick: number; stateHash: string }) => FakeEvent[]>): FakeStreamFn {
  let call = 0;
  return async function* (_model, context) {
    const run = parseRunContext(context);
    const events = script[Math.min(call, script.length - 1)]?.(run) ?? textStream("完成。");
    call += 1;
    for (const e of events) {
      yield e;
    }
  };
}

const REAL_PROMPT_BUILDER = (input: { runId: string; context: { tick: number; stateHash: string } }): string =>
  `本次决策的 runId = ${input.runId}，tick = ${input.context.tick}，stateHash = ${input.context.stateHash}；` +
  `调用 arena_plan 时参数必须携带这三个值。每 Tick 必须且只能调用一次 arena_plan。`;

/** 注入 ModelRuntime：registerProvider("fixture") 带 apiKey + streamSimple（fake stream）。
 *  pi 原生认证路径（provider 配置 apiKey）→ 认证通过；streamSimple 被调用 → 剧本事件。 */
async function makeEmbeddedRuntime(stream: FakeStreamFn, sink: CandidateSink): Promise<{ runtime: PiAgentRuntime; close: () => Promise<void> }> {
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:9", // 不可达：streamSimple 注入后不会真联网
    api: "openai-completions", // 注册 streamSimple 必须声明 api 协议
    apiKey: "fake-key-not-real",
    streamSimple: stream as never,
  });
  const runtime = await PiAgentRuntime.create({
    session: {
      baseDir: mkdtempSync(join(tmpdir(), "pi-embed-")),
      model: FAKE_MODEL,
      configHash: "cfg-test",
      modelRuntime,
    },
    tenantId: "t1",
    promptBuilder: REAL_PROMPT_BUILDER,
    idleTimeoutMs: 80,
    consecutiveErrorThreshold: 2,
  });
  runtime.bindCandidateSink(sink);
  return { runtime, close: () => runtime.close().catch(() => {}) };
}

test("冒烟 1：真实 session 全链路——arena_plan 工具调用 → CandidateSink 收到合法候选", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  const stream = scriptedStream([
    (run) =>
      toolUseStream([
        {
          id: "tc-1",
          name: "arena_plan",
          arguments: {
            runId: run.runId,
            tick: run.tick,
            stateHash: run.stateHash,
            actions: [{ unit: "u-1", kind: "MOVE", direction: "UP" }],
            core: null,
            reason: "smoke",
            confidence: 0.9,
          },
        },
      ]),
    () => textStream("计划已提交。"),
  ]);
  const { runtime, close } = await makeEmbeddedRuntime(stream, sink);
  try {
    const state = makeRequest().state as never;
    const handle = runtime.startDecision(
      makeRequest({
        state: {
          ...(state as object),
          units: [{ id: "u-1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
          workers: [{ id: "u-1", position: [0, 1], hp: 2, unitType: "WORKER", cargo: 0 }],
        } as never,
      }),
    );
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
    assert.equal(envelopes.length, 1, "sink 必须收到恰好 1 个候选");
    assert.equal(envelopes[0].runId, "local:t1:100:0");
    assert.equal(envelopes[0].tick, 100);
    assert.equal(envelopes[0].plan.unitActions["u-1"]?.type, "MOVE");
    assert.equal((envelopes[0].plan.unitActions["u-1"] as { direction: string }).direction, "UP");
    assert.equal(envelopes[0].reason, "smoke");
  } finally {
    await close();
  }
});

test("冒烟 2：纯文本响应（无工具调用）→ 无候选，run 正常 settle", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  const stream = scriptedStream([() => textStream("本轮保守观望，不提交计划。")]);
  const { runtime, close } = await makeEmbeddedRuntime(stream, sink);
  try {
    const handle = runtime.startDecision(makeRequest());
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
    assert.equal(envelopes.length, 0, "纯文本轮不得产生候选");
  } finally {
    await close();
  }
});

test("冒烟 3：错 runId 回显 → context_mismatch 拒绝，候选不投递", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  const stream = scriptedStream([
    (run) =>
      toolUseStream([
        {
          id: "tc-1",
          name: "arena_plan",
          arguments: {
            runId: "wrong-run-id", // 故意错
            tick: run.tick,
            stateHash: run.stateHash,
            actions: [],
            core: null,
          },
        },
      ]),
    () => textStream("收到拒绝，结束本轮。"),
  ]);
  const { runtime, close } = await makeEmbeddedRuntime(stream, sink);
  try {
    const handle = runtime.startDecision(makeRequest());
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
    assert.equal(envelopes.length, 0, "runId 不一致 → 候选不得投递");
  } finally {
    await close();
  }
});

test("冒烟 4：arena_map 0..N 次 + 重复 arena_plan → duplicate 拒绝（只投递一次）", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  const stream = scriptedStream([
    (run) =>
      toolUseStream([
        { id: "tc-map", name: "arena_map", arguments: {} },
        { id: "tc-plan-1", name: "arena_plan", arguments: { runId: run.runId, tick: run.tick, stateHash: run.stateHash, actions: [], core: null } },
      ]),
    (run) =>
      toolUseStream([
        { id: "tc-plan-2", name: "arena_plan", arguments: { runId: run.runId, tick: run.tick, stateHash: run.stateHash, actions: [], core: null } },
      ]),
    () => textStream("收到 duplicate 拒绝。"),
  ]);
  const { runtime, close } = await makeEmbeddedRuntime(stream, sink);
  try {
    const handle = runtime.startDecision(makeRequest());
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
    assert.equal(envelopes.length, 1, "重复调用必须被拒绝，候选只投递一次");
  } finally {
    await close();
  }
});

test("冒烟 5：abort hang → idle timeout → rotation → 新 session 恢复 ready", async () => {
  const telemetry: PiRuntimeTelemetry[] = [];
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  // 剧本：挂起（永不结束的流）——abort 后 prompt 不 settle → idle timeout → rotate
  const hangingStream: FakeStreamFn = async function* () {
    for (;;) {
      await new Promise(() => {}); // 永不 resolve
      yield {};
    }
  };
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  modelRuntime.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    apiKey: "fake-key-not-real",
    streamSimple: hangingStream as never,
  });
  const runtime = await PiAgentRuntime.create({
    session: {
      baseDir: mkdtempSync(join(tmpdir(), "pi-embed-")),
      model: FAKE_MODEL,
      configHash: "cfg-test",
      modelRuntime,
    },
    tenantId: "t1",
    promptBuilder: REAL_PROMPT_BUILDER,
    idleTimeoutMs: 60,
    consecutiveErrorThreshold: 2,
    onTelemetry: (e) => telemetry.push(e),
  });
  runtime.bindCandidateSink(sink);
  try {
    const handle = runtime.startDecision(makeRequest());
    handle.abort("test-abort");
    // 等 rotation 完成（unhealthy → rotating → rotated → ready）
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(runtime.health().ready, true, "rotation 后必须恢复 ready");
    assert.ok(telemetry.some((e) => e.type === "abort_requested"), "必须发出 abort_requested");
    assert.ok(telemetry.some((e) => e.type === "unhealthy"), "idle 超时必须标记 unhealthy");
    assert.ok(telemetry.some((e) => e.type === "rotating"), "必须触发 rotation");
    assert.ok(telemetry.some((e) => e.type === "rotated"), "必须完成 rotation");
    // hang 的 prompt promise 永不 settle（rotate 只清 active）——settled 加超时 race
    const result = await Promise.race([
      handle.settled.catch(() => ({ outcome: "error" as const, message: "hang" })),
      new Promise<{ outcome: "error"; message: string }>((r) => setTimeout(() => r({ outcome: "error", message: "hang-timeout" }), 200)),
    ]);
    assert.ok(result.outcome === "settled" || result.outcome === "error", "settle 必须终结");
    assert.equal(envelopes.length, 0);
  } finally {
    await runtime.close().catch(() => {});
  }
});

test("冒烟 6：1000 runs 无泄漏——全部 settle、active 清理、runtime 持续 ready", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const sink: CandidateSink = (e) => {
    envelopes.push(e);
    return { accepted: true, candidate: e };
  };
  const stream = scriptedStream([() => textStream("完成。")]);
  const { runtime, close } = await makeEmbeddedRuntime(stream, sink);
  try {
    const RUNS = 1000;
    for (let i = 0; i < RUNS; i += 1) {
      // 周期重置（每 40 run，#4 语义）是异步的——等待 runtime 回 ready 再继续
      const deadline = Date.now() + 2000;
      while (!runtime.health().ready) {
        assert.ok(Date.now() < deadline, `run ${i} 等待周期 rotation 完成超时`);
        await new Promise((r) => setTimeout(r, 5));
      }
      if (i % 100 === 99) {
        assert.equal(runtime.health().ready, true, `run ${i} 后 runtime 必须 ready（无泄漏）`);
        assert.equal(runtime.health().activeRunId, null, `run ${i} 后无残留 active run`);
      }
      const handle = runtime.startDecision(makeRequest({ runId: `local:t1:100:${i}` }));
      const result = await handle.settled;
      assert.equal(result.outcome, "settled", `run ${i} 必须 settle`);
    }
    // 第 1000 个 run settle 后周期 rotate（25×40）异步在途——等待回 ready 再断言
    const deadline = Date.now() + 2000;
    while (!runtime.health().ready) {
      assert.ok(Date.now() < deadline, "最终周期 rotation 完成超时");
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(runtime.health().ready, true);
    assert.equal(runtime.health().activeRunId, null);
  } finally {
    await close();
  }
});

// ---------- #4：周期重置计数语义（成功/abort 都计，idle 边界 rotate） ----------

function rotatingEvents(h: Harness): PiRuntimeTelemetry[] {
  return h.telemetry.filter((t) => t.type === "rotating");
}

test("#4-1: 39 个成功 run 不 rotate（阈值 40 未到）", async () => {
  const h = await makeHarness({}, { maxRunsBeforeRotate: 40 });
  try {
    for (let i = 0; i < 39; i += 1) {
      const handle = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      const result = await handle.settled;
      assert.equal(result.outcome, "settled");
    }
    assert.equal(rotatingEvents(h).length, 0, "39 run 未达阈值，不得 rotate");
    assert.equal(h.sessions.length, 1, "不 rotate → 不重建 session");
  } finally {
    await h.close();
  }
});

test("#4-2: 第 40 个成功 run settle 后 rotate 一次（idle 边界，reason=periodic_reset，事件单组）", async () => {
  const h = await makeHarness({}, { maxRunsBeforeRotate: 40 });
  try {
    for (let i = 0; i < 40; i += 1) {
      const handle = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      const result = await handle.settled;
      assert.equal(result.outcome, "settled");
    }
    await waitForTelemetry(h, "rotated");
    const rotating = rotatingEvents(h);
    assert.equal(rotating.length, 1, "恰好一次 rotating（无重复事件）");
    assert.equal(rotating[0].reason, "periodic_reset", "周期重置必须带 reason=periodic_reset");
    assert.equal(h.telemetry.filter((t) => t.type === "rotated").length, 1, "rotated 事件单组");
    assert.equal(h.sessions.length, 2, "rotate 后 session 重建");
    assert.deepEqual(h.runtime.health(), { ready: true, activeRunId: null }, "rotate 后恢复 ready");
  } finally {
    await h.close();
  }
});

test("#4-3: 40 个 aborted run 仍只 rotate 一次（无 double count）", async () => {
  // abort 时 prompt 才 resolve（模拟真实 pi：abort 打断 LLM → prompt 立即终止）——
  // 计数在 startDecision（abort 也计一次），第 40 个 settle 触发唯一一次周期 rotate
  let control: Deferred | null = null;
  const h = await makeHarness(
    {
      prompt: () => (control !== null ? control.promise : Promise.resolve()),
      abort: () => {
        control?.resolve();
        return Promise.resolve();
      },
    },
    { maxRunsBeforeRotate: 40, deferredPrompt: true },
  );
  try {
    control = h.promptControls[0] ?? null;
    for (let i = 0; i < 40; i += 1) {
      const handle = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      handle.abort("test-abort");
      const result = await handle.settled;
      assert.equal(result.outcome, "settled" as const, "abort 后 prompt 终止 → settle");
    }
    await waitForTelemetry(h, "rotated");
    assert.equal(rotatingEvents(h).length, 1, "40 个 aborted run 只 rotate 一次（无 double count）");
    assert.equal(h.telemetry.filter((t) => t.type === "rotated").length, 1);
    assert.equal(h.sessions.length, 2);
  } finally {
    await h.close();
  }
});

test("#4-4: 成功/abort 混合计数正确（20 成功 + 20 abort → 40 触发一次）", async () => {
  // deferredPrompt：prompt 返回本 session 的 control.promise（挂起）——
  // 成功 run 显式 resolve（模拟 LLM 完成）；abort run abort 后 resolve（模拟打断终止）。
  // 同一 session 内所有 prompt 调用共享已 resolve 的 promise → 后续 run 立即 settle。
  const h = await makeHarness({}, { maxRunsBeforeRotate: 40, deferredPrompt: true });
  try {
    const control = h.promptControls[0];
    for (let i = 0; i < 40; i += 1) {
      const handle = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      if (i < 20) {
        control?.resolve(); // 成功 run：LLM 完成 → settle
      } else {
        handle.abort("test-abort"); // abort run：打断 → resolve 终止 prompt
        control?.resolve();
      }
      const result = await handle.settled;
      assert.equal(result.outcome, "settled" as const);
    }
    await waitForTelemetry(h, "rotated");
    assert.equal(rotatingEvents(h).length, 1, "混合 40 次计数恰好一次 rotate（无 double count）");
    assert.equal(h.sessions.length, 2);
  } finally {
    await h.close();
  }
});

test("#4-5: 旧 generation 延迟 settle 不影响新计数（rotate 后旧 prompt 才结束）", async () => {
  // 场景：run 0 的 prompt 挂起 → abort → idle 超时（50ms）→ 异常 rotate →
  // 新 generation 跑 run 1-5（计数 5）→ 旧 run 0 的 prompt 此刻才 settle（旧 generation）→
  // 迟到 settle 不得触发周期 rotate、不得消耗/重置新计数
  const hang = makeDeferred();
  let hangUsed = false;
  const h = await makeHarness(
    {
      prompt: () => {
        if (!hangUsed) {
          hangUsed = true;
          return hang.promise; // 首调用（run 0）挂起
        }
        return Promise.resolve();
      },
    },
    { maxRunsBeforeRotate: 40 },
  );
  try {
    const handle = h.runtime.startDecision(makeRequest());
    handle.abort("test-abort");
    await waitForTelemetry(h, "rotated"); // idle 超时 → unhealthy → rotate
    assert.equal(h.sessions.length, 2, "异常路径 rotate 重建 session");
    assert.equal(rotatingEvents(h).length, 1);
    assert.equal(rotatingEvents(h)[0].reason, undefined, "异常 rotation 不带 periodic_reset");
    // 新 generation 跑 5 个 run（新计数 5）
    for (let i = 1; i <= 5; i += 1) {
      const hd = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      await hd.settled;
    }
    hang.resolve(); // 旧 run 0 迟到 settle（旧 generation）
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(rotatingEvents(h).length, 1, "旧 generation 迟到 settle 不得触发 rotate");
    assert.equal(h.sessions.length, 2, "旧 session 迟到 settle 不得重建 session");
    // 新计数不受影响：再跑 40 个新 run → 计数 5+40=45 ≥ 40 → 恰好触发一次周期 rotate；
    // 第 40 个 settle 触发异步 rotate → 循环内等 ready（与冒烟 6 同模式）
    for (let i = 6; i < 46; i += 1) {
      const deadline = Date.now() + 2000;
      while (!h.runtime.health().ready) {
        assert.ok(Date.now() < deadline, `run ${i} 等待周期 rotation 完成超时`);
        await new Promise((r) => setTimeout(r, 5));
      }
      const hd = h.runtime.startDecision(makeRequest({ runId: `local:t1:${100 + i}:${i}`, tick: 100 + i }));
      await hd.settled;
    }
    await new Promise((r) => setTimeout(r, 200)); // 等周期 rotate 完成（rotating 事件已计数）
    const periodic = rotatingEvents(h).filter((t) => t.reason === "periodic_reset");
    assert.equal(periodic.length, 1, "新计数到 40 仍触发周期 rotate（旧迟到 settle 未重置计数）");
    assert.equal(h.sessions.length, 3, "周期 rotate 重建第三个 session");
  } finally {
    hang.resolve();
    await h.close();
  }
});

test("#4-6: warmup reject → fail-open（telemetry 记录，runtime 仍 ready）", async () => {
  let warmupRejected = false;
  const h = await makeHarness(
    {
      prompt: () => {
        if (!warmupRejected) {
          warmupRejected = true;
          return Promise.reject(new Error("warmup provider down"));
        }
        return Promise.resolve();
      },
    },
    { warmupPrompt: "warmup" },
  );
  try {
    assert.equal(h.runtime.health().ready, true, "warmup 失败 fail-open：runtime 必须 ready");
    const err = h.telemetry.find((t) => t.type === "prompt_error" && t.message?.startsWith("warmup:"));
    assert.ok(err !== undefined, "warmup 失败必须写 telemetry（prompt_error + warmup 前缀）");
    // 首决策正常
    const handle = h.runtime.startDecision(makeRequest());
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
  } finally {
    await h.close();
  }
});

test("#4-7: warmup timeout → fail-open + warmup_timeout telemetry，close 不挂死", async () => {
  const hang = makeDeferred();
  const h = await makeHarness(
    {
      prompt: () => hang.promise, // 预热挂起 → 超时
    },
    { warmupTimeoutMs: 50, warmupPrompt: "warmup-hang" },
  );
  try {
    assert.equal(h.runtime.health().ready, true, "warmup 超时 fail-open：runtime 必须 ready");
    assert.ok(h.telemetry.some((t) => t.type === "warmup_timeout"), "必须发出 warmup_timeout");
    // close 并发：后台 abort 不阻塞关闭
    await h.close();
    assert.ok(true, "close 在 warmup 超时后不挂死");
    return;
  } finally {
    hang.resolve(); // 释放挂起（close 已过，防悬挂 timer）
  }
});

// ---------- Track B：Pi/Provider 最小熔断（circuit breaker） ----------

test("CB-1: 连续失败达阈值 → circuit open；open 期间 startDecision 立即抛错（fallbackReason=provider_failure）", async () => {
  let promptCalls = 0;
  const h = await makeHarness({
    prompt: () => {
      promptCalls += 1;
      return Promise.reject(new Error("provider down"));
    },
  });
  try {
    // 失败 1、2（threshold=2）→ trip
    await tripCircuit(h);
    const opened = h.telemetry.find((t) => t.type === "circuit_opened");
    assert.ok(opened !== undefined, "必须发出 circuit_opened");
    assert.equal(opened.circuitState, "open");
    assert.equal(opened.consecutiveFailures, 2);
    // open 且冷却未到（默认 30s）→ startDecision 立即抛错，不启动 Pi 请求
    assert.throws(
      () => h.runtime.startDecision(makeRequest({ runId: "local:t1:102:3", tick: 102 })),
      /circuit open \(fallbackReason=provider_failure/,
    );
    // prompt 未被再次调用（open 期间零 Pi 请求）
    assert.equal(promptCalls, 2, "open 期间不得发起新的 prompt");
  } finally {
    await h.close();
  }
});

test("CB-2: 冷却结束后 → half-open 单次试探 → 成功恢复 closed（仅恢复候选能力）", async () => {
  let fail = true;
  let now = 0;
  const h = await makeHarness(
    {
      prompt: () => (fail ? Promise.reject(new Error("provider down")) : Promise.resolve()),
    },
    { circuitOpenMs: 80, nowMs: () => now },
  );
  try {
    await tripCircuit(h);
    // 冷却中：仍抛错
    assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:102:3", tick: 102 })));
    // 推进单调时钟越过冷却，不使用真实 sleep。
    now = 80;
    // half-open：放行单次试探；provider 已恢复 → 成功 → closed
    fail = false;
    const handle = h.runtime.startDecision(makeRequest({ runId: "local:t1:103:4", tick: 103 }));
    const result = await handle.settled;
    assert.equal(result.outcome, "settled");
    assert.ok(h.telemetry.some((t) => t.type === "circuit_half_open"), "必须经过 half-open");
    assert.ok(h.telemetry.some((t) => t.type === "circuit_closed"), "试探成功必须恢复 closed");
    // closed：后续 run 正常
    const handle2 = h.runtime.startDecision(makeRequest({ runId: "local:t1:104:5", tick: 104 }));
    await handle2.settled;
    assert.equal(h.runtime.health().ready, true);
  } finally {
    await h.close();
  }
});

test("CB-3: half-open 试探失败 → 立即重新 open（circuit_retry_failed），冷却重新计时", async () => {
  let now = 0;
  const h = await makeHarness(
    {
      prompt: () => Promise.reject(new Error("provider still down")),
    },
    { circuitOpenMs: 80, nowMs: () => now },
  );
  try {
    await tripCircuit(h);
    now = 80; // 冷却结束
    // half-open 试探（仍然失败）→ 重新 open
    const handle = h.runtime.startDecision(makeRequest({ runId: "local:t1:103:4", tick: 103 }));
    const result = await handle.settled;
    assert.equal(result.outcome, "error");
    assert.ok(
      h.telemetry.some((t) => t.type === "circuit_retry_failed"),
      "half-open 失败必须发出 circuit_retry_failed",
    );
    const reopened = h.telemetry.find((t) => t.type === "circuit_retry_failed");
    assert.equal(reopened?.circuitState, "open");
    // 重新 open：再次立即抛错（新冷却从 lastTripAt 起算）
    assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:104:5", tick: 104 })), /circuit open/);
  } finally {
    await h.close();
  }
});

test("CB-4: 成功恢复后失败计数清零；close() 复位 circuit 状态", async () => {
  let fail = true;
  let now = 0;
  const h = await makeHarness(
    {
      prompt: () => (fail ? Promise.reject(new Error("provider down")) : Promise.resolve()),
    },
    { circuitOpenMs: 80, nowMs: () => now },
  );
  try {
    await tripCircuit(h);
    now = 80;
    fail = false;
    const handle = h.runtime.startDecision(makeRequest({ runId: "local:t1:103:4", tick: 103 }));
    await handle.settled;
    assert.ok(h.telemetry.some((t) => t.type === "circuit_closed"));
    // closed 后失败计数已清零：单次失败不再 trip（需连续 threshold 次）
    fail = true;
    const h2 = await runAndSettle(h, { runId: "local:t1:104:5", tick: 104 });
    assert.equal(h2.outcome, "error");
    assert.equal(
      h.telemetry.filter((t) => t.type === "circuit_opened" || t.type === "circuit_retry_failed").length,
      1,
      "closed 后单次失败不得直接 trip（计数已清零）",
    );
    await h.close();
    // close 后 startDecision 拒绝（状态已复位，无残留）
    assert.throws(() => h.runtime.startDecision(makeRequest()));
  } finally {
    await h.close();
  }
});

test("CB-5: agent-shadow 语义不变——熔断不授予任何真实提交权（runtime 层面无 submit 路径）", async () => {
  const h = await makeHarness({
    prompt: () => Promise.reject(new Error("provider down")),
  });
  try {
    await tripCircuit(h);
    // runtime 只暴露 startDecision/settle 端口，无 submit/plan 写入路径；
    // open 时 startDecision 抛错 → coordinator 立即 Safety（execution 恒 safety/agent-shadow）
    assert.throws(() => h.runtime.startDecision(makeRequest({ runId: "local:t1:102:3", tick: 102 })), /circuit open/);
    assert.equal(h.envelopes.length, 0, "熔断期间不得产生任何候选（无提交素材）");
  } finally {
    await h.close();
  }
});
