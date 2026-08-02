"""策略注册表：按名实例化策略（换策略 = 改配置，不改代码）。

新策略：继承 Strategy 实现 decide()，注册到 REGISTRY。
注册表 + 参数快照 + git commit 构成实验可复现性。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..llm import LLMStrategy
from ..strategy import Strategy
from .balance import BalanceStrategy

if TYPE_CHECKING:
    from ..config import TacticConfig
    from ..world import World

REGISTRY: dict[str, type[Strategy]] = {
    "balance": BalanceStrategy,
    "llm": LLMStrategy,  # LLM 指挥官（backend=pi RPC，失败回退 balance）
}


def create_strategy(name: str, config: "TacticConfig", world: "World",
                    **kwargs) -> Strategy:
    """按名字实例化策略；未知名字抛 KeyError。kwargs 透传构造器。"""
    try:
        cls = REGISTRY[name]
    except KeyError:
        raise KeyError(f"未知策略: {name!r}，可用: {sorted(REGISTRY)}") from None
    return cls(config, world, **kwargs)


__all__ = ["BalanceStrategy", "Strategy", "REGISTRY", "create_strategy"]
