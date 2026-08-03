/** S8b Runtime-Golden dataset integrity verifier and aggregate calibration gate. */

import type { PlayerState, ResolutionEvent } from "@arena/arena-hero-ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalIntegrityJson, sha256Canonical } from "../../domain/integrity.ts";
import { loadRulesManifest, manifestHash } from "../contracts/rules-manifest.ts";
import {
  runCalibrationCase,
  type CalibrationDifferenceClass,
  type CalibrationReport,
  type CalibrationStatus,
} from "./calibrate.ts";
import { parseCalibrationCase, type CalibrationCaseV1 } from "./schema.ts";

export const RUNTIME_GOLDEN_CALIBRATION_REPORT_SCHEMA =
  "runtime-golden-calibration-report-v1" as const;

const DIFFERENCE_CLASSES = new Set<CalibrationDifferenceClass>([
  "STATE", "ENTITY", "TERRAIN", "EVENT", "EXPECTED_UNKNOWN", "UNSUPPORTED",
]);

const SUPPORTED_DETERMINISTIC_EVENTS = new Set([
  "UNIT_MOVE_SUCCEEDED",
  "UNIT_MOVE_FAILED",
  "UNIT_SELF_DESTRUCTED",
  "WORKER_CARGO_DROPPED",
  "CORE_RESOURCE_OVERFLOW_DESTROYED",
  "UPKEEP_PAID",
  "UNIT_DAMAGED",
  "HARVEST_SUCCEEDED",
  "HARVEST_FAILED",
  "DEPOSIT_SUCCEEDED",
  "DEPOSIT_FAILED",
  "UNIT_HEAL_SUCCEEDED",
  "UNIT_HEAL_FAILED",
  "CORE_SPAWN_SUCCEEDED",
  "CORE_SPAWN_FAILED",
  "CORE_HEAL_SUCCEEDED",
  "CORE_HEAL_FAILED",
  "CORE_REPAIR_SUCCEEDED",
  "CORE_REPAIR_FAILED",
  "CORE_ACTION_FAILED",
]);

interface DatasetCaseEntry {
  readonly caseId: string;
  readonly tick: number;
  readonly file: string;
  readonly caseSha256: string;
  readonly beforeSha256: string;
  readonly planSha256: string;
  readonly afterSha256: string;
}

interface DatasetManifest {
  readonly schema: "runtime-golden-dataset-v1";
  readonly datasetId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly sourceCommit: string;
  readonly configHash: string;
  readonly caseCount: number;
  readonly errorCount: number;
  readonly cases: readonly DatasetCaseEntry[];
}

export interface RuntimeGoldenCaseSummary {
  readonly caseId: string;
  readonly tick: number;
  readonly status: CalibrationStatus;
  readonly differenceCount: number;
  readonly hardDifferenceCount: number;
  readonly unsupported: readonly string[];
  readonly unknownEffectCount: number;
  readonly knownEventMatched: number;
  readonly knownEventCompared: number;
}

export interface RuntimeGoldenCalibrationReport {
  readonly schema: typeof RUNTIME_GOLDEN_CALIBRATION_REPORT_SCHEMA;
  readonly datasetId: string;
  readonly tenantId: string;
  readonly rulesVersion: string;
  readonly rulesManifestHash: string;
  readonly sourceCommit: string;
  readonly configHash: string;
  readonly integrityVerified: true;
  readonly caseCount: number;
  readonly statusCounts: Readonly<Record<CalibrationStatus, number>>;
  readonly taxonomyCounts: Readonly<Record<CalibrationDifferenceClass, number>>;
  readonly unclassifiedDifferenceCount: number;
  readonly hardMismatchCaseCount: number;
  readonly knownEventMatched: number;
  readonly knownEventCompared: number;
  readonly knownEventAccuracy: number | null;
  readonly accuracyThreshold: 0.999;
  readonly accuracyGatePassed: boolean;
  readonly passed: boolean;
  readonly cases: readonly RuntimeGoldenCaseSummary[];
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
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} must be integer`);
  return value;
}

function hash(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(`${label} must be sha256 hex`);
  return parsed;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], label: string): void {
  const allowed = new Set(required);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in record)) throw new Error(`${label}.${key} is required`);
  }
}

function parseEntry(value: unknown, index: number): DatasetCaseEntry {
  const label = `manifest.cases[${index}]`;
  const raw = object(value, label);
  // receipt is integrity evidence for recorder but not needed by the offline comparator.
  exactKeys(
    raw,
    ["caseId", "tick", "file", "caseSha256", "beforeSha256", "planSha256", "afterSha256", "receipt"],
    label,
  );
  const file = string(raw.file, `${label}.file`);
  if (isAbsolute(file) || file.split(/[\\/]+/u).includes("..")) {
    throw new Error(`${label}.file must be a relative non-traversing path`);
  }
  object(raw.receipt, `${label}.receipt`);
  return {
    caseId: string(raw.caseId, `${label}.caseId`),
    tick: integer(raw.tick, `${label}.tick`),
    file,
    caseSha256: hash(raw.caseSha256, `${label}.caseSha256`),
    beforeSha256: hash(raw.beforeSha256, `${label}.beforeSha256`),
    planSha256: hash(raw.planSha256, `${label}.planSha256`),
    afterSha256: hash(raw.afterSha256, `${label}.afterSha256`),
  };
}

function parseManifest(value: unknown): DatasetManifest {
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
  if (raw.schema !== "runtime-golden-dataset-v1") throw new Error("unsupported dataset schema");
  if (!Array.isArray(raw.cases)) throw new Error("manifest.cases must be an array");
  if (!Array.isArray(raw.errors)) throw new Error("manifest.errors must be an array");
  const entries = raw.cases.map(parseEntry);
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
    schema: "runtime-golden-dataset-v1",
    datasetId: string(raw.datasetId, "manifest.datasetId"),
    tenantId: string(raw.tenantId, "manifest.tenantId"),
    rulesVersion: string(raw.rulesVersion, "manifest.rulesVersion"),
    sourceCommit,
    configHash,
    caseCount,
    errorCount,
    cases: entries,
  };
}

function controlledIds(state: PlayerState): Set<string> {
  const ids = new Set<string>();
  for (const entry of state.objects) {
    if ((entry.kind === "CORE" || entry.kind === "UNIT") && entry.controlled) ids.add(entry.id);
  }
  return ids;
}

function normalizedEvent(event: ResolutionEvent): string {
  const spawn = event.event_type === "CORE_SPAWN_SUCCEEDED";
  return canonicalIntegrityJson({
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
    if (event.actor_id === null || !ids.has(event.actor_id)) continue;
    const signature = normalizedEvent(event);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function eventAccuracy(
  calibrationCase: CalibrationCaseV1,
  report: CalibrationReport,
): { readonly matched: number; readonly compared: number } {
  if (report.predictedState === null || report.unsupported.length > 0) return { matched: 0, compared: 0 };
  const ids = controlledIds(calibrationCase.before.state);
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

function casePath(manifestPath: string, file: string): string {
  const root = resolve(dirname(manifestPath));
  const candidate = resolve(root, file);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`case path escapes dataset: ${file}`);
  }
  if (!existsSync(candidate)) throw new Error(`case file missing: ${file}`);
  return candidate;
}

export function runCalibrationDataset(
  manifestPath: string,
  rulesPath: string,
): RuntimeGoldenCalibrationReport {
  const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = parseManifest(rawManifest);
  const rules = loadRulesManifest(rulesPath);
  if (manifest.rulesVersion !== rules.rulesVersion) {
    throw new Error(`stale rules: dataset=${manifest.rulesVersion}, manifest=${rules.rulesVersion}`);
  }

  const statusCounts: Record<CalibrationStatus, number> = { MATCH: 0, MISMATCH: 0, INCONCLUSIVE: 0 };
  const taxonomyCounts: Record<CalibrationDifferenceClass, number> = {
    STATE: 0, ENTITY: 0, TERRAIN: 0, EVENT: 0, EXPECTED_UNKNOWN: 0, UNSUPPORTED: 0,
  };
  const summaries: RuntimeGoldenCaseSummary[] = [];
  let unclassifiedDifferenceCount = 0;
  let hardMismatchCaseCount = 0;
  let knownEventMatched = 0;
  let knownEventCompared = 0;

  for (const entry of manifest.cases) {
    const path = casePath(manifestPath, entry.file);
    const rawCase = JSON.parse(readFileSync(path, "utf8"));
    const calibrationCase = parseCalibrationCase(rawCase);
    if (calibrationCase.caseId !== entry.caseId) throw new Error(`caseId mismatch at ${entry.file}`);
    if (calibrationCase.before.tick !== entry.tick) throw new Error(`tick mismatch at ${entry.file}`);
    if (calibrationCase.tenantId !== manifest.tenantId) throw new Error(`tenant mismatch at ${entry.file}`);
    if (sha256Canonical(rawCase) !== entry.caseSha256) throw new Error(`case hash mismatch at ${entry.file}`);
    if (sha256Canonical(calibrationCase.before) !== entry.beforeSha256) throw new Error(`before hash mismatch at ${entry.file}`);
    if (sha256Canonical(calibrationCase.plan) !== entry.planSha256) throw new Error(`plan hash mismatch at ${entry.file}`);
    if (sha256Canonical(calibrationCase.after) !== entry.afterSha256) throw new Error(`after hash mismatch at ${entry.file}`);

    const report = runCalibrationCase(calibrationCase, rulesPath);
    statusCounts[report.status] += 1;
    let hardDifferenceCount = 0;
    for (const difference of report.differences) {
      if (!DIFFERENCE_CLASSES.has(difference.class)) {
        unclassifiedDifferenceCount += 1;
        continue;
      }
      taxonomyCounts[difference.class] += 1;
      if (difference.class !== "EXPECTED_UNKNOWN" && difference.class !== "UNSUPPORTED") {
        hardDifferenceCount += 1;
      }
    }
    if (hardDifferenceCount > 0) hardMismatchCaseCount += 1;
    const accuracy = eventAccuracy(calibrationCase, report);
    knownEventMatched += accuracy.matched;
    knownEventCompared += accuracy.compared;
    summaries.push({
      caseId: calibrationCase.caseId,
      tick: calibrationCase.before.tick,
      status: report.status,
      differenceCount: report.differences.length,
      hardDifferenceCount,
      unsupported: [...report.unsupported],
      unknownEffectCount: report.unknownEffects.length,
      knownEventMatched: accuracy.matched,
      knownEventCompared: accuracy.compared,
    });
  }

  const knownEventAccuracy = knownEventCompared === 0 ? null : knownEventMatched / knownEventCompared;
  const accuracyGatePassed = knownEventAccuracy !== null && knownEventAccuracy >= 0.999;
  const passed =
    hardMismatchCaseCount === 0 &&
    unclassifiedDifferenceCount === 0 &&
    accuracyGatePassed;
  return {
    schema: RUNTIME_GOLDEN_CALIBRATION_REPORT_SCHEMA,
    datasetId: manifest.datasetId,
    tenantId: manifest.tenantId,
    rulesVersion: manifest.rulesVersion,
    rulesManifestHash: manifestHash(rules),
    sourceCommit: manifest.sourceCommit,
    configHash: manifest.configHash,
    integrityVerified: true,
    caseCount: manifest.caseCount,
    statusCounts,
    taxonomyCounts,
    unclassifiedDifferenceCount,
    hardMismatchCaseCount,
    knownEventMatched,
    knownEventCompared,
    knownEventAccuracy,
    accuracyThreshold: 0.999,
    accuracyGatePassed,
    passed,
    cases: summaries,
  };
}
