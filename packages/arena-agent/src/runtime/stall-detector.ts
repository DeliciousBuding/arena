/**
 * StallDetector：疑似死循环/局部卡死的系统化多模式检测器。
 *
 * 背景（2026-08-05 生产事故）：t1 7000+ tick 经济停摆——全 worker patrol /
 * go_focus 远征、视野 0 资源、资源冻结 4、无法补员/产兵——但既有 stall 检测
 * 只覆盖 cargo_blocked（满载 Worker 滞留）一种模式，该场景 workerCargoTotal=0
 * 完全不匹配，0 条告警。检测盲区导致死循环只能靠人工发现。
 *
 * 本模块把"疑似卡死"做成多模式连续滑窗检测：每 tick 喂一条精简观测，任一模式
 * 连续命中阈值即发一条 stall 事件（rising-edge，达阈值只发一次，恢复后重新计数）。
 * 纯函数式状态机（无 IO），tenant-runtime 持有实例并负责落盘。
 */

export type StallKind =
  /** 满载 Worker 滞留无法卸货（delta=0 且满载 worker 位置指纹不变）。 */
  | "cargo_blocked"
  /** 有单位但 0 产出（delta=0 且无 harvest/deposit）——经济停摆总判据。 */
  | "no_production"
  /** 全部单位只巡逻/等待且 0 产出（无资源可采的探索僵局）。 */
  | "patrol_only"
  /** go_focus 远征：worker 被 focusRegion 支离 Core 且 0 产出。 */
  | "focus_exile"
  /** capacity_wait 占主导（容量互堵循环）。 */
  | "capacity_wait_loop";

export interface StallObservation {
  readonly tick: number;
  readonly coreResourceDelta: number;
  readonly workerCount: number;
  readonly workerCargoTotal: number;
  readonly workerMeanDistanceFromCore: number | undefined;
  readonly harvestCount: number;
  readonly depositCount: number;
  readonly moveCount: number;
  readonly waitCount: number;
  readonly intentCounts: Readonly<Record<string, number>>;
  /** 满载 worker 位置指纹（无满载 worker 时 null）；cargo_blocked 的移动判据。 */
  readonly cargoWorkerFingerprint: string | null;
}

export interface StallEvent {
  readonly kind: StallKind;
  readonly tick: number;
  readonly streak: number;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface StallDetectorOptions {
  /** 连续命中阈值（ticks），达到即发事件。默认 16（与历史 cargo_blocked 一致）。 */
  readonly thresholdTicks?: number;
  /** go_focus 远征判定：worker 平均离家距离下限（Chebyshev/Manhattan 语义同 outcome）。 */
  readonly exileDistance?: number;
  /** 慢速类检测（no_production/patrol_only/focus_exile/capacity_wait_loop）的
   *  开局宽限 tick：开局探索期（无资源可见、全巡逻）属正常，不报警。默认 256。 */
  readonly warmupTicks?: number;
}

export const DEFAULT_STALL_DETECTOR_OPTIONS: Required<StallDetectorOptions> = {
  thresholdTicks: 16,
  exileDistance: 24,
  warmupTicks: 256,
};

/** intent 计数取整（undefined 视为 0）。 */
function intentCount(counts: Readonly<Record<string, number>>, intent: string): number {
  return counts[intent] ?? 0;
}

/** patrol 家族意图（巡逻 + 巡逻 reroute + WAIT 占位）。 */
function patrolFamilyCount(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [intent, count] of Object.entries(counts)) {
    if (
      intent === "patrol" ||
      intent === "WAIT_UNCLAIMED" ||
      intent.startsWith("capacity_reroute:patrol") ||
      intent === "WAIT"
    ) {
      total += count;
    }
  }
  return total;
}

/** capacity_wait 家族意图计数（容量互堵循环判据）。 */
function capacityWaitCount(counts: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const [intent, count] of Object.entries(counts)) {
    if (intent.startsWith("capacity_wait:")) {
      total += count;
    }
  }
  return total;
}

export class StallDetector {
  private readonly thresholdTicks: number;
  private readonly exileDistance: number;
  private readonly warmupTicks: number;
  private streaks = new Map<StallKind, number>();
  private lastCargoFingerprint: string | null = null;

  constructor(options: StallDetectorOptions = {}) {
    const merged = { ...DEFAULT_STALL_DETECTOR_OPTIONS, ...options };
    this.thresholdTicks = merged.thresholdTicks;
    this.exileDistance = merged.exileDistance;
    this.warmupTicks = merged.warmupTicks;
  }

  /** 喂一 tick 观测；返回本 tick 新触发的事件（rising-edge，每 kind 达阈值只发一次）。 */
  onObservation(obs: StallObservation): readonly StallEvent[] {
    const hits = this.hits(obs);
    const events: StallEvent[] = [];
    for (const kind of STALL_KINDS) {
      const hit = hits[kind];
      const streak = hit ? (this.streaks.get(kind) ?? 0) + 1 : 0;
      this.streaks.set(kind, streak);
      if (hit && streak === this.thresholdTicks) {
        events.push({ kind, tick: obs.tick, streak, detail: this.detail(kind, obs) });
      }
    }
    return events;
  }

  /** 当前各模式连续命中计数（诊断/测试用）。 */
  currentStreaks(): ReadonlyMap<StallKind, number> {
    return new Map(this.streaks);
  }

  /** 本 tick 各模式命中判定。 */
  private hits(obs: StallObservation): Partial<Record<StallKind, boolean>> {
    const results: Partial<Record<StallKind, boolean>> = {};
    const cargoMoved = obs.cargoWorkerFingerprint !== null && obs.cargoWorkerFingerprint !== this.lastCargoFingerprint;
    if (obs.cargoWorkerFingerprint !== null) {
      this.lastCargoFingerprint = obs.cargoWorkerFingerprint;
    }
    results.cargo_blocked =
      obs.workerCargoTotal > 0 && obs.coreResourceDelta === 0 && !cargoMoved;

    if (obs.tick < this.warmupTicks) {
      return results;
    }
    const noProduction =
      obs.workerCount > 0 &&
      obs.coreResourceDelta === 0 &&
      obs.harvestCount === 0 &&
      obs.depositCount === 0;
    results.no_production = noProduction;
    results.patrol_only =
      noProduction &&
      obs.moveCount > 0 &&
      patrolFamilyCount(obs.intentCounts) >= obs.workerCount &&
      intentCount(obs.intentCounts, "go_focus") === 0;
    results.focus_exile =
      noProduction &&
      intentCount(obs.intentCounts, "go_focus") > 0 &&
      (obs.workerMeanDistanceFromCore ?? 0) >= this.exileDistance;
    results.capacity_wait_loop =
      noProduction &&
      obs.waitCount > 0 &&
      capacityWaitCount(obs.intentCounts) >= Math.ceil(obs.workerCount / 2);
    return results;
  }

  private detail(kind: StallKind, obs: StallObservation): Readonly<Record<string, unknown>> {
    switch (kind) {
      case "cargo_blocked":
        return {
          workerCargoTotal: obs.workerCargoTotal,
          cargoFingerprint: this.lastCargoFingerprint,
        };
      case "no_production":
        return {
          workerCount: obs.workerCount,
          coreResourceDelta: obs.coreResourceDelta,
          harvestCount: obs.harvestCount,
          depositCount: obs.depositCount,
        };
      case "patrol_only":
        return {
          workerCount: obs.workerCount,
          intentCounts: obs.intentCounts,
        };
      case "focus_exile":
        return {
          intentCounts: obs.intentCounts,
          workerMeanDistanceFromCore: obs.workerMeanDistanceFromCore,
          exileDistance: this.exileDistance,
        };
      case "capacity_wait_loop":
        return {
          waitCount: obs.waitCount,
          intentCounts: obs.intentCounts,
        };
    }
  }
}

const STALL_KINDS: readonly StallKind[] = [
  "cargo_blocked",
  "no_production",
  "patrol_only",
  "focus_exile",
  "capacity_wait_loop",
];
