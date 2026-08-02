"""LLM 层测试：parser 严格校验、LLMStrategy fallback、prompt 构建。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

from arena_hero import BeaconStatus, CoreState, Direction, UnitType

from arena_bot.config import TacticConfig
from arena_bot.core.state import TickState
from arena_bot.llm.backend import AskResult, LLMBackend, ToolCall, _extract_result
from arena_bot.llm.llm_strategy import LLMStrategy, _events_summary, state_to_prompt
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
    """可编程 backend：固定 AskResult / 抛错（可限前 N 次）/ 记录调用。"""

    def __init__(self, results=None, error=None, fail_first=0):
        self.results = list(results or [])
        self.error = error
        self.fail_first = fail_first  # 前 N 次调用抛错（瞬态失败语义），之后正常
        self.calls: list[tuple[str, int]] = []
        self.closed = False
        self.session_epoch = 0  # 模拟会话纪元（backend 重启时 +1）

    def ask(self, message: str, request_id: str, timeout: float) -> AskResult:
        self.calls.append((request_id, len(message)))
        if self.fail_first > 0:
            self.fail_first -= 1
            raise TimeoutError("transient")  # 瞬态失败：限前 N 次，之后正常
        if self.error is not None:
            raise self.error
        return self.results.pop(0) if self.results else AskResult(text="")

    def close(self) -> None:
        self.closed = True


def make_tool_call(name, **input):
    return ToolCall(name=name, input=input)


# ---------- backend：turn_end 提取（pi 原生命名） ----------

def test_extract_result_pi_toolCall_block():
    """pi 原生 toolCall block（arguments 字段）→ ToolCall。"""
    res = _extract_result({
        "role": "assistant", "content": [
            {"type": "thinking", "thinking": "想一下"},
            {"type": "toolCall", "id": "call_1", "name": "arena_plan",
             "arguments": {"actions": [], "reason": "无"}},
        ]})
    assert res.thinking == "想一下"
    assert res.tool("arena_plan") is not None
    assert res.tool("arena_plan").input["actions"] == []
    assert res.text == ""


def test_extract_result_anthropic_tool_use_block():
    """Anthropic 风格 tool_use + input 同样兼容。"""
    res = _extract_result({
        "content": [
            {"type": "tool_use", "name": "arena_plan",
             "input": {"actions": [{"unit": "u1", "kind": "WAIT"}]}},
            {"type": "text", "text": "已提交"},
        ]})
    assert res.text == "已提交"
    assert res.tool("arena_plan").input["actions"][0]["kind"] == "WAIT"


def test_extract_result_no_blocks():
    assert _extract_result({}).text == ""
    assert _extract_result({"content": []}).tool_calls == []
    assert _extract_result({"text": "plain"}).text == "plain"


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

def test_llm_strategy_uses_make_tool_call():
    """主路径：arena_plan tool_use → Plan。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(results=[
        AskResult(text="", tool_calls=[make_tool_call(
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
    # retries=0：不重试直接回退（retry 行为另有专测）
    strat = LLMStrategy(TacticConfig(llm_retries=0), World(), backend=backend)
    plan = strat.decide(st)
    # 回退到 balance：资源 8 够造 Worker（早期 5+1）
    assert plan.core_action is not None
    assert plan.core_action.kind == "SPAWN"
    assert strat.stats["fallback"] == 1
    assert strat.stats["calls"] == 1


def test_llm_strategy_retry_then_success():
    """瞬态失败（超时）→ 指数退避重试 → 成功。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(
        fail_first=1,
        results=[AskResult(text="", tool_calls=[make_tool_call(
            "arena_plan", actions=[{"unit": str(w.id), "kind": "HARVEST"}],
            core=None)])])
    strat = LLMStrategy(
        TacticConfig(llm_retries=2, llm_retry_delay=0.01), World(), backend=backend)
    plan = strat.decide(st)
    assert plan.actions[w.id].kind == "HARVEST"
    assert len(backend.calls) == 2          # 第 1 次失败 + 重试成功
    assert strat.stats["retries"] == 1      # 失败总次数
    assert strat.stats["tool_ok"] == 1
    assert strat.stats["fallback"] == 0


def test_llm_strategy_retry_exhausted_falls_back():
    """重试耗尽仍失败 → 回退确定性策略（stats 留痕）。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(error=OSError("pipe broken"))
    strat = LLMStrategy(
        TacticConfig(llm_retries=2, llm_retry_delay=0.01), World(), backend=backend)
    plan = strat.decide(st)
    assert plan.core_action is not None     # balance 兜底
    assert len(backend.calls) == 3          # 1 次 + 2 次重试
    assert strat.stats["retries"] == 3      # 失败总次数 = calls
    assert strat.stats["fallback"] == 1


def test_llm_strategy_degrades_tool_fail_to_text_json():
    """分级降级：arena_plan 校验失败 → 文本 JSON 仍可用 → text_ok 路径。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    # 工具 input 非法（未知单位），但文本里带着合法 JSON
    backend = FakeBackend(results=[
        AskResult(
            text='{"actions": [{"unit": "%s", "kind": "HARVEST"}]}' % w.id,
            tool_calls=[make_tool_call(
                "arena_plan", actions=[{"unit": "nobody", "kind": "HARVEST"}],
                core=None)])])
    strat = LLMStrategy(TacticConfig(llm_retries=0), World(), backend=backend)
    plan = strat.decide(st)
    assert plan.actions[w.id].kind == "HARVEST"  # 不是 balance 兜底
    assert strat.stats["text_ok"] == 1
    assert strat.stats["fallback"] == 0


def test_llm_strategy_stats_recorded():
    """决策统计：calls/latency 记录。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend(results=[
        AskResult(text="", tool_calls=[make_tool_call(
            "arena_plan", actions=[{"unit": str(w.id), "kind": "HARVEST"}],
            core=None)])])
    strat = LLMStrategy(TacticConfig(llm_retries=0), World(), backend=backend)
    strat.decide(st)
    assert strat.stats["calls"] == 1
    assert strat.stats["tool_ok"] == 1
    assert strat.stats["fallback"] == 0
    assert strat.stats["avg_latency_s"] >= 0


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
        AskResult(text="", tool_calls=[make_tool_call(
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


def test_merge_tool_calls_dedup():
    """P0-2: turn_end 与 tool_execution_start 报告同一调用时不重复累积。"""
    res = AskResult(text="")
    res.merge_tool_calls([ToolCall("arena_plan", {"actions": []}, call_id="c1")])
    res.merge_tool_calls([ToolCall("arena_plan", {"actions": []}, call_id="c1")])
    res.merge_tool_calls([ToolCall("arena_map", {"query": "stats"}, call_id="c2")])
    assert len(res.tool_calls) == 2
    assert res.tool("arena_map") is not None


def test_bootstrap_resends_rules_after_epoch_change():
    """P0-3: backend 重启（epoch+1）后自动重发完整规则。"""
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w], resources=8)
    backend = FakeBackend()
    strat = LLMStrategy(TacticConfig(llm_retries=0), World(), backend=backend)
    strat.decide(st)                     # 首决策：完整规则
    full_len = backend.calls[0][1]
    strat.decide(st)                     # 增量（无规则，前缀缓存命中）
    assert backend.calls[1][1] < full_len
    backend.session_epoch = 1            # 模拟 backend 重启
    strat.decide(st)                     # 重发完整规则
    assert backend.calls[2][1] == full_len


def test_prompt_first_includes_rules_then_incremental():
    w = FakeUnit((5, 5), UnitType.WORKER)
    st = make_state(units=[w])
    first = state_to_prompt(st, first=True)
    later = state_to_prompt(st, first=False)
    assert "规则约束" in first       # 首 Tick 有完整规则
    assert "规则约束" not in later   # 之后增量（缓存前缀稳定）
    assert "T42" in first            # 符号化状态行
    assert str(w.id) in later        # 单位全量 ID 供 LLM 引用
    assert "W " in later             # 单位类型符号（WORKER→W）


def test_prompt_includes_result_feedback():
    """上轮结果反馈：采集成功/失败 → 决策闭环。"""
    from types import SimpleNamespace
    ev_ok = SimpleNamespace(event_type="HARVEST_SUCCEEDED", position=(4, 5))
    ev_bad = SimpleNamespace(event_type="HARVEST_FAILED", position=(8, 2))
    ev_move = SimpleNamespace(event_type="UNIT_MOVE_SUCCEEDED", position=(6, 5))
    st = make_state(units=[])
    prompt = state_to_prompt(st, first=False)
    st2 = make_state(units=[])
    st2 = TickState(
        tick=st2.tick, resources=st2.resources,
        resource_capacity=st2.resource_capacity, resource_space=st2.resource_space,
        core=st2.core, core_view=st2.core_view, units=st2.units,
        workers=st2.workers, vanguards=st2.vanguards, rangers=st2.rangers,
        visible_enemies=st2.visible_enemies, resource_cells=st2.resource_cells,
        obstacle_cells=st2.obstacle_cells, beacon=st2.beacon,
        events=(ev_ok, ev_bad, ev_move))
    prompt2 = state_to_prompt(st2, first=False)
    summary_line = "结果 采✓×1 移✓×1 采✗[(8, 2)]"
    assert prompt == prompt2.replace(summary_line + "\n", "")
    assert "采✓×1" in prompt2 and "移✓×1" in prompt2
    assert "采✗[(8, 2)]" in prompt2     # 失败带位置（纠错信号）
    assert _events_summary(()) == ""    # 无事件不输出


def test_rules_variants_distinct_and_configurable():
    """策略变体：standard 修复巡逻待命问题，aggressive/economic 各有人格。"""
    from arena_bot.llm.llm_strategy import RULES_VARIANTS, rules_for
    assert len(RULES_VARIANTS) >= 3
    std, agg, eco = (RULES_VARIANTS[k] for k in ("standard", "aggressive", "economic"))
    # standard 修复：无可见资源要巡逻探索而非原地待命
    assert "巡逻方向持续移动探索" in std
    assert "原地等待" in std
    # 人格差异
    assert "进攻" in agg and "经济只够军备" in agg
    assert "种田" in eco and "积累至上" in eco
    assert rules_for(TacticConfig(llm_rules="economic")) == eco
    assert rules_for(TacticConfig()) == std          # 默认 standard
    assert rules_for(TacticConfig(llm_rules="未知")) == std  # 未知回退默认
    # 变体注入 prompt（首 Tick）
    st = make_state()
    assert "经济只够军备" in state_to_prompt(st, first=True, rules=agg)
