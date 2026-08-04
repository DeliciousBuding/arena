/**
 * arena_plan 工具（切片 4-4B + 4D-pre 严格化）：LLM 提交本 Tick 计划的唯一收尾工具。
 *
 * 流程固定（总任务书 2.2 + 4D-pre P0-2）：
 *   回显校验（runId/tick/stateHash 与 ctx 一致）→ 不一致：context_mismatch，不投递
 *   → planCalls 已为 1：duplicate_tool_call，不投递
 *   → 严格参数解析（缺 direction/target_id/expected_cell → invalid_tool_arguments；
 *      重复 unit → duplicate_unit_action；未知己方 unit → unknown_unit）——一律不投递，不猜值
 *   → 用 ctx 的标识字段构造 CandidateEnvelope（plan/reason/confidence 从参数取）
 *   → ctx.sink(envelope) → 把 LeaseSubmission.accepted/code/message 反馈给模型
 *
 * 禁止：直接 submit 游戏；自动替换错误 runId 后继续接受；把迟到计划投到新 Tick；
 * Lease 拒绝后重试下一 Lease；局部猜值（缺字段补默认）。
 */

import { Type, type Static } from "typebox";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CoreAction, Direction, Plan, UnitAction } from "../../../domain/model.ts";
import type { CandidateEnvelope } from "../../../runtime/decision-types.ts";
import { ActiveToolContextSlot } from "./active-context-slot.ts";
import type { ToolContext } from "./tool-context.ts";

// ---------- 参数 schema（LLM 必须显式回显 runId/tick/stateHash；值源在 ctx） ----------

const actionSchema = Type.Object(
  {
    unit: Type.String({ description: "单位完整 UUID（必须来自本 Tick 受控单位列表）" }),
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
      { description: "动作类型（MOVE/SWEEP 需要 direction；SHOOT 需要 target_id + expected_cell）" },
    ),
    direction: Type.Optional(
      Type.Union(
        [Type.Literal("UP"), Type.Literal("DOWN"), Type.Literal("LEFT"), Type.Literal("RIGHT")],
        { description: "方向（MOVE/SWEEP 必需）" },
      ),
    ),
    target_id: Type.Optional(Type.String({ description: "射击目标 UUID（SHOOT 可选：缺省为 cell fire 射向 expected_cell 格）" })),
    expected_cell: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  },
  { additionalProperties: false },
);

const coreSchema = Type.Union(
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
    Type.Object(
      { kind: Type.Literal("START_MOVE"), direction: Type.Union([Type.Literal("UP"), Type.Literal("DOWN"), Type.Literal("LEFT"), Type.Literal("RIGHT")]) },
      { additionalProperties: false },
    ),
    Type.Object({ kind: Type.Literal("CANCEL_MOVE") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("PICKUP_BEACON") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("DROP_BEACON") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("SELF_DESTRUCT") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("WAIT") }, { additionalProperties: false }),
    Type.Null(),
  ],
  { description: "Core 动作（完整覆盖 domain 能力；null 表示不动）" },
);

const arenaPlanSchema = Type.Object(
  {
    // 回显字段（总任务书：参数必须显式携带，与 ctx 一致性校验）
    runId: Type.String({ description: "本次决策的 runId（必须与提示一致）" }),
    tick: Type.Number({ description: "本次决策的 tick（必须与提示一致）" }),
    stateHash: Type.String({ description: "本次决策的 stateHash（必须与提示一致）" }),
    actions: Type.Array(actionSchema, { description: "每个单位的动作（每单位最多一条）" }),
    core: Type.Optional(coreSchema),
    reason: Type.Optional(Type.String({ description: "一句话决策理由" })),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

export type ArenaPlanParams = Static<typeof arenaPlanSchema>;

// ---------- 严格解析（4D-pre P0-2：不猜值，缺字段一律拒绝） ----------

/** 工具参数拒绝（execute 捕获 → 返回拒绝文本，不投递）。 */
export class ToolArgError extends Error {
  readonly code: "invalid_tool_arguments" | "duplicate_unit_action" | "unknown_unit";
  constructor(code: ToolArgError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const DIRECTION: Record<string, Direction> = { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" };

function requireDirection(action: ArenaPlanParams["actions"][number]): Direction {
  const direction = DIRECTION[action.direction ?? ""];
  if (direction === undefined) {
    throw new ToolArgError("invalid_tool_arguments", `action ${action.unit} ${action.kind} 缺少 direction`);
  }
  return direction;
}

function toDomainAction(action: ArenaPlanParams["actions"][number]): UnitAction {
  switch (action.kind) {
    case "MOVE":
    case "SWEEP":
      return { type: action.kind, direction: requireDirection(action) };
    case "SHOOT": {
      const cell = action.expected_cell;
      if (
        cell === undefined ||
        cell.length !== 2 ||
        !Number.isInteger(cell[0]) ||
        !Number.isInteger(cell[1])
      ) {
        throw new ToolArgError("invalid_tool_arguments", `action ${action.unit} SHOOT 缺少整数 expected_cell`);
      }
      // Upstream v0.12 cell fire: target_id 可选；缺省时对 expected_cell 格射击。
      const targetId = action.target_id === undefined || action.target_id.length === 0 ? null : action.target_id;
      return { type: "SHOOT", targetId, expectedCell: [cell[0], cell[1]] };
    }
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
  switch (core.kind) {
    case "SPAWN":
      return { type: "SPAWN", unitType: core.unit_type };
    case "START_MOVE": {
      const direction = DIRECTION[core.direction];
      if (direction === undefined) {
        throw new ToolArgError("invalid_tool_arguments", `core START_MOVE 缺少 direction`);
      }
      return { type: "START_MOVE", direction };
    }
    default:
      return { type: core.kind };
  }
}

/** 参数 → domain Plan（tick 用 ctx 权威值；intents 空）。严格：重复 unit / 未知 unit 拒绝。 */
function toDomainPlan(ctx: ToolContext, params: ArenaPlanParams): Plan {
  const unitActions: Record<string, UnitAction> = {};
  for (const action of params.actions ?? []) {
    if (!ctx.controlledUnits.has(action.unit)) {
      throw new ToolArgError("unknown_unit", `未知己方单位 UUID: ${action.unit}`);
    }
    if (unitActions[action.unit] !== undefined) {
      throw new ToolArgError("duplicate_unit_action", `重复单位动作: ${action.unit}`);
    }
    unitActions[action.unit] = toDomainAction(action);
  }
  return { tick: ctx.tick, unitActions, coreAction: toDomainCore(params.core), intents: {} };
}

// ---------- 工具定义 ----------

export function createArenaPlanToolDefinition(slot: ActiveToolContextSlot): ToolDefinition<typeof arenaPlanSchema> {
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
      const ctx = slot.current(); // 4D-pre：每次 execute 取当前 active context
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
      // 3) 严格参数解析（4D-pre P0-2：不猜值，一律拒绝并返回 code）
      let plan: Plan;
      try {
        plan = toDomainPlan(ctx, params);
      } catch (error) {
        if (error instanceof ToolArgError) {
          return {
            content: [{ type: "text", text: `${error.code}：${error.message}。候选未投递。` }],
            details: undefined,
            terminate: true,
          };
        }
        throw error;
      }
      // 4) 用 ctx 标识字段构造 envelope（plan/reason/confidence 从参数取）
      const envelope: CandidateEnvelope = {
        protocolVersion: "1",
        runId: ctx.runId,
        tenantId: ctx.tenantId,
        tick: ctx.tick,
        stateHash: ctx.stateHash,
        plan,
        reason: params.reason ?? "arena_plan tool call",
        confidence: params.confidence ?? null,
      };
      ctx.planCalls += 1;
      ctx.closed = true;
      // 5) 投递并反馈结构化结果（accepted / code / message）
      const submission = ctx.sink(envelope);
      const text = submission.accepted
        ? "计划已接收。请直接结束本轮，不要输出其他内容或调用其他工具。"
        : `候选被拒：${submission.code}（${submission.message}）。本 Tick 计划已由系统兜底，请直接结束本轮。`;
      return { content: [{ type: "text", text }], details: undefined, terminate: true };
    },
  };
}
