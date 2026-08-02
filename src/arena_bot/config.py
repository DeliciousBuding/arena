"""配置：战术参数、阶段阈值、调试端点、.env 秘钥读取。

TacticConfig 为 frozen dataclass：运行期参数调整通过 replace() 产生新实例
（debug API 的 set_param 走这条路径），不引入可变全局状态。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_PATH = PROJECT_ROOT / ".env"
MAP_STORE_PATH = PROJECT_ROOT / "mapstore" / "arena_map.db"

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

    # 积累模式（GOAL：攒资源兑换商店商品）
    accumulate_target: int = 0    # Core 资源 ≥ 此值停止消费（0 = 关闭积累模式）
    guard_resources: int = 30     # 资源 ≥ 此值视为"值得抢"→ 触发守备补兵
    guard_force: int = 4          # 守备兵力目标数（Vanguard+Ranger）

    # 自诊断 watchdog（卡死/停滞告警）
    watchdog_stall_ticks: int = 20  # 连续 N tick 无进展视为停滞（约 5 分钟）

    # W3 差分回放素材：raw state 落盘（每 tick 一个 JSON，含完整 objects/events）
    raw_state_dir: str = ""         # 空 = 不存；非空 = 每 tick 写 <dir>/<tick>.json

    # LLM 决策后端（pi RPC 长驻，兼容原 pi 设计）
    llm_pi_cli: str = "pi-dev/packages/coding-agent/dist/cli.js"  # 相对项目根
    llm_model: str = "newapi/deepseek-v4-flash"
    llm_timeout: float = 60.0       # 单 Tick 决策超时（窗口 15 秒内需留提交余量）
    llm_startup_timeout: float = 30.0
    llm_session_dir: str = "logs/pi_rpc_sessions"  # 会话落盘（缓存前缀稳定）
    llm_pi_extension: str = "packages/pi-arena/src/index.ts"  # pi-arena 原生 extension
    llm_retries: int = 2            # 决策级重试次数（瞬态失败，指数退避）
    llm_retry_delay: float = 2.0    # 重试退避基数（秒），第 n 次等待 delay*2^n
    llm_rules: str = "standard"     # RULES 变体：standard/aggressive/economic

    # 调试端点
    debug_host: str = "127.0.0.1"
    debug_port: int = 8123

    def spawn_reserve(self, resources: int) -> int:
        """早期激进扩张：资源少时留 1，富足后留 3。"""
        return self.reserve_wealthy if resources >= self.wealthy_threshold else self.reserve_early

    def with_param(self, name: str, value: object) -> "TacticConfig":
        """运行时参数调整（debug API / 实验参数覆盖）：返回新实例；未知参数抛 KeyError。"""
        if name not in self.__dataclass_fields__:
            raise KeyError(f"未知参数: {name}")
        return replace(self, **{name: value})

    def with_params(self, params: dict) -> "TacticConfig":
        """批量参数覆盖（实验定义）。"""
        cfg = self
        for name, value in params.items():
            cfg = cfg.with_param(name, value)
        return cfg


@dataclass(frozen=True)
class TenantConfig:
    """单个账号租户的运行时配置（进程隔离，一租户一进程）。"""

    index: int                     # 租户索引（0-based），决定 key/端口/路径
    name: str                      # 租户名：t1/t2/t3...
    api_key: str
    strategy_name: str = "balance"  # 策略注册表名字
    params: dict = field(default_factory=dict)  # 实验参数覆盖
    base_port: int = 8123           # 调试端口 = base_port + index
    run_dir: Path | None = None     # run-scoped 目录（runs/<run_id>/）；None=旧 telemetry/ 兼容

    @property
    def debug_port(self) -> int:
        return self.base_port + self.index

    @property
    def log_dir(self) -> Path:
        return PROJECT_ROOT / "logs" / f"tenant-{self.name}"

    @property
    def telemetry_path(self) -> Path:
        # run-scoped：runs/<run_id>/telemetry/tN.jsonl；无 run_dir 时旧路径（.csv 兼容废弃）
        if self.run_dir is not None:
            return self.run_dir / "telemetry" / f"{self.name}.jsonl"
        return PROJECT_ROOT / "telemetry" / f"{self.name}.jsonl"


def load_api_key() -> str:
    """从 .env 或环境变量读取 API key（不经 stdout 打印）。"""
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("ARENA_HERO_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("ARENA_HERO_API_KEY", "")


def load_tenant_keys() -> list[str]:
    """读多租户 key：ARENA_HERO_API_KEY_1..N；无序号时回退单 key。

    返回列表与租户索引对应（index 0 → 第一个 key）。
    """
    keys: list[str] = []
    idx = 1
    while True:
        name = f"ARENA_HERO_API_KEY_{idx}"
        env_value = os.environ.get(name, "")
        file_value = ""
        if ENV_PATH.exists():
            for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(f"{name}="):
                    file_value = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        if env_value:
            keys.append(env_value)
        elif file_value:
            keys.append(file_value)
        else:
            break
        idx += 1
    if not keys:
        fallback = load_api_key()
        if fallback:
            keys.append(fallback)
    return keys
