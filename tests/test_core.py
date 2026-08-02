"""world.py / logging_util.py / core/state.py 单测。"""

from __future__ import annotations

import logging
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState

from arena_bot.core.state import TickState
from arena_bot.logging_util import get_logger, set_current_tick, setup_logging
from arena_bot.world import ResourceState, World


# ---------- World 记忆 ----------

def _enemy(uid, pos, kind="UNIT"):
    return SimpleNamespace(id=uid, position=pos, kind=kind)


def test_obstacle_memory_is_permanent():
    w = World()
    w.observe(1, frozenset({(5, 5), (6, 6)}), frozenset(), ())
    w.observe(2, frozenset(), frozenset(), ())  # 视野不再含障碍
    assert w.obstacles() == frozenset({(5, 5), (6, 6)})  # 永久保留


def test_resource_visible_then_stale():
    w = World()
    w.observe(1, frozenset(), frozenset({(3, 3)}), ())
    assert w.resource_memory[(3, 3)].state is ResourceState.VISIBLE
    w.observe(2, frozenset(), frozenset(), ())  # 不再可见
    assert w.resource_memory[(3, 3)].state is ResourceState.STALE


def test_resource_hints_priority():
    w = World()
    w.observe(1, frozenset(), frozenset({(3, 3)}), ())   # VISIBLE
    w.observe(2, frozenset(), frozenset(), ())           # (3,3) → STALE
    w.observe(3, frozenset(), frozenset({(7, 7)}), ())   # 新 VISIBLE
    hints = w.resource_hints()
    assert hints[0] == (7, 7)  # VISIBLE 优先
    assert (3, 3) in hints


def test_mark_harvested_removes_from_visible():
    w = World()
    w.observe(1, frozenset(), frozenset({(3, 3)}), ())
    w.mark_harvested((3, 3), 1)
    assert w.resource_memory[(3, 3)].state is ResourceState.HARVESTED
    assert (3, 3) not in w.resource_hints()


def test_enemy_tracking_and_age():
    w = World()
    e1 = _enemy("11111111-1111-1111-1111-111111111111", (1, 1))
    w.observe(1, frozenset(), frozenset(), (e1,))
    assert w.enemy_memory[e1.id].position == (1, 1)
    # 10 tick 后旧敌人不进入 hints
    w.observe(11, frozenset(), frozenset(), ())
    assert w.enemy_hints() == []


def test_harvest_failed_downgrades_cell():
    w = World()
    w.observe(1, frozenset(), frozenset({(3, 3)}), ())
    w.observe(2, frozenset(), frozenset({(3, 3)}), (), harvest_failed_cells={(3, 3)})
    assert w.resource_memory[(3, 3)].state is ResourceState.STALE


# ---------- TickState 适配层 ----------

class FakeCore:
    def __init__(self, position, state=None):
        self.position = position
        self.view = SimpleNamespace(
            state=state if state is not None else CoreState.NORMAL)


def test_tick_state_derived_fields():
    core = FakeCore((5, 5))
    st = TickState(tick=42, resources=3, resource_capacity=10, resource_space=7,
                   core=core, core_view=core.view, units=(1, 2))
    assert st.population == 2
    assert st.home == (5, 5)
    assert st.core_normal is True


def test_tick_state_core_moving_not_normal():
    core = FakeCore((5, 5), state=CoreState.MOVING)
    st = TickState(tick=1, resources=0, resource_capacity=10, resource_space=10,
                   core=core, core_view=core.view)
    assert st.core_normal is False


# ---------- 日志 ----------

def test_setup_logging_and_tick_injection(caplog):
    setup_logging()
    set_current_tick(999)
    logger = get_logger("test")
    with caplog.at_level(logging.INFO, logger="arena_bot"):
        logger.info("hello")
    assert any("tick 999" in rec.message or rec.message == "hello"
               for rec in caplog.records)
    assert any(getattr(rec, "tick", None) == 999 for rec in caplog.records)
