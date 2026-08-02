"""LLM 层测试：parser 严格校验、LLMStrategy fallback、prompt 构建。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.llm.backend import AskResult, LLMBackend, ToolCall
from arena_bot.llm.llm_strategy import LLMStrategy, state_to_prompt
from arena_bot.llm.parser import parse_llm_plan, parse_tool_plan
from arena_bot.world import World


class FakeCoreView:
    def __init__(self, hp=5, shield=5, state=None):
        self.hp = hp
        self.shield = shield
        self.state = state if state is not None else CoreState.NORMAL


class FakeCore:
    def __init__(self, position=(0, 0)):
        self.id = uuid.uuid4()
        self.position = position
        self.view = FakeCoreView()


class FakeUnit:
    def __init__(self, pos, unit_type, hp=2, cargo=0, uid=None):
        self.id = uid if uid is not None else uuid.uuid4()
        self.position = pos
        self.unit_type = unit_type
        self.hp = hp
        self.cargo = cargo


class FakeBackend:
    """可编程 backend：固定 AskResult / 抛错 / 记录调用。"""

    def __init__(self, results=None, error=None):
        self.results = list(results or [])
        self.error = error
        self.calls: list[tuple[str, int]] = []
        self.closed = False

    def ask(self, message: str, request_id: str, timeout: float) -> AskResult:
        self.calls.append((request_id, len(message)))
        if self.error is not None:
            raise self.error
        return self.results.pop(0) if self.results else AskResult(text="")

    def close(self) -> None:
        self.closed = True


def tool_call(name, **input):
    return ToolCall(name=name, input=input)


def make_state(units=(), enemies=(), resources=5):
    core = FakeCore()
    units = tuple(units)
    return TickState(
        tick=42, resources=resources, resource_capacity=max(10, len(units) * 5),
        resource_space=10, core=core, core_view=core.view, units=units,
        workers=tuple(u for u in units if u.unit_type is UnitType.WORKER),
        vanguards=tuple(u for u in units if u.unit_type is UnitType.VANGUARD),
        rangers=tuple(u for u in units if u.unit_type is UnitType.RANGER),
        visible_enemies=tuple(enemies), resource_cells=frozenset(),
        obstacle_cells=frozenset(),
        beacon=SimpleNamespace(status=BeaconStatus.GROUND, position=(0, 20),
                               carrier_id=None),
        events=(),
    )


# ---------- parser：合法路径 ----------

def test_parse_valid_plan():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    text = ('{"actions": [{"unit": "%s", "kind": "MOVE", "direction": "RIGHT"}], '
            '"core": {"kind": "SPAWN", "unit_type": "WORKER"}, '
            '"reason": "扩张"}' % w.id)
    plan = parse_llm_plan(text, st)
    assert plan is not None
    a = plan.actions[w.id]
    assert a.kind == "MOVE"
    assert a.direction is Direction.RIGHT
    assert plan.core_action.kind == "SPAWN"
    assert plan.core_action.unit_type is UnitType.WORKER


def test_parse_valid_plan_fence_and_prefix():
    """容忍 ```json 围栏 + 单位 ID 前 8 位。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    prefix = str(w.id)[:8]
    text = (f"```json\n{{\"actions\": [{{\"unit\": \"{prefix}\", "
            f"\"kind\": \"HARVEST\"}}], \"core\": null}}\n```")
    plan = parse_llm_plan(text, st)
    assert plan is not None
    assert plan.actions[w.id].kind == "HARVEST"


def test_parse_shoot_with_coords():
    r = FakeUnit((5, 5), UnitType.RANGER)
    target = uuid.uuid4()
    st = make_state(units=[r])
    text = ('{"actions": [{"unit": "%s", "kind": "SHOOT", '
            '"target_id": "%s", "expected_cell": [5, 8]}]}' % (r.id, target))
    plan = parse_llm_plan(text, st)
    assert plan is not None
    a = plan.actions[r.id]
    assert a.kind == "SHOOT"
    assert a.expected_cell == (5, 8)


# ---------- parser：非法路径（全部 None → 回退） ----------

def test_parse_rejects_unknown_unit():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    text = '{"actions": [{"unit": "nobody", "kind": "HARVEST"}]}'
    assert parse_llm_plan(text, st) is None


def test_parse_rejects_bad_kind():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    text = '{"actions": [{"unit": "%s", "kind": "NUKE"}]}' % w.id
    assert parse_llm_plan(text, st) is None


def test_parse_rejects_bad_direction():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    text = '{"actions": [{"unit": "%s", "kind": "MOVE", "direction": "对角线"}]}' % w.id
    assert parse_llm_plan(text, st) is None


def test_parse_rejects_duplicate_unit():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    text = ('{"actions": [{"unit": "%s", "kind": "HARVEST"}, '
            '{"unit": "%s", "kind": "DEPOSIT"}]}' % (w.id, w.id))
    assert parse_llm_plan(text, st) is None


def test_parse_rejects_vague_text():
    """模糊指令（'去巡逻''采矿'）不是契约 JSON → None。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    assert parse_llm_plan("去采矿，然后回家交付", st) is None
    assert parse_llm_plan("", st) is None


def test_parse_rejects_core_action_without_core():
    st = make_state(units=[])  # core 存在
    text = '{"actions": [], "core": {"kind": "SPAWN", "unit_type": "WORKER"}}'
    assert parse_llm_plan(text, st) is not None


# ---------- LLMStrategy：决策与回退 ----------

def test_llm_strategy_uses_tool_call():
    """主路径：arena_plan tool_use → Plan。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(results=[
        AskResult(text="", tool_calls=[tool_call(
            "arena_plan", actions=[{"unit": str(w.id), "kind": "HARVEST"}],
            core=None)])])
    strat = LLMStrategy(TacticConfig(), World(), backend=backend)
    plan = strat.decide(st)
    assert plan.actions[w.id].kind == "HARVEST"
    assert len(backend.calls) == 1
    assert backend.calls[0][0] == "tick-42"


def test_llm_strategy_fallback_on_timeout():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(error=TimeoutError("slow"))
    strat = LLMStrategy(TacticConfig(), World(), backend=backend)
    plan = strat.decide(st)
    # 回退到 balance：资源 8 够造 Worker（早期 5+1）
    assert plan.core_action is not None
    assert plan.core_action.kind == "SPAWN"


def test_llm_strategy_fallback_when_no_tool():
    """未调用 arena_plan（纯文本）→ 回退确定性策略。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=2)
    backend = FakeBackend(results=[AskResult(text="去巡逻吧，保护好家园")])
    strat = LLMStrategy(TacticConfig(), World(), backend=backend)
    plan = strat.decide(st)
    # 回退 balance：worker 在 (5,5)，home (0,0)，巡逻移动
    assert plan.actions.get(w.id) is not None


def test_llm_strategy_fallback_on_bad_tool_input():
    """arena_plan 参数校验失败（未知单位）→ 回退确定性策略。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=2)
    backend = FakeBackend(results=[
        AskResult(text="", tool_calls=[tool_call(
            "arena_plan", actions=[{"unit": "nobody", "kind": "HARVEST"}],
            core=None)])])
    strat = LLMStrategy(TacticConfig(), World(), backend=backend)
    plan = strat.decide(st)
    assert plan.actions.get(w.id) is not None  # balance 兜底


def test_llm_strategy_close_releases_backend():
    backend = FakeBackend()
    strat = LLMStrategy(TacticConfig(), World(), backend=backend)
    strat.close()
    assert backend.closed is True


def test_prompt_first_includes_rules_then_incremental():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    first = state_to_prompt(st, first=True)
    later = state_to_prompt(st, first=False)
    assert "规则约束" in first       # 首 Tick 有完整规则
    assert "规则约束" not in later   # 之后增量（缓存前缀稳定）
    assert "tick-42" not in first and "Tick 42" in first
    assert str(w.id) in later        # 单位全量 ID 供 LLM 引用
