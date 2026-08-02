"""生成 docs/generated/status.md：仓库状态权威数字（命令实测自动采集）。

背景：测试数 / commit SHA 曾手工维护在多份文档里导致漂移（架构评审 R1），
本脚本把这些数字统一为生成物。每次代码改动后重跑：

    python scripts/gen-status.py            # 生成并覆盖 status.md
    python scripts/gen-status.py --check    # 生成到临时文件并 diff（CI 门禁用）

status.md 是生成物，禁止手工编辑；各数字都标注来源命令，可追溯复算。

设计约束（2026-08-02 切片 1.1）：
- 不写 commit SHA 与生成时间——生成文件本身一提交 HEAD 就变，写 SHA 必然过期（自指）。
  SHA / 实际通过数等瞬时事实属于运行 manifest 与 CI summary，不落 status 文件。
- 测试数从**实际执行输出**解析（pytest 文本 / node TAP），不统计源码里的 `test(` 文本。
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "generated" / "status.md"
SDK_TEST_DIR = ROOT / "packages" / "arena-hero-ts" / "test"
AGENT_TEST_DIR = ROOT / "packages" / "arena-agent" / "test"
CONTRACTS_DIR = ROOT / "packages" / "arena-hero-ts" / "contracts" / "generated"
PYTHON_MOD_DIR = ROOT / "src" / "arena_bot"


def die(msg: str) -> None:
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


def sh(cmd: list[str], note: str) -> str:
    """在仓库根执行命令，返回去首尾空白的 stdout；失败时给出可读错误。"""
    try:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f"{note} 无法执行：{exc}")
    if proc.returncode != 0:
        die(f"{note} 退出码 {proc.returncode}：{proc.stderr.strip()}")
    return proc.stdout.strip()


def pytest_counts() -> tuple[int, int, int]:
    """实际跑 pytest，解析 passed/failed/skipped（非 collect-only）。"""
    out = sh(["uv", "run", "pytest", "tests/", "-q"], "uv run pytest tests/ -q")
    passed = int(re.search(r"(\d+) passed", out).group(1) if re.search(r"(\d+) passed", out) else 0)
    failed = int(re.search(r"(\d+) failed", out).group(1) if re.search(r"(\d+) failed", out) else 0)
    skipped = int(re.search(r"(\d+) skipped", out).group(1) if re.search(r"(\d+) skipped", out) else 0)
    return passed, failed, skipped


def node_tap_counts(cmd: list[str], note: str) -> tuple[int, int, int]:
    """跑 node:test（TAP reporter），解析 # tests / # pass / # fail。"""
    out = sh(cmd, note)
    tests = int(re.search(r"^# tests (\d+)", out, re.M).group(1))
    passed = int(re.search(r"^# pass (\d+)", out, re.M).group(1))
    failed = int(re.search(r"^# fail (\d+)", out, re.M).group(1))
    return tests, passed, failed


def count_files(directory: Path, pattern: str, note: str) -> int:
    if not directory.is_dir():
        die(f"{note}目录不存在：{directory}")
    return len(list(directory.rglob(pattern)))


def main() -> None:
    check_mode = "--check" in sys.argv

    # 实际执行解析测试数（非源码统计）
    py_passed, py_failed, py_skipped = pytest_counts()
    sdk_tests, sdk_passed, sdk_failed = node_tap_counts(
        ["node", "--experimental-transform-types", "--test", "--test-reporter=tap",
         *[str(p) for p in sorted(SDK_TEST_DIR.glob("*.test.ts"))]],
        "SDK 测试",
    )
    agent_tests, agent_passed, agent_failed = node_tap_counts(
        [("npx.cmd" if sys.platform == "win32" else "npx"), "tsx", "--test", "--test-reporter=tap",
         *[str(p) for p in sorted(AGENT_TEST_DIR.glob("*.test.ts"))]],
        "编排层测试",
    )
    contracts = count_files(CONTRACTS_DIR, "*.schema.json", "contracts/generated")
    py_mods = count_files(PYTHON_MOD_DIR, "*.py", "src/arena_bot")

    rows = [
        ("Python 测试", f"{py_passed} passed / {py_failed} failed / {py_skipped} skipped",
         "`uv run pytest tests/ -q`（实际执行输出解析）"),
        ("SDK 测试", f"{sdk_passed} pass / {sdk_failed} fail（共 {sdk_tests}）",
         "`node --experimental-transform-types --test --test-reporter=tap test/*.test.ts`"),
        ("编排层测试", f"{agent_passed} pass / {agent_failed} fail（共 {agent_tests}）",
         "`npx tsx --test --test-reporter=tap test/*.test.ts`"),
        ("schema 契约文件数", contracts,
         "`ls packages/arena-hero-ts/contracts/generated/*.schema.json` 计数"),
        ("Python 待退役模块数", py_mods, "`find src/arena_bot -name '*.py'` 计数"),
    ]

    lines = [
        "# 仓库状态（自动生成）",
        "",
        "> 由 `scripts/gen-status.py` 生成，**禁止手工编辑**。每次代码改动后重跑：`python scripts/gen-status.py`。",
        "> 背景：测试数曾手工维护于多份文档导致漂移（架构评审 R1），本文件是这些数字的唯一权威来源。",
        "> 注：本文件不含 commit SHA 与生成时间（生成物自身提交会使 SHA 过期，属自指）；瞬时事实见运行 manifest 与 CI。",
        "",
        "| 指标 | 数值 | 来源命令 |",
        "|---|---|---|",
    ]
    lines += [f"| {name} | {value} | {cmd} |" for name, value, cmd in rows]
    lines += ["", "数值与文档不一致时，以实测为准：先重跑本脚本，再修文档。"]

    content = "\n".join(lines) + "\n"

    if check_mode:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        proc = subprocess.run(
            ["git", "diff", "--no-index", "--", str(OUT), str(tmp_path)],
            cwd=ROOT, capture_output=True, text=True,
        )
        tmp_path.unlink()
        if proc.returncode != 0:
            print(proc.stdout, file=sys.stderr)
            die("status.md 与当前实测不一致——请重跑 `python scripts/gen-status.py` 后提交")
        print("OK：status.md 与实测一致")
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(content, encoding="utf-8")
    print(f"已生成 {OUT.relative_to(ROOT)}")
    for name, value, _ in rows:
        print(f"  {name}: {value}")


if __name__ == "__main__":
    main()
