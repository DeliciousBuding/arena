"""把 arena-hero skill 的内置英文文档（v0.10 契约）同步到项目 docs/。

skill 的 references 是从上游核对过的（2026-08-02 复核，与线上契约一致），
本项目直接引用，避免维护两副本。skill 更新后重跑本脚本即可。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKILL_REFERENCES = ROOT / ".agents" / "skills" / "arena-hero" / "references"
DOCS = ROOT / "docs"

# references 中不需要进项目 docs 的（内部使用/生成源）
SKIP = {"openapi.yaml", "asyncapi.yaml"}


def main() -> None:
    if not SKILL_REFERENCES.is_dir():
        print(f"错误：skill references 不存在：{SKILL_REFERENCES}", file=sys.stderr)
        sys.exit(1)
    DOCS.mkdir(exist_ok=True)
    copied = []
    for src in sorted(SKILL_REFERENCES.iterdir()):
        if not src.is_file() or src.name in SKIP:
            continue
        shutil.copy2(src, DOCS / src.name)
        copied.append(src.name)
    print(f"已同步 {len(copied)} 个文档到 docs/：")
    for name in copied:
        print(f"  {name}")


if __name__ == "__main__":
    main()
