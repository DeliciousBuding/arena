/** Per-Tick 控制接口：Turn / Unit / Worker / Vanguard / Ranger / Core。
 *
 * 对应上游 turn.py：builder 模式收集动作，submit 时构建完整计划。
 * 动作按 unit id 字符串排序（与上游 sorted(str) 一致）。
 */

import type {
  Accepted,
  CancelMoveAction,
  CommandPlan,
  CoreAction,
  DepositAction,
  DropBeaconAction,
  HarvestAction,
  HealAction,
  MoveAction,
  PickupBeaconAction,
  RepairShieldAction,
  SelfDestructAction,
  ShootAction,
  SpawnAction,
  StartMoveAction,
  SweepAction,
  UnitAction,
  WaitAction,
} from "./actions.ts";
import type { Direction, UnitType } from "./enums.ts";
import { InvalidActionError, TurnClosedError } from "./errors.ts";
import type { Position } from "./geometry.ts";
import { coreResourceCapacity } from "./rules.ts";
import type {
  ChampionBeacon,
  CoreView,
  PlayerState,
  ResolutionEvent,
  TerrainView,
  UnitView,
} from "./types.ts";
import { CoreState, UnitType as UT } from "./enums.ts";

export type ObservedEntity = CoreView | UnitView;
type Submitter = (plan: CommandPlan, idempotencyKey: string | null) => Promise<Accepted>;

class PlanBuilder {
  readonly tick: number;
  unitActions: Record<string, UnitAction> = {};
  coreAction: CoreAction | null = null;
  closed = false;

  constructor(tick: number) {
    this.tick = tick;
  }

  ensureOpen(): void {
    if (this.closed) {
      throw new TurnClosedError("this Turn is no longer current");
    }
  }

  build(): CommandPlan {
    this.ensureOpen();
    const ordered: Record<string, UnitAction> = {};
    for (const id of Object.keys(this.unitActions).sort()) {
      ordered[id] = this.unitActions[id];
    }
    return { tick: this.tick, unit_actions: ordered, core_action: this.coreAction };
  }
}

/** Common control interface shared by all owned Units. */
export class Unit {
  protected readonly view: UnitView;
  protected readonly builder: PlanBuilder;

  constructor(view: UnitView, builder: PlanBuilder) {
    this.view = view;
    this.builder = builder;
  }

  get id(): string {
    return this.view.id;
  }

  get position(): Position {
    return this.view.position;
  }

  get hp(): number {
    return this.view.hp;
  }

  get unitType(): UnitType {
    return this.view.unit_type;
  }

  move(direction: Direction): void {
    this._set({ type: "MOVE", direction } satisfies MoveAction);
  }

  pickupBeacon(): void {
    this._set({ type: "PICKUP_BEACON" } satisfies PickupBeaconAction);
  }

  dropBeacon(): void {
    this._set({ type: "DROP_BEACON" } satisfies DropBeaconAction);
  }

  /** 移除本 Unit（upkeep 前）；Worker 的 cargo 掉落在当前格。 */
  selfDestruct(): void {
    this._set({ type: "SELF_DESTRUCT" } satisfies SelfDestructAction);
  }

  /** 战后在静止的 Core 处恢复 HP。 */
  heal(): void {
    this._set({ type: "HEAL" } satisfies HealAction);
  }

  wait(): void {
    this._set({ type: "WAIT" } satisfies WaitAction);
  }

  clearAction(): void {
    this.builder.ensureOpen();
    delete this.builder.unitActions[this.id];
  }

  protected _set(action: UnitAction): void {
    this.builder.ensureOpen();
    this.builder.unitActions[this.id] = action;
  }
}

/** Control interface for an owned Worker. */
export class Worker extends Unit {
  get cargo(): number {
    return this.view.cargo ?? 0;
  }

  harvest(): void {
    this._set({ type: "HARVEST" } satisfies HarvestAction);
  }

  deposit(): void {
    this._set({ type: "DEPOSIT" } satisfies DepositAction);
  }
}

/** Control interface for an owned Vanguard. */
export class Vanguard extends Unit {
  sweep(direction: Direction): void {
    this._set({ type: "SWEEP", direction } satisfies SweepAction);
  }
}

/** Control interface for an owned Ranger. */
export class Ranger extends Unit {
  shoot(target: string | Unit | Core | UnitView | CoreView, expectedCell?: Position): void {
    let targetId: string;
    let targetCell: Position;
    if (typeof target === "string") {
      if (!/^[0-9a-fA-F-]{36}$/.test(target)) {
        throw new InvalidActionError("target must be a valid UUID");
      }
      if (expectedCell === undefined) {
        throw new InvalidActionError("expected_cell is required when target is only a UUID");
      }
      targetId = target;
      targetCell = expectedCell;
    } else if (target instanceof Unit || target instanceof Core) {
      targetId = target.id;
      targetCell = target.position;
    } else {
      targetId = target.id;
      targetCell = target.position;
    }
    this._set({ type: "SHOOT", target_id: targetId, expected_cell: targetCell } satisfies ShootAction);
  }
}

/** Control interface for the player's owned Core. */
export class Core {
  private readonly view: CoreView;
  private readonly builder: PlanBuilder;

  constructor(view: CoreView, builder: PlanBuilder) {
    this.view = view;
    this.builder = builder;
  }

  get id(): string {
    return this.view.id;
  }

  get position(): Position {
    return this.view.position;
  }

  get hp(): number {
    return this.view.hp;
  }

  get shield(): number {
    return this.view.shield;
  }

  get ownerUsername(): string {
    return this.view.owner_username;
  }

  spawn(unitType: UnitType): void {
    this._set({ type: "SPAWN", unit_type: unitType } satisfies SpawnAction);
  }

  repairShield(): void {
    this._set({ type: "REPAIR_SHIELD" } satisfies RepairShieldAction);
  }

  heal(): void {
    this._set({ type: "HEAL" } satisfies HealAction);
  }

  startMove(direction: Direction): void {
    this._set({ type: "START_MOVE", direction } satisfies StartMoveAction);
  }

  cancelMove(): void {
    this._set({ type: "CANCEL_MOVE" } satisfies CancelMoveAction);
  }

  pickupBeacon(): void {
    this._set({ type: "PICKUP_BEACON" } satisfies PickupBeaconAction);
  }

  dropBeacon(): void {
    this._set({ type: "DROP_BEACON" } satisfies DropBeaconAction);
  }

  wait(): void {
    this._set({ type: "WAIT" } satisfies WaitAction);
  }

  clearAction(): void {
    this.builder.ensureOpen();
    this.builder.coreAction = null;
  }

  private _set(action: CoreAction): void {
    this.builder.ensureOpen();
    this.builder.coreAction = action;
  }
}

/** 可行动的 player-state 快照。 */
export class Turn {
  readonly tick: number;
  readonly state: PlayerState;
  readonly units: readonly Unit[];
  readonly workers: readonly Worker[];
  readonly vanguards: readonly Vanguard[];
  readonly rangers: readonly Ranger[];
  readonly core: Core | null;
  readonly visibleEnemies: readonly ObservedEntity[];
  readonly terrain: readonly TerrainView[];
  readonly obstacleCells: ReadonlySet<string>;
  readonly resourceCells: ReadonlySet<string>;

  private readonly builder: PlanBuilder;
  private readonly submitter: Submitter;
  private readonly unitsById: ReadonlyMap<string, Unit>;

  constructor(tick: number, state: PlayerState, submitter: Submitter) {
    this.tick = tick;
    this.state = state;
    this.submitter = submitter;
    this.builder = new PlanBuilder(tick);

    const units: Unit[] = [];
    const workers: Worker[] = [];
    const vanguards: Vanguard[] = [];
    const rangers: Ranger[] = [];
    const enemies: ObservedEntity[] = [];
    const terrain: TerrainView[] = [];
    let core: Core | null = null;

    for (const obj of state.objects) {
      if (obj.kind === "OBSTACLE" || obj.kind === "RESOURCE") {
        terrain.push(obj);
      } else if (obj.kind === "CORE") {
        if (obj.controlled) {
          core = new Core(obj, this.builder);
        } else {
          enemies.push(obj);
        }
      } else if ("unit_type" in obj) {
        if (obj.controlled) {
          const unit = this._unitController(obj);
          units.push(unit);
          if (unit instanceof Worker) {
            workers.push(unit);
          } else if (unit instanceof Vanguard) {
            vanguards.push(unit);
          } else if (unit instanceof Ranger) {
            rangers.push(unit);
          }
        } else {
          enemies.push(obj);
        }
      }
    }

    this.units = units;
    this.workers = workers;
    this.vanguards = vanguards;
    this.rangers = rangers;
    this.core = core;
    this.visibleEnemies = enemies;
    this.terrain = terrain;
    const obstacleCells = new Set<string>();
    const resourceCells = new Set<string>();
    for (const batch of terrain) {
      for (const [x, y] of batch.positions) {
        (batch.kind === "OBSTACLE" ? obstacleCells : resourceCells).add(`${x},${y}`);
      }
    }
    this.obstacleCells = obstacleCells;
    this.resourceCells = resourceCells;
    this.unitsById = new Map(units.map((u) => [u.id, u]));
  }

  get resources(): number {
    return this.state.resources;
  }

  /** 当前 Core 容量（含 10 资源下限）。 */
  get resourceCapacity(): number {
    return coreResourceCapacity(this.state.population);
  }

  /** Core 还能接受多少资源。 */
  get resourceSpace(): number {
    return Math.max(0, this.resourceCapacity - this.state.resources);
  }

  get beacon(): ChampionBeacon {
    return this.state.champion_beacon;
  }

  get events(): readonly ResolutionEvent[] {
    return this.state.events;
  }

  /** 当前排队等待提交的完整计划。 */
  get plan(): CommandPlan {
    return this.builder.build();
  }

  unit(unitId: string): Unit {
    const unit = this.unitsById.get(unitId);
    if (unit === undefined) {
      throw new InvalidActionError(`unknown owned Unit: ${unitId}`);
    }
    return unit;
  }

  clear(): void {
    this.builder.ensureOpen();
    this.builder.unitActions = {};
    this.builder.coreAction = null;
  }

  /** 用外部计划整体替换排队计划（编排层决策注入，如 arena-agent runtime loop）。 */
  replace(plan: CommandPlan): void {
    this.builder.ensureOpen();
    this.builder.unitActions = { ...plan.unit_actions };
    this.builder.coreAction = plan.core_action;
  }

  /** 提交当前排队计划。 */
  async submit(options: { idempotencyKey?: string | null } = {}): Promise<Accepted> {
    return this.submitter(this.plan, options.idempotencyKey ?? null);
  }

  _seal(): void {
    this.builder.closed = true;
  }

  private _unitController(view: UnitView): Unit {
    if (view.unit_type === UT.WORKER) {
      return new Worker(view, this.builder);
    }
    if (view.unit_type === UT.VANGUARD) {
      return new Vanguard(view, this.builder);
    }
    return new Ranger(view, this.builder);
  }
}
