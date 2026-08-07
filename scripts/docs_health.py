"""docs/ 文档健康门禁：版本分叉、相对时间、坏链接、超大文件。

neat-freak 快速自检的脚本化。每次改动 docs 后运行：

    python scripts/docs_health.py          # 只读检查，输出问题清单
    python scripts/docs_health.py --check  # CI 门禁用：发现问题退出码 1

检查项：
1. 规则版本分叉：docs/game-rules.md 与 skill refs（.agents/.../references/game-rules.md）版本行是否一致。
   - skill 目录不存在（未安装）时跳过；docs 领先时告警（已知保护态，exit 0 但提示）；
   - skill 存在且版本落后 → fail（应同步）。
2. 相对时间：docs/ 里出现 今天/昨天/刚刚/最近/上周/today/yesterday/recently（除外：说明性用法白名单）。
3. 坏链接：docs 内相对 .md 链接指向不存在的文件。
4. 超大文件：单个 docs md 超过 1500 行 → 建议拆分（只告警，不 fail）。

设计约束：
- 只读扫描，不修改任何文件；
- archives/ 与 generated/ 不扫相对时间（历史与生成物豁免）；
- 版本比较用首行 "v0.d+" 正则（与 sync_docs.py 口径一致）。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _main_repo_root() -> Path:
    """Resolve the primary checkout root when running from a secondary Git worktree."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if proc.returncode == 0:
            common = Path(proc.stdout.strip())
            if not common.is_absolute():
                common = (ROOT / common).resolve()
            if common.name == ".git":
                return common.parent.resolve()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ROOT.resolve()


MAIN_REPO_ROOT = _main_repo_root()
DOCS = ROOT / "docs"
SKILL_RULES = ROOT / ".agents" / "skills" / "arena-hero" / "references" / "game-rules.md"
DOCS_RULES = DOCS / "game-rules.md"

# 不扫相对时间的目录（历史/生成物豁免）
TIME_EXEMPT = {DOCS / "archives", DOCS / "generated"}

RELATIVE_TIME_PATTERN = re.compile(
    r"今天|昨天|刚刚|最近|上周|today|yesterday|recently",
    re.IGNORECASE,
)

# 相对时间词出现在这些语境里是说明性用法（规则原文/协议术语），排除
TIME_ALLOWED_CONTEXT = ("规则原文", "today()", "recently()")

MAX_DOC_LINES = 1500

VERSION_PATTERN = re.compile(r"v0\.\d+")


def _version_of(path: Path) -> str | None:
    try:
        first_line = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
    except (OSError, IndexError):
        return None
    match = VERSION_PATTERN.search(first_line)
    return match.group(0) if match else None


def check_rules_version() -> list[str]:
    """docs 与 skill refs 的 game-rules 版本一致性。"""
    problems: list[str] = []
    if not SKILL_RULES.exists():
        # skill 未安装：docs 单源自身无分叉，跳过（不误报）
        return problems
    docs_ver = _version_of(DOCS_RULES)
    skill_ver = _version_of(SKILL_RULES)
    if docs_ver is None or skill_ver is None:
        problems.append(f"无法解析 game-rules 版本行（docs={docs_ver or '?'} / skill={skill_ver or '?'}）")
        return problems
    if docs_ver != skill_ver:
        if docs_ver > skill_ver:
            problems.append(
                f"规则版本分叉：docs/game-rules.md={docs_ver} 领先 skill refs={skill_ver}。"
                "运行 `python scripts/sync_docs.py`（docs 领先时保留 docs）或更新 skill bundle。"
            )
        else:
            problems.append(
                f"规则版本分叉：skill refs={skill_ver} 领先 docs={docs_ver}。"
                "docs 规则单源落后，运行 `python scripts/sync_docs.py` 同步。"
            )
    return problems


def check_relative_time() -> list[str]:
    """扫描 docs（除 archives/generated）中的相对时间词。"""
    problems: list[str] = []
    for path in sorted(DOCS.rglob("*.md")):
        if any(path.is_relative_to(dir) for dir in TIME_EXEMPT):
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for lineno, line in enumerate(lines, start=1):
            for match in RELATIVE_TIME_PATTERN.finditer(line):
                if any(ctx in line for ctx in TIME_ALLOWED_CONTEXT):
                    continue
                problems.append(
                    f"{path.relative_to(ROOT)}:{lineno} 相对时间「{match.group(0)}」→ 应改为绝对日期"
                )
    return problems


def check_broken_links() -> list[str]:
    """docs 内相对 .md 链接指向不存在的文件。"""
    problems: list[str] = []
    link_pattern = re.compile(r"\]\(([^)#]+\.md)(?:#[^)]*)?\)")
    for path in sorted(DOCS.rglob("*.md")):
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(content.splitlines(), start=1):
            for target in link_pattern.findall(line):
                target = target.strip()
                if not target or target.startswith("http"):
                    continue
                resolved = (path.parent / target).resolve()
                if resolved.exists():
                    continue
                # Secondary worktree 中，`../../docs/...` 这类协调根链接会错误落到
                # `.worktrees/docs/...`。将当前文档映射回主 clone 后再解析一次。
                if ROOT.resolve() != MAIN_REPO_ROOT:
                    main_copy = MAIN_REPO_ROOT / path.relative_to(ROOT)
                    remapped = (main_copy.parent / target).resolve()
                    if remapped.exists():
                        continue
                # GitHub standalone checkout 没有本地协调根；明确的 ../../docs/*
                # 是跨仓链接，CI 无法验证存在性，不应误报成 arena-ts 内部坏链接。
                if target.replace(chr(92), "/").startswith("../../docs/"):
                    continue
                problems.append(
                    f"{path.relative_to(ROOT)}:{lineno} 坏链接 → {target}（不存在）"
                )
    return problems


def check_oversized_docs() -> list[str]:
    """单个 docs md 超过 1500 行 → 建议拆分（仅提示）。"""
    problems: list[str] = []
    for path in sorted(DOCS.rglob("*.md")):
        try:
            line_count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
        except OSError:
            continue
        if line_count > MAX_DOC_LINES:
            problems.append(
                f"{path.relative_to(ROOT)}：{line_count} 行 > {MAX_DOC_LINES}，建议拆分"
            )
    return problems


def main() -> None:
    check_mode = "--check" in sys.argv
    all_problems: list[tuple[str, list[str]]] = [
        ("规则版本分叉", check_rules_version()),
        ("相对时间", check_relative_time()),
        ("坏链接", check_broken_links()),
        ("超大文档", check_oversized_docs()),
    ]

    total = sum(len(problems) for _, problems in all_problems)
    for name, problems in all_problems:
        if not problems:
            print(f"[OK] {name}")
            continue
        print(f"[FAIL] {name}（{len(problems)}）" if check_mode else f"[发现] {name}（{len(problems)}）")
        for problem in problems[:20]:
            print(f"  - {problem}")
        if len(problems) > 20:
            print(f"  ... 共 {len(problems)} 条")

    if total == 0:
        print("docs 健康检查通过")
        return

    if check_mode:
        print(f"\ndocs_health 发现 {total} 个问题，退出码 1", file=sys.stderr)
        sys.exit(1)
    print(f"\n共 {total} 个提示（--check 模式下为门禁失败）")


if __name__ == "__main__":
    main()

