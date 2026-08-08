/**
 * Outcome event accounting shared by live telemetry and simulator evaluation.
 *
 * The event vocabulary is intentionally explicit. Do not count by suffix/prefix:
 * CORE_RESOURCE_OVERFLOW_DESTROYED is not a unit loss, and future event names
 * must not silently enter an economic KPI.
 */

export interface OutcomeEventLike {
  readonly eventType: string;
  readonly actorId: string | null;
  readonly targetId?: string | null;
  readonly values?: Readonly<Record<string, unknown>> | null;
}

export interface OwnedOutcomeContext {
  /** Unit ids owned by the subject before this resolution window. */
  readonly priorUnitIds: ReadonlySet<string>;
  /** Unit ids owned after resolution (covers freshly spawned actors in future protocols). */
  readonly currentUnitIds?: ReadonlySet<string>;
  readonly priorCoreId?: string | null;
  readonly currentCoreId?: string | null;
}

export interface OutcomeEventCounters {
  readonly grossDeposit: number;
  readonly spawnCount: number;
  readonly healCount: number;
  readonly unitLossCount: number;
}

export const OUTCOME_DEPOSIT_EVENTS = Object.freeze(new Set(["DEPOSIT_SUCCEEDED"]));
export const OUTCOME_SPAWN_EVENTS = Object.freeze(new Set(["CORE_SPAWN_SUCCEEDED"]));
export const OUTCOME_HEAL_EVENTS = Object.freeze(new Set(["UNIT_HEAL_SUCCEEDED", "CORE_HEAL_SUCCEEDED"]));
export const OUTCOME_UNIT_LOSS_EVENTS = Object.freeze(new Set(["UNIT_DESTROYED", "UNIT_SELF_DESTRUCTED"]));

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function ownedActor(actorId: string | null, context: OwnedOutcomeContext): boolean {
  if (actorId === null) return false;
  if (context.priorCoreId === actorId || context.currentCoreId === actorId) return true;
  if (context.priorUnitIds.has(actorId)) return true;
  return context.currentUnitIds?.has(actorId) === true;
}

/**
 * Count one resolution window for a single player.
 *
 * `UNIT_DESTROYED` is only counted when its actor id belonged to the player in
 * the preceding state. This is important for private/live streams that may also
 * expose destruction events caused by the player.
 */
export function countOutcomeEvents(
  events: readonly OutcomeEventLike[],
  context: OwnedOutcomeContext,
): OutcomeEventCounters {
  let grossDeposit = 0;
  let spawnCount = 0;
  let healCount = 0;
  let unitLossCount = 0;

  for (const event of events) {
    if (OUTCOME_DEPOSIT_EVENTS.has(event.eventType) && ownedActor(event.actorId, context)) {
      grossDeposit += finiteNonNegative(event.values?.amount);
      continue;
    }
    if (OUTCOME_SPAWN_EVENTS.has(event.eventType) && ownedActor(event.actorId, context)) {
      spawnCount += 1;
      continue;
    }
    if (OUTCOME_HEAL_EVENTS.has(event.eventType) && ownedActor(event.actorId, context)) {
      healCount += 1;
      continue;
    }
    if (OUTCOME_UNIT_LOSS_EVENTS.has(event.eventType) && event.actorId !== null && context.priorUnitIds.has(event.actorId)) {
      unitLossCount += 1;
    }
  }

  return Object.freeze({ grossDeposit, spawnCount, healCount, unitLossCount });
}
