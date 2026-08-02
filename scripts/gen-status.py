"""生成 docs/generated/status.md：仓库状态权威数字（命令实测自动采集）。

背景：测试数 / commit SHA 曾手工维护在多份文档里导致漂移（架构评审 R1），
本脚本把这些数字统一为生成物。每次代码改动后重跑：

    python scripts/gen-status.py

status.md 是生成物，禁止手工编辑；各数字都标注来源命令，可追溯复算。
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
import sys
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
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f"{note} 无法执行：{exc}")
    if proc.returncode != 0:
        die(f"{note} 退出码 {proc.returncode}：{proc.stderr.strip()}")
    return proc.stdout.strip()


def count_test_calls(test_dir: Path) -> int:
    """统计 test('...') 用例数：'test(' 总数减去正则方法调用 '.test('（如 /re/i.test(x)）。"""
    if not test_dir.is_dir():
        die(f"测试目录不存在：{test_dir}")
    files = sorted(test_dir.glob("*.test.ts"))
    if not files:
        die(f"测试目录下没有 *.test.ts：{test_dir}")
    total = 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        total += text.count("test(") - text.count(".test(")
    return total


def count_files(directory: Path, pattern: str, note: str) -> int:
    if not directory.is_dir():
        die(f"{note}目录不存在：{directory}")
    hits = list(directory.rglob(pattern))
    return len(hits)


def main() -> None:
    # commit SHA
    commit_sha = sh(["git", "rev-parse", "HEAD"], "git rev-parse HEAD")

    # Python 测试数（uv run pytest collect-only，解析 "N tests collected"）
    pytest_out = sh(["uv", "run", "pytest", "tests/", "--collect-only", "-q"], "uv run pytest")
    m = re.search(r"(\d+) tests? collected", pytest_out)
    if not m:
        die("pytest 输出中找不到 'N tests collected'")
    py_tests = int(m.group(1))

    # TS 测试数 / 契约数 / Python 待退役模块数
    sdk_tests = count_test_calls(SDK_TEST_DIR)
    agent_tests = count_test_calls(AGENT_TEST_DIR)
    contracts = count_files(CONTRACTS_DIR, "*.schema.json", "contracts/generated")
    py_mods = count_files(PYTHON_MOD_DIR, "*.py", "src/arena_bot")

    rows = [
        ("commit SHA", commit_sha, "`git rev-parse HEAD`"),
        ("Python 测试数", py_tests, "`uv run pytest tests/ --collect-only -q`（解析 \"N tests collected\"）"),
        ("SDK 测试数", sdk_tests,
         "统计 `packages/arena-hero-ts/test/*.test.ts` 的 `test(` 调用（剔除 `.test(` 正则方法）"),
        ("编排层测试数", agent_tests,
         "统计 `packages/arena-agent/test/*.test.ts` 的 `test(` 调用（同上）"),
        ("schema 契约文件数", contracts,
         "`ls packages/arena-hero-ts/contracts/generated/*.schema.json` 计数"),
        ("Python 待退役模块数", py_mods, "`find src/arena_bot -name '*.py'` 计数"),
        ("生成时间", dt.datetime.now().astimezone().isoformat(timespec="seconds"),
         "`datetime.now().astimezone()`"),
    ]

    lines = [
        "# 仓库状态（自动生成）",
        "",
        "> 由 `scripts/gen-status.py` 生成，**禁止手工编辑**。每次代码改动后重跑：`python scripts/gen-status.py`。",
        "> 背景：测试数 / commit SHA 曾手工维护于多份文档导致漂移（架构评审 R1），本文件是这些数字的唯一权威来源。",
        "",
        "| 指标 | 数值 | 来源命令 |",
        "|---|---|---|",
    ]
    lines += [f"| {name} | {value} | {cmd} |" for name, value, cmd in rows]
    lines += ["", "数值与文档不一致时，以实测为准：先重跑本脚本，再修文档。"]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"已生成 {OUT.relative_to(ROOT)}")
    for name, value, _ in rows:
        print(f"  {name}: {value}")


if __name__ == "__main__":
    main()
