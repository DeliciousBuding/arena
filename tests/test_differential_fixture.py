"""切片 2A：fixture builder 测试（tmp_path，无网络）。

覆盖：坏 JSON fail-fast（SystemExit）、segments/gaps 分组（跨 gap 数据）、
config_hash 单源（canonical JSON）、sha256 前缀格式、构建后自校验 fail-fast、
脱敏、重复构建字节一致、manifest round-trip、Schema 关键约束。
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from scripts.differential import fixture_builder
from scripts.differential.fixture_builder import (
    FixtureBuildError,
    compute_gap_entries,
    compute_segments,
    main,
    run,
    sanitize_value,
    self_check,
)
from scripts.differential.fixture_model import (
    DEFAULT_DECISION_CONFIG,
    DatasetManifest,
    canonical_json,
    config_hash_of,
)

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


def load_manifest(out: Path) -> DatasetManifest:
    return DatasetManifest.from_json((out / "manifest.json").read_text(encoding="utf-8"))


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


# ---------------------------------------------------------------- 2. segments / gaps


def test_gaps_recorded_in_manifest(tmp_path: Path) -> None:
    """带缺口 source：窗口降级取最长连续干净段 → 单 segment、无 inter-segment gap。"""
    ticks = {t: valid_body(t) for t in (1, 2, 4, 5, 7)}  # 缺 3、6
    out = build(tmp_path, ticks, window=100)
    manifest = load_manifest(out)
    assert manifest.segments == [{"segment_id": "unknown-001", "ticks": [1, 2]}]
    assert manifest.gaps == []          # 单 segment 无相邻缺口
    assert manifest.bad_files == []
    assert set(manifest.inputs) == {"1", "2"}


def test_compute_segments_groups_with_gaps() -> None:
    """跨 gap 的 tick 列表必须按连续段分组（核心语义：不许跨 gap 延续 segment）。"""
    segments = compute_segments([1, 2, 3, 5, 6, 8], tenant_id="t1")
    assert segments == [
        {"segment_id": "t1-001", "ticks": [1, 2, 3]},
        {"segment_id": "t1-002", "ticks": [5, 6]},
        {"segment_id": "t1-003", "ticks": [8]},
    ]
    assert compute_gap_entries(segments) == [
        {"after": 3, "before": 5, "missing_count": 1},
        {"after": 6, "before": 8, "missing_count": 1},
    ]
    # 连续序列只有一个 segment、无 gap
    assert compute_segments([10, 11, 12], "t2") == [{"segment_id": "t2-001", "ticks": [10, 11, 12]}]
    assert compute_gap_entries(compute_segments([10, 11, 12], "t2")) == []


def test_manifest_rejects_gap_spanning_segment() -> None:
    """模型级防线：segment 内部不连续（跨 gap 延续）或 gaps 与边界不符 → 拒绝。"""
    with pytest.raises(ValueError, match="内部 tick 不连续"):
        DatasetManifest(
            dataset_id="x", source="runs/x/raw-state", tenant_id="t1",
            segments=[{"segment_id": "t1-001", "ticks": [1, 2, 4]}],  # 3 缺失却同段
            gaps=[], inputs={}, decision_config={}, config_hash="sha256:" + "0" * 64,
        )
    with pytest.raises(ValueError, match="与 segment 边界不符"):
        DatasetManifest(
            dataset_id="x", source="runs/x/raw-state", tenant_id="t1",
            segments=[{"segment_id": "t1-001", "ticks": [1, 2]},
                      {"segment_id": "t1-002", "ticks": [6, 7]}],
            gaps=[{"after": 2, "before": 9, "missing_count": 6}],  # before 与边界不符
            inputs={}, decision_config={}, config_hash="sha256:" + "0" * 64,
        )


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
        segments=[{"segment_id": "t1-001", "ticks": [10, 11, 12]},
                  {"segment_id": "t1-002", "ticks": [14]}],
        gaps=[{"after": 12, "before": 14, "missing_count": 1}],
        inputs={"10": {"sha256": "sha256:" + "a" * 64, "size": 100}},
        decision_config={"worker_target": 8},
        config_hash="sha256:" + "b" * 64,
        map_mode="frozen",
        bad_files=[13],
    )
    text = m.to_json()
    m2 = DatasetManifest.from_json(text)
    assert m2 == m
    assert m2.to_json() == text  # to_json → from_json → to_json 字节一致


def test_manifest_round_trip_optional_defaults() -> None:
    """可选字段（map_mode/protocol_version/bad_files）缺省兼容。"""
    text = json.dumps({
        "dataset_id": "legacy",
        "source": "runs/run-x/raw-state",
        "tenant_id": "unknown",
        "segments": [{"segment_id": "unknown-001", "ticks": [1]}],
        "gaps": [],
        "inputs": {"1": {"sha256": "sha256:" + "0" * 64, "size": 1}},
        "decision_config": {"worker_target": 8},
        "config_hash": "sha256:" + "1" * 64,
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
    manifest = load_manifest(out)
    assert manifest.bad_files == [3]
    assert 3 not in [t for seg in manifest.segments for t in seg["ticks"]]
    assert not (out / "3.json").exists()


# ---------------------------------------------------------------- 8. decision_config 单源 + config_hash


def test_default_config_injected_and_hash_matches(tmp_path: Path) -> None:
    """缺省 --config-json：manifest.decision_config == 契约中立默认配置，hash 一致。"""
    out = build(tmp_path, {t: valid_body(t) for t in range(1, 4)})
    manifest = load_manifest(out)
    assert manifest.decision_config == DEFAULT_DECISION_CONFIG
    assert manifest.config_hash == config_hash_of(DEFAULT_DECISION_CONFIG)
    assert manifest.config_hash.startswith("sha256:")
    assert len(manifest.config_hash) == 7 + 64


def test_config_hash_changes_with_config(tmp_path: Path) -> None:
    """改 config 值 → hash 变；仅 key 顺序不同 → canonical JSON hash 不变。"""
    ticks = {t: valid_body(t) for t in range(1, 4)}
    src = make_source(tmp_path, ticks)

    cfg_default = DEFAULT_DECISION_CONFIG
    cfg_changed = {**DEFAULT_DECISION_CONFIG, "worker_target": 9}
    cfg_reordered = dict(sorted(cfg_default.items(), key=lambda kv: kv[0], reverse=True))

    assert config_hash_of(cfg_changed) != config_hash_of(cfg_default)
    assert config_hash_of(cfg_reordered) == config_hash_of(cfg_default)  # canonical：与字面顺序无关
    assert canonical_json(cfg_reordered) == canonical_json(cfg_default)

    def build_with(cfg: dict) -> DatasetManifest:
        out = tmp_path / ("out-" + str(hash(json.dumps(cfg, sort_keys=True))))
        main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
              "--out", str(out), "--config-json", json.dumps(cfg)])
        return load_manifest(out)

    m1, m2, m3 = build_with(cfg_default), build_with(cfg_changed), build_with(cfg_reordered)
    assert m1.config_hash == m3.config_hash
    assert m2.config_hash != m1.config_hash
    assert m2.decision_config == cfg_changed  # 用户传入的 config 原样进入 manifest


def test_config_json_invalid_errors(tmp_path: Path) -> None:
    """坏 --config-json 必须报错（非法 JSON / 非对象），不产出任何产物。"""
    src = make_source(tmp_path, {1: valid_body(1)})
    for bad in ("{not json", "[1, 2, 3]", '"str"'):
        out = tmp_path / "out"
        with pytest.raises(SystemExit) as exc:
            main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
                  "--out", str(out), "--config-json", bad])
        assert exc.value.code == 2  # argparse 参数错误
        assert not out.exists(), f"--config-json {bad!r} 时不得产出任何产物"


# ---------------------------------------------------------------- 9. sha256 前缀格式（契约 v1.0.1 规则 9）


def test_input_sha256_prefix_format(tmp_path: Path) -> None:
    """inputs[tick].sha256 统一 "sha256:<64hex>" 前缀，且与落盘文件逐字节一致。"""
    out = build(tmp_path, {t: valid_body(t) for t in range(1, 4)})
    manifest = load_manifest(out)
    for tick in ("1", "2", "3"):
        sha = manifest.inputs[tick]["sha256"]
        assert re.fullmatch(r"sha256:[0-9a-f]{64}", sha), f"sha256 前缀格式非法: {sha}"
        assert sha == "sha256:" + sha256_of(out / f"{tick}.json")
        assert manifest.inputs[tick]["size"] == (out / f"{tick}.json").stat().st_size


# ---------------------------------------------------------------- 10. 构建后自校验 fail-fast


def test_self_check_detects_tampered_config_hash(tmp_path: Path) -> None:
    """直接篡改 manifest → 自校验拒绝（任一断言失败即 fail-fast）。"""
    src = make_source(tmp_path, {t: valid_body(t) for t in range(1, 4)})
    manifest, payloads = run(src, dataset="test-ds", tenant="auto", map_mode="disabled",
                             window=100, hard_window=False)
    chosen = [t for seg in manifest.segments for t in seg["ticks"]]
    bad_ticks = list(manifest.bad_files)

    manifest.config_hash = "sha256:" + "0" * 64  # 篡改
    with pytest.raises(FixtureBuildError, match="config_hash"):
        self_check(manifest, payloads, chosen, bad_ticks)

    manifest = DatasetManifest.from_json(manifest.to_json())
    manifest.inputs["1"]["sha256"] = "sha256:" + "1" * 64  # 篡改 inputs
    with pytest.raises(FixtureBuildError, match="不一致"):
        self_check(manifest, payloads, chosen, bad_ticks)


def test_self_check_failure_exits_no_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """构建期自校验失败 → SystemExit(1)，且不产出任何产物（fail-fast 接线）。"""
    src = make_source(tmp_path, {t: valid_body(t) for t in range(1, 4)})
    out = tmp_path / "out"

    def boom(*_args, **_kwargs):
        raise FixtureBuildError("自校验失败: 模拟")

    monkeypatch.setattr(fixture_builder, "self_check", boom)
    with pytest.raises(SystemExit) as exc:
        main(["--source", str(src), "--dataset", "test-ds", "--tenant", "auto",
              "--out", str(out)])
    assert exc.value.code == 1
    assert not out.exists(), "自校验失败时不得产出任何产物"


# ---------------------------------------------------------------- 11. Schema 关键约束（stdlib 逐字段比对）


def test_manifest_matches_schema_key_constraints(tmp_path: Path) -> None:
    """构建产物逐字段满足 manifest-v1.schema.json 关键约束（不引入 jsonschema 依赖）。"""
    out = build(tmp_path, {t: valid_body(t) for t in range(1, 4)})
    data = json.loads((out / "manifest.json").read_text(encoding="utf-8"))

    required = {"protocol_version", "dataset_id", "source", "tenant_id",
                "segments", "gaps", "inputs", "map_mode", "decision_config", "config_hash"}
    assert required <= set(data)
    assert data["protocol_version"] == 1
    assert data["map_mode"] in ("disabled", "frozen", "controlled")

    assert len(data["segments"]) >= 1
    for seg in data["segments"]:
        assert set(seg) == {"segment_id", "ticks"}  # additionalProperties: false
        assert isinstance(seg["segment_id"], str)
        assert len(seg["ticks"]) >= 1
        assert all(isinstance(t, int) and t >= 0 for t in seg["ticks"])
        assert all(b == a + 1 for a, b in zip(seg["ticks"], seg["ticks"][1:]))  # 内部严格连续

    for gap in data["gaps"]:
        assert set(gap) == {"after", "before", "missing_count"}
        assert gap["missing_count"] >= 0
        assert gap["missing_count"] == gap["before"] - gap["after"] - 1

    for info in data["inputs"].values():
        assert set(info) == {"sha256", "size"}
        assert re.fullmatch(r"sha256:[0-9a-f]{64}", info["sha256"])
        assert isinstance(info["size"], int) and info["size"] >= 0

    assert isinstance(data["decision_config"], dict)
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", data["config_hash"])
