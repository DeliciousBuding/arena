/** Stable public helpers for current Arena Hero game rules. */

export const CORE_RESOURCE_CAPACITY_PER_UNIT = 5;
export const CORE_RESOURCE_MINIMUM_CAPACITY = 10;

/** Core storage capacity for a living Unit population. */
export function coreResourceCapacity(population: number): number {
  if (population < 0) {
    throw new RangeError("population must not be negative");
  }
  return Math.max(CORE_RESOURCE_MINIMUM_CAPACITY, population * CORE_RESOURCE_CAPACITY_PER_UNIT);
}
