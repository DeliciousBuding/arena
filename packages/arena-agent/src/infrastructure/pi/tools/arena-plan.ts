/**
 * arena_plan 工具（切片 4-4B，总任务书 2.2）：LLM 提交本 Tick 计划的唯一收尾工具。
 *
 * 流程固定（总任务书）：
 *   参数回显与 ctx 比较 → 不一致：context_mismatch，不投递
 *   → planCalls 已为 1：duplicate_tool_call，不投递
 *   → 用 ctx 的标识字段构造 CandidateEnvelope（plan/reason/confidence 从参数取）
 *   → ctx.sink(envelope) → 把 LeaseSubmission.accepted/code/message 反馈给模型
 *
 * 禁止：直接 submit 游戏；自动替换错误 runId 后继续接受；把迟到计划投到新 Tick；
 * Lease 拒绝后重试下一 Lease。
 */

import { Type, type Static } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CoreAction, Direction, Plan, UnitAction } from "../../../domain/model.ts";
import type { CandidateEnvelope } from "../../../runtime/decision-types.ts";
import type { ToolContext } from "./tool-context.ts";

// ---------- 参数 schema（LLM 必须显式回显 runId/tick/stateHash；值源在 ctx） ----------

const actionSchema = Type.Object(
  {
    unit: Type.String({ description: "单位完整 UUID（来自本 Tick 状态中的单位列表）" }),
    kind: Type.Union(
      [
        Type.Literal("MOVE"),
        Type.Literal("SWEEP"),
        Type.Literal("SHOOT"),
        Type.Literal("HARVEST"),
        Type.Literal("DEPOSIT"),
        Type.Literal("HEAL"),
        Type.Literal("PICKUP_BEACON"),
        Type.Literal("DROP_BEACON"),
        Type.Literal("SELF_DESTRUCT"),
        Type.Literal("WAIT"),
      ],
      { description: "动作类型（MOVE/SWEEP 需要 direction）" },
    ),
    direction: Type.Optional(
      Type.Union(
        [Type.Literal("UP"), Type.Literal("DOWN"), Type.Literal("LEFT"), Type.Literal("RIGHT")],
        { description: "方向（MOVE/SWEEP 必需）" },
      ),
    ),
    target_id: Type.Optional(Type.String({ description: "射击目标 UUID（SHOOT 用）" })),
    expected_cell: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  },
  { additionalProperties: false },
);

const arenaPlanSchema = Type.Object(
  {
    // 回显字段（GPT 审核/总任务书：参数必须显式携带，与 ctx 一致性校验）
    runId: Type.String({ description: "本次决策的 runId（必须与提示一致）" }),
    tick: Type.Number({ description: "本次决策的 tick（必须与提示一致）" }),
    stateHash: Type.String({ description: "本次决策的 stateHash（必须与提示一致）" }),
    actions: Type.Array(actionSchema, { description: "每个单位的动作（每单位最多一条）" }),
    core: Type.Optional(
      Type.Union(
        [
          Type.Object(
            {
              kind: Type.Literal("SPAWN"),
              unit_type: Type.Union([
                Type.Literal("WORKER"),
                Type.Literal("VANGUARD"),
                Type.Literal("RANGER"),
              ]),
            },
            { additionalProperties: false },
          ),
          Type.Object({ kind: Type.Literal("HEAL") }, { additionalProperties: false }),
          Type.Object({ kind: Type.Literal("REPAIR_SHIELD") }, { additionalProperties: false }),
          Type.Object({ kind: Type.Literal("WAIT") }, { additionalProperties: false }),
          Type.Null(),
        ],
        { description: "Core 动作（可选，null 表示不动）" },
      ),
    ),
    reason: Type.Optional(Type.String({ description: "一句话决策理由" })),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export type ArenaPlanParams = Static<typeof arenaPlanSchema>;

// ---------- wire → domain 映射（与 loop.ts 的 planToCommandPlan 反向） ----------

const DIRECTION: Record<string, Direction> = { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" };

function toDomainAction(action: ArenaPlanParams["actions"][number]): UnitAction {
  switch (action.kind) {
    case "MOVE":
    case "SWEEP":
      return { type: action.kind, direction: DIRECTION[action.direction ?? ""] ?? "UP" };
    case "SHOOT":
      return {
        type: "SHOOT",
        targetId: action.target_id ?? "",
        expectedCell: [action.expected_cell?.[0] ?? 0, action.expected_cell?.[1] ?? 0],
      };
    case "HARVEST":
    case "DEPOSIT":
    case "HEAL":
    case "PICKUP_BEACON":
    case "DROP_BEACON":
    case "SELF_DESTRUCT":
    case "WAIT":
      return { type: action.kind };
  }
}

function toDomainCore(core: ArenaPlanParams["core"]): CoreAction | null {
  if (core === null || core === undefined) {
    return null;
  }
  if (core.kind === "SPAWN") {
    return { type: "SPAWN", unitType: core.unit_type };
  }
  return { type: core.kind };
}

/** 参数 → domain Plan（tick 用 ctx 权威值；intents 空）。 */
function toDomainPlan(ctx: ToolContext, params: ArenaPlanParams): Plan {
  const unitActions: Record<string, UnitAction> = {};
  // 每单位最多一条：重复 unit 取最后一条（总任务书 2.2）
  for (const action of params.actions ?? []) {
    unitActions[action.unit] = toDomainAction(action);
  }
  return { tick: ctx.tick, unitActions, coreAction: toDomainCore(params.core), intents: {} };
}

// ---------- 工具定义 ----------

export function createArenaPlanToolDefinition(ctx: ToolContext): ToolDefinition<typeof arenaPlanSchema> {
  return {
    name: "arena_plan",
    label: "arena_plan",
    description:
      "提交本 Tick 的 Arena Hero 游戏行动计划（每个受控单位的动作 + 可选 Core 动作）。" +
      "runId/tick/stateHash 必须与本次提示完全一致。无法决定时提交空 actions。",
    promptSnippet: "提交 Arena Hero 行动计划的唯一收尾工具",
    promptGuidelines: [
      "最后且只能调用一次 arena_plan 提交完整计划，调用后立即结束本轮。",
      "runId/tick/stateHash 参数必须与提示中给出的本次值完全一致。",
      "不要调用任何其他工具（arena_map 除外）。",
      "无法决定时就提交空 actions 而不是犹豫。",
    ],
    parameters: arenaPlanSchema,
    async execute(_toolCallId, params) {
      // 1) 回显校验（值源在 ctx；LLM 参数只是回显）
      if (params.runId !== ctx.runId || params.tick !== ctx.tick || params.stateHash !== ctx.stateHash) {
        return {
          content: [
            {
              type: "text",
              text: `context_mismatch：参数携带的 runId/tick/stateHash 与本次决策不一致（参数 runId=${params.runId} tick=${params.tick}，本次 ${ctx.runId}/${ctx.tick}）。候选未投递。`,
            },
          ],
          details: undefined,
          terminate: true,
        };
      }
      // 2) 重复调用校验（必须且只能 1 次）
      if (ctx.planCalls >= 1) {
        return {
          content: [
            {
              type: "text",
              text: `duplicate_tool_call：arena_plan 每 Tick 只能调用一次（本次已是第 ${ctx.planCalls + 1} 次）。候选未投递。`,
            },
          ],
          details: undefined,
          terminate: true,
        };
      }
      // 3) 用 ctx 标识字段构造 envelope（plan/reason/confidence 从参数取）
      const envelope: CandidateEnvelope = {
        protocolVersion: "1",
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        tick: ctx.tick,
        stateHash: ctx.stateHash,
        plan: toDomainPlan(ctx, params),
        reason: params.reason ?? "arena_plan tool call",
        confidence: params.confidence ?? null,
      };
      ctx.planCalls += 1;
      ctx.closed = true;
      // 4) 投递并反馈结构化结果（accepted / code / message）
      const submission = ctx.sink(envelope);
      const text = submission.accepted
        ? "计划已接收。请直接结束本轮，不要输出其他内容或调用其他工具。"
        : `候选被拒：${submission.code}（${submission.message}）。本 Tick 计划已由系统兜底，请直接结束本轮。`;
      return { content: [{ type: "text", text }], details: undefined, terminate: true };
    },
  };
}
