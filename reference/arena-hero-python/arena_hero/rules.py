"""Stable public helpers for current Arena Hero game rules."""

from typing import Final

CORE_RESOURCE_CAPACITY_PER_UNIT: Final = 5
CORE_RESOURCE_MINIMUM_CAPACITY: Final = 10


def core_resource_capacity(population: int) -> int:
    """Return the Core storage capacity for a living Unit population."""

    if population < 0:
        raise ValueError("population must not be negative")
    return max(
        CORE_RESOURCE_MINIMUM_CAPACITY,
        population * CORE_RESOURCE_CAPACITY_PER_UNIT,
    )
