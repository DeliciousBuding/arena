import { randomUUID } from "node:crypto";
import { type DecisionCandidate } from "../domain/model.ts";
import { type CandidateEnvelope } from "./decision-types.ts";

export type DecisionLeaseStatus = "active" | "accepted" | "selected" | "expired" | "cancelled";
export type LeaseRejectionCode =
  | "lease_not_active"
  | "deadline_exceeded"
  | "protocol_mismatch"
  | "run_id_mismatch"
  | "tenant_mismatch"
  | "tick_mismatch"
  | "state_mismatch"
  | "plan_tick_mismatch"
  | "lease_not_found";

/**
 * submit 接受的候选：W4 新信封（CandidateEnvelope，runId/tenantId 必填）或旧 DecisionCandidate
 * （无 runId/tenantId——legacy 路径跳过对应校验，见 loop.ts）。
 */
export type LeaseCandidate = CandidateEnvelope | DecisionCandidate;

export type LeaseSubmission =
  | { readonly accepted: true; readonly candidate: LeaseCandidate }
  | { readonly accepted: false; readonly code: LeaseRejectionCode; readonly message: string };

export interface DecisionLeaseOptions {
  readonly tick: number;
  readonly stateHash: string;
  readonly deadlineAt: number;
  readonly runId?: string;
  readonly tenantId?: string;
  /** 可注入时钟（3A clock.ts 的 Clock 结构兼容；缺省 Date.now()）。 */
  readonly clock?: { readonly now: () => number };
}

/**
 * One immutable right to submit a candidate for one authoritative TickState.
 * Tool calls never mutate the game directly: they can only try to fulfill this lease.
 *
 * 状态机（W4）：active → accepted → selected（agent 候选被采纳）
 *              active → expired → selected（无候选时采纳 fallback 计划）
 *              active → cancelled（run 中止）
 * 已终结（selected/expired/cancelled）之后的所有提交一律拒绝——"旧 Tick 候选永不执行"。
 */
export class DecisionLease {
  readonly runId: string;
  readonly tenantId: string | null;
  readonly tick: number;
  readonly stateHash: string;
  readonly deadlineAt: number;

  private readonly clock: { readonly now: () => number };
  private currentStatus: DecisionLeaseStatus = "active";
  private acceptedCandidate: LeaseCandidate | null = null;

  constructor(options: DecisionLeaseOptions) {
    if (!Number.isInteger(options.tick) || options.tick < 1) {
      throw new Error(`invalid lease tick: ${options.tick}`);
    }
    if (!Number.isFinite(options.deadlineAt)) {
      throw new Error("deadlineAt must be finite");
    }
    this.tick = options.tick;
    this.stateHash = options.stateHash;
    this.deadlineAt = options.deadlineAt;
    this.runId = options.runId ?? randomUUID();
    this.tenantId = options.tenantId ?? null;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  get status(): DecisionLeaseStatus {
    return this.currentStatus;
  }

  get candidate(): LeaseCandidate | null {
    return this.acceptedCandidate;
  }

  /** 提交候选：只接受 active；校验 runId/tenantId/tick/stateHash/deadline。
   *  accepted 只表示收到合法候选，不表示最终执行（select() 才最终采纳）。
   */
  submit(candidate: LeaseCandidate, now?: number): LeaseSubmission {
    if (this.currentStatus !== "active") {
      return reject("lease_not_active", `lease is ${this.currentStatus}`);
    }
    if ((now ?? this.clock.now()) > this.deadlineAt) {
      this.currentStatus = "expired";
      return reject("deadline_exceeded", "candidate arrived after the lease deadline");
    }
    if (candidate.protocolVersion !== "1") {
      return reject("protocol_mismatch", `unsupported protocol ${String(candidate.protocolVersion)}`);
    }
    if ("runId" in candidate && candidate.runId !== this.runId) {
      return reject("run_id_mismatch", `candidate runId ${candidate.runId} does not match ${this.runId}`);
    }
    if (this.tenantId !== null && "tenantId" in candidate && candidate.tenantId !== this.tenantId) {
      return reject(
        "tenant_mismatch",
        `candidate tenant ${String(candidate.tenantId)} does not match ${this.tenantId}`,
      );
    }
    if (candidate.tick !== this.tick) {
      return reject("tick_mismatch", `candidate tick ${candidate.tick} does not match ${this.tick}`);
    }
    if (candidate.stateHash !== this.stateHash) {
      return reject("state_mismatch", "candidate was produced for another state snapshot");
    }
    if (candidate.plan.tick !== this.tick) {
      return reject("plan_tick_mismatch", `plan tick ${candidate.plan.tick} does not match ${this.tick}`);
    }
    this.acceptedCandidate = candidate;
    this.currentStatus = "accepted";
    return { accepted: true, candidate };
  }

  /** 终结为 expired：active/accepted → expired（此后所有提交拒绝）。
   *  仍受 deadline 门禁：now >= deadlineAt 才允许（先让 Lease 过期，再清理 Agent）。
   */
  expire(now?: number): boolean {
    if (this.currentStatus !== "active" && this.currentStatus !== "accepted") return false;
    if ((now ?? this.clock.now()) < this.deadlineAt) return false;
    this.currentStatus = "expired";
    return true;
  }

  /** 最终采纳：accepted → selected；expired → selected（无 agent 候选时采纳 fallback 计划）。 */
  select(): boolean {
    if (this.currentStatus !== "accepted" && this.currentStatus !== "expired") return false;
    this.currentStatus = "selected";
    return true;
  }

  cancel(): boolean {
    if (this.currentStatus !== "active") return false;
    this.currentStatus = "cancelled";
    return true;
  }
}

export function reject(code: LeaseRejectionCode, message: string): LeaseSubmission {
  return { accepted: false, code, message };
}
