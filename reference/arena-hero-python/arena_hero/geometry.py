"""Coordinate types shared by state and command models."""

from typing import Annotated

from pydantic import Field

_MIN_INT64 = -(2**63)
_MAX_INT64 = 2**63 - 1

Coordinate = Annotated[int, Field(ge=_MIN_INT64, le=_MAX_INT64)]
Position = tuple[Coordinate, Coordinate]
