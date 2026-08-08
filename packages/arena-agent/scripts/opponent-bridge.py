#!/usr/bin/env python3
"""opponent-bridge.py — 模拟器 ↔ 外部策略进程桥接适配层（榜二 arena_farmer）。

桥接协议（R48，与 arena-sim-bridge crate 对偶）：
- stdin 每行一个 JSON：{"tick": N, "state": <官方 PlayerState 形状>}
- stdout 每行一个 JSON：官方 CommandPlan（turn.plan().model_dump()）
- 子进程跨 tick 保持——外部策略（CoreFarmer 实例）的记忆在进程内持续

榜二零改动：只消费官方 SDK 的 Turn/PlayerState 接口（turn.clear()/
turn.unit()/turn.plan()）。本脚本是唯一适配面（~90 行）。

跨 tick 记忆（--state-slot）：
  Windows 桥接常用 "--one-shot"（每 tick 新起进程），此时 CoreFarmer 的
  记忆（scout/resource/worker 状态表）会随进程退出丢失。--state-slot 把
  CoreFarmer.__dict__ pickle 到磁盘槽：每次启动先 unpickle 恢复，决策后
  pickle 存回，从而"随用随起"也能跨 tick 保留记忆。

用法：
  python scripts/opponent-bridge.py \
    [--farmer-repo <arena-hero-agent-path>] \
    [--sdk-repo <arena-hero-python-path>] \
    [--worker-target 12] [--beacon-policy retreat] \
    [--state-slot <pickle 槽路径>] [--one-shot]

诊断日志走 stderr（模拟器把外部策略 stderr 透传到终端）。
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

ARENA_TS_ROOT = Path(__file__).resolve().parents[3]
COORDINATION_ROOT = ARENA_TS_ROOT.parent
DEFAULT_FARMER_REPO = COORDINATION_ROOT / "reference" / "arena-hero-agent"
DEFAULT_SDK_REPO = COORDINATION_ROOT / "reference" / "arena-hero-python"


def _load_repos(farmer_repo: Path, sdk_repo: Path) -> None:
    """注入 arena_farmer（榜二）与官方 SDK 镜像路径到 sys.path。"""
    for repo in (sdk_repo, farmer_repo):
        resolved = repo.resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"repo not found: {resolved}")
        if str(resolved) not in sys.path:
            sys.path.insert(0, str(resolved))


def _noop_submitter(plan, idempotency_key=None):
    """桥接不提交网络——Turn.submit() 不会被调用，占位即可。"""
    return None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulator <-> external strategy process bridge (arena_farmer)"
    )
    parser.add_argument("--farmer-repo", type=Path, default=DEFAULT_FARMER_REPO)
    parser.add_argument("--sdk-repo", type=Path, default=DEFAULT_SDK_REPO)
    parser.add_argument("--worker-target", type=int, default=12)
    parser.add_argument("--beacon-policy", default="retreat")
    parser.add_argument(
        "--one-shot",
        action="store_true",
        help="读 stdin 一行 → 决策 → 输出一行 → 退出（配合 --state-slot 保留记忆）",
    )
    parser.add_argument(
        "--state-slot",
        type=Path,
        default=None,
        help="CoreFarmer 记忆 pickle 槽路径：启动恢复、每次决策后存回（跨 tick 记忆）",
    )
    args = parser.parse_args()

    try:
        _load_repos(args.farmer_repo, args.sdk_repo)
        from arena_hero.actions import CommandPlan  # noqa: F401  （导入自检）
        from arena_hero.models import PlayerState
        from arena_hero.turn import Turn
        from arena_farmer import CoreFarmer
    except Exception as exc:  # noqa: BLE001 —— 启动失败必须输出到 stderr 退出。
        print(f"bridge startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    farmer = CoreFarmer(
        worker_target=args.worker_target,
        beacon_policy=args.beacon_policy,
        # 模拟器规则 v0.13 与榜二期望一致——不需要兼容性 hold。
        compatibility_marker=None,
    )
    if args.state_slot is not None and args.state_slot.exists():
        try:
            with open(args.state_slot, "rb") as slot_file:
                farmer.__dict__.update(pickle.load(slot_file))
            print(
                f"bridge state restored from slot: {args.state_slot}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 —— 槽损坏不应阻断对局，重置即可。
            print(f"bridge state slot corrupt, starting fresh: {exc}", file=sys.stderr, flush=True)

    def _persist_state() -> None:
        if args.state_slot is None:
            return
        try:
            args.state_slot.parent.mkdir(parents=True, exist_ok=True)
            with open(args.state_slot, "wb") as slot_file:
                pickle.dump(dict(farmer.__dict__), slot_file)
        except Exception as exc:  # noqa: BLE001 —— 槽写失败降级为无记忆，不阻断对局。
            print(f"bridge state slot write failed: {exc}", file=sys.stderr, flush=True)

    print(
        f"bridge ready: worker_target={args.worker_target} "
        f"beacon_policy={args.beacon_policy} "
        f"state_slot={'on' if args.state_slot is not None else 'off'}",
        file=sys.stderr,
        flush=True,
    )

    for line_number, line in enumerate(sys.stdin, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            state = PlayerState.model_validate(message["state"])
            turn = Turn(
                tick=int(message["tick"]),
                state=state,
                submitter=_noop_submitter,
            )
            farmer.choose_actions(turn)
            # 注意：SDK 的 Turn.plan 是 property（返回 CommandPlan），非方法。
            plan = turn.plan
            # mode="json"：UUID key/Position 转 JSON 原生类型。
            payload = json.dumps(plan.model_dump(mode="json"), separators=(",", ":"))
            print(payload, flush=True)
            _persist_state()
            if args.one_shot:
                return 0
        except Exception as exc:  # noqa: BLE001 —— 决策失败输出到 stderr
            # （模拟器端 fail-fast 中止——诚实暴露适配/榜二问题）。
            print(
                f"bridge error at line {line_number} (tick "
                f"{message.get('tick') if 'message' in locals() else '?'}): {exc}",
                file=sys.stderr,
                flush=True,
            )
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
