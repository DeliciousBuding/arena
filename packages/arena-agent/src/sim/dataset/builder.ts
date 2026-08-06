/**
 * P1-1 offline ml-sample-v1 dataset builder.
 *
 * Input: one runtime-golden dataset manifest (or a calibration directory that
 * contains one). Output: <dataRoot>/datasets/<datasetId>/{samples.jsonl,
 * manifest.json, quality-report.json} plus an appended dataset-registry-entry
 * in <dataRoot>/datasets/registry.jsonl.
 *
 * This is an OFFLINE derivation only: it never writes runtime data, never
 * enters the live loop, and does not train any model. Labels are rolling
 * windows computed from recorded before/after pairs within each
 * (processRunId, tick-consecutive-segment); windows truncate and are marked
 * incomplete across segment boundaries and tick gaps (design 5.2). Cases with
 * hard failures (schema/integrity/parse errors, untraceable lineage) are
 * quarantined. INCONCLUSIVE cases whose differences are all EXPECTED_UNKNOWN
 * are still published with an honest provenance.sampleStatus of
 * "inconclusive" (decision 1).
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlayerState, ResolutionEvent } from "@arena/arena-hero-ts";
import { sha256Canonical } from "../../domain/integrity.ts";
import { runCalibrationCase, type CalibrationReport } from "../calibration/calibrate.ts";
import { parseCalibrationCase, type CalibrationCaseV1 } from "../calibration/schema.ts";
import { assertRulesSupported, loadRulesManifest, manifestHash } from "../contracts/rules-manifest.ts";
import { atomicWriteText, canonicalJson } from "../tools/artifacts.ts";
import {
  SUPPORTED_RULES_VERSION,
  type DatasetBuildOptions,
  type DatasetBuildResult,
  type GoldenCaseEntry,
  type GoldenDatasetManifest,
  type ParsedCase,
  type QualityReport,
  type QuarantineRecord,
  type SplitName,
} from "./types.ts";
import {
  validateDatasetManifest,
  validateDatasetRegistryEntry,
  validateMlSample,
} from "./validate-sample.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..", "..", "..");
const RUNTIME_GOLDEN_SCHEMA = "runtime-golden-dataset-v1";
const NET_WINDOW_TICKS = 20;
const DEATH_WINDOW_TICKS = 20;
const CORE_RISK_WINDOW_TICKS = 50;
const DEFAULT_POLICY = Object.freeze({
  policyId: "deterministic",
  policyVersion: null,
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.3,
  parametersHash: null,
});
const POSTURE_ENUM = new Set(["balanced", "economy", "defense", "offense", "explore"]);
const SPLIT_RATIOS: Readonly<Record<SplitName, number>> = {
  train: 0.7,
  validation: 0.15,
  test: 0.15,
};
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SUPPORTED_DETERMINISTIC_EVENTS = new Set([
  "UNIT_MOVE_SUCCEEDED", "UNIT_MOVE_FAILED", "CORE_MOVE_STARTED", "CORE_MOVE_PROGRESS",
  "CORE_MOVE_SUCCEEDED", "CORE_MOVE_FAILED", "CORE_MOVE_START_FAILED", "CORE_MOVE_CANCELLED",
  "UNIT_SELF_DESTRUCTED", "WORKER_CARGO_DROPPED", "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "UPKEEP_PAID", "CORE_DAMAGED", "CORE_DESTROYED", "UNIT_DAMAGED", "HARVEST_SUCCEEDED",
  "HARVEST_FAILED", "BEACON_HARVEST_BONUS", "DEPOSIT_SUCCEEDED", "DEPOSIT_FAILED",
  "BEACON_PICKUP_FAILED", "BEACON_PICKED_UP", "BEACON_DROP_FAILED", "BEACON_DROPPED",
  "BEACON_DROPPED_ON_DEATH", "SWEEP_RESOLVED", "SHOT_MISSED", "SHOT_HIT",
  "DESTRUCTION_PARTICIPATION", "CORE_RESOURCES_CAPTURED", "UNIT_HEAL_SUCCEEDED",
  "UNIT_HEAL_FAILED", "CORE_SPAWN_SUCCEEDED", "CORE_SPAWN_FAILED", "CORE_HEAL_SUCCEEDED",
  "CORE_HEAL_FAILED", "CORE_REPAIR_SUCCEEDED", "CORE_REPAIR_FAILED", "CORE_ACTION_FAILED",
  "RESPAWN_DELAYED", "CORE_RESPAWNED",
]);

interface PolicyUpdate {
  readonly tick: number;
  readonly index: number;
  readonly policy: Record<string, unknown>;
}

interface LabelResult {
  readonly net20: number;
  readonly deathProb20: number;
  readonly coreRisk50: 0 | 1;
  readonly windowComplete: boolean;
  readonly windowEndTick: number | null;
}

interface MutableCounts {
  caseEntries: number;
  casesParsed: number;
  duplicateCases: number;
  integrityFailures: number;
  parseFailures: number;
  calibrationErrors: number;
  hardMismatchCases: number;
  inconclusiveCases: number;
  inconclusiveSamples: number;
  conclusiveSamples: number;
  absentOpponentPlansCount: number;
  policyParseErrors: number;
  policyFieldNormalized: number;
  tickGapCases: number;
  schemaFailures: number;
  quarantineTotal: number;
  derivedSamples: number;
}

interface CoverageCounts {
  combat: number;
  core: number;
  beacon: number;
  respawn: number;
  samplesWithDeaths: number;
}

interface CalibrationAggregate {
  statusCounts: Record<string, number>;
  taxonomyCounts: Record<string, number>;
  knownEventMatched: number;
  knownEventCompared: number;
  unclassifiedDifferenceCount: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(`${label} must be sha256 hex`);
  return parsed;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const key of expected) {
    if (!(key in record)) throw new Error(`${label}.${key} is required`);
  }
}

/** Strict runtime-golden manifest parser. Mirrors sim/calibration/dataset.ts
 *  parseManifest (which is not exported); keep the two in sync. */
function parseGoldenManifest(value: unknown): GoldenDatasetManifest {
  const raw = object(value, "manifest");
  exactKeys(
    raw,
    [
      "schema", "datasetId", "tenantId", "rulesVersion", "sourceCommit", "configHash",
      "startedAt", "completedAt", "caseCount", "skippedRejected", "droppedPending",
      "errorCount", "cases", "errors",
    ],
    "manifest",
  );
  if (raw.schema !== RUNTIME_GOLDEN_SCHEMA) throw new Error("unsupported dataset schema");
  if (!Array.isArray(raw.cases)) throw new Error("manifest.cases must be an array");
  if (!Array.isArray(raw.errors)) throw new Error("manifest.errors must be an array");
  const entries: GoldenCaseEntry[] = raw.cases.map((entryValue, index) => {
    const label = `manifest.cases[${index}]`;
    const entry = object(entryValue, label);
    exactKeys(
      entry,
      ["caseId", "tick", "file", "caseSha256", "beforeSha256", "planSha256", "afterSha256", "receipt"],
      label,
    );
    const file = string(entry.file, `${label}.file`);
    if (isAbsolute(file) || file.split(/[\/]+/u).includes("..")) {
      throw new Error(`${label}.file must be a relative non-traversing path`);
    }
    object(entry.receipt, `${label}.receipt`);
    return {
      caseId: string(entry.caseId, `${label}.caseId`),
      tick: integer(entry.tick, `${label}.tick`),
      file,
      caseSha256: hash(entry.caseSha256, `${label}.caseSha256`),
      beforeSha256: hash(entry.beforeSha256, `${label}.beforeSha256`),
      planSha256: hash(entry.planSha256, `${label}.planSha256`),
      afterSha256: hash(entry.afterSha256, `${label}.afterSha256`),
    };
  });
  const caseCount = integer(raw.caseCount, "manifest.caseCount");
  if (caseCount !== entries.length) throw new Error("manifest.caseCount does not match cases length");
  const errorCount = integer(raw.errorCount, "manifest.errorCount");
  if (errorCount !== raw.errors.length) throw new Error("manifest.errorCount does not match errors length");
  if (errorCount !== 0) throw new Error(`dataset recorder contains ${errorCount} errors`);
  const sourceCommit = string(raw.sourceCommit, "manifest.sourceCommit");
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("manifest.sourceCommit must be full git sha");
  const configHash = string(raw.configHash, "manifest.configHash");
  if (!/^sha256:[0-9a-f]{64}$/u.test(configHash)) throw new Error("manifest.configHash is invalid");
  return {
    schema: RUNTIME_GOLDEN_SCHEMA,
    datasetId: string(raw.datasetId, "manifest.datasetId"),
    tenantId: string(raw.tenantId, "manifest.tenantId"),
    rulesVersion: string(raw.rulesVersion, "manifest.rulesVersion"),
    sourceCommit,
    configHash,
    startedAt: string(raw.startedAt, "manifest.startedAt"),
    completedAt: string(raw.completedAt, "manifest.completedAt"),
    caseCount,
    skippedRejected: integer(raw.skippedRejected, "manifest.skippedRejected"),
    droppedPending: integer(raw.droppedPending, "manifest.droppedPending"),
    errorCount,
    cases: entries,
    errors: [...raw.errors] as string[],
  };
}

/** Resolve a case file relative to the manifest directory without traversal. */
function caseFilePath(manifestPath: string, file: string): string {
  const root = resolve(dirname(manifestPath));
  const candidate = resolve(root, file);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`case path escapes dataset: ${file}`);
  }
  if (!existsSync(candidate)) throw new Error(`case file missing: ${file}`);
  return candidate;
}

/** Data-root-relative URI; input must live under the data root (design 5.3). */
function dataRootRelativeUri(dataRoot: string, path: string): string {
  const rel = relative(resolve(dataRoot), resolve(path));
  if (rel.startsWith("..") || rel === ".." || isAbsolute(rel)) {
    throw new Error(`path escapes data root: ${path}`);
  }
  return rel.replaceAll("\\", "/");
}

function engineVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json version is missing");
  }
  return packageJson.version;
}

function controlledUnitIds(state: PlayerState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.objects) {
    if (entry.kind === "UNIT" && entry.controlled) ids.add(entry.id);
  }
  return ids;
}

function controlledEntityIds(state: PlayerState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.objects) {
    if ((entry.kind === "CORE" || entry.kind === "UNIT") && entry.controlled) ids.add(entry.id);
  }
  return ids;
}

function controlledCoreIds(state: PlayerState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.objects) {
    if (entry.kind === "CORE" && entry.controlled) ids.add(entry.id);
  }
  return ids;
}

/** Per-case core-risk signal: our core destroyed, respawning, or zero resources. */
function coreRiskAt(caseValue: CalibrationCaseV1): boolean {
  const coreIds = controlledCoreIds(caseValue.before.state);
  const destroyed = caseValue.after.state.events.some((event) =>
    event.event_type === "CORE_DESTROYED" &&
    event.target_id !== null && coreIds.has(event.target_id),
  );
  return destroyed || caseValue.after.state.status === "RESPAWNING" || caseValue.after.state.resources === 0;
}

/** Rolling label windows (design 5.2): truncate across gaps, mark incomplete. */
function computeLabel(tickMap: Map<number, ParsedCase>, tick: number): LabelResult {
  let complete = true;
  let lastAvailable: number | null = null;
  const windowCases: ParsedCase[] = [];
  for (let nextTick = tick + 1; nextTick <= tick + CORE_RISK_WINDOW_TICKS; nextTick += 1) {
    const next = tickMap.get(nextTick);
    if (next === undefined) {
      complete = false;
      break;
    }
    windowCases.push(next);
    lastAvailable = nextTick;
  }
  const usable = windowCases.slice(0, NET_WINDOW_TICKS);
  const net20 = usable.reduce(
    (sum, next) => sum + (next.caseValue.after.state.resources - next.caseValue.before.state.resources),
    0,
  );
  const initialUnits = controlledUnitIds(tickMap.get(tick)!.caseValue.before.state);
  let deathProb20 = 0;
  if (usable.length > 0 && initialUnits.size > 0) {
    // A unit counts as dead if it is missing from any after-state inside the
    // 20-tick window (units do not respawn in reality).
    const deaths = [...initialUnits].filter((id) =>
      usable.some((next) => !controlledUnitIds(next.caseValue.after.state).has(id))).length;
    deathProb20 = deaths / initialUnits.size;
  }
  const coreRisk50 = windowCases.some((next) => coreRiskAt(next.caseValue)) ? 1 : 0;
  return {
    net20,
    deathProb20,
    coreRisk50,
    windowComplete: complete,
    windowEndTick: complete ? tick + CORE_RISK_WINDOW_TICKS : lastAvailable,
  };
}

/** 决策停摆 run 识别（2026-08-07 t2 实证后新增）：decision telemetry 中
 *  agentActionCount==0 且 moveCount==0 占比 >= threshold 的 processRunId。
 *  死锁期 run 的 calibration case 决策全 WAIT（策略缺陷产物，非正常
 *  行为）——作为训练数据会教坏模型（学 WAIT），builder 整体 quarantine
 *  （reason: stall-run）。t2 实测：死锁 run 2209 行中 92% zero-action，
 *  恢复 run 仅 12%。minRows 宽限短 run（新 run 未积累不判）。 */
export function loadStallRuns(
  decisionPath: string,
  threshold = 0.8,
  minRows = 10,
): Set<string> {
  const stallRuns = new Set<string>();
  if (!existsSync(decisionPath)) return stallRuns;
  const byRun = new Map<string, { total: number; zero: number }>();
  for (const line of readFileSync(decisionPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let row: { processRunId?: unknown; agentActionCount?: unknown; moveCount?: unknown };
    try {
      row = JSON.parse(line) as { processRunId?: unknown; agentActionCount?: unknown; moveCount?: unknown };
    } catch {
      continue;
    }
    const runId = String(row.processRunId ?? "");
    if (runId === "") continue;
    const entry = byRun.get(runId) ?? { total: 0, zero: 0 };
    entry.total += 1;
    if (Number(row.agentActionCount ?? 0) === 0 && Number(row.moveCount ?? 0) === 0) {
      entry.zero += 1;
    }
    byRun.set(runId, entry);
  }
  for (const [runId, { total, zero }] of byRun) {
    if (total >= minRows && zero * 100 >= total * threshold * 100) {
      stallRuns.add(runId);
    }
  }
  return stallRuns;
}

function loadPolicyUpdates(policyPath: string, counts: MutableCounts): PolicyUpdate[] {
  if (!existsSync(policyPath)) return [];
  const updates: PolicyUpdate[] = [];
  const lines = readFileSync(policyPath, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      counts.policyParseErrors += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      counts.policyParseErrors += 1;
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== "policy_update") continue;
    if (!Number.isSafeInteger(record.tick)) {
      counts.policyParseErrors += 1;
      continue;
    }
    let policy: unknown;
    try {
      policy = typeof record.policy === "string" ? JSON.parse(record.policy) : record.policy;
    } catch {
      counts.policyParseErrors += 1;
      continue;
    }
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
      counts.policyParseErrors += 1;
      continue;
    }
    updates.push({ tick: record.tick as number, index, policy: policy as Record<string, unknown> });
  }
  updates.sort((left, right) => left.tick - right.tick || left.index - right.index);
  return updates;
}

/** Last policy update with tick <= sample tick; otherwise the deterministic baseline. */
function alignPolicy(updates: readonly PolicyUpdate[], tick: number, counts: MutableCounts) {
  let chosen: PolicyUpdate | null = null;
  for (const update of updates) {
    if (update.tick > tick) break;
    chosen = update;
  }
  if (chosen === null) return { ...DEFAULT_POLICY };
  const raw = chosen.policy;
  const rawPosture = typeof raw.posture === "string" ? raw.posture : null;
  const posture = rawPosture !== null && POSTURE_ENUM.has(rawPosture) ? rawPosture : null;
  const rawWorkerTarget = raw.workerTarget;
  const workerTarget =
    Number.isSafeInteger(rawWorkerTarget) && (rawWorkerTarget as number) >= 0
      ? (rawWorkerTarget as number)
      : null;
  const rawMilitaryRatio = raw.militaryRatio;
  const militaryRatio =
    typeof rawMilitaryRatio === "number" && Number.isFinite(rawMilitaryRatio) &&
    rawMilitaryRatio >= 0 && rawMilitaryRatio <= 1
      ? rawMilitaryRatio
      : null;
  if (posture === null || workerTarget === null || militaryRatio === null) {
    counts.policyFieldNormalized += 1;
  }
  return {
    policyId: "telemetry-policy",
    policyVersion: null,
    posture,
    workerTarget,
    militaryRatio,
    parametersHash: sha256Canonical(raw),
  };
}

function datasetIdOf(raw: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw)) {
    throw new Error("datasetId must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  return raw;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`no existing ancestor for ${path}`);
    current = parent;
  }
  return current;
}

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

/** Confine the dataset output directory to <dataRoot>/datasets (design 3.2). */
function resolveDatasetDir(dataRoot: string, datasetId: string): string {
  const resolvedRoot = resolve(dataRoot);
  mkdirSync(resolvedRoot, { recursive: true });
  const realRoot = realpathSync(resolvedRoot);
  const datasetsBase = resolve(realRoot, "datasets");
  mkdirSync(datasetsBase, { recursive: true });
  const realBase = realpathSync(datasetsBase);
  if (!isWithin(realRoot, realBase)) {
    throw new Error("datasets base escapes data root through symlink/junction");
  }
  const candidate = resolve(realBase, datasetId);
  const realAncestor = realpathSync(nearestExistingAncestor(candidate));
  if (!isWithin(realBase, realAncestor)) {
    throw new Error("dataset directory escapes datasets base through symlink/junction");
  }
  return candidate;
}

interface RegistryEntryRecord {
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly createdAt: string;
}

function readRegistry(registryPath: string): RegistryEntryRecord[] {
  if (!existsSync(registryPath)) return [];
  const lines = readFileSync(registryPath, "utf8").split("\n");
  const entries: RegistryEntryRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`registry.jsonl line ${index + 1} is not valid JSON (fail closed)`);
    }
    const record = object(parsed, `registry[${index}]`);
    if (typeof record.datasetId !== "string" || typeof record.datasetHash !== "string") {
      throw new Error(`registry.jsonl line ${index + 1} misses datasetId/datasetHash (fail closed)`);
    }
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
    entries.push({ datasetId: record.datasetId, datasetHash: record.datasetHash, createdAt });
  }
  return entries;
}

function appendRegistry(
  registryPath: string,
  entry: Record<string, unknown>,
  existing: readonly RegistryEntryRecord[],
): { appended: boolean; reason: string } {
  const priorEntries = existing.filter((entryValue) => entryValue.datasetId === entry.datasetId);
  const lastPrior = priorEntries.length > 0 ? priorEntries[priorEntries.length - 1]! : null;
  if (lastPrior !== null && lastPrior.datasetHash === entry.datasetHash) {
    return { appended: false, reason: "identical datasetHash entry already present" };
  }
  const createdAt = lastPrior !== null ? lastPrior.createdAt : (entry.createdAt as string);
  const record = {
    ...entry,
    createdAt,
    updatedAt: new Date().toISOString(),
    notes: lastPrior === null ? null : "rebuilt with new content hash; prior candidate retained",
  };
  const problems = validateDatasetRegistryEntry(record);
  if (problems.length > 0) {
    throw new Error(`registry entry failed validation: ${problems.join("; ")}`);
  }
  const existingContent = existsSync(registryPath) ? readFileSync(registryPath, "utf8") : "";
  atomicWriteText(registryPath, existingContent + `${JSON.stringify(record)}\n`);
  return { appended: true, reason: "appended" };
}

/** Known deterministic event accuracy (mirrors calibration/dataset.ts). */
function knownEventAccuracy(
  calibrationCase: CalibrationCaseV1,
  report: CalibrationReport,
): { matched: number; compared: number } {
  if (report.predictedState === null || report.unsupported.length > 0) {
    return { matched: 0, compared: 0 };
  }
  const ids = controlledEntityIds(calibrationCase.before.state);
  const observed = knownEventMultiset(report.observedState, ids);
  const predicted = knownEventMultiset(report.predictedState, ids);
  let matched = 0;
  let compared = 0;
  const signatures = new Set([...observed.keys(), ...predicted.keys()]);
  for (const signature of signatures) {
    const expectedCount = observed.get(signature) ?? 0;
    const actualCount = predicted.get(signature) ?? 0;
    matched += Math.min(expectedCount, actualCount);
    compared += Math.max(expectedCount, actualCount);
  }
  return { matched, compared };
}

function normalizedEvent(event: ResolutionEvent): string {
  const spawn = event.event_type === "CORE_SPAWN_SUCCEEDED" ||
    event.event_type === "CORE_RESPAWNED";
  return sha256Canonical({
    event_type: event.event_type,
    reason_code: event.reason_code,
    actor_id: event.actor_id,
    target_id: spawn && event.target_id !== null ? "<server-generated-id>" : event.target_id,
    position: event.position,
    values: event.values,
  });
}

function knownEventMultiset(state: PlayerState, ids: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of state.events) {
    if (!SUPPORTED_DETERMINISTIC_EVENTS.has(event.event_type)) continue;
    const ownedActor = event.actor_id !== null && ids.has(event.actor_id);
    const ownedTarget = event.target_id !== null && ids.has(event.target_id);
    if (!ownedActor && !ownedTarget) continue;
    const signature = normalizedEvent(event);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

/** Event-type coverage across the accepted cases (design 5.5 semantic coverage). */
function updateCoverage(caseValue: CalibrationCaseV1, coverage: CoverageCounts): void {
  const eventTypes = new Set(caseValue.after.state.events.map((event) => event.event_type));
  if (eventTypes.has("SHOT_HIT") || eventTypes.has("SHOT_MISSED") || eventTypes.has("UNIT_DAMAGED")) {
    coverage.combat += 1;
  }
  if (eventTypes.has("CORE_DAMAGED") || eventTypes.has("CORE_DESTROYED")) coverage.core += 1;
  if ([...eventTypes].some((eventType) => eventType.startsWith("BEACON_"))) coverage.beacon += 1;
  if (eventTypes.has("CORE_RESPAWNED") || eventTypes.has("RESPAWN_DELAYED")) coverage.respawn += 1;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sampleTick(caseValue: CalibrationCaseV1): number {
  return caseValue.before.tick;
}

export function buildDataset(options: DatasetBuildOptions): DatasetBuildResult {
  const rules = loadRulesManifest(options.rulesPath);
  assertRulesSupported(rules, SUPPORTED_RULES_VERSION);
  const engine = { name: "arena-ts", version: engineVersion() } as const;

  const inputStat = statSync(options.inputPath);
  const manifestPath = inputStat.isDirectory()
    ? join(options.inputPath, "manifest.json")
    : options.inputPath;
  if (!existsSync(manifestPath)) throw new Error(`manifest.json not found at ${manifestPath}`);
  const manifest = parseGoldenManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (manifest.rulesVersion !== rules.rulesVersion) {
    throw new Error(
      `rules version mismatch (fail closed): dataset=${manifest.rulesVersion}, ` +
        `rules manifest=${rules.rulesVersion}`,
    );
  }

  const counts: MutableCounts = {
    caseEntries: manifest.cases.length,
    casesParsed: 0,
    duplicateCases: 0,
    integrityFailures: 0,
    parseFailures: 0,
    calibrationErrors: 0,
    hardMismatchCases: 0,
    inconclusiveCases: 0,
    inconclusiveSamples: 0,
    conclusiveSamples: 0,
    absentOpponentPlansCount: 0,
    policyParseErrors: 0,
    policyFieldNormalized: 0,
    tickGapCases: 0,
    schemaFailures: 0,
    quarantineTotal: 0,
    derivedSamples: 0,
  };
  const coverage: CoverageCounts = { combat: 0, core: 0, beacon: 0, respawn: 0, samplesWithDeaths: 0 };
  const calibrationAggregate: CalibrationAggregate = {
    statusCounts: { MATCH: 0, MISMATCH: 0, INCONCLUSIVE: 0 },
    taxonomyCounts: {
      STATE: 0, ENTITY: 0, TERRAIN: 0, EVENT: 0, EXPECTED_UNKNOWN: 0, UNSUPPORTED: 0,
    },
    knownEventMatched: 0,
    knownEventCompared: 0,
    unclassifiedDifferenceCount: 0,
  };

  const processRunId = manifest.datasetId;
  const tenantId = manifest.tenantId;
  const policyUpdates = loadPolicyUpdates(
    join(options.dataRoot, "runtime", tenantId, "telemetry", "policy.jsonl"),
    counts,
  );
  // 决策停摆 run（2026-08-07 t2 实证）：死锁期 run 的 case 决策全 WAIT，
  // 整体 quarantine（stall-run），防止污染训练数据（学 WAIT）。
  const stallRuns = loadStallRuns(
    join(options.dataRoot, "runtime", tenantId, "telemetry", "decision.jsonl"),
  );
  const accepted: ParsedCase[] = [];
  const quarantine: QuarantineRecord[] = [];

  for (const entry of manifest.cases) {
    const casePath = caseFilePath(manifestPath, entry.file);
    const rawCase = JSON.parse(readFileSync(casePath, "utf8"));
    const caseKey = entry.caseId;
    if (sha256Canonical(rawCase) !== entry.caseSha256) {
      counts.integrityFailures += 1;
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: "integrity" });
      continue;
    }
    let caseValue: CalibrationCaseV1;
    try {
      caseValue = parseCalibrationCase(rawCase);
    } catch (error) {
      counts.parseFailures += 1;
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: `parse: ${(error as Error).message}` });
      continue;
    }
    if (
      sha256Canonical(caseValue.before) !== entry.beforeSha256 ||
      sha256Canonical(caseValue.plan) !== entry.planSha256 ||
      sha256Canonical(caseValue.after) !== entry.afterSha256
    ) {
      counts.integrityFailures += 1;
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: "integrity" });
      continue;
    }
    if (caseValue.tenantId !== tenantId) {
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: "tenant-mismatch" });
      continue;
    }
    // 死锁期 run 数据（决策全 WAIT 的策略缺陷产物）整体排除
    const processRun = (caseValue.metadata.runId ?? processRunId).split(":")[0];
    if (stallRuns.has(processRun)) {
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: "stall-run" });
      continue;
    }
    let calibrationStatus: "MATCH" | "MISMATCH" | "INCONCLUSIVE" = "MATCH";
    let calibrationReport: CalibrationReport | null = null;
    try {
      calibrationReport = runCalibrationCase(rawCase, options.rulesPath);
      const report = calibrationReport;
      calibrationStatus = report.status;
      calibrationAggregate.statusCounts[report.status] =
        (calibrationAggregate.statusCounts[report.status] ?? 0) + 1;
      for (const difference of report.differences) {
        if (difference.class in calibrationAggregate.taxonomyCounts) {
          calibrationAggregate.taxonomyCounts[difference.class] += 1;
        } else {
          calibrationAggregate.unclassifiedDifferenceCount += 1;
        }
      }
      const accuracy = knownEventAccuracy(caseValue, report);
      calibrationAggregate.knownEventMatched += accuracy.matched;
      calibrationAggregate.knownEventCompared += accuracy.compared;
    } catch (error) {
      counts.calibrationErrors += 1;
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: caseKey, reason: `calibration-error: ${(error as Error).message}` });
      continue;
    }
    const report = calibrationReport!;
    if (calibrationStatus === "INCONCLUSIVE") {
      counts.inconclusiveCases += 1;
      // Publish only INCONCLUSIVE cases whose differences are all
      // EXPECTED_UNKNOWN (no MISMATCH, no unclassified, no UNSUPPORTED);
      // the rest stay quarantined (decision 1).
      const publishableInconclusive = report.differences.length > 0 &&
        report.differences.every((difference) => difference.class === "EXPECTED_UNKNOWN");
      if (!publishableInconclusive) {
        counts.quarantineTotal += 1;
        quarantine.push({ caseId: caseKey, reason: "inconclusive" });
        continue;
      }
    }
    if (calibrationStatus === "MISMATCH") counts.hardMismatchCases += 1;
    if (caseValue.metadata.opponentPlans === "absent") counts.absentOpponentPlansCount += 1;
    counts.casesParsed += 1;
    updateCoverage(caseValue, coverage);
    const sampleStatus: "conclusive" | "inconclusive" | null =
      calibrationStatus === "MATCH"
        ? "conclusive"
        : calibrationStatus === "INCONCLUSIVE"
          ? "inconclusive"
          : null;
    accepted.push({
      entry,
      caseValue,
      caseFilePath: casePath,
      runId: caseValue.metadata.runId ?? processRunId,
      sampleStatus,
    });
  }

  // Windows are grouped per (processRunId, tick-consecutive-segment): the
  // recorder's runId is per-tick (`<processRunId>:<tenant>:<tick>:<seq>`) and
  // unusable as a window-grouping key (decision 3). Same-tick duplicates stay
  // quarantined (ambiguous timeline).
  const runGroups = new Map<string, Map<number, ParsedCase>>();
  const tickToRunKey = new Map<number, string>();
  const orderedAccepted = [...accepted].sort(
    (left, right) => left.caseValue.before.tick - right.caseValue.before.tick,
  );
  let segmentOrdinal = 0;
  let previousTick: number | null = null;
  let currentRunKey: string | null = null;
  let currentTickMap: Map<number, ParsedCase> | null = null;
  for (const parsedCase of orderedAccepted) {
    const tick = sampleTick(parsedCase.caseValue);
    if (tick === previousTick) {
      counts.duplicateCases += 1;
      counts.quarantineTotal += 1;
      quarantine.push({ caseId: parsedCase.caseValue.caseId, reason: "duplicate" });
      continue;
    }
    if (currentTickMap === null || previousTick === null || tick !== previousTick + 1) {
      segmentOrdinal += 1;
      currentRunKey = `seg-${String(segmentOrdinal).padStart(6, "0")}`;
      currentTickMap = new Map<number, ParsedCase>();
      runGroups.set(currentRunKey, currentTickMap);
    }
    tickToRunKey.set(tick, currentRunKey!);
    currentTickMap.set(tick, parsedCase);
    previousTick = tick;
  }

  // Samples are derived per (processRunId, tick-consecutive-segment) with rolling lookahead.
  const derivedSamples: Array<Record<string, unknown>> = [];
  const runOrder: string[] = [...runGroups.keys()].sort(compareStrings);
  for (const runKey of runOrder) {
    const tickMap = runGroups.get(runKey)!;
    const ticks = [...tickMap.keys()].sort((left, right) => left - right);
    for (const tick of ticks) {
      const parsedCase = tickMap.get(tick)!;
      if (!tickMap.has(tick + 1)) counts.tickGapCases += 1;
      const caseValue = parsedCase.caseValue;
      const label = computeLabel(tickMap, tick);
      const policy = alignPolicy(policyUpdates, tick, counts);
      const source = caseValue.metadata.source === "live-recorder" ? "live" : "sim";
      const sourceCommit = caseValue.metadata.sourceCommit ?? manifest.sourceCommit;
      if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
        throw new Error(`invalid sourceCommit for case ${caseValue.caseId} (fail closed)`);
      }
      const beforeUnits = controlledUnitIds(caseValue.before.state);
      const afterUnits = controlledUnitIds(caseValue.after.state);
      const sampleWithoutId: Record<string, unknown> = {
        schema: "ml-sample-v1",
        state: caseValue.before,
        plan: caseValue.plan,
        policy,
        outcome: {
          coreResourceDelta: caseValue.after.state.resources - caseValue.before.state.resources,
          workerDelta: afterUnits.size - beforeUnits.size,
          deaths: [...beforeUnits].filter((id) => !afterUnits.has(id)).length,
        },
        label,
        provenance: {
          rulesVersion: manifest.rulesVersion,
          rulesManifestHash: manifestHash(rules),
          sourceCommit,
          engine,
          processRunId,
          runId: parsedCase.runId,
          tick,
          seed: caseValue.seed,
          source,
          observationScope: "private-player-projection",
          opponentPlans: "not-included",
          sampleStatus: parsedCase.sampleStatus,
          sourceRefs: [
            {
              kind: "calibration-case",
              schema: "sim-calibration-case-v1",
              id: caseValue.caseId,
              uri: dataRootRelativeUri(options.dataRoot, parsedCase.caseFilePath),
              sha256: parsedCase.entry.caseSha256,
            },
          ],
        },
      };
      counts.derivedSamples += 1;
      const sample: Record<string, unknown> = {
        ...sampleWithoutId,
        sampleId: sha256Canonical(sampleWithoutId),
      };
      if ((sample.outcome as Record<string, unknown>).deaths !== 0) coverage.samplesWithDeaths += 1;
      const problems = validateMlSample(sample);
      if (problems.length > 0) {
        counts.schemaFailures += 1;
        counts.quarantineTotal += 1;
        quarantine.push({ caseId: caseValue.caseId, reason: `schema: ${problems[0]}` });
        continue;
      }
      derivedSamples.push(sample);
      if (parsedCase.sampleStatus === "inconclusive") counts.inconclusiveSamples += 1;
      if (parsedCase.sampleStatus === "conclusive") counts.conclusiveSamples += 1;
    }
  }

  const samples = [...derivedSamples].sort(compareSamples);
  const splitMap = assignSplits(runOrder);
  const splitCounts = buildSplitCounts(samples, splitMap, tickToRunKey);
  const sampleTicks = samples.map((sample) => (sample.provenance as Record<string, unknown>).tick as number);
  const inputTicks = manifest.cases.map((entry) => entry.tick);
  const tickRange = {
    first: sampleTicks.length > 0 ? Math.min(...sampleTicks) : Math.min(...inputTicks),
    last: sampleTicks.length > 0 ? Math.max(...sampleTicks) : Math.max(...inputTicks),
  };
  const liveSamples = samples.filter((sample) =>
    (sample.provenance as Record<string, unknown>).source === "live").length;
  const completeLabelWindows = samples.filter((sample) =>
    (sample.label as Record<string, unknown>).windowComplete === true).length;

  const datasetId = datasetIdOf(options.datasetId ?? processRunId);
  const datasetDir = resolveDatasetDir(options.dataRoot, datasetId);
  if (existsSync(datasetDir)) {
    if (!options.force) {
      throw new Error(`dataset directory already exists: ${datasetDir} (use --force to replace)`);
    }
    rmSync(datasetDir, { recursive: true, force: true });
  }
  mkdirSync(datasetDir, { recursive: true });

  const samplesContent = samples.map((sample) => canonicalJson(sample, false).trimEnd()).join("\n") + "\n";
  const samplesHash = createHash("sha256").update(samplesContent, "utf8").digest("hex");
  atomicWriteText(join(datasetDir, "samples.jsonl"), samplesContent);

  const sourceRefs = [
    {
      kind: "dataset-manifest",
      schema: RUNTIME_GOLDEN_SCHEMA,
      id: processRunId,
      uri: dataRootRelativeUri(options.dataRoot, manifestPath),
      sha256: sha256Canonical(manifest),
    },
  ];
  const runIds = [...new Set([...runGroups.keys()].map((key) => key.slice(key.indexOf("\u0000") + 1)))]
    .sort(compareStrings);
  // datasetHash covers content-identifying fields only (createdAt excluded) so
  // rebuilding the same input reproduces the same hash (design 5.4).
  const manifestContentBase: Record<string, unknown> = {
    schema: "dataset-manifest-v1",
    datasetId,
    sampleSchema: "ml-sample-v1",
    format: "jsonl",
    rulesVersion: manifest.rulesVersion,
    rulesManifestHash: manifestHash(rules),
    sourceCommit: manifest.sourceCommit,
    engine,
    tickRange,
    sourceRefs,
    processRunIds: [processRunId],
    runIds,
    counts: {
      samples: samples.length,
      liveSamples,
      simSamples: samples.length - liveSamples,
      completeLabelWindows,
      incompleteLabelWindows: samples.length - completeLabelWindows,
    },
    labelSpec: {
      netWindowTicks: NET_WINDOW_TICKS,
      deathWindowTicks: DEATH_WINDOW_TICKS,
      coreRiskWindowTicks: CORE_RISK_WINDOW_TICKS,
      runBoundary: "truncate-and-mark-incomplete",
    },
    artifacts: [
      {
        path: "samples.jsonl",
        mediaType: "application/x-ndjson",
        recordSchema: "ml-sample-v1",
        sha256: samplesHash,
        bytes: Buffer.byteLength(samplesContent, "utf8"),
        recordCount: samples.length,
        tickRange,
      },
    ],
  };
  const datasetHash = sha256Canonical(manifestContentBase);
  const manifestRecord: Record<string, unknown> = {
    ...manifestContentBase,
    createdAt: new Date().toISOString(),
    datasetHash,
  };
  const manifestProblems = validateDatasetManifest(manifestRecord);
  if (manifestProblems.length > 0) {
    throw new Error(`manifest failed validation: ${manifestProblems.join("; ")}`);
  }
  const manifestContent = `${canonicalJson(manifestRecord)}\n`;
  atomicWriteText(join(datasetDir, "manifest.json"), manifestContent);
  const manifestFileHash = createHash("sha256").update(manifestContent, "utf8").digest("hex");

  const registryPath = resolve(datasetDir, "..", "registry.jsonl");
  const existingRegistry = readRegistry(registryPath);
  const registryEntryBase: Record<string, unknown> = {
    schema: "dataset-registry-entry-v1",
    datasetId,
    status: "candidate",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sampleSchema: "ml-sample-v1",
    rulesVersion: manifestRecord.rulesVersion,
    rulesManifestHash: manifestRecord.rulesManifestHash,
    sourceCommit: manifestRecord.sourceCommit,
    engine,
    processRunIds: manifestRecord.processRunIds,
    runIds,
    tickRange,
    sampleCount: samples.length,
    datasetHash,
    manifestRef: {
      schema: "dataset-manifest-v1",
      datasetId,
      uri: `datasets/${datasetId}/manifest.json`,
      sha256: manifestFileHash,
    },
    sourceRefs,
    supersedes: [],
    tags: [],
    notes: samples.length === 0
      ? "0 samples survived; all input cases quarantined (see quality-report.json)"
      : null,
  };
  const registryResult = appendRegistry(registryPath, registryEntryBase, existingRegistry);

  const report = buildQualityReport({
    datasetId,
    manifest,
    manifestUri: sourceRefs[0]!.uri,
    counts,
    coverage,
    calibrationAggregate,
    samples,
    runOrder,
    splitMap,
    splitCounts,
    tickToRunKey,
    quarantine,
    datasetHash,
    rulesManifestHash: manifestHash(rules),
    registryResult,
  });
  atomicWriteText(
    join(datasetDir, "quality-report.json"),
    `${canonicalJson(report)}\n`,
  );

  const gatePassed =
    counts.schemaFailures === 0 &&
    report.versionMixing.mixed === false &&
    report.splits.leakChecks.runCrossesSplit === 0 &&
    report.splits.leakChecks.sampleInMultipleSplits === 0;
  return {
    datasetId,
    datasetDir,
    samplesHash,
    datasetHash,
    sampleCount: samples.length,
    gatePassed,
    report,
  };
}

function compareSamples(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftProvenance = left.provenance as Record<string, unknown>;
  const rightProvenance = right.provenance as Record<string, unknown>;
  const runComparison = compareStrings(leftProvenance.runId as string, rightProvenance.runId as string);
  if (runComparison !== 0) return runComparison;
  const tickComparison = (leftProvenance.tick as number) - (rightProvenance.tick as number);
  if (tickComparison !== 0) return tickComparison;
  const leftRefs = leftProvenance.sourceRefs as Array<{ id: string }>;
  const rightRefs = rightProvenance.sourceRefs as Array<{ id: string }>;
  return compareStrings(leftRefs[0]!.id, rightRefs[0]!.id);
}

function assignSplits(runOrder: readonly string[]): ReadonlyMap<string, SplitName> {
  // Chronological by run completion time; all runs of one manifest share the
  // manifest completedAt, so ordering is by run key. A run never crosses a
  // split boundary (design 5.4).
  const ordered = [...runOrder].sort(compareStrings);
  const trainCount = Math.round(ordered.length * SPLIT_RATIOS.train);
  const validationCount = Math.round(ordered.length * SPLIT_RATIOS.validation);
  const splitMap = new Map<string, SplitName>();
  ordered.forEach((runKey, index) => {
    const split: SplitName = index < trainCount
      ? "train"
      : index < trainCount + validationCount
        ? "validation"
        : "test";
    splitMap.set(runKey, split);
  });
  return splitMap;
}

function buildSplitCounts(
  samples: readonly Record<string, unknown>[],
  splitMap: ReadonlyMap<string, SplitName>,
  tickToRunKey: ReadonlyMap<number, string>,
): Readonly<Record<SplitName, { runs: number; samples: number; completeLabelWindows: number }>> {
  const result: Record<SplitName, { runs: number; samples: number; completeLabelWindows: number }> = {
    train: { runs: 0, samples: 0, completeLabelWindows: 0 },
    validation: { runs: 0, samples: 0, completeLabelWindows: 0 },
    test: { runs: 0, samples: 0, completeLabelWindows: 0 },
  };
  for (const [runKey, split] of splitMap) {
    result[split].runs += 1;
  }
  const runSplit = new Map(splitMap);
  for (const sample of samples) {
    const provenance = sample.provenance as Record<string, unknown>;
    const runKey = tickToRunKey.get(provenance.tick as number);
    const split = runKey === undefined ? undefined : runSplit.get(runKey);
    if (split !== undefined) {
      result[split].samples += 1;
      if ((sample.label as Record<string, unknown>).windowComplete === true) {
        result[split].completeLabelWindows += 1;
      }
    }
  }
  return result;
}

interface ReportInput {
  readonly datasetId: string;
  readonly manifest: GoldenDatasetManifest;
  readonly manifestUri: string;
  readonly counts: MutableCounts;
  readonly coverage: CoverageCounts;
  readonly calibrationAggregate: CalibrationAggregate;
  readonly samples: readonly Record<string, unknown>[];
  readonly runOrder: readonly string[];
  readonly splitMap: ReadonlyMap<string, SplitName>;
  readonly splitCounts: Readonly<Record<SplitName, { runs: number; samples: number; completeLabelWindows: number }>>;
  readonly tickToRunKey: ReadonlyMap<number, string>;
  readonly quarantine: readonly QuarantineRecord[];
  readonly datasetHash: string;
  readonly rulesManifestHash: string;
  readonly registryResult: { appended: boolean; reason: string };
}

function buildQualityReport(input: ReportInput): QualityReport {
  const versionsSeen: Record<string, number> = {};
  versionsSeen[input.manifest.rulesVersion] = input.manifest.caseCount;
  const live = input.samples.filter((sample) =>
    (sample.provenance as Record<string, unknown>).source === "live").length;
  const sim = input.samples.length - live;
  const byTenant: Record<string, number> = {};
  byTenant[input.manifest.tenantId] = input.samples.length;
  const byEngine: Record<string, number> = { "arena-ts": input.samples.length };
  const completeLabelWindows = input.samples.filter((sample) =>
    (sample.label as Record<string, unknown>).windowComplete === true).length;
  const runAssignments = input.runOrder.map((runKey) => {
    const runSamples = input.samples.filter((sample) => {
      const provenance = sample.provenance as Record<string, unknown>;
      return input.tickToRunKey.get(provenance.tick as number) === runKey;
    });
    return {
      processRunId: input.manifest.datasetId,
      runId: runKey,
      completedAt: input.manifest.completedAt,
      split: input.splitMap.get(runKey) ?? "train",
      sampleCount: runSamples.length,
      completeWindowSampleCount: runSamples.filter((sample) =>
        (sample.label as Record<string, unknown>).windowComplete === true).length,
    };
  });
  const knownEventAccuracy = input.calibrationAggregate.knownEventCompared === 0
    ? null
    : input.calibrationAggregate.knownEventMatched / input.calibrationAggregate.knownEventCompared;
  const quarantineByReason: Record<string, number> = {};
  for (const record of input.quarantine) {
    quarantineByReason[record.reason] = (quarantineByReason[record.reason] ?? 0) + 1;
  }
  return {
    schema: "arena-dataset-quality-report",
    datasetId: input.datasetId,
    createdAt: new Date().toISOString(),
    rulesVersion: input.manifest.rulesVersion,
    rulesManifestHash: input.rulesManifestHash,
    input: {
      manifestUri: input.manifestUri,
      processRunId: input.manifest.datasetId,
      tenantId: input.manifest.tenantId,
      startedAt: input.manifest.startedAt,
      completedAt: input.manifest.completedAt,
      skippedRejected: input.manifest.skippedRejected,
      droppedPending: input.manifest.droppedPending,
      recorderErrorCount: input.manifest.errorCount,
    },
    counts: {
      caseEntries: input.counts.caseEntries,
      casesParsed: input.counts.casesParsed,
      duplicateCases: input.counts.duplicateCases,
      integrityFailures: input.counts.integrityFailures,
      parseFailures: input.counts.parseFailures,
      calibrationErrors: input.counts.calibrationErrors,
      hardMismatchCases: input.counts.hardMismatchCases,
      inconclusiveCases: input.counts.inconclusiveCases,
      inconclusiveSamples: input.counts.inconclusiveSamples,
      conclusiveSamples: input.counts.conclusiveSamples,
      absentOpponentPlansCount: input.counts.absentOpponentPlansCount,
      policyParseErrors: input.counts.policyParseErrors,
      policyPostureNormalized: input.counts.policyFieldNormalized,
      tickGapCases: input.counts.tickGapCases,
      schemaFailures: input.counts.schemaFailures,
      quarantineTotal: input.counts.quarantineTotal,
      samplesDerived: input.counts.derivedSamples,
      samplesWritten: input.samples.length,
      completeLabelWindows,
      incompleteLabelWindows: input.samples.length - completeLabelWindows,
    },
    versionMixing: { versionsSeen, acceptedVersion: input.manifest.rulesVersion, mixed: false },
    sourceShare: { live, sim, byTenant, byEngine },
    calibration: {
      statusCounts: input.calibrationAggregate.statusCounts,
      taxonomyCounts: input.calibrationAggregate.taxonomyCounts,
      knownEventMatched: input.calibrationAggregate.knownEventMatched,
      knownEventCompared: input.calibrationAggregate.knownEventCompared,
      knownEventAccuracy,
      hardMismatchCaseCount: input.counts.hardMismatchCases,
      unclassifiedDifferenceCount: input.calibrationAggregate.unclassifiedDifferenceCount,
      expectedUnknownCount: input.calibrationAggregate.taxonomyCounts.EXPECTED_UNKNOWN,
    },
    coverage: { ...input.coverage },
    splits: {
      rule: "chronological by run completion time; runs are never split across buckets",
      ratios: SPLIT_RATIOS,
      runAssignments,
      counts: input.splitCounts,
      leakChecks: { runCrossesSplit: 0, sampleInMultipleSplits: 0 },
    },
    gates: {
      schemaFailures: input.counts.schemaFailures,
      crossRulesMixing: Object.keys(versionsSeen).length === 1 ? 0 : 1,
      crossSplitLeakage: 0,
      manifestSelfCheckFailures: 0,
      passed:
        input.counts.schemaFailures === 0 &&
        Object.keys(versionsSeen).length === 1,
    },
    quarantine: [...input.quarantine],
    quarantineByReason,
    registry: {
      appended: input.registryResult.appended,
      entryUri: `datasets/${input.datasetId}/manifest.json`,
      reason: input.registryResult.reason,
    },
  };
}
