"""apply_plan 执行器测试：Plan 正确应用到 SDK 控制器（含关键字参数）。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import Direction, UnitType

from arena_bot.strategy import Action, Plan, apply_plan


class Recorder:
    """记录调用：验证参数传递方式（位置 vs 关键字）。"""

    def __init__(self):
        self.calls = []

    def move(self, d): self.calls.append(("move", (), {"d": d}))
    def harvest(self): self.calls.append(("harvest", (), {}))
    def deposit(self): self.calls.append(("deposit", (), {}))
    def heal(self): self.calls.append(("heal", (), {}))
    def repair_shield(self): self.calls.append(("repair_shield", (), {}))
    def pickup_beacon(self): self.calls.append(("pickup_beacon", (), {}))
    def drop_beacon(self): self.calls.append(("drop_beacon", (), {}))
    def self_destruct(self): self.calls.append(("self_destruct", (), {}))
    def sweep(self, d): self.calls.append(("sweep", (), {"d": d}))
    def shoot(self, target, *, expected_cell=None):
        self.calls.append(("shoot", (), {"target": target, "expected_cell": expected_cell}))
    def spawn(self, t): self.calls.append(("spawn", (), {"t": t}))
    def wait(self): self.calls.append(("wait", (), {}))


class FakeTurn:
    def __init__(self, units: dict, core=None):
        self._units = units
        self.core = core

    def unit(self, uid: str):
        return self._units[uid]


def test_apply_shoot_uses_keyword_expected_cell():
    """SDK 签名 shoot(target, *, expected_cell)：必须关键字传参。"""
    uid = uuid.uuid4()
    target_id = uuid.uuid4()
    unit = Recorder()
    turn = FakeTurn({str(uid): unit})
    plan = Plan(tick=1)
    plan.set(Action(uid, "SHOOT", target_id=target_id, expected_cell=(5, 8)))
    apply_plan(turn, plan)
    assert unit.calls == [("shoot", (), {"target": target_id, "expected_cell": (5, 8)})]


def test_apply_full_plan():
    uid = uuid.uuid4()
    unit = Recorder()
    core = Recorder()
    turn = FakeTurn({str(uid): unit}, core=core)
    plan = Plan(tick=1)
    plan.set(Action(uid, "MOVE", direction=Direction.UP))
    plan.core_action = Action(uuid.uuid4(), "SPAWN", unit_type=UnitType.WORKER)
    apply_plan(turn, plan)
    assert unit.calls == [("move", (), {"d": Direction.UP})]
    assert core.calls == [("spawn", (), {"t": UnitType.WORKER})]


def test_apply_repair_shield_and_spawn():
    """REPAIR_SHIELD / SPAWN 动作必须可应用（平衡策略会产出）。"""
    uid = uuid.uuid4()
    core = Recorder()
    turn = FakeTurn({}, core=core)
    plan = Plan(tick=1)
    plan.core_action = Action(uuid.uuid4(), "REPAIR_SHIELD")
    apply_plan(turn, plan)
    assert core.calls == [("repair_shield", (), {})]
    core.calls.clear()
    plan.core_action = Action(uuid.uuid4(), "SPAWN", unit_type=UnitType.WORKER)
    apply_plan(turn, plan)
    assert core.calls == [("spawn", (), {"t": UnitType.WORKER})]


def test_apply_skip_core_when_none():
    uid = uuid.uuid4()
    unit = Recorder()
    turn = FakeTurn({str(uid): unit}, core=None)
    plan = Plan(tick=1)
    plan.core_action = Action(uuid.uuid4(), "HEAL")
    apply_plan(turn, plan)
    assert unit.calls == []  # core None 时跳过 core_action，不抛错
