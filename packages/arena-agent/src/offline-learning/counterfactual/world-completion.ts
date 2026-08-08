/**
 * Real decision-point → counterfactual initial-world bridge.
 *
 * A live PlayerState is a PRIVATE observation, never a complete world. This
 * module makes completion an explicit strategy with auditable assumptions so
 * later survey-memory / belief-sampling implementations can replace the first
 * visible-only prototype without changing the rollout or q-sample contracts.
 */

import type { PlayerState } from "@arena/arena-hero-ts";
import {
  parseCalibrationCase,
  type CalibrationCaseV1,
} from "../../sim/calibration/schema.ts";
import { worldFromRawState } from "../../sim/world/loaders.ts";
import type { SimWorld } from "../../sim/world/types.ts";
import { assertWorldInvariants } from "../../sim/world/world.ts";
import type { MacroDecisionPointV1 } from "../runtime/macro-decision-point.ts";
import type { InitialStateScope } from "../q-sample/q-sample-v1.ts";

export interface DecisionWorldCompletion {
  readonly world: SimWorld;
  readonly initialStateScope: InitialStateScope;
  readonly completionPolicy: string;
  readonly completionSeed: number | null;
  readonly completionAssumptions: readonly string[];
  readonly opponentId: string;
}

export interface DecisionWorldCompletionInput {
  readonly decisionPoint: MacroDecisionPointV1;
  readonly calibrationCase: CalibrationCaseV1;
}

/** Pluggable hidden-world completion boundary. */
export interface DecisionWorldCompletionProvider {
  readonly id: string;
  complete(input: DecisionWorldCompletionInput): DecisionWorldCompletion;
}

export interface VisibleOnlyCompletionOptions {
  readonly syntheticOpponentId?: string;
}

function isUncontrolledEntity(object: PlayerState["objects"][number]): boolean {
  return (object.kind === "CORE" || object.kind === "UNIT") && object.controlled === false;
}

function validateDecisionCaseIdentity(
  decisionPoint: MacroDecisionPointV1,
  calibrationCase: CalibrationCaseV1,
): void {
  if (decisionPoint.tick !== calibrationCase.before.tick) {
    throw new Error(
      `world completion: decision tick ${decisionPoint.tick} != calibration before tick ${calibrationCase.before.tick}`,
    );
  }
  if (decisionPoint.processRunId !== calibrationCase.caseId.split(":")[0]) {
    throw new Error(
      `world completion: processRunId ${decisionPoint.processRunId} does not match caseId ${calibrationCase.caseId}`,
    );
  }
  if (decisionPoint.decisionPointId !== `${decisionPoint.processRunId}:${decisionPoint.tick}`) {
    throw new Error("world completion: malformed decisionPointId");
  }
}

/**
 * P4 prototype completion policy.
 *
 * What it knows exactly:
 * - controlled Core/units/resources;
 * - currently visible terrain/resources/enemies;
 * - beacon absolute position from the private wire state.
 *
 * What it intentionally assumes:
 * - unobserved terrain is empty;
 * - unobserved entities are absent;
 * - all currently visible uncontrolled entities belong to one synthetic
 *   opponent (wire observations do not reveal owner identity);
 * - if beacon status is hidden, treat it as GROUND at its authoritative
 *   position so the simulator can retain a wire-projectable beacon state.
 *
 * These are DEV counterfactuals, not certification-grade truth. A future
 * survey-memory/belief provider implements DecisionWorldCompletionProvider and
 * can replace this policy without touching q-sample or rollout code.
 */
export function createVisibleOnlyCompletionProvider(
  options: VisibleOnlyCompletionOptions = {},
): DecisionWorldCompletionProvider {
  const syntheticOpponentId = options.syntheticOpponentId ?? "visible-opponent-v1";
  return Object.freeze({
    id: "private-visible-only-v1",
    complete(input: DecisionWorldCompletionInput): DecisionWorldCompletion {
      const { decisionPoint, calibrationCase } = input;
      validateDecisionCaseIdentity(decisionPoint, calibrationCase);
      const beforeState = calibrationCase.before.state;
      const hasVisibleOpponent = beforeState.objects.some(isUncontrolledEntity);
      const loaded = worldFromRawState(
        beforeState,
        calibrationCase.tenantId,
        calibrationCase.rulesVersion,
        hasVisibleOpponent ? { opponentPlayerId: syntheticOpponentId } : {},
      );
      const assumptions = [
        "unobserved-terrain=>EMPTY",
        "unobserved-entities=>ABSENT",
      ];
      if (hasVisibleOpponent) {
        assumptions.push("visible-opponent-ownership=>SINGLE_SYNTHETIC_OPPONENT");
        assumptions.push("visible-opponent-future-policy=>DETERMINISTIC_DEFAULT");
      }
      if (beforeState.champion_beacon.status === null) {
        assumptions.push("hidden-beacon-status=>GROUND_AT_AUTHORITATIVE_POSITION");
      }
      if (calibrationCase.metadata.opponentPlans === "absent" && hasVisibleOpponent) {
        assumptions.push("observed-opponent-plan=>ABSENT");
      }

      const world: SimWorld = {
        ...loaded,
        tick: decisionPoint.tick,
        resolvedTickCount: Math.max(0, decisionPoint.tick - 1),
        // CalibrationCase.seed is only a local replay seed; candidate rollout
        // seeds are injected later by runEpisodeFromWorld and are orthogonal
        // to hidden-state completion randomness.
        seed: calibrationCase.seed,
        provenance: {
          scenario: calibrationCase.caseId,
          sourceCaseHash: calibrationCase.metadata.sourceCommit,
        },
      };
      assertWorldInvariants(world);
      return Object.freeze({
        world,
        initialStateScope: "private-observation-completed" as const,
        completionPolicy: "private-visible-only-v1",
        // visible-only completion is deterministic: no hidden-world sampling.
        completionSeed: null,
        completionAssumptions: Object.freeze(assumptions.sort()),
        opponentId: hasVisibleOpponent ? syntheticOpponentId : "none-visible-v1",
      });
    },
  });
}

/** Parse + complete convenience path for CLI/exporter callers. */
export function completeVisibleOnlyDecisionWorld(
  rawCalibrationCase: unknown,
  decisionPoint: MacroDecisionPointV1,
  options: VisibleOnlyCompletionOptions = {},
): DecisionWorldCompletion {
  return createVisibleOnlyCompletionProvider(options).complete({
    decisionPoint,
    calibrationCase: parseCalibrationCase(rawCalibrationCase),
  });
}
