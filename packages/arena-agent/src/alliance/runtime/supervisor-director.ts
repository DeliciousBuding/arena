/**
 * Tokenless, in-memory Alliance Director shadow runtime.
 * Default disabled; it cannot submit Arena actions and all faults fail open.
 */
import type { AllianceDirective, AllianceMemberReport } from "../control-types.ts";
import { isMemberReportStale, DEFAULT_REPORT_STALE_TICKS } from "../member-report.ts";
import { validateDirectiveForTenant } from "../directive.ts";
import type { AllianceAckStatus, AllianceDirectiveMessage } from "./ipc.ts";
import { createDirectiveMessage } from "./ipc.ts";

export type AckState = "sent" | AllianceAckStatus;

export interface DirectiveAckRecord {
  readonly tenantId: string;
  readonly revision: number;
  readonly state: AckState;
  readonly tick: number;
  readonly reason?: string;
}

export interface AllianceDirectorStats {
  readonly reportCount: number;
  readonly directiveSentCount: number;
  /** Number of child ACK calls received; internal sent/rejected bookkeeping is excluded. */
  readonly ackCount: number;
  readonly directorErrorCount: number;
  readonly invalidOutputCount: number;
  readonly sendErrorCount: number;
  readonly lastReplanTick: number;
  readonly enabled: boolean;
  readonly memberTenants: readonly string[];
  readonly ackRecords: readonly DirectiveAckRecord[];
}

export interface AllianceDirectorCallbacks {
  send(tenantId: string, message: AllianceDirectiveMessage): void;
}

export interface AllianceDirectorInterface {
  replan(
    reports: ReadonlyMap<string, AllianceMemberReport>,
    tick: number,
  ): readonly AllianceDirective[];
}

export interface SupervisorAllianceDirectorOptions {
  readonly enabled?: boolean;
  readonly maxReportAgeTicks?: number;
  readonly maxAckRecords?: number;
}

export interface SupervisorAllianceDirectorRuntime {
  onMemberReport(report: AllianceMemberReport): void;
  /** Child ACK entry point. `sent` is intentionally not accepted here. */
  onAck(
    tenantId: string,
    revision: number,
    status: AllianceAckStatus,
    tick: number,
    reason?: string,
  ): void;
  replan(tick: number): void;
  stats(): AllianceDirectorStats;
  enabled: boolean;
}

interface AckEntry {
  tenantId: string;
  revision: number;
  state: AckState;
  tick: number;
  reason?: string;
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && (value as number) >= 0
    ? (value as number)
    : fallback;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

function directiveRuntimeShape(value: unknown): value is AllianceDirective {
  if (value === null || typeof value !== "object") return false;
  const directive = value as Record<string, unknown>;
  return typeof directive.tenantId === "string"
    && directive.tenantId.length > 0
    && Number.isInteger(directive.revision)
    && (directive.revision as number) >= 0;
}

export function createSupervisorAllianceDirectorRuntime(
  director: AllianceDirectorInterface,
  callbacks: AllianceDirectorCallbacks,
  options: SupervisorAllianceDirectorOptions = {},
): SupervisorAllianceDirectorRuntime {
  const maxReportAgeTicks = nonNegativeInt(options.maxReportAgeTicks, DEFAULT_REPORT_STALE_TICKS);
  const maxAckRecords = positiveInt(options.maxAckRecords, 64);

  const reports = new Map<string, AllianceMemberReport>();
  const ackEntries: AckEntry[] = [];
  const latestAckRevisionByTenant = new Map<string, number>();
  let enabled = options.enabled ?? false;
  let directiveSentCount = 0;
  let ackCount = 0;
  let directorErrorCount = 0;
  let invalidOutputCount = 0;
  let sendErrorCount = 0;
  let lastReplanTick = -1;

  function sortedTenants(): string[] {
    return [...reports.keys()].sort(stableCompare);
  }

  function freshReports(tick: number): ReadonlyMap<string, AllianceMemberReport> {
    const fresh = new Map<string, AllianceMemberReport>();
    for (const tenantId of sortedTenants()) {
      const report = reports.get(tenantId)!;
      if (!isMemberReportStale(report, tick, maxReportAgeTicks)) fresh.set(tenantId, report);
    }
    return fresh;
  }

  function trimAckRecords(): void {
    while (ackEntries.length > maxAckRecords) ackEntries.shift();
  }

  function recordAckState(
    tenantId: string,
    revision: number,
    state: AckState,
    tick: number,
    reason?: string,
  ): void {
    if (typeof tenantId !== "string" || tenantId.length === 0) return;
    if (!Number.isInteger(revision) || revision < 0) return;
    if (!Number.isInteger(tick) || tick < 0) return;

    const latestRevision = latestAckRevisionByTenant.get(tenantId) ?? -1;
    if (revision < latestRevision) return;

    const existingIdx = ackEntries.findIndex(
      (entry) => entry.tenantId === tenantId && entry.revision === revision,
    );
    const existing = existingIdx >= 0 ? ackEntries[existingIdx] : undefined;

    if (revision === latestRevision && existing !== undefined && existing.state !== "sent") {
      return;
    }

    if (revision > latestRevision) latestAckRevisionByTenant.set(tenantId, revision);

    const next: AckEntry = {
      tenantId,
      revision,
      state,
      tick,
      ...(reason !== undefined ? { reason } : {}),
    };
    if (existingIdx >= 0) ackEntries[existingIdx] = next;
    else ackEntries.push(next);
    trimAckRecords();
  }

  const runtime: SupervisorAllianceDirectorRuntime = {
    onMemberReport(report: AllianceMemberReport): void {
      if (typeof report.tenantId !== "string" || report.tenantId.length === 0) return;
      if (!Number.isInteger(report.tick) || report.tick < 0) return;
      if (!Number.isFinite(report.observedAtMs) || report.observedAtMs < 0) return;
      const existing = reports.get(report.tenantId);
      if (existing !== undefined && report.tick <= existing.tick) return; // deterministic first-wins on ties
      reports.set(report.tenantId, report);
    },

    onAck(
      tenantId: string,
      revision: number,
      status: AllianceAckStatus,
      tick: number,
      reason?: string,
    ): void {
      ackCount += 1;
      recordAckState(tenantId, revision, status, tick, reason);
    },

    replan(tick: number): void {
      if (!enabled) return;
      if (!Number.isInteger(tick) || tick < 0) return;
      lastReplanTick = tick;

      const fresh = freshReports(tick);
      if (fresh.size === 0) return;

      let raw: unknown;
      try {
        raw = director.replan(fresh, tick);
      } catch {
        directorErrorCount += 1;
        return;
      }
      if (!Array.isArray(raw)) {
        invalidOutputCount += 1;
        return;
      }

      const directives = [...raw]
        .filter(directiveRuntimeShape)
        .sort((a, b) => stableCompare(a.tenantId, b.tenantId) || a.revision - b.revision);
      invalidOutputCount += raw.length - directives.length;

      for (const directive of directives) {
        const validation = validateDirectiveForTenant(directive, directive.tenantId);
        if (!validation.valid) {
          invalidOutputCount += 1;
          recordAckState(
            directive.tenantId,
            directive.revision,
            "rejected",
            tick,
            `director produced invalid: ${validation.issues[0]?.message ?? "unknown"}`,
          );
          continue;
        }
        if (!fresh.has(directive.tenantId)) continue;

        try {
          callbacks.send(directive.tenantId, createDirectiveMessage(directive, tick));
          directiveSentCount += 1;
          recordAckState(directive.tenantId, directive.revision, "sent", tick);
        } catch {
          sendErrorCount += 1;
        }
      }
    },

    stats(): AllianceDirectorStats {
      return {
        reportCount: reports.size,
        directiveSentCount,
        ackCount,
        directorErrorCount,
        invalidOutputCount,
        sendErrorCount,
        lastReplanTick,
        enabled,
        memberTenants: sortedTenants(),
        ackRecords: ackEntries.map((entry) => ({ ...entry })),
      };
    },

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
  };

  return runtime;
}
