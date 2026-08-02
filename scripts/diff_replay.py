"""Differential comparator：对比 E1（Python）/E2（TS）回放输出，生成分类差分报告。

W3 验收工具。输入两个 Differential Record v1 JSONL（scripts/replay_py.py /
packages/arena-agent/scripts/replay-ts.ts 产出），按 tick 对齐，四维比较：

    state（硬：canonical 语义树，不一致 = reducer bug → exit 1）
    memory / phase / intents / plan（软：分类计数，白名单内标 whitelisted）

契约：docs/differential-record-v1.md + contracts/differential/record-v1.schema.json。

用法：
    uv run python scripts/diff_replay.py --py /tmp/replay-py.jsonl --ts /tmp/replay-ts.jsonl \
        [--report /tmp/diff-report.txt] [--json /tmp/diff.json] [--whitelist scripts/differential/whitelist.json]

退出码：state 硬差异 > 0 → 1；未解释差异（非白名单软差异）> 0 → 1；其余 → 0。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 差异分类（契约定义）
CAT_STATE = "state_reducer"   # 硬
CAT_WORLD = "world_memory"    # 软
CAT_PHASE = "phase"           # 软
CAT_INTENT = "intent"         # 软
CAT_PLAN_TYPE = "plan_action_type"     # 软
CAT_PLAN_PARAM = "plan_action_param"   # 软
CAT_PLAN_MISSING = "plan_unit_missing"  # 软
CAT_MISSING_INPUT = "missing_input"    # 软（单侧缺 tick）
CAT_REPRESENTATION = "representation"  # 软（规范化前的表示差异，允许白名单）

CATEGORIES = [
    CAT_STATE, CAT_WORLD, CAT_PHASE, CAT_INTENT,
    CAT_PLAN_TYPE, CAT_PLAN_PARAM, CAT_PLAN_MISSING, CAT_MISSING_INPUT, CAT_REPRESENTATION,
]

HARD = {CAT_STATE}


def load_records(path: str) -> dict[int, dict]:
    records: dict[int, dict] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        records[int(rec["tick"])] = rec
    return records


def collect_diffs(pa, pb, prefix: str, out: list) -> None:
    """递归收集语义差异（JSON Pointer 定位）。pa/pb 为已对齐的 JSON 值。"""
    if isinstance(pa, dict) and isinstance(pb, dict):
        for k in sorted(set(pa) | set(pb)):
            if k not in pb:
                out.append(f"{prefix}/{k}: py={json.dumps(pa[k], ensure_ascii=False)[:80]} ts=<缺失>")
            elif k not in pa:
                out.append(f"{prefix}/{k}: py=<缺失> ts={json.dumps(pb[k], ensure_ascii=False)[:80]}")
            else:
                collect_diffs(pa[k], pb[k], f"{prefix}/{k}", out)
    elif isinstance(pa, list) and isinstance(pb, list):
        if pa != pb:
            out.append(f"{prefix}: py={json.dumps(pa, ensure_ascii=False)[:80]} ts={json.dumps(pb, ensure_ascii=False)[:80]}")
    elif pa != pb:
        out.append(f"{prefix}: py={json.dumps(pa, ensure_ascii=False)[:80]} ts={json.dumps(pb, ensure_ascii=False)[:80]}")


def compare_state(pa: dict, pb: dict) -> list[str]:
    """state 硬比较：units/enemies 按 id 对齐、cells 排序后比较。"""
    a, b = dict(pa), dict(pb)
    for key in ("units", "enemies"):
        by_id_a = {u["id"]: u for u in a.get(key, [])}
        by_id_b = {u["id"]: u for u in b.get(key, [])}
        merged = []
        for uid in sorted(set(by_id_a) | set(by_id_b)):
            if uid not in by_id_b:
                merged.append(f"state/{key}/{uid}: py=<存在> ts=<缺失>")
            elif uid not in by_id_a:
                merged.append(f"state/{key}/{uid}: py=<缺失> ts=<存在>")
            else:
                collect_diffs(by_id_a[uid], by_id_b[uid], f"state/{key}/{uid}", merged)
        a.pop(key, None)
        b.pop(key, None)
        if merged:
            out = merged
            return out
    for key in ("resource_cells", "obstacle_cells"):
        a[key] = sorted(tuple(c) for c in a.get(key, []))
        b[key] = sorted(tuple(c) for c in b.get(key, []))
    out: list[str] = []
    collect_diffs(a, b, "state", out)
    return out


def compare_plan(pa: dict, pb: dict) -> list[tuple[str, str]]:
    """plan 比较：unit_actions 按 id 对齐；core_action 直接比。返回 [(类别, 描述)]。"""
    diffs: list[tuple[str, str]] = []
    ua, ub = pa.get("unit_actions", {}), pb.get("unit_actions", {})
    for uid in sorted(set(ua) | set(ub)):
        if uid not in ub:
            diffs.append((CAT_PLAN_MISSING, f"plan/unit_actions/{uid}: py=<存在> ts=<缺失>"))
        elif uid not in ua:
            diffs.append((CAT_PLAN_MISSING, f"plan/unit_actions/{uid}: py=<缺失> ts=<存在>"))
        else:
            act_a, act_b = ua[uid], ub[uid]
            if act_a.get("type") != act_b.get("type"):
                diffs.append((CAT_PLAN_TYPE, f"plan/unit_actions/{uid}: py={act_a.get('type')} ts={act_b.get('type')}"))
            elif act_a != act_b:
                diffs.append((CAT_PLAN_PARAM, f"plan/unit_actions/{uid}: py={json.dumps(act_a, ensure_ascii=False)[:70]} ts={json.dumps(act_b, ensure_ascii=False)[:70]}"))
    if pa.get("core_action") != pb.get("core_action"):
        diffs.append((CAT_PLAN_PARAM, f"plan/core_action: py={json.dumps(pa.get('core_action'), ensure_ascii=False)[:70]} ts={json.dumps(pb.get('core_action'), ensure_ascii=False)[:70]}"))
    return diffs


def load_whitelist(path: str | None) -> set[str]:
    if not path:
        return set()
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return set(data)  # {category: ...} 的 key 集合


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--py", required=True)
    ap.add_argument("--ts", required=True)
    ap.add_argument("--report", help="人类可读报告路径（默认 stdout）")
    ap.add_argument("--json", help="机器可读报告路径")
    ap.add_argument("--whitelist", help="白名单 JSON：{category: reason}")
    args = ap.parse_args()

    py_records = load_records(args.py)
    ts_records = load_records(args.ts)
    whitelist = load_whitelist(args.whitelist)

    ticks = sorted(set(py_records) | set(ts_records))
    missing: list[str] = []
    state_diffs: list[dict] = []
    soft_diffs: list[dict] = []  # {tick, category, detail}
    first_divergence: int | None = None

    for tick in ticks:
        if tick not in py_records:
            missing.append(f"tick {tick}: py=<缺失> ts=<存在>")
            soft_diffs.append({"tick": tick, "category": CAT_MISSING_INPUT, "detail": missing[-1]})
            continue
        if tick not in ts_records:
            missing.append(f"tick {tick}: py=<存在> ts=<缺失>")
            soft_diffs.append({"tick": tick, "category": CAT_MISSING_INPUT, "detail": missing[-1]})
            continue
        pa, pb = py_records[tick], ts_records[tick]

        # state 硬比较
        diffs = compare_state(pa["state"], pb["state"])
        if diffs:
            state_diffs.append({"tick": tick, "details": diffs})
            if first_divergence is None:
                first_divergence = tick

        # phase
        if pa["phase"] != pb["phase"]:
            soft_diffs.append({"tick": tick, "category": CAT_PHASE,
                               "detail": f"phase: py={pa['phase']} ts={pb['phase']}"})
            if first_divergence is None:
                first_divergence = tick

        # memory（按子块比较，key 对齐）
        for block in ("resources", "enemies", "units"):
            ma, mb = pa["memory"].get(block, {}), pb["memory"].get(block, {})
            for key in sorted(set(ma) | set(mb)):
                if ma.get(key) != mb.get(key):
                    soft_diffs.append({"tick": tick, "category": CAT_WORLD,
                                       "detail": f"memory/{block}/{key}: py={json.dumps(ma.get(key), ensure_ascii=False)[:70]} ts={json.dumps(mb.get(key), ensure_ascii=False)[:70]}"})
                    if first_divergence is None:
                        first_divergence = tick

        # intents
        if pa.get("intents") != pb.get("intents"):
            soft_diffs.append({"tick": tick, "category": CAT_INTENT,
                               "detail": f"intents: py={json.dumps(pa.get('intents'), ensure_ascii=False)[:80]} ts={json.dumps(pb.get('intents'), ensure_ascii=False)[:80]}"})
            if first_divergence is None:
                first_divergence = tick

        # plan
        for cat, detail in compare_plan(pa.get("plan", {}), pb.get("plan", {})):
            soft_diffs.append({"tick": tick, "category": cat, "detail": detail})
            if first_divergence is None:
                first_divergence = tick

    # 分类统计 + 白名单 + unexplained
    by_cat: dict[str, int] = {}
    for d in soft_diffs:
        by_cat[d["category"]] = by_cat.get(d["category"], 0) + 1
    unexplained = [d for d in soft_diffs if d["category"] not in whitelist]
    unexplained_by_cat = {}
    for d in unexplained:
        unexplained_by_cat[d["category"]] = unexplained_by_cat.get(d["category"], 0) + 1

    # 报告
    lines = [
        "# W3 差分报告（Differential Record v1.0.1）",
        "",
        f"- 对比范围：{len(ticks)} ticks（py {len(py_records)} / ts {len(ts_records)}）",
        f"- state 硬差异：{len(state_diffs)} tick",
        f"- 软差异：{len(soft_diffs)} 条（{json.dumps(by_cat, ensure_ascii=False)}）",
        f"- 白名单：{sorted(whitelist) or '无'}",
        f"- 未解释差异：{len(unexplained)} 条（{json.dumps(unexplained_by_cat, ensure_ascii=False)}）",
        f"- 首次分歧：tick {first_divergence if first_divergence is not None else '无'}",
        "",
    ]
    if state_diffs:
        lines.append("## state 硬差异（reducer bug，必须修复）")
        for d in state_diffs[:10]:
            for detail in d["details"][:5]:
                lines.append(f"- tick {d['tick']} {detail}")
        lines.append("")
    if unexplained:
        lines.append("## 未解释软差异 TOP 20")
        for d in unexplained[:20]:
            wl = "" if d["category"] in whitelist else " [WHITELISTED]" if False else ""
            lines.append(f"- tick {d['tick']} [{d['category']}]{wl} {d['detail']}")
        lines.append("")

    state_clean = len(state_diffs) == 0
    lines.append(f"结论：{'STATE_CLEAN' if state_clean else f'STATE_DIFFS: {len(state_diffs)}'} · "
                 f"未解释差异 {len(unexplained)} 条")
    report = "\n".join(lines) + "\n"

    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"报告 → {args.report}")
    else:
        print(report)

    if args.json:
        machine = {
            "ticks": len(ticks),
            "py_records": len(py_records),
            "ts_records": len(ts_records),
            "state_diffs": state_diffs,
            "soft_diffs": soft_diffs,
            "by_category": by_cat,
            "unexplained": len(unexplained),
            "unexplained_by_category": unexplained_by_cat,
            "first_divergence_tick": first_divergence,
            "whitelist": sorted(whitelist),
            "state_clean": state_clean,
        }
        Path(args.json).write_text(json.dumps(machine, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"机器报告 → {args.json}")

    # 退出码：state 硬差异 > 0 → 1；未解释差异 > 0 → 1
    if not state_clean or len(unexplained) > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
