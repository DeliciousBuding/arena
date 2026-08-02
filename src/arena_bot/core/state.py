"""Turn 适配层：类型化状态封装 + 索引预计算。

决策层消费 TickState 而非裸 Turn：便于 Fake 构造测试、统一类型、预计算索引。
submit() 委托给原 Turn（SDK 收尾逻辑不重建）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from arena_hero import (
        ChampionBeacon, Core, CoreView, Position, ResolutionEvent,
        Ranger, Turn, UnitView, Vanguard, Worker,
    )


@dataclass(frozen=True)
class TickState:
    tick: int
    resources: int
    resource_capacity: int
    resource_space: int
    core: "Core | None"
    core_view: "CoreView | None"
    units: tuple = field(default=())
    workers: tuple = field(default=())
    vanguards: tuple = field(default=())
    rangers: tuple = field(default=())
    visible_enemies: tuple = field(default=())
    resource_cells: frozenset = field(default_factory=frozenset)
    obstacle_cells: frozenset = field(default_factory=frozenset)
    beacon: "ChampionBeacon | None" = None
    events: tuple = field(default=())
    _turn: object = field(default=None, repr=False)

    @property
    def population(self) -> int:
        return len(self.units)

    @property
    def home(self) -> "Position | None":
        return self.core.position if self.core is not None else None

    @property
    def core_normal(self) -> bool:
        """Core 存在且非 MOVING（可 heal/deposit/spawn 的前置条件）。"""
        from arena_hero import CoreState
        return (self.core_view is not None
                and self.core_view.state is CoreState.NORMAL)

    @classmethod
    def from_turn(cls, turn: "Turn") -> "TickState":
        core = turn.core
        return cls(
            tick=turn.tick,
            resources=turn.resources,
            resource_capacity=turn.resource_capacity,
            resource_space=turn.resource_space,
            core=core,
            core_view=core.view if core is not None else None,
            units=tuple(turn.units),
            workers=tuple(turn.workers),
            vanguards=tuple(turn.vanguards),
            rangers=tuple(turn.rangers),
            visible_enemies=tuple(turn.visible_enemies),
            resource_cells=frozenset(turn.resource_cells),
            obstacle_cells=frozenset(turn.obstacle_cells),
            beacon=turn.beacon,
            events=tuple(turn.events),
            _turn=turn,
        )

    def submit(self, idempotency_key: str | None = None):
        """委托 SDK Turn 提交计划。"""
        return self._turn.submit(idempotency_key=idempotency_key)
