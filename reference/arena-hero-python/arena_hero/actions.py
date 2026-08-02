"""Typed command actions and complete command plans."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from .enums import CommandSource, Direction, UnitType
from .geometry import Position


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class WaitAction(_StrictModel):
    """Explicitly do nothing for this Tick."""

    type: Literal["WAIT"] = "WAIT"


class MoveAction(_StrictModel):
    """Move a Unit one cell."""

    type: Literal["MOVE"] = "MOVE"
    direction: Direction


class HarvestAction(_StrictModel):
    """Harvest resources with a Worker."""

    type: Literal["HARVEST"] = "HARVEST"


class DepositAction(_StrictModel):
    """Deposit Worker cargo into the Core."""

    type: Literal["DEPOSIT"] = "DEPOSIT"


class SweepAction(_StrictModel):
    """Sweep an adjacent cell with a Vanguard."""

    type: Literal["SWEEP"] = "SWEEP"
    direction: Direction


class ShootAction(_StrictModel):
    """Shoot an expected target cell with a Ranger in an eight-direction line."""

    type: Literal["SHOOT"] = "SHOOT"
    target_id: UUID
    expected_cell: Position


class PickupBeaconAction(_StrictModel):
    """Pick up the Champion Beacon on the current cell."""

    type: Literal["PICKUP_BEACON"] = "PICKUP_BEACON"


class DropBeaconAction(_StrictModel):
    """Drop the Champion Beacon on the current cell."""

    type: Literal["DROP_BEACON"] = "DROP_BEACON"


class SelfDestructAction(_StrictModel):
    """Remove a Unit before upkeep without refund or damage."""

    type: Literal["SELF_DESTRUCT"] = "SELF_DESTRUCT"


class HealAction(_StrictModel):
    """Recover HP after combat by spending Core resources."""

    type: Literal["HEAL"] = "HEAL"


class SpawnAction(_StrictModel):
    """Spawn one Unit from the Core."""

    type: Literal["SPAWN"] = "SPAWN"
    unit_type: UnitType


class RepairShieldAction(_StrictModel):
    """Spend one resource to restore one Core shield."""

    type: Literal["REPAIR_SHIELD"] = "REPAIR_SHIELD"


class StartMoveAction(_StrictModel):
    """Start moving the Core in one direction."""

    type: Literal["START_MOVE"] = "START_MOVE"
    direction: Direction


class CancelMoveAction(_StrictModel):
    """Cancel the Core's current movement."""

    type: Literal["CANCEL_MOVE"] = "CANCEL_MOVE"


UnitAction = Annotated[
    WaitAction
    | MoveAction
    | HarvestAction
    | DepositAction
    | SweepAction
    | ShootAction
    | PickupBeaconAction
    | DropBeaconAction
    | SelfDestructAction
    | HealAction,
    Field(discriminator="type"),
]

CoreAction = Annotated[
    WaitAction
    | SpawnAction
    | RepairShieldAction
    | StartMoveAction
    | CancelMoveAction
    | PickupBeaconAction
    | DropBeaconAction
    | HealAction,
    Field(discriminator="type"),
]


class CommandPlan(_StrictModel):
    """A complete replacement plan for one source and Tick."""

    tick: int = Field(ge=1)
    unit_actions: dict[UUID, UnitAction] = Field(default_factory=dict)
    core_action: CoreAction | None = None


class Accepted(_StrictModel):
    """HTTP acknowledgement that a complete plan was persisted."""

    accepted: Literal[True]
    tick: int = Field(ge=1)
    source: CommandSource
    received_at: AwareDatetime
