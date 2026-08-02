"""环境感知：跨 Tick 世界记忆。

记忆规则（对应契约）：
- 障碍是永久地形 → 视野外不丢失，直接可长期使用
- 资源是动态的 → 只做"线索"：VISIBLE（当前可见）/ STALE（曾见现未见）/
  HARVESTED（本侧成功采集）。决策永远优先当前 Turn 的 resource_cells
- 敌人 → 最近位置/类型/时间戳，stale 由调用方按 age 判断，绝不当作当前真相
- 记忆不决定结算：服务器状态是唯一权威
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from .core.unit_state import UnitStateTracker

if TYPE_CHECKING:
    from uuid import UUID

    Position = tuple[int, int]


class ResourceState(Enum):
    VISIBLE = "visible"      # 当前 Turn 可见（自然节点或 cargo 堆）
    STALE = "stale"          # 曾见现未见（可能被采/刷新移走）
    HARVESTED = "harvested"  # 本侧成功采集（节点已消耗）


@dataclass
class ResourceMemory:
    cell: "Position"
    state: ResourceState
    first_seen_tick: int
    last_seen_tick: int


@dataclass
class EnemyMemory:
    id: "UUID"
    position: "Position"
    kind: str  # "UNIT" 或 "CORE"
    last_seen_tick: int


class World:
    """跨 Tick 记忆容器。observe(turn) 每次 Turn 更新。"""

    def __init__(self) -> None:
        self.obstacle_memory: set[Position] = set()
        self.resource_memory: dict[Position, ResourceMemory] = {}
        self.enemy_memory: dict[UUID, EnemyMemory] = {}
        self.failed_cells: dict[Position, int] = {}  # HARVEST_FAILED 格 → tick
        self.tick: int = 0
        self.current_resource_cells: frozenset[Position] = frozenset()
        self.current_enemy_count: int = 0
        self.unit_states = UnitStateTracker()  # 单元意图状态机记忆

    def observe(self, tick: int,
                obstacle_cells: frozenset[Position],
                resource_cells: frozenset[Position],
                visible_enemies: tuple,  # UnitView | CoreView
                harvest_failed_cells: set[Position] = frozenset()) -> None:
        """用当前 Turn 的可见数据更新记忆。"""
        self.tick = tick
        self.current_resource_cells = resource_cells

        # 障碍：永久地形，只增不减
        self.obstacle_memory.update(obstacle_cells)

        # 资源：当前可见 → VISIBLE；曾见的 → STALE
        seen = set()
        for cell in resource_cells:
            seen.add(cell)
            old = self.resource_memory.get(cell)
            self.resource_memory[cell] = ResourceMemory(
                cell=cell, state=ResourceState.VISIBLE,
                first_seen_tick=old.first_seen_tick if old else tick,
                last_seen_tick=tick)
        for cell, mem in list(self.resource_memory.items()):
            if cell in seen:
                continue
            if mem.state is ResourceState.HARVESTED:
                # 已采节点：保持记忆但降级 stale（可能刷新回来，仅作线索）
                mem.state = ResourceState.STALE
                mem.last_seen_tick = tick
            elif mem.state is ResourceState.VISIBLE:
                mem.state = ResourceState.STALE

        # 本侧成功采集/失败：更新状态（由策略在处理事件后传入）
        for cell in harvest_failed_cells:
            self.failed_cells[cell] = tick
            mem = self.resource_memory.get(cell)
            if mem is not None and mem.state is ResourceState.VISIBLE:
                # 失败原因可能是被抢（RESOURCE_DEPLETED）→ 降级，避免反复撞
                mem.state = ResourceState.STALE

        # 敌人：可见更新；不可见的保留最后位置（调用方按 age 用）
        self.current_enemy_count = len(visible_enemies)
        for e in visible_enemies:
            self.enemy_memory[e.id] = EnemyMemory(
                id=e.id, position=e.position, kind=e.kind, last_seen_tick=tick)

    def mark_harvested(self, cell: "Position", tick: int) -> None:
        """成功采集后调用：节点已消耗，从线索中移除。"""
        self.resource_memory[cell] = ResourceMemory(
            cell=cell, state=ResourceState.HARVESTED,
            first_seen_tick=self.resource_memory.get(cell, ResourceMemory(
                cell, ResourceState.STALE, tick, tick)).first_seen_tick,
            last_seen_tick=tick)

    # ---- 查询 ----
    def obstacles(self) -> frozenset["Position"]:
        return frozenset(self.obstacle_memory)

    def resource_hints(self, max_age: int = 8, failed_cooldown: int = 4) -> list["Position"]:
        """最近见过的资源线索（VISIBLE 优先，其次近期 STALE）。

        failed_cooldown：HARVEST_FAILED 的格在此窗口内排除（避免反复撞同格）。
        """
        visible = [m.cell for m in self.resource_memory.values()
                   if m.state is ResourceState.VISIBLE]
        recent = [m.cell for m in self.resource_memory.values()
                  if m.state is ResourceState.STALE
                  and self.tick - m.last_seen_tick <= max_age]
        hints = visible + recent
        return [c for c in hints
                if self.tick - self.failed_cells.get(c, -10**9) >= failed_cooldown]

    def enemy_hints(self, max_age: int = 6) -> list[EnemyMemory]:
        """近期可见敌人线索，按最近出现排序。"""
        return sorted(
            (m for m in self.enemy_memory.values()
             if self.tick - m.last_seen_tick <= max_age),
            key=lambda m: m.last_seen_tick, reverse=True)
