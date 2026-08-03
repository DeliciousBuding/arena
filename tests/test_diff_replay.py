"""diff_replay 差分比较器测试：fail-fast、分类、白名单、退出码。

W3 验收工具回归保护（契约 v1.0.1）。
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "diff_replay.py"

RECORD = {
    "protocol_version": 1,
    "dataset_id": "test",
    "tenant_id": "t1",
    "segment_id": "s1",
    "tick": 100,
    "input_sha256": "sha256:" + "0" * 64,
    "config_hash": "sha256:" + "1" * 64,
    "map_snapshot_hash": None,
    "state": {
        "resources": 4, "population": 1, "resource_capacity": 10, "resource_space": 6,
        "core": {"id": "c1", "position": [0, 0], "hp": 5, "shield": 5, "state": "NORMAL"},
        "units": [{"id": "u1", "position": [1, 0], "hp": 2, "cargo": 0, "unit_type": "WORKER"}],
        "enemies": [],
        "resource_cells": [[2, 0]],
        "obstacle_cells": [[3, 0]],
        "beacon": None,
    },
    "phase": "early_expansion",
    "memory": {"resources": {}, "enemies": {}, "units": {"u1": {"mode": "patrol"}}},
    "intents": {"u1": "explore"},
    "plan": {"unit_actions": {"u1": {"type": "MOVE", "direction": "UP"}}, "core_action": None},
    "map_mode": "disabled",
}


def run(py_path: Path, ts_path: Path, whitelist: Path | None = None) -> subprocess.CompletedProcess:
    cmd = [sys.executable, str(SCRIPT), "--py", str(py_path), "--ts", str(ts_path)]
    if whitelist:
        cmd += ["--whitelist", str(whitelist)]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")


def test_identical_inputs_clean(tmp_path):
    """相同输入 → STATE_CLEAN + exit 0。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [RECORD])
    proc = run(a, b)
    assert proc.returncode == 0
    assert "STATE_CLEAN" in proc.stdout


def test_state_diff_exit_1(tmp_path):
    """state 硬差异（unit hp 不同）→ exit 1。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    bad = json.loads(json.dumps(RECORD))
    bad["state"]["units"][0]["hp"] = 1  # 故意改 state
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    proc = run(a, b)
    assert proc.returncode == 1
    assert "DIFFS: hard=1" in proc.stdout
    assert "state/units/u1/hp" in proc.stdout


def test_plan_type_diff_categorized(tmp_path):
    """plan 动作 type 不同 → plan_action_type 类别 + 未解释 → exit 1。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    bad = json.loads(json.dumps(RECORD))
    bad["plan"]["unit_actions"]["u1"]["type"] = "HARVEST"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    proc = run(a, b)
    assert proc.returncode == 1
    assert "[plan_action_type]" in proc.stdout


def test_whitelist_suppresses_soft_diff(tmp_path):
    """白名单规则内（category+path+difference 全匹配）→ 未解释 0 → exit 0。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    wl = tmp_path / "wl.json"
    bad = json.loads(json.dumps(RECORD))
    bad["plan"]["unit_actions"]["u1"]["type"] = "HARVEST"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    wl.write_text(json.dumps({"rules": [
        {"category": "plan_action_type", "path_pattern": "^plan/unit_actions/u1/type$",
         "difference": "value_mismatch", "reason": "测试白名单"},
    ]}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 0
    assert "未解释差异 0 条" in proc.stdout


def test_whitelist_rule_mismatch_fails(tmp_path):
    """白名单规则只匹配指定路径——同类别其他路径的差异仍必须失败。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    wl = tmp_path / "wl.json"
    bad = json.loads(json.dumps(RECORD))
    bad["plan"]["unit_actions"]["u1"]["type"] = "HARVEST"  # 路径 u1，规则写 u2
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    wl.write_text(json.dumps({"rules": [
        {"category": "plan_action_type", "path_pattern": "^plan/unit_actions/u2/type$",
         "difference": "value_mismatch", "reason": "路径不匹配"},
    ]}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 1
    assert "[plan_action_type]" in proc.stdout


def test_whitelist_key_scope_matches_only_exact_fixture_window(tmp_path):
    """有界规则只放行指定 dataset/tenant/segment/tick 窗口。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    wl = tmp_path / "wl.json"
    bad = json.loads(json.dumps(RECORD))
    bad["plan"]["unit_actions"]["u1"]["direction"] = "DOWN"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    rule = {
        "category": "plan_action_param",
        "path_pattern": "^plan/unit_actions/[^/]+$",
        "difference": "value_mismatch",
        "dataset_id": "test",
        "tenant_id": "t1",
        "segment_id": "s1",
        "tick_min": 100,
        "tick_max": 100,
        "reason": "固定 fixture 的已知策略差异",
    }
    wl.write_text(json.dumps({"rules": [rule]}), encoding="utf-8")
    assert run(a, b, wl).returncode == 0

    rule["tick_min"] = 101
    rule["tick_max"] = 101
    wl.write_text(json.dumps({"rules": [rule]}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 1
    assert "[plan_action_param]" in proc.stdout


def test_whitelist_rejects_unknown_fields_and_missing_reason(tmp_path):
    """白名单本身必须 fail closed，不能靠拼错字段形成隐式全局豁免。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [RECORD])
    wl = tmp_path / "wl.json"
    wl.write_text(json.dumps({"rules": [{
        "category": "world_memory", "path_pattern": ".*", "unknown_scope": "x", "reason": "x"
    }]}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 1
    assert "未知字段" in proc.stderr

    wl.write_text(json.dumps({"rules": [{
        "category": "world_memory", "path_pattern": ".*"
    }]}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 1
    assert "非空 reason" in proc.stderr


def test_metadata_mismatch_hard_error(tmp_path):
    """input_sha256 不一致 → record_metadata 硬错误 → exit 1（白名单不可覆盖）。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    bad = json.loads(json.dumps(RECORD))
    bad["input_sha256"] = "sha256:" + "f" * 64
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    proc = run(a, b)
    assert proc.returncode == 1
    assert "[record_metadata]" in proc.stdout


def test_duplicate_key_fail_fast(tmp_path):
    """重复复合键 → fail-fast（SystemExit）。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    dup = json.loads(json.dumps(RECORD))
    dup["tick"] = 100  # 与第一条同键
    write_jsonl(a, [RECORD, dup])
    write_jsonl(b, [RECORD])
    proc = run(a, b)
    assert proc.returncode == 1
    assert "重复 record 键" in proc.stderr


def test_invalid_record_schema_rejected(tmp_path):
    """缺字段的 record → schema 校验失败 → fail-fast。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    bad = json.loads(json.dumps(RECORD))
    del bad["state"]["beacon"]  # 违反 schema（state.beacon required）
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    proc = run(a, b)
    assert proc.returncode == 1
    assert "schema 校验失败" in proc.stderr


def test_missing_tick_reported(tmp_path):
    """单侧缺失 tick → missing_input 类别。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    rec2 = json.loads(json.dumps(RECORD))
    rec2["tick"] = 101
    write_jsonl(a, [RECORD, rec2])
    write_jsonl(b, [RECORD])
    proc = run(a, b)
    assert "[missing_input]" in proc.stdout

