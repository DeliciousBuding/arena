"""配置：战术参数、阶段阈值、调试端点、.env 秘钥读取。

TacticConfig 为 frozen dataclass：运行期参数调整通过 replace() 产生新实例
（debug API 的 set_param 走这条路径），不引入可变全局状态。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"

# 规则常量（对应 v0.10 契约，勿凭记忆改动）
WORKER_COST = 5
VANGUARD_COST = 10
RANGER_COST = 12
CORE_MAX_HP = 5
CORE_MAX_SHIELD = 5

UNIT_MAX_HP = {"WORKER": 2, "VANGUARD": 4, "RANGER": 2}


@dataclass(frozen=True)
class TacticConfig:
    """战术可调参数（实测调优值，debug API 可运行时调整）。"""

    # 经济
    reserve_wealthy: int = 3      # 资源充足时 spawn 后保留的应急资源
    reserve_early: int = 1        # 早期（<10 资源）只留 1，尽快铺 Worker
    wealthy_threshold: int = 10   # 资源 ≥ 此值视为"充足"
    worker_target: int = 8        # 经济目标 Worker 数，之后开始造兵
    pop_ceiling: int = 20         # 人口上限：tier 0 (0-19) 无 upkeep

    # 巡逻
    explore_radius: int = 8       # 空 Worker 巡逻半径（超距回头，缩短往返周期）

    # 阶段状态机阈值
    military_pop: int = 18        # 人口 ≥ 此值允许进入 MILITARY 阶段
    threat_enemy_near: int = 2    # 视野内可见敌人 ≥ 此值视为威胁 → 优先军事
    threat_enemy_dist: int = 5    # 敌人距 Core ≤ 此值计为"近敌"

    # 调试端点
    debug_host: str = "127.0.0.1"
    debug_port: int = 8123

    def spawn_reserve(self, resources: int) -> int:
        """早期激进扩张：资源少时留 1，富足后留 3。"""
        return self.reserve_wealthy if resources >= self.wealthy_threshold else self.reserve_early

    def with_param(self, name: str, value: object) -> "TacticConfig":
        """运行时参数调整（debug API）：返回新实例；未知参数抛 KeyError。"""
        if name not in self.__dataclass_fields__:
            raise KeyError(f"未知参数: {name}")
        return replace(self, **{name: value})


def load_api_key() -> str:
    """从 .env 或环境变量读取 API key（不经 stdout 打印）。"""
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("ARENA_HERO_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("ARENA_HERO_API_KEY", "")
