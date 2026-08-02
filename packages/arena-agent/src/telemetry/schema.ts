/**
 * 遥测记录 TypeBox schema（W9 三流），与 decision-trace.ts 接口字段一一对应。
 * validateTraceRecord：三条 schema 任一通过即合法；全部失败 → 抛错并携带
 * 每条 schema 的首个字段路径（instancePath；缺必填字段时由 required 合成）。
 * 校验失败必须抛错（不许静默跳过——脏数据不进审计链）。
 */

import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TraceRecord } from "./decision-trace.ts";

const DeadlineOutcomeSchema = Type.Union([
  Type.Literal("candidate"),
  Type.Literal("soft_deadline"),
  Type.Literal("selection_timeout"),
  Type.Literal("error"),
]);

const DecisionSourceSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("hybrid"),
  Type.Literal("safety"),
  Type.Literal("emergency"),
  Type.Literal("repaired-agent"),
]);

const SubmitResultSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("rejected"),
  Type.Literal("not_submitted"),
]);

export const RuntimeTraceSchema = Type.Object({
  processRunId: Type.String(),
  tenantId: Type.String(),
  tick: Type.Integer(),
  runId: Type.String(),
  deadlineOutcome: DeadlineOutcomeSchema,
  agentLatencyMs: Type.Union([Type.Number(), Type.Null()]),
  selectionLatencyMs: Type.Number(),
  abortRequested: Type.Boolean(),
  rotationGeneration: Type.Integer(),
  submitResult: SubmitResultSchema,
  leaseRejectionCode: Type.Optional(Type.String()),
});

export const DecisionTraceSchema = Type.Object({
  processRunId: Type.String(),
  tenantId: Type.String(),
  tick: Type.Integer(),
  runId: Type.String(),
  decisionSource: DecisionSourceSchema,
  agentActionCount: Type.Integer(),
  safetyReplacementCount: Type.Integer(),
  invalidAgentActionCount: Type.Integer(),
  repairCount: Type.Integer(),
  planHash: Type.String(),
  reason: Type.Optional(Type.String()),
});

export const OutcomeTraceSchema = Type.Object({
  processRunId: Type.String(),
  tenantId: Type.String(),
  tick: Type.Integer(),
  coreResourcesBefore: Type.Number(),
  coreResourcesAfter: Type.Number(),
  coreResourceDelta: Type.Number(),
  grossDeposit: Type.Optional(Type.Number()),
  spawnCount: Type.Optional(Type.Integer()),
  healCount: Type.Optional(Type.Integer()),
  unitLossCount: Type.Optional(Type.Integer()),
  events: Type.Array(Type.String()),
});

/** 返回首个错误的字段路径 + 消息（无错误返回 null）。 */
function firstFieldError(schema: TSchema, value: unknown): string | null {
  if (Value.Check(schema, value)) {
    return null;
  }
  const first = Value.Errors(schema, value)[0];
  if (first === undefined) {
    return null;
  }
  // 缺必填字段：instancePath 为空，路径从 params.requiredProperties 合成
  const required = (first.params as { requiredProperties?: string[] }).requiredProperties?.[0];
  const path =
    first.instancePath !== ""
      ? first.instancePath
      : required !== undefined
        ? `/${required}`
        : "/";
  return `${path} ${first.message}`;
}

/**
 * 校验遥测记录：三条 schema 任一通过即返回（narrow 为 TraceRecord）；
 * 全部失败抛错，错误信息含每条 schema 的首个字段路径（如
 * `runtime(/deadlineOutcome ...); decision(/decisionSource ...); outcome(/tick ...)`）。
 */
export function validateTraceRecord(record: unknown): TraceRecord {
  const failures: Array<{ name: string; detail: string }> = [];
  for (const [name, schema] of [
    ["runtime", RuntimeTraceSchema],
    ["decision", DecisionTraceSchema],
    ["outcome", OutcomeTraceSchema],
  ] as const) {
    const detail = firstFieldError(schema, record);
    if (detail === null) {
      return record as TraceRecord;
    }
    failures.push({ name, detail });
  }
  throw new Error(
    `invalid trace record: ${failures.map((f) => `${f.name}(${f.detail})`).join("; ")}`,
  );
}
