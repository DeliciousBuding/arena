"""tactic.py 决策逻辑的无凭据测试（合成 Turn，零网络）。

验证分支：生命周期、恢复、经济（采集/交付/移动）、战斗（sweep/shoot/射程）、
Beacon 拾取、生产、障碍回避、确定性。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from tactic import decide_actions, manhattan, _line_blocked, _step_toward


class FakeUnit:
    def __init__(self, pos, unit_type, hp, cargo=0, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.unit_type = unit_type
        self.hp = hp
        self.cargo = cargo
        self.actions = []

    def _rec(self, name, *args):
        self.actions.append((name, args))

    def move(self, d): self._rec("move", d)
    def harvest(self): self._rec("harvest")
    def deposit(self): self._rec("deposit")
    def heal(self): self._rec("heal")
    def pickup_beacon(self): self._rec("pickup_beacon")
    def sweep(self, d): self._rec("sweep", d)
    def shoot(self, target): self._rec("shoot", target)


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
        self.actions = []

    def spawn(self, t): self.actions.append(("spawn", t))
    def heal(self): self.actions.append(("heal",))
    def repair_shield(self): self.actions.append(("repair_shield",))


class FakeTurn:
    def __init__(self, core=None, units=(), enemies=(), resource_cells=(),
                 obstacle_cells=(), resources=0, resource_space=10,
                 beacon_status=None, beacon_pos=(0, 0), carrier_id=None,
                 population=None, tick=1, events=()):
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
        self.state = SimpleNamespace(population=population if population is not None else len(units))
        self.tick = tick
        self.events = tuple(events)


def actions_of(unit):
    return [a for a, _ in unit.actions]


def core_at(pos=(10, 10)):
    return FakeCore(position=pos)


# ---------- 经济 ----------

def test_worker_harvest_on_resource_cell():
    core = core_at((0, 0))
    w = FakeUnit((5, 5), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resource_cells=[(5, 5)])
    decide_actions(turn)
    assert actions_of(w) == ["harvest"]


def test_worker_deposit_cargo_at_core():
    core = core_at((5, 5))
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=3)
    turn = FakeTurn(core=core, units=[w], resources=4, resource_space=6)
    decide_actions(turn)
    assert actions_of(w) == ["deposit"]


def test_worker_cargo_at_full_core_waits():
    core = core_at((5, 5))
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=3)
    turn = FakeTurn(core=core, units=[w], resources=10, resource_space=0)
    decide_actions(turn)
    assert actions_of(w) == []  # 满容量：原地等待


def test_worker_with_cargo_moves_home():
    core = core_at((0, 0))
    w = FakeUnit((3, 0), UnitType.WORKER, 2, cargo=2)
    turn = FakeTurn(core=core, units=[w])
    decide_actions(turn)
    assert actions_of(w) == ["move"]


def test_worker_moves_to_nearest_resource():
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w],
                    resource_cells=[(2, 0), (0, 3), (10, 10)])
    decide_actions(turn)
    assert actions_of(w) == ["move"]
    d = w.actions[0][1][0]
    assert d is Direction.RIGHT  # (2,0) 最近，x 轴优先


def test_worker_avoids_obstacle():
    core = core_at((0, 0))
    w = FakeUnit((3, 0), UnitType.WORKER, 2, cargo=1)
    turn = FakeTurn(core=core, units=[w],
                    obstacle_cells=[(2, 0)])  # 直线回家被堵
    decide_actions(turn)
    assert actions_of(w) == ["move"]
    d = w.actions[0][1][0]
    assert d in (Direction.DOWN, Direction.UP)  # 绕行，不撞障碍


def test_worker_fully_boxed_in_waits():
    core = core_at((0, 0))
    w = FakeUnit((1, 0), UnitType.WORKER, 2, cargo=1)
    turn = FakeTurn(core=core, units=[w],
                    obstacle_cells=[(0, 0), (2, 0), (1, 1), (1, -1)])
    decide_actions(turn)
    assert actions_of(w) == []  # 四向全堵：等待


def test_worker_explores_toward_beacon_when_no_resources():
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=2,
                    beacon_pos=(10, 0), beacon_status=BeaconStatus.GROUND)
    decide_actions(turn)
    assert actions_of(w) == ["move"]
    assert w.actions[0][1][0] is Direction.RIGHT  # 巡逻主方向朝向 Beacon 轴


def test_worker_returns_home_beyond_explore_radius():
    core = core_at((0, 0))
    w = FakeUnit((10, 0), UnitType.WORKER, 2)  # 距 Core 10 > EXPLORE_RADIUS 8
    turn = FakeTurn(core=core, units=[w], resources=2,
                    beacon_pos=(10, 0), beacon_status=BeaconStatus.GROUND)
    decide_actions(turn)
    assert actions_of(w) == ["move"]
    assert w.actions[0][1][0] is Direction.LEFT  # 回头朝家走


def test_multiple_workers_patrol_different_directions():
    core = core_at((0, 0))
    # Beacon 在正东 → base 方向 RIGHT；2 个 Worker 依次取 RIGHT / DOWN
    w1 = FakeUnit((0, 0), UnitType.WORKER, 2, uid=uuid.UUID(int=1))
    w2 = FakeUnit((0, 0), UnitType.WORKER, 2, uid=uuid.UUID(int=2))
    turn = FakeTurn(core=core, units=[w1, w2], resources=2,
                    beacon_pos=(10, 0), beacon_status=BeaconStatus.GROUND)
    decide_actions(turn)
    assert w1.actions[0][1][0] is Direction.RIGHT  # index 0 → 主方向
    assert w2.actions[0][1][0] is Direction.DOWN   # index 1 → 顺时针一格


def test_early_spawn_worker_with_low_resources():
    # 早期（<10 资源）只留 1：res=6 即可造第 2 个 Worker（5+1）
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=6)
    decide_actions(turn)
    assert core.actions == [("spawn", UnitType.WORKER)]


def test_low_resources_blocks_spawn():
    # res=5 连 5+1 都不够：不 spawn
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=5)
    decide_actions(turn)
    assert core.actions == []


# ---------- 恢复 ----------

def test_damaged_unit_heals_at_core():
    core = core_at((5, 5))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    turn = FakeTurn(core=core, units=[v])
    decide_actions(turn)
    assert actions_of(v) == ["heal"]


def test_damaged_unit_away_from_core_moves_home():
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    turn = FakeTurn(core=core, units=[v])
    decide_actions(turn)
    assert actions_of(v) == ["move"]  # 不在 Core 格：heal 必失败，改为移动回家


def test_unit_does_not_heal_while_core_moving():
    core = FakeCore((5, 5), state=CoreState.MOVING)
    v = FakeUnit((5, 5), UnitType.VANGUARD, 1)
    turn = FakeTurn(core=core, units=[v])
    decide_actions(turn)
    assert actions_of(v) == []  # CORE_MOVING：heal 必失败


# ---------- 战斗 ----------

def test_vanguard_sweeps_adjacent_enemy():
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    e = FakeEnemy((5, 6))
    turn = FakeTurn(core=core, units=[v], enemies=[e])
    decide_actions(turn)
    assert actions_of(v) == ["sweep"]
    assert v.actions[0][1][0] is Direction.DOWN


def test_ranger_shoots_in_range_line():
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 8))  # 垂直距离 3，直线无遮挡
    turn = FakeTurn(core=core, units=[r], enemies=[e])
    decide_actions(turn)
    assert actions_of(r) == ["shoot"]


def test_ranger_shoots_diagonal():
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((8, 8))  # 45 度对角距离 3
    turn = FakeTurn(core=core, units=[r], enemies=[e])
    decide_actions(turn)
    assert actions_of(r) == ["shoot"]


def test_ranger_wont_shoot_unaligned():
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((7, 6))  # 偏移 (2,1)：不对齐
    turn = FakeTurn(core=core, units=[r], enemies=[e])
    decide_actions(turn)
    assert actions_of(r) != ["shoot"]


def test_ranger_shot_blocked_by_obstacle():
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 8))
    turn = FakeTurn(core=core, units=[r], enemies=[e], obstacle_cells=[(5, 6)])
    decide_actions(turn)
    assert actions_of(r) != ["shoot"]


def test_ranger_out_of_range_moves():
    core = core_at((0, 0))
    r = FakeUnit((5, 5), UnitType.RANGER, 2)
    e = FakeEnemy((5, 9))  # 距离 4：超射程
    turn = FakeTurn(core=core, units=[r], enemies=[e])
    decide_actions(turn)
    assert actions_of(r) == ["move"]


def test_vanguard_moves_toward_enemy():
    core = core_at((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    e = FakeEnemy((5, 8))  # 距离 3：非相邻，逼近
    turn = FakeTurn(core=core, units=[v], enemies=[e])
    decide_actions(turn)
    assert actions_of(v) == ["move"]


def test_combat_units_guard_home_when_close_to_core():
    # 敌人在 4 格内且单位离 Core <= 4：守家不动（守家优先于追击）
    core = core_at((0, 0))
    v = FakeUnit((2, 0), UnitType.VANGUARD, 4)
    e = FakeEnemy((4, 0))
    turn = FakeTurn(core=core, units=[v], enemies=[e])
    decide_actions(turn)
    assert actions_of(v) == []


# ---------- Beacon ----------

def test_unit_picks_up_ground_beacon():
    core = core_at((0, 0))
    w = FakeUnit((2, 2), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w],
                    beacon_status=BeaconStatus.GROUND, beacon_pos=(2, 2))
    decide_actions(turn)
    assert actions_of(w) == ["pickup_beacon"]


def test_unit_ignores_distant_beacon():
    core = core_at((0, 0))
    w = FakeUnit((2, 2), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w],
                    beacon_status=BeaconStatus.GROUND, beacon_pos=(9, 9))
    decide_actions(turn)
    assert actions_of(w) == ["move"]  # 不同格不拾取：空 Worker 朝家走


# ---------- 生产 ----------

def test_core_spawns_worker_when_affordable():
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=8)  # 5 + RESERVE 3
    decide_actions(turn)
    assert core.actions == [("spawn", UnitType.WORKER)]


def test_core_does_not_spawn_when_low_resources():
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=4)  # 不够 5+3
    decide_actions(turn)
    assert core.actions == []


def test_core_heals_when_damaged():
    core = FakeCore((0, 0), hp=2)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=5)
    decide_actions(turn)
    assert core.actions == [("heal",)]


def test_core_repairs_shield_before_spawning():
    core = FakeCore((0, 0), shield=3)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=8)
    decide_actions(turn)
    assert core.actions == [("repair_shield",)]


def test_core_mixing_army_after_worker_target():
    core = core_at((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(8)]
    turn = FakeTurn(core=core, units=units, resources=13)  # 10+3
    decide_actions(turn)
    assert core.actions == [("spawn", UnitType.VANGUARD)]


def test_core_stops_at_pop_ceiling():
    core = core_at((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(20)]
    turn = FakeTurn(core=core, units=units, resources=50)
    decide_actions(turn)
    assert core.actions == []  # POP_CEILING=20：不越界


def test_core_cannot_spawn_while_moving():
    core = FakeCore((0, 0), state=CoreState.MOVING)
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=20)
    decide_actions(turn)
    assert core.actions == []


# ---------- 生命周期 ----------

def test_respawning_no_core_no_crash():
    w = FakeUnit((5, 5), UnitType.WORKER, 2, cargo=1)
    turn = FakeTurn(core=None, units=[w], resources=0)
    decide_actions(turn)
    # 无 Core：不安排伪造动作（worker 有 cargo 但不知家在哪 → 原地等待）
    assert actions_of(w) == []


def test_all_units_wait_when_nothing_to_do():
    # 空手 Worker 在家也会出门巡逻（巡逻目标在半径圆周上）
    core = core_at((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    turn = FakeTurn(core=core, units=[w], resources=2)
    decide_actions(turn)
    assert actions_of(w) == ["move"]
    assert core.actions == []


# ---------- 工具函数 ----------

def test_manhattan():
    assert manhattan((0, 0), (3, 4)) == 7
    assert manhattan((5, 5), (5, 5)) == 0


def test_line_blocked_diagonal_intermediate_only():
    # 对角中间格被堵 → 挡；旁边格被堵 → 不挡
    assert _line_blocked((0, 0), (3, 3), {(1, 1)}) is True
    assert _line_blocked((0, 0), (3, 3), {(1, 2)}) is False
    assert _line_blocked((0, 0), (2, 2), {(1, 2)}) is False


def test_step_toward_prefers_major_axis():
    d = _step_toward((0, 0), (0, 5), set())
    assert d is Direction.DOWN
    d = _step_toward((0, 0), (5, 0), set())
    assert d is Direction.RIGHT


# ---------- 确定性 ----------

def test_deterministic_same_input_same_output():
    from copy import deepcopy

    def snapshot(turn):
        core = turn.core
        units = sorted(turn.units, key=lambda u: u.id)

        def norm_args(args):
            # shoot 的目标是敌人对象：归一化为 (position, id)，排除内存地址
            out = []
            for x in args:
                if hasattr(x, "position"):
                    out.append(("target", x.position, str(x.id)))
                else:
                    out.append(str(x))
            return tuple(out)

        return {
            "core_actions": tuple(core.actions) if core else None,
            "unit_actions": tuple(
                (str(u.id), tuple((a, norm_args(args)) for a, args in u.actions))
                for u in units
            ),
        }

    def build():
        # 固定 UUID 保证敌人/单位排序确定（核心是决策确定性而非夹具随机性）
        core = FakeCore((3, 3), uid=uuid.UUID(int=0))
        units = [
            FakeUnit((3, 3), UnitType.WORKER, 2, cargo=1, uid=uuid.UUID(int=1)),
            FakeUnit((1, 1), UnitType.WORKER, 2, uid=uuid.UUID(int=2)),
            FakeUnit((2, 2), UnitType.VANGUARD, 4, uid=uuid.UUID(int=3)),
            FakeUnit((4, 4), UnitType.RANGER, 2, uid=uuid.UUID(int=4)),
        ]
        enemies = [FakeEnemy((5, 5), uid=uuid.UUID(int=5)),
                   FakeEnemy((4, 3), uid=uuid.UUID(int=6))]
        return FakeTurn(core=core, units=units, enemies=enemies,
                        resource_cells=[(0, 0), (6, 6)],
                        obstacle_cells=[(2, 1), (1, 2)],
                        resources=15)

    t1, t2 = build(), build()
    decide_actions(t1)
    decide_actions(t2)
    assert snapshot(t1) == snapshot(t2)
