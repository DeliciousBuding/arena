"""Watchdog 自诊断测试：空计划/单位卡死/经济停滞三类告警。"""

from __future__ import annotations

import json
import uuid

from arena_bot.watchdog import Watchdog


def _unit(pos, intent="patrol"):
    return {"id": str(uuid.uuid4()), "pos": pos, "intent": intent}


def test_empty_plan_stall_alarm_and_resolve(tmp_path):
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=5)
    for tick in range(1, 6):
        wd.observe(tick=tick, empty_plan=True, units=[_unit((0, 0))],
                   resources=tick, resource_capacity=10)  # 资源递增隔离经济告警
    assert wd.open_alarms()[0].alarm_type == "EMPTY_PLAN_STALL"
    # 恢复：有动作后告警解除
    wd.observe(tick=6, empty_plan=False, units=[_unit((0, 0))],
               resources=6, resource_capacity=10)
    assert wd.open_alarms() == []


def test_empty_plan_stall_no_duplicate(tmp_path):
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=3)
    for tick in range(1, 10):
        wd.observe(tick=tick, empty_plan=True, units=[_unit((0, 0))],
                   resources=tick, resource_capacity=10)
    assert len(wd.open_alarms()) == 1  # 未解决不重复上报


def test_unit_stall_alarm(tmp_path):
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=5)
    u = _unit((5, 5))
    for tick in range(1, 6):
        wd.observe(tick=tick, empty_plan=False, units=[u],
                   resources=tick, resource_capacity=10)
    assert wd.open_alarms()[0].alarm_type == "UNIT_STALL"
    # 单位动了 → 解除
    u["pos"] = (5, 6)
    wd.observe(tick=6, empty_plan=False, units=[u],
               resources=6, resource_capacity=10)
    assert wd.open_alarms() == []


def test_unit_waiting_intent_not_stall(tmp_path):
    """intent 不是移动类（如 deposit/heal 等待）不算卡死。"""
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=3)
    u = _unit((5, 5), intent="deposit")
    for tick in range(1, 6):
        wd.observe(tick=tick, empty_plan=False, units=[u],
                   resources=tick, resource_capacity=10)
    assert wd.open_alarms() == []


def test_economy_stall_alarm_only_below_capacity(tmp_path):
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=3)
    for tick in range(1, 4):
        wd.observe(tick=tick, empty_plan=False, units=[_unit((0, 0))],
                   resources=5, resource_capacity=10)  # 未满 → 停滞
    assert wd.open_alarms()[0].alarm_type == "ECONOMY_STALL"

    # 满容量时不报警（资源不动是正常的）
    wd2 = Watchdog(tmp_path / "alerts2.jsonl", stall_ticks=3)
    for tick in range(1, 6):
        wd2.observe(tick=tick, empty_plan=False, units=[_unit((0, 0))],
                    resources=10, resource_capacity=10)
    assert wd2.open_alarms() == []


def test_unit_cycle_alarm_on_oscillation(tmp_path):
    """两点振荡（A→B→A→B）→ UNIT_CYCLE 告警；走出循环解除。"""
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=100)  # 关掉 stall
    u = _unit((0, 0))
    # 6 tick 内在 (0,0)↔(1,0) 振荡
    for tick in range(1, 7):
        u["pos"] = (0, 0) if tick % 2 else (1, 0)
        wd.observe(tick=tick, empty_plan=False, units=[u],
                   resources=tick, resource_capacity=10)
    alarms = [a.alarm_type for a in wd.open_alarms()]
    assert "UNIT_CYCLE" in alarms
    # 走出循环（出现第 3 个位置）→ 解除
    for tick in range(7, 12):
        u["pos"] = (tick, 0)
        wd.observe(tick=tick, empty_plan=False, units=[u],
                   resources=tick, resource_capacity=10)
    assert "UNIT_CYCLE" not in [a.alarm_type for a in wd.open_alarms()]


def test_unit_cycle_no_alarm_on_progress(tmp_path):
    """持续前进（每个 tick 位置不同）→ 不触发循环告警。"""
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=100)
    u = _unit((0, 0))
    for tick in range(1, 12):
        u["pos"] = (tick, 0)
        wd.observe(tick=tick, empty_plan=False, units=[u],
                   resources=tick, resource_capacity=10)
    assert [a.alarm_type for a in wd.open_alarms()] == []


def test_alerts_persisted_jsonl(tmp_path):
    wd = Watchdog(tmp_path / "alerts.jsonl", stall_ticks=2)
    for tick in range(1, 3):
        wd.observe(tick=tick, empty_plan=True, units=[_unit((0, 0))],
                   resources=tick, resource_capacity=10)
    lines = (tmp_path / "alerts.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["type"] == "EMPTY_PLAN_STALL"
    assert record["resolved"] is False
    # 恢复后写 resolved 行
    wd.observe(tick=3, empty_plan=False, units=[_unit((0, 0))],
               resources=3, resource_capacity=10)
    lines = (tmp_path / "alerts.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert json.loads(lines[-1])["resolved"] is True
