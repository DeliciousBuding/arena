"""map_store 共享地图测试：测绘去重、跨实例共享、策略合并视野外障碍。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.map_store import MapStore
from arena_bot.strategies import BalanceStrategy
from arena_bot.world import World


def test_record_dedup(tmp_path):
    ms = MapStore(tmp_path / "m.db")
    assert ms.record({(5, 5), (6, 6)}, "t1", 1) == 2
    assert ms.record({(5, 5), (7, 7)}, "t1", 2) == 1  # (5,5) 去重
    assert ms.obstacles() == frozenset({(5, 5), (6, 6), (7, 7)})
    ms.close()


def test_cross_instance_shared(tmp_path):
    """两个 MapStore 实例（模拟两个租户进程）共享同一 DB。"""
    db = tmp_path / "m.db"
    ms1 = MapStore(db)
    ms1.record({(1, 1), (2, 2)}, "t1", 1)
    ms1.close()
    ms2 = MapStore(db)  # 新实例加载已有数据
    assert ms2.obstacles() == frozenset({(1, 1), (2, 2)})
    ms2.record({(3, 3)}, "t2", 2)
    ms2.close()
    ms3 = MapStore(db)
    assert ms3.obstacles() == frozenset({(1, 1), (2, 2), (3, 3)})
    ms3.close()


def test_stats_chunks(tmp_path):
    ms = MapStore(tmp_path / "m.db")
    ms.record({(5, 5), (100, 100)}, "t1", 1)  # (5,5) chunk(0,0); (100,100) chunk(3,3)
    stats = ms.stats()
    assert stats["obstacles_known"] == 2
    assert stats["chunks_explored"] == 2
    ms.close()


def test_world_records_to_map_store(tmp_path):
    ms = MapStore(tmp_path / "m.db")
    world = World(map_store=ms)
    world.observe(1, frozenset({(5, 5)}), frozenset(), (), observer="t1")
    assert ms.obstacles() == frozenset({(5, 5)})
    ms.close()


def test_balance_uses_shared_obstacles(tmp_path):
    """巡逻避开共享地图已知但当前不可见的障碍。"""
    ms = MapStore(tmp_path / "m.db")
    ms.record({(2, 0)}, "t2", 1)  # 另一租户测绘的障碍
    world = World(map_store=ms)
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    w = FakeUnit((3, 0), UnitType.WORKER, 2, cargo=1)  # 回家路径被共享障碍挡
    st = make_state(core=core, units=[w])  # 当前视野无障碍
    plan = strat.decide(st)
    a = plan.actions.get(w.id)
    assert a is not None and a.kind == "MOVE"
    assert a.direction in (Direction.DOWN, Direction.UP)  # 绕行，不撞共享障碍
    ms.close()


# ---- 夹具 ----

class FakeUnit:
    def __init__(self, pos, unit_type, hp, cargo=0, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.unit_type = unit_type
        self.hp = hp
        self.cargo = cargo


class FakeCoreView:
    def __init__(self, hp=5, shield=5, state=None):
        self.hp = hp
        self.shield = shield
        self.state = state if state is not None else CoreState.NORMAL


class FakeCore:
    def __init__(self, position):
        self.id = uuid.uuid4()
        self.position = position
        self.view = FakeCoreView()


def make_state(core=None, units=(), resource_cells=(), obstacle_cells=(),
               resources=0, resource_space=10, beacon_pos=(0, 20)):
    beacon = SimpleNamespace(status=BeaconStatus.GROUND, position=beacon_pos,
                             carrier_id=None)
    units = tuple(units)
    return TickState(
        tick=1, resources=resources, resource_capacity=max(10, len(units) * 5),
        resource_space=resource_space, core=core,
        core_view=core.view if core else None,
        units=units,
        workers=tuple(u for u in units if u.unit_type is UnitType.WORKER),
        vanguards=tuple(u for u in units if u.unit_type is UnitType.VANGUARD),
        rangers=tuple(u for u in units if u.unit_type is UnitType.RANGER),
        visible_enemies=(), resource_cells=frozenset(resource_cells),
        obstacle_cells=frozenset(obstacle_cells), beacon=beacon, events=(),
    )
