"""租户入口：每账号一进程（多租户实验模式）。

    uv run python -m arena_bot.tenant --tenant 0
    uv run python -m arena_bot.tenant --tenant 1 --strategy balance \
        --params explore_radius=5,worker_target=12

由 run_experiments.py 调度器以子进程方式拉起。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import TacticConfig, TenantConfig, load_tenant_keys
from .main import play


def parse_params(spec: str | None) -> dict:
    """解析 'k=v,k2=v2' 参数覆盖；类型按目标字段自动转换。"""
    params: dict = {}
    if not spec:
        return params
    for item in spec.split(","):
        if not item.strip():
            continue
        key, _, raw = item.partition("=")
        key = key.strip()
        raw = raw.strip()
        # 参考 TacticConfig 字段类型：int/float/str/bool
        if raw.lower() in ("true", "false"):
            params[key] = raw.lower() == "true"
        else:
            try:
                params[key] = int(raw)
            except ValueError:
                try:
                    params[key] = float(raw)
                except ValueError:
                    params[key] = raw
    return params


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", type=int, required=True,
                        help="租户索引（0 起），对应 ARENA_HERO_API_KEY_<N> 与端口 8123+N")
    parser.add_argument("--strategy", default="balance",
                        help="策略注册表名字（默认 balance）")
    parser.add_argument("--params", default=None,
                        help="参数覆盖：explore_radius=5,worker_target=12")
    parser.add_argument("--run-dir", default=None,
                        help="run-scoped 目录（runs/<run_id>/），telemetry 写入其下")
    args = parser.parse_args()

    keys = load_tenant_keys()
    if args.tenant >= len(keys):
        print(f"错误：租户 {args.tenant} 超出可用 key 数 {len(keys)}"
              f"（.env 需配置 ARENA_HERO_API_KEY_{args.tenant + 1}）", file=sys.stderr)
        sys.exit(1)

    cfg = TacticConfig().with_params(parse_params(args.params))
    tenant = TenantConfig(index=args.tenant, name=f"t{args.tenant + 1}",
                          api_key=keys[args.tenant],
                          strategy_name=args.strategy,
                          params=parse_params(args.params),
                          run_dir=Path(args.run_dir) if args.run_dir else None)
    try:
        play(tenant.api_key, cfg, tenant)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
