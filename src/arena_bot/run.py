"""实验调度器：读 experiments/*.yaml → 为每个租户起子进程（进程级隔离）。

    uv run python -m arena_bot.run --experiment exp-radii
    uv run python -m arena_bot.run --experiment exp-radii --minutes 120

子进程 = uv run python -m arena_bot.tenant --tenant N --strategy S --params ...
每租户独立：API key / 调试端口(8123+N) / 日志目录 / 遥测 CSV。
Ctrl-C 或到时：优雅停止全部子进程。
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
EXPERIMENTS_DIR = PROJECT_ROOT / "experiments"
TELEMETRY_DIR = PROJECT_ROOT / "telemetry"

procs: list[subprocess.Popen] = []


def load_experiment(name: str) -> dict:
    path = EXPERIMENTS_DIR / f"{name}.yaml"
    if not path.is_file():
        raise FileNotFoundError(f"实验定义不存在: {path}（可用: "
                                f"{[p.stem for p in EXPERIMENTS_DIR.glob('*.yaml')]}）")
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def stop_all() -> None:
    """P0-5 优雅停机：先发 debug API shutdown（租户结束当前 tick 后自清理），
    超时才强杀——pi RPC 子进程随 strategy.close() 一并释放，不留孤儿。"""
    import json
    import urllib.request
    for i, p in enumerate(procs):
        if p.poll() is None:
            port = 8123 + i
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/command",
                    data=json.dumps({"cmd": "shutdown"}).encode(),
                    headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=3)
                print(f"  租户 {i + 1}（端口 {port}）收到 shutdown 指令")
            except Exception as exc:
                print(f"  租户 {i + 1}（端口 {port}）shutdown 指令失败：{exc}")
    for p in procs:
        if p.poll() is None:
            try:
                p.wait(timeout=15)  # 宽限期：结束当前 tick + 清理 pi RPC
            except subprocess.TimeoutExpired:
                print(f"  pid={p.pid} 宽限期超时，强杀")
                p.kill()
            else:
                print(f"  pid={p.pid} 已优雅退出 rc={p.returncode}")


def main() -> int:
    global procs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", required=True, help="experiments/<name>.yaml")
    parser.add_argument("--minutes", type=float, default=0,
                        help="运行时长（分钟）；0 = 无限（Ctrl-C 停止）")
    args = parser.parse_args()

    exp = load_experiment(args.experiment)
    name = exp.get("name", args.experiment)
    print(f"实验 [{name}]: {exp.get('description', '')}")

    TELEMETRY_DIR.mkdir(exist_ok=True)
    for t in exp["tenants"]:
        params_spec = ",".join(f"{k}={v}" for k, v in t.get("params", {}).items())
        cmd = ["uv", "run", "python", "-m", "arena_bot.tenant",
               "--tenant", str(t["api_key_index"]),
               "--strategy", t.get("strategy", "balance")]
        if params_spec:
            cmd += ["--params", params_spec]
        proc = subprocess.Popen(cmd, cwd=PROJECT_ROOT)
        procs.append(proc)
        print(f"  租户 {t['name']} pid={proc.pid} "
              f"key_index={t['api_key_index']} 策略={t.get('strategy', 'balance')} "
              f"params={t.get('params', {})} 端口={8123 + t['api_key_index']}")

    deadline = time.monotonic() + args.minutes * 60 if args.minutes else None
    try:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                print(f"\n时长到（{args.minutes} 分钟），停止实验")
                break
            dead = [p for p in procs if p.poll() is not None]
            if dead:
                detail = ", ".join(f"pid={p.pid} rc={p.returncode}" for p in dead)
                print(f"有租户进程退出: {detail}")
                for p in dead:
                    procs.remove(p)
                if not procs:
                    print("全部租户已退出")
                    break
            time.sleep(5)
    except KeyboardInterrupt:
        print("\nCtrl-C，停止实验")
    finally:
        stop_all()
        print(f"遥测数据: {TELEMETRY_DIR}/t*.csv")
        print(f"评估: uv run python -m arena_bot.evaluate --experiment {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
