"""Differential comparator：对比 E1（Python）/E2（TS）回放输出，生成分类差分报告。

W3 验收工具（v1.0.1 + W3.1 加固）。输入两个 Differential Record v1 JSONL，按复合键
(dataset_id, tenant_id, segment_id, tick) 对齐，四维比较：

    state（硬：canonical 语义树，不一致 = reducer bug → exit 1）
    record_metadata（硬：input_sha256/config_hash/map_mode 不一致 → exit 1）
    memory / phase / intents / plan（软：按白名单 rules 精确放行）

W3.1 加固：
- 白名单从「类别放行」改为「规则放行」：{category, path_pattern, difference, reason}
- 复合主键 + 重复 fail-fast；metadata 不一致单独归 record_metadata 硬错误
- 输入 record 真实执行 record-v1.schema.json 校验（jsonschema）

契约：docs/differential-record-v1.md + contracts/differential/record-v1.schema.json。

用法：
    uv run python scripts/diff_replay.py --py /tmp/replay-py.jsonl --ts /tmp/replay-ts.jsonl \
        [--report /tmp/diff-report.txt] [--json /tmp/diff.json] [--whitelist scripts/differential/whitelist.json]

退出码：硬差异（state/record_metadata）> 0 → 1；未解释差异 > 0 → 1；其余 → 0。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from jsonschema import ValidationError, validate as schema_validate

ROOT = Path(__file__).resolve().parent.parent
RECORD_SCHEMA = json.loads(
    (ROOT / "contracts" / "differential" / "record-v1.schema.json").read_text(encoding="utf-8")
)

CAT_STATE = "state_reducer"       # 硬
CAT_METADATA = "record_metadata"  # 硬
CAT_WORLD = "world_memory"        # 软
CAT_PHASE = "phase"               # 软
CAT_INTENT = "intent"             # 软
CAT_PLAN_TYPE = "plan_action_type"
CAT_PLAN_PARAM = "plan_action_param"
CAT_PLAN_MISSING = "plan_unit_missing"
CAT_MISSING_INPUT = "missing_input"
CAT_REPRESENTATION = "representation"

HARD = {CAT_STATE, CAT_METADATA}


def load_records(path: str) -> dict[tuple, dict]:
    """解析 JSONL，复合键 (dataset_id, tenant_id, segment_id, tick)；重复键 fail-fast。"""
    records: dict[tuple, dict] = {}
    for lineno, line in enumerate(
        Path(path).read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        rec = json.loads(line)
        # 机器 Schema 校验（W3.1：真正执行，不靠手写）
        try:
            schema_validate(rec, RECORD_SCHEMA)
        except ValidationError as exc:
            raise SystemExit(
                f"{path}:{lineno} record schema 校验失败: {exc.message} "
                f"(path={exc.json_path})"
            )
        key = (rec["dataset_id"], rec["tenant_id"], rec["segment_id"], int(rec["tick"]))
        if key in records:
            raise SystemExit(f"{path}:{lineno} 重复 record 键 {key}")
        records[key] = rec
    return records


def collect_diffs(pa, pb, prefix: str, out: list) -> None:
    """递归收集语义差异（JSON Pointer 定位）。"""
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
            return merged
    for key in ("resource_cells", "obstacle_cells"):
        a[key] = sorted(tuple(c) for c in a.get(key, []))
        b[key] = sorted(tuple(c) for c in b.get(key, []))
    out: list[str] = []
    collect_diffs(a, b, "state", out)
    return out


def diff_kind(py_val, ts_val) -> str:
    """差异形态：py_present_ts_missing / ts_present_py_missing / value_mismatch。"""
    if py_val is not None and ts_val is None:
        return "py_present_ts_missing"
    if ts_val is not None and py_val is None:
        return "ts_present_py_missing"
    return "value_mismatch"


def compare_plan(pa: dict, pb: dict) -> list[tuple[str, str, str]]:
    """plan 比较：unit_actions 按 id 对齐；core_action 直接比。返回 [(类别, path, detail)]。"""
    diffs: list[tuple[str, str, str]] = []
    ua, ub = pa.get("unit_actions", {}), pb.get("unit_actions", {})
    for uid in sorted(set(ua) | set(ub)):
        if uid not in ub:
            diffs.append((CAT_PLAN_MISSING, f"plan/unit_actions/{uid}",
                          f"plan/unit_actions/{uid}: py=<存在> ts=<缺失>"))
        elif uid not in ua:
            diffs.append((CAT_PLAN_MISSING, f"plan/unit_actions/{uid}",
                          f"plan/unit_actions/{uid}: py=<缺失> ts=<存在>"))
        else:
            act_a, act_b = ua[uid], ub[uid]
            if act_a.get("type") != act_b.get("type"):
                diffs.append((CAT_PLAN_TYPE, f"plan/unit_actions/{uid}/type",
                              f"plan/unit_actions/{uid}: py={act_a.get('type')} ts={act_b.get('type')}"))
            elif act_a != act_b:
                diffs.append((CAT_PLAN_PARAM, f"plan/unit_actions/{uid}",
                              f"plan/unit_actions/{uid}: py={json.dumps(act_a, ensure_ascii=False)[:70]} ts={json.dumps(act_b, ensure_ascii=False)[:70]}"))
    if pa.get("core_action") != pb.get("core_action"):
        diffs.append((CAT_PLAN_PARAM, "plan/core_action",
                      f"plan/core_action: py={json.dumps(pa.get('core_action'), ensure_ascii=False)[:70]} ts={json.dumps(pb.get('core_action'), ensure_ascii=False)[:70]}"))
    return diffs


def load_whitelist_rules(path: str | None) -> list[dict]:
    """白名单 rules：[{category, path_pattern, difference, reason}]。"""
    if not path:
        return []
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rules = data.get("rules", data if isinstance(data, list) else [])
    return rules


def is_whitelisted(rules: list[dict], category: str, path: str, kind: str) -> bool:
    """规则放行：category + path_pattern(re) + difference 全匹配。"""
    for rule in rules:
        if rule.get("category") != category:
            continue
        if rule.get("difference") and rule["difference"] != kind:
            continue
        pattern = rule.get("path_pattern", "")
        if pattern and not re.match(pattern, path):
            continue
        return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--py", required=True)
    ap.add_argument("--ts", required=True)
    ap.add_argument("--report", help="人类可读报告路径（默认 stdout）")
    ap.add_argument("--json", help="机器可读报告路径")
    ap.add_argument("--whitelist", help="白名单 rules JSON：{rules: [{category, path_pattern, difference, reason}]}")
    args = ap.parse_args()

    py_records = load_records(args.py)
    ts_records = load_records(args.ts)
    rules = load_whitelist_rules(args.whitelist)

    keys = sorted(set(py_records) | set(ts_records))
    hard_diffs: list[dict] = []   # {key, category, details}
    soft_diffs: list[dict] = []   # {key, category, path, difference, detail}
    first_divergence: tuple | None = None

    for key in keys:
        if key not in py_records:
            soft_diffs.append({"key": key, "category": CAT_MISSING_INPUT, "path": "",
                               "difference": "ts_present_py_missing", "detail": f"{key}: py=<缺失> ts=<存在>"})
            if first_divergence is None:
                first_divergence = key
            continue
        if key not in ts_records:
            soft_diffs.append({"key": key, "category": CAT_MISSING_INPUT, "path": "",
                               "difference": "py_present_ts_missing", "detail": f"{key}: py=<存在> ts=<缺失>"})
            if first_divergence is None:
                first_divergence = key
            continue
        pa, pb = py_records[key], ts_records[key]

        # metadata 硬检查（W3.1：input_sha256/config_hash/map_mode 必须先一致）
        meta_diffs = []
        for field in ("input_sha256", "config_hash", "map_mode"):
            if pa.get(field) != pb.get(field):
                meta_diffs.append(f"metadata/{field}: py={pa.get(field)} ts={pb.get(field)}")
        if meta_diffs:
            hard_diffs.append({"key": key, "category": CAT_METADATA, "details": meta_diffs})
            if first_divergence is None:
                first_divergence = key

        # state 硬比较
        diffs = compare_state(pa["state"], pb["state"])
        if diffs:
            hard_diffs.append({"key": key, "category": CAT_STATE, "details": diffs})
            if first_divergence is None:
                first_divergence = key

        # phase
        if pa["phase"] != pb["phase"]:
            soft_diffs.append({"key": key, "category": CAT_PHASE, "path": "phase",
                               "difference": "value_mismatch",
                               "detail": f"phase: py={pa['phase']} ts={pb['phase']}"})
            if first_divergence is None:
                first_divergence = key

        # memory（按子块比较；软差异带 path 与 difference 形态）
        for block in ("resources", "enemies", "units"):
            ma, mb = pa["memory"].get(block, {}), pb["memory"].get(block, {})
            for sub in sorted(set(ma) | set(mb)):
                va, vb = ma.get(sub), mb.get(sub)
                if va != vb:
                    soft_diffs.append({
                        "key": key, "category": CAT_WORLD,
                        "path": f"memory/{block}/{sub}",
                        "difference": diff_kind(va, vb),
                        "detail": f"memory/{block}/{sub}: py={json.dumps(va, ensure_ascii=False)[:70]} ts={json.dumps(vb, ensure_ascii=False)[:70]}",
                    })
                    if first_divergence is None:
                        first_divergence = key

        # intents
        if pa.get("intents") != pb.get("intents"):
            soft_diffs.append({"key": key, "category": CAT_INTENT, "path": "intents",
                               "difference": "value_mismatch",
                               "detail": f"intents: py={json.dumps(pa.get('intents'), ensure_ascii=False)[:80]} ts={json.dumps(pb.get('intents'), ensure_ascii=False)[:80]}"})
            if first_divergence is None:
                first_divergence = key

        # plan
        for cat, path, detail in compare_plan(pa.get("plan", {}), pb.get("plan", {})):
            soft_diffs.append({"key": key, "category": cat, "path": path,
                               "difference": "value_mismatch", "detail": detail})
            if first_divergence is None:
                first_divergence = key

    # 白名单规则过滤（W3.1：类别+路径+形态全匹配才放行）
    unexplained = [
        d for d in soft_diffs
        if not is_whitelisted(rules, d["category"], d["path"], d["difference"])
    ]
    by_cat = {}
    for d in soft_diffs:
        by_cat[d["category"]] = by_cat.get(d["category"], 0) + 1
    unexplained_by_cat = {}
    for d in unexplained:
        unexplained_by_cat[d["category"]] = unexplained_by_cat.get(d["category"], 0) + 1
    hard_count = len(hard_diffs)

    # 报告
    lines = [
        "# W3 差分报告（Differential Record v1.0.1 + W3.1）",
        "",
        f"- 对比范围：{len(keys)} 个 record 键（py {len(py_records)} / ts {len(ts_records)}）",
        f"- 硬差异：{hard_count}（{json.dumps({d['category']: len(d['details']) for d in hard_diffs}, ensure_ascii=False)}）",
        f"- 软差异：{len(soft_diffs)} 条（{json.dumps(by_cat, ensure_ascii=False)}）",
        f"- 白名单规则：{len(rules)} 条",
        f"- 未解释差异：{len(unexplained)} 条（{json.dumps(unexplained_by_cat, ensure_ascii=False)}）",
        f"- 首次分歧：{first_divergence if first_divergence is not None else '无'}",
        "",
    ]
    if hard_diffs:
        lines.append("## 硬差异（必须修复）")
        for d in hard_diffs[:10]:
            for detail in d["details"][:5]:
                lines.append(f"- {d['key']} [{d['category']}] {detail}")
        lines.append("")
    if unexplained:
        lines.append("## 未解释软差异 TOP 20")
        for d in unexplained[:20]:
            lines.append(f"- {d['key']} [{d['category']}] {d['detail']}")
        lines.append("")

    clean = hard_count == 0 and len(unexplained) == 0
    lines.append(f"结论：{'STATE_CLEAN' if clean else f'DIFFS: hard={hard_count} unexplained={len(unexplained)}'} · "
                 f"未解释差异 {len(unexplained)} 条")
    report = "\n".join(lines) + "\n"

    if args.report:
        Path(args.report).write_text(report, encoding="utf-8")
        print(f"报告 → {args.report}")
    else:
        print(report)

    if args.json:
        machine = {
            "records": len(keys),
            "hard_diffs": hard_diffs,
            "soft_diffs": soft_diffs,
            "by_category": by_cat,
            "unexplained": len(unexplained),
            "unexplained_by_category": unexplained_by_cat,
            "first_divergence": list(first_divergence) if first_divergence else None,
            "whitelist_rules": rules,
            "clean": clean,
        }
        Path(args.json).write_text(json.dumps(machine, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"机器报告 → {args.json}")

    if not clean:
        sys.exit(1)


if __name__ == "__main__":
    main()
