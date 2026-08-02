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
    for p in procs:
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


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
