/** Public enums used by Arena Hero state and command models. */

/** A cardinal movement or attack direction. */
export const Direction = {
  UP: "UP",
  DOWN: "DOWN",
  LEFT: "LEFT",
  RIGHT: "RIGHT",
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

/** Direction as an (x, y) offset. */
export const DIRECTION_DELTA: Record<Direction, readonly [number, number]> = {
  [Direction.UP]: [0, -1],
  [Direction.DOWN]: [0, 1],
  [Direction.LEFT]: [-1, 0],
  [Direction.RIGHT]: [1, 0],
};

/** A playable Arena Hero unit type. */
export const UnitType = {
  WORKER: "WORKER",
  VANGUARD: "VANGUARD",
  RANGER: "RANGER",
} as const;
export type UnitType = (typeof UnitType)[keyof typeof UnitType];

/** The player's current lifecycle state. */
export const PlayerStatus = {
  ACTIVE: "ACTIVE",
  RESPAWNING: "RESPAWNING",
} as const;
export type PlayerStatus = (typeof PlayerStatus)[keyof typeof PlayerStatus];

/** The Core's current movement state. */
export const CoreState = {
  NORMAL: "NORMAL",
  MOVING: "MOVING",
} as const;
export type CoreState = (typeof CoreState)[keyof typeof CoreState];

/** The source slot that owns a complete command plan. */
export const CommandSource = {
  AGENT: "AGENT",
  MANUAL: "MANUAL",
} as const;
export type CommandSource = (typeof CommandSource)[keyof typeof CommandSource];

/** The visible status of the Champion Beacon. */
export const BeaconStatus = {
  GROUND: "GROUND",
  CARRIED: "CARRIED",
} as const;
export type BeaconStatus = (typeof BeaconStatus)[keyof typeof BeaconStatus];

/** The resource source reported by a successful Worker harvest. */
export const HarvestSource = {
  RESOURCE_NODE: "RESOURCE_NODE",
  DROPPED_CARGO: "DROPPED_CARGO",
} as const;
export type HarvestSource = (typeof HarvestSource)[keyof typeof HarvestSource];
