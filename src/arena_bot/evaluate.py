"""评估：读 telemetry/t*.csv → 对比报告（产出/效率/事件汇总）。

    uv run python -m arena_bot.evaluate                # 全部 telemetry/*.csv
    uv run python -m arena_bot.evaluate --experiment exp-accumulate

报告指标（markdown 表）：
- 覆盖 tick 数、末资源/末人口（攒了多少）
- 资源增速（线性回归斜率，单位/tick）
- 到达人口 4（容量 30）/8（容量 50）的 tick
- 采集/交付/战斗事件累计
- 最近 200 tick 的意图分布 top（看策略实际在干嘛）
"""

from __future__ import annotations

import argparse
import csv
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
        reader = csv.DictReader(fh)
        for row in reader:
            rows.append(row)
    if not rows:
        return {"file": path.name, "rows": 0}

    def num(row, key, default=0):
        try:
            return int(row[key] or 0)
        except (ValueError, KeyError):
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
        for item in (r.get("intents") or "-").split(","):
            if item == "-" or not item:
                continue
            key, _, n = item.partition(":")
            intent_counts[key] = intent_counts.get(key, 0) + int(n or 0)
    top_intents = sorted(intent_counts.items(), key=lambda kv: -kv[1])[:4]

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
        "harvest_ok": sum(num(r, "HARVEST_SUCCEEDED") for r in rows),
        "harvest_fail": sum(num(r, "HARVEST_FAILED") for r in rows),
        "deposit_ok": sum(num(r, "DEPOSIT_SUCCEEDED") for r in rows),
        "combat": sum(num(r, "combat_events") for r in rows),
        "intents": top_intents,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--experiment", default=None, help="仅报告标题")
    args = parser.parse_args()

    files = sorted(TELEMETRY_DIR.glob("t*.csv")) if TELEMETRY_DIR.is_dir() else []
    if not files:
        print(f"无遥测数据（{TELEMETRY_DIR}/t*.csv）。先运行调度器。")
        return 1

    title = args.experiment or "全部"
    print(f"# 实验评估：{title}\n")
    print("| 租户 | tick 范围 | 末资源 | 末人口 | 增速(近200) | 增速(全程) | "
          "达pop4 | 达pop8 | 采集✓ | 采集✗ | 交付✓ | 战斗 | 最近意图 |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for f in files:
        r = analyze(f)
        if r.get("rows", 0) == 0:
            print(f"| {r['file']} | 空 | | | | | | | | | | | |")
            continue
        intent_s = " ".join(f"{k}:{v}" for k, v in r["intents"])
        print(f"| {r['file']} | {r['ticks']} | {r['res_end']} | {r['pop_end']} "
              f"| {r['slope']:.3f} | {r['slope_all']:.3f} "
              f"| {r['reach_pop4'] or '-'} | {r['reach_pop8'] or '-'} "
              f"| {r['harvest_ok']} | {r['harvest_fail']} | {r['deposit_ok']} "
              f"| {r['combat']} | {intent_s or '-'} |")
    print("\n说明：增速=资源/线性斜率(单位/tick)；达pop4/8=容量到30/50的tick；采集✗高=资源竞争激烈")
    return 0


if __name__ == "__main__":
    sys.exit(main())
