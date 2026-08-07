/** Tenant-local, fail-open Alliance directive inbox. */
import type { AllianceDirective } from "../types.ts";
import { evaluateDirective, isNewerRevision } from "../directive.ts";

export type DirectiveAcceptResult =
  | { readonly accepted: true; readonly revision: number }
  | { readonly accepted: false; readonly reason: string; readonly revision: number };

export interface DirectiveInbox {
  /** Store a directive only when it is consumable at currentTick and newer than the saved revision. */
  accept(directive: AllianceDirective, currentTick: number): DirectiveAcceptResult;
  /** Re-check temporal validity on every read; invalid/stale/expired directives fail open to undefined. */
  current(tick: number): AllianceDirective | undefined;
  readonly hasDirective: boolean;
  /** Last accepted revision only. Rejected input never advances this value. */
  readonly lastRevision: number;
}

export function createDirectiveInbox(tenantId: string): DirectiveInbox {
  let saved: AllianceDirective | null = null;
  let lastAcceptedRevision = -1;

  return {
    accept(directive: AllianceDirective, currentTick: number): DirectiveAcceptResult {
      if (directive.tenantId !== tenantId) {
        return {
          accepted: false,
          reason: `tenant mismatch: directive for "${directive.tenantId}", inbox for "${tenantId}"`,
          revision: directive.revision,
        };
      }

      const evaluation = evaluateDirective(directive, tenantId, currentTick);
      if (!evaluation.consume) {
        return {
          accepted: false,
          reason: evaluation.reason ?? "not consumable",
          revision: directive.revision,
        };
      }

      if (saved !== null && !isNewerRevision(directive, saved)) {
        return {
          accepted: false,
          reason: `revision not newer: incoming=${directive.revision} <= current=${saved.revision}`,
          revision: directive.revision,
        };
      }

      saved = directive;
      lastAcceptedRevision = directive.revision;
      return { accepted: true, revision: directive.revision };
    },

    current(tick: number): AllianceDirective | undefined {
      if (saved === null) return undefined;
      return evaluateDirective(saved, tenantId, tick).consume ? saved : undefined;
    },

    get hasDirective(): boolean {
      return saved !== null;
    },

    get lastRevision(): number {
      return lastAcceptedRevision;
    },
  };
}