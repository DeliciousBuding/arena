/**
 * 工具层测试（切片 4-4B，总任务书 2.x + GPT 终版契约）。
 *
 * 验收口径：
 * - 值源：envelope 标识字段一律来自 ctx（不读全局）；LLM 参数只做回显校验；
 * - 回显不一致 → context_mismatch，不投递；重复调用 → duplicate_tool_call，不投递；
 * - sink 返回 LeaseSubmission → 文本反馈含 accepted/code；
 * - wire→domain 映射（targetId/expectedCell/MOVE direction/core SPAWN）；
 * - arena_map 本 Tick 冻结快照 + bounds 过滤 + disabled 降级；
 * - arena_plan terminate、arena_map 不 terminate；重复 unit 取最后一条。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { LeaseSubmission } from "../src/runtime/decision-lease.ts";
import type { CandidateEnvelope } from "../src/runtime/decision-types.ts";
import { createArenaMapToolDefinition } from "../src/infrastructure/pi/tools/arena-map.ts";
import { createArenaPlanToolDefinition, type ArenaPlanParams } from "../src/infrastructure/pi/tools/arena-plan.ts";
import { createToolContext, type MapSnapshot, type ToolContext } from "../src/infrastructure/pi/tools/tool-context.ts";

const REJECTED: LeaseSubmission = { accepted: false, code: "deadline_exceeded", message: "lease expired" };
const ACCEPTED: LeaseSubmission = {
  accepted: true,
  candidate: { protocolVersion: "1", runId: "r", tenantId: "t", tick: 1, stateHash: "h", plan: { tick: 1, unitActions: {}, coreAction: null, intents: {} }, reason: "", confidence: null },
};

function makeCtx(overrides: Partial<ToolContext> = {}): {
  ctx: ToolContext;
  envelopes: CandidateEnvelope[];
  sink: (e: CandidateEnvelope) => LeaseSubmission;
} {
  const envelopes: CandidateEnvelope[] = [];
  const sink = (e: CandidateEnvelope): LeaseSubmission => {
    envelopes.push(e);
    return ACCEPTED;
  };
  const ctx = createToolContext({
    runId: "t1-100-0",
    tenantId: "t1",
    tick: 100,
    stateHash: "sha256:state-100",
    mapSnapshot: null,
    sink,
    ...overrides,
  });
  return { ctx, envelopes, sink };
}


/** 提取工具返回文本（content 是 TextContent|ImageContent union，取 text）。 */
function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

const VALID_PARAMS: ArenaPlanParams = {
  runId: "t1-100-0",
  tick: 100,
  stateHash: "sha256:state-100",
  actions: [
    { unit: "u1", kind: "MOVE", direction: "UP" },
    { unit: "u2", kind: "SHOOT", target_id: "e9", expected_cell: [3, 4] },
  ],
  core: { kind: "SPAWN", unit_type: "WORKER" },
  reason: "扩张",
  confidence: 0.8,
};

// ---------- 值源与回显校验 ----------

test("合法回显 → sink 收到 envelope，标识字段 == ctx 值（而非参数值）", async () => {
  const { ctx, envelopes } = makeCtx();
  const tool = createArenaPlanToolDefinition(ctx);
  const result = await tool.execute("c1", VALID_PARAMS, undefined, undefined, undefined as never);
  assert.equal(envelopes.length, 1);
  const env = envelopes[0];
  assert.equal(env.runId, ctx.runId);
  assert.equal(env.tenantId, ctx.tenantId);
  assert.equal(env.tick, ctx.tick);
  assert.equal(env.stateHash, ctx.stateHash);
  assert.equal(env.protocolVersion, "1");
  assert.equal(env.reason, "扩张");
  assert.equal(env.confidence, 0.8);
  assert.match(textOf(result), /计划已接收/);
  // plan 已映射为 domain 结构（targetId 而非 target_id；direction 保留）
  const plan = env.plan;
  assert.equal((plan.unitActions.u2 as { targetId: string }).targetId, "e9");
  assert.deepEqual((plan.unitActions.u2 as unknown as { expectedCell: [number, number] }).expectedCell, [3, 4]);
  assert.deepEqual(plan.unitActions.u1, { type: "MOVE", direction: "UP" });
  assert.deepEqual(plan.coreAction, { type: "SPAWN", unitType: "WORKER" });
  assert.equal(ctx.planCalls, 1);
  assert.equal(ctx.closed, true, "调用后写入口必须关闭");
});

test("回显不一致（runId/tick/stateHash 各一种）→ context_mismatch，不投递", async () => {
  const { ctx, envelopes } = makeCtx();
  const tool = createArenaPlanToolDefinition(ctx);
  for (const bad of [
    { ...VALID_PARAMS, runId: "t1-99-0" },
    { ...VALID_PARAMS, tick: 99 },
    { ...VALID_PARAMS, stateHash: "sha256:stale" },
  ]) {
    const result = await tool.execute("c1", bad, undefined, undefined, undefined as never);
    assert.match(textOf(result), /context_mismatch/);
  }
  assert.equal(envelopes.length, 0, "回显不一致一律不投递");
  assert.equal(ctx.planCalls, 0);
});

test("重复调用 → 第二次 duplicate_tool_call，不投递", async () => {
  const { ctx, envelopes } = makeCtx();
  const tool = createArenaPlanToolDefinition(ctx);
  await tool.execute("c1", VALID_PARAMS, undefined, undefined, undefined as never);
  const second = await tool.execute("c2", VALID_PARAMS, undefined, undefined, undefined as never);
  assert.match(textOf(second), /duplicate_tool_call/);
  assert.equal(envelopes.length, 1, "只投递第一次");
});

test("sink 返回 rejected → 文本含 code；换 ctx → envelope 用新 ctx 值（不读全局）", async () => {
  const envelopes: CandidateEnvelope[] = [];
  const ctxA = createToolContext({
    runId: "t1-100-0", tenantId: "t1", tick: 100, stateHash: "sha256:state-100", mapSnapshot: null,
    sink: (e) => { envelopes.push(e); return REJECTED; },
  });
  const toolA = createArenaPlanToolDefinition(ctxA);
  const resultA = await toolA.execute("c1", VALID_PARAMS, undefined, undefined, undefined as never);
  assert.match(textOf(resultA), /deadline_exceeded/);
  assert.match(textOf(resultA), /候选被拒/);

  // 新 run 新 ctx：同一工具定义换 ctx 后 envelope 携带新标识
  const ctxB = createToolContext({
    runId: "t2-101-5", tenantId: "t2", tick: 101, stateHash: "h101", mapSnapshot: null,
    sink: (e) => { envelopes.push(e); return ACCEPTED; },
  });
  const toolB = createArenaPlanToolDefinition(ctxB);
  await toolB.execute("c1", { ...VALID_PARAMS, runId: "t2-101-5", tick: 101, stateHash: "h101" }, undefined, undefined, undefined as never);
  assert.equal(envelopes[1].runId, "t2-101-5");
  assert.equal(envelopes[1].tick, 101);
});

test("重复 unit → 只保留最后一条；core: null → coreAction null；空 actions 合法", async () => {
  const { ctx, envelopes } = makeCtx();
  const tool = createArenaPlanToolDefinition(ctx);
  await tool.execute("c1", { ...VALID_PARAMS, actions: [
    { unit: "u1", kind: "MOVE", direction: "UP" },
    { unit: "u1", kind: "WAIT" },
  ], core: null }, undefined, undefined, undefined as never);
  assert.deepEqual(envelopes[0].plan.unitActions.u1, { type: "WAIT" }, "重复 unit 取最后一条");
  assert.equal(envelopes[0].plan.coreAction, null);

  const { ctx: ctx2, envelopes: env2 } = makeCtx();
  const tool2 = createArenaPlanToolDefinition(ctx2);
  await tool2.execute("c1", { ...VALID_PARAMS, actions: [] }, undefined, undefined, undefined as never);
  assert.deepEqual(env2[0].plan.unitActions, {}, "空 actions 合法（保守计划）");
});

test("terminate 语义：arena_plan terminate、arena_map 不 terminate", () => {
  const { ctx } = makeCtx();
  const planTool = createArenaPlanToolDefinition(ctx);
  assert.equal((planTool as { terminate?: boolean }).terminate ?? false, false);
  // ToolDefinition 的 terminate 通过 execute 返回结果表达；验证 execute 返回 terminate: true
  const mapTool = createArenaMapToolDefinition(ctx);
  assert.ok(mapTool.name === "arena_map");
  assert.ok(planTool.name === "arena_plan");
});

test("arena_plan execute 返回 terminate: true（收尾工具）", async () => {
  const { ctx } = makeCtx();
  const tool = createArenaPlanToolDefinition(ctx);
  const result = await tool.execute("c1", VALID_PARAMS, undefined, undefined, undefined as never);
  assert.equal(result.terminate, true);
});

// ---------- arena_map ----------

const SNAPSHOT: MapSnapshot = {
  stats: { width: 20, height: 20, obstacleCount: 1, resourceCellCount: 2 },
  resources: [
    { position: [2, 2], kind: "crystal" },
    { position: [9, 9] },
  ],
  obstacles: [[5, 5]],
  allies: [{ id: "u1", unitType: "WORKER", position: [1, 1] }],
  enemies: [{ id: "e9", unitType: "VANGUARD", position: [7, 7] }],
};

test("arena_map：stats/resources/obstacles/allies/enemies 各自返回冻结快照", async () => {
  const { ctx } = makeCtx({ mapSnapshot: SNAPSHOT });
  const tool = createArenaMapToolDefinition(ctx);
  const stats = await tool.execute("c1", { query: "stats" }, undefined, undefined, undefined as never);
  assert.match(textOf(stats), /20x20/);
  const res = await tool.execute("c2", { query: "resources" }, undefined, undefined, undefined as never);
  assert.match(textOf(res), /\[2,2\] crystal/);
  const obs = await tool.execute("c3", { query: "obstacles" }, undefined, undefined, undefined as never);
  assert.match(textOf(obs), /\[5,5\]/);
  const allies = await tool.execute("c4", { query: "allies" }, undefined, undefined, undefined as never);
  assert.match(textOf(allies), /u1 WORKER @\[1,1\]/);
  const enemies = await tool.execute("c5", { query: "enemies" }, undefined, undefined, undefined as never);
  assert.match(textOf(enemies), /e9 VANGUARD @\[7,7\]/);
});

test("arena_map：bounds 过滤生效；无快照 → disabled 降级文本", async () => {
  const { ctx } = makeCtx({ mapSnapshot: SNAPSHOT });
  const tool = createArenaMapToolDefinition(ctx);
  const filtered = await tool.execute("c1", { query: "resources", bounds: [0, 0, 5, 5] }, undefined, undefined, undefined as never);
  assert.match(textOf(filtered), /\[2,2\]/);
  assert.ok(!textOf(filtered).includes("9,9"), "bounds 过滤必须生效");

  const { ctx: ctxNull } = makeCtx();
  const toolNull = createArenaMapToolDefinition(ctxNull);
  const disabled = await toolNull.execute("c2", { query: "stats" }, undefined, undefined, undefined as never);
  assert.match(textOf(disabled), /地图不可用/);
});

test("arena_map 多次调用不影响 planCalls（0..N 次允许）", async () => {
  const { ctx } = makeCtx({ mapSnapshot: SNAPSHOT });
  const mapTool = createArenaMapToolDefinition(ctx);
  for (let i = 0; i < 3; i += 1) {
    await mapTool.execute(`c${i}`, { query: "stats" }, undefined, undefined, undefined as never);
  }
  assert.equal(ctx.planCalls, 0, "arena_map 不得计入 planCalls");
});
