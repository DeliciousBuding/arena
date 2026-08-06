/**
 * Strict record validators mirroring the shared JSON Schemas (2020-12,
 * additionalProperties:false). The schemas under data/schema/*.schema.json are
 * authoritative; these hand-rolled validators are the offline equivalent used
 * by the builder (ajv is not importable inside the sim isolation closure).
 *
 * For `state`/`plan` the ml-sample-v1 schema $refs the calibration case
 * observation/plan definitions, so deep validation reuses parseCalibrationCase
 * through a synthetic case shell instead of duplicating the player-state
 * parser.
 */

import { CALIBRATION_CASE_SCHEMA, parseCalibrationCase } from "../calibration/schema.ts";

const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const POSTURES = new Set(["balanced", "economy", "defense", "offense", "explore", null]);
const SOURCE_REF_KINDS = new Set([
  "calibration-case", "sim-record", "telemetry", "scenario", "policy", "dataset-manifest",
]);
const ENGINE_NAMES = new Set(["arena-ts", "arena-rs"]);
const REGISTRY_STATUSES = new Set(["candidate", "active", "deprecated", "quarantined"]);

interface ProblemCollector {
  errors: string[];
  push(path: string, message: string): void;
}

function collector(): ProblemCollector {
  return {
    errors: [],
    push(path, message) {
      this.errors.push(`${path} ${message}`);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Exact key set + required keys (additionalProperties:false semantics). */
function checkKeys(
  problems: ProblemCollector,
  path: string,
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(path, "must be an object");
    return false;
  }
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) problems.push(`${path}.${key}`, "is not allowed");
  }
  for (const key of expected) {
    if (!(key in value)) problems.push(`${path}.${key}`, "is required");
  }
  return true;
}

function checkSha256(problems: ProblemCollector, path: string, value: unknown): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    problems.push(path, "must match sha256 hex (optionally sha256: prefixed)");
  }
}

function checkUriReference(problems: ProblemCollector, path: string, value: unknown): void {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value)) {
    problems.push(path, "must be a uri-reference without whitespace or control characters");
  }
}

function checkSourceRef(problems: ProblemCollector, path: string, value: unknown): void {
  if (!checkKeys(problems, path, value, ["kind", "schema", "id", "uri", "sha256"])) return;
  if (!SOURCE_REF_KINDS.has(value.kind as string)) problems.push(`${path}.kind`, "has an unknown kind");
  if (value.schema !== null && !nonEmptyString(value.schema)) {
    problems.push(`${path}.schema`, "must be a non-empty string or null");
  }
  if (!nonEmptyString(value.id)) problems.push(`${path}.id`, "must be a non-empty string");
  checkUriReference(problems, `${path}.uri`, value.uri);
  checkSha256(problems, `${path}.sha256`, value.sha256);
}

function checkEngine(problems: ProblemCollector, path: string, value: unknown): void {
  if (!checkKeys(problems, path, value, ["name", "version"])) return;
  if (!ENGINE_NAMES.has(value.name as string)) problems.push(`${path}.name`, "has an unknown engine");
  if (!nonEmptyString(value.version)) problems.push(`${path}.version`, "must be a non-empty string");
}

function checkTickRange(problems: ProblemCollector, path: string, value: unknown): void {
  if (!checkKeys(problems, path, value, ["first", "last"])) return;
  if (!isInteger(value.first) || value.first < 1) problems.push(`${path}.first`, "must be an integer >= 1");
  if (!isInteger(value.last) || value.last < 1) problems.push(`${path}.last`, "must be an integer >= 1");
}

/** Deep-validate state/plan through the calibration case parser (schema $ref). */
function checkStateAndPlan(problems: ProblemCollector, state: unknown, plan: unknown): void {
  if (!isRecord(state) || !isRecord(plan)) {
    problems.push("state", "must be an object with tick and state");
    return;
  }
  if (!isInteger(state.tick) || state.tick < 1) {
    problems.push("state.tick", "must be an integer >= 1");
    return;
  }
  const shell = {
    schema: CALIBRATION_CASE_SCHEMA,
    caseId: "ml-sample-validation-shell",
    tenantId: "validation",
    rulesVersion: "v0.11",
    seed: 0,
    metadata: {
      source: "fixture",
      opponentPlans: "complete",
      recordedAt: null,
      sourceCommit: null,
      runId: null,
    },
    before: state,
    plan,
    after: { tick: (state.tick as number) + 1, state: state.state },
  };
  try {
    parseCalibrationCase(shell);
  } catch (error) {
    problems.push("state", `fails calibration-case validation: ${(error as Error).message}`);
  }
}

/** Validate an ml-sample-v1 row. Returns a list of problems (empty = valid). */
export function validateMlSample(value: unknown): readonly string[] {
  const problems = collector();
  if (!checkKeys(problems, "", value, [
    "schema", "sampleId", "state", "plan", "policy", "outcome", "label", "provenance",
  ])) {
    return problems.errors;
  }
  if (value.schema !== "ml-sample-v1") problems.push("schema", "must be ml-sample-v1");
  if (!nonEmptyString(value.sampleId)) problems.push("sampleId", "must be a non-empty string");

  checkStateAndPlan(problems, value.state, value.plan);

  const policy = value.policy;
  if (checkKeys(problems, "policy", policy, [
    "policyId", "policyVersion", "posture", "workerTarget", "militaryRatio", "parametersHash",
  ])) {
    if (!nonEmptyString(policy.policyId)) problems.push("policy.policyId", "must be a non-empty string");
    if (policy.policyVersion !== null && !nonEmptyString(policy.policyVersion)) {
      problems.push("policy.policyVersion", "must be a non-empty string or null");
    }
    if (!POSTURES.has(policy.posture as string)) problems.push("policy.posture", "has an unknown posture");
    if (policy.workerTarget !== null && (!isInteger(policy.workerTarget) || policy.workerTarget < 0)) {
      problems.push("policy.workerTarget", "must be a non-negative integer or null");
    }
    if (
      policy.militaryRatio !== null &&
      (typeof policy.militaryRatio !== "number" || !Number.isFinite(policy.militaryRatio) ||
        policy.militaryRatio < 0 || policy.militaryRatio > 1)
    ) {
      problems.push("policy.militaryRatio", "must be a number in [0, 1] or null");
    }
    if (policy.parametersHash !== null && (typeof policy.parametersHash !== "string" ||
      !SHA256_PATTERN.test(policy.parametersHash))) {
      problems.push("policy.parametersHash", "must be a sha256 or null");
    }
  }

  const outcome = value.outcome;
  if (checkKeys(problems, "outcome", outcome, ["coreResourceDelta", "workerDelta", "deaths"])) {
    if (!isInteger(outcome.coreResourceDelta)) {
      problems.push("outcome.coreResourceDelta", "must be an integer");
    }
    if (!isInteger(outcome.workerDelta)) problems.push("outcome.workerDelta", "must be an integer");
    if (!isInteger(outcome.deaths) || outcome.deaths < 0) {
      problems.push("outcome.deaths", "must be a non-negative integer");
    }
  }

  const label = value.label;
  if (checkKeys(problems, "label", label, [
    "net20", "deathProb20", "coreRisk50", "windowComplete", "windowEndTick",
  ])) {
    if (typeof label.net20 !== "number" || !Number.isFinite(label.net20)) {
      problems.push("label.net20", "must be a finite number");
    }
    if (
      typeof label.deathProb20 !== "number" || !Number.isFinite(label.deathProb20) ||
      label.deathProb20 < 0 || label.deathProb20 > 1
    ) {
      problems.push("label.deathProb20", "must be a number in [0, 1]");
    }
    if (label.coreRisk50 !== 0 && label.coreRisk50 !== 1) {
      problems.push("label.coreRisk50", "must be 0 or 1");
    }
    if (typeof label.windowComplete !== "boolean") {
      problems.push("label.windowComplete", "must be a boolean");
    }
    if (label.windowEndTick !== null && (!isInteger(label.windowEndTick) || label.windowEndTick < 1)) {
      problems.push("label.windowEndTick", "must be an integer >= 1 or null");
    }
    if (label.windowComplete === true && label.windowEndTick === null) {
      problems.push("label.windowEndTick", "is required when windowComplete is true");
    }
  }

  const provenance = value.provenance;
  if (checkKeys(problems, "provenance", provenance, [
    "rulesVersion", "rulesManifestHash", "sourceCommit", "engine", "processRunId", "runId",
    "tick", "seed", "source", "observationScope", "opponentPlans", "sourceRefs",
  ])) {
    if (!nonEmptyString(provenance.rulesVersion)) {
      problems.push("provenance.rulesVersion", "must be a non-empty string");
    }
    checkSha256(problems, "provenance.rulesManifestHash", provenance.rulesManifestHash);
    if (typeof provenance.sourceCommit !== "string" || !SOURCE_COMMIT_PATTERN.test(provenance.sourceCommit)) {
      problems.push("provenance.sourceCommit", "must be a 40- or 64-hex git commit");
    }
    checkEngine(problems, "provenance.engine", provenance.engine);
    if (!nonEmptyString(provenance.processRunId)) {
      problems.push("provenance.processRunId", "must be a non-empty string");
    }
    if (!nonEmptyString(provenance.runId)) {
      problems.push("provenance.runId", "must be a non-empty string");
    }
    if (!isInteger(provenance.tick) || provenance.tick < 1) {
      problems.push("provenance.tick", "must be an integer >= 1");
    }
    if (!isInteger(provenance.seed)) problems.push("provenance.seed", "must be an integer");
    if (provenance.source !== "live" && provenance.source !== "sim") {
      problems.push("provenance.source", "must be live or sim");
    }
    if (provenance.observationScope !== "private-player-projection") {
      problems.push("provenance.observationScope", "must be private-player-projection");
    }
    if (provenance.opponentPlans !== "not-included") {
      problems.push("provenance.opponentPlans", "must be not-included");
    }
    if (!Array.isArray(provenance.sourceRefs) || provenance.sourceRefs.length === 0) {
      problems.push("provenance.sourceRefs", "must be a non-empty array");
    } else {
      const ids = new Set<string>();
      for (const [index, ref] of provenance.sourceRefs.entries()) {
        checkSourceRef(problems, `provenance.sourceRefs[${index}]`, ref);
        if (isRecord(ref) && typeof ref.id === "string") {
          if (ids.has(ref.id)) problems.push(`provenance.sourceRefs[${index}].id`, "is duplicated");
          ids.add(ref.id);
        }
      }
    }
  }
  return problems.errors;
}

/** Validate a dataset-manifest-v1 record (the builder self-checks what it writes). */
export function validateDatasetManifest(value: unknown): readonly string[] {
  const problems = collector();
  if (!checkKeys(problems, "", value, [
    "schema", "datasetId", "createdAt", "sampleSchema", "format", "rulesVersion",
    "rulesManifestHash", "sourceCommit", "engine", "tickRange", "sourceRefs",
    "processRunIds", "runIds", "counts", "labelSpec", "artifacts", "datasetHash",
  ])) {
    return problems.errors;
  }
  if (value.schema !== "dataset-manifest-v1") problems.push("schema", "must be dataset-manifest-v1");
  if (!nonEmptyString(value.datasetId)) problems.push("datasetId", "must be a non-empty string");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    problems.push("createdAt", "must be an ISO date-time");
  }
  if (value.sampleSchema !== "ml-sample-v1") problems.push("sampleSchema", "must be ml-sample-v1");
  if (value.format !== "jsonl") problems.push("format", "must be jsonl");
  if (!nonEmptyString(value.rulesVersion)) problems.push("rulesVersion", "must be a non-empty string");
  checkSha256(problems, "rulesManifestHash", value.rulesManifestHash);
  if (typeof value.sourceCommit !== "string" || !SOURCE_COMMIT_PATTERN.test(value.sourceCommit)) {
    problems.push("sourceCommit", "must be a 40- or 64-hex git commit");
  }
  checkEngine(problems, "engine", value.engine);
  checkTickRange(problems, "tickRange", value.tickRange);
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) {
    problems.push("sourceRefs", "must be a non-empty array");
  } else {
    const ids = new Set<string>();
    for (const [index, ref] of value.sourceRefs.entries()) {
      checkSourceRef(problems, `sourceRefs[${index}]`, ref);
      if (isRecord(ref) && typeof ref.id === "string") {
        if (ids.has(ref.id)) problems.push(`sourceRefs[${index}].id`, "is duplicated");
        ids.add(ref.id);
      }
    }
  }
  if (!Array.isArray(value.processRunIds) || value.processRunIds.some((id) => !nonEmptyString(id))) {
    problems.push("processRunIds", "must be an array of non-empty strings");
  } else if (new Set(value.processRunIds).size !== value.processRunIds.length) {
    problems.push("processRunIds", "must be unique");
  }
  if (!Array.isArray(value.runIds) || value.runIds.some((id) => !nonEmptyString(id))) {
    problems.push("runIds", "must be an array of non-empty strings");
  } else if (new Set(value.runIds).size !== value.runIds.length) {
    problems.push("runIds", "must be unique");
  }
  const counts = value.counts;
  if (checkKeys(problems, "counts", counts, [
    "samples", "liveSamples", "simSamples", "completeLabelWindows", "incompleteLabelWindows",
  ])) {
    for (const field of ["samples", "liveSamples", "simSamples", "completeLabelWindows", "incompleteLabelWindows"] as const) {
      if (!isInteger(counts[field]) || counts[field] < 0) {
        problems.push(`counts.${field}`, "must be a non-negative integer");
      }
    }
  }
  const labelSpec = value.labelSpec;
  if (checkKeys(problems, "labelSpec", labelSpec, [
    "netWindowTicks", "deathWindowTicks", "coreRiskWindowTicks", "runBoundary",
  ])) {
    if (labelSpec.netWindowTicks !== 20) problems.push("labelSpec.netWindowTicks", "must be 20");
    if (labelSpec.deathWindowTicks !== 20) problems.push("labelSpec.deathWindowTicks", "must be 20");
    if (labelSpec.coreRiskWindowTicks !== 50) problems.push("labelSpec.coreRiskWindowTicks", "must be 50");
    if (labelSpec.runBoundary !== "truncate-and-mark-incomplete") {
      problems.push("labelSpec.runBoundary", "must be truncate-and-mark-incomplete");
    }
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    problems.push("artifacts", "must be a non-empty array");
  } else {
    for (const [index, artifact] of value.artifacts.entries()) {
      const artifactPath = `artifacts[${index}]`;
      if (!checkKeys(problems, artifactPath, artifact, [
        "path", "mediaType", "recordSchema", "sha256", "bytes", "recordCount", "tickRange",
      ])) continue;
      checkUriReference(problems, `${artifactPath}.path`, artifact.path);
      if (artifact.mediaType !== "application/x-ndjson") {
        problems.push(`${artifactPath}.mediaType`, "must be application/x-ndjson");
      }
      if (artifact.recordSchema !== "ml-sample-v1") {
        problems.push(`${artifactPath}.recordSchema`, "must be ml-sample-v1");
      }
      checkSha256(problems, `${artifactPath}.sha256`, artifact.sha256);
      if (!isInteger(artifact.bytes) || artifact.bytes < 0) {
        problems.push(`${artifactPath}.bytes`, "must be a non-negative integer");
      }
      if (!isInteger(artifact.recordCount) || artifact.recordCount < 0) {
        problems.push(`${artifactPath}.recordCount`, "must be a non-negative integer");
      }
      checkTickRange(problems, `${artifactPath}.tickRange`, artifact.tickRange);
    }
  }
  checkSha256(problems, "datasetHash", value.datasetHash);
  return problems.errors;
}

/** Validate a dataset-registry-entry-v1 record (appended to registry.jsonl). */
export function validateDatasetRegistryEntry(value: unknown): readonly string[] {
  const problems = collector();
  if (!checkKeys(problems, "", value, [
    "schema", "datasetId", "status", "createdAt", "updatedAt", "sampleSchema",
    "rulesVersion", "rulesManifestHash", "sourceCommit", "engine", "processRunIds",
    "runIds", "tickRange", "sampleCount", "datasetHash", "manifestRef", "sourceRefs",
    "supersedes", "tags", "notes",
  ])) {
    return problems.errors;
  }
  if (value.schema !== "dataset-registry-entry-v1") {
    problems.push("schema", "must be dataset-registry-entry-v1");
  }
  if (!nonEmptyString(value.datasetId)) problems.push("datasetId", "must be a non-empty string");
  if (!REGISTRY_STATUSES.has(value.status as string)) problems.push("status", "has an unknown status");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof value[field] !== "string" || !Number.isFinite(Date.parse(value[field]))) {
      problems.push(field, "must be an ISO date-time");
    }
  }
  if (value.sampleSchema !== "ml-sample-v1") problems.push("sampleSchema", "must be ml-sample-v1");
  if (!nonEmptyString(value.rulesVersion)) problems.push("rulesVersion", "must be a non-empty string");
  checkSha256(problems, "rulesManifestHash", value.rulesManifestHash);
  if (typeof value.sourceCommit !== "string" || !SOURCE_COMMIT_PATTERN.test(value.sourceCommit)) {
    problems.push("sourceCommit", "must be a 40- or 64-hex git commit");
  }
  checkEngine(problems, "engine", value.engine);
  if (!Array.isArray(value.processRunIds) || value.processRunIds.some((id) => !nonEmptyString(id))) {
    problems.push("processRunIds", "must be an array of non-empty strings");
  } else if (new Set(value.processRunIds).size !== value.processRunIds.length) {
    problems.push("processRunIds", "must be unique");
  }
  if (!Array.isArray(value.runIds) || value.runIds.some((id) => !nonEmptyString(id))) {
    problems.push("runIds", "must be an array of non-empty strings");
  } else if (new Set(value.runIds).size !== value.runIds.length) {
    problems.push("runIds", "must be unique");
  }
  checkTickRange(problems, "tickRange", value.tickRange);
  if (!isInteger(value.sampleCount) || value.sampleCount < 0) {
    problems.push("sampleCount", "must be a non-negative integer");
  }
  checkSha256(problems, "datasetHash", value.datasetHash);
  const manifestRef = value.manifestRef;
  if (checkKeys(problems, "manifestRef", manifestRef, ["schema", "datasetId", "uri", "sha256"])) {
    if (manifestRef.schema !== "dataset-manifest-v1") {
      problems.push("manifestRef.schema", "must be dataset-manifest-v1");
    }
    if (!nonEmptyString(manifestRef.datasetId)) {
      problems.push("manifestRef.datasetId", "must be a non-empty string");
    }
    checkUriReference(problems, "manifestRef.uri", manifestRef.uri);
    checkSha256(problems, "manifestRef.sha256", manifestRef.sha256);
  }
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) {
    problems.push("sourceRefs", "must be a non-empty array");
  } else {
    for (const [index, ref] of value.sourceRefs.entries()) {
      checkSourceRef(problems, `sourceRefs[${index}]`, ref);
    }
  }
  if (!Array.isArray(value.supersedes) || value.supersedes.some((id) => !nonEmptyString(id))) {
    problems.push("supersedes", "must be an array of non-empty strings");
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => !nonEmptyString(tag))) {
    problems.push("tags", "must be an array of non-empty strings");
  }
  if (value.notes !== null && !nonEmptyString(value.notes)) {
    problems.push("notes", "must be a non-empty string or null");
  }
  return problems.errors;
}
