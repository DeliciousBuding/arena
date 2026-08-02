"""评估：读 telemetry/t*.jsonl → 对比报告（产出/效率/事件/outcome 汇总）。

    uv run python -m arena_bot.evaluate                # 全部 telemetry/*.jsonl
    uv run python -m arena_bot.evaluate --experiment exp-accumulate
    uv run python -m arena_bot.evaluate --run runs/run-XXXX/   # run-scoped 目录

报告指标（markdown 表）：
- 覆盖 tick 数、末资源/末人口（攒了多少）
- 资源增速（线性回归斜率，单位/tick）
- 到达人口 4（容量 30）/8（容量 50）的 tick
- 采集/交付/战斗事件累计
- 最近 200 tick 的意图分布 top（看策略实际在干嘛）
- outcome 分布（submitted/paused/empty/tick_mismatch/error——失败 tick 不再静默）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TELEMETRY_DIR = PROJECT_ROOT / "telemetry"


def _slope(points: list[tuple[int, int]]) -> float:
    """最小二乘斜率：resources ~ tick。"""
    n = len(points)
    if n < 2:
        return 0.0
    sx = sum(x for x, _ in points)
    sy = sum(y for _, y in points)
    sxy = sum(x * y for x, y in points)
    sxx = sum(x * x for x, _ in points)
    denom = n * sxx - sx * sx
    if denom == 0:
        return 0.0
    return (n * sxy - sx * sy) / denom


def analyze(path: Path) -> dict:
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not rows:
        return {"file": path.name, "rows": 0}

    def num(row, key, default=0):
        try:
            return int(row.get(key) or default)
        except (ValueError, TypeError):
            return default

    ticks = [num(r, "tick") for r in rows]
    resources = [num(r, "resources") for r in rows]
    population = [num(r, "population") for r in rows]
    first_tick, last_tick = ticks[0], ticks[-1]

    reach_pop4 = next((t for t, p in zip(ticks, population) if p >= 4), None)
    reach_pop8 = next((t for t, p in zip(ticks, population) if p >= 8), None)

    last200 = list(zip(ticks, resources))[-200:]
    last_all = list(zip(ticks, resources))
    intent_counts: dict[str, int] = {}
    for r in rows[-200:]:
        for key, n in (r.get("intents") or {}).items():
            intent_counts[key] = intent_counts.get(key, 0) + int(n or 0)
    top_intents = sorted(intent_counts.items(), key=lambda kv: -kv[1])[:4]

    def events_total(name):
        total = 0
        for r in rows:
            ev = r.get("events")
            if isinstance(ev, dict):
                total += int(ev.get(name) or 0)
        return total

    return {
        "file": path.name,
        "rows": len(rows),
        "ticks": f"{first_tick}-{last_tick}",
        "res_end": resources[-1],
        "pop_end": population[-1],
        "slope": _slope(last200),
        "slope_all": _slope(last_all),
        "reach_pop4": reach_pop4,
        "reach_pop8": reach_pop8,
        "harvest_ok": events_total("HARVEST_SUCCEEDED"),
        "harvest_fail": events_total("HARVEST_FAILED"),
        "deposit_ok": events_total("DEPOSIT_SUCCEEDED"),
        "combat": sum(num(r, "combat_events") for r in rows),
        "intents": top_intents,
        "outcomes": {k: sum(1 for r in rows if r.get("outcome") == k)
                     for k in ("submitted", "paused", "empty",
                               "tick_mismatch", "error")},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", default=None, help="仅报告标题")
    parser.add_argument("--run", default=None,
                        help="run-scoped 目录（runs/<run_id>/），只评估该 run 的 telemetry")
    args = parser.parse_args()

    telemetry_dir = PROJECT_ROOT / "runs" / args.run / "telemetry" if args.run else TELEMETRY_DIR
    files = sorted(telemetry_dir.glob("t*.jsonl")) if telemetry_dir.is_dir() else []
    if not files:
        print(f"无遥测数据（{telemetry_dir}/t*.jsonl）。先运行调度器。")
        return 1

    title = args.experiment or "全部"
    print(f"# 实验评估：{title}\n")
    print("| 租户 | tick 范围 | 末资源 | 末人口 | 增速(近200) | 增速(全程) | "
          "达pop4 | 达pop8 | 采集✓ | 采集✗ | 交付✓ | 战斗 | outcome | 最近意图 |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for f in files:
        r = analyze(f)
        if r.get("rows", 0) == 0:
            print(f"| {r['file']} | 空 | | | | | | | | | | | | |")
            continue
        intent_s = " ".join(f"{k}:{v}" for k, v in r["intents"])
        out_s = " ".join(f"{k}:{v}" for k, v in r["outcomes"].items() if v)
        print(f"| {r['file']} | {r['ticks']} | {r['res_end']} | {r['pop_end']} "
              f"| {r['slope']:.3f} | {r['slope_all']:.3f} "
              f"| {r['reach_pop4'] or '-'} | {r['reach_pop8'] or '-'} "
              f"| {r['harvest_ok']} | {r['harvest_fail']} | {r['deposit_ok']} "
              f"| {r['combat']} | {out_s or '-'} | {intent_s or '-'} |")
    print("\n说明：增速=资源/线性斜率(单位/tick)；达pop4/8=容量到30/50的tick；采集✗高=资源竞争激烈；"
          "outcome=tick 结果分布（失败不再静默）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
