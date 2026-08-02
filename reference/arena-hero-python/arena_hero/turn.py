"""Per-Tick control interfaces for every playable Arena Hero object."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from types import MappingProxyType
from typing import TypeAlias
from uuid import UUID

from .actions import (
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
)
from .enums import Direction, UnitType
from .errors import InvalidActionError, TurnClosedError
from .geometry import Position
from .models import (
    ChampionBeacon,
    CoreView,
    PlayerState,
    ResolutionEvent,
    TerrainView,
    UnitView,
)
from .rules import core_resource_capacity

ObservedEntity: TypeAlias = CoreView | UnitView
_SyncSubmitter = Callable[[CommandPlan, str | None], Accepted]
_AsyncSubmitter = Callable[[CommandPlan, str | None], Awaitable[Accepted]]


class _PlanBuilder:
    def __init__(self, tick: int) -> None:
        self.tick = tick
        self.unit_actions: dict[UUID, UnitAction] = {}
        self.core_action: CoreAction | None = None
        self.closed = False

    def ensure_open(self) -> None:
        if self.closed:
            raise TurnClosedError("this Turn is no longer current")

    def build(self) -> CommandPlan:
        self.ensure_open()
        ordered_actions = {
            unit_id: self.unit_actions[unit_id]
            for unit_id in sorted(self.unit_actions, key=str)
        }
        return CommandPlan(
            tick=self.tick,
            unit_actions=ordered_actions,
            core_action=self.core_action,
        )


class Unit:
    """Common control interface shared by all owned Units."""

    def __init__(self, view: UnitView, builder: _PlanBuilder) -> None:
        self._view = view
        self._builder = builder

    @property
    def view(self) -> UnitView:
        """Return the immutable authoritative Unit state."""

        return self._view

    @property
    def id(self) -> UUID:
        """Return the Unit's stable identifier."""

        return self._view.id

    @property
    def position(self) -> Position:
        """Return the Unit's current cell."""

        return self._view.position

    @property
    def hp(self) -> int:
        """Return the Unit's current hit points."""

        return self._view.hp

    @property
    def unit_type(self) -> UnitType:
        """Return the Unit's type."""

        return self._view.unit_type

    def move(self, direction: Direction) -> None:
        """Queue a one-cell move."""

        self._set(MoveAction(direction=direction))

    def pickup_beacon(self) -> None:
        """Queue a Champion Beacon pickup."""

        self._set(PickupBeaconAction())

    def drop_beacon(self) -> None:
        """Queue a Champion Beacon drop."""

        self._set(DropBeaconAction())

    def self_destruct(self) -> None:
        """Remove this Unit before upkeep; Worker cargo drops on its final cell."""

        self._set(SelfDestructAction())

    def heal(self) -> None:
        """Queue post-combat HP recovery at the Unit's stationary Core."""

        self._set(HealAction())

    def wait(self) -> None:
        """Queue an explicit WAIT."""

        self._set(WaitAction())

    def clear_action(self) -> None:
        """Remove this Unit's queued action."""

        self._builder.ensure_open()
        self._builder.unit_actions.pop(self.id, None)

    def _set(self, action: UnitAction) -> None:
        self._builder.ensure_open()
        self._builder.unit_actions[self.id] = action


class Worker(Unit):
    """Control interface for an owned Worker."""

    @property
    def cargo(self) -> int:
        """Return the Worker's carried resources."""

        return self.view.cargo or 0

    def harvest(self) -> None:
        """Queue a resource harvest."""

        self._set(HarvestAction())

    def deposit(self) -> None:
        """Queue a deposit up to the Core's remaining storage capacity."""

        self._set(DepositAction())


class Vanguard(Unit):
    """Control interface for an owned Vanguard."""

    def sweep(self, direction: Direction) -> None:
        """Queue a sweep into one adjacent cell."""

        self._set(SweepAction(direction=direction))


class Ranger(Unit):
    """Control interface for an owned Ranger."""

    def shoot(
        self,
        target: UUID | str | Unit | Core | UnitView | CoreView,
        *,
        expected_cell: Position | None = None,
    ) -> None:
        """Queue a shot at a target and its expected cell.

        Passing a visible Unit, Core, or controller derives both required wire
        fields. Passing a UUID or UUID string requires ``expected_cell``.
        The server resolves horizontal, vertical, or exact 45-degree diagonal
        shots at range 1-3; this method does not prevalidate that geometry.
        """

        if isinstance(target, (Unit, Core, UnitView, CoreView)):
            target_id = target.id
            target_cell = target.position
        else:
            try:
                target_id = target if isinstance(target, UUID) else UUID(target)
            except ValueError as exc:
                raise InvalidActionError("target must be a valid UUID") from exc
            if expected_cell is None:
                raise InvalidActionError(
                    "expected_cell is required when target is only a UUID"
                )
            target_cell = expected_cell
        if expected_cell is not None:
            target_cell = expected_cell
        self._set(ShootAction(target_id=target_id, expected_cell=target_cell))


class Core:
    """Control interface for the player's owned Core."""

    def __init__(self, view: CoreView, builder: _PlanBuilder) -> None:
        self._view = view
        self._builder = builder

    @property
    def view(self) -> CoreView:
        """Return the immutable authoritative Core state."""

        return self._view

    @property
    def id(self) -> UUID:
        """Return the Core's stable identifier."""

        return self._view.id

    @property
    def position(self) -> Position:
        """Return the Core's current cell."""

        return self._view.position

    @property
    def hp(self) -> int:
        """Return the Core's current hit points."""

        return self._view.hp

    @property
    def shield(self) -> int:
        """Return the Core's current shield."""

        return self._view.shield

    @property
    def owner_username(self) -> str:
        """Return the username of the player who owns this Core."""

        return self._view.owner_username

    def spawn(self, unit_type: UnitType) -> None:
        """Queue one Unit spawn."""

        self._set(SpawnAction(unit_type=unit_type))

    def repair_shield(self) -> None:
        """Queue one shield repair."""

        self._set(RepairShieldAction())

    def heal(self) -> None:
        """Queue post-combat Core HP recovery."""

        self._set(HealAction())

    def start_move(self, direction: Direction) -> None:
        """Queue the start of Core movement."""

        self._set(StartMoveAction(direction=direction))

    def cancel_move(self) -> None:
        """Queue cancellation of Core movement."""

        self._set(CancelMoveAction())

    def pickup_beacon(self) -> None:
        """Queue a Champion Beacon pickup."""

        self._set(PickupBeaconAction())

    def drop_beacon(self) -> None:
        """Queue a Champion Beacon drop."""

        self._set(DropBeaconAction())

    def wait(self) -> None:
        """Queue an explicit WAIT."""

        self._set(WaitAction())

    def clear_action(self) -> None:
        """Remove the queued Core action."""

        self._builder.ensure_open()
        self._builder.core_action = None

    def _set(self, action: CoreAction) -> None:
        self._builder.ensure_open()
        self._builder.core_action = action


class _TurnBase:
    def __init__(self, *, tick: int, state: PlayerState) -> None:
        self.tick = tick
        self.state = state
        self._builder = _PlanBuilder(tick)
        units: list[Unit] = []
        workers: list[Worker] = []
        vanguards: list[Vanguard] = []
        rangers: list[Ranger] = []
        enemies: list[ObservedEntity] = []
        terrain: list[TerrainView] = []
        core: Core | None = None

        for obj in state.objects:
            if isinstance(obj, TerrainView):
                terrain.append(obj)
            elif isinstance(obj, CoreView):
                if obj.controlled:
                    core = Core(obj, self._builder)
                else:
                    enemies.append(obj)
            elif obj.controlled:
                unit = self._unit_controller(obj)
                units.append(unit)
                if isinstance(unit, Worker):
                    workers.append(unit)
                elif isinstance(unit, Vanguard):
                    vanguards.append(unit)
                elif isinstance(unit, Ranger):
                    rangers.append(unit)
            else:
                enemies.append(obj)

        self.units = tuple(units)
        self.workers = tuple(workers)
        self.vanguards = tuple(vanguards)
        self.rangers = tuple(rangers)
        self.core = core
        self.visible_enemies = tuple(enemies)
        self.terrain = tuple(terrain)
        self.obstacle_cells = frozenset(
            position
            for batch in terrain
            if batch.kind == "OBSTACLE"
            for position in batch.positions
        )
        self.resource_cells = frozenset(
            position
            for batch in terrain
            if batch.kind == "RESOURCE"
            for position in batch.positions
        )
        self._units_by_id = MappingProxyType({unit.id: unit for unit in units})

    def _unit_controller(self, view: UnitView) -> Unit:
        if view.unit_type is UnitType.WORKER:
            return Worker(view, self._builder)
        if view.unit_type is UnitType.VANGUARD:
            return Vanguard(view, self._builder)
        return Ranger(view, self._builder)

    @property
    def resources(self) -> int:
        """Return resources currently stored in the Core."""

        return self.state.resources

    @property
    def resource_capacity(self) -> int:
        """Return the current Core capacity with its ten-resource minimum."""

        return core_resource_capacity(self.state.population)

    @property
    def resource_space(self) -> int:
        """Return how many more resources the Core can currently accept."""

        return max(0, self.resource_capacity - self.resources)

    @property
    def beacon(self) -> ChampionBeacon:
        """Return the current Champion Beacon view."""

        return self.state.champion_beacon

    @property
    def events(self) -> tuple[ResolutionEvent, ...]:
        """Return private resolution results from the previous Tick."""

        return self.state.events

    @property
    def plan(self) -> CommandPlan:
        """Return the complete plan currently queued for submission."""

        return self._builder.build()

    def unit(self, unit_id: UUID | str) -> Unit:
        """Find an owned Unit by UUID."""

        try:
            key = unit_id if isinstance(unit_id, UUID) else UUID(unit_id)
            return self._units_by_id[key]
        except (KeyError, ValueError) as exc:
            raise InvalidActionError(f"unknown owned Unit: {unit_id}") from exc

    def clear(self) -> None:
        """Remove all queued Unit and Core actions."""

        self._builder.ensure_open()
        self._builder.unit_actions.clear()
        self._builder.core_action = None

    def _seal(self) -> None:
        self._builder.closed = True


class Turn(_TurnBase):
    """An actionable synchronous player-state snapshot."""

    def __init__(
        self,
        *,
        tick: int,
        state: PlayerState,
        submitter: _SyncSubmitter,
    ) -> None:
        super().__init__(tick=tick, state=state)
        self._submitter = submitter

    def submit(self, *, idempotency_key: str | None = None) -> Accepted:
        """Submit the complete plan currently queued on this Turn."""

        return self._submitter(self.plan, idempotency_key)


class AsyncTurn(_TurnBase):
    """An actionable asynchronous player-state snapshot."""

    def __init__(
        self,
        *,
        tick: int,
        state: PlayerState,
        submitter: _AsyncSubmitter,
    ) -> None:
        super().__init__(tick=tick, state=state)
        self._submitter = submitter

    async def submit(self, *, idempotency_key: str | None = None) -> Accepted:
        """Asynchronously submit the complete plan queued on this Turn."""

        return await self._submitter(self.plan, idempotency_key)
