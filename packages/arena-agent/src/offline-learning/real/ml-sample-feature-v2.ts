/**
 * Canonical ml-sample-v1 -> feature-vector-v2 projection for M1 B+.
 *
 * The path intentionally reuses the official SDK Turn + production reduceTurn()
 * before feature extraction. Python must consume the resulting records, never
 * reimplement state semantics.
 */

import { Turn, type PlayerState } from "@arena/arena-hero-ts";

import { reduceTurn, type TurnLike } from "../../domain/state-reducer.ts";
import { validateMlSample } from "../../sim/dataset/validate-sample.ts";
import {
  FEATURE_VECTOR_V2_SCHEMA_VERSION,
  extractFeatureVectorV2,
  featureVectorV2ToRecord,
  type FeatureV2Context,
  type FeatureV2Posture,
} from "../schema/feature-vector-v2.ts";
import {
  lookupDecisionRecord,
  type DecisionJoinIndex,
} from "./decision-join.ts";

interface ObservationV1 {
  readonly tick: number;
  readonly state: PlayerState;
}

interface PolicyV1 {
  readonly posture: FeatureV2Posture | null;
  readonly workerTarget: number | null;
  readonly militaryRatio: number | null;
}

interface ProvenanceV1 {
  readonly processRunId: string;
  readonly tick: number;
  readonly source: "live" | "sim";
  readonly sampleStatus?: "conclusive" | "inconclusive" | null;
}

interface LabelV1 {
  readonly net20: number;
  readonly deathProb20: number;
  readonly coreRisk50: 0 | 1;
  readonly windowComplete: boolean;
}

export interface MlSampleV1ForFeatures {
  readonly schema: "ml-sample-v1";
  readonly sampleId: string;
  readonly state: ObservationV1;
  readonly policy: PolicyV1;
  readonly label: LabelV1;
  readonly provenance: ProvenanceV1;
  readonly [key: string]: unknown;
}

export interface FeatureV2Record {
  readonly schema: typeof FEATURE_VECTOR_V2_SCHEMA_VERSION;
  readonly sampleId: string;
  /** Metadata only; never included in `features`. */
  readonly processRunId: string;
  readonly tick: number;
  readonly source: "live" | "sim";
  readonly simReplayStatus: "conclusive" | "inconclusive" | null;
  readonly decisionJoin: {
    readonly matched: boolean;
    readonly threatLevelKnown: boolean;
    readonly threatHistoryKnown: boolean;
  };
  readonly label: LabelV1;
  readonly features: Readonly<Record<string, number>>;
}

export interface ProjectMlSampleOptions {
  /** Default true: a missing decision row is a lineage error, not "NORMAL" threat. */
  readonly requireDecisionJoin?: boolean;
}

function asMlSample(value: unknown): MlSampleV1ForFeatures {
  const problems = validateMlSample(value);
  if (problems.length > 0) {
    throw new Error(`ml-sample-v1 validation failed: ${problems.join("; ")}`);
  }
  return value as MlSampleV1ForFeatures;
}

function toTickState(observation: ObservationV1) {
  const offlineSubmit = async (): Promise<never> => {
    throw new Error("offline feature projection must never submit a plan");
  };
  const turn = new Turn(observation.tick, observation.state, offlineSubmit);
  return reduceTurn(turn as unknown as TurnLike);
}

export function projectMlSampleToFeatureV2(
  value: unknown,
  decisionIndex: DecisionJoinIndex,
  options: ProjectMlSampleOptions = {},
): FeatureV2Record {
  const sample = asMlSample(value);
  if (sample.provenance.tick !== sample.state.tick) {
    throw new Error(
      `sample ${sample.sampleId} tick mismatch: provenance=${sample.provenance.tick}, state=${sample.state.tick}`,
    );
  }

  const decision = lookupDecisionRecord(
    decisionIndex,
    sample.provenance.processRunId,
    sample.provenance.tick,
  );
  if (decision === null && options.requireDecisionJoin !== false) {
    throw new Error(
      `sample ${sample.sampleId} has no decision telemetry for ${sample.provenance.processRunId}:${sample.provenance.tick}`,
    );
  }

  const context: FeatureV2Context = {
    threatLevel: decision?.threatLevel ?? null,
    recentNonNormalThreatTicks6: decision?.recentNonNormalThreatTicks6 ?? null,
    workerTarget: sample.policy.workerTarget,
    militaryRatio: sample.policy.militaryRatio,
    posture: sample.policy.posture,
  };
  const vector = extractFeatureVectorV2(toTickState(sample.state), context);

  return Object.freeze({
    schema: FEATURE_VECTOR_V2_SCHEMA_VERSION,
    sampleId: sample.sampleId,
    processRunId: sample.provenance.processRunId,
    tick: sample.provenance.tick,
    source: sample.provenance.source,
    simReplayStatus: sample.provenance.sampleStatus ?? null,
    decisionJoin: Object.freeze({
      matched: decision !== null,
      threatLevelKnown: decision?.threatLevel !== null && decision?.threatLevel !== undefined,
      threatHistoryKnown: decision?.recentNonNormalThreatTicks6 !== null &&
        decision?.recentNonNormalThreatTicks6 !== undefined,
    }),
    label: Object.freeze({ ...sample.label }),
    features: featureVectorV2ToRecord(vector),
  });
}
