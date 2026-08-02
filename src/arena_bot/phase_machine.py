"""全局阶段状态机：EARLY_EXPANSION → BALANCED → MILITARY。

转移规则（阈值来自 config，可运行时调整）：
- 威胁（可见敌人 ≥ threat_enemy_near 且距 Core ≤ threat_enemy_dist）→ MILITARY
- 人口 ≥ military_pop → MILITARY（大军团转入军事）
- 经济成型（人口 ≥ 5 且资源 ≥ 20）且无威胁 → BALANCED
- 其他 → EARLY_EXPANSION

阶段影响决策参数（策略侧消费 self.phase）：
- EARLY：全力铺 Worker 经济
- BALANCED：Worker 目标减半，兵种均衡
- MILITARY：停止产 Worker，Vanguard 优先
"""

from __future__ import annotations

from enum import Enum

from .config import TacticConfig


class GamePhase(Enum):
    EARLY_EXPANSION = "early_expansion"
    BALANCED = "balanced"
    MILITARY = "military"


class PhaseMachine:
    def __init__(self, config: TacticConfig) -> None:
        self.config = config
        self.phase = GamePhase.EARLY_EXPANSION

    def update(self, population: int, resources: int,
               enemy_near_core: int) -> GamePhase:
        """每个 Turn 调用：根据当前态势更新阶段。返回新阶段。"""
        cfg = self.config
        if enemy_near_core >= cfg.threat_enemy_near:
            self.phase = GamePhase.MILITARY
        elif population >= cfg.military_pop:
            self.phase = GamePhase.MILITARY
        elif population >= 5 and resources >= 20:
            self.phase = GamePhase.BALANCED
        else:
            self.phase = GamePhase.EARLY_EXPANSION
        return self.phase

    def force(self, phase: GamePhase) -> None:
        """调试指令强制阶段（debug API set_phase）。"""
        self.phase = phase
