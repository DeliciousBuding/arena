"""BalanceStrategy 决策测试：旧 tactic.py 38 例的等价迁移（Plan 结构）。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.strategy import Plan
from arena_bot.strategies import BalanceStrategy
from arena_bot.world import World


class FakeUnit:
    def __init__(self, pos, unit_type, hp, cargo=0, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.unit_type = unit_type
        self.hp = hp
        self.cargo = cargo


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
    def __init__(self, position, hp=5, shield=5, state=None, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = position
        self.view = FakeCoreView(hp, shield, state)


def make_state(core=None, units=(), enemies=(), resource_cells=(),
               obstacle_cells=(), resources=0, resource_space=10,
               beacon_status=None, beacon_pos=(0, 0), carrier_id=None,
               population=None, tick=1):
    beacon = SimpleNamespace(status=beacon_status, position=beacon_pos,
                             carrier_id=carrier_id)
    units = tuple(units)
    return TickState(
        tick=tick, resources=resources,
        resource_capacity=max(10, len(units) * 5),
        resource_space=resource_space,
        core=core, core_view=core.view if core else None,
        units=units,
        workers=tuple(u for u in units if u.unit_type is UnitType.WORKER),
        vanguards=tuple(u for u in units if u.unit_type is UnitType.VANGUARD),
        rangers=tuple(u for u in units if u.unit_type is UnitType.RANGER),
        visible_enemies=tuple(enemies),
        resource_cells=frozenset(resource_cells),
        obstacle_cells=frozenset(obstacle_cells),
        beacon=beacon, events=(),
    )


def make_strategy():
    return BalanceStrategy(TacticConfig(), World())


def actions_of(strategy, state, uid):
    plan = strategy.decide(state)
    action = plan.actions.get(uid)
    return (action.kind,) if action else ()


def action_of(strategy, state, uid):
    return strategy.decide(state).actions.get(uid)


def core_action_of(strategy, state):
    return strategy.decide(state).core_action


def core_at(pos=(10, 10)):
    return FakeCore(position=pos)


# ---------- 经济 ----------

def test_worker_harvest_on_resource_cell():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((5, 5), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resource_cells=[(5, 5)])
    assert actions_of(s, st, w.id) == ("HARVEST",)


def test_worker_deposit_cargo_at_core():
    s = make_strategy()
    core = core_at((5, 5))
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=3)
    st = make_state(core=core, units=[w], resources=4, resource_space=6)
    assert actions_of(s, st, w.id) == ("DEPOSIT",)


def test_worker_cargo_at_full_core_waits():
    s = make_strategy()
    core = core_at((5, 5))
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=3)
    st = make_state(core=core, units=[w], resources=10, resource_space=0)
    assert actions_of(s, st, w.id) == ()


def test_worker_with_cargo_moves_home():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((3, 0), UnitType.WORKER, 2, cargo=2)
    st = make_state(core=core, units=[w])
    a = action_of(s, st, w.id)
    assert a.kind == "MOVE"


def test_worker_moves_to_nearest_resource():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resource_cells=[(2, 0), (0, 3), (10, 10)])
    a = action_of(s, st, w.id)
    assert a.kind == "MOVE"
    assert a.direction is Direction.RIGHT


def test_worker_avoids_obstacle():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((3, 0), UnitType.WORKER, 2, cargo=1)
    st = make_state(core=core, units=[w], obstacle_cells=[(2, 0)])
    a = action_of(s, st, w.id)
    assert a.kind == "MOVE"
    assert a.direction in (Direction.DOWN, Direction.UP)


def test_worker_fully_boxed_in_waits():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((1, 0), UnitType.WORKER, 2, cargo=1)
    st = make_state(core=core, units=[w],
                    obstacle_cells=[(0, 0), (2, 0), (1, 1), (1, -1)])
    assert actions_of(s, st, w.id) == ()


def test_worker_explores_when_no_resources():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=2,
                    beacon_pos=(10, 0), beacon_status=BeaconStatus.GROUND)
    a = action_of(s, st, w.id)
    assert a.kind == "MOVE"
    assert a.direction is Direction.RIGHT


def test_worker_returns_home_beyond_explore_radius():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((10, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=2,
                    beacon_pos=(9, 0), beacon_status=BeaconStatus.GROUND)
    a = action_of(s, st, w.id)
    assert a.kind == "MOVE"
    assert a.direction is Direction.LEFT


def test_multiple_workers_patrol_different_directions():
    s = make_strategy()
    core = core_at((0, 0))
    w1 = FakeUnit((0, 0), UnitType.WORKER, 2, uid=uuid.UUID(int=1))
    w2 = FakeUnit((0, 0), UnitType.WORKER, 2, uid=uuid.UUID(int=2))
    st = make_state(core=core, units=[w1, w2], resources=2,
                    beacon_pos=(10, 0), beacon_status=BeaconStatus.GROUND)
    plan = s.decide(st)  # 单次 decide：两个 Worker 按序号错开扇区
    assert plan.actions[w1.id].direction is Direction.RIGHT  # index 0 → 主方向
    assert plan.actions[w2.id].direction is Direction.DOWN   # index 1 → 顺时针一格


# ---------- 恢复 ----------

def test_damaged_unit_heals_at_core():
    s = make_strategy()
    core = core_at((5, 5))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    st = make_state(core=core, units=[v])
    assert actions_of(s, st, v.id) == ("HEAL",)


def test_damaged_unit_away_from_core_moves_home():
    s = make_strategy()
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    st = make_state(core=core, units=[v])
    assert actions_of(s, st, v.id) == ("MOVE",)


def test_unit_does_not_heal_while_core_moving():
    s = make_strategy()
    core = FakeCore((5, 5), state=CoreState.MOVING)
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    st = make_state(core=core, units=[v])
    assert actions_of(s, st, v.id) == ()


# ---------- 战斗 ----------

def test_vanguard_sweeps_adjacent_enemy():
    s = make_strategy()
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    e = FakeEnemy((5, 6))
    st = make_state(core=core, units=[v], enemies=[e])
    a = action_of(s, st, v.id)
    assert a.kind == "SWEEP"
    assert a.direction is Direction.DOWN


def test_ranger_shoots_in_range_line():
    s = make_strategy()
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 8))
    st = make_state(core=core, units=[r], enemies=[e])
    a = action_of(s, st, r.id)
    assert a.kind == "SHOOT"
    assert a.target_id == e.id
    assert a.expected_cell == (5, 8)


def test_ranger_shoots_diagonal():
    s = make_strategy()
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((8, 8))
    st = make_state(core=core, units=[r], enemies=[e])
    assert actions_of(s, st, r.id) == ("SHOOT",)


def test_ranger_wont_shoot_unaligned():
    s = make_strategy()
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((7, 6))
    st = make_state(core=core, units=[r], enemies=[e])
    assert actions_of(s, st, r.id) != ("SHOOT",)


def test_ranger_shot_blocked_by_obstacle():
    s = make_strategy()
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 8))
    st = make_state(core=core, units=[r], enemies=[e], obstacle_cells=[(5, 6)])
    assert actions_of(s, st, r.id) != ("SHOOT",)


def test_ranger_out_of_range_moves():
    s = make_strategy()
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 9))
    st = make_state(core=core, units=[r], enemies=[e])
    assert actions_of(s, st, r.id) == ("MOVE",)


def test_vanguard_moves_toward_enemy():
    s = make_strategy()
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    e = FakeEnemy((5, 8))
    st = make_state(core=core, units=[v], enemies=[e])
    assert actions_of(s, st, v.id) == ("MOVE",)


def test_combat_units_guard_home_when_close_to_core():
    s = make_strategy()
    core = core_at((0, 0))
    v = FakeUnit((2, 0), UnitType.VANGUARD, 4)
    e = FakeEnemy((4, 0))
    st = make_state(core=core, units=[v], enemies=[e])
    assert actions_of(s, st, v.id) == ()


# ---------- Beacon ----------

def test_unit_picks_up_ground_beacon():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((2, 2), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w],
                    beacon_status=BeaconStatus.GROUND, beacon_pos=(2, 2))
    assert actions_of(s, st, w.id) == ("PICKUP_BEACON",)


def test_unit_ignores_distant_beacon():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((2, 2), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w],
                    beacon_status=BeaconStatus.GROUND, beacon_pos=(9, 9))
    assert actions_of(s, st, w.id) == ("MOVE",)


# ---------- 生产 ----------

def test_core_spawns_worker_when_affordable():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=8)
    a = core_action_of(s, st)
    assert a.kind == "SPAWN"
    assert a.unit_type is UnitType.WORKER


def test_core_does_not_spawn_when_low_resources():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=4)
    assert core_action_of(s, st) is None


def test_core_heals_when_damaged():
    s = make_strategy()
    core = FakeCore((0, 0), hp=2)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=5)
    assert core_action_of(s, st).kind == "HEAL"


def test_core_repairs_shield_before_spawning():
    s = make_strategy()
    core = FakeCore((0, 0), shield=3)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=8)
    assert core_action_of(s, st).kind == "REPAIR_SHIELD"


def test_core_mixing_army_after_worker_target():
    s = make_strategy()
    core = core_at((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(8)]
    st = make_state(core=core, units=units, resources=13)
    a = core_action_of(s, st)
    assert a.kind == "SPAWN"
    assert a.unit_type is UnitType.VANGUARD


def test_core_stops_at_pop_ceiling():
    s = make_strategy()
    core = core_at((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(20)]
    st = make_state(core=core, units=units, resources=50)
    assert core_action_of(s, st) is None


def test_core_cannot_spawn_while_moving():
    s = make_strategy()
    core = FakeCore((0, 0), state=CoreState.MOVING)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=20)
    assert core_action_of(s, st) is None


def test_early_spawn_worker_with_low_resources():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=6)
    a = core_action_of(s, st)
    assert a.kind == "SPAWN"
    assert a.unit_type is UnitType.WORKER


def test_low_resources_blocks_spawn():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=5)
    assert core_action_of(s, st) is None


# ---------- 生命周期 ----------

def test_respawning_no_core_no_crash():
    s = make_strategy()
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=1)
    st = make_state(core=None, units=[w], resources=0)
    assert actions_of(s, st, w.id) == ()
    assert core_action_of(s, st) is None


def test_all_units_wait_when_nothing_to_do():
    s = make_strategy()
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=2)
    a = action_of(s, st, w.id)
    assert a is not None and a.kind == "MOVE"  # 空手 Worker 出门巡逻
    assert core_action_of(s, st) is None


# ---------- 确定性 ----------

def test_deterministic_same_input_same_output():
    def build():
        core = FakeCore((3, 3), uid=uuid.UUID(int=0))
        units = [
            FakeUnit((3, 3), UnitType.WORKER, 2, cargo=1, uid=uuid.UUID(int=1)),
            FakeUnit((1, 1), UnitType.WORKER, 2, uid=uuid.UUID(int=2)),
            FakeUnit((2, 2), UnitType.VANGUARD, 4, uid=uuid.UUID(int=3)),
            FakeUnit((4, 4), UnitType.RANGER, 2, uid=uuid.UUID(int=4)),
        ]
        enemies = [FakeEnemy((5, 5), uid=uuid.UUID(int=5)),
                   FakeEnemy((4, 3), uid=uuid.UUID(int=6))]
        return make_state(core=core, units=units, enemies=enemies,
                          resource_cells=[(0, 0), (6, 6)],
                          obstacle_cells=[(2, 1), (1, 2)], resources=15)

    s1, s2 = make_strategy(), make_strategy()
    p1, p2 = s1.decide(build()), s2.decide(build())
    # Plan 是数据类：直接比较结构化输出
    assert {str(k): (a.kind, a.direction, a.expected_cell)
            for k, a in p1.actions.items()} == \
           {str(k): (a.kind, a.direction, a.expected_cell)
            for k, a in p2.actions.items()}
    assert p1.core_action == p2.core_action
