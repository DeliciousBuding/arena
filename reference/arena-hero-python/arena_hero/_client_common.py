"""Shared client configuration and retry helpers."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from random import SystemRandom
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from websockets.exceptions import ConnectionClosed, InvalidStatus

from .errors import (
    AuthenticationError,
    ConfigurationError,
    PolicyViolationError,
    TransportError,
)

DEFAULT_BASE_URL = "https://api.arenahero.io"
COMMAND_PATH = "/api/v1/game/commands"
WEBSOCKET_PATH = "/api/v1/game/ws"
USER_AGENT = "arena-hero-python/0.1.0"
_SYSTEM_RANDOM = SystemRandom()


@dataclass(frozen=True, slots=True)
class ClientConfig:
    """Validated connection options shared by both clients."""

    api_key: str = field(repr=False)
    base_url: str
    websocket_url: str
    request_timeout: float
    request_retries: int
    reconnect_min_delay: float
    reconnect_max_delay: float
    max_message_size: int

    @property
    def command_url(self) -> str:
        """Return the complete command endpoint."""

        return f"{self.base_url}{COMMAND_PATH}"

    @property
    def headers(self) -> dict[str, str]:
        """Build authenticated headers without retaining a second secret copy."""

        return {
            "Authorization": f"Bearer {self.api_key}",
            "User-Agent": USER_AGENT,
        }


def build_config(
    *,
    api_key: str,
    base_url: str,
    websocket_url: str | None,
    request_timeout: float,
    request_retries: int,
    reconnect_min_delay: float,
    reconnect_max_delay: float,
    max_message_size: int,
) -> ClientConfig:
    """Validate public constructor options and derive the WebSocket URL."""

    if not api_key or not api_key.strip():
        raise ConfigurationError("api_key must be a non-empty string")
    try:
        encoded_api_key = api_key.encode("ascii", errors="strict")
    except UnicodeEncodeError as exc:
        raise ConfigurationError("api_key must contain visible ASCII only") from exc
    if any(byte < 0x21 or byte > 0x7E for byte in encoded_api_key):
        raise ConfigurationError("api_key must contain visible ASCII only")
    normalized_base = _normalize_http_url(base_url)
    normalized_websocket = (
        _normalize_websocket_url(websocket_url)
        if websocket_url is not None
        else _derive_websocket_url(normalized_base)
    )
    if request_timeout <= 0:
        raise ConfigurationError("request_timeout must be positive")
    if request_retries < 0:
        raise ConfigurationError("request_retries cannot be negative")
    if reconnect_min_delay <= 0:
        raise ConfigurationError("reconnect_min_delay must be positive")
    if reconnect_max_delay < reconnect_min_delay:
        raise ConfigurationError(
            "reconnect_max_delay cannot be less than reconnect_min_delay"
        )
    if max_message_size <= 0:
        raise ConfigurationError("max_message_size must be positive")
    return ClientConfig(
        api_key=api_key,
        base_url=normalized_base,
        websocket_url=normalized_websocket,
        request_timeout=request_timeout,
        request_retries=request_retries,
        reconnect_min_delay=reconnect_min_delay,
        reconnect_max_delay=reconnect_max_delay,
        max_message_size=max_message_size,
    )


def validate_idempotency_key(key: str | None, tick: int) -> str:
    """Return a valid caller key or generate a unique key."""

    if key is None:
        return f"arena-{tick}-{uuid4().hex}"
    try:
        encoded = key.encode("ascii", errors="strict")
    except UnicodeEncodeError as exc:
        raise ConfigurationError(
            "idempotency_key must contain only visible ASCII without spaces"
        ) from exc
    if not 8 <= len(encoded) <= 128:
        raise ConfigurationError(
            "idempotency_key must contain 8 to 128 visible ASCII bytes"
        )
    if any(byte < 0x21 or byte > 0x7E for byte in encoded):
        raise ConfigurationError(
            "idempotency_key must contain only visible ASCII without spaces"
        )
    return key


def close_code(exc: ConnectionClosed) -> int | None:
    """Read a WebSocket close code without deprecated compatibility accessors."""

    return exc.rcvd.code if exc.rcvd is not None else None


def check_close_exception(exc: ConnectionClosed) -> None:
    """Raise for non-retryable WebSocket close codes."""

    if close_code(exc) == 1008:
        raise PolicyViolationError(
            "WebSocket closed with 1008 Policy Violation"
        ) from exc


def check_handshake_exception(exc: InvalidStatus) -> float | None:
    """Raise for terminal handshake errors or return a retry delay."""

    status = exc.response.status_code
    if status in {401, 403}:
        raise AuthenticationError(
            f"WebSocket authorization failed with HTTP {status}"
        ) from exc
    if status == 409:
        return max(1.0, _retry_after(exc.response.headers))
    if status == 429:
        return max(1.0, _retry_after(exc.response.headers))
    if 500 <= status <= 599:
        return None
    raise TransportError(f"WebSocket handshake failed with HTTP {status}") from exc


def jitter(delay: float) -> float:
    """Apply non-predictable reconnect jitter to a delay."""

    return _SYSTEM_RANDOM.uniform(0.8, 1.2) * delay


def _normalize_http_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ConfigurationError(
            "base_url must be an http(s) origin without credentials, query, or fragment"
        )
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _normalize_websocket_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    if (
        parsed.scheme not in {"ws", "wss"}
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ConfigurationError(
            "websocket_url must be a ws(s) URL without credentials, query, or fragment"
        )
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path or WEBSOCKET_PATH, "", "")
    )


def _derive_websocket_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = f"{parsed.path.rstrip('/')}{WEBSOCKET_PATH}"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def _retry_after(headers: Mapping[str, str]) -> float:
    raw_value = headers.get("Retry-After")
    if raw_value is None:
        return 0.0
    try:
        delay = float(raw_value)
    except ValueError:
        return 0.0
    return max(0.0, delay)
