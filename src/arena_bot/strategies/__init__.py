"""策略注册表：按名实例化策略（换策略 = 改配置，不改代码）。

新策略：继承 Strategy 实现 decide()，注册到 REGISTRY。
注册表 + 参数快照 + git commit 构成实验可复现性。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..strategy import Strategy
from .balance import BalanceStrategy

if TYPE_CHECKING:
    from ..config import TacticConfig
    from ..world import World

REGISTRY: dict[str, type[Strategy]] = {
    "balance": BalanceStrategy,
}


def create_strategy(name: str, config: "TacticConfig", world: "World") -> Strategy:
    """按名字创建策略实例；未知名字抛 KeyError。"""
    try:
        cls = REGISTRY[name]
    except KeyError:
        raise KeyError(f"未知策略: {name!r}，可用: {sorted(REGISTRY)}") from None
    return cls(config, world)


__all__ = ["BalanceStrategy", "Strategy", "REGISTRY", "create_strategy"]
