/**
 * M2a.1: DecisionCandidateV1 contract — the single most important contract of
 * the Learned Decision System (v4 ruling 2026-08-08, hardened per user audit
 * 2026-08-08: M2a.1 per-kind exact parameter schema).
 *
 * A candidate is a DECLARATIVE STRATEGIC INTENTION, never a final Plan.
 * Unit-level actions (who moves / who harvests / Hungarian assignment) are
 * expanded by the deterministic planner and MUST NOT appear in a learned
 * candidate. If this contract is designed wrong, every downstream dataset
 * has to be re-collected; models can be swapped freely, the contract cannot.
 *
 * M2a.1 hardening: `parameters` is no longer an arbitrary scalar map — every
 * kind has an EXACT key set and value domain, enforced both structurally
 * (TypeScript discriminated union: the compiler rejects wrong parameters)
 * and at runtime (validateDecisionCandidateV1). "unit action" semantics
 * (unitId/action/direction) are structurally unrepresentable: WORKER_TARGET
 * accepts only {workerTarget}, ATTACK_TARGET only {targetId}|{targetClass},
 * etc. — a comment-level discipline became a structure-level guarantee.
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

/** POSTURE values — aligned with runtime-config.ts policy override. */
export const POSTURE_VALUES = ["harvest", "balanced", "aggressive"] as const;
export type Posture = (typeof POSTURE_VALUES)[number];

/** ATTACK_TARGET targetClass — the unit taxonomy of the game. */
export const TARGET_CLASSES = ["WORKER", "VANGUARD", "RANGER"] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

/** MIGRATE cardinal directions (4-way; diagonals are two-step intentions). */
export const MIGRATE_DIRECTIONS = ["north", "east", "south", "west"] as const;
export type MigrateDirection = (typeof MIGRATE_DIRECTIONS)[number];

export type ResourceFocusParameters =
  | { readonly targetX: number; readonly targetY: number }
  | { readonly regionId: string };

export type AttackTargetParameters =
  | { readonly targetId: string }
  | { readonly targetClass: TargetClass };

export type MigrateParameters =
  | { readonly direction: MigrateDirection }
  | { readonly targetX: number; readonly targetY: number };

/**
 * Per-kind exact parameter shapes. The compiler rejects any candidate whose
 * parameters do not match its kind — a unit action cannot even be typed.
 */
export interface DecisionCandidateBase {
  readonly schema: "decision-candidate-v1";
  readonly candidateId: string;
  readonly source: CandidateSource;
  readonly legality: "legal" | "rejected";
  /** sha256(kind + canonical parameters) — the candidate's semantic identity. */
  readonly deterministicHash: string;
}

export type DecisionCandidateV1 =
  | (DecisionCandidateBase & { readonly kind: "KEEP"; readonly parameters: {} })
  | (DecisionCandidateBase & { readonly kind: "WORKER_TARGET"; readonly parameters: { readonly workerTarget: number } })
  | (DecisionCandidateBase & { readonly kind: "MILITARY_RATIO"; readonly parameters: { readonly militaryRatio: number } })
  | (DecisionCandidateBase & { readonly kind: "POSTURE"; readonly parameters: { readonly posture: Posture } })
  | (DecisionCandidateBase & { readonly kind: "RESOURCE_FOCUS"; readonly parameters: ResourceFocusParameters })
  | (DecisionCandidateBase & { readonly kind: "ATTACK_TARGET"; readonly parameters: AttackTargetParameters })
  | (DecisionCandidateBase & { readonly kind: "MIGRATE"; readonly parameters: MigrateParameters });

export type CandidateParameters = DecisionCandidateV1["parameters"];
export type ParametersForKind<K extends CandidateKind> = Extract<
  DecisionCandidateV1,
  { readonly kind: K }
>["parameters"];

/** Canonical JSON of the semantic identity (kind + parameters, key-sorted). */
export function candidateSemanticRecord(
  kind: CandidateKind,
  parameters: CandidateParameters,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(parameters).sort()) {
    sorted[key] = parameters[key as keyof typeof parameters];
  }
  return { kind, parameters: sorted };
}

export function computeCandidateDeterministicHash(
  kind: CandidateKind,
  parameters: CandidateParameters,
): string {
  const canonical = JSON.stringify(candidateSemanticRecord(kind, parameters));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Candidate-set identity: sha256 over the sorted deterministic hashes
 *  (order-independent — the same set always hashes identically). */
export function computeCandidateSetHash(candidates: readonly DecisionCandidateV1[]): string {
  const hashes = candidates.map((candidate) => candidate.deterministicHash).sort();
  return createHash("sha256").update(hashes.join("\n"), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(parameters: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(parameters).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Per-kind parameter validation: exact key set + value domain (M2a.1). */
function validateKindParameters(kind: CandidateKind, parameters: Record<string, unknown>): string[] {
  const problems: string[] = [];
  switch (kind) {
    case "KEEP": {
      if (!hasExactKeys(parameters, [])) {
        problems.push("KEEP parameters must be empty");
      }
      break;
    }
    case "WORKER_TARGET": {
      if (!hasExactKeys(parameters, ["workerTarget"])) {
        problems.push("WORKER_TARGET parameters must be exactly { workerTarget }");
        break;
      }
      const value = parameters.workerTarget;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16) {
        problems.push("WORKER_TARGET workerTarget must be an integer in [1,16] (runtime-config range)");
      }
      break;
    }
    case "MILITARY_RATIO": {
      if (!hasExactKeys(parameters, ["militaryRatio"])) {
        problems.push("MILITARY_RATIO parameters must be exactly { militaryRatio }");
        break;
      }
      const value = parameters.militaryRatio;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        problems.push("MILITARY_RATIO militaryRatio must be a finite number in [0,1]");
      }
      break;
    }
    case "POSTURE": {
      if (!hasExactKeys(parameters, ["posture"])) {
        problems.push("POSTURE parameters must be exactly { posture }");
        break;
      }
      if (!POSTURE_VALUES.includes(parameters.posture as Posture)) {
        problems.push(`POSTURE posture must be one of ${POSTURE_VALUES.join(", ")}`);
      }
      break;
    }
    case "RESOURCE_FOCUS": {
      // Exactly one alternative: coordinates or regionId (never both).
      if (hasExactKeys(parameters, ["targetX", "targetY"])) {
        for (const axis of ["targetX", "targetY"] as const) {
          const value = parameters[axis];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            problems.push(`RESOURCE_FOCUS ${axis} must be a finite number`);
          }
        }
      } else if (hasExactKeys(parameters, ["regionId"])) {
        if (typeof parameters.regionId !== "string" || parameters.regionId.length === 0) {
          problems.push("RESOURCE_FOCUS regionId must be a non-empty string");
        }
      } else {
        problems.push(
          "RESOURCE_FOCUS parameters must be exactly { targetX, targetY } or { regionId } (never both)",
        );
      }
      break;
    }
    case "ATTACK_TARGET": {
      if (hasExactKeys(parameters, ["targetId"])) {
        if (typeof parameters.targetId !== "string" || parameters.targetId.length === 0) {
          problems.push("ATTACK_TARGET targetId must be a non-empty string");
        }
      } else if (hasExactKeys(parameters, ["targetClass"])) {
        if (!TARGET_CLASSES.includes(parameters.targetClass as TargetClass)) {
          problems.push(`ATTACK_TARGET targetClass must be one of ${TARGET_CLASSES.join(", ")}`);
        }
      } else {
        problems.push(
          "ATTACK_TARGET parameters must be exactly { targetId } or { targetClass } (never both)",
        );
      }
      break;
    }
    case "MIGRATE": {
      if (hasExactKeys(parameters, ["direction"])) {
        if (!MIGRATE_DIRECTIONS.includes(parameters.direction as MigrateDirection)) {
          problems.push(`MIGRATE direction must be one of ${MIGRATE_DIRECTIONS.join(", ")}`);
        }
      } else if (hasExactKeys(parameters, ["targetX", "targetY"])) {
        for (const axis of ["targetX", "targetY"] as const) {
          const value = parameters[axis];
          if (typeof value !== "number" || !Number.isFinite(value)) {
            problems.push(`MIGRATE ${axis} must be a finite number`);
          }
        }
      } else {
        problems.push(
          "MIGRATE parameters must be exactly { direction } or { targetX, targetY } (never both)",
        );
      }
      break;
    }
  }
  return problems;
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
  } else if (typeof value.kind === "string" && CANDIDATE_KINDS.includes(value.kind as CandidateKind)) {
    problems.push(...validateKindParameters(value.kind as CandidateKind, value.parameters));
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
      value.parameters as CandidateParameters,
    );
    if (value.deterministicHash !== expectedHash) {
      problems.push(`deterministicHash mismatch: expected ${expectedHash}`);
    }
  }
  return problems;
}

/** Build a validated candidate (throws on invalid parameters). */
export function makeCandidateV1<K extends CandidateKind>(options: {
  readonly candidateId: string;
  readonly kind: K;
  readonly parameters: ParametersForKind<K>;
  readonly source: CandidateSource;
  readonly legality?: "legal" | "rejected";
}): DecisionCandidateV1 {
  // Generic union construction: the object literal cannot be typed through K,
  // so it is built as a plain record and validated at runtime (the validator
  // below is the second line of defense after the TS discriminated union).
  const candidate = {
    schema: DECISION_CANDIDATE_SCHEMA_VERSION,
    candidateId: options.candidateId,
    kind: options.kind,
    parameters: Object.freeze({ ...options.parameters }),
    source: options.source,
    legality: options.legality ?? "legal",
    deterministicHash: computeCandidateDeterministicHash(options.kind, options.parameters),
  } as unknown as DecisionCandidateV1;
  const problems = validateDecisionCandidateV1(candidate);
  if (problems.length > 0) {
    throw new Error(`invalid candidate: ${problems.join("; ")}`);
  }
  return Object.freeze(candidate);
}
