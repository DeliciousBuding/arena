"""结构化日志：文件轮转 + stdout 双写，[tick] 上下文关联。

- 文件 logs/arena.log：DEBUG 全量，大小轮转（5MB x 5 份）
- stdout：INFO 实时摘要（事件明细只在文件）
- tick 通过 TickFilter 注入每条记录，不侵入调用方签名
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
LOG_DIR = PROJECT_ROOT / "logs"
LOG_FILE = LOG_DIR / "arena.log"

_FORMAT = "[%(asctime)s][tick %(tick)d][%(levelname)s] %(name)s: %(message)s"

# 模块级当前 tick：主循环每个 Turn 更新，TickFilter 注入日志记录
_current_tick = 0

_configured = False


def set_current_tick(tick: int) -> None:
    """主循环在收到每个 Turn 时调用，使后续日志带 tick 上下文。"""
    global _current_tick
    _current_tick = tick


class _TickFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.tick = _current_tick
        return True


def setup_logging(level: int = logging.INFO,
                  log_dir: Path | None = None) -> logging.Logger:
    """初始化 arena_bot 日志树（幂等）。文件 DEBUG 全量 + stdout INFO 摘要。

    log_dir 覆盖日志目录（多租户：每租户 logs/tenant-<name>/）。
    """
    global _configured
    root = logging.getLogger("arena_bot")
    if _configured:
        return root
    root.setLevel(logging.DEBUG)
    fmt = logging.Formatter(_FORMAT)

    target_dir = Path(log_dir) if log_dir is not None else LOG_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        target_dir / "arena.log", maxBytes=5 * 1024 * 1024, backupCount=5,
        encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(fmt)
    file_handler.addFilter(_TickFilter())

    stream_handler = logging.StreamHandler()
    stream_handler.setLevel(level)
    stream_handler.setFormatter(fmt)
    stream_handler.addFilter(_TickFilter())

    root.addHandler(file_handler)
    root.addHandler(stream_handler)
    _configured = True
    return root


def get_logger(name: str) -> logging.Logger:
    """按模块取 logger：arena_bot.<name>。"""
    return logging.getLogger(f"arena_bot.{name}")
