"""Exceptions raised by the Arena Hero SDK."""

from collections.abc import Mapping
from typing import Any


class ArenaHeroError(Exception):
    """Base class for all SDK errors."""


class ConfigurationError(ArenaHeroError, ValueError):
    """The client was initialized with an invalid option."""


class ProtocolError(ArenaHeroError):
    """The server sent a message that violates the public protocol."""


class TransportError(ArenaHeroError):
    """A network operation failed after safe retries were exhausted."""


class AuthenticationError(ArenaHeroError):
    """The server rejected the API key."""


class PolicyViolationError(ArenaHeroError):
    """The WebSocket connection closed with policy-violation code 1008."""


class TurnClosedError(ArenaHeroError):
    """An action was added to a Turn that is no longer current."""


class InvalidActionError(ArenaHeroError, ValueError):
    """An action cannot be represented by the Arena Hero command protocol."""


class APIError(ArenaHeroError):
    """The command API rejected a request."""

    def __init__(
        self,
        *,
        status_code: int,
        error: str,
        message: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        """Initialize a safe, structured API error."""

        self.status_code = status_code
        self.error = error
        self.message = message
        self.details = dict(details or {})
        description = f"{status_code} {error}"
        if message:
            description = f"{description}: {message}"
        super().__init__(description)
