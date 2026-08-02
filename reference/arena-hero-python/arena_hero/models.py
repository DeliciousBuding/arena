"""Immutable models for Arena Hero state and WebSocket messages."""

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from .actions import CommandPlan
from .enums import (
    BeaconStatus,
    CommandSource,
    CoreState,
    Direction,
    HarvestSource,
    PlayerStatus,
    UnitType,
)
from .geometry import Position


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ChampionBeacon(_StateModel):
    """The public Beacon position and its visibility-limited status."""

    position: Position
    status: BeaconStatus | None = None
    carrier_id: UUID | None = None

    @model_validator(mode="after")
    def validate_carrier(self) -> "ChampionBeacon":
        """Require a carrier exactly when a carried Beacon is visible."""

        if self.status is BeaconStatus.CARRIED and self.carrier_id is None:
            raise ValueError("carrier_id is required when status is CARRIED")
        if self.status is not BeaconStatus.CARRIED and self.carrier_id is not None:
            raise ValueError("carrier_id is only valid when status is CARRIED")
        return self


class TerrainView(_StateModel):
    """A batch of visible UUID-less terrain cells."""

    kind: Literal["OBSTACLE", "RESOURCE"]
    positions: Annotated[tuple[Position, ...], Field(min_length=1)]


class CoreView(_StateModel):
    """A controlled or visible Core."""

    kind: Literal["CORE"]
    id: UUID
    controlled: bool
    owner_username: str = Field(min_length=3, max_length=24, pattern=r"^[a-z0-9_]+$")
    position: Position
    hp: int = Field(ge=0)
    shield: int = Field(ge=0)
    state: CoreState
    move_direction: Direction | None = None
    move_progress: int | None = Field(default=None, ge=0)
    move_required_ticks: int | None = Field(default=None, ge=1)
    destination: Position | None = None

    @model_validator(mode="after")
    def validate_movement_fields(self) -> "CoreView":
        """Keep NORMAL and MOVING Core payloads unambiguous."""

        movement = (
            self.move_direction,
            self.move_progress,
            self.move_required_ticks,
            self.destination,
        )
        if self.state is CoreState.MOVING and any(value is None for value in movement):
            raise ValueError("MOVING Core requires all movement fields")
        if self.state is CoreState.NORMAL and any(
            value is not None for value in movement
        ):
            raise ValueError("NORMAL Core cannot contain movement fields")
        return self


class UnitView(_StateModel):
    """A controlled or visible Unit."""

    kind: Literal["UNIT"]
    id: UUID
    controlled: bool
    position: Position
    hp: int = Field(ge=0)
    unit_type: UnitType
    cargo: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_cargo(self) -> "UnitView":
        """Expose cargo only for a controlled Worker."""

        if self.cargo is not None and (
            not self.controlled or self.unit_type is not UnitType.WORKER
        ):
            raise ValueError("cargo is only valid for a controlled Worker")
        return self


WorldObject = Annotated[
    TerrainView | CoreView | UnitView,
    Field(discriminator="kind"),
]


class CoreResourceCapture(_StateModel):
    """Typed values from a ``CORE_RESOURCES_CAPTURED`` result."""

    amount: int = Field(ge=0)
    available: int = Field(ge=1)
    destroyed: int = Field(ge=0)
    capacity: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_distribution(self) -> "CoreResourceCapture":
        """Account for every resource removed from the destroyed Core."""

        if self.amount + self.destroyed != self.available:
            raise ValueError("amount and destroyed must equal available")
        return self


class HealingResult(_StateModel):
    """Typed values from a successful Unit or Core heal result."""

    amount: int = Field(ge=1)
    hp: int = Field(ge=1)
    cost: int = Field(ge=1)

    @model_validator(mode="after")
    def validate_cost(self) -> "HealingResult":
        """Require one resource for every recovered HP."""

        if self.cost != self.amount:
            raise ValueError("healing cost must equal recovered HP")
        return self


class ResolutionEvent(_StateModel):
    """A private result produced while resolving the previous Tick."""

    event_id: UUID
    tick: int = Field(ge=1)
    event_type: str
    reason_code: str | None = None
    actor_id: UUID | None = None
    target_id: UUID | None = None
    position: Position | None = None
    values: dict[str, Any] | None = None

    @property
    def resource_amount(self) -> int | None:
        """Return the amount carried by a resource event, when available."""

        if self.event_type not in {
            "CORE_RESOURCES_CAPTURED",
            "CORE_RESOURCE_OVERFLOW_DESTROYED",
            "DEPOSIT_SUCCEEDED",
            "HARVEST_SUCCEEDED",
            "WORKER_CARGO_DROPPED",
        }:
            return None
        amount = self.values.get("amount") if self.values is not None else None
        return amount if type(amount) is int and amount > 0 else None

    @property
    def core_resource_capture(self) -> CoreResourceCapture | None:
        """Return typed Core loot values when the event is well formed."""

        if self.event_type != "CORE_RESOURCES_CAPTURED" or self.values is None:
            return None
        try:
            return CoreResourceCapture.model_validate(self.values)
        except ValueError:
            return None

    @property
    def healing(self) -> HealingResult | None:
        """Return typed values from a successful Unit or Core heal."""

        if (
            self.event_type
            not in {
                "UNIT_HEAL_SUCCEEDED",
                "CORE_HEAL_SUCCEEDED",
            }
            or self.values is None
        ):
            return None
        try:
            return HealingResult.model_validate(self.values)
        except ValueError:
            return None

    @property
    def harvest_source(self) -> HarvestSource | None:
        """Return the natural-node or dropped-cargo source for a harvest."""

        if self.event_type != "HARVEST_SUCCEEDED" or self.values is None:
            return None
        source = self.values.get("source")
        if not isinstance(source, str):
            return None
        try:
            return HarvestSource(source)
        except ValueError:
            return None


class PlayerState(_StateModel):
    """A complete authoritative player-state replacement."""

    status: PlayerStatus
    respawn_at_tick: int | None = Field(default=None, ge=1)
    resources: int = Field(ge=0)
    population: int = Field(ge=0)
    population_tier: int = Field(ge=0)
    upkeep_next_tick: int = Field(ge=0)
    champion_beacon: ChampionBeacon
    objects: tuple[WorldObject, ...]
    events: tuple[ResolutionEvent, ...]

    @model_validator(mode="after")
    def validate_respawn_tick(self) -> "PlayerState":
        """Require ``respawn_at_tick`` only while respawning."""

        if self.status is PlayerStatus.RESPAWNING and self.respawn_at_tick is None:
            raise ValueError("RESPAWNING state requires respawn_at_tick")
        if self.status is PlayerStatus.ACTIVE and self.respawn_at_tick is not None:
            raise ValueError("ACTIVE state cannot contain respawn_at_tick")
        return self


class Tick(_StateModel):
    """Notice that a new logical Tick has started."""

    tick: int = Field(ge=1)


class Received(_StateModel):
    """The latest canonical complete plan stored for one source."""

    tick: int = Field(ge=1)
    source: CommandSource
    received_at: AwareDatetime
    plan: CommandPlan

    @model_validator(mode="after")
    def validate_plan_tick(self) -> "Received":
        """Require receipt metadata and its plan to reference the same Tick."""

        if self.plan.tick != self.tick:
            raise ValueError("received plan tick does not match receipt tick")
        return self

    @property
    def received_at_datetime(self) -> datetime:
        """Return the timezone-aware receipt timestamp."""

        return self.received_at
