#!/usr/bin/env python3
"""pi RPC 离线验证：长驻 pi --mode rpc 进程，逐 Tick 决策（不提交游戏）。

v2 版已重构：PiRpcBridge 类迁移至 src/arena_bot/llm/backend.py（PiRpcBackend），
本脚本只做离线验证编排（演化状态 → prompt → 决策 → 报告），复用一个实现。

用法:
    python scripts/pi_rpc_bridge.py --ticks 20 [--snapshot logs/pi_dryrun_snapshot.json]
"""

import argparse
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from arena_bot.llm.backend import PiRpcBackend
from arena_bot.llm.llm_strategy import RULES

DEFAULT_PI_CLI = PROJECT_ROOT / "pi-dev" / "packages" / "coding-agent" / "dist" / "cli.js"
DEFAULT_SNAPSHOT = PROJECT_ROOT / "logs" / "pi_dryrun_snapshot.json"
SESSION_DIR = PROJECT_ROOT / "logs" / "pi_rpc_sessions"


def evolve_state(base: dict, tick: int) -> dict:
    """离线演化：模拟早期扩张的资源/人口增长（真实接入时替换为游戏新 Tick）。"""
    s = dict(base)
    s["tick"] = base.get("tick", 0) + tick
    s["resources"] = base.get("resources", 0) + tick * 1          # 每 Tick 采 1
    if tick % 8 == 7 and s["resources"] >= 6:                     # 每 8 tick 造一个 Worker
        s["resources"] -= 5
        s["population"] = min(s.get("population", 0) + 1, 20)
    return s


def state_summary(s: dict) -> str:
    lines = [f"Tick {s.get('tick')}, 资源 {s.get('resources')}, 人口 {s.get('population')}, "
             f"阶段 {s.get('phase')}"]
    for u in s.get("units", []):
        lines.append(f"- {u['type']} {u['id'][:8]} pos={u.get('pos')} hp={u.get('hp')} "
                     f"cargo={u.get('cargo')} intent={u.get('intent')}")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--ticks", type=int, default=20)
    ap.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    ap.add_argument("--pi", type=Path, default=DEFAULT_PI_CLI)
    ap.add_argument("--model", default="newapi/deepseek-v4-flash")
    args = ap.parse_args()

    if not args.pi.exists():
        print(f"[错误] pi CLI 不存在: {args.pi}", file=sys.stderr)
        return 2

    base = json.loads(args.snapshot.read_text(encoding="utf-8"))
    SESSION_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[桥接] 启动 pi RPC: {' '.join(PiRpcBackend(args.pi, args.model, SESSION_DIR).cmd)}")
    bridge = PiRpcBackend(args.pi, args.model, SESSION_DIR)
    try:
        print("[桥接] RPC 就绪，开始逐 Tick 决策\n")
        report = []
        for tick in range(1, args.ticks + 1):
            state = evolve_state(base, tick)
            msg = (RULES if tick == 1 else "") + state_summary(state) + "\n\n请给出下一 Tick 行动计划:"
            try:
                t0 = time.monotonic()
                text = bridge.ask(msg, f"tick-{tick}")
                dt = time.monotonic() - t0
            except TimeoutError as e:
                print(f"[tick {tick}] 超时: {e}")
                report.append((tick, "TIMEOUT", 0.0, ""))
                continue
            ok = len(text.strip()) >= 10
            print(f"[tick {tick}] {dt:.1f}s | {len(text)} 字符 | {'✓' if ok else '? 空/过短'}")
            print(text.strip()[:300])
            print("-" * 60)
            report.append((tick, "ok" if ok else "short", dt, text.strip()[:200]))

        times = [r[2] for r in report if r[1] == "ok"]
        if times:
            print(f"\n=== 汇总: {len(report)} tick, ok={sum(1 for r in report if r[1]=='ok')}, "
                  f"平均 {sum(times)/len(times):.1f}s, 最快 {min(times):.1f}s, 最慢 {max(times):.1f}s")
        csv = PROJECT_ROOT / "logs" / "pi_rpc_report.csv"
        csv.write_text(
            "tick,status,seconds,decision\n"
            + "\n".join(f"{t},{s},{d:.2f},{v.replace(chr(10),' ')}" for t, s, d, v in report),
            encoding="utf-8",
        )
        print(f"报告: {csv}")
        return 0
    finally:
        bridge.close()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
