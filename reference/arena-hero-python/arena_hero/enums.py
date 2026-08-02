"""Public enums used by Arena Hero state and command models."""

from enum import StrEnum


class Direction(StrEnum):
    """A cardinal movement or attack direction."""

    UP = "UP"
    DOWN = "DOWN"
    LEFT = "LEFT"
    RIGHT = "RIGHT"

    @property
    def delta(self) -> tuple[int, int]:
        """Return the direction as an ``(x, y)`` offset."""

        return {
            Direction.UP: (0, -1),
            Direction.DOWN: (0, 1),
            Direction.LEFT: (-1, 0),
            Direction.RIGHT: (1, 0),
        }[self]


class UnitType(StrEnum):
    """A playable Arena Hero unit type."""

    WORKER = "WORKER"
    VANGUARD = "VANGUARD"
    RANGER = "RANGER"


class PlayerStatus(StrEnum):
    """The player's current lifecycle state."""

    ACTIVE = "ACTIVE"
    RESPAWNING = "RESPAWNING"


class CoreState(StrEnum):
    """The Core's current movement state."""

    NORMAL = "NORMAL"
    MOVING = "MOVING"


class CommandSource(StrEnum):
    """The source slot that owns a complete command plan."""

    AGENT = "AGENT"
    MANUAL = "MANUAL"


class BeaconStatus(StrEnum):
    """The visible status of the Champion Beacon."""

    GROUND = "GROUND"
    CARRIED = "CARRIED"


class HarvestSource(StrEnum):
    """The resource source reported by a successful Worker harvest."""

    RESOURCE_NODE = "RESOURCE_NODE"
    DROPPED_CARGO = "DROPPED_CARGO"
