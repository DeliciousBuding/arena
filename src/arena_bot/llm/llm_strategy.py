"""LLM 决策策略：backend（pi RPC）→ parser（严格校验）→ fallback（确定性）。

注册表名 "llm"。decide() 完整链路（按优先级降级，绝不空手而归）：
1. 主路径：原生 tool calling（arena_plan）→ parse_tool_plan 严格校验
2. 兼容路径：LLM 输出自由文本 JSON → parse_llm_plan（工具调用退化时仍可用）
3. 兜底路径：全部失败/异常 → fallback.decide()（默认 balance，确定性）

健壮性设计：
- retry：瞬态失败（超时/进程/IO）指数退避重试 llm_retries 次；校验类失败不重试
  （模型没调用工具，重试大概率同样失败，直接降级）
- 进程自愈：backend 崩溃后自动重启（见 PiRpcBackend._ensure_alive）
- 决策统计：每次 decide 记录路径/延迟/重试次数 → snapshot 可观测

LLM 是"指挥官"：只输出决策意图，执行（apply_plan/合法性）由框架负责。
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from ..config import TacticConfig
from ..strategy import Plan, Strategy
from .backend import LLMBackend, PiRpcBackend
from .parser import parse_llm_plan, parse_tool_plan

if TYPE_CHECKING:
    from ..core.state import TickState
    from ..world import World

log = logging.getLogger("arena_bot.llm")

_RULES_COMMON = """输出要求:
- 每 Tick 调用 arena_plan 工具提交计划; 需要回忆已探索区域/障碍分布/盟友名单时, 可先调用 arena_map 查询（不要每 Tick 都查）
- 不要调用任何其他工具
- 无法决定时提交空 actions
- 提交后立即结束, 不要输出多余内容"""

RULES_VARIANTS: dict[str, str] = {
    "standard": """你是 Arena Hero 游戏的战术指挥官，每 Tick 必须使用 arena_plan 工具提交下一 Tick 的行动计划。

规则约束:
- Worker 采集资源后回家交付; cargo 满时优先回家; 无可见资源时沿巡逻方向持续移动探索新区域, 不要原地等待
- 优先造 Worker 到 8 个, 之后 Vanguard/Ranger 交替
- 人口上限 20 (tier 0 免 upkeep); spawn 后保留 3 资源应急
- 受损单位在自家静止 Core 格自动 HEAL; Core 先补 HP 再修盾再生产
- Vanguard 相邻 SWEEP、逼近敌人; Ranger 只射 8 方向 1-3 格无遮挡目标
- 地面 Beacon 同格自动拾取 (采集 2 倍收益)
- 结盟: @delicious233 @buding @delicious23333 @deliciousbuding 是我们的账号,
  它们和它们的 Core 不是敌人, 绝不攻击

""" + _RULES_COMMON,
    "aggressive": """你是 Arena Hero 游戏的进攻型战术指挥官，每 Tick 必须使用 arena_plan 工具提交下一 Tick 的行动计划。

规则约束:
- 经济只够军备: Worker 铺到 6 个即可, 之后全力造 Vanguard/Ranger
- 主动求战: 视野内有敌人时 Vanguard 立即逼近 SWEEP, Ranger 走位到可射角度射击
- 敌人近 Core 时优先击杀而不是生产; spawn 后保留 2 资源应急
- 受损单位回自家静止 Core 格自动 HEAL; Core 先修盾 (进攻姿态) 再补 HP
- 无可见敌人时 Vanguard/Ranger 向核心外围推进, 不要蹲守
- 地面 Beacon 同格自动拾取 (采集 2 倍收益)
- 结盟: @delicious233 @buding @delicious23333 @deliciousbuding 是我们的账号,
  它们和它们的 Core 不是敌人, 绝不攻击

""" + _RULES_COMMON,
    "economic": """你是 Arena Hero 游戏的种田型战术指挥官，每 Tick 必须使用 arena_plan 工具提交下一 Tick 的行动计划。

规则约束:
- 经济优先: Worker 铺到 10 个, 保持 2 个专职巡逻探路, 其余轮换采集
- 积累至上: 资源主要攒着 (accumulate_target 达成前不造兵); 只有敌人进犯 Core 才造守卫
- 避战: 视野内有敌人时单位远离而不是主动接战; 保留 4 资源应急
- 受损单位回自家静止 Core 格自动 HEAL; Core 先补 HP 再修盾 (防御姿态)
- 无可见资源时 Worker 沿巡逻方向持续移动探索, 不要原地等待
- 地面 Beacon 同格自动拾取 (采集 2 倍收益)
- 结盟: @delicious233 @buding @delicious23333 @deliciousbuding 是我们的账号,
  它们和它们的 Core 不是敌人, 绝不攻击

""" + _RULES_COMMON,
}

# 兼容旧引用（离线脚本等）
RULES = RULES_VARIANTS["standard"]


def rules_for(config: "TacticConfig") -> str:
    """按配置选 RULES 变体（llm_rules 参数，默认 standard）。"""
    return RULES_VARIANTS.get(config.llm_rules, RULES_VARIANTS["standard"])


_EVENT_SHORT = {
    "HARVEST_SUCCEEDED": "采✓",
    "DEPOSIT_SUCCEEDED": "交✓",
    "UNIT_MOVE_SUCCEEDED": "移✓",
    "UNIT_HEAL_SUCCEEDED": "治✓",
    "CORE_HEAL_SUCCEEDED": "疗✓",
    "UNIT_DAMAGED": "伤",
    "UPKEEP_DEFICIT": "粮缺",
    "CORE_RESOURCES_CAPTURED": "库被夺",
    "WORKER_CARGO_DROPPED": "货落",
}


def _events_summary(events) -> str:
    """上轮执行结果 → 一行摘要（决策闭环：agent 看到自己的计划效果）。"""
    if not events:
        return ""
    counts: dict[str, int] = {}
    harvest_fails: list = []
    for ev in events:
        t = getattr(ev, "event_type", "")
        counts[t] = counts.get(t, 0) + 1
        if t == "HARVEST_FAILED" and getattr(ev, "position", None):
            harvest_fails.append(tuple(ev.position))
    parts = []
    for t, n in counts.items():
        short = _EVENT_SHORT.get(t)
        if short is None:
            continue  # 未知事件不显示（保持输出稳定）
        parts.append(f"{short}×{n}")
    if harvest_fails:
        parts.append(f"采✗{sorted(harvest_fails)[:4]}")
    return "结果 " + " ".join(parts) if parts else ""


def state_to_prompt(state: "TickState", first: bool = False,
                    rules: str | None = None) -> str:
    """Tick 状态 → 决策 prompt（首 Tick 含完整规则，之后仅增量）。

    增量只发局势，不发规则 → prompt 前缀逐 Tick 稳定 → DeepSeek context cache
    命中（实测 94-98%），token 成本和时间都大幅下降。
    状态符号化（固定字段序，比自然语言省 token 且更稳定）+ 上轮结果反馈
    （决策闭环）。rules=None 时用默认 standard（首 Tick 才需要）。
    """
    lines = [(rules if rules is not None else RULES), ""] if first else [""]
    core = state.core
    core_pos = f"({core.position[0]},{core.position[1]})" if core else "无"
    lines.append(
        f"T{state.tick} R{state.resources}/{state.resource_capacity} "
        f"P{state.population} | Core{core_pos}"
        f" h{core.view.hp if core else '-'}s{core.view.shield if core else '-'}")
    if state.visible_enemies:
        lines.append("敌:")
        for e in sorted(state.visible_enemies, key=lambda x: x.id):
            owner = getattr(e, "owner_username", "")
            lines.append(
                f"- {e.kind[0]} {str(e.id)[:8]}({e.position[0]},{e.position[1]})"
                f"{f'@{owner}' if owner else ''}")
    if state.resource_cells:
        lines.append(f"资 {sorted(state.resource_cells)[:12]}")
    lines.append("我:")
    for u in sorted(state.units, key=lambda x: x.id):
        cargo = getattr(u, "cargo", None)
        line = (f"- {u.unit_type.value[0]} {u.id}({u.position[0]},{u.position[1]})"
                f"h{u.hp}")
        if cargo is not None:
            line += f"c{cargo}"
        lines.append(line)
    summary = _events_summary(state.events)
    if summary:
        lines.append(summary)
    lines.append("")
    lines.append("请调用 arena_plan 工具提交下一 Tick 计划:")
    return "\n".join(lines)


class LLMStrategy(Strategy):
    """LLM 指挥官策略：tool calling 主路径 + 文本兼容 + 确定性兜底。"""

    name = "llm"

    def __init__(self, config: TacticConfig, world: "World",
                 backend: "LLMBackend | None" = None,
                 fallback: "Strategy | None" = None,
                 map_url: str | None = None) -> None:
        super().__init__(config, world)
        if backend is None:
            backend = PiRpcBackend(
                pi_cli=config.llm_pi_cli, model=config.llm_model,
                session_dir=config.llm_session_dir,
                startup_timeout=config.llm_startup_timeout,
                arena_extension=config.llm_pi_extension,
                map_url=map_url)
        self.backend = backend
        self.fallback = fallback if fallback is not None else _balance(config, world)
        self._rules = rules_for(config)  # RULES 变体（standard/aggressive/economic）
        self._bootstrap_epoch = -1       # 已发完整规则的会话纪元（P0-3）
        # 决策统计（snapshot/telemetry 可观测）
        self.stats = {
            "calls": 0, "tool_ok": 0, "text_ok": 0, "fallback": 0,
            "retries": 0, "last_latency_s": 0.0, "avg_latency_s": 0.0,
        }

    def decide(self, state: "TickState") -> Plan:
        # bootstrap 判定按会话纪元：首次 / backend 重启（epoch+1）都要重发完整规则
        epoch = getattr(self.backend, "session_epoch", 0)
        first = self._bootstrap_epoch != epoch
        if first:
            self._bootstrap_epoch = epoch
        prompt = state_to_prompt(state, first=first, rules=self._rules)
        self.stats["calls"] += 1

        result, latency = self._ask_with_retry(state, prompt)
        if result is None:  # 重试耗尽仍失败
            return self._fallback(state, latency, "backend_error")

        # 主路径：原生 tool calling
        tool = result.tool("arena_plan")
        if tool is not None:
            plan = parse_tool_plan(tool.input, state)
            if plan is not None:
                self._mark("tool_ok", latency)
                plan.intents = {str(k): f"llm:{v}"
                                for k, v in plan.intents.items()}
                return plan
            log.warning("tick %d arena_plan 参数校验失败（%.200r），降级文本解析",
                        state.tick, tool.input)
        # 兼容路径：文本 JSON（工具未调用/校验失败时仍可能产出可用计划）
        if result.text:
            plan = parse_llm_plan(result.text, state)
            if plan is not None:
                self._mark("text_ok", latency)
                plan.intents = {str(k): f"llm:{v}"
                                for k, v in plan.intents.items()}
                return plan
        return self._fallback(state, latency, "parse_failed")

    # ---- 内部 ----

    def _ask_with_retry(self, state: "TickState", prompt: str):
        """决策级重试：瞬态失败指数退避重试，直到成功或耗尽次数。

        返回 (AskResult | None, latency)。None 表示重试耗尽。
        """
        t0 = time.monotonic()
        for attempt in range(self.config.llm_retries + 1):
            try:
                result = self.backend.ask(
                    prompt, f"tick-{state.tick}", timeout=self.config.llm_timeout)
                return result, time.monotonic() - t0
            except (TimeoutError, OSError, RuntimeError) as exc:
                if attempt < self.config.llm_retries:
                    delay = self.config.llm_retry_delay * (2 ** attempt)
                    log.warning(
                        "tick %d LLM 调用失败（第 %d 次：%s），%.1fs 后重试",
                        state.tick, attempt + 1, exc, delay)
                    time.sleep(delay)
                else:
                    log.warning("tick %d LLM 调用重试耗尽（%s），回退确定性策略",
                                state.tick, exc)
            self.stats["retries"] += 1
        return None, time.monotonic() - t0

    def _fallback(self, state: "TickState", latency: float, reason: str) -> Plan:
        self._mark("fallback", latency)
        log.warning("tick %d 降级到确定性策略（reason=%s）", state.tick, reason)
        return self.fallback.decide(state)

    def _mark(self, kind: str, latency: float) -> None:
        self.stats[kind] += 1
        self.stats["last_latency_s"] = round(latency, 2)
        n = self.stats["calls"]
        self.stats["avg_latency_s"] = round(
            (self.stats["avg_latency_s"] * (n - 1) + latency) / n, 2) if n else 0.0

    def close(self) -> None:
        self.backend.close()


def _balance(config: TacticConfig, world: "World") -> Strategy:
    from ..strategies import BalanceStrategy
    return BalanceStrategy(config, world)
