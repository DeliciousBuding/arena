/**
 * Worker task progress contract.
 *
 * Liveness must judge whether the assigned task is advancing, not infer success from intent names.
 * New task kinds must choose an explicit expectation here; e.g. future RESURVEY should use a
 * target/refresh expectation instead of reusing EXPLORE's novel-coverage contract.
 */

import type { Position } from "../domain/model.ts";

export type WorkerProgressExpectation =
  | {
      readonly kind: "target";
      readonly taskType: "GO_RESOURCE" | "DEPOSIT";
      readonly target: Position;
    }
  | {
      readonly kind: "cargo_change";
      readonly taskType: "HARVEST_CURRENT";
    }
  | {
      readonly kind: "novel_coverage";
      readonly taskType: "EXPLORE";
    };

export type WorkerProgressExpectations = ReadonlyMap<string, WorkerProgressExpectation>;
