"""把 arena-hero skill 的内置英文文档（v0.10 契约）同步到项目 docs/。

skill 的 references 是从上游核对过的（2026-08-02 复核，与线上契约一致），
本项目直接引用，避免维护两副本。skill 更新后重跑本脚本即可。

game-rules.md 特殊处理：项目 docs 已手工升级到 v0.11（规则单源），skill bundle
仍为 v0.10。为避免永久 SKIP 造成静默分叉，改为按版本比较决定：skill 版本不落后
于 docs 时正常同步；docs 领先时保留 docs 并打印警告。
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_REFERENCES = ROOT / ".agents" / "skills" / "arena-hero" / "references"
DOCS = ROOT / "docs"

# references 中不需要进项目 docs 的（内部使用/生成源）
SKIP = {"openapi.yaml", "asyncapi.yaml"}

# game-rules.md 是项目手工维护的规则单源（v0.11），做版本比较而非无条件覆盖
RULES_FILE = "game-rules.md"


def _version(path: Path) -> str | None:
    """从文档首行解析版本号（如 'v0.11'）；解析失败返回 None。"""
    try:
        first_line = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
    except (OSError, IndexError):
        return None
    match = re.search(r"v0\.\d+", first_line)
    return match.group(0) if match else None


def _rules_should_sync(docs_version: str | None, skill_version: str | None) -> bool:
    """skill 版本不落后于 docs 时同步；docs 领先（手工升级）时保护 docs。"""
    if docs_version is None or skill_version is None:
        return False  # 版本无法解析 → 保守保护 docs
    return skill_version >= docs_version


def main() -> None:
    if not SKILL_REFERENCES.is_dir():
        print(f"错误：skill references 不存在：{SKILL_REFERENCES}", file=sys.stderr)
        sys.exit(1)
    DOCS.mkdir(exist_ok=True)
    copied = []
    skipped = []
    for src in sorted(SKILL_REFERENCES.iterdir()):
        if not src.is_file() or src.name in SKIP:
            continue
        if src.name == RULES_FILE:
            docs_rules = DOCS / RULES_FILE
            docs_ver = _version(docs_rules) if docs_rules.exists() else None
            skill_ver = _version(src)
            if not _rules_should_sync(docs_ver, skill_ver):
                skipped.append(
                    f"game-rules.md（docs={docs_ver or '?'} / skill={skill_ver or '?'}，"
                    "docs 领先，保留 docs 单源，请待 skill 更新）"
                )
                continue
        shutil.copy2(src, DOCS / src.name)
        copied.append(src.name)
    print(f"已同步 {len(copied)} 个文档到 docs/：")
    for name in copied:
        print(f"  {name}")
    if skipped:
        print(f"\n跳过 {len(skipped)} 个：")
        for name in skipped:
            print(f"  {name}")


if __name__ == "__main__":
    main()
