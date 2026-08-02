"""遥测：每 Tick 指标采样 → CSV（按租户分文件）。

实验对比的基础：没有这层，策略优劣无从衡量。
采样列设计为评估脚本的最小充分集：
- 状态：资源/容量/人口/单位组成/Core HP/盾/可见敌人数/阶段
- 事件计数：采集成功/失败、交付、治疗、战斗事件（本 Tick 增量）
- 意图分布：各意图标签计数（看策略在干嘛）
"""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

# 计入遥测的事件类型（事件名是字符串，新增事件不破坏兼容）
EVENT_COUNTERS = (
    "HARVEST_SUCCEEDED", "HARVEST_FAILED", "DEPOSIT_SUCCEEDED",
    "DEPOSIT_FAILED", "UNIT_HEAL_SUCCEEDED", "CORE_HEAL_SUCCEEDED",
    "UNIT_SELF_DESTRUCTED", "UNIT_MOVE_SUCCEEDED",
)
COMBAT_EVENTS = ("UNIT_DESTROYED", "CORE_DESTROYED", "CORE_RESPAWNED",
                 "CORE_RESOURCES_CAPTURED", "UNIT_HEAL_FAILED")

HEADER = (
    "tick", "phase", "resources", "resource_capacity", "population",
    "workers", "vanguards", "rangers", "core_hp", "core_shield",
    "enemies_visible",
    *EVENT_COUNTERS, "combat_events",
    "intents",
)


class Telemetry:
    """按租户写 CSV。record() 每 Tick 调用一次。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._file = path.open("w", newline="", encoding="utf-8")
        self._writer = csv.writer(self._file)
        self._writer.writerow(HEADER)

    def record(self, *, tick: int, phase: str, resources: int,
               resource_capacity: int, population: int, workers: int,
               vanguards: int, rangers: int, core_hp: int | None,
               core_shield: int | None, enemies_visible: int,
               events: tuple, intents: dict) -> None:
        """采样一帧。events 为当前 Tick 的 ResolutionEvent 序列。"""
        ev = Counter(getattr(e, "event_type", "") for e in events)
        combat = sum(ev.get(name, 0) for name in COMBAT_EVENTS)
        intent_counts = Counter(intents.values())
        intent_repr = ",".join(f"{k}:{v}" for k, v in
                               sorted(intent_counts.items())) or "-"
        self._writer.writerow((
            tick, phase, resources, resource_capacity, population,
            workers, vanguards, rangers,
            core_hp if core_hp is not None else "",
            core_shield if core_shield is not None else "",
            enemies_visible,
            *(ev.get(name, 0) for name in EVENT_COUNTERS),
            combat, intent_repr,
        ))
        # 立即落盘：遥测必须可实时观察（评估/监控依赖文件内容）
        self._file.flush()

    def close(self) -> None:
        if not self._file.closed:
            self._file.close()

    def __enter__(self) -> "Telemetry":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
