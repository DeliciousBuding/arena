"""E1 新旧决策对比：同一合成场景跑旧 tactic 与新 BalanceStrategy，断言动作一致。

用法：uv run python scripts/compare_legacy.py
场景：采集/交付/巡逻/战斗(sweep/shoot)/生产/Beacon 六类。
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.strategies import BalanceStrategy
from arena_bot.world import World

from tactic import decide_actions  # 旧决策（legacy，Batch 5 前保留在根目录）


class FakeUnit:
    def __init__(self, pos, unit_type, hp, cargo=0, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.unit_type = unit_type
        self.hp = hp
        self.cargo = cargo
        self.actions = []  # 旧接口：记录调用

    def _rec(self, name, *args):
        self.actions.append((name, tuple(args)))

    def move(self, d): self._rec("move", d)
    def harvest(self): self._rec("harvest")
    def deposit(self): self._rec("deposit")
    def heal(self): self._rec("heal")
    def pickup_beacon(self): self._rec("pickup_beacon")
    def sweep(self, d): self._rec("sweep", d)
    def shoot(self, t): self._rec("shoot", t.position)


class FakeEnemy:
    def __init__(self, pos, kind="UNIT", uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.kind = kind


class FakeCoreView:
    def __init__(self, hp=5, shield=5, state=None):
        self.hp = hp
        self.shield = shield
        self.state = state if state is not None else CoreState.NORMAL


class FakeCore:
    def __init__(self, position, hp=5, shield=5):
        self.id = uuid.uuid4()
        self.position = position
        self.view = FakeCoreView(hp, shield)
        self.actions = []

    def _rec(self, name, *args):
        self.actions.append((name, tuple(args)))

    def spawn(self, t): self._rec("spawn", t)
    def heal(self): self._rec("heal")
    def repair_shield(self): self._rec("repair_shield")


class FakeTurn:
    """旧接口的 Turn 视图。"""

    def __init__(self, core, units, enemies, resource_cells, obstacle_cells,
                 resources, resource_space, beacon_status, beacon_pos,
                 carrier_id=None):
        self.core = core
        self.units = tuple(units)
        self.workers = tuple(u for u in units if u.unit_type is UnitType.WORKER)
        self.vanguards = tuple(u for u in units if u.unit_type is UnitType.VANGUARD)
        self.rangers = tuple(u for u in units if u.unit_type is UnitType.RANGER)
        self.visible_enemies = tuple(enemies)
        self.resource_cells = frozenset(resource_cells)
        self.obstacle_cells = frozenset(obstacle_cells)
        self.resources = resources
        self.resource_capacity = max(10, len(units) * 5)
        self.resource_space = resource_space
        self.beacon = SimpleNamespace(status=beacon_status, position=beacon_pos,
                                      carrier_id=carrier_id)
        self.state = SimpleNamespace(population=len(units))
        self.tick = 1
        self.events = ()


def make_new_state(core, units, enemies, resource_cells, obstacle_cells,
                   resources, resource_space, beacon_status, beacon_pos,
                   carrier_id=None):
    """同一场景的新接口 TickState 视图。"""
    beacon = SimpleNamespace(status=beacon_status, position=beacon_pos,
                             carrier_id=carrier_id)
    units = tuple(units)
    return TickState(
        tick=1, resources=resources, resource_capacity=max(10, len(units) * 5),
        resource_space=resource_space, core=core,
        core_view=core.view if core else None,
        units=units,
        workers=tuple(u for u in units if u.unit_type is UnitType.WORKER),
        vanguards=tuple(u for u in units if u.unit_type is UnitType.VANGUARD),
        rangers=tuple(u for u in units if u.unit_type is UnitType.RANGER),
        visible_enemies=tuple(enemies),
        resource_cells=frozenset(resource_cells),
        obstacle_cells=frozenset(obstacle_cells),
        beacon=beacon, events=(),
    )


def run_old(core, units, enemies, resource_cells, obstacle_cells, resources,
            resource_space, beacon_status, beacon_pos, carrier_id=None):
    turn = FakeTurn(core, units, enemies, resource_cells, obstacle_cells,
                    resources, resource_space, beacon_status, beacon_pos,
                    carrier_id)
    decide_actions(turn)
    out = {}
    for u in units:
        for name, args in u.actions:
            out[str(u.id)] = (name.upper(), tuple(
                str(a) if isinstance(a, Direction) else a for a in args))
    if core.actions:
        name, args = core.actions[0]
        out["core"] = (name.upper(), tuple(str(a) for a in args))
    return out


def run_new(core, units, enemies, resource_cells, obstacle_cells, resources,
            resource_space, beacon_status, beacon_pos, carrier_id=None):
    strat = BalanceStrategy(TacticConfig(), World())
    st = make_new_state(core, units, enemies, resource_cells, obstacle_cells,
                        resources, resource_space, beacon_status, beacon_pos,
                        carrier_id)
    plan = strat.decide(st)
    out = {}
    for uid, a in plan.actions.items():
        args = ()
        if a.direction is not None:
            args = (str(a.direction),)
        elif a.expected_cell is not None:
            args = (a.expected_cell,)
        out[str(uid)] = (a.kind, args)
    if plan.core_action is not None:
        ca = plan.core_action
        out["core"] = (ca.kind, (str(ca.unit_type),) if ca.unit_type else ())
    return out


SCENARIOS = ["采集", "交付", "巡逻", "战斗-sweep", "战斗-shoot", "生产", "Beacon"]


def build_scenario(name, kw):
    """按场景名构造 (core, units, enemies, resource_cells, obstacle_cells,
    resources, resource_space, beacon_status, beacon_pos)。"""
    if name == "采集":
        return (FakeCore((0, 0)), [FakeUnit((5, 5), UnitType.WORKER, 2)], [],
                [(5, 5)], [], 0, 10, None, (0, 0))
    if name == "交付":
        return (FakeCore((5, 5)), [FakeUnit((5, 5), UnitType.WORKER, 2, cargo=3)],
                [], [], [], 4, 6, None, (0, 0))
    if name == "巡逻":
        return (FakeCore((0, 0)), [FakeUnit((0, 0), UnitType.WORKER, 2)],
                [], [], [], 2, 10, None, (0, 0))
    if name == "战斗-sweep":
        return (FakeCore((0, 0)), [FakeUnit((5, 5), UnitType.VANGUARD, 4)],
                [FakeEnemy((5, 6))], [], [], 0, 10, None, (0, 0))
    if name == "战斗-shoot":
        return (FakeCore((0, 0)), [FakeUnit((5, 5), UnitType.RANGER, 2)],
                [FakeEnemy((5, 8))], [], [], 0, 10, None, (0, 0))
    if name == "生产":
        return (FakeCore((0, 0)), [FakeUnit((0, 0), UnitType.WORKER, 2)],
                [], [], [], 8, 10, None, (0, 0))
    if name == "Beacon":
        return (FakeCore((0, 0)), [FakeUnit((2, 2), UnitType.WORKER, 2)],
                [], [], [], 0, 10, BeaconStatus.GROUND, (2, 2))
    raise ValueError(name)


def main() -> int:
    failures = 0
    for name in SCENARIOS:
        core, units, enemies, res_cells, obs_cells, resources, space, b_status, b_pos = \
            build_scenario(name, None)

        old = run_old(core, units, enemies, res_cells, obs_cells, resources,
                      space, b_status, b_pos)
        core2 = FakeCore(core.position, core.view.hp, core.view.shield)
        units2 = [FakeUnit(u.position, u.unit_type, u.hp, u.cargo, u.id)
                  for u in units]
        enemies2 = [FakeEnemy(e.position, e.kind, e.id) for e in enemies]
        new = run_new(core2, units2, enemies2, res_cells, obs_cells, resources,
                      space, b_status, b_pos)

        # 归一化：shoot 的 expected_cell 与旧接口 position 对齐
        normalized_new = {}
        for k, (kind, args) in new.items():
            if kind == "SHOOT":
                args = (args[0],)  # 只比 target 位置
            normalized_new[k] = (kind, args)

        if old == normalized_new:
            print(f"  OK  {name}")
        else:
            failures += 1
            print(f"FAIL  {name}\n  old={old}\n  new={normalized_new}")

    if failures:
        print(f"\n对比失败 {failures} 个场景")
        return 1
    print("\n全部场景新旧决策一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
