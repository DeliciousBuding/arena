"""实验调度器：读 experiments/*.yaml → 为每个租户起子进程（进程级隔离）。

    uv run python -m arena_bot.run --experiment exp-radii
    uv run python -m arena_bot.run --experiment exp-radii --minutes 120

子进程 = uv run python -m arena_bot.tenant --tenant N --strategy S --params ...
每租户独立：API key / 调试端口(8123+N) / 日志目录 / 遥测 JSONL。
Ctrl-C 或到时：优雅停止全部子进程。

run-scoped 布局（runs/<run_id>/）：telemetry + logs + sessions 分目录，
manifest.json 记录实验/代码 SHA/模型——多次运行不再混入同一 t*.jsonl。
"""

from __future__ import annotations

import argparse
import json
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
EXPERIMENTS_DIR = PROJECT_ROOT / "experiments"
RUNS_DIR = PROJECT_ROOT / "runs"

DEBUG_PORT_BASE = 8123


@dataclass
class TenantProcess:
    """租户进程记录：端口按 api_key_index 推导，不依赖列表索引。"""

    process: subprocess.Popen
    name: str
    debug_port: int
    api_key_index: int


def load_experiment(name: str) -> dict:
    path = EXPERIMENTS_DIR / f"{name}.yaml"
    if not path.is_file():
        raise FileNotFoundError(f"实验定义不存在: {path}（可用: "
                                f"{[p.stem for p in EXPERIMENTS_DIR.glob('*.yaml')]}）")
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def stop_all(tenants: list[TenantProcess]) -> None:
    """P0-5 优雅停机：先发 debug API shutdown（租户结束当前 tick 后自清理），
    超时才强杀——pi RPC 子进程随 strategy.close() 一并释放，不留孤儿。"""
    import urllib.request
    for tp in tenants:
        if tp.process.poll() is None:
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{tp.debug_port}/command",
                    data=json.dumps({"cmd": "shutdown"}).encode(),
                    headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=3)
                print(f"  租户 {tp.name}（端口 {tp.debug_port}）收到 shutdown 指令")
            except Exception as exc:
                print(f"  租户 {tp.name}（端口 {tp.debug_port}）shutdown 指令失败：{exc}")
    for tp in tenants:
        if tp.process.poll() is None:
            try:
                tp.process.wait(timeout=15)  # 宽限期：结束当前 tick + 清理 pi RPC
            except subprocess.TimeoutExpired:
                print(f"  pid={tp.process.pid} 宽限期超时，强杀")
                tp.process.kill()
            else:
                print(f"  pid={tp.process.pid} 已优雅退出 rc={tp.process.returncode}")


def write_manifest(run_dir: Path, exp: dict, run_id: str) -> None:
    """记录实验可复现信息：完整 YAML、启动时间、代码 SHA。"""
    import subprocess as sp
    def git_sha(path: Path) -> str | None:
        try:
            out = sp.run(["git", "rev-parse", "HEAD"], cwd=path,
                         capture_output=True, text=True, timeout=5)
            return out.stdout.strip() if out.returncode == 0 else None
        except Exception:
            return None
    manifest = {
        "run_id": run_id,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "experiment": exp,
        "arena_sha": git_sha(PROJECT_ROOT),
        "pi_sha": git_sha(PROJECT_ROOT.parent / "pi"),
        "platform": sys.platform,
    }
    (run_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", required=True, help="experiments/<name>.yaml")
    parser.add_argument("--minutes", type=float, default=0,
                        help="运行时长（分钟）；0 = 无限（Ctrl-C 停止）")
    args = parser.parse_args()

    exp = load_experiment(args.experiment)
    name = exp.get("name", args.experiment)
    print(f"实验 [{name}]: {exp.get('description', '')}")

    # run-scoped 目录：telemetry/logs/sessions 按 run 隔离
    run_id = datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%S") + f"-{uuid.uuid4().hex[:6]}"
    run_dir = RUNS_DIR / run_id
    telemetry_dir = run_dir / "telemetry"
    telemetry_dir.mkdir(parents=True, exist_ok=True)
    write_manifest(run_dir, exp, run_id)
    print(f"run 目录: {run_dir}（manifest.json 已写）")

    tenants: list[TenantProcess] = []
    for t in exp["tenants"]:
        params_spec = ",".join(f"{k}={v}" for k, v in t.get("params", {}).items())
        # W3 差分回放素材：raw state 落盘到 run 目录
        raw_state_dir = run_dir / "raw-state"
        params_spec = f"{params_spec},raw_state_dir={raw_state_dir.as_posix()}" if params_spec \
            else f"raw_state_dir={raw_state_dir.as_posix()}"
        cmd = ["uv", "run", "python", "-m", "arena_bot.tenant",
               "--tenant", str(t["api_key_index"]),
               "--strategy", t.get("strategy", "balance"),
               "--run-dir", str(run_dir)]
        if params_spec:
            cmd += ["--params", params_spec]
        proc = subprocess.Popen(cmd, cwd=PROJECT_ROOT)
        debug_port = DEBUG_PORT_BASE + t["api_key_index"]
        tenants.append(TenantProcess(
            process=proc,
            name=t["name"],
            debug_port=debug_port,
            api_key_index=t["api_key_index"],
        ))
        print(f"  租户 {t['name']} pid={proc.pid} "
              f"key_index={t['api_key_index']} 策略={t.get('strategy', 'balance')} "
              f"params={t.get('params', {})} 端口={debug_port}")

    deadline = time.monotonic() + args.minutes * 60 if args.minutes else None
    try:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                print(f"\n时长到（{args.minutes} 分钟），停止实验")
                break
            dead = [tp for tp in tenants if tp.process.poll() is not None]
            if dead:
                detail = ", ".join(f"{tp.name} pid={tp.process.pid} rc={tp.process.returncode}"
                                   for tp in dead)
                print(f"有租户进程退出: {detail}")
                for tp in dead:
                    tenants.remove(tp)
                if not tenants:
                    print("全部租户已退出")
                    break
            time.sleep(5)
    except KeyboardInterrupt:
        print("\nCtrl-C，停止实验")
    finally:
        stop_all(tenants)
        print(f"遥测数据: {telemetry_dir}/t*.jsonl")
        print(f"评估: uv run python -m arena_bot.evaluate --experiment {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
