"""自诊断 watchdog：检测卡死/停滞并告警（而不是默默空转）。

三类告警（阈值 config 可调）：
- EMPTY_PLAN_STALL：连续 N tick 无任何动作（全单位等待）
- UNIT_STALL：单位意图在移动（patrol/go_harvest）但位置连续 N tick 不变
- ECONOMY_STALL：Core 资源连续 N tick 不增长且未满容量（采集停滞）

告警通道：
- 日志 WARNING（进程日志）
- alerts/<tenant>.jsonl 追加（含 resolved 状态，便于恢复跟踪）
- debug API GET /state 的 alarms 字段（当前未解决）
同一类型告警在未解决前不重复上报；恢复后写 resolved 行。
"""

from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("arena_bot.watchdog")


@dataclass
class Alarm:
    alarm_type: str
    tick: int
    message: str
    resolved: bool = False
    resolved_tick: int | None = None


class Watchdog:
    def __init__(self, alert_path: Path | None, stall_ticks: int = 20) -> None:
        self.alert_path = alert_path
        self.stall_ticks = stall_ticks
        self._alarms: list[Alarm] = []
        self._open: dict[str, Alarm] = {}      # type -> 未解决告警
        self._empty_plan_count = 0
        self._unit_positions: dict[str, tuple] = {}   # uid -> last pos
        self._unit_stall: dict[str, int] = {}         # uid -> 连续不动 tick
        self._unit_history: dict[str, deque] = {}     # uid -> 最近位置序列
        self._last_resources: int | None = None
        self._resource_stall = 0
        self._tick = 0

    # ---- 观察 ----
    def observe(self, *, tick: int, empty_plan: bool,
                units: list, resources: int | None,
                resource_capacity: int | None) -> None:
        """每 Tick 调用。units: [{id, pos, intent}]。"""
        self._tick = tick

        # 1. 空计划停滞
        if empty_plan:
            self._empty_plan_count += 1
            if self._empty_plan_count >= self.stall_ticks:
                self._raise_alarm("EMPTY_PLAN_STALL",
                                  f"连续 {self._empty_plan_count} tick 全单位无动作")
        else:
            self._empty_plan_count = 0
            self._resolve("EMPTY_PLAN_STALL")

        # 2. 单位卡死（意图移动但位置不变）
        current: set[str] = set()
        for u in units:
            uid = str(u["id"])
            current.add(uid)
            intent = u.get("intent") or ""
            if intent not in ("patrol", "go_harvest", "go_harvest_mem",
                              "return_home", "vanguard_move", "ranger_move"):
                # 合法等待（deposit/heal 等）：不算卡死，并解除已有告警
                self._unit_stall.pop(uid, None)
                self._unit_positions.pop(uid, None)
                self._resolve("UNIT_STALL")
                continue
            if self._unit_positions.get(uid) == u["pos"]:
                self._unit_stall[uid] = self._unit_stall.get(uid, 0) + 1
            else:
                self._unit_stall[uid] = 1  # 新位置/首次观察：计数 1
                self._resolve("UNIT_STALL")  # 单位恢复移动 → 解除
            self._unit_positions[uid] = u["pos"]

            # 循环走格检测：实际在振荡（位置变化 ≥3 次且只覆盖 ≤2 格）
            hist = self._unit_history.setdefault(uid, deque(maxlen=8))
            hist.append(u["pos"])
            changes = sum(1 for a, b in zip(hist, list(hist)[1:]) if a != b)
            if (len(hist) >= 6 and len(set(hist)) <= 2 and changes >= 3):
                self._raise_alarm(
                    "UNIT_CYCLE",
                    f"单位 {uid[:8]} 在 {sorted(set(hist))} 间循环走格 "
                    f"（最近 {len(hist)} tick {changes} 次来回）")
            elif len(set(hist)) >= 3:
                self._resolve("UNIT_CYCLE")  # 走出循环 → 解除

            if self._unit_stall[uid] >= self.stall_ticks:
                self._raise_alarm(
                    "UNIT_STALL",
                    f"单位 {uid[:8]} 意图={intent} 位置 {u['pos']} "
                    f"连续 {self._unit_stall[uid]} tick 未移动")
        for uid in list(self._unit_stall):
            if uid not in current:
                self._unit_stall.pop(uid, None)
                self._unit_positions.pop(uid, None)
                self._unit_history.pop(uid, None)
                self._resolve("UNIT_STALL")  # 单位消失/死亡 → 解除
                self._resolve("UNIT_CYCLE")

        # 3. 经济停滞（资源未满且不增长）
        if resources is not None and resource_capacity is not None:
            if resources < resource_capacity:
                if (self._last_resources is not None
                        and resources == self._last_resources):
                    self._resource_stall += 1
                else:
                    self._resource_stall = 1  # 变化/首次观察：计数 1
                if self._resource_stall >= self.stall_ticks:
                    self._raise_alarm(
                        "ECONOMY_STALL",
                        f"资源 {resources}/{resource_capacity} 连续 "
                        f"{self._resource_stall} tick 未增长（采集停滞？）")
            else:
                self._resource_stall = 0
                self._resolve("ECONOMY_STALL")
            self._last_resources = resources

    # ---- 告警管理 ----
    def _raise_alarm(self, alarm_type: str, message: str) -> None:
        if alarm_type in self._open:
            return  # 未解决不重复
        alarm = Alarm(alarm_type, self._tick, message)
        self._alarms.append(alarm)
        self._open[alarm_type] = alarm
        log.warning("告警 %s: %s", alarm_type, message)
        self._persist(alarm)

    def _resolve(self, alarm_type: str) -> None:
        alarm = self._open.pop(alarm_type, None)
        if alarm is None:
            return
        alarm.resolved = True
        alarm.resolved_tick = self._tick
        log.info("告警解除 %s @tick %d", alarm_type, self._tick)
        self._persist(alarm)

    def _persist(self, alarm: Alarm) -> None:
        if self.alert_path is None:
            return
        self.alert_path.parent.mkdir(parents=True, exist_ok=True)
        with self.alert_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "type": alarm.alarm_type, "tick": alarm.tick,
                "message": alarm.message, "resolved": alarm.resolved,
                "resolved_tick": alarm.resolved_tick,
            }, ensure_ascii=False) + "\n")

    def open_alarms(self) -> list[Alarm]:
        return list(self._open.values())
