"""决策抽象：Strategy 基类 + Plan 纯数据模型 + 计划应用器。

决策与执行分离：
- Strategy.decide(state) -> Plan：纯决策，只读 TickState/World/Config，零副作用
- apply_plan(turn, plan)：提交层把 Plan 应用到 SDK controller（queue 动作）
Plan 是纯数据 → 可单测、可日志、可 diff、可被调试接口审查
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from .config import TacticConfig

if TYPE_CHECKING:
    from uuid import UUID

    from arena_hero import Direction, Turn, UnitType

    from .core.state import TickState
    from .world import World

log = logging.getLogger("arena_bot.strategy")

ActionKind = Literal[
    "MOVE", "HARVEST", "DEPOSIT", "HEAL", "REPAIR_SHIELD", "SPAWN",
    "PICKUP_BEACON", "DROP_BEACON", "SELF_DESTRUCT", "SWEEP", "SHOOT", "WAIT",
]


@dataclass(frozen=True)
class Action:
    """单个受控对象的一个动作（纯数据，不触网）。"""
    unit_id: "UUID"
    kind: ActionKind
    direction: "Direction | None" = None
    target_id: "UUID | None" = None
    expected_cell: "tuple[int, int] | None" = None
    unit_type: "UnitType | None" = None  # 仅 SPAWN 使用


@dataclass
class Plan:
    """一个 Tick 的完整计划：单位动作 + Core 动作 + 意图标签。"""
    tick: int
    actions: dict["UUID", Action] = field(default_factory=dict)
    core_action: "Action | None" = None
    intents: dict["UUID", str] = field(default_factory=dict)  # 调试/日志用

    def set(self, action: Action, intent: str = "") -> None:
        self.actions[action.unit_id] = action
        if intent:
            self.intents[action.unit_id] = intent


class Strategy(ABC):
    """决策策略基类。子类实现 decide()，保持确定性（同输入同输出）。"""

    name: str = "base"

    def __init__(self, config: TacticConfig, world: "World") -> None:
        self.config = config
        self.world = world

    @abstractmethod
    def decide(self, state: "TickState") -> Plan:
        """读取当前 Tick 状态，返回完整计划。不修改任何外部状态。"""


def apply_plan(turn: "Turn", plan: Plan) -> None:
    """把 Plan 应用到 SDK Turn（queue 动作），然后由调用方 submit。"""
    for action in plan.actions.values():
        unit = turn.unit(str(action.unit_id))
        _apply_action(unit, action)
    if plan.core_action is not None and turn.core is not None:
        _apply_action(turn.core, plan.core_action)


def _apply_action(obj, action: Action) -> None:
    kind = action.kind
    if kind == "MOVE":
        obj.move(action.direction)
    elif kind == "HARVEST":
        obj.harvest()
    elif kind == "DEPOSIT":
        obj.deposit()
    elif kind == "HEAL":
        obj.heal()
    elif kind == "REPAIR_SHIELD":
        obj.repair_shield()
    elif kind == "SPAWN":
        obj.spawn(action.unit_type)
    elif kind == "PICKUP_BEACON":
        obj.pickup_beacon()
    elif kind == "DROP_BEACON":
        obj.drop_beacon()
    elif kind == "SELF_DESTRUCT":
        obj.self_destruct()
    elif kind == "SWEEP":
        obj.sweep(action.direction)
    elif kind == "SHOOT":
        # SDK 签名：shoot(target, *, expected_cell=None) —— expected_cell 仅关键字
        obj.shoot(action.target_id, expected_cell=action.expected_cell)
    elif kind == "WAIT":
        obj.wait()
    else:  # pragma: no cover
        raise ValueError(f"未知动作类型: {kind}")
