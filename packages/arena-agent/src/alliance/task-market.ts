/** Deterministic alliance task market.
 *
 * CBBA/auction inspired, but centrally cleared because the Supervisor already owns the
 * canonical AllianceSnapshot. Each READY tenant submits an implicit utility bid for each
 * global task; a Hungarian assignment clears the market globally so one tenant cannot
 * greedily take a task that another tenant can perform far more efficiently.
 *
 * Shadow/control-plane only: this module has no Arena Plan, token, submit or writer access.
 */
import { minimumCostAssignment } from "../algorithms/min-cost-assignment.ts";
import type { MissionKind } from "./control-types.ts";
import type { AllianceMemberState, Position } from "./types.ts";
import type { TenantThreatSummary } from "./threat-summary.ts";

export interface AllianceMarketTask {
  readonly id: string;
  readonly kind: Extract<MissionKind, "RAID" | "ESCORT">;
  readonly priority: number;
  readonly target: Position;
  readonly targetEntityKey?: string;
  readonly defendTenant?: string;
  readonly minMilitary: number;
  readonly maxDistance?: number;
}

export interface AllianceTaskBid {
  readonly tenantId: string;
  readonly taskId: string;
  readonly utility: number;
  readonly distance: number;
  readonly military: number;
  readonly threatPenalty: number;
  readonly treasuryPenalty: number;
  readonly eligible: boolean;
}

export interface AllianceMarketAssignment {
  readonly tenantId: string;
  readonly task: AllianceMarketTask;
  readonly bid: AllianceTaskBid;
}

export interface AllianceTaskMarketResult {
  readonly assignments: readonly AllianceMarketAssignment[];
  readonly bids: readonly AllianceTaskBid[];
}

function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function military(member: AllianceMemberState): number {
  return member.vanguards + member.rangers;
}

export function allianceTaskBid(
  member: AllianceMemberState,
  task: AllianceMarketTask,
  summary: TenantThreatSummary | undefined,
  treasuryTenant: string,
): AllianceTaskBid {
  const force = military(member);
  const distance = member.core === null ? Number.MAX_SAFE_INTEGER : manhattan(member.core.position, task.target);
  const eligible = member.status === "READY"
    && member.core !== null
    && force >= task.minMilitary
    && (task.maxDistance === undefined || distance <= task.maxDistance)
    && task.defendTenant !== member.tenantId; // local defense is handled before the market.
  const threatPenalty = Math.round((summary?.totalScore ?? member.localThreat) * 12_000) / 1_000;
  // Keep the treasury available for production unless it is materially the best executor.
  const treasuryPenalty = member.tenantId === treasuryTenant ? 18 : 0;
  const resourceBonus = Math.min(30, Math.max(0, member.resources)) * 0.15;
  const utility = eligible
    ? task.priority * 2 + force * 8 + resourceBonus - distance * 0.75 - threatPenalty - treasuryPenalty
    : -1_000_000;
  return {
    tenantId: member.tenantId,
    taskId: task.id,
    utility: Math.round(utility * 1_000) / 1_000,
    distance,
    military: force,
    threatPenalty,
    treasuryPenalty,
    eligible,
  };
}

/** Global one-to-one clearing. Unassigned tenants land on dummy columns and keep local policy. */
export function allocateAllianceTaskMarket(
  membersInput: readonly AllianceMemberState[],
  tasksInput: readonly AllianceMarketTask[],
  summaries: ReadonlyMap<string, TenantThreatSummary>,
  treasuryTenant: string,
): AllianceTaskMarketResult {
  const members = [...membersInput].sort((a, b) => stableCompare(a.tenantId, b.tenantId));
  const tasks = [...tasksInput].sort((a, b) => b.priority - a.priority || stableCompare(a.id, b.id));
  const bids = members.flatMap((member) => tasks.map((task) => allianceTaskBid(member, task, summaries.get(member.tenantId), treasuryTenant)));
  if (members.length === 0 || tasks.length === 0) return { assignments: [], bids };

  const bidByPair = new Map(bids.map((bid) => [`${bid.tenantId}\0${bid.taskId}`, bid] as const));
  // Real task cost = -utility. Dummy cost = 0, so non-positive/forbidden bids are naturally skipped.
  const matrix = members.map((member) => [
    ...tasks.map((task) => {
      const bid = bidByPair.get(`${member.tenantId}\0${task.id}`)!;
      return bid.eligible ? -bid.utility : 1_000_000;
    }),
    ...Array.from({ length: members.length }, () => 0),
  ]);
  const selected = minimumCostAssignment(matrix);
  const assignments: AllianceMarketAssignment[] = [];
  for (let row = 0; row < members.length; row += 1) {
    const column = selected[row]!;
    if (column >= tasks.length) continue;
    const member = members[row]!;
    const task = tasks[column]!;
    const bid = bidByPair.get(`${member.tenantId}\0${task.id}`)!;
    if (!bid.eligible || bid.utility <= 0) continue;
    assignments.push({ tenantId: member.tenantId, task, bid });
  }
  return {
    assignments: assignments.sort((a, b) => stableCompare(a.tenantId, b.tenantId)),
    bids: bids.sort((a, b) => stableCompare(a.tenantId, b.tenantId) || stableCompare(a.taskId, b.taskId)),
  };
}
