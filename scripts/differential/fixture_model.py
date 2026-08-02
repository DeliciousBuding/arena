"""Differential fixture 数据模型（纯 dataclass，无 I/O）。

W3 数据完整性层：DatasetManifest 描述一个脱敏、可复现、带完整性校验的
差分数据集。E1/E2 回放器消费本 manifest：
  - inputs[tick_str]["sha256"] == Differential Record v1 的 input_sha256
    （语义：脱敏后文件内容的 sha256，与 fixture 文件逐字节一致）
  - ticks 是有序 tick 列表（连续窗口，见 gaps 记录缺口）
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any

MAP_MODES = ("disabled", "frozen", "controlled")

PROTOCOL_VERSION = 1


@dataclass
class DatasetManifest:
    """差分数据集清单。

    Attributes:
        dataset_id: 数据集标识，如 burnin-20260802-a。
        source: 数据来源的相对描述（如 runs/<run_id>/raw-state），不写绝对路径。
        tenant_id: 租户标识（t1..t4）；扁平混合数据为 "unknown"。
        ticks: 有序 tick 列表（数据集实际包含的 tick）。
        gaps: source 跨度 [min_tick, max_tick] 内缺失的 tick（非连续缺口，
            显式进入 manifest，绝不静默）。
        inputs: tick(str) -> {"sha256": 脱敏后内容 sha256, "size": 字节数}。
        map_mode: "disabled" | "frozen" | "controlled"，默认 disabled。
        protocol_version: manifest 协议版本，当前 1。
        bad_files: source 中损坏（坏 JSON / 空文件 / 超限）的 tick 列表，
            观察性字段：窗口选择已排除它们，此处显式留档。
    """

    dataset_id: str
    source: str
    tenant_id: str
    ticks: list[int]
    gaps: list[int]
    inputs: dict[str, dict[str, Any]]
    map_mode: str = "disabled"
    protocol_version: int = PROTOCOL_VERSION
    bad_files: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.map_mode not in MAP_MODES:
            raise ValueError(f"map_mode 必须是 {MAP_MODES} 之一，得到 {self.map_mode!r}")

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
            ticks=list(data["ticks"]),
            gaps=list(data.get("gaps", [])),
            inputs=dict(data["inputs"]),
            map_mode=data.get("map_mode", "disabled"),
            protocol_version=int(data.get("protocol_version", PROTOCOL_VERSION)),
            bad_files=list(data.get("bad_files", [])),
        )
