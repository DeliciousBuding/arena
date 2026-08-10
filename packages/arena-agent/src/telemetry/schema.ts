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
  Type.Literal("not_applicable"),
  Type.Literal("error"),
]);

const DecisionSourceSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("hybrid"),
  Type.Literal("deterministic"),
  Type.Literal("safety"),
  Type.Literal("emergency"),
  Type.Literal("repaired-agent"),
  // human-command-v1（5394371）给 DecisionSource 类型加了 "human"，但漏同步
  // 运行时 schema——人类指令激活时 source="human" 触发 trace 校验崩溃
  // （生产 t1 实测 2026-08-07：invalid trace record decision(/decisionSource
  // must be equal to constant)，tenant exitCode=1）。
  Type.Literal("human"),
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
  /** 配置热加载代数（2026-08-08）：每次 config 热替换 +1，tick 归属当前配置代。 */
  configGeneration: Type.Optional(Type.Integer()),
  configHash: Type.Optional(Type.String()),
  strategyHash: Type.Optional(Type.String()),
  submitResult: SubmitResultSchema,
  submitError: Type.Optional(Type.String()),
  notSubmittedReason: Type.Optional(Type.Union([
    Type.Literal("disabled"),
    Type.Literal("startup_sync"),
    Type.Literal("outcome_drain"),
  ])),
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
  moveCount: Type.Optional(Type.Integer()),
  harvestCount: Type.Optional(Type.Integer()),
  depositCount: Type.Optional(Type.Integer()),
  waitCount: Type.Optional(Type.Integer()),
  intentCounts: Type.Optional(Type.Record(Type.String(), Type.Integer())),
  planHash: Type.String(),
  reason: Type.Optional(Type.String()),
  threatLevel: Type.Optional(Type.Union([
    Type.Literal("NORMAL"),
    Type.Literal("ALERT"),
    Type.Literal("ENGAGED"),
    Type.Literal("BREAKOUT"),
  ])),
  threatReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  threatClosingEnemies: Type.Optional(Type.Integer()),
  threatMovingEnemies: Type.Optional(Type.Integer()),
  threatAxes: Type.Optional(Type.Integer()),
  // 信标遥测（2026-08-08）：position 永远公开；status/carrierId 仅信标格可见时非空。
  beacon: Type.Optional(Type.Object({
    position: Type.Tuple([Type.Integer(), Type.Integer()]),
    status: Type.Optional(Type.Union([Type.Literal("GROUND"), Type.Literal("CARRIED"), Type.Null()])),
    carrierId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  })),
  // GAP 1.3 遥测（2026-08-10）：渐进冷却升级累计计数（96/192/384 tick 升级次数）。
  failedCooldownEscalationCount: Type.Optional(Type.Integer()),
});

export const OutcomeTraceSchema = Type.Object({
  processRunId: Type.String(),
  tenantId: Type.String(),
  tick: Type.Integer(),
  coreResourcesBefore: Type.Number(),
  coreResourcesAfter: Type.Number(),
  coreResourceDelta: Type.Number(),
  visibleResourceCellCount: Type.Optional(Type.Integer()),
  workerCount: Type.Optional(Type.Integer()),
  workersWithCargo: Type.Optional(Type.Integer()),
  workerCargoTotal: Type.Optional(Type.Integer()),
  uniqueWorkerCellCount: Type.Optional(Type.Integer()),
  workerMaxDistanceFromCore: Type.Optional(Type.Number()),
  workerMeanDistanceFromCore: Type.Optional(Type.Number()),
  failedEvents: Type.Optional(Type.Array(Type.Object({
    eventType: Type.String(),
    reasonCode: Type.Union([Type.String(), Type.Null()]),
    actorId: Type.Union([Type.String(), Type.Null()]),
    targetId: Type.Union([Type.String(), Type.Null()]),
    position: Type.Optional(Type.Tuple([Type.Integer(), Type.Integer()])),
    priorAction: Type.Optional(Type.String()),
    priorIntent: Type.Optional(Type.String()),
  }))),
  grossDeposit: Type.Optional(Type.Number()),
  spawnCount: Type.Optional(Type.Integer()),
  healCount: Type.Optional(Type.Integer()),
  unitLossCount: Type.Optional(Type.Integer()),
  events: Type.Array(Type.String()),
  humanOverride: Type.Optional(Type.Object({
    active: Type.Boolean(),
    applied: Type.Array(Type.String()),
    rejected: Type.Array(Type.Object({
      unitId: Type.String(),
      reason: Type.String(),
    })),
    satisfied: Type.Array(Type.String()),
    updatedAt: Type.Union([Type.String(), Type.Null()]),
  })),
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
