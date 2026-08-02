"""LLM 决策策略：backend（pi RPC）→ parser（严格校验）→ fallback（确定性）。

注册表名 "llm"。decide() 流程：
1. 构建 prompt（第一 Tick 注入完整规则，之后只发局势增量 → 前缀稳定缓存命中）
2. backend.ask() → LLM 决策文本
3. parser 严格校验 → Plan；失败/超时 → fallback.decide()（默认 balance）

LLM 是"指挥官"：只输出决策意图，执行（apply_plan/合法性）由框架负责——
不暴露工具给 LLM，保持决策与执行解耦。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..config import TacticConfig
from ..strategy import Plan, Strategy
from .backend import LLMBackend, PiRpcBackend
from .parser import parse_llm_plan

if TYPE_CHECKING:
    from ..core.state import TickState
    from ..world import World

log = logging.getLogger("arena_bot.llm")

RULES = """你是 Arena Hero 游戏的战术指挥官，每 Tick 根据局势输出下一 Tick 的行动计划。

规则约束:
- Worker 采集资源后回家交付; cargo 满时优先回家; 无可见资源回家待命
- 优先造 Worker 到 8 个, 之后 Vanguard/Ranger 交替
- 人口上限 20 (tier 0 免 upkeep); spawn 后保留 3 资源应急
- 受损单位在自家静止 Core 格自动 HEAL; Core 先补 HP 再修盾再生产
- Vanguard 相邻 SWEEP、逼近敌人; Ranger 只射 8 方向 1-3 格无遮挡目标
- 地面 Beacon 同格自动拾取 (采集 2 倍收益)
- 结盟: @delicious233 @buding @delicious23333 @deliciousbuding 是我们的账号,
  它们和它们的 Core 不是敌人, 绝不攻击

输出契约: 只输出一个 JSON 对象, 不要输出其他内容:
{
  "actions": [
    {"unit": "<单位完整ID>", "kind": "MOVE", "direction": "RIGHT"},
    {"unit": "<单位完整ID>", "kind": "HARVEST"},
    {"unit": "<单位完整ID>", "kind": "SHOOT", "target_id": "<敌人ID>", "expected_cell": [x, y]}
  ],
  "core": {"kind": "SPAWN", "unit_type": "WORKER"},
  "reason": "一句话理由"
}
kind 可选: MOVE/SWEEP(需 direction: UP/DOWN/LEFT/RIGHT), HARVEST/DEPOSIT/HEAL/
PICKUP_BEACON/DROP_BEACON/SELF_DESTRUCT/WAIT, SHOOT(需 target_id+expected_cell)
core 可选: SPAWN(需 unit_type: WORKER/VANGUARD/RANGER)/HEAL/REPAIR_SHIELD/WAIT, 或 null
无法决定就输出空 actions: {"actions": [], "core": null, "reason": "..."}"""


def state_to_prompt(state: "TickState", first: bool = False) -> str:
    """Tick 状态 → 决策 prompt（首 Tick 含完整规则，之后仅增量）。"""
    lines = [RULES, ""] if first else [""]
    core = state.core
    lines.append(
        f"Tick {state.tick} | 资源 {state.resources}/{state.resource_capacity} "
        f"| 人口 {state.population} | Core@{core.position if core else '无'}"
        f" hp={core.view.hp if core else '-'} shield={core.view.shield if core else '-'}")
    lines.append(f"可见敌人 {len(state.visible_enemies)}:")
    for e in sorted(state.visible_enemies, key=lambda x: x.id):
        owner = getattr(e, "owner_username", "")
        lines.append(f"- {e.kind} {e.id} pos={e.position}"
                     f"{f' owner={owner}' if owner else ''}")
    lines.append(f"可见资源格 {len(state.resource_cells)}: "
                 f"{sorted(state.resource_cells)[:12]}")
    lines.append("我方单位:")
    for u in sorted(state.units, key=lambda x: x.id):
        cargo = getattr(u, "cargo", None)
        lines.append(
            f"- {u.unit_type.value} {u.id} pos={u.position} hp={u.hp}"
            f"{f' cargo={cargo}' if cargo is not None else ''}")
    lines.append("")
    lines.append("请给出下一 Tick 行动计划（严格按输出契约，只输出 JSON）:")
    return "\n".join(lines)


class LLMStrategy(Strategy):
    """LLM 指挥官策略：决策失败/超时回退确定性策略。"""

    name = "llm"

    def __init__(self, config: TacticConfig, world: "World",
                 backend: "LLMBackend | None" = None,
                 fallback: "Strategy | None" = None) -> None:
        super().__init__(config, world)
        if backend is None:
            backend = PiRpcBackend(
                pi_cli=config.llm_pi_cli, model=config.llm_model,
                session_dir=config.llm_session_dir,
                startup_timeout=config.llm_startup_timeout)
        self.backend = backend
        self.fallback = fallback if fallback is not None else _balance(config, world)
        self._first = True

    def decide(self, state: "TickState") -> Plan:
        prompt = state_to_prompt(state, first=self._first)
        self._first = False
        try:
            text = self.backend.ask(prompt, f"tick-{state.tick}",
                                    timeout=self.config.llm_timeout)
        except (TimeoutError, RuntimeError, OSError) as exc:
            log.warning("tick %d LLM 调用失败（%s），回退确定性策略", state.tick, exc)
            return self.fallback.decide(state)
        plan = parse_llm_plan(text, state)
        if plan is None:
            log.warning("tick %d LLM 输出解析失败（%.200s），回退确定性策略",
                        state.tick, text.replace("\n", " "))
            return self.fallback.decide(state)
        plan.intents = {str(k): f"llm:{v}" for k, v in plan.intents.items()}
        return plan

    def close(self) -> None:
        self.backend.close()


def _balance(config: TacticConfig, world: "World") -> Strategy:
    from ..strategies import BalanceStrategy
    return BalanceStrategy(config, world)
