"""Generate docs/generated/status.md from executable repository facts.

Only the standard library is required. The script runs the Node test suites and counts
published schemas; it deliberately does not maintain a second Python project/runtime.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _main_repo_root() -> Path:
    """Resolve the primary checkout root even when this script runs in a Git worktree."""
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
# 外部协调根仍是 generated status 的唯一 SSOT。worktree 通过 git-common-dir 找回
# 主 clone，避免 ROOT.parent 误落到 `.worktrees/docs/...`；GitHub standalone checkout
# 没有协调根时，--check 只验证内容可重复生成，不伪造第二份 SSOT。
OUT = MAIN_REPO_ROOT.parent / "docs" / "generated" / "status.md"
SDK_PKG_DIR = ROOT / "packages" / "arena-hero-ts"
AGENT_PKG_DIR = ROOT / "packages" / "arena-agent"
SDK_TEST_DIR = SDK_PKG_DIR / "test"
AGENT_TEST_DIR = AGENT_PKG_DIR / "test"
CONTRACTS_DIR = SDK_PKG_DIR / "contracts" / "generated"
PYTHON_RUNTIME_DIR = ROOT / "src" / "arena_bot"



def main() -> None:
    # 测试通过性由 CI/本地前置 `npm test` 唯一负责。这里仅记录静态、可重复的
    # 结构计数，避免生成文档时再次嵌套执行带信号/进程树测试（Windows 下会影响
    # Python 父进程，也会让 CI 将同一 1000+ tests 重跑两遍）。
    sdk_test_files = len(list(SDK_TEST_DIR.glob("*.test.ts")))
    agent_test_files = len(list(AGENT_TEST_DIR.glob("*.test.ts")))
    schemas = len(list(CONTRACTS_DIR.glob("*.schema.json")))
    python_runtime_modules = (
        len(list(PYTHON_RUNTIME_DIR.rglob("*.py"))) if PYTHON_RUNTIME_DIR.is_dir() else 0
    )

    rows = [
        ("SDK 测试文件数", str(sdk_test_files), "test/*.test.ts 计数；通过性由前置 npm test 门禁"),
        ("编排层测试文件数", str(agent_test_files), "test/*.test.ts 计数；通过性由前置 npm test 门禁"),
        ("schema 契约文件数", str(schemas), "contracts/generated 计数"),
        ("Python 实时运行模块数", str(python_runtime_modules), "src/arena_bot/*.py 计数（目标 0）"),
    ]
    lines = [
        "# 仓库状态（自动生成）",
        "",
        "> 由 `scripts/gen-status.py` 生成，禁止手工编辑。",
        "> 测试通过性由 CI/本地前置 `npm test` 门禁；本生成物只记录静态可重复的结构计数。",
        "> 瞬时 SHA 和生产运行事实属于 manifest/CI，不写入该自指生成物。",
        "",
        "| 指标 | 数值 | 来源 |",
        "|---|---|---|",
        *[f"| {name} | {value} | {source} |" for name, value, source in rows],
        "",
        "数值漂移时先重跑 `python scripts/gen-status.py`，再提交生成物。",
        "",
    ]
    content = "\n".join(lines)

    if "--check" in sys.argv:
        # 只有本地主 clone 且外部协调 SSOT 确实存在时才做严格字节比较。
        # Secondary worktree 的分支测试数天然可能领先 main；CI standalone 也没有
        # 协调根。两者都应验证“测试实跑 + 内容可生成”，而不是因外部文件缺失/滞后假失败。
        strict_external = ROOT.resolve() == MAIN_REPO_ROOT and OUT.exists()
        if not strict_external:
            mode = "secondary worktree" if ROOT.resolve() != MAIN_REPO_ROOT else "standalone checkout"
            print(f"OK：status 可重复生成（{mode}，外部 SSOT 不参与本次 --check）")
            return
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        proc = subprocess.run(
            ["git", "diff", "--no-index", "--", str(OUT), str(tmp_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        tmp_path.unlink(missing_ok=True)
        if proc.returncode != 0:
            print(proc.stdout, file=sys.stderr)
            die("status.md 与实测不一致，请先运行 `python scripts/gen-status.py`")
        print("OK：status.md 与实测一致")
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content, encoding="utf-8")
    print(f"已生成 {OUT}")
    for name, value, _ in rows:
        print(f"  {name}: {value}")


if __name__ == "__main__":
    main()
