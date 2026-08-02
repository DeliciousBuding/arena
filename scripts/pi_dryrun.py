#!/usr/bin/env python3
"""pi 干跑桥接：真实 Tick 快照 → pi agent 决策（不提交游戏，只读实验）。

用法:
    python scripts/pi_dryrun.py [--snapshot logs/pi_dryrun_snapshot.json]
                               [--pi <pi-cli.js>] [--model <model>]

输出: pi 决策文本 + 耗时。不连接游戏、不提交任何计划。
"""

import argparse
import json
import subprocess
import sys
import time
from os import environ
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PI_CLI = PROJECT_ROOT / "pi-dev" / "packages" / "coding-agent" / "dist" / "cli.js"
DEFAULT_SNAPSHOT = PROJECT_ROOT / "logs" / "pi_dryrun_snapshot.json"

RULE_HINTS = """你是 Arena Hero 游戏的战术指挥官，只输出下一 Tick 的行动计划。

规则约束:
- Worker 采集资源后回家交付; cargo 满时优先回家; 无可见资源回家待命
- 优先造 Worker 到 8 个, 之后 Vanguard/Ranger 交替
- 人口上限 20 (tier 0 免 upkeep); spawn 后保留 3 资源应急
- 受损单位在自家静止 Core 格自动 HEAL; Core 先补 HP 再修盾再生产
- Vanguard 相邻 SWEEP、逼近敌人; Ranger 只射 8 方向 1-3 格无遮挡目标
- 地面 Beacon 同格自动拾取 (采集 2 倍收益)

输出要求: 每条指令一行, 格式 "[单位ID前8位] 动作 参数", 附一行理由。"""


def build_prompt(state: dict) -> str:
    lines = [
        RULE_HINTS,
        "",
        f"当前 Tick {state.get('tick')}, 资源 {state.get('resources')}, "
        f"人口 {state.get('population')}, 阶段 {state.get('phase')}",
    ]
    units = state.get("units", [])
    lines.append(f"单位 {len(units)} 个:")
    for u in units:
        lines.append(
            f"- {u['type']} {u['id'][:8]} pos={u.get('pos')} hp={u.get('hp')} "
            f"cargo={u.get('cargo')} intent={u.get('intent')}"
        )
    lines.append("")
    lines.append("请给出下一 Tick 的行动计划:")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    ap.add_argument("--pi", type=Path, default=DEFAULT_PI_CLI)
    ap.add_argument("--model", default="newapi/deepseek-v4-flash")
    args = ap.parse_args()

    if not args.pi.exists():
        print(f"[错误] pi CLI 不存在: {args.pi}（需先 build）", file=sys.stderr)
        return 2

    state = json.loads(args.snapshot.read_text(encoding="utf-8"))
    prompt = build_prompt(state)

    env = dict(environ)
    # undici 原生 fetch 不读 HTTPS_PROXY；--use-env-proxy 让它走 Clash 代理（模型目录刷新用）
    env["NODE_OPTIONS"] = env.get("NODE_OPTIONS", "") + " --use-env-proxy"
    cmd = ["node", str(args.pi), "--model", args.model, "-p", prompt]
    print(f"[pi] 调用: node {args.pi.name} --model {args.model} (prompt {len(prompt)} 字符)")
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120, env=env)
    dt = time.monotonic() - t0
    print(f"[pi] 退出码 {proc.returncode}, 耗时 {dt:.1f}s")
    print("=== pi 输出 ===")
    print(proc.stdout.strip() or "(空)")
    if proc.stderr.strip():
        print("=== stderr(截断) ===")
        print(proc.stderr.strip()[:2000])
    return proc.returncode


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
