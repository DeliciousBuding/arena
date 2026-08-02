"""Asynchronous Arena Hero client."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from types import MappingProxyType

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from ._client_common import (
    DEFAULT_BASE_URL,
    build_config,
    check_close_exception,
    check_handshake_exception,
    jitter,
    validate_idempotency_key,
)
from ._protocol import api_error, encode_plan, parse_accepted, parse_stream_message
from .actions import Accepted, CommandPlan
from .enums import CommandSource
from .errors import ConfigurationError, ProtocolError, TransportError
from .models import PlayerState, Received, Tick
from .turn import AsyncTurn

AsyncGameEvent = Tick | AsyncTurn | Received


class AsyncArenaHeroClient:
    """Asynchronous client for writing an explicit Arena Hero game loop."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        websocket_url: str | None = None,
        request_timeout: float = 5.0,
        request_retries: int = 2,
        reconnect_min_delay: float = 0.25,
        reconnect_max_delay: float = 5.0,
        max_message_size: int = 2 * 1024 * 1024,
    ) -> None:
        """Initialize the client from explicit parameters.

        The SDK never reads the API key or endpoint from environment variables.
        """

        self._config = build_config(
            api_key=api_key,
            base_url=base_url,
            websocket_url=websocket_url,
            request_timeout=request_timeout,
            request_retries=request_retries,
            reconnect_min_delay=reconnect_min_delay,
            reconnect_max_delay=reconnect_max_delay,
            max_message_size=max_message_size,
        )
        self._http = httpx.AsyncClient(
            headers=self._config.headers,
            timeout=self._config.request_timeout,
        )
        self._closed = False
        self._iterating = False
        self._socket: ClientConnection | None = None
        self._current_tick: int | None = None
        self._active_turn: AsyncTurn | None = None
        self._latest_receipts: dict[CommandSource, Received] = {}

    async def __aenter__(self) -> AsyncArenaHeroClient:
        """Enter the asynchronous client context."""

        self._ensure_open()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: object | None,
    ) -> None:
        """Close network resources when leaving the context."""

        await self.close()

    def __aiter__(self) -> AsyncIterator[AsyncGameEvent]:
        """Iterate over the complete game event stream."""

        return self.events()

    @property
    def latest_receipts(self) -> Mapping[CommandSource, Received]:
        """Return the latest current-Tick plan received for each source."""

        return MappingProxyType(dict(self._latest_receipts))

    async def events(self) -> AsyncIterator[AsyncGameEvent]:
        """Yield ``Tick``, actionable ``AsyncTurn``, and ``Received`` messages.

        The iterator reconnects with bounded exponential backoff. Only one
        event or Turn iterator may consume a client at a time.
        """

        self._start_iteration()
        delay = self._config.reconnect_min_delay
        try:
            while not self._closed:
                override_delay: float | None = None
                try:
                    async with connect(
                        self._config.websocket_url,
                        additional_headers=self._config.headers,
                        compression=None,
                        ping_interval=20,
                        ping_timeout=60,
                        max_size=self._config.max_message_size,
                    ) as websocket:
                        self._socket = websocket
                        delay = self._config.reconnect_min_delay
                        async for raw_message in websocket:
                            yield self._materialize(parse_stream_message(raw_message))
                        if websocket.close_code == 1000:
                            return
                except InvalidStatus as exc:
                    override_delay = check_handshake_exception(exc)
                except ConnectionClosed as exc:
                    check_close_exception(exc)
                except (OSError, TimeoutError):
                    if self._closed:
                        return
                finally:
                    self._socket = None
                if self._closed:
                    return
                sleep_for = override_delay or jitter(delay)
                await asyncio.sleep(sleep_for)
                delay = min(delay * 2, self._config.reconnect_max_delay)
        finally:
            self._iterating = False
            if self._closed and self._active_turn is not None:
                self._active_turn._seal()

    async def turns(self) -> AsyncIterator[AsyncTurn]:
        """Yield each actionable Tick once, while still processing receipts."""

        last_tick: int | None = None
        async for event in self.events():
            if isinstance(event, AsyncTurn) and event.tick != last_tick:
                last_tick = event.tick
                yield event

    async def submit(
        self,
        plan: CommandPlan,
        *,
        idempotency_key: str | None = None,
    ) -> Accepted:
        """Submit one complete AGENT plan with safe exact-body retries."""

        self._ensure_open()
        key = validate_idempotency_key(idempotency_key, plan.tick)
        body = encode_plan(plan)
        headers = {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
        }
        last_error: httpx.TransportError | None = None
        attempts = self._config.request_retries + 1
        for attempt in range(attempts):
            try:
                response = await self._http.post(
                    self._config.command_url,
                    content=body,
                    headers=headers,
                )
            except httpx.TransportError as exc:
                last_error = exc
            else:
                if response.status_code == 202:
                    return parse_accepted(response.content)
                if response.status_code not in {502, 503, 504}:
                    raise api_error(response.status_code, response.content)
            if attempt + 1 < attempts:
                await asyncio.sleep(min(0.1 * (2**attempt), 0.5))
        raise TransportError(
            "command submission failed after safe retries"
        ) from last_error

    async def close(self) -> None:
        """Close the active WebSocket and HTTP connection pool."""

        if self._closed:
            return
        self._closed = True
        if self._active_turn is not None:
            self._active_turn._seal()
        if self._socket is not None:
            await self._socket.close()
        await self._http.aclose()

    def _start_iteration(self) -> None:
        self._ensure_open()
        if self._iterating:
            raise ConfigurationError("only one event iterator may run per client")
        self._iterating = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise ConfigurationError("the client is closed")

    def _materialize(
        self,
        message: Tick | PlayerState | Received,
    ) -> AsyncGameEvent:
        if isinstance(message, Tick):
            if self._current_tick != message.tick:
                self._latest_receipts.clear()
            self._current_tick = message.tick
            if self._active_turn is not None:
                self._active_turn._seal()
                self._active_turn = None
            return message
        if isinstance(message, Received):
            if self._current_tick == message.tick:
                self._latest_receipts[message.source] = message
            return message
        if self._current_tick is None:
            raise ProtocolError("state arrived before tick")
        if self._active_turn is not None:
            self._active_turn._seal()
        turn = AsyncTurn(
            tick=self._current_tick,
            state=message,
            submitter=lambda plan, key: self.submit(
                plan,
                idempotency_key=key,
            ),
        )
        self._active_turn = turn
        return turn
