"""Differential fixture 数据模型（纯 dataclass，无 I/O）。

W3 数据完整性层：DatasetManifest 描述一个脱敏、可复现、带完整性校验的
差分数据集。E1/E2 回放器消费本 manifest：
  - inputs[tick_str]["sha256"] == Differential Record v1 的 input_sha256
    （语义：脱敏后文件内容的 sha256，统一 "sha256:<64hex>" 前缀，与 fixture
    文件逐字节一致；契约 v1.0.1 规则 9）
  - segments 按连续段组织回放顺序（每 segment 内部严格连续、升序）；
    **禁止跨 gap 延续 segment** —— World/记忆/意图是跨 Tick 状态机，
    gap 中间的 tick 未知，segment 开头必须重建状态机
  - gaps 记录相邻 segment 之间的缺口（after/before/missing_count），显式进
    manifest，绝不静默
  - decision_config 是决策配置单源（两端从 manifest 读取，禁止各自读默认值）；
    config_hash 基于 decision_config 的 canonical JSON 计算（契约 v1.0.1）
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any

MAP_MODES = ("disabled", "frozen", "controlled")

PROTOCOL_VERSION = 1

# 契约中立配置（两端都能映射的字段名），fixture_builder --config-json 默认注入。
DEFAULT_DECISION_CONFIG: dict[str, Any] = {
    "worker_target": 8,
    "population_ceiling": 20,
    "explore_radius": 8,
    "guard_resources": 30,
    "guard_force": 4,
}

SHA256_PREFIX_RE = r"sha256:[0-9a-f]{64}"


def canonical_json(obj: Any) -> str:
    """canonical JSON（契约 v1.0.1）：sort_keys + 紧凑分隔符。

    config_hash 基于此计算，与 key 字面顺序无关。
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def config_hash_of(config: dict[str, Any]) -> str:
    """decision_config -> "sha256:<64hex>"（canonical JSON 的 sha256）。"""
    return "sha256:" + hashlib.sha256(canonical_json(config).encode("utf-8")).hexdigest()


@dataclass
class DatasetManifest:
    """差分数据集清单。

    Attributes:
        dataset_id: 数据集标识，如 burnin-20260802-a。
        source: 数据来源的相对描述（如 runs/<run_id>/raw-state），不写绝对路径。
        tenant_id: 租户标识（t1..t4）；扁平混合数据为 "unknown"。
        segments: [{segment_id, ticks}]，每 segment 内部严格连续 tick（升序），
            按首个 tick 升序排列；segment_id 形如 "<tenant_id>-<seq>"（如 t1-001）。
        gaps: [{after, before, missing_count}]，相邻 segment 之间的缺口；
            missing_count = before - after - 1（显式进入 manifest，绝不静默）。
        inputs: tick(str) -> {"sha256": "sha256:<64hex>", "size": 字节数}。
        decision_config: 决策配置单源（两端必须从 manifest 读取，禁止各自读默认值）。
        config_hash: decision_config 的 canonical JSON sha256（"sha256:" 前缀）。
        map_mode: "disabled" | "frozen" | "controlled"，默认 disabled。
        protocol_version: manifest 协议版本，当前 1。
        bad_files: source 中损坏（坏 JSON / 空文件 / 超限）的 tick 列表，
            观察性字段：窗口选择已排除它们，此处显式留档。
    """

    dataset_id: str
    source: str
    tenant_id: str
    segments: list[dict[str, Any]]
    gaps: list[dict[str, int]]
    inputs: dict[str, dict[str, Any]]
    decision_config: dict[str, Any]
    config_hash: str
    map_mode: str = "disabled"
    protocol_version: int = PROTOCOL_VERSION
    bad_files: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.map_mode not in MAP_MODES:
            raise ValueError(f"map_mode 必须是 {MAP_MODES} 之一，得到 {self.map_mode!r}")
        self._validate_segments()
        self._validate_gaps()

    def _validate_segments(self) -> None:
        if not self.segments:
            raise ValueError("segments 不得为空（manifest 必须至少一个 segment）")
        seen_ids: set[str] = set()
        prev_end: int | None = None
        for seg in self.segments:
            sid, ticks = seg.get("segment_id"), seg.get("ticks")
            if not isinstance(sid, str) or not sid:
                raise ValueError(f"segment_id 必须是非空字符串: {seg!r}")
            if sid in seen_ids:
                raise ValueError(f"segment_id 重复: {sid}")
            seen_ids.add(sid)
            if not isinstance(ticks, list) or not ticks:
                raise ValueError(f"segment {sid} 的 ticks 必须是非空列表")
            if not all(isinstance(t, int) and t >= 0 for t in ticks):
                raise ValueError(f"segment {sid} 的 ticks 必须是非负整数: {ticks!r}")
            if any(b != a + 1 for a, b in zip(ticks, ticks[1:])):
                raise ValueError(f"segment {sid} 内部 tick 不连续（禁止跨 gap 延续）: {ticks}")
            if prev_end is not None and ticks[0] <= prev_end:
                raise ValueError(f"segments 乱序或重叠: {sid} 起始 {ticks[0]} 应晚于前段末尾 {prev_end}")
            prev_end = ticks[-1]

    def _validate_gaps(self) -> None:
        if len(self.gaps) != len(self.segments) - 1:
            raise ValueError(
                f"gaps 数量 ({len(self.gaps)}) 必须等于 segments 数量减一 ({len(self.segments) - 1})"
            )
        for i, gap in enumerate(self.gaps):
            after, before, missing = gap["after"], gap["before"], gap["missing_count"]
            seg_a = self.segments[i]["ticks"][-1]
            seg_b = self.segments[i + 1]["ticks"][0]
            if not (after == seg_a and before == seg_b and missing == before - after - 1):
                raise ValueError(
                    f"gap[{i}] {gap} 与 segment 边界不符（应为 after={seg_a} before={seg_b} "
                    f"missing_count={before - seg_a - 1}）"
                )

    def to_json(self) -> str:
        """序列化为 JSON 字符串（字段顺序稳定，round-trip 一致）。"""
        return json.dumps(asdict(self), ensure_ascii=False, indent=2, sort_keys=False)

    @classmethod
    def from_json(cls, text: str) -> "DatasetManifest":
        """反序列化；可选字段（map_mode / protocol_version / bad_files）缺省兼容。"""
        data = json.loads(text)
        return cls(
            dataset_id=data["dataset_id"],
            source=data["source"],
            tenant_id=data["tenant_id"],
            segments=[dict(s) for s in data["segments"]],
            gaps=[dict(g) for g in data["gaps"]],
            inputs=dict(data["inputs"]),
            decision_config=dict(data["decision_config"]),
            config_hash=data["config_hash"],
            map_mode=data.get("map_mode", "disabled"),
            protocol_version=int(data.get("protocol_version", PROTOCOL_VERSION)),
            bad_files=list(data.get("bad_files", [])),
        )
