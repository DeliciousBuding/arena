"""遥测：每 Tick 指标采样 → JSONL（append-only，按租户分文件）。

P0-4 修复：每个观察到的 Tick 必写一行（含 outcome），paused/空计划/
409/异常不再静默丢失；append 模式不覆盖历史；每行是完整 JSON 对象，
evaluate 报告从 JSONL 派生。

outcome 取值：submitted / paused / empty / tick_mismatch / error
"""

from __future__ import annotations

import json
import time
from pathlib import Path

# 计入遥测的事件类型（事件名是字符串，新增事件不破坏兼容）
EVENT_COUNTERS = (
    "HARVEST_SUCCEEDED", "HARVEST_FAILED", "DEPOSIT_SUCCEEDED",
    "DEPOSIT_FAILED", "UNIT_HEAL_SUCCEEDED", "CORE_HEAL_SUCCEEDED",
    "UNIT_SELF_DESTRUCTED", "UNIT_MOVE_SUCCEEDED",
)
COMBAT_EVENTS = (
    "SWEEP_RESOLVED", "SHOT_MISSED", "SHOT_HIT", "UNIT_DAMAGED",
    "CORE_DAMAGED", "DESTRUCTION_PARTICIPATION", "CORE_DESTROYED",
    "CORE_RESOURCES_CAPTURED",
)


class Telemetry:
    """按租户写 JSONL。record() 每 Tick 必调用一次（含失败分支）。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._file = path.open("a", encoding="utf-8")  # append：不覆盖历史

    def record(self, *, tick: int, outcome: str, phase: str = "",
               resources=None, resource_capacity=None, population=None,
               workers: int = 0, vanguards: int = 0, rangers: int = 0,
               core_hp=None, core_shield=None, enemies_visible: int = 0,
               events: tuple = (), intents=None, **extra) -> None:
        """采样一帧。outcome 标记本 tick 结果（submitted/empty/paused/...）。"""
        from collections import Counter
        ev = Counter(getattr(e, "event_type", "") for e in events)
        row = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "tick": tick,
            "outcome": outcome,
            "phase": phase,
            "resources": resources,
            "resource_capacity": resource_capacity,
            "population": population,
            "workers": workers,
            "vanguards": vanguards,
            "rangers": rangers,
            "core_hp": core_hp,
            "core_shield": core_shield,
            "enemies_visible": enemies_visible,
            "events": {name: ev.get(name, 0) for name in EVENT_COUNTERS},
            "combat_events": sum(ev.get(name, 0) for name in COMBAT_EVENTS),
        }
        if intents:
            intent_counts = Counter(intents.values())
            row["intents"] = {k: v for k, v in sorted(intent_counts.items())}
        row.update(extra)
        self._file.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        self._file.flush()  # 立即落盘：遥测必须可实时观察

    def close(self) -> None:
        if not self._file.closed:
            self._file.close()

    def __enter__(self) -> "Telemetry":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
