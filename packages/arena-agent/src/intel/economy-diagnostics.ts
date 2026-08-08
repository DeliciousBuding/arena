/**
 * 经济健康诊断（2026-08-08）：outcome.jsonl 窗口分析纯函数。
 *
 * 停滞判定语义与 scripts/check-economy-stall.sh 对齐（bash 版 2026-08-08
 * t1/t2/t3 复盘后新增，本模块是其 TS 纯函数化 + 归因扩展）：
 *  - 满载 worker ≥2 持货且持续 0 卸货 → "假活"冻结；
 *  - 排除合法 0 卸货：容量满（CORE_RESOURCE_FULL）/ 迁移期（CORE_MOVING）/
 *    核心不在（CORE_NOT_PRESENT）。
 *
 * 归因（扩展）：核心迁移占比、卸货失败、采集失败、勘探扩散趋势——把"冻结"
 * 从布尔判定升级为可行动归因。只依赖 outcome 行结构，无副作用，可单测。
 */
export interface EconomyOutcomeRow {
  readonly tick: number;
  readonly coreResourcesBefore?: number;
  readonly coreResourcesAfter?: number;
  readonly coreResourceDelta?: number;
  readonly coreState?: string;
  readonly visibleResourceCellCount?: number;
  readonly workerCount?: number;
  readonly workersWithCargo?: number;
  readonly workerCargoTotal?: number;
  readonly workerMaxDistanceFromCore?: number;
  readonly workerMeanDistanceFromCore?: number;
  readonly events?: readonly string[];
  readonly failedEvents?: readonly unknown[];
}

export type EconomyHealthVerdict = "ok" | "stall" | "insufficient_data";

export interface EconomyHealthReport {
  readonly verdict: EconomyHealthVerdict;
  readonly tenant: string;
  readonly windowTicks: number;
  readonly rows: number;
  readonly firstTick: number | null;
  readonly lastTick: number | null;
  readonly resDeltaSum: number;
  readonly depositSucceeded: number;
  readonly depositFailed: number;
  readonly harvestSucceeded: number;
  readonly maxCargoWorkers: number;
  readonly coreMovingTicks: number;
  readonly coreMovingRatio: number;
  readonly maxDistFirst: number | null;
  readonly maxDistLast: number | null;
  readonly maxDistTrend: "flat" | "rising" | "falling" | "unknown";
  /** 归因列表（stall 时的可行动原因；ok 时可为空）。 */
  readonly causes: readonly string[];
}

/** outcome 事件名常量（与遥测 schema 对齐）。 */
export const OUTCOME_EVENTS = Object.freeze({
  depositSucceeded: "DEPOSIT_SUCCEEDED",
  depositFailed: "DEPOSIT_FAILED",
  harvestSucceeded: "HARVEST_SUCCEEDED",
  harvestFailed: "HARVEST_FAILED",
  coreResourceFull: "CORE_RESOURCE_FULL",
  coreMoving: "CORE_MOVING",
  coreNotPresent: "CORE_NOT_PRESENT",
  coreMoveStarted: "CORE_MOVE_STARTED",
} as const);

/** 窗口内无合法卸货豁免事件（容量满/迁移/核心不在）→ 判定生效。 */
const LEGAL_ZERO_DEPOSIT_EVENTS = new Set<string>([
  OUTCOME_EVENTS.coreResourceFull,
  OUTCOME_EVENTS.coreMoving,
  OUTCOME_EVENTS.coreNotPresent,
]);

/** 判定经济是否停滞 + 归因。窗口过小（<10 行）→ insufficient_data。 */
export function analyzeEconomyHealth(
  rows: readonly EconomyOutcomeRow[],
  tenant: string,
  windowTicks = 60,
): EconomyHealthReport {
  if (rows.length < 10) {
    return {
      verdict: "insufficient_data",
      tenant,
      windowTicks,
      rows: rows.length,
      firstTick: rows[0]?.tick ?? null,
      lastTick: rows[rows.length - 1]?.tick ?? null,
      resDeltaSum: 0,
      depositSucceeded: 0,
      depositFailed: 0,
      harvestSucceeded: 0,
      maxCargoWorkers: 0,
      coreMovingTicks: 0,
      coreMovingRatio: 0,
      maxDistFirst: null,
      maxDistLast: null,
      maxDistTrend: "unknown",
      causes: [],
    };
  }

  let resDeltaSum = 0;
  let depositSucceeded = 0;
  let depositFailed = 0;
  let harvestSucceeded = 0;
  let maxCargoWorkers = 0;
  let coreMovingTicks = 0;
  const maxDists: number[] = [];

  for (const row of rows) {
    resDeltaSum += row.coreResourceDelta ?? 0;
    depositSucceeded += countEvents(row.events, OUTCOME_EVENTS.depositSucceeded);
    depositFailed += countEvents(row.events, OUTCOME_EVENTS.depositFailed);
    harvestSucceeded += countEvents(row.events, OUTCOME_EVENTS.harvestSucceeded);
    maxCargoWorkers = Math.max(maxCargoWorkers, row.workersWithCargo ?? 0);
    if (row.coreState === "MOVING") coreMovingTicks += 1;
    if (typeof row.workerMaxDistanceFromCore === "number") {
      maxDists.push(row.workerMaxDistanceFromCore);
    }
  }

  const coreMovingRatio = coreMovingTicks / rows.length;
  const maxDistFirst = maxDists[0] ?? null;
  const maxDistLast = maxDists[maxDists.length - 1] ?? null;
  const maxDistTrend = maxDistTrendOf(maxDistFirst, maxDistLast);

  const causes: string[] = [];
  const legalZeroDeposit = rows.some((row) => (row.events ?? []).some((e) => LEGAL_ZERO_DEPOSIT_EVENTS.has(String(e))));
  const stalled = maxCargoWorkers >= 2
    && depositSucceeded === 0
    && resDeltaSum === 0
    && !legalZeroDeposit;

  if (stalled) {
    causes.push("满载 worker 持货但 0 卸货（cargo>=2、deposit=0、resDelta=0）");
    if (depositFailed > 0) causes.push(`DEPOSIT_FAILED ${depositFailed} 次（交仓通道受阻）`);
    if (coreMovingRatio >= 0.5) causes.push(`核心迁移占比 ${Math.round(coreMovingRatio * 100)}%（迁移期拒 DEPOSIT，需查迁移命令来源）`);
    if (maxDistTrend === "rising") causes.push(`worker 离核最远距离 ${maxDistFirst}→${maxDistLast} 持续外扩（勘探扩散但无采集进账）`);
    if (harvestSucceeded === 0) causes.push("窗口内零采集成功（可见矿不足或采集目标被门槛拦截）");
  } else if (coreMovingRatio >= 0.5) {
    causes.push(`核心迁移占比 ${Math.round(coreMovingRatio * 100)}%（迁移期：非停滞，但迁移过频需留意 goal/命令来源）`);
  }

  return {
    verdict: stalled ? "stall" : "ok",
    tenant,
    windowTicks,
    rows: rows.length,
    firstTick: rows[0]?.tick ?? null,
    lastTick: rows[rows.length - 1]?.tick ?? null,
    resDeltaSum,
    depositSucceeded,
    depositFailed,
    harvestSucceeded,
    maxCargoWorkers,
    coreMovingTicks,
    coreMovingRatio,
    maxDistFirst,
    maxDistLast,
    maxDistTrend,
    causes,
  };
}

function countEvents(events: readonly string[] | undefined, name: string): number {
  if (events === undefined || events.length === 0) return 0;
  return events.filter((event) => event === name).length;
}

function maxDistTrendOf(first: number | null, last: number | null): "flat" | "rising" | "falling" | "unknown" {
  if (first === null || last === null || first === last) return "unknown";
  const delta = last - first;
  if (Math.abs(delta) <= 2) return "flat";
  return delta > 0 ? "rising" : "falling";
}
