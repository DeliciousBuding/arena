"""切片 2A：fixture builder 测试（tmp_path，无网络）。

覆盖：坏 JSON fail-fast（SystemExit）、缺口进 manifest、脱敏、重复构建字节一致、
manifest round-trip。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.differential.fixture_builder import (
    FixtureBuildError,
    main,
    sanitize_value,
)
from scripts.differential.fixture_model import DatasetManifest

# ---------------------------------------------------------------- helpers


def write_tick(dir_path: Path, tick: int, body: dict | str) -> Path:
    p = dir_path / f"{tick}.json"
    if isinstance(body, str):
        p.write_text(body, encoding="utf-8")
    else:
        p.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    return p


def make_source(tmp_path: Path, ticks: dict[int, dict | str]) -> Path:
    src = tmp_path / "raw-state"
    src.mkdir(exist_ok=True)
    for tick, body in ticks.items():
        write_tick(src, tick, body)
    return src


def valid_body(tick: int) -> dict:
    return {
        "status": "ACTIVE",
        "tick": tick,
        "owner_username": "buding",
        "objects": [{"kind": "CORE", "id": f"core-{tick}", "owner_username": "deliciousbuding"}],
        "note": f"user buding at D:/home/{tick}",
    }


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(
    tmp_path: Path,
    ticks: dict[int, dict | str],
    *,
    dataset: str = "test-ds",
    window: int | None = None,
    out_name: str = "out",
    tenant: str = "auto",
) -> Path:
    src = make_source(tmp_path, ticks)
    out = tmp_path / out_name
    argv = ["--source", str(src), "--dataset", dataset, "--tenant", tenant, "--out", str(out)]
    if window is not None:
        argv += ["--window", str(window)]
    main(argv)
    return out


# ---------------------------------------------------------------- 1. 坏 JSON fail-fast


def test_bad_json_fail_fast_exit(tmp_path: Path) -> None:
    """坏 JSON + 显式硬窗口（无法绕开）→ SystemExit(1)，且不产出任何产物。"""
    ticks = {t: valid_body(t) for t in range(1, 7)}
    ticks[4] = '{"status": "ACTIVE", "tick": 4, "broken'  # 截断的坏 JSON
    src = make_source(tmp_path, ticks)
    out = tmp_path / "out"

    with pytest.raises(SystemExit) as exc:
        main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
              "--out", str(out), "--window", "6", "--exact"])
    assert exc.value.code == 1
    assert not out.exists(), "fail-fast 时不得产出任何产物"


def test_empty_file_fail_fast(tmp_path: Path) -> None:
    """0 字节文件同样 fail-fast（完整性校验的一部分）。"""
    ticks = {t: valid_body(t) for t in range(1, 6)}
    ticks[3] = ""
    src = make_source(tmp_path, ticks)

    with pytest.raises(SystemExit) as exc:
        main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
              "--out", str(tmp_path / "out"), "--window", "5", "--exact"])
    assert exc.value.code == 1


def test_bad_json_error_names_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """坏文件必须点名（文件名 + tick + 原因），不静默。"""
    ticks = {t: valid_body(t) for t in range(1, 6)}
    ticks[4] = "{not json"
    src = make_source(tmp_path, ticks)

    with pytest.raises(SystemExit):
        main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
              "--out", str(tmp_path / "out"), "--window", "5", "--exact"])
    err = capsys.readouterr().err
    assert "4.json" in err and "tick 4" in err and "JSON" in err


# ---------------------------------------------------------------- 2. 缺口进 manifest


def test_gaps_recorded_in_manifest(tmp_path: Path) -> None:
    """带缺口序列：source 跨度内缺失的 tick 显式进入 manifest.gaps。"""
    ticks = {t: valid_body(t) for t in (1, 2, 4, 5, 7)}  # 缺 3、6
    out = build(tmp_path, ticks, window=100)
    manifest = DatasetManifest.from_json((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.ticks == [1, 2]          # 无 100 连续窗口 → 降级取最长连续段 [1,2]
    assert manifest.gaps == [3, 6]           # 缺口显式进入 manifest
    assert manifest.bad_files == []


# ---------------------------------------------------------------- 3. 脱敏


def test_sanitize_owner_and_accounts(tmp_path: Path) -> None:
    """owner_username → fixture_user；真实账号名/本机路径被清理；内容不含 buding。"""
    body = valid_body(1)
    body["extra"] = {"path": "C:\\Users\\x\\game", "acct": "delicious23333 says deliciousbuding"}
    out = build(tmp_path, {1: body})
    text = (out / "1.json").read_text(encoding="utf-8")

    assert "fixture_user" in text
    assert "buding" not in text
    assert "delicious" not in text
    assert "D:/" not in text
    assert "C:\\" not in text
    assert json.loads(text)["extra"]["acct"] == "[REDACTED] says [REDACTED]"


def test_sanitize_other_fields_kept(tmp_path: Path) -> None:
    """其他字段原样保留（数值、布尔、普通字符串）。"""
    body = valid_body(1)
    out = build(tmp_path, {1: body})
    data = json.loads((out / "1.json").read_text(encoding="utf-8"))
    assert data["status"] == "ACTIVE"
    assert data["tick"] == 1
    assert data["objects"][0]["kind"] == "CORE"
    assert data["objects"][0]["owner_username"] == "fixture_user"


# ---------------------------------------------------------------- 4. 重复构建字节一致


def test_repeat_build_byte_identical(tmp_path: Path) -> None:
    """同输入构建两次（不同 out 目录），所有产物（tick + manifest）sha256 一致。"""
    ticks = {t: valid_body(t) for t in range(1, 6)}
    out1 = build(tmp_path, ticks, out_name="out1")
    out2 = build(tmp_path, ticks, out_name="out2")

    f1 = {p.name: p for p in out1.iterdir()}
    f2 = {p.name: p for p in out2.iterdir()}
    assert set(f1) == set(f2) == {"manifest.json", "1.json", "2.json", "3.json", "4.json", "5.json"}
    for name in f1:
        assert sha256_of(f1[name]) == sha256_of(f2[name]), f"产物 {name} 字节不一致"


# ---------------------------------------------------------------- 5. manifest round-trip


def test_manifest_round_trip() -> None:
    m = DatasetManifest(
        dataset_id="burnin-x",
        source="runs/run-x/raw-state",
        tenant_id="t1",
        ticks=[10, 11, 12],
        gaps=[14],
        inputs={"10": {"sha256": "abc", "size": 100}},
        map_mode="frozen",
        bad_files=[13],
    )
    text = m.to_json()
    m2 = DatasetManifest.from_json(text)
    assert m2 == m
    assert m2.to_json() == text  # to_json → from_json → to_json 字节一致


def test_manifest_round_trip_optional_defaults() -> None:
    """老 manifest（无可选字段）也能读：map_mode/protocol_version/bad_files 缺省。"""
    text = json.dumps({
        "dataset_id": "legacy",
        "source": "runs/run-x/raw-state",
        "tenant_id": "unknown",
        "ticks": [1],
        "gaps": [],
        "inputs": {"1": {"sha256": "x", "size": 1}},
    })
    m = DatasetManifest.from_json(text)
    assert m.map_mode == "disabled"
    assert m.protocol_version == 1
    assert m.bad_files == []


# ---------------------------------------------------------------- 6. 脱敏纯函数


def test_sanitize_value_pure() -> None:
    assert sanitize_value({"owner_username": "deliciousbuding"}) == {"owner_username": "fixture_user"}
    assert sanitize_value({"a": [1, True, None, "buding", {"b": "C:/x"}]}) == {
        "a": [1, True, None, "[REDACTED]", {"b": "[REDACTED]x"}]}


# ---------------------------------------------------------------- 7. 边界：坏 JSON 全量点名 + 降级仍然排除坏文件


def test_bad_files_excluded_and_recorded(tmp_path: Path) -> None:
    """坏文件被显式排除且记录进 bad_files，窗口降级后数据集仍全部合法。"""
    ticks = {t: valid_body(t) for t in range(1, 8)}
    ticks[3] = "{broken"
    out = build(tmp_path, ticks)  # 默认窗口 100 → 降级
    manifest = DatasetManifest.from_json((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.bad_files == [3]
    assert 3 not in manifest.ticks
    assert not (out / "3.json").exists()
