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
    assert "STATE_DIFFS" in proc.stdout
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
    """白名单内类别 → 未解释 0 → exit 0。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    wl = tmp_path / "wl.json"
    bad = json.loads(json.dumps(RECORD))
    bad["plan"]["unit_actions"]["u1"]["type"] = "HARVEST"
    write_jsonl(a, [RECORD])
    write_jsonl(b, [bad])
    wl.write_text(json.dumps({"plan_action_type": "测试白名单"}), encoding="utf-8")
    proc = run(a, b, wl)
    assert proc.returncode == 0
    assert "未解释差异 0 条" in proc.stdout


def test_missing_tick_reported(tmp_path):
    """单侧缺失 tick → missing_input 类别。"""
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    rec2 = json.loads(json.dumps(RECORD))
    rec2["tick"] = 101
    write_jsonl(a, [RECORD, rec2])
    write_jsonl(b, [RECORD])
    proc = run(a, b)
    assert "[missing_input]" in proc.stdout
