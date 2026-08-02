"""单元状态机：Worker 采集链的跨 Tick 意图状态。

状态转移只由当前 Turn 触发（无 tick 内并发），存于 World（跨 Tick 记忆）：

    PATROL ──发现可见资源──▶ GO_HARVEST ──到格──▶ (HARVEST)
       ▲                        │
       │◀──目标消失/被采────────┘
       ▲
       │◀──交付完成(cargo==0 且在家)──┐
    RETURN ◀──cargo>0──────────────┘
       │
       └──到家──▶ DEPOSIT

cargo 是 Turn 权威字段，cargo>0 直接进入 RETURN 语义，无需记忆。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from uuid import UUID

    Position = tuple[int, int]


class WorkerState(Enum):
    PATROL = "patrol"          # 巡逻/待机，无采集目标
    GO_HARVEST = "go_harvest"  # 有目标资源格，前往中


@dataclass
class UnitMemory:
    """单个单位的跨 Tick 意图状态。"""
    worker_state: WorkerState = WorkerState.PATROL
    harvest_target: "Position | None" = None  # GO_HARVEST 的目标格
    patrol_direction: int = 0  # 辐射巡逻当前方向（轮盘索引 0-3）
    patrol_started: bool = False  # 是否已按序号方向出发过（首次不换扇区）
    last_tick: int = 0


class UnitStateTracker:
    """单位意图记忆容器（挂在 World 上）。"""

    def __init__(self) -> None:
        self.memory: dict["UUID", UnitMemory] = {}

    def get(self, unit_id: "UUID", **init) -> UnitMemory:
        """获取单位记忆；首次创建时应用 init 覆盖默认值。"""
        mem = self.memory.get(unit_id)
        if mem is None:
            mem = UnitMemory(**init)
            self.memory[unit_id] = mem
        return mem

    def snapshot(self) -> dict:
        return {str(k): v.worker_state.value for k, v in self.memory.items()}
