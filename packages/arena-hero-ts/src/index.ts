/** Arena Hero 游戏 SDK 的 TypeScript 实现。
 *
 * fork 自 arena-hero/arena-hero-python（Apache-2.0），协议面逐项对应：
 * - enums/geometry/rules：常量与规则助手
 * - actions/types：数据模型（只读接口 + 窄校验）
 * - protocol：WS 消息解析、计划序列化（与上游逐字节兼容：sort_keys + 紧凑）
 * - client：WebSocket 事件流 + HTTP 命令提交
 * - turn：每 Tick 控制接口（Unit/Worker/Vanguard/Ranger/Core）
 */

export {
  ArenaHeroClient,
  DEFAULT_BASE_URL,
  buildConfig,
  validateIdempotencyKey,
  type ClientConfig,
  type ClientOptions,
  type GameEvent,
} from "./client.ts";
export {
  Direction,
  DIRECTION_DELTA,
  UnitType,
  PlayerStatus,
  CoreState,
  CommandSource,
  BeaconStatus,
  HarvestSource,
  type Direction as DirectionType,
  type UnitType as UnitTypeType,
  type PlayerStatus as PlayerStatusType,
  type CoreState as CoreStateType,
  type CommandSource as CommandSourceType,
  type BeaconStatus as BeaconStatusType,
  type HarvestSource as HarvestSourceType,
} from "./enums.ts";
export type { Position } from "./geometry.ts";
export {
  coreResourceCapacity,
  CORE_RESOURCE_CAPACITY_PER_UNIT,
  CORE_RESOURCE_MINIMUM_CAPACITY,
} from "./rules.ts";
export {
  ArenaHeroError,
  ConfigurationError,
  ProtocolError,
  TransportError,
  AuthenticationError,
  PolicyViolationError,
  TurnClosedError,
  InvalidActionError,
  APIError,
} from "./errors.ts";
export type {
  WaitAction,
  MoveAction,
  HarvestAction,
  DepositAction,
  SweepAction,
  ShootAction,
  PickupBeaconAction,
  DropBeaconAction,
  SelfDestructAction,
  HealAction,
  SpawnAction,
  RepairShieldAction,
  StartMoveAction,
  CancelMoveAction,
  UnitAction,
  CoreAction,
  CommandPlan,
  Accepted,
} from "./actions.ts";
export type {
  ChampionBeacon,
  TerrainView,
  CoreView,
  UnitView,
  WorldObject,
  CoreResourceCapture,
  HealingResult,
  ResolutionEvent,
  PlayerState,
  Tick,
  Received,
} from "./types.ts";
export {
  eventResourceAmount,
  eventCoreResourceCapture,
  eventHealing,
  eventHarvestSource,
} from "./types.ts";
export { parseStreamMessage, encodePlan, parseAccepted, apiError } from "./protocol.ts";
export { Turn, Unit, Worker, Vanguard, Ranger, Core, type ObservedEntity } from "./turn.ts";
export {
  PlayerStateSchema, CommandPlanSchema, AcceptedSchema, ReceivedSchema,
  StreamEnvelopeSchema, WorldObjectSchema, UnitActionSchema, CoreActionSchema,
  toJsonSchema, type Position as WirePosition,
} from "./wire-schema.ts";
