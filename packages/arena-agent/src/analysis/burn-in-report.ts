import type {
  DecisionTraceRecord,
  FailedEventTrace,
  OutcomeTraceRecord,
  RuntimeTraceRecord,
} from "../telemetry/decision-trace.ts";

export interface BurnInThresholds {
  readonly expectedLiveTicks: number;
  readonly expectedStartupSyncTicks: number;
  readonly maxFailedActionRate: number;
  readonly maxWaitRatio: number;
  readonly maxSelectionP95Ms: number;
  readonly requirePositiveEconomy: boolean;
}

export const DEFAULT_BURN_IN_THRESHOLDS: BurnInThresholds = Object.freeze({
  expectedLiveTicks: 100,
  expectedStartupSyncTicks: 1,
  maxFailedActionRate: 0.01,
  maxWaitRatio: 0.02,
  maxSelectionP95Ms: 100,
  requirePositiveEconomy: true,
});

export interface BurnInGate {
  readonly name: string;
  readonly pass: boolean;
  readonly actual: number | string;
  readonly expected: string;
}

export interface BurnInReport {
  readonly processRunId: string;
  readonly observedTicks: number;
  readonly liveAttempts: number;
  readonly startupSyncTicks: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly repairTotal: number;
  readonly moveActions: number;
  readonly waitActions: number;
  readonly waitRatio: number;
  readonly failedEventCount: number;
  readonly failedActionRate: number;
  readonly failedReasonCounts: Readonly<Record<string, number>>;
  readonly harvestActions: number;
  readonly depositActions: number;
  readonly coreResourceDelta: number;
  readonly maxVisibleResourceCells: number;
  readonly meanUniqueWorkerCells: number;
  readonly maxWorkerDistanceFromCore: number;
  readonly selectionP95Ms: number;
  readonly decisionSources: readonly string[];
  readonly deadlineOutcomes: readonly string[];
  readonly gates: readonly BurnInGate[];
  readonly passed: boolean;
}

export function buildBurnInReport(
  processRunId: string,
  runtime: readonly RuntimeTraceRecord[],
  decisions: readonly DecisionTraceRecord[],
  outcomes: readonly OutcomeTraceRecord[],
  thresholds: BurnInThresholds = DEFAULT_BURN_IN_THRESHOLDS,
): BurnInReport {
  assertPositiveInteger(thresholds.expectedLiveTicks, "expectedLiveTicks");
  assertNonNegativeInteger(thresholds.expectedStartupSyncTicks, "expectedStartupSyncTicks");
  assertRatio(thresholds.maxFailedActionRate, "maxFailedActionRate");
  assertRatio(thresholds.maxWaitRatio, "maxWaitRatio");
  if (!Number.isFinite(thresholds.maxSelectionP95Ms) || thresholds.maxSelectionP95Ms < 0) {
    throw new Error(`maxSelectionP95Ms must be finite and non-negative: ${thresholds.maxSelectionP95Ms}`);
  }

  const accepted = runtime.filter((record) => record.submitResult === "accepted").length;
  const rejected = runtime.filter((record) => record.submitResult === "rejected").length;
  const liveAttempts = accepted + rejected;
  const startupSyncTicks = runtime.filter(
    (record) => record.submitResult === "not_submitted" && record.notSubmittedReason === "startup_sync",
  ).length;
  const repairTotal = sum(decisions.map((record) => record.repairCount));
  const moveActions = sum(decisions.map((record) => record.moveCount ?? 0));
  const waitActions = sum(decisions.map((record) => record.waitCount ?? 0));
  const totalUnitActions = sum(decisions.map((record) =>
    (record.moveCount ?? 0) +
    (record.harvestCount ?? 0) +
    (record.depositCount ?? 0) +
    (record.waitCount ?? 0),
  ));
  const waitRatio = ratio(waitActions, totalUnitActions);
  const failedEvents = outcomes.flatMap((record) => record.failedEvents ?? []);
  const failedEventCount = failedEvents.length;
  const resolvedActionEvents = outcomes.reduce(
    (total, record) => total + record.events.filter((event) => event.endsWith("_SUCCEEDED") || event.endsWith("_FAILED")).length,
    0,
  );
  const failedActionRate = ratio(failedEventCount, resolvedActionEvents);
  const failedReasonCounts = countFailureReasons(failedEvents);
  const harvestActions = sum(decisions.map((record) => record.harvestCount ?? 0));
  const depositActions = sum(decisions.map((record) => record.depositCount ?? 0));
  const coreResourceDelta = sum(outcomes.map((record) => record.coreResourceDelta));
  const maxVisibleResourceCells = max(outcomes.map((record) => record.visibleResourceCellCount ?? 0));
  const meanUniqueWorkerCells = mean(
    outcomes
      .map((record) => record.uniqueWorkerCellCount)
      .filter((value): value is number => value !== undefined),
  );
  const maxWorkerDistanceFromCore = max(outcomes.map((record) => record.workerMaxDistanceFromCore ?? 0));
  const selectionP95Ms = percentile(runtime.map((record) => record.selectionLatencyMs), 0.95);
  const decisionSources = uniqueSorted(decisions.map((record) => record.decisionSource));
  const deadlineOutcomes = uniqueSorted(runtime.map((record) => record.deadlineOutcome));

  const gates: BurnInGate[] = [
    gate("live_attempt_count", liveAttempts === thresholds.expectedLiveTicks, liveAttempts, `== ${thresholds.expectedLiveTicks}`),
    gate(
      "startup_sync_count",
      startupSyncTicks === thresholds.expectedStartupSyncTicks,
      startupSyncTicks,
      `== ${thresholds.expectedStartupSyncTicks}`,
    ),
    gate("all_live_submits_accepted", accepted === thresholds.expectedLiveTicks, accepted, `== ${thresholds.expectedLiveTicks}`),
    gate("no_submit_rejection", rejected === 0, rejected, "== 0"),
    gate("deterministic_source_only", decisionSources.length === 1 && decisionSources[0] === "deterministic", decisionSources.join(","), "deterministic"),
    gate("deadline_not_applicable_only", deadlineOutcomes.length === 1 && deadlineOutcomes[0] === "not_applicable", deadlineOutcomes.join(","), "not_applicable"),
    gate("no_plan_repair", repairTotal === 0, repairTotal, "== 0"),
    gate("no_cell_unit_limit", (failedReasonCounts.CELL_UNIT_LIMIT ?? 0) === 0, failedReasonCounts.CELL_UNIT_LIMIT ?? 0, "== 0"),
    gate("failed_action_rate", failedActionRate <= thresholds.maxFailedActionRate, round(failedActionRate), `<= ${thresholds.maxFailedActionRate}`),
    gate("wait_ratio", waitRatio <= thresholds.maxWaitRatio, round(waitRatio), `<= ${thresholds.maxWaitRatio}`),
    gate("selection_p95_ms", selectionP95Ms <= thresholds.maxSelectionP95Ms, round(selectionP95Ms), `<= ${thresholds.maxSelectionP95Ms}`),
  ];

  if (thresholds.requirePositiveEconomy) {
    gates.push(
      gate("harvest_observed", harvestActions > 0, harvestActions, "> 0"),
      gate("deposit_observed", depositActions > 0, depositActions, "> 0"),
      gate("positive_core_resource_delta", coreResourceDelta > 0, coreResourceDelta, "> 0"),
    );
  }

  return {
    processRunId,
    observedTicks: decisions.length,
    liveAttempts,
    startupSyncTicks,
    accepted,
    rejected,
    repairTotal,
    moveActions,
    waitActions,
    waitRatio: round(waitRatio),
    failedEventCount,
    failedActionRate: round(failedActionRate),
    failedReasonCounts,
    harvestActions,
    depositActions,
    coreResourceDelta,
    maxVisibleResourceCells,
    meanUniqueWorkerCells: round(meanUniqueWorkerCells),
    maxWorkerDistanceFromCore,
    selectionP95Ms: round(selectionP95Ms),
    decisionSources,
    deadlineOutcomes,
    gates,
    passed: gates.every((item) => item.pass),
  };
}

function countFailureReasons(events: readonly FailedEventTrace[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const key = event.reasonCode ?? "UNKNOWN";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function gate(name: string, pass: boolean, actual: number | string, expected: string): BurnInGate {
  return { name, pass, actual, expected };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function max(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer: ${value}`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer: ${value}`);
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be within [0,1]: ${value}`);
}
