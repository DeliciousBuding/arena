#!/usr/bin/env python3
"""opponent-bridge.py — 模拟器 ↔ 外部策略进程桥接适配层（注册表驱动）。

对手由 scripts/python-agents.json 注册表声明（--agent <注册名>）。新增 Python
对手 = 注册表加一个条目（repo/module/construct/decide/slot），桥接零改动。

最小契约（所有对手共同遵守）：
  decide 入口（实例方法或模块函数）用官方 SDK 的 turn 方法填充 plan builder
  （turn.unit(id).move(...) / worker.harvest() / turn.plan 读取），bridge 负责
  把 turn.plan 序列化输出。farmer 的 choose_actions(turn) 即此契约的实例方法版。

桥接协议（R48，与 arena-sim-bridge crate 对偶）：
- stdin 每行一个 JSON：{"tick": N, "state": <官方 PlayerState 形状>}
- stdout 每行一个 JSON：官方 CommandPlan（turn.plan.model_dump()）

跨 tick 记忆（--state-slot）：
  Windows 桥接常用 "--one-shot"（每 tick 新起进程），此时对手的记忆会随进程
  退出丢失。--state-slot 把记忆写进磁盘槽：启动恢复、决策后存回。槽类型由
  注册表声明：pickle（farmer 的 __dict__）/ json（core 的原子持久化）。
  --slot-every N：写盘降频（常驻进程记忆在进程内持续，槽仅备份/恢复用；
  默认注册表值；--one-shot 强制每 tick 写——跨进程记忆必须完整）。

用法：
  python scripts/opponent-bridge.py \
    [--agent farmer|core|<注册名>] \
    [--farmer-repo <arena-hero-agent-path>] \
    [--core-repo <arena-hero-guide-path>] \
    [--sdk-repo <arena-hero-python-path>] \
    [--worker-target 12] [--beacon-policy retreat] \
    [--mode control|harvest] [--target 30] \
    [--state-slot <槽路径>] [--slot-every N] [--one-shot]

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
REGISTRY_PATH = Path(__file__).resolve().parent / "python-agents.json"


def _load_agent_registry() -> dict:
    """读 python-agents.json（注册表）。"""
    with open(REGISTRY_PATH, encoding="utf-8") as registry_file:
        registry = json.load(registry_file)
    return registry["agents"]


def _load_repos(repo: Path, sdk_repo: Path) -> None:
    """注入对手仓库与官方 SDK 镜像路径到 sys.path（sdk 优先，防同名模块遮蔽）。"""
    for repo_path in (sdk_repo, repo):
        resolved = repo_path.resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"repo not found: {resolved}")
        if str(resolved) not in sys.path:
            sys.path.insert(0, str(resolved))


def _noop_submitter(plan, idempotency_key=None):
    """桥接不提交网络——Turn.submit() 不会被调用，占位即可。"""
    return None


def _build_agent(args, config: dict):
    """按注册表条目构建对手运行时：返回 (decide, persist, ready_label)。

    decide(turn)：填充 turn.plan builder；persist()：写盘降频的记忆槽。
    """
    repo = (COORDINATION_ROOT / "reference" / config["repo"]).resolve()
    _load_repos(repo, args.sdk_repo)
    module = __import__(config["module"])

    slot = config.get("slot", "pickle")
    construct = config.get("construct")
    decide_name = config["decide"]

    instance = None
    memory = None
    if construct is not None:
        cls = getattr(module, construct["fn"])
        kwargs = {}
        if "worker_target" in construct.get("kwargs", []):
            kwargs["worker_target"] = args.worker_target
        if "beacon_policy" in construct.get("kwargs", []):
            kwargs["beacon_policy"] = args.beacon_policy
        if "compatibility_marker" in construct.get("kwargs", []):
            # 模拟器规则与榜二期望一致——不需要兼容性 hold。
            kwargs["compatibility_marker"] = None
        instance = cls(**kwargs)

    # 槽路径重定向（json 型 agent 的自带持久化写模块级 STATE_PATH）
    state_paths = config.get("state_paths", [])
    if args.state_slot is not None and slot == "json":
        for attr in state_paths:
            setattr(module, attr, str(args.state_slot) if "TEMP" not in attr else f"{args.state_slot}.tmp")

    # 槽恢复
    if slot == "pickle" and instance is not None and args.state_slot is not None and args.state_slot.exists():
        try:
            with open(args.state_slot, "rb") as slot_file:
                instance.__dict__.update(pickle.load(slot_file))
            print(
                f"bridge state restored from slot: {args.state_slot}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 —— 槽损坏不应阻断对局，重置即可。
            print(f"bridge state slot corrupt, starting fresh: {exc}", file=sys.stderr, flush=True)
    if slot == "json":
        memory = module.AgentMemory.restore(module.load_persistent_state())

    decide_kwargs = {}
    if "target" in config.get("decide_kwargs", []):
        decide_kwargs["target"] = args.target
    if "mode" in config.get("decide_kwargs", []):
        decide_kwargs["mode"] = args.mode

    def decide(turn) -> None:
        if instance is not None:
            getattr(instance, decide_name)(turn)
            return
        if memory is not None:
            # core 分支：返回值 (actions, reached) 仅用于日志；动作已进 builder。
            module.plan_turn(turn, memory, **decide_kwargs)
            return
        getattr(module, decide_name)(turn, **decide_kwargs)

    # 写盘降频：one-shot 必须每 tick；常驻默认注册表 slotEvery。
    slot_every = (
        1
        if args.one_shot
        else (args.slot_every if args.slot_every is not None else config.get("slotEvery"))
    )
    decision_count = [0]

    def persist() -> None:
        if args.state_slot is None:
            return
        decision_count[0] += 1
        if slot_every is not None and decision_count[0] % slot_every != 0:
            return
        try:
            args.state_slot.parent.mkdir(parents=True, exist_ok=True)
            if slot == "pickle" and instance is not None:
                with open(args.state_slot, "wb") as slot_file:
                    pickle.dump(dict(instance.__dict__), slot_file)
            elif slot == "json" and memory is not None:
                module.save_state(memory.persistent_state())
        except Exception as exc:  # noqa: BLE001 —— 槽写失败降级为无记忆，不阻断对局。
            print(f"bridge state slot write failed: {exc}", file=sys.stderr, flush=True)

    ready_label = (
        f"agent={args.agent} module={config['module']} slot={slot}"
        f" slot_every={slot_every}"
        f" state_slot={'on' if args.state_slot is not None else 'off'}"
    )
    return decide, persist, ready_label


def _serve_lines(args, decide, persist) -> int:
    """读 stdin 每行 JSON → 决策 → 输出一行 CommandPlan JSON → 存槽。"""
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
            decide(turn)
            # 注意：SDK 的 Turn.plan 是 property（返回 CommandPlan），非方法。
            plan = turn.plan
            # mode="json"：UUID key/Position 转 JSON 原生类型。
            payload = json.dumps(plan.model_dump(mode="json"), separators=(",", ":"))
            print(payload, flush=True)
            persist()
            if args.one_shot:
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
        description="Simulator <-> external strategy process bridge (registry-driven reference opponents)"
    )
    parser.add_argument(
        "--agent",
        default="farmer",
        help="python-agents.json 注册名（farmer/core，或自定义条目）",
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
        help="core 型对手运行模式：control=无限对局；harvest=达到 --target 即止",
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
        help="对手记忆槽路径：pickle（farmer 型）/ 原子 JSON（core 型）；启动恢复、决策后存回",
    )
    parser.add_argument(
        "--slot-every",
        type=int,
        default=None,
        help="槽写盘降频（决策 N 次写 1 次；默认取注册表值；--one-shot 强制每 tick）",
    )
    args = parser.parse_args()

    try:
        registry = _load_agent_registry()
    except Exception as exc:  # noqa: BLE001
        print(f"bridge registry load error: {exc}", file=sys.stderr, flush=True)
        return 1
    config = registry.get(args.agent)
    if config is None:
        print(
            f"bridge startup error: unknown agent {args.agent!r} "
            f"(registered: {', '.join(sorted(registry))})",
            file=sys.stderr,
            flush=True,
        )
        return 1
    if args.slot_every is not None:
        config = {**config, "slotEvery": args.slot_every}

    try:
        decide, persist, ready_label = _build_agent(args, config)
    except Exception as exc:  # noqa: BLE001 —— 启动失败必须输出到 stderr 退出。
        print(f"bridge startup error: {exc}", file=sys.stderr, flush=True)
        return 1

    print(f"bridge ready: {ready_label}", file=sys.stderr, flush=True)
    return _serve_lines(args, decide, persist)


if __name__ == "__main__":
    raise SystemExit(main())
