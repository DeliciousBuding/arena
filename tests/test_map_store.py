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


def test_live_cross_process_visibility(tmp_path):
    """P0-1 核心：进程不重启，实时看到另一实例的新写入（revision 增量）。"""
    db = tmp_path / "m.db"
    ms1 = MapStore(db)
    ms1.record({(1, 1)}, "t1", 1)
    ms2 = MapStore(db)  # ms2 启动后 ms1 持续运行
    assert ms2.obstacles() == frozenset({(1, 1)})
    # ms2 写入 → ms1 无需重启即看到
    ms2.record({(50, 50), (51, 51)}, "t2", 2)
    assert ms1.obstacles() == frozenset({(1, 1), (50, 50), (51, 51)})
    # 盟友同样实时
    ms2.register_ally("buding", "t2", 2)
    assert ms1.allies() == frozenset({"buding"})
    # revision 单调递增
    r1 = ms1.stats()["revision"]
    ms2.record({(60, 60)}, "t2", 3)
    assert ms1.stats()["revision"] > r1
    ms1.close()
    ms2.close()


def test_concurrent_writers_no_lock(tmp_path):
    """两实例并发写不同障碍：busy_timeout 下无 database locked，全部落盘。

    模拟两个租户进程：各 writer 线程用自己创建的连接（SQLite 连接线程亲和，
    生产中是每进程一个连接，无跨线程问题）。
    """
    import threading
    db = tmp_path / "m.db"
    ms1 = MapStore(db)  # 主线程连接，最后用于验证可见性
    results = {}

    def writer(name, cells):
        ms = MapStore(db)  # 本线程专用连接（模拟独立进程）
        try:
            results[name] = ms.record(cells, name, 1)
        except Exception as exc:  # noqa: BLE001
            results[name] = f"ERROR: {exc}"
        finally:
            ms.close()

    t1 = threading.Thread(target=writer, args=("t1", {(i, i) for i in range(10)}))
    t2 = threading.Thread(target=writer, args=("t2", {(i, i + 100) for i in range(10)}))
    t1.start(); t2.start(); t1.join(); t2.join()
    assert "ERROR" not in str(results.values())
    # 主线程连接实时看到双方数据（无锁冲突）
    assert len(ms1.obstacles()) == 20
    ms1.close()


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


def test_ally_registration_and_shared(tmp_path):
    """盟友注册跨实例共享（4 账号互相注册为盟友）。"""
    db = tmp_path / "m.db"
    ms1 = MapStore(db)
    assert ms1.register_ally("delicious233", "t1", 1) is True
    assert ms1.register_ally("delicious233", "t1", 2) is False  # 去重
    ms1.close()
    ms2 = MapStore(db)
    ms2.register_ally("buding", "t2", 1)
    assert ms2.allies() == frozenset({"delicious233", "buding"})
    ms2.close()


def test_balance_ignores_ally_core(tmp_path):
    """盟友 Core 不视为敌人（不攻击/不追击）。"""
    ms = MapStore(tmp_path / "m.db")
    ms.register_ally("ally1", "t2", 1)
    world = World(map_store=ms)
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    ally_core = SimpleNamespace(id=uuid.uuid4(), position=(5, 6), kind="CORE",
                                owner_username="ally1")
    # 直接构造 TickState（make_state 不支持 visible_enemies）
    st = TickState(
        tick=1, resources=0, resource_capacity=10, resource_space=10,
        core=core, core_view=core.view, units=(v,),
        workers=(), vanguards=(v,), rangers=(),
        visible_enemies=(ally_core,), resource_cells=frozenset(),
        obstacle_cells=frozenset(),
        beacon=SimpleNamespace(status=BeaconStatus.GROUND, position=(0, 20),
                               carrier_id=None),
        events=(),
    )
    plan = strat.decide(st)
    a = plan.actions.get(v.id)
    assert a is not None and a.kind != "SWEEP"  # 不攻击盟友 Core（守家移动合法）
    ms.close()


def test_balance_attacks_enemy_core(tmp_path):
    """非盟友 Core 仍是敌人（会攻击）。"""
    ms = MapStore(tmp_path / "m.db")
    world = World(map_store=ms)
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    v = FakeUnit((5, 5), UnitType.VANGUARD, 4)
    enemy_core = SimpleNamespace(id=uuid.uuid4(), position=(5, 6), kind="CORE",
                                 owner_username="enemy1")
    st = TickState(
        tick=1, resources=0, resource_capacity=10, resource_space=10,
        core=core, core_view=core.view, units=(v,),
        workers=(), vanguards=(v,), rangers=(),
        visible_enemies=(enemy_core,), resource_cells=frozenset(),
        obstacle_cells=frozenset(),
        beacon=SimpleNamespace(status=BeaconStatus.GROUND, position=(0, 20),
                               carrier_id=None),
        events=(),
    )
    plan = strat.decide(st)
    a = plan.actions.get(v.id)
    assert a is not None and a.kind == "SWEEP"
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
