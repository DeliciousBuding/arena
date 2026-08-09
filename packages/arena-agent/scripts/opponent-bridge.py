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
  注册表声明：pickle（farmer 的 __dict__）/ json（core 的原子持久化）/
  process-memory（arena-evolve：常驻内存 + 磁盘镜像——先试整实例 pickle，
  不可 pickle 则退而求其次存内部 memory 状态，恢复时经 load_memory 重建）。
  --slot-every N：写盘降频（常驻进程记忆在进程内持续，槽仅备份/恢复用；
  默认注册表值；--one-shot 强制每 tick 写——跨进程记忆必须完整；常驻模式
  stdin EOF 退出前强制 flush 一次槽）。

用法：
  python scripts/opponent-bridge.py \
    [--agent farmer|core|<注册名>] \
    [--farmer-repo <arena-hero-agent-path>] \
    [--core-repo <arena-hero-guide-path>] \
    [--sdk-repo <arena-hero-python-path>] \
    [--worker-target 12] [--beacon-policy retreat] \
    [--mode control|harvest] [--target 30] \
    [--state-slot <槽路径>] [--slot-every N] [--one-shot]

遥测（agent-ecosystem-v1 P0/P4d）：env ``ARENA_HERO_TELEMETRY_ENDPOINT`` 配了
command-center ingest 端点后：启动发 ``register`` + ``connection up``，每处理
一行 state 发 ``tick_summary``，退出发 ``disconnected``（tenant=``sim-<agent>``，
instance=``<agent>-s<seed>``（``--seed``/``--state-slot`` 推导）或 ``--instance``
覆盖，无 seed 时 fallback ``sim-<agent>``；后台线程 5s/20 条批量，失败静默）；
未配 = no-op，协议行为零变化。

诊断日志走 stderr（模拟器把外部策略 stderr 透传到终端）。
"""

from __future__ import annotations

import argparse
import json
import os
import pickle
import platform
import queue
import re
import sys
import threading
import time
from pathlib import Path

ARENA_TS_ROOT = Path(__file__).resolve().parents[3]

# 进程启动时刻（ARENA_BRIDGE_TIMING=1 时用于冷启动测量）。
_PROCESS_STARTED_AT = time.perf_counter()


def _find_coordination_root(start: Path) -> Path:
    """从脚本目录向上找协调根（含 reference/official/arena-hero-python；兼容
    旧平铺 reference/arena-hero-python）——主工作树与 .worktrees/<分支> 层级
    不同，硬编码 parents 级数在 worktree 会落空。"""
    dir_ = start
    for _ in range(12):
        if (dir_ / "reference" / "official" / "arena-hero-python").exists():
            return dir_
        if (dir_ / "reference" / "arena-hero-python").exists():
            return dir_
        parent = dir_.parent
        if parent == dir_:
            break
        dir_ = parent
    raise FileNotFoundError(
        "coordination root (reference/[official/]arena-hero-python) not found"
    )


def _resolve_reference_repo(name: str) -> Path:
    """reference/ 子仓路径解析（2026-08-09 重组：official/third-party 分组；
    兼容旧平铺布局 reference/<name>）。"""
    for subdir in ("third-party", "official"):
        candidate = COORDINATION_ROOT / "reference" / subdir / name
        if candidate.exists():
            return candidate
    return COORDINATION_ROOT / "reference" / name


COORDINATION_ROOT = _find_coordination_root(Path(__file__).resolve().parent)
DEFAULT_FARMER_REPO = _resolve_reference_repo("arena-hero-agent")
DEFAULT_CORE_REPO = _resolve_reference_repo("arena-hero-guide")
DEFAULT_SDK_REPO = _resolve_reference_repo("arena-hero-python")
REGISTRY_PATH = Path(__file__).resolve().parent / "python-agents.json"


def _load_agent_registry() -> dict:
    """读 python-agents.json（注册表）。"""
    with open(REGISTRY_PATH, encoding="utf-8") as registry_file:
        registry = json.load(registry_file)
    return registry["agents"]


def _load_repos(repo: Path, sdk_repo: Path) -> None:
    """注入对手仓库与官方 SDK 镜像路径到 sys.path。

    arena-hero-python 是标准 ``src/arena_hero`` 布局；只放仓根会静默回退到
    机器 site-packages 里的任意旧 SDK。这里显式把 SDK 的 src 目录放在最高
    优先级，同时兼容未来对手仓也采用 src-layout。顺序必须是：
    SDK src > SDK root > opponent src > opponent root > ambient environment。
    """
    resolved_sdk = sdk_repo.resolve()
    resolved_repo = repo.resolve()
    for resolved in (resolved_sdk, resolved_repo):
        if not resolved.exists():
            raise FileNotFoundError(f"repo not found: {resolved}")

    priority = []
    sdk_src = resolved_sdk / "src"
    repo_src = resolved_repo / "src"
    if sdk_src.is_dir():
        priority.append(sdk_src)
    priority.append(resolved_sdk)
    if repo_src.is_dir():
        priority.append(repo_src)
    priority.append(resolved_repo)

    # insert(0) reverses order, so prepend from lowest to highest priority.
    for candidate in reversed(priority):
        text = str(candidate)
        if text in sys.path:
            sys.path.remove(text)
        sys.path.insert(0, text)


def _noop_submitter(plan, idempotency_key=None):
    """桥接不提交网络——Turn.submit() 不会被调用，占位即可。"""
    return None


class _NoopTelemetrySink:
    """默认 no-op：env 未配端点 = 行为零变化。"""

    def emit(self, event: dict) -> None:  # noqa: ARG002
        pass

    def close(self) -> None:
        pass


class _HttpTelemetrySink:
    """轻量遥测上报（agent-ecosystem-v1 P0/P4d）：后台线程批量 POST ingest 端点。

    仅当 env ``ARENA_HERO_TELEMETRY_ENDPOINT`` 配置后才构造；队列背压丢
    事件、网络失败静默——绝不阻塞/影响决策主循环。
    """

    _FLUSH_INTERVAL_SECONDS = 5.0
    _FLUSH_BATCH_SIZE = 20

    def __init__(self, endpoint: str, tenant: str, instance: str, mode: str) -> None:
        self._endpoint = endpoint
        self._tenant = tenant
        self._instance = instance
        self._mode = mode
        self._queue: queue.Queue[dict | None] = queue.Queue(maxsize=200)
        self._thread = threading.Thread(
            target=self._run,
            name="bridge-telemetry",
            daemon=True,
        )
        self._thread.start()

    def emit(self, event: dict) -> None:
        payload = {
            "tenant": self._tenant,
            "instance": self._instance,
            "ts": time.time(),
            "mode": self._mode,
            **event,
        }
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            pass  # 背压丢事件，不阻塞决策。

    def close(self) -> None:
        try:
            self._queue.put_nowait(None)
        except queue.Full:
            pass
        self._thread.join(timeout=3.0)

    def _run(self) -> None:
        batch: list[dict] = []
        last_flush = time.monotonic()
        try:
            import httpx
        except ImportError:
            # httpx 不可用时静默降级为 no-op（遥测绝不阻断桥接）。
            return
        try:
            with httpx.Client(timeout=2.0) as client:
                while True:
                    try:
                        item = self._queue.get(timeout=0.5)
                    except queue.Empty:
                        # 队列暂空：继续等待（只有 close() 的 None 哨兵才退出）——
                        # 否则启动期（注册表加载/import 慢于 0.5s）线程会带着
                        # register/connection 提前退出，后续事件全部丢失。
                        continue
                    if item is None:
                        self._flush(client, batch)
                        return
                    batch.append(item)
                    if len(batch) >= self._FLUSH_BATCH_SIZE:
                        self._flush(client, batch)
                        batch = []
                        last_flush = time.monotonic()
                    elif batch and time.monotonic() - last_flush >= self._FLUSH_INTERVAL_SECONDS:
                        self._flush(client, batch)
                        batch = []
                        last_flush = time.monotonic()
        except Exception:
            pass  # 遥测线程异常静默退出。

    def _flush(self, client: httpx.Client, batch: list[dict]) -> None:
        if not batch:
            return
        try:
            client.post(self._endpoint, json={"events": batch})
        except Exception:
            pass  # 上报失败静默。


def _tick_summary(tick: int, state) -> dict:
    """从官方 PlayerState 推导 tick_summary 摘要（字段 snake_case）。"""
    core = None
    units = 0
    visible_enemies = 0
    for obj in state.objects:
        if obj.kind == "CORE":
            if obj.controlled:
                core = [obj.position[0], obj.position[1]]
        elif obj.kind == "UNIT":
            units += 1
            if not obj.controlled:
                visible_enemies += 1
    return {
        "event": "tick_summary",
        "tick": tick,
        "resources": state.resources,
        "population": state.population,
        "core": core,
        "units": units,
        "visible_enemies": visible_enemies,
    }


# P4d：instance 区分同 agent 多 seed。推导优先级：
# --instance 显式覆盖 > --seed > --state-slot 文件名尾缀 -s<digits> > sim-<agent>。
_SEED_SUFFIX_RE = re.compile(r"-s(\d+)$")


def _resolve_instance_id(args) -> str:
    """台账 instance：同 agent 多 seed 实例用 <agent>-s<seed> 区分。"""
    if args.instance:
        return args.instance
    seed = args.seed
    if seed is None and args.state_slot is not None:
        match = _SEED_SUFFIX_RE.search(args.state_slot.stem)
        if match:
            seed = int(match.group(1))
    if seed is not None:
        return f"{args.agent}-s{seed}"
    return f"sim-{args.agent}"


def _read_telemetry_mode() -> str:
    """agent 运行模式（production|simulation）：bridge 只跑模拟器，缺省
    simulation；env ``ARENA_HERO_MODE`` 可显式覆盖。非法值回落 simulation。"""
    mode = os.environ.get("ARENA_HERO_MODE", "").strip().lower()
    if mode not in ("production", "simulation"):
        return "simulation"
    return mode


def _sdk_version() -> str | None:
    """官方 SDK 版本号（arena_hero.__version__）；拿不到返回 None（ingest 置空）。"""
    try:
        import arena_hero  # noqa: PLC0415 —— 惰性导入：身份事件只在启动后发。
        return getattr(arena_hero, "__version__", None)
    except Exception:  # noqa: BLE001 —— 遥测字段缺失不阻断。
        return None


def _identity_event(base_url: str) -> dict:
    """bridge 版 register 事件：字段对齐 fork SDK telemetry.py 的 identity_event
    （api_key_tail/base_url/sdk_version/pid/platform/mode；bridge 无 API key）。"""
    event = {
        "event": "register",
        "api_key_tail": "",
        "base_url": base_url,
        "pid": os.getpid(),
        "platform": platform.platform(),
    }
    sdk_version = _sdk_version()
    if sdk_version:
        event["sdk_version"] = sdk_version
    return event


def _build_agent(args, config: dict):
    """按注册表条目构建对手运行时：返回 (decide, persist, ready_label)。

    decide(turn)：填充 turn.plan builder；persist()：写盘降频的记忆槽。
    """
    repo = _resolve_reference_repo(config["repo"]).resolve()
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

    # P4c：process-memory 槽的持久化能力探测（常驻内存 + 磁盘镜像）：
    # 1) 整实例 pickle（arena-evolve 的 Pathfinder.goal_ok 存了 lambda——
    #    大概率不可 pickle，探测一次定案，避免每 tick 重复失败）；
    # 2) 退而求其次：duck-type 找 instance.strategy.mem（Memory.to_dict）+
    #    strategy.load_memory(dict) 的内部 memory 持久化 API。
    instance_pickleable = False
    memory_snapshot = None
    memory_restore = None
    if slot == "process-memory" and instance is not None:
        try:
            pickle.dumps(dict(instance.__dict__))
            instance_pickleable = True
        except Exception:  # noqa: BLE001 —— 不可 pickle 走 memory 状态落盘。
            pass
        if not instance_pickleable:
            for holder in (getattr(instance, "strategy", None), instance):
                mem = getattr(holder, "mem", None)
                if (
                    mem is not None
                    and callable(getattr(mem, "to_dict", None))
                    and callable(getattr(holder, "load_memory", None))
                ):
                    def memory_snapshot():
                        # 延迟取 holder.mem：restore 经 load_memory 会替换 mem
                        # 为新建的 Memory 实例，绑定探测时的旧对象会丢恢复的记忆。
                        current = getattr(holder, "mem", None)
                        return current.to_dict() if current is not None else {}
                    memory_restore = holder.load_memory
                    break

    # 槽恢复
    if slot in ("pickle", "process-memory") and instance is not None and args.state_slot is not None and args.state_slot.exists():
        try:
            with open(args.state_slot, "rb") as slot_file:
                payload = pickle.load(slot_file)
            if slot == "process-memory" and isinstance(payload, dict) and payload.get("__arena_slot_kind__") == "memory":
                if memory_restore is None:
                    raise ValueError("slot is a memory snapshot but agent exposes no load_memory API")
                memory_restore(payload["state"])
            elif isinstance(payload, dict) and (slot == "pickle" or instance_pickleable):
                instance.__dict__.update(payload)
            else:
                raise ValueError("unrecognized slot payload")
            print(
                f"bridge state restored from slot: {args.state_slot}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 —— 槽损坏不应阻断对局，重置即可。
            print(f"bridge state slot corrupt, starting fresh: {exc}", file=sys.stderr, flush=True)
    if slot == "json":
        memory = module.AgentMemory.restore(module.load_persistent_state())

    # SDK 配置注入通道（config-injection）：构造完成后应用 ARENA_CFG_*/文件覆盖。
    # SDK 默认 no-op；缺失/失败静默降级（SDK 内部 try/except + stderr 一行）。
    applied_config = {}
    if instance is not None:
        try:
            from arena_hero import apply_config_overrides

            applied_config = apply_config_overrides(instance=instance)
        except Exception:  # noqa: BLE001 —— SDK 通道不可用不影响默认构造。
            applied_config = {}
    if applied_config:
        print(
            f"bridge config overrides applied: {sorted(applied_config)}",
            file=sys.stderr,
            flush=True,
        )

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
    no_persist_warned = [False]

    def persist(force: bool = False) -> None:
        """写盘降频的记忆槽；force=True 跳过 slotEvery（退出前强制 flush）。"""
        if args.state_slot is None:
            return
        decision_count[0] += 1
        if not force and slot_every is not None and decision_count[0] % slot_every != 0:
            return
        try:
            args.state_slot.parent.mkdir(parents=True, exist_ok=True)
            if slot == "pickle" and instance is not None:
                with open(args.state_slot, "wb") as slot_file:
                    pickle.dump(dict(instance.__dict__), slot_file)
            elif slot == "process-memory" and instance is not None:
                if instance_pickleable:
                    with open(args.state_slot, "wb") as slot_file:
                        pickle.dump(dict(instance.__dict__), slot_file)
                elif memory_snapshot is not None:
                    with open(args.state_slot, "wb") as slot_file:
                        pickle.dump(
                            {"__arena_slot_kind__": "memory", "state": memory_snapshot()},
                            slot_file,
                        )
                elif not no_persist_warned[0]:
                    # 如实报告：实例不可 pickle 且无 memory API → 记忆无法持久化。
                    print(
                        f"bridge state slot: agent={args.agent} exposes no pickle-able "
                        "state or memory API — memory cannot be persisted",
                        file=sys.stderr,
                        flush=True,
                    )
                    no_persist_warned[0] = True
            elif slot == "json" and memory is not None:
                module.save_state(memory.persistent_state())
        except Exception as exc:  # noqa: BLE001 —— 槽写失败降级为无记忆，不阻断对局。
            print(f"bridge state slot write failed: {exc}", file=sys.stderr, flush=True)

    ready_label = (
        f"agent={args.agent} module={config['module']} slot={slot}"
        f" slot_every={slot_every}"
        f" state_slot={'on' if args.state_slot is not None else 'off'}"
        f" instance={_resolve_instance_id(args)}"
    )
    return decide, persist, ready_label


def _serve_lines(args, decide, persist, telemetry) -> int:
    """读 stdin 每行 JSON → 决策 → 输出一行 CommandPlan JSON → 存槽。"""
    from arena_hero.models import PlayerState
    from arena_hero.turn import Turn

    # 临时计时（ARENA_BRIDGE_TIMING=1 时输出到 stderr；默认关 = 零行为变化）。
    timing = os.environ.get("ARENA_BRIDGE_TIMING", "").strip() == "1"
    timing_stats = {"ticks": 0, "bytes": 0.0, "parse": 0.0, "validate": 0.0,
                    "decide": 0.0, "dump": 0.0, "persist": 0.0}
    startup = time.perf_counter() - _PROCESS_STARTED_AT

    try:
        for line_number, line in enumerate(sys.stdin, start=1):
            line = line.strip()
            if not line:
                continue
            # 优雅退出哨兵（worker 关闭时发送）：静默 return 0，走 finally
            # （强制 flush 状态槽 + 遥测 disconnected/剩余事件）。
            if line == "__arena_quit__":
                return 0
            message: dict | None = None
            try:
                t0 = time.perf_counter()
                message = json.loads(line)
                t1 = time.perf_counter()
                state = PlayerState.model_validate(message["state"])
                t2 = time.perf_counter()
                # 遥测旁路：每处理一行 state 上报 tick_summary（不参与决策语义）。
                telemetry.emit(_tick_summary(int(message["tick"]), state))
                turn = Turn(
                    tick=int(message["tick"]),
                    state=state,
                    submitter=_noop_submitter,
                )
                decide(turn)
                t3 = time.perf_counter()
                # 注意：SDK 的 Turn.plan 是 property（返回 CommandPlan），非方法。
                plan = turn.plan
                # mode="json"：UUID key/Position 转 JSON 原生类型。
                payload = json.dumps(plan.model_dump(mode="json"), separators=(",", ":"))
                t4 = time.perf_counter()
                print(payload, flush=True)
                persist()
                t5 = time.perf_counter()
                if timing:
                    timing_stats["ticks"] += 1
                    timing_stats["bytes"] += len(line)
                    timing_stats["parse"] += t1 - t0
                    timing_stats["validate"] += t2 - t1
                    timing_stats["decide"] += t3 - t2
                    timing_stats["dump"] += t4 - t3
                    timing_stats["persist"] += t5 - t4
                    print(
                        f"[timing] agent={args.agent} tick={message.get('tick')} "
                        f"bytes={len(line)} parse={(t1 - t0) * 1e3:.2f}ms "
                        f"validate={(t2 - t1) * 1e3:.2f}ms decide={(t3 - t2) * 1e3:.2f}ms "
                        f"dump={(t4 - t3) * 1e3:.2f}ms persist={(t5 - t4) * 1e3:.2f}ms "
                        f"roundtrip={(t5 - t0) * 1e3:.2f}ms",
                        file=sys.stderr,
                        flush=True,
                    )
            except Exception as exc:  # noqa: BLE001 —— 决策失败输出到 stderr
                # （模拟器端 fail-fast 中止——诚实暴露适配/对手问题）。
                print(
                    f"bridge error agent={args.agent} at line {line_number} (tick "
                    f"{message.get('tick') if message is not None else '?'}): {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                return 1
            if args.one_shot:
                return 0
        return 0
    finally:
        # 常驻模式 stdin EOF / 任何退出路径：最后一次强制 flush 状态槽
        # （P4c：常驻进程退出时记忆不丢；one-shot 已每 tick 写过，冗余无害）。
        persist(force=True)
        if timing and timing_stats["ticks"] > 0:
            n = timing_stats["ticks"]
            total = sum(timing_stats[k] for k in ("parse", "validate", "decide", "dump", "persist"))
            print(
                f"[timing] agent={args.agent} summary ticks={n} "
                f"startup={startup * 1e3:.0f}ms "
                f"avg_bytes={timing_stats['bytes'] / n:.0f} "
                f"avg_parse={(timing_stats['parse'] / n) * 1e3:.2f}ms "
                f"avg_validate={(timing_stats['validate'] / n) * 1e3:.2f}ms "
                f"avg_decide={(timing_stats['decide'] / n) * 1e3:.2f}ms "
                f"avg_dump={(timing_stats['dump'] / n) * 1e3:.2f}ms "
                f"avg_persist={(timing_stats['persist'] / n) * 1e3:.2f}ms "
                f"avg_roundtrip={(total / n) * 1e3:.2f}ms",
                file=sys.stderr,
                flush=True,
            )


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
        help="对手记忆槽路径：pickle（farmer 型）/ 原子 JSON（core 型）/ "
        "process-memory 磁盘镜像（arena-evolve 型）；启动恢复、决策后存回",
    )
    parser.add_argument(
        "--slot-every",
        type=int,
        default=None,
        help="槽写盘降频（决策 N 次写 1 次；默认取注册表值；--one-shot 强制每 tick）",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="seed 标识：遥测台账 instance=<agent>-s<seed>（区分同 agent 多 seed 实例）",
    )
    parser.add_argument(
        "--instance",
        default=None,
        help="遥测台账 instance 显式覆盖（优先于 --seed/--state-slot 推导）",
    )
    args = parser.parse_args()

    # 遥测（agent-ecosystem-v1 P0/P4d）：env 未配端点 = no-op，行为零变化。
    endpoint = os.environ.get("ARENA_HERO_TELEMETRY_ENDPOINT", "").strip()
    telemetry = (
        _HttpTelemetrySink(
            endpoint,
            f"sim-{args.agent}",
            _resolve_instance_id(args),
            _read_telemetry_mode(),
        )
        if endpoint
        else _NoopTelemetrySink()
    )

    try:
        registry = _load_agent_registry()
    except Exception as exc:  # noqa: BLE001
        print(f"bridge registry load error: {exc}", file=sys.stderr, flush=True)
        telemetry.close()
        return 1
    config = registry.get(args.agent)
    if config is None:
        print(
            f"bridge startup error: unknown agent {args.agent!r} "
            f"(registered: {', '.join(sorted(registry))})",
            file=sys.stderr,
            flush=True,
        )
        telemetry.close()
        return 1
    if args.slot_every is not None:
        config = {**config, "slotEvery": args.slot_every}

    try:
        decide, persist, ready_label = _build_agent(args, config)
    except Exception as exc:  # noqa: BLE001 —— 启动失败必须输出到 stderr 退出。
        print(f"bridge startup error: {exc}", file=sys.stderr, flush=True)
        telemetry.close()
        return 1

    print(f"bridge ready: {ready_label}", file=sys.stderr, flush=True)
    if endpoint:
        # P4d：身份事件（tenant=sim-<agent>，instance=<agent>-s<seed>/--instance）。
        telemetry.emit(_identity_event(endpoint))
        telemetry.emit({"event": "connection", "status": "up"})
    try:
        return _serve_lines(args, decide, persist, telemetry)
    finally:
        # P4d：退出事件，close() flush（后台线程把剩余事件发完）。
        telemetry.emit({"event": "disconnected"})
        telemetry.close()


if __name__ == "__main__":
    raise SystemExit(main())
