/**
 * Alliance Director — IPC discriminated union 与 runtime guards（Phase 3a）。
 *
 * 消息方向：
 * - child → supervisor: arena.alliance.member（租户状态报告）
 * - supervisor → child: arena.alliance.directive（联盟指令下发）
 * - child → supervisor: arena.alliance.ack（指令确认/拒绝）
 *
 * 设计约束（spec §15）：
 * - 不含 Arena credentials or action-writer capabilities——合同层不能成为 writer；
 * - malformed 消息拒绝且不 throw 生产主循环（fail-open）；
 * - 所有 guard 返回 boolean，由调用方决定处理路径。
 *
 * 最后更新：2026-08-08
 */

import type { AllianceDirective, AllianceMemberReport } from "../control-types.ts";

// ── Schema version ────────────────────────────────────────────

/** 当前 IPC schema 版本。不匹配的消息被忽略（不抛）。 */
export const ALLIANCE_IPC_SCHEMA_VERSION = 1;

// ── Message types ─────────────────────────────────────────────

/**
 * child → supervisor：租户每 Tick 向 supervisor 发送压缩状态报告。
 * 不发送整个私有 TickState——只包含联盟决策所需的最小信息。
 */
export interface AllianceMemberMessage {
  readonly type: "arena.alliance.member";
  readonly schemaVersion: number;
  readonly tenantId: string;
  readonly tick: number;
  readonly report: AllianceMemberReport;
}

/**
 * supervisor → child：supervisor 向单个租户下发 AllianceDirective。
 * child 只保存最新有效 revision——过期/stale/wrong tenant → ignore。
 */
export interface AllianceDirectiveMessage {
  readonly type: "arena.alliance.directive";
  readonly schemaVersion: number;
  readonly tenantId: string;
  readonly tick: number;
  readonly revision: number;
  readonly directive: AllianceDirective;
}

/**
 * child → supervisor：租户确认收到指令后的状态反馈。
 * supervisor 用 ack 跟踪 sent/accepted/ignored/rejected 状态。
 */
export type AllianceAckStatus = "accepted" | "ignored" | "rejected";

export interface AllianceAckMessage {
  readonly type: "arena.alliance.ack";
  readonly schemaVersion: number;
  readonly tenantId: string;
  readonly tick: number;
  readonly revision: number;
  readonly status: AllianceAckStatus;
  readonly reason?: string;
}

/** Alliance IPC 消息 discriminated union。 */
export type AllianceIpcMessage =
  | AllianceMemberMessage
  | AllianceDirectiveMessage
  | AllianceAckMessage;

// ── Runtime guards ────────────────────────────────────────────

/**
 * 验证消息是否为合法 Alliance IPC 消息（discriminated union）。
 * malformed → false，调用方忽略消息但不抛。
 */
export function isAllianceIpcMessage(message: unknown): message is AllianceIpcMessage {
  if (message === null || message === undefined) return false;
  if (typeof message !== "object") return false;

  const m = message as Record<string, unknown>;
  if (typeof m.type !== "string") return false;

  switch (m.type) {
    case "arena.alliance.member":
      return isAllianceMemberMessage(message);
    case "arena.alliance.directive":
      return isAllianceDirectiveMessage(message);
    case "arena.alliance.ack":
      return isAllianceAckMessage(message);
    default:
      return false;
  }
}

/**
 * 验证 child→supervisor member 消息结构完整性。
 * 不抛——返回 false，调用方忽略消息。
 */
export function isAllianceMemberMessage(message: unknown): message is AllianceMemberMessage {
  if (message === null || message === undefined) return false;
  if (typeof message !== "object") return false;

  const m = message as Record<string, unknown>;
  if (m.type !== "arena.alliance.member") return false;
  if (m.schemaVersion !== ALLIANCE_IPC_SCHEMA_VERSION) return false;
  if (typeof m.tenantId !== "string" || m.tenantId.length === 0) return false;
  if (!Number.isInteger(m.tick) || (m.tick as number) < 0) return false;
  if (m.report === null || m.report === undefined || typeof m.report !== "object") return false;

  const report = m.report as Record<string, unknown>;
  // 最小必需字段校验
  if (typeof report.tenantId !== "string" || report.tenantId.length === 0) return false;
  if (!Number.isInteger(report.tick) || (report.tick as number) < 0) return false;
  if (!Number.isFinite(report.observedAtMs) || (report.observedAtMs as number) < 0) return false;
  if (report.tenantId !== m.tenantId || report.tick !== m.tick) return false;

  return true;
}

/**
 * 验证 supervisor→child directive 消息结构完整性。
 * 不抛——返回 false，调用方忽略消息。
 */
export function isAllianceDirectiveMessage(message: unknown): message is AllianceDirectiveMessage {
  if (message === null || message === undefined) return false;
  if (typeof message !== "object") return false;

  const m = message as Record<string, unknown>;
  if (m.type !== "arena.alliance.directive") return false;
  if (m.schemaVersion !== ALLIANCE_IPC_SCHEMA_VERSION) return false;
  if (typeof m.tenantId !== "string" || m.tenantId.length === 0) return false;
  if (!Number.isInteger(m.tick) || (m.tick as number) < 0) return false;
  if (!Number.isInteger(m.revision) || (m.revision as number) < 0) return false;
  if (m.directive === null || m.directive === undefined || typeof m.directive !== "object") return false;

  const directive = m.directive as Record<string, unknown>;
  // 最小必需字段校验
  if (typeof directive.tenantId !== "string" || directive.tenantId.length === 0) return false;
  if (!Number.isInteger(directive.revision) || (directive.revision as number) < 0) return false;
  if (directive.tenantId !== m.tenantId || directive.revision !== m.revision) return false;

  return true;
}

/**
 * 验证 child→supervisor ack 消息结构完整性。
 * 不抛——返回 false，调用方忽略消息。
 */
export function isAllianceAckMessage(message: unknown): message is AllianceAckMessage {
  if (message === null || message === undefined) return false;
  if (typeof message !== "object") return false;

  const m = message as Record<string, unknown>;
  if (m.type !== "arena.alliance.ack") return false;
  if (m.schemaVersion !== ALLIANCE_IPC_SCHEMA_VERSION) return false;
  if (typeof m.tenantId !== "string" || m.tenantId.length === 0) return false;
  if (!Number.isInteger(m.tick) || (m.tick as number) < 0) return false;
  if (!Number.isInteger(m.revision) || (m.revision as number) < 0) return false;

  const status = m.status;
  if (status !== "accepted" && status !== "ignored" && status !== "rejected") return false;

  // reason 可选，但如果有则必须是 string
  if (m.reason !== undefined && m.reason !== null && typeof m.reason !== "string") return false;

  return true;
}

// ── Message constructors (pure factory, no side effects) ──────

/**
 * 构造 child→supervisor member 报告消息（不验证内容语义，仅构造 shape）。
 * 调用方负责确保 report 字段完整。
 */
export function createMemberMessage(report: AllianceMemberReport): AllianceMemberMessage {
  return {
    type: "arena.alliance.member",
    schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION,
    tenantId: report.tenantId,
    tick: report.tick,
    report,
  };
}

/**
 * 构造 supervisor→child directive 消息（不验证内容语义，仅构造 shape）。
 * 调用方负责确保 directive 已通过 validateDirectiveForTenant。
 */
export function createDirectiveMessage(
  directive: AllianceDirective,
  tick: number,
): AllianceDirectiveMessage {
  return {
    type: "arena.alliance.directive",
    schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION,
    tenantId: directive.tenantId,
    tick,
    revision: directive.revision,
    directive,
  };
}

/**
 * 构造 child→supervisor ack 消息。
 */
export function createAckMessage(
  tenantId: string,
  tick: number,
  revision: number,
  status: AllianceAckStatus,
  reason?: string,
): AllianceAckMessage {
  return {
    type: "arena.alliance.ack",
    schemaVersion: ALLIANCE_IPC_SCHEMA_VERSION,
    tenantId,
    tick,
    revision,
    status,
    ...(reason !== undefined ? { reason } : {}),
  };
}

