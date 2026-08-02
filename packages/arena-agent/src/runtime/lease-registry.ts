import { DecisionLease, reject, type DecisionLeaseStatus, type LeaseCandidate, type LeaseSubmission } from "./decision-lease.ts";

export interface LeaseRegistryOptions {
  /** 已终结 lease 保留上限（默认 1000，可配置），超出丢弃最旧的。 */
  readonly maxTerminated?: number;
}

export interface LeaseRegistryStats {
  readonly active: number;
  readonly accepted: number;
  readonly selected: number;
  readonly expired: number;
  readonly cancelled: number;
  /** 当前 registry 占位（活跃 + 已终结保留区），有界。 */
  readonly total: number;
}

/**
 * 以 runId 精确索引的 Lease 注册表——旧 run 的迟到工具调用永远不能命中新 Tick 的 Lease。
 *
 * - 查找严格按 runId（精确索引）：未注册/已被清理的 runId → lease_not_found。
 * - 有界清理：终结（expire/cancel/select）须经 registry；保留最近 maxTerminated 个
 *   已终结 lease，超出丢弃最旧的——"10 万个模拟 Lease 后 registry 大小回到常数级"。
 * - 活跃 lease 永不被清理（coordinator 必须还能路由到它们）。
 */
export class LeaseRegistry {
  private readonly leases = new Map<string, DecisionLease>();
  /** 已终结 runId 的 FIFO（去重），长度 ≤ maxTerminated。 */
  private readonly terminatedQueue: string[] = [];
  private readonly terminatedSet = new Set<string>();
  private readonly maxTerminated: number;

  constructor(options: LeaseRegistryOptions = {}) {
    const max = options.maxTerminated ?? 1000;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxTerminated must be a positive integer, got ${max}`);
    }
    this.maxTerminated = max;
  }

  /** 注册 lease；runId 重复 → false。 */
  register(lease: DecisionLease): boolean {
    if (this.leases.has(lease.runId)) return false;
    this.leases.set(lease.runId, lease);
    return true;
  }

  get(runId: string): DecisionLease | undefined {
    return this.leases.get(runId);
  }

  /** 按 runId 精确提交：未找到 → lease_not_found（旧 runId / 已清理 runId 一律拒绝）。 */
  submit(runId: string, candidate: LeaseCandidate): LeaseSubmission {
    const lease = this.leases.get(runId);
    if (!lease) {
      return reject("lease_not_found", `no lease registered for runId ${runId}`);
    }
    return lease.submit(candidate);
  }

  expire(runId: string, now?: number): boolean {
    const lease = this.leases.get(runId);
    if (!lease) return false;
    if (lease.expire(now)) {
      this.onTerminated(runId);
      return true;
    }
    return false;
  }

  select(runId: string): boolean {
    const lease = this.leases.get(runId);
    if (!lease) return false;
    if (lease.select()) {
      this.onTerminated(runId);
      return true;
    }
    return false;
  }

  cancel(runId: string): boolean {
    const lease = this.leases.get(runId);
    if (!lease) return false;
    if (lease.cancel()) {
      this.onTerminated(runId);
      return true;
    }
    return false;
  }

  stats(): LeaseRegistryStats {
    const counts: Record<DecisionLeaseStatus, number> = {
      active: 0,
      accepted: 0,
      selected: 0,
      expired: 0,
      cancelled: 0,
    };
    for (const lease of this.leases.values()) {
      counts[lease.status] += 1;
    }
    return { ...counts, total: this.leases.size };
  }

  private onTerminated(runId: string): void {
    if (this.terminatedSet.has(runId)) return;
    this.terminatedSet.add(runId);
    this.terminatedQueue.push(runId);
    while (this.terminatedQueue.length > this.maxTerminated) {
      const evicted = this.terminatedQueue.shift()!;
      this.terminatedSet.delete(evicted);
      this.leases.delete(evicted);
    }
  }
}
