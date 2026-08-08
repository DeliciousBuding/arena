/**
 * M2a: DecisionCandidateV1 contract — the single most important contract of
 * the Learned Decision System (v4 ruling 2026-08-08).
 *
 * A candidate is a DECLARATIVE STRATEGIC INTENTION, never a final Plan.
 * Unit-level actions (who moves / who harvests / Hungarian assignment) are
 * expanded by the deterministic planner and MUST NOT appear in a learned
 * candidate. If this contract is designed wrong, every downstream dataset
 * has to be re-collected; models can be swapped freely, the contract cannot.
 *
 * First version learns only macro choices: workerTarget neighborhood
 * (8/10/12), militaryRatio (.2/.3/.4), posture, resource/attack focus,
 * migration direction. A single tick's candidate set is 5–20 bounded
 * candidates.
 *
 * deterministicHash covers kind + parameters only (the semantic identity);
 * source/legality are metadata (legality can change per tick).
 */

import { createHash } from "node:crypto";

export const DECISION_CANDIDATE_SCHEMA_VERSION = "decision-candidate-v1";

export const CANDIDATE_KINDS = [
  "KEEP",
  "WORKER_TARGET",
  "MILITARY_RATIO",
  "POSTURE",
  "RESOURCE_FOCUS",
  "ATTACK_TARGET",
  "MIGRATE",
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export const CANDIDATE_SOURCES = [
  "baseline",
  "local-neighborhood",
  "planner",
  "search",
  "model",
] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export interface DecisionCandidateV1 {
  readonly schema: "decision-candidate-v1";
  readonly candidateId: string;
  readonly kind: CandidateKind;
  /** Semantic parameters only; values are JSON-scalar (number/string/null). */
  readonly parameters: Readonly<Record<string, number | string | null>>;
  readonly source: CandidateSource;
  readonly legality: "legal" | "rejected";
  /** sha256(kind + canonical parameters) — the candidate's semantic identity. */
  readonly deterministicHash: string;
}

/** Canonical JSON of the semantic identity (kind + parameters, key-sorted). */
export function candidateSemanticRecord(
  kind: CandidateKind,
  parameters: Readonly<Record<string, number | string | null>>,
): Record<string, unknown> {
  const sorted: Record<string, number | string | null> = {};
  for (const key of Object.keys(parameters).sort()) {
    sorted[key] = parameters[key] ?? null;
  }
  return { kind, parameters: sorted };
}

export function computeCandidateDeterministicHash(
  kind: CandidateKind,
  parameters: Readonly<Record<string, number | string | null>>,
): string {
  const canonical = JSON.stringify(candidateSemanticRecord(kind, parameters));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict validator mirroring the contract (additionalProperties:false). */
export function validateDecisionCandidateV1(value: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return ["must be an object"];
  }
  const expected = new Set([
    "schema", "candidateId", "kind", "parameters", "source", "legality", "deterministicHash",
  ]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) problems.push(`${key} is not allowed`);
  }
  for (const key of expected) {
    if (!(key in value)) problems.push(`${key} is required`);
  }
  if (value.schema !== DECISION_CANDIDATE_SCHEMA_VERSION) {
    problems.push(`schema must be ${DECISION_CANDIDATE_SCHEMA_VERSION}`);
  }
  if (typeof value.candidateId !== "string" || value.candidateId.length === 0) {
    problems.push("candidateId must be a non-empty string");
  }
  if (!CANDIDATE_KINDS.includes(value.kind as CandidateKind)) {
    problems.push(`kind must be one of ${CANDIDATE_KINDS.join(", ")}`);
  }
  if (!isRecord(value.parameters)) {
    problems.push("parameters must be an object");
  } else {
    for (const [key, param] of Object.entries(value.parameters)) {
      if (param !== null && typeof param !== "number" && typeof param !== "string") {
        problems.push(`parameters.${key} must be a number, string, or null`);
      }
    }
  }
  if (!CANDIDATE_SOURCES.includes(value.source as CandidateSource)) {
    problems.push(`source must be one of ${CANDIDATE_SOURCES.join(", ")}`);
  }
  if (value.legality !== "legal" && value.legality !== "rejected") {
    problems.push("legality must be legal or rejected");
  }
  if (typeof value.deterministicHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.deterministicHash)) {
    problems.push("deterministicHash must be sha256 hex");
  }
  if (problems.length === 0 && typeof value.kind === "string" && isRecord(value.parameters)) {
    const expectedHash = computeCandidateDeterministicHash(
      value.kind as CandidateKind,
      value.parameters as Record<string, number | string | null>,
    );
    if (value.deterministicHash !== expectedHash) {
      problems.push(`deterministicHash mismatch: expected ${expectedHash}`);
    }
  }
  return problems;
}

/** Build a validated candidate (throws on invalid parameters). */
export function makeCandidateV1(options: {
  readonly candidateId: string;
  readonly kind: CandidateKind;
  readonly parameters: Readonly<Record<string, number | string | null>>;
  readonly source: CandidateSource;
  readonly legality?: "legal" | "rejected";
}): DecisionCandidateV1 {
  const candidate: DecisionCandidateV1 = {
    schema: DECISION_CANDIDATE_SCHEMA_VERSION,
    candidateId: options.candidateId,
    kind: options.kind,
    parameters: Object.freeze({ ...options.parameters }),
    source: options.source,
    legality: options.legality ?? "legal",
    deterministicHash: computeCandidateDeterministicHash(options.kind, options.parameters),
  };
  const problems = validateDecisionCandidateV1(candidate);
  if (problems.length > 0) {
    throw new Error(`invalid candidate: ${problems.join("; ")}`);
  }
  return Object.freeze(candidate);
}
