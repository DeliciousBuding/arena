"""LLM 决策输出解析：严格校验的 LLM 文本 → Plan。

设计原则（不依赖 LLM 自由发挥）：
- 输出契约是 JSON（prompt 明确要求 schema），解析失败 → 返回 None → 策略回退确定性
- 校验：单位必须属于本 Tick、动作类型白名单、枚举值合法、坐标整数对、
  每单位最多一个动作、Core 动作合法
- 模糊指令（"巡逻方向""去采矿"）不匹配契约 → None（宁可回退，不猜）
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from arena_hero import Direction, UnitType

from ..strategy import Action, Plan

if TYPE_CHECKING:
    from ..core.state import TickState

_KIND_WHITELIST = {
    "MOVE", "HARVEST", "DEPOSIT", "HEAL", "REPAIR_SHIELD", "SPAWN",
    "PICKUP_BEACON", "DROP_BEACON", "SELF_DESTRUCT", "SWEEP", "SHOOT", "WAIT",
}
_DIRECTIONS = {d.value: d for d in Direction}
_UNIT_TYPES = {u.value: u for u in UnitType}


def _extract_json(text: str) -> dict | None:
    """从 LLM 输出中提取 JSON 对象（容忍围栏/前缀说明）。"""
    text = text.strip()
    # 去掉 ```json ... ``` 围栏
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def parse_tool_plan(tool_input: dict, state: "TickState") -> "Plan | None":
    """原生 tool_use input → 严格校验的 Plan；任何不合法 → None（回退确定性）。

    input 结构由 arena_plan 工具 schema 约束（pi 原生 tool calling），
    但仍需游戏侧校验：单位归属/重复/动作白名单/枚举/坐标。
    """
    if not isinstance(tool_input, dict):
        return None
    plan = Plan(tick=state.tick)
    units_by_id = {str(u.id): u for u in state.units}
    id_prefix = {str(u.id)[:8]: u for u in state.units}
    seen: set = set()

    raw_actions = tool_input.get("actions")
    if not isinstance(raw_actions, list):
        return None
    for item in raw_actions:
        if not isinstance(item, dict):
            return None
        uid = _resolve_unit(item.get("unit"), units_by_id, id_prefix)
        if uid is None or uid in seen:
            return None
        kind = str(item.get("kind", "")).upper()
        if kind not in _KIND_WHITELIST:
            return None
        action = _build_action(uid, kind, item, state)
        if action is None:
            return None
        plan.set(action)
        seen.add(uid)

    core = tool_input.get("core")
    if core is not None:
        if not isinstance(core, dict) or state.core is None:
            return None
        kind = str(core.get("kind", "")).upper()
        if kind not in ("SPAWN", "HEAL", "REPAIR_SHIELD", "WAIT"):
            return None
        if kind == "SPAWN":
            ut = _UNIT_TYPES.get(str(core.get("unit_type", "")).upper())
            if ut is None:
                return None
            plan.core_action = Action(state.core.id, "SPAWN", unit_type=ut)
        elif kind == "HEAL":
            plan.core_action = Action(state.core.id, "HEAL")
        elif kind == "REPAIR_SHIELD":
            plan.core_action = Action(state.core.id, "REPAIR_SHIELD")
        else:
            plan.core_action = Action(state.core.id, "WAIT")
        plan.intents["core"] = f"llm_{kind.lower()}"
    return plan


def parse_llm_plan(text: str, state: "TickState") -> "Plan | None":
    """（兼容/降级路径）LLM 自由文本 JSON → Plan。工具调用为主路径。"""
    obj = _extract_json(text)
    if obj is None:
        return None
    return parse_tool_plan(obj, state)


def _resolve_unit(raw, units_by_id, id_prefix):
    """unit 字段：全量 UUID 字符串或前 8 位前缀（LLM 常截断）。返回 UUID。"""
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if raw in units_by_id:
        return units_by_id[raw].id
    if len(raw) <= 8:
        unit = id_prefix.get(raw)
        return unit.id if unit else None
    return None


def _build_action(uid, kind: str, item: dict, state: "TickState"):
    """构造单单位动作；参数非法返回 None。"""
    unit = next(u for u in state.units if u.id == uid)
    if kind == "MOVE":
        d = _DIRECTIONS.get(str(item.get("direction", "")).upper())
        return Action(uid, "MOVE", direction=d) if d else None
    if kind == "SWEEP":
        d = _DIRECTIONS.get(str(item.get("direction", "")).upper())
        return Action(uid, "SWEEP", direction=d) if d else None
    if kind == "SHOOT":
        target = _pos_or_none(item.get("expected_cell"))
        if target is None:
            return None
        tid = str(item.get("target_id", ""))
        if not tid:
            return None
        return Action(uid, "SHOOT", target_id=tid, expected_cell=target)
    if kind in ("HARVEST", "DEPOSIT", "HEAL", "PICKUP_BEACON",
                "DROP_BEACON", "SELF_DESTRUCT", "WAIT"):
        return Action(uid, kind)
    return None


def _pos_or_none(raw):
    """坐标：len-2 整数列表/元组。"""
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        return None
    try:
        return (int(raw[0]), int(raw[1]))
    except (TypeError, ValueError):
        return None
