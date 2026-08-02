/** W1：wire-level TypeBox schema（协议单源）。
 *
 * 服务端原始协议的字段级校验（判别 + 类型 + 范围），与 domain 层
 * （关系约束：cargo 只在受控 Worker、MOVING Core 字段一致性）分离。
 *
 * 导出：
 * - TypeBox schema（运行时校验 Compile(schema).Check）
 * - toJsonSchema()（JSON.stringify 即标准 JSON Schema，供跨仓库
 *   contracts/generated/*.schema.json 与 Python 侧校验）
 *
 * 兼容性说明：服务端字段可能"缺失或 null"（pydantic 默认 None），
 * 可选字段一律 Type.Optional(Type.Union([T, Type.Null()]))。
 */

import { Type, type Static } from "typebox";
import {
  BeaconStatus,
  CommandSource,
  CoreState,
  Direction,
  HarvestSource,
  PlayerStatus,
  UnitType,
} from "./enums.ts";

export const PositionSchema = Type.Tuple([Type.Integer(), Type.Integer()], {
  description: "网格坐标 [x, y]（有限整数）",
});
export type Position = Static<typeof PositionSchema>;

export const DirectionSchema = Type.Enum(Direction);
export const UnitTypeSchema = Type.Enum(UnitType);
export const PlayerStatusSchema = Type.Enum(PlayerStatus);
export const CoreStateSchema = Type.Enum(CoreState);
export const CommandSourceSchema = Type.Enum(CommandSource);
export const BeaconStatusSchema = Type.Enum(BeaconStatus);
export const HarvestSourceSchema = Type.Enum(HarvestSource);

const Nullable = <T extends Parameters<typeof Type.Optional>[0]>(schema: T) =>
  Type.Optional(Type.Union([schema, Type.Null()]));

// ---------- 世界对象 ----------

export const ChampionBeaconSchema = Type.Object(
  {
    position: PositionSchema,
    status: Nullable(BeaconStatusSchema),
    carrier_id: Nullable(Type.String()),
  },
  { additionalProperties: false },
);
export type ChampionBeacon = Static<typeof ChampionBeaconSchema>;

export const TerrainViewSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("OBSTACLE"), Type.Literal("RESOURCE")]),
    positions: Type.Array(PositionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type TerrainView = Static<typeof TerrainViewSchema>;

export const CoreViewSchema = Type.Object(
  {
    kind: Type.Literal("CORE"),
    id: Type.String(),
    controlled: Type.Boolean(),
    owner_username: Type.String({ minLength: 3, maxLength: 24, pattern: "^[a-z0-9_]+$" }),
    position: PositionSchema,
    hp: Type.Integer({ minimum: 0 }),
    shield: Type.Integer({ minimum: 0 }),
    state: CoreStateSchema,
    move_direction: Nullable(DirectionSchema),
    move_progress: Nullable(Type.Integer({ minimum: 0 })),
    move_required_ticks: Nullable(Type.Integer({ minimum: 1 })),
    destination: Nullable(PositionSchema),
  },
  { additionalProperties: false },
);
export type CoreView = Static<typeof CoreViewSchema>;

export const UnitViewSchema = Type.Object(
  {
    kind: Type.Literal("UNIT"),
    id: Type.String(),
    controlled: Type.Boolean(),
    position: PositionSchema,
    hp: Type.Integer({ minimum: 0 }),
    unit_type: UnitTypeSchema,
    cargo: Nullable(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type UnitView = Static<typeof UnitViewSchema>;

export const WorldObjectSchema = Type.Union([TerrainViewSchema, CoreViewSchema, UnitViewSchema], {
  discriminator: "kind",
});
export type WorldObject = Static<typeof WorldObjectSchema>;

export const CoreResourceCaptureSchema = Type.Object(
  {
    amount: Type.Integer({ minimum: 0 }),
    available: Type.Integer({ minimum: 1 }),
    destroyed: Type.Integer({ minimum: 0 }),
    capacity: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type CoreResourceCapture = Static<typeof CoreResourceCaptureSchema>;

export const HealingResultSchema = Type.Object(
  {
    amount: Type.Integer({ minimum: 1 }),
    hp: Type.Integer({ minimum: 1 }),
    cost: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type HealingResult = Static<typeof HealingResultSchema>;

export const ResolutionEventSchema = Type.Object(
  {
    event_id: Type.String(),
    tick: Type.Integer({ minimum: 1 }),
    event_type: Type.String(),
    reason_code: Nullable(Type.String()),
    actor_id: Nullable(Type.String()),
    target_id: Nullable(Type.String()),
    position: Nullable(PositionSchema),
    values: Nullable(Type.Record(Type.String(), Type.Any())),
  },
  { additionalProperties: false },
);
export type ResolutionEvent = Static<typeof ResolutionEventSchema>;

export const PlayerStateSchema = Type.Object(
  {
    status: PlayerStatusSchema,
    respawn_at_tick: Nullable(Type.Integer({ minimum: 1 })),
    resources: Type.Integer({ minimum: 0 }),
    population: Type.Integer({ minimum: 0 }),
    population_tier: Type.Integer({ minimum: 0 }),
    upkeep_next_tick: Type.Integer({ minimum: 0 }),
    champion_beacon: ChampionBeaconSchema,
    objects: Type.Array(WorldObjectSchema),
    events: Type.Array(ResolutionEventSchema),
  },
  { additionalProperties: false },
);
export type PlayerState = Static<typeof PlayerStateSchema>;

// ---------- 动作与计划 ----------

export const WaitActionSchema = Type.Object({ type: Type.Literal("WAIT") });
export const MoveActionSchema = Type.Object({
  type: Type.Literal("MOVE"),
  direction: DirectionSchema,
});
export const HarvestActionSchema = Type.Object({ type: Type.Literal("HARVEST") });
export const DepositActionSchema = Type.Object({ type: Type.Literal("DEPOSIT") });
export const SweepActionSchema = Type.Object({
  type: Type.Literal("SWEEP"),
  direction: DirectionSchema,
});
export const ShootActionSchema = Type.Object({
  type: Type.Literal("SHOOT"),
  target_id: Type.String(),
  expected_cell: PositionSchema,
});
export const PickupBeaconActionSchema = Type.Object({ type: Type.Literal("PICKUP_BEACON") });
export const DropBeaconActionSchema = Type.Object({ type: Type.Literal("DROP_BEACON") });
export const SelfDestructActionSchema = Type.Object({ type: Type.Literal("SELF_DESTRUCT") });
export const HealActionSchema = Type.Object({ type: Type.Literal("HEAL") });
export const SpawnActionSchema = Type.Object({
  type: Type.Literal("SPAWN"),
  unit_type: UnitTypeSchema,
});
export const RepairShieldActionSchema = Type.Object({ type: Type.Literal("REPAIR_SHIELD") });
export const StartMoveActionSchema = Type.Object({
  type: Type.Literal("START_MOVE"),
  direction: DirectionSchema,
});
export const CancelMoveActionSchema = Type.Object({ type: Type.Literal("CANCEL_MOVE") });

export const UnitActionSchema = Type.Union(
  [
    WaitActionSchema, MoveActionSchema, HarvestActionSchema, DepositActionSchema,
    SweepActionSchema, ShootActionSchema, PickupBeaconActionSchema,
    DropBeaconActionSchema, SelfDestructActionSchema, HealActionSchema,
  ],
  { discriminator: "type" },
);
export const CoreActionSchema = Type.Union(
  [
    WaitActionSchema, SpawnActionSchema, RepairShieldActionSchema,
    StartMoveActionSchema, CancelMoveActionSchema, PickupBeaconActionSchema,
    DropBeaconActionSchema, HealActionSchema,
  ],
  { discriminator: "type" },
);

export const CommandPlanSchema = Type.Object(
  {
    tick: Type.Integer({ minimum: 1 }),
    unit_actions: Type.Record(Type.String(), UnitActionSchema),
    core_action: Nullable(CoreActionSchema),
  },
  { additionalProperties: false },
);
export type CommandPlan = Static<typeof CommandPlanSchema>;

export const AcceptedSchema = Type.Object(
  {
    accepted: Type.Literal(true),
    tick: Type.Integer({ minimum: 1 }),
    source: CommandSourceSchema,
    received_at: Type.String(),
  },
  { additionalProperties: false },
);
export type Accepted = Static<typeof AcceptedSchema>;

// ---------- WS 信封 ----------

export const TickEnvelopeSchema = Type.Object(
  { type: Type.Literal("tick"), data: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const StateEnvelopeSchema = Type.Object(
  { type: Type.Literal("state"), data: PlayerStateSchema },
  { additionalProperties: false },
);
export const ReceivedEnvelopeSchema = Type.Object(
  { type: Type.Literal("received"), data: Type.Any() }, // Received 校验见下（依赖 CommandPlan）
  { additionalProperties: false },
);
export const ReceivedSchema = Type.Object(
  {
    tick: Type.Integer({ minimum: 1 }),
    source: CommandSourceSchema,
    received_at: Type.String(),
    plan: CommandPlanSchema,
  },
  { additionalProperties: false },
);
export type Received = Static<typeof ReceivedSchema>;

export const StreamEnvelopeSchema = Type.Union(
  [TickEnvelopeSchema, StateEnvelopeSchema, ReceivedEnvelopeSchema],
  { discriminator: "type" },
);

// ---------- JSON Schema 生成（契约导出） ----------

/** TypeBox schema → 标准 JSON Schema（JSON.stringify 即产物）。 */
export function toJsonSchema(schema: Parameters<typeof JSON.stringify>[0]): string {
  return JSON.stringify(schema, null, 2);
}
