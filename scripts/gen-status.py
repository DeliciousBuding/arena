"""Generate docs/generated/status.md from executable repository facts.

Only the standard library is required. The script runs the Node test suites and counts
published schemas; it deliberately does not maintain a second Python project/runtime.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "generated" / "status.md"
SDK_PKG_DIR = ROOT / "packages" / "arena-hero-ts"
AGENT_PKG_DIR = ROOT / "packages" / "arena-agent"
SDK_TEST_DIR = SDK_PKG_DIR / "test"
AGENT_TEST_DIR = AGENT_PKG_DIR / "test"
CONTRACTS_DIR = SDK_PKG_DIR / "contracts" / "generated"
PYTHON_RUNTIME_DIR = ROOT / "src" / "arena_bot"


def die(message: str) -> None:
    print(f"错误：{message}", file=sys.stderr)
    raise SystemExit(1)


def run(cmd: list[str], note: str, cwd: Path = ROOT) -> str:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f"{note} 无法执行：{exc}")
    if proc.returncode != 0:
        die(f"{note} 退出码 {proc.returncode}：{proc.stderr.strip()}")
    return proc.stdout


def node_tap_counts(cmd: list[str], note: str, cwd: Path = ROOT) -> tuple[int, int, int, int]:
    output = run(cmd, note, cwd=cwd)
    def value(name: str) -> int:
        match = re.search(rf"^# {name} (\d+)", output, re.MULTILINE)
        if match is None:
            die(f"{note} 未找到 TAP 字段 # {name}")
        return int(match.group(1))
    tests = value("tests")
    failed = value("fail")
    # TAP 的 pass 计数不含 skipped；skipped 是显式跳过而非失败，跨平台（Windows/Linux
    # 有无 /proc 等差异）会产生不同的 pass/skip 拆分。为了 status.md 在 Windows 与
    # Ubuntu 上一致，pass 口径 = pass + skipped（= tests - fail）。
    skipped = value("skipped")
    passed = tests - failed
    return tests, passed, failed, skipped


def main() -> None:
    # 计数命令与各包 npm test 脚本同形（glob 由 node 展开、cwd = 包目录），
    # 保证 status.md 口径与标准门禁 `npm test` 一致（跨平台不因调用形式产生差异）。
    sdk_tests, sdk_passed, sdk_failed, _sdk_skipped = node_tap_counts(
        [
            "node",
            "--test",
            "--test-force-exit",
            "--test-reporter=tap",
            "test/*.test.ts",
        ],
        "SDK 测试",
        cwd=SDK_PKG_DIR,
    )
    # 与各包 npm test 脚本完全同形（tsx --test）——node --test 原生跑 .ts 的
    # 测试发现与 tsx 不一致（CI/本地/平台间计数漂移），必须走同一执行链。
    npx_bin = "npx.cmd" if os.name == "nt" else "npx"
    agent_tests, agent_passed, agent_failed, _agent_skipped = node_tap_counts(
        [
            npx_bin,
            "tsx",
            "--test",
            "test/*.test.ts",
        ],
        "编排层测试",
        cwd=AGENT_PKG_DIR,
    )
    schemas = len(list(CONTRACTS_DIR.glob("*.schema.json")))
    python_runtime_modules = (
        len(list(PYTHON_RUNTIME_DIR.rglob("*.py"))) if PYTHON_RUNTIME_DIR.is_dir() else 0
    )

    rows = [
        ("SDK 测试", f"{sdk_passed} pass / {sdk_failed} fail（共 {sdk_tests}）", "Node TAP 实跑"),
        ("编排层测试", f"{agent_passed} pass / {agent_failed} fail（共 {agent_tests}）", "Node TAP 实跑"),
        ("schema 契约文件数", str(schemas), "contracts/generated 计数"),
        ("Python 实时运行模块数", str(python_runtime_modules), "src/arena_bot/*.py 计数（目标 0）"),
    ]
    lines = [
        "# 仓库状态（自动生成）",
        "",
        "> 由 `scripts/gen-status.py` 生成，禁止手工编辑。",
        "> 测试数来自实际命令输出；瞬时 SHA 和生产运行事实属于 manifest/CI，不写入该自指生成物。",
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
    print(f"已生成 {OUT.relative_to(ROOT)}")
    for name, value, _ in rows:
        print(f"  {name}: {value}")


if __name__ == "__main__":
    main()
