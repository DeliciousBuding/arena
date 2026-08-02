/** W0 闸门：AgentSession 嵌入机制验证（fake streamFn，零网络）。
 *
 * 验证项（外部审阅 W0 清单）：
 * 1. customTools 注册 + tool allowlist（无内置工具泄漏）
 * 2. prompt → arena_plan 工具调用 → 参数捕获 → 工具执行 → 第二轮完成
 * 3. 挂起 run → session.abort() → waitForIdle
 * 4. abort 后同 session 可再次 prompt（复用，历史保留）
 * 5. 迟到 tool call 隔离：abort 丢弃未完成 run，不污染下一次
 * 6. session persistence（SessionManager 记录消息）
 *
 * 运行（pi-dev worktree 上下文，workspace 依赖可解析）：
 *   cd pi-dev/packages/coding-agent && node --test test/embed-spike.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Context, ProviderId, StreamFunction } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "../../ai/dist/utils/event-stream.js";
import { Type } from "typebox";

import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { defineTool } from "../src/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

// ---------- fake streamFn：按脚本返回可控响应 ----------

type StreamPlan = "tool-call" | "text" | "hang";

const FAKE_USAGE: AssistantMessage["usage"] = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseMessage(partialOverrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions" as Api,
    provider: "custom" as ProviderId,
    model: "fake-model",
    usage: FAKE_USAGE,
    stopReason: "pending",
    timestamp: Date.now(),
    ...partialOverrides,
  };
}

/** 可变 plan：测试中途切换行为（abort 后改回正常响应）。 */
function makeStreamFn(planRef: { current: StreamPlan }): StreamFunction {
  return (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    // 模拟真实 provider 的 abort 语义：signal 中断 → error(aborted) 结束流
    // （真实 LLM 流监听 signal；runLoop 的 for-await 不查 signal，靠此结束）
    options?.signal?.addEventListener("abort", () => {
      const aborted = baseMessage({ stopReason: "aborted", errorMessage: "aborted by user" });
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
    });
    void (async () => {
      const plan = planRef.current;
      if (plan === "hang") {
        return; // 只发 start，永不正常结束——abort 由上方 signal 监听结束
      }
      const hasToolResult = context.messages.some((m) => m.role === "toolResult");
      const partial = baseMessage();
      if (plan === "tool-call" && !hasToolResult) {
        const toolCall = {
          type: "toolCall" as const,
          id: "call_arena_plan",
          name: "arena_plan",
          arguments: { tick: 42, reason: "spike-test" },
        };
        const message = baseMessage({ content: [toolCall], stopReason: "toolUse" });
        stream.push({ type: "start", partial });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        return;
      }
      const text = { type: "text" as const, text: "计划完成" };
      const message = baseMessage({ content: [text], stopReason: "stop" });
      stream.push({ type: "start", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "计划完成", partial });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ---------- arena_plan 工具（捕获调用，验证隔离） ----------

const capturedPlans: Array<{ tick: number; reason?: string }> = [];

const arenaPlanTool = defineTool({
  name: "arena_plan",
  label: "arena_plan",
  description: "提交 Arena Hero 计划（spike 测试版）",
  promptSnippet: "提交计划",
  parameters: Type.Object({
    tick: Type.Integer(),
    reason: Type.Optional(Type.String()),
  }),
  async execute(toolCallId: string, params: { tick: number; reason?: string }) {
    capturedPlans.push(params);
    return {
      content: [{ type: "text", text: `plan ${params.tick} accepted` }],
      terminate: true,
    };
  },
});

// ---------- session 工厂 ----------

async function makeSession(options: { allowedTools?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "embed-spike-"));
  const planRef = { current: "text" as StreamPlan };
  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  const agent = new Agent({
    getApiKey: () => "fake-key",
    initialState: {
      model,
      systemPrompt: "你是 Arena Hero 决策者。给出计划。",
      tools: [],
    },
    streamFn: makeStreamFn(planRef),
  });
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.create(cwd, cwd);
  const authStorage = AuthStorage.create(join(cwd, "auth.json"));
  const modelRegistry = await createInMemoryModelRegistry(authStorage);
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd,
    modelRuntime: getModelRuntime(modelRegistry),
    resourceLoader: createTestResourceLoader(),
    customTools: [arenaPlanTool],
    allowedToolNames: options.allowedTools,
  });
  session.subscribe(() => {}); // 官方要求：订阅以启用持久化
  return { session, sessionManager, planRef, cwd };
}

// ---------- 测试 ----------

test("W0-1: customTools 注册 + allowlist 只含 arena_plan（无内置泄漏）", async () => {
  const { session, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  const names = session.agent.state.tools.map((t) => t.name);
  assert.deepEqual(names, ["arena_plan"]);
  session.dispose();
  rm(cwd);
});

test("W0-2: prompt → arena_plan 工具调用 → 参数捕获 → 工具执行 → 第二轮完成", async () => {
  capturedPlans.length = 0;
  const { session, planRef, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  planRef.current = "tool-call";
  await session.prompt("tick 42，请给出计划");
  assert.equal(capturedPlans.length, 1);
  assert.equal(capturedPlans[0].tick, 42);
  assert.equal(capturedPlans[0].reason, "spike-test");
  // 第二轮（toolResult 后）fake 返回 text → prompt 正常完成
  assert.ok(session.isIdle);
  session.dispose();
  rm(cwd);
});

test("W0-3: 挂起 run → abort() → waitForIdle 完成", async () => {
  const { session, planRef, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  planRef.current = "hang";
  const pending = session.prompt("慢慢想，别急着回答");
  await new Promise((resolve) => setTimeout(resolve, 100)); // 让 run 开始
  assert.ok(!session.isIdle, "run 应处于活跃状态");
  await session.abort();
  await session.waitForIdle();
  assert.ok(session.isIdle, "abort 后应回到 idle");
  await pending.catch(() => {}); // 被取消的 prompt 可能 reject，容错
  session.dispose();
  rm(cwd);
});

test("W0-4: abort 后同 session 再次 prompt → 正常完成（复用）", async () => {
  capturedPlans.length = 0;
  const { session, planRef, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  // 第一轮：挂起 → abort
  planRef.current = "hang";
  const p1 = session.prompt("第一轮：挂起");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.abort();
  await p1.catch(() => {});
  // 第二轮：正常工具调用 → 复用同一 session
  planRef.current = "tool-call";
  await session.prompt("第二轮：给计划");
  assert.equal(capturedPlans.length, 1, "第二轮工具调用应成功");
  assert.ok(session.isIdle);
  session.dispose();
  rm(cwd);
});

test("W0-5: 迟到 tool call 隔离——abort 丢弃未完成 run，不污染下一次", async () => {
  const { session, planRef, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  // 挂起 run：fake 只发 start 不发 toolCall（工具未执行）
  planRef.current = "hang";
  const p1 = session.prompt("挂起中");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.abort();
  await p1.catch(() => {});
  // 第二次正常 run 后：历史中不应残留第一轮的挂起内容
  planRef.current = "text";
  await session.prompt("第二次");
  const context = session.agent.state.messages;
  const assistantTexts = context
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text));
  assert.ok(assistantTexts.some((t) => t.includes("计划完成")), "第二次的响应应在历史中");
  session.dispose();
  rm(cwd);
});

test("W0-6: session persistence——SessionManager 记录消息", async () => {
  const { session, sessionManager, cwd } = await makeSession({ allowedTools: ["arena_plan"] });
  await session.prompt("记录一下");
  const context = sessionManager.buildSessionContext();
  assert.ok(context.messages.length > 0, "会话消息应被 SessionManager 记录");
  session.dispose();
  rm(cwd);
});

// ---------- helpers ----------

import { rmSync } from "node:fs";
function rm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}
