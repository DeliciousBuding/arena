/** Private event delivery for one player without leaking simulator-only metadata to wire. */

import type { ResolutionEvent } from "../engine/phase.ts";
import type { SimWorld } from "../world/types.ts";

function entityIds(world: SimWorld, playerId: string): Set<string> {
  const ids = new Set<string>();
  const player = world.players.get(playerId);
  if (player?.core !== null && player?.core !== undefined) ids.add(player.core.id);
  for (const unit of player?.units ?? []) ids.add(unit.id);
  return ids;
}

/**
 * Select events visible to one player. An explicit internal recipient takes
 * precedence; otherwise ownership is inferred from before/after entity IDs.
 */
export function privateEventsForPlayer(
  before: SimWorld,
  after: SimWorld,
  playerId: string,
  events: readonly ResolutionEvent[],
): ResolutionEvent[] {
  const ids = entityIds(before, playerId);
  for (const id of entityIds(after, playerId)) ids.add(id);
  return events.filter((event) => {
    if (event.recipientPlayerId !== undefined) return event.recipientPlayerId === playerId;
    return (event.actorId !== null && ids.has(event.actorId)) ||
      (event.targetId !== null && ids.has(event.targetId));
  });
}
