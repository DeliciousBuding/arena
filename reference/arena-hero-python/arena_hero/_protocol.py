"""Wire parsing and stable serialization for the public v0.1 protocol."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .actions import Accepted, CommandPlan
from .errors import APIError, ProtocolError
from .models import PlayerState, Received, Tick


class _Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class _TickEnvelope(_Envelope):
    type: Literal["tick"]
    data: int = Field(ge=1)


class _StateEnvelope(_Envelope):
    type: Literal["state"]
    data: PlayerState


class _ReceivedEnvelope(_Envelope):
    type: Literal["received"]
    data: Received


_StreamEnvelope = Annotated[
    _TickEnvelope | _StateEnvelope | _ReceivedEnvelope,
    Field(discriminator="type"),
]
_STREAM_ADAPTER = TypeAdapter(_StreamEnvelope)
_ACCEPTED_ADAPTER = TypeAdapter(Accepted)


def parse_stream_message(raw: str | bytes) -> Tick | PlayerState | Received:
    """Parse one server WebSocket text message."""

    if isinstance(raw, bytes):
        raise ProtocolError("the server sent a binary WebSocket message")
    try:
        envelope = _STREAM_ADAPTER.validate_json(raw, strict=True)
    except ValidationError as exc:
        raise ProtocolError("invalid Arena Hero WebSocket message") from exc
    if isinstance(envelope, _TickEnvelope):
        return Tick(tick=envelope.data)
    return envelope.data


def encode_plan(plan: CommandPlan) -> bytes:
    """Serialize a complete plan into stable, compact UTF-8 JSON bytes."""

    data = plan.model_dump(mode="json", exclude_none=True)
    return json.dumps(
        data,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def parse_accepted(raw: bytes) -> Accepted:
    """Parse a successful command acknowledgement."""

    try:
        return _ACCEPTED_ADAPTER.validate_json(raw, strict=True)
    except ValidationError as exc:
        raise ProtocolError("invalid command acknowledgement") from exc


def api_error(status_code: int, raw: bytes) -> APIError:
    """Build a structured API error without exposing request credentials."""

    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    error = payload.get("error")
    message = payload.get("message")
    safe_error = error if isinstance(error, str) else "HTTP_ERROR"
    safe_message = message if isinstance(message, str) else None
    details: dict[str, Any] = {
        key: value for key, value in payload.items() if key not in {"error", "message"}
    }
    return APIError(
        status_code=status_code,
        error=safe_error,
        message=safe_message,
        details=details,
    )
