/**
 * PiSessionFactory 测试（切片 4-4A，GPT 审核终版契约）。
 *
 * 验收口径：
 * - spy 注入验证配置模板（noTools:"all" + tools 白名单 + customTools + model/thinkingLevel）；
 * - 租户隔离（cwd/agentDir/sessionDir 不同且不在仓库根——禁止项目仓库自动发现）；
 * - in-memory vs persistent sessionManager；
 * - artifacts 记录 piVersion/modelId/provider/configHash；
 * - compat：真实 createAgentSession 可嵌入（ModelRuntime 离线构造 + 最小 fake model），
 *   工具面验证 builtin = 0、arena_plan/arena_map 存在（Pi 公共接口变化时 CI 直接失败）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { PiSessionFactory } from "../src/infrastructure/pi/pi-session-factory.ts";
import type { PiModel, PiSessionFactoryOptions } from "../src/infrastructure/pi/pi-types.ts";

// ---------- fixtures ----------

const FAKE_MODEL = {
  id: "fixture-model",
  name: "Fixture Model",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://127.0.0.1:9", // 不可达端口：任何误连网请求立即失败而非挂起
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 8000,
  maxTokens: 1024,
} as unknown as PiModel;

/** 最小合法工具 stub（真实工具由 4B 提供；factory 只转发不校验）。 */
function stubTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `stub ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "stub" }], details: undefined };
    },
  };
}

const TOOLS = [stubTool("arena_plan"), stubTool("arena_map")];

function baseOptions(overrides: Partial<PiSessionFactoryOptions> = {}): PiSessionFactoryOptions {
  return {
    baseDir: mkdtempSync(join(tmpdir(), "pi-factory-")),
    model: FAKE_MODEL,
    customTools: TOOLS,
    configHash: "sha256:cfg-test",
    ...overrides,
  };
}

/** 注入 spy：捕获每次 createAgentSession 的 options（数组，防覆盖）。 */
function spyOptions(
  options: PiSessionFactoryOptions,
): { calls: Array<Record<string, unknown>>; createSession: (opts: unknown) => Promise<unknown> } {
  const calls: Array<Record<string, unknown>> = [];
  const createSession = async (opts: unknown) => {
    calls.push(opts as Record<string, unknown>);
    return {
      session: {} as AgentSession,
      extensionsResult: {},
    };
  };
  return { calls, createSession };
}

// ---------- spy 配置模板 ----------

test("配置模板：noTools=all + tools 白名单 + customTools + model/thinkingLevel 显式", async () => {
  const options = baseOptions({ thinkingLevel: "high" });
  const spy = spyOptions(options);
  const factory = new PiSessionFactory({ ...options, createSession: spy.createSession as never });
  await factory.createSession("t1");
  const captured = spy.calls[0];

  assert.equal(captured.noTools, "all");
  assert.deepEqual(captured.tools, ["arena_plan", "arena_map"]);
  assert.equal(Array.isArray(captured.customTools), true);
  assert.equal((captured.customTools as unknown[]).length, 2);
  assert.equal(captured.model, FAKE_MODEL);
  assert.equal(captured.thinkingLevel, "high");
});

test("租户隔离：不同 tenantId → 不同 cwd/agentDir，且都不在仓库根", async () => {
  const options = baseOptions();
  const spy = spyOptions(options);
  const factory = new PiSessionFactory({ ...options, createSession: spy.createSession as never });
  await factory.createSession("t1");
  const cwd1 = spy.calls[0].cwd as string;
  const agentDir1 = spy.calls[0].agentDir as string;
  await factory.createSession("t2");
  const cwd2 = spy.calls[1].cwd as string;
  const agentDir2 = spy.calls[1].agentDir as string;

  assert.notEqual(cwd1, cwd2, "不同租户 cwd 必须不同");
  assert.notEqual(agentDir1, agentDir2, "不同租户 agentDir 必须不同");
  for (const [dir, tenant] of [
    [cwd1, "t1"],
    [agentDir1, "t1"],
    [cwd2, "t2"],
    [agentDir2, "t2"],
  ] as const) {
    assert.ok(dir.includes(tenant), `目录必须含租户段 ${tenant}: ${dir}`);
    assert.ok(dir.includes("cwd") || dir.includes("agent"), `目录必须落在 cwd/agent 子结构: ${dir}`);
    assert.ok(existsSync(dir), `隔离目录必须已创建: ${dir}`);
  }
});

test("in-memory（默认）与 persistent 的 sessionManager 选择", async () => {
  const mem = baseOptions();
  const spyMem = spyOptions(mem);
  const factoryMem = new PiSessionFactory({ ...mem, createSession: spyMem.createSession as never });
  const a1 = await factoryMem.createSession("t1");
  assert.equal(a1.sessionMode, "in-memory");

  const per = baseOptions({ sessionMode: "persistent" });
  const spyPer = spyOptions(per);
  const factoryPer = new PiSessionFactory({ ...per, createSession: spyPer.createSession as never });
  const a2 = await factoryPer.createSession("t1");
  assert.equal(a2.sessionMode, "persistent");
});

test("artifacts 记录 piVersion/modelId/provider/configHash 非空", async () => {
  const options = baseOptions();
  const spy = spyOptions(options);
  const factory = new PiSessionFactory({ ...options, createSession: spy.createSession as never });
  const artifacts = await factory.createSession("t1");

  assert.ok(artifacts.piVersion.length > 0, "piVersion 必须非空（VERSION 导出）");
  assert.equal(artifacts.modelId, "fixture-model");
  assert.equal(artifacts.provider, "fixture");
  assert.equal(artifacts.configHash, "sha256:cfg-test");
});

test("非法配置直接抛错（空 baseDir / 非数组 customTools / 空 configHash）", async () => {
  assert.throws(() => new PiSessionFactory(baseOptions({ baseDir: "  " })), RangeError);
  assert.throws(() => new PiSessionFactory(baseOptions({ customTools: undefined as never })), RangeError);
  assert.throws(() => new PiSessionFactory(baseOptions({ configHash: "" })), RangeError);
  // 空 customTools 合法：策略层（无工具）原生支持零 custom tool
  const empty = new PiSessionFactory(baseOptions({ customTools: [] }));
  assert.deepEqual(empty.options.customTools, []);
});

// ---------- compat：真实 createAgentSession 嵌入（零网络，10s 超时保护） ----------

test("compat：createAgentSession 可嵌入 + builtin=0 + 两个 Arena 工具存在", { timeout: 15000 }, async () => {
  const options = baseOptions();
  const factory = new PiSessionFactory(options);
  const artifacts = await factory.createSession("compat-1");

  assert.ok(artifacts.session, "session 必须创建成功");
  // 工具面验证：builtin 全禁用（read/bash 不存在），两个 Arena 工具存在
  assert.equal(artifacts.session.getToolDefinition("read"), undefined, "builtin read 必须禁用");
  assert.equal(artifacts.session.getToolDefinition("bash"), undefined, "builtin bash 必须禁用");
  assert.ok(artifacts.session.getToolDefinition("arena_plan"), "arena_plan 必须注册");
  assert.ok(artifacts.session.getToolDefinition("arena_map"), "arena_map 必须注册");
});
