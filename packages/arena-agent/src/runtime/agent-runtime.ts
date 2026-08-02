/** W4 Agent 决策源端口补充层（2026-08-03）。
 *
 * 端口本身冻结在 decision-types.ts（AgentDecisionRuntime / AgentRunHandle /
 * CandidateEnvelope / AgentDecisionRequest），本文件只补 CandidateSink 需要的
 * 运行时判别：isCandidateEnvelope。
 */

import type { Plan } from "../domain/model.ts";
import type { CandidateEnvelope } from "./decision-types.ts";

/**
 * 运行时判别：候选信封是否结构合法（CandidateSink 过滤用）。
 *
 * 判别规则：protocolVersion === "1" 且必需字段齐全、类型正确。
 * 深度语义校验（plan 可执行性、tick/stateHash 是否命中 lease）不在这里做——
 * 那是 LeaseRegistry 的职责；本守卫只回答"这算不算一个 CandidateEnvelope"。
 */
export function isCandidateEnvelope(value: unknown): value is CandidateEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== "1") {
    return false;
  }
  if (typeof v.runId !== "string" || v.runId.length === 0) {
    return false;
  }
  if (typeof v.tenantId !== "string" || v.tenantId.length === 0) {
    return false;
  }
  if (typeof v.tick !== "number" || !Number.isInteger(v.tick)) {
    return false;
  }
  if (typeof v.stateHash !== "string" || v.stateHash.length === 0) {
    return false;
  }
  if (typeof v.reason !== "string") {
    return false;
  }
  if (v.confidence !== null && (typeof v.confidence !== "number" || !Number.isFinite(v.confidence))) {
    return false;
  }
  return isPlan(v.plan);
}

function isPlan(value: unknown): value is Plan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const p = value as Record<string, unknown>;
  if (typeof p.tick !== "number" || !Number.isInteger(p.tick)) {
    return false;
  }
  if (typeof p.unitActions !== "object" || p.unitActions === null || Array.isArray(p.unitActions)) {
    return false;
  }
  if (p.coreAction !== null && (typeof p.coreAction !== "object" || p.coreAction === null)) {
    return false;
  }
  if (typeof p.intents !== "object" || p.intents === null || Array.isArray(p.intents)) {
    return false;
  }
  return true;
}
