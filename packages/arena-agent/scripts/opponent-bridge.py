#!/usr/bin/env python3
"""opponent-bridge.py — 模拟器 ↔ 外部策略进程桥接适配层（参考对手通用）。

支持两个官方参考对手（--agent）：
- farmer：榜二 arena_farmer（arena-hero-agent 仓库的 CoreFarmer，默认）
- core  ：官方完整参考 agent（arena-hero-guide 仓库的 arena_core_agent.py，
          5895 行，含搜索/战斗小队/核心推演——远强于 farmer 的守矿型）

桥接协议（R48，与 arena-sim-bridge crate 对偶）：
- stdin 每行一个 JSON：{"tick": N, "state": <官方 PlayerState 形状>}
- stdout 每行一个 JSON：官方 CommandPlan（turn.plan().model_dump()）
- 子进程跨 tick 保持——外部策略的记忆在进程内持续

对手零改动：只消费官方 SDK 的 Turn/PlayerState 接口。arena_farmer 走
farmer.choose_actions(turn)，arena_core_agent 走 plan_turn(turn, memory)
（两者都通过 SDK 方法填充 turn 的 plan builder）。本脚本是唯一适配面。

跨 tick 记忆（--state-slot）：
  Windows 桥接常用 "--one-shot"（每 tick 新起进程），此时对手的记忆
  （CoreFarmer 状态表 / AgentMemory 持久态）会随进程退出丢失。--state-slot
  把记忆写进磁盘槽：每次启动先恢复，决策后存回，从而"随用随起"也能跨
  tick 保留记忆。farmer 用 pickle（CoreFarmer.__dict__），core 用
  arena_core_agent 自带的原子 JSON 持久化（STATE_PATH 重定向到槽）。

用法：
  python scripts/opponent-bridge.py \
    [--agent farmer|core] \
    [--farmer-repo <arena-hero-agent-path>] \
    [--core-repo <arena-hero-guide-path>] \
    [--sdk-repo <arena-hero-python-path>] \
    [--worker-target 12] [--beacon-policy retreat] \
    [--mode control|harvest] [--target 30] \
    [--state-slot <槽路径>] [--one-shot]

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
DEFAULT_CORE_REPO = COORDINATION_ROOT / "reference" / "arena-hero-guide"
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


def _run_farmer(args) -> int:
    """arena_farmer（榜二）分支：CoreFarmer 实例 + pickle 槽记忆。"""
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
        f"bridge ready (farmer): worker_target={args.worker_target} "
        f"beacon_policy={args.beacon_policy} "
        f"state_slot={'on' if args.state_slot is not None else 'off'}",
        file=sys.stderr,
        flush=True,
    )

    return _serve_lines(
        line_number_args=args,
        make_decision=lambda turn: farmer.choose_actions(turn),
        persist_state=_persist_state,
    )


def _run_core(args) -> int:
    """arena_core_agent（官方完整参考）分支：AgentMemory + 原子 JSON 槽记忆。

    arena_core_agent 的 plan_turn(turn, memory) 通过 SDK 方法（unit.move()/
    worker.harvest()/...）直接填充 turn 的 plan builder——与 CoreFarmer 同构，
    桥接后 turn.plan 即官方 CommandPlan。其自带的 save_state 写模块级
    STATE_PATH（默认脚本目录），必须重定向到 state-slot 以免多局互踩。
    """
    try:
        _load_repos(args.core_repo, args.sdk_repo)
        from arena_hero.actions import CommandPlan  # noqa: F401  （导入自检）
        from arena_hero.models import PlayerState
        from arena_hero.turn import Turn
        import arena_core_agent as core_agent
    except Exception as exc:  # noqa: BLE001 —— 启动失败必须输出到 stderr 退出。
        print(f"bridge startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    if args.state_slot is not None:
        # plan_turn 内部每 10 tick（或有变更时）原子写 STATE_PATH——重定向到槽。
        core_agent.STATE_PATH = str(args.state_slot)
        core_agent.STATE_TEMP_PATH = f"{args.state_slot}.tmp"
    memory = core_agent.AgentMemory.restore(core_agent.load_persistent_state())

    def _persist_state() -> None:
        if args.state_slot is None:
            return
        try:
            args.state_slot.parent.mkdir(parents=True, exist_ok=True)
            core_agent.save_state(memory.persistent_state())
        except Exception as exc:  # noqa: BLE001 —— 槽写失败降级为无记忆，不阻断对局。
            print(f"bridge state slot write failed: {exc}", file=sys.stderr, flush=True)

    print(
        f"bridge ready (core): mode={args.mode} target={args.target} "
        f"state_slot={'on' if args.state_slot is not None else 'off'}",
        file=sys.stderr,
        flush=True,
    )

    def _decide(turn) -> None:
        # 返回值 (actions, reached) 仅用于日志；真实动作已进 turn.plan builder。
        core_agent.plan_turn(
            turn,
            memory,
            target=args.target,
            mode=args.mode,
        )

    return _serve_lines(
        line_number_args=args,
        make_decision=_decide,
        persist_state=_persist_state,
    )


def _serve_lines(*, line_number_args, make_decision, persist_state) -> int:
    """读 stdin 每行 JSON → 决策 → 输出一行 CommandPlan JSON → 存槽。

    farmer/core 两分支共用：状态构造（PlayerState → Turn）与输出协议一致。
    """
    from arena_hero.models import PlayerState
    from arena_hero.turn import Turn

    for line_number, line in enumerate(sys.stdin, start=1):
        line = line.strip()
        if not line:
            continue
        message: dict | None = None
        try:
            message = json.loads(line)
            state = PlayerState.model_validate(message["state"])
            turn = Turn(
                tick=int(message["tick"]),
                state=state,
                submitter=_noop_submitter,
            )
            make_decision(turn)
            # 注意：SDK 的 Turn.plan 是 property（返回 CommandPlan），非方法。
            plan = turn.plan
            # mode="json"：UUID key/Position 转 JSON 原生类型。
            payload = json.dumps(plan.model_dump(mode="json"), separators=(",", ":"))
            print(payload, flush=True)
            persist_state()
            if line_number_args.one_shot:
                return 0
        except Exception as exc:  # noqa: BLE001 —— 决策失败输出到 stderr
            # （模拟器端 fail-fast 中止——诚实暴露适配/对手问题）。
            print(
                f"bridge error at line {line_number} (tick "
                f"{message.get('tick') if message is not None else '?'}): {exc}",
                file=sys.stderr,
                flush=True,
            )
            return 1

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Simulator <-> external strategy process bridge (reference opponents)"
    )
    parser.add_argument(
        "--agent",
        choices=("farmer", "core"),
        default="farmer",
        help="参考对手：farmer=榜二 arena_farmer（默认）；core=官方完整参考 agent",
    )
    parser.add_argument("--farmer-repo", type=Path, default=DEFAULT_FARMER_REPO)
    parser.add_argument("--core-repo", type=Path, default=DEFAULT_CORE_REPO)
    parser.add_argument("--sdk-repo", type=Path, default=DEFAULT_SDK_REPO)
    parser.add_argument("--worker-target", type=int, default=12)
    parser.add_argument("--beacon-policy", default="retreat")
    parser.add_argument(
        "--mode",
        choices=("control", "harvest"),
        default="control",
        help="core 对手的运行模式：control=无限对局（模拟器用）；harvest=达到 --target 即止",
    )
    parser.add_argument("--target", type=int, default=30)
    parser.add_argument(
        "--one-shot",
        action="store_true",
        help="读 stdin 一行 → 决策 → 输出一行 → 退出（配合 --state-slot 保留记忆）",
    )
    parser.add_argument(
        "--state-slot",
        type=Path,
        default=None,
        help="对手记忆槽路径：farmer 用 pickle，core 用原子 JSON；启动恢复、决策后存回",
    )
    args = parser.parse_args()

    if args.agent == "core":
        return _run_core(args)
    return _run_farmer(args)


if __name__ == "__main__":
    raise SystemExit(main())
