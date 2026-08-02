"""W3 差分 fixture 构建器（CLI）。

从 burn-in raw-state 生成脱敏、可复现、带完整性校验的差分数据集。

核心原则（本片验收）：
  - 坏 JSON fail-fast：数据集绝不包含未通过完整性校验的文件。
  - 源数据损坏显式留档（stderr + manifest.bad_files），绝不静默跳过。
  - 同输入重复构建产物字节一致（脱敏确定性 + JSON 保序 dump）。

窗口选择语义：
  - --window N（默认 100）：优先取第一个 N 个连续 tick 且全部通过校验的窗口；
    含坏文件的窗口整体放弃，换下一个。
  - 显式指定 --window 时窗口大小是硬约束：无法满足 → 报错并 exit 1（不产任何产物）。
  - 默认 --window 时允许优雅降级：取最长的连续干净窗口，并向 stderr 输出显式警告。

用法：
  uv run python scripts/differential/fixture_builder.py \
      --source runs/<run_id>/raw-state --dataset <id> --tenant auto \
      --out fixtures/differential/<dataset> [--map-mode disabled]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
from pathlib import Path
from typing import Any

# 脚本直跑时（python scripts/.../fixture_builder.py）sys.path[0] 是脚本目录，
# 需把仓库根补进 sys.path 才能 import scripts.differential 包。
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.differential.fixture_model import MAP_MODES, DatasetManifest

TENANTS = ("auto", "t1", "t2", "t3", "t4")

MAX_TICK_BYTES = 1_000_000
OWNER_FIELD = "owner_username"
OWNER_PLACEHOLDER = "fixture_user"
REDACTED = "[REDACTED]"

# 真实账号名：按长度降序替换，避免子串互吞（deliciousbuding 含 buding 等）。
ACCOUNT_NAMES = ("deliciousbuding", "delicious23333", "delicious233", "delicious", "buding")
LOCAL_PATHS = ("D:/", "C:/", "D:\\", "C:\\")

TICK_RE = re.compile(r"^(\d+)\.json$")


class FixtureBuildError(Exception):
    """构建不可继续的确定性错误（fail-fast）。"""


# ---------------------------------------------------------------- 数据发现

def resolve_tenant_dir(source: Path, tenant: str) -> tuple[Path, str]:
    """解析实际数据目录与 tenant_id。

    - --tenant auto：source 下有子目录（新租户格式）取第一个；扁平格式直接读。
    - --tenant tN：读 <source>/tN/（不存在则 fallback 扁平）。
    扁平数据无法确定租户 → tenant_id "unknown"。
    """
    subdirs = sorted(p for p in source.iterdir() if p.is_dir()) if source.is_dir() else []
    if tenant != "auto":
        if tenant in ("t1", "t2", "t3", "t4") and (source / tenant).is_dir():
            return source / tenant, tenant
        if subdirs:
            raise FixtureBuildError(
                f"--tenant {tenant} 但 {source} 下无 {tenant}/ 子目录（存在 {[d.name for d in subdirs]}）"
            )
        print(f"警告: {source}/{tenant} 不存在，fallback 扁平格式（tenant_id={tenant}）", file=sys.stderr)
        return source, tenant
    if subdirs:
        return source / subdirs[0].name, subdirs[0].name
    return source, "unknown"


def discover_ticks(source_dir: Path) -> dict[int, Path]:
    """扫描 tick 文件：文件名必须为 <int>.json；其他文件一律报错（fail-fast，不静默忽略）。"""
    ticks: dict[int, Path] = {}
    stray: list[str] = []
    for p in sorted(source_dir.iterdir()):
        if p.is_dir():
            continue
        m = TICK_RE.match(p.name)
        if not m:
            stray.append(p.name)
            continue
        tick = int(m.group(1))
        if tick in ticks:
            raise FixtureBuildError(f"重复 tick {tick}: {ticks[tick]} 与 {p}")
        ticks[tick] = p
    if stray:
        raise FixtureBuildError(
            f"存在非 tick 文件（禁止静默忽略）: {', '.join(sorted(stray))}（目录: {source_dir}）"
        )
    return ticks


# ---------------------------------------------------------------- 完整性校验（fail-fast）

def validate_tick_files(ticks: dict[int, Path]) -> list[tuple[int, Path, str]]:
    """全量校验每个 tick 文件：坏 JSON / 0 字节 / >1MB 均记录原因。

    不在此处 exit：错误清单交给调用方统一输出（坏文件由窗口选择逻辑处理，
    属于显式数据选择，不是静默跳过）。
    """
    errors: list[tuple[int, Path, str]] = []
    for tick in sorted(ticks):
        p = ticks[tick]
        data = p.read_bytes()
        if len(data) == 0:
            errors.append((tick, p, "文件为空 (0 字节)"))
            continue
        if len(data) > MAX_TICK_BYTES:
            errors.append((tick, p, f"文件过大 ({len(data)} 字节 > {MAX_TICK_BYTES})"))
            continue
        try:
            json.loads(data.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 —— 坏 JSON 的原因要完整上报
            errors.append((tick, p, f"JSON 解析失败: {type(exc).__name__}: {exc}"))
    return errors


def print_bad_files(errors: list[tuple[int, Path, str]]) -> None:
    print(f"[FAIL-FAST] 完整性校验发现 {len(errors)} 个损坏文件（全部列出，窗口选择将排除它们）:",
          file=sys.stderr)
    for tick, p, reason in errors:
        print(f"  [tick {tick}] {p}: {reason}", file=sys.stderr)


# ---------------------------------------------------------------- 窗口选择

def select_window(valid_ticks: list[int], window: int, hard: bool) -> tuple[list[int], str]:
    """选取窗口：第一个长度 >= window 的连续干净段取前 window 个；
    无则 hard 时报错 / 降级取最长连续段（带显式警告）。
    """
    runs: list[list[int]] = []
    cur = [valid_ticks[0]]
    for t in valid_ticks[1:]:
        if t == cur[-1] + 1:
            cur.append(t)
        else:
            runs.append(cur)
            cur = [t]
    runs.append(cur)

    for run in runs:
        if len(run) >= window:
            chosen = run[:window]
            return chosen, f"窗口 [{chosen[0]}..{chosen[-1]}] 共 {len(chosen)} ticks"

    longest = max(runs, key=len)
    if hard:
        raise FixtureBuildError(
            f"请求窗口 {window} 无法满足：最大连续干净窗口仅 {len(longest)}"
            f"（[{longest[0]}..{longest[-1]}]）。已检测到坏文件，不产出任何产物。"
        )
    print(
        f"警告: 请求窗口 {window} 未满足（最大连续干净窗口 {len(longest)}，"
        f"[{longest[0]}..{longest[-1]}]），降级取最长连续干净窗口 —— 这是显式数据选择，不是静默跳过。",
        file=sys.stderr,
    )
    return longest, f"窗口 [{longest[0]}..{longest[-1]}] 共 {len(longest)} ticks（降级）"


def compute_gaps(ticks: list[int]) -> list[int]:
    """source 跨度 [min, max] 内缺失的 tick 号（非连续缺口，显式进 manifest）。"""
    if len(ticks) < 2:
        return []
    lo, hi = ticks[0], ticks[-1]
    present = set(ticks)
    return [t for t in range(lo, hi + 1) if t not in present]


# ---------------------------------------------------------------- 脱敏（确定性）

def redact_string(text: str) -> str:
    for name in sorted(ACCOUNT_NAMES, key=len, reverse=True):
        text = text.replace(name, REDACTED)
    for path in LOCAL_PATHS:
        text = text.replace(path, REDACTED)
    return text


def sanitize_value(value: Any) -> Any:
    """递归脱敏：owner_username -> fixture_user；字符串清理账号名与本机路径。"""
    if isinstance(value, dict):
        return {k: (OWNER_PLACEHOLDER if k == OWNER_FIELD else sanitize_value(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_value(v) for v in value]
    if isinstance(value, str):
        return redact_string(value)
    return value


# ---------------------------------------------------------------- 输出

def relative_source(source: Path) -> str:
    """manifest.source：相对描述（runs/<run_id>/raw-state），绝不写绝对路径。

    路径含 runs/ 段时取该段起；否则退化为目录名（如测试的 tmp raw-state）。
    """
    norm = posixpath.normpath(str(source).replace("\\", "/"))
    idx = norm.rfind("runs/")
    return norm[idx:] if idx >= 0 else posixpath.basename(norm.rstrip("/"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 主流程

def run(
    source: Path,
    dataset: str,
    tenant: str,
    map_mode: str,
    window: int,
    hard_window: bool,
) -> tuple[DatasetManifest, dict[int, bytes]]:
    """执行一次构建，返回 (manifest, payloads)。

    payloads: tick -> 脱敏后字节（sha256 与之逐字节一致，写盘由调用方完成）。
    任何 FixtureBuildError 都不会产出产物（fail-fast）。
    """
    src_dir, tenant_id = resolve_tenant_dir(source, tenant)
    print(f"数据源: {src_dir}（tenant_id={tenant_id}）")

    ticks = discover_ticks(src_dir)
    if not ticks:
        raise FixtureBuildError(f"source 目录无任何 tick 文件: {src_dir}")

    errors = validate_tick_files(ticks)
    if errors:
        print_bad_files(errors)
    ordered = sorted(ticks)
    bad_set = {t for t, _p, _r in errors}
    good_ordered = [t for t in ordered if t not in bad_set]
    if not good_ordered:
        raise FixtureBuildError("所有 tick 文件均未通过完整性校验，无法构建")
    chosen, note = select_window(good_ordered, window, hard=hard_window)
    gaps = compute_gaps(ordered)
    bad_ticks = [t for t, _p, _r in errors]

    inputs: dict[str, dict[str, Any]] = {}
    payloads: dict[int, bytes] = {}
    for tick in chosen:
        raw = json.loads(ticks[tick].read_text(encoding="utf-8"))
        data = json.dumps(sanitize_value(raw), ensure_ascii=False).encode("utf-8")
        payloads[tick] = data
        inputs[str(tick)] = {"sha256": sha256_bytes(data), "size": len(data)}

    manifest = DatasetManifest(
        dataset_id=dataset,
        source=relative_source(src_dir),
        tenant_id=tenant_id,
        ticks=chosen,
        gaps=gaps,
        inputs=inputs,
        map_mode=map_mode,
        bad_files=bad_ticks,
    )
    print(note)
    print(f"缺口(gaps): {gaps}（{len(gaps)} 个）  坏文件(bad_files): {len(bad_ticks)} 个 → 已写入 manifest")
    return manifest, payloads


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="fixture_builder",
        description="W3 差分 fixture 构建器：raw-state → 脱敏差分数据集 + manifest（fail-fast）。",
    )
    parser.add_argument("--source", required=True, type=Path, help="raw-state 目录")
    parser.add_argument("--dataset", required=True, help="数据集 id，如 burnin-20260802-a")
    parser.add_argument("--tenant", choices=TENANTS, default="auto",
                        help="租户（t1..t4 或 auto；auto 时取租户子目录第一个/扁平）")
    parser.add_argument("--out", required=True, type=Path, help="输出目录 fixtures/differential/<dataset>")
    parser.add_argument("--map-mode", choices=MAP_MODES, default="disabled",
                        help="map 模式（默认 disabled，第一版只做 Tenant-local parity）")
    parser.add_argument("--window", type=int, default=100,
                        help="期望连续 tick 窗口大小（默认 100）。与 --exact 配合时是硬约束")
    parser.add_argument("--exact", action="store_true",
                        help="窗口大小是硬约束：--window 无法满足则 exit 1（默认允许降级为最长连续干净窗口）")
    args = parser.parse_args(argv)

    if args.window <= 0:
        parser.error("--window 必须 >= 1")

    try:
        manifest, payloads = run(
            source=args.source,
            dataset=args.dataset,
            tenant=args.tenant,
            map_mode=args.map_mode,
            window=args.window,
            hard_window=args.exact,
        )
    except FixtureBuildError as exc:
        print(f"构建失败（不产出任何产物）: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    for tick, data in payloads.items():
        (out_dir / f"{tick}.json").write_bytes(data)
    (out_dir / "manifest.json").write_bytes(manifest.to_json().encode("utf-8"))

    print(f"完成: {len(manifest.ticks)} 个脱敏 tick + manifest.json → {out_dir}")
    print(f"dataset={manifest.dataset_id} source={manifest.source} tenant={manifest.tenant_id} "
          f"map_mode={manifest.map_mode} protocol_version={manifest.protocol_version}")


if __name__ == "__main__":
    main()
