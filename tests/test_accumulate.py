"""accumulate 模式 + 多租户配置 + 遥测采样测试。"""

from __future__ import annotations

import csv
import uuid
from pathlib import Path
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig, TenantConfig, load_tenant_keys
from arena_bot.core.state import TickState
from arena_bot.phase_machine import GamePhase, PhaseMachine
from arena_bot.strategies import BalanceStrategy, create_strategy
from arena_bot.telemetry import Telemetry
from arena_bot.world import World


# ---------- accumulate 模式（GOAL：攒资源兑换） ----------

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


def make_state(core=None, units=(), resources=0, resource_space=10,
               beacon_pos=(0, 20)):
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
        visible_enemies=(), resource_cells=frozenset(),
        obstacle_cells=frozenset(), beacon=beacon, events=(),
    )


def acc_cfg(**overrides):
    base = {"accumulate_target": 30, "guard_resources": 20, "guard_force": 4}
    base.update(overrides)
    return TacticConfig().with_params(base)


def test_accumulate_stops_spending_at_target():
    """资源 ≥ 目标：不 spawn，意图 accumulated_target。"""
    world = World()
    strat = BalanceStrategy(acc_cfg(), world)
    core = FakeCore((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(8)]
    st = make_state(core=core, units=units, resources=31)
    plan = strat.decide(st)
    assert plan.core_action is None
    assert plan.intents.get("core") == "accumulated_target"


def test_accumulate_guards_when_resources_valuable():
    """资源 ≥ guard_resources 且兵力不足：优先造兵（不造 Worker）。"""
    world = World()
    strat = BalanceStrategy(acc_cfg(), world)
    core = FakeCore((0, 0))
    workers = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(4)]
    st = make_state(core=core, units=workers, resources=25)  # ≥20 守备
    plan = strat.decide(st)
    assert plan.core_action is not None
    assert plan.core_action.unit_type is UnitType.VANGUARD
    assert plan.intents.get("core") == "spawn_vanguard"


def test_accumulate_still_expands_before_target():
    """资源未达守备阈值：正常扩张（产 Worker）。"""
    world = World()
    strat = BalanceStrategy(acc_cfg(), world)
    core = FakeCore((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], resources=15)  # <20 守备线
    plan = strat.decide(st)
    assert plan.core_action is not None
    assert plan.core_action.unit_type is UnitType.WORKER


def test_worker_at_patrol_point_returns_home():
    """Worker 站在巡逻方向点上 → 返回回家（到家后换扇区，防卡死）。"""
    world = World()
    strat = BalanceStrategy(TacticConfig().with_params({"explore_radius": 8}),
                            world)
    core = FakeCore((0, 0))
    # beacon 在正东 → base RIGHT；worker 恰好在方向点 (8, 0)
    w = FakeUnit((8, 0), UnitType.WORKER, 2)
    st = make_state(core=core, units=[w], beacon_pos=(10, 0))
    plan = strat.decide(st)
    a = plan.actions.get(w.id)
    assert a is not None and a.kind == "MOVE"
    assert a.direction is Direction.LEFT  # 回家方向


def test_worker_rotates_sector_after_returning_home():
    """辐射巡逻：首次出发 RIGHT（index 0）→ 回家后再出发换扇区。"""
    world = World()
    strat = BalanceStrategy(TacticConfig().with_params({"explore_radius": 8}),
                            world)
    core = FakeCore((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)  # 在家
    st = make_state(core=core, units=[w], beacon_pos=(10, 0))

    # 首次：按 index 0 出发 RIGHT
    plan1 = strat.decide(st)
    assert plan1.actions[w.id].direction is Direction.RIGHT

    # 到家（模拟完成一轮巡逻）→ 换扇区 DOWN
    world.unit_states.get(w.id).patrol_started = True
    plan2 = strat.decide(st)
    assert plan2.actions[w.id].direction is Direction.DOWN


def test_accumulate_disabled_by_default():
    """accumulate_target=0（默认）：原行为不受影响。"""
    world = World()
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    units = [FakeUnit((0, 0), UnitType.WORKER, 2) for _ in range(8)]
    st = make_state(core=core, units=units, resources=50)
    plan = strat.decide(st)
    # 默认模式：会继续生产（兵力交替）
    assert plan.core_action is not None


# ---------- 策略注册表 ----------

def test_registry_create_and_unknown():
    world = World()
    strat = create_strategy("balance", TacticConfig(), world)
    assert strat.name == "balance"
    try:
        create_strategy("nope", TacticConfig(), world)
        raise AssertionError("应当抛 KeyError")
    except KeyError:
        pass


# ---------- 多租户配置 ----------

def test_tenant_config_derived_paths(tmp_path, monkeypatch):
    tenant = TenantConfig(index=0, name="t1", api_key="k")
    assert tenant.debug_port == 8123
    assert tenant.log_dir.name == "tenant-t1"
    assert tenant.telemetry_path.name == "t1.csv"
    t2 = TenantConfig(index=1, name="t2", api_key="k2")
    assert t2.debug_port == 8124  # 端口偏移


def test_tenant_keys_from_env(monkeypatch, tmp_path):
    monkeypatch.setattr("arena_bot.config.ENV_PATH", tmp_path / "empty.env")
    monkeypatch.setenv("ARENA_HERO_API_KEY_1", "k1")
    monkeypatch.setenv("ARENA_HERO_API_KEY_2", "k2")
    keys = load_tenant_keys()
    assert keys == ["k1", "k2"]


def test_tenant_keys_fallback_single(monkeypatch, tmp_path):
    monkeypatch.setattr("arena_bot.config.ENV_PATH", tmp_path / "empty.env")
    monkeypatch.delenv("ARENA_HERO_API_KEY_1", raising=False)
    monkeypatch.delenv("ARENA_HERO_API_KEY_2", raising=False)
    monkeypatch.delenv("ARENA_HERO_API_KEY", raising=False)
    assert load_tenant_keys() == []


# ---------- 遥测采样 ----------

def test_telemetry_records_and_csv_shape(tmp_path):
    path = tmp_path / "t1.csv"
    with Telemetry(path) as tele:
        tele.record(tick=1, phase="early_expansion", resources=5,
                    resource_capacity=10, population=1, workers=1,
                    vanguards=0, rangers=0, core_hp=5, core_shield=5,
                    enemies_visible=0, events=(), intents={})
        ev = SimpleNamespace(event_type="HARVEST_SUCCEEDED")
        tele.record(tick=2, phase="early_expansion", resources=6,
                    resource_capacity=10, population=1, workers=1,
                    vanguards=0, rangers=0, core_hp=5, core_shield=5,
                    enemies_visible=0, events=(ev,),
                    intents={"core": "harvest"})
        # record 后立即落盘（不依赖 close）
        assert path.read_text(encoding="utf-8").count("\n") >= 2
    with path.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 2
    assert rows[1]["HARVEST_SUCCEEDED"] == "1"
    assert rows[1]["resources"] == "6"
    assert "harvest:1" in rows[1]["intents"]


def test_telemetry_combat_counter(tmp_path):
    path = tmp_path / "t2.csv"
    with Telemetry(path) as tele:
        ev = SimpleNamespace(event_type="CORE_DESTROYED")
        tele.record(tick=1, phase="military", resources=0,
                    resource_capacity=10, population=0, workers=0,
                    vanguards=0, rangers=0, core_hp=None, core_shield=None,
                    enemies_visible=2, events=(ev,), intents={})
    with path.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    assert rows[0]["combat_events"] == "1"
