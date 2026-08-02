"""Phase D 测试：全局阶段机、Worker 状态机序列、调试端点。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.core.unit_state import WorkerState
from arena_bot.debug_api import COMMANDS, handle_request
from arena_bot.phase_machine import GamePhase, PhaseMachine
from arena_bot.strategies import BalanceStrategy
from arena_bot.world import World


# ---------- C3 全局阶段状态机 ----------

def test_phase_starts_early():
    m = PhaseMachine(TacticConfig())
    assert m.phase is GamePhase.EARLY_EXPANSION


def test_phase_to_balanced_when_economy_matures():
    m = PhaseMachine(TacticConfig())
    assert m.update(population=6, resources=25, enemy_near_core=0) is GamePhase.BALANCED


def test_phase_stays_early_when_poor():
    m = PhaseMachine(TacticConfig())
    assert m.update(population=3, resources=5, enemy_near_core=0) is GamePhase.EARLY_EXPANSION


def test_phase_military_on_population():
    m = PhaseMachine(TacticConfig())
    assert m.update(population=19, resources=5, enemy_near_core=0) is GamePhase.MILITARY


def test_phase_military_on_threat():
    m = PhaseMachine(TacticConfig())
    assert m.update(population=3, resources=5, enemy_near_core=2) is GamePhase.MILITARY


def test_phase_force_for_debug():
    m = PhaseMachine(TacticConfig())
    m.force(GamePhase.MILITARY)
    assert m.phase is GamePhase.MILITARY


# ---------- C4 Worker 状态机序列 ----------

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


def test_worker_goes_to_harvest_target_across_ticks():
    """视野内看到资源 → GO_HARVEST 前往；资源不可见但记忆在线索中 → 继续前往。"""
    world = World()
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    w = FakeUnit((0, 0), UnitType.WORKER, 2)

    # Tick 1：看到 (5, 0) 资源 → GO_HARVEST 朝右
    st1 = make_state(core=core, units=[w], resource_cells=[(5, 0)])
    p1 = strat.decide(st1)
    assert p1.actions[w.id].kind == "MOVE"
    assert world.unit_states.get(w.id).worker_state is WorkerState.GO_HARVEST
    world.observe(1, st1.obstacle_cells, st1.resource_cells, ())

    # Tick 2：资源不可见（视野外）→ 记忆目标仍有效 → 继续前往
    w.position = (1, 0)
    st2 = make_state(core=core, units=[w])
    p2 = strat.decide(st2)
    assert p2.actions[w.id].kind == "MOVE"
    assert p2.intents.get(w.id) == "go_harvest_mem"
    world.observe(2, st2.obstacle_cells, st2.resource_cells, ())


def test_worker_harvest_failed_clears_target():
    """HARVEST_FAILED（被抢/耗竭）→ 目标从线索失效 → 回 PATROL 巡逻。"""
    world = World()
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    w = FakeUnit((2, 0), UnitType.WORKER, 2)

    st1 = make_state(core=core, units=[w], resource_cells=[(2, 0)])
    p1 = strat.decide(st1)
    assert p1.actions[w.id].kind == "HARVEST"
    world.observe(1, st1.obstacle_cells, st1.resource_cells, (),
                  harvest_failed_cells={(2, 0)})

    # 下一 Tick：目标已失效 → 巡逻（不再 go_harvest_mem）
    st2 = make_state(core=core, units=[w])
    p2 = strat.decide(st2)
    assert p2.intents.get(w.id) != "go_harvest_mem"
    assert world.unit_states.get(w.id).worker_state is WorkerState.PATROL


def test_worker_harvest_success_then_return_deposit():
    """采集成功 → cargo=1 → RETURN 回家 → DEPOSIT。"""
    world = World()
    strat = BalanceStrategy(TacticConfig(), world)
    core = FakeCore((0, 0))
    w = FakeUnit((2, 0), UnitType.WORKER, 2)

    # 采集成功（事件处理由 main 调 world.mark_harvested）
    world.mark_harvested((2, 0), 1)

    # cargo=1 离家 → RETURN
    w.cargo = 1
    st = make_state(core=core, units=[w])
    p = strat.decide(st)
    assert p.intents.get(w.id) == "return_home"

    # 到家 → DEPOSIT
    w.position = (0, 0)
    st = make_state(core=core, units=[w], resource_space=9)
    p = strat.decide(st)
    assert p.actions[w.id].kind == "DEPOSIT"


# ---------- D1 调试端点 ----------

def _snapshot():
    return {"tick": 42, "units": [{"id": "u1"}],
            "strategies": {"phase": "early_expansion", "explore_radius": 8}}


def _command(cmd, args):
    return True, f"ok {cmd} {args}"


def test_get_state():
    code, body = handle_request("GET", "/state", None, _snapshot, _command)
    assert code == 200
    assert body["tick"] == 42
    assert "strategies" in body


def test_get_strategies():
    code, body = handle_request("GET", "/strategies", None, _snapshot, _command)
    assert code == 200
    assert body["strategies"]["phase"] == "early_expansion"


def test_get_unknown_404():
    code, _ = handle_request("GET", "/nope", None, _snapshot, _command)
    assert code == 404


def test_post_command_ok():
    code, body = handle_request("POST", "/command",
                                b'{"cmd": "set_param", "args": {"explore_radius": 12}}',
                                _snapshot, _command)
    assert code == 200
    assert body == {"ok": True, "msg": "ok set_param {'explore_radius': 12}"}


def test_post_command_unknown_rejected():
    code, body = handle_request("POST", "/command", b'{"cmd": "rm_rf"}',
                                _snapshot, _command)
    assert code == 400
    assert "invalid command" in body["error"]


def test_post_command_bad_json():
    code, _ = handle_request("POST", "/command", b"not json", _snapshot, _command)
    assert code == 400


def test_command_whitelist():
    assert set(COMMANDS) == {"pause", "resume", "set_param", "set_phase"}
