import { randomUUID } from "node:crypto";
import { type DecisionCandidate } from "../domain/model.ts";

export type DecisionLeaseStatus = "active" | "accepted" | "expired" | "cancelled";
export type LeaseRejectionCode =
  | "lease_not_active"
  | "deadline_exceeded"
  | "protocol_mismatch"
  | "tick_mismatch"
  | "state_mismatch"
  | "plan_tick_mismatch";

export type LeaseSubmission =
  | { readonly accepted: true; readonly candidate: DecisionCandidate }
  | { readonly accepted: false; readonly code: LeaseRejectionCode; readonly message: string };

export interface DecisionLeaseOptions {
  readonly tick: number;
  readonly stateHash: string;
  readonly deadlineAt: number;
  readonly runId?: string;
}

/**
 * One immutable right to submit a candidate for one authoritative TickState.
 * Tool calls never mutate the game directly: they can only try to fulfill this lease.
 */
export class DecisionLease {
  readonly runId: string;
  readonly tick: number;
  readonly stateHash: string;
  readonly deadlineAt: number;

  private currentStatus: DecisionLeaseStatus = "active";
  private acceptedCandidate: DecisionCandidate | null = null;

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
  }

  get status(): DecisionLeaseStatus {
    return this.currentStatus;
  }

  get candidate(): DecisionCandidate | null {
    return this.acceptedCandidate;
  }

  submit(candidate: DecisionCandidate, now = Date.now()): LeaseSubmission {
    if (this.currentStatus !== "active") {
      return reject("lease_not_active", `lease is ${this.currentStatus}`);
    }
    if (now > this.deadlineAt) {
      this.currentStatus = "expired";
      return reject("deadline_exceeded", "candidate arrived after the lease deadline");
    }
    if (candidate.protocolVersion !== "1") {
      return reject("protocol_mismatch", `unsupported protocol ${String(candidate.protocolVersion)}`);
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

  expire(now = Date.now()): boolean {
    if (this.currentStatus !== "active") return false;
    if (now < this.deadlineAt) return false;
    this.currentStatus = "expired";
    return true;
  }

  cancel(): boolean {
    if (this.currentStatus !== "active") return false;
    this.currentStatus = "cancelled";
    return true;
  }
}

function reject(code: LeaseRejectionCode, message: string): LeaseSubmission {
  return { accepted: false, code, message };
}
