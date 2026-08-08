#!/usr/bin/env node
/**
 * 测试计数 checker（W4）：全量测试总数只增不减。
 *
 * 检查内容：
 * 1. 以与 package.json 的 test 脚本同一 glob 运行 node --test（全量）；
 * 2. 解析运行器末尾汇总行（"# tests N" / "ℹ tests N"），得到测试总数；
 * 3. 断言总数 >= MIN_TEST_COUNT（基线 2026-08-09，测试数只增不减）。
 *
 * 用法：node scripts/check-test-count.mts [--min=N]
 *   --min=N 仅用于调试/反向验证时覆盖基线；CI 不传，走 MIN_TEST_COUNT。
 * 退出码：0 = 通过；1 = 失败（总数低于基线，或无法解析汇总）。
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "..");

/** 基线 2026-08-09（f09e7e7 后实测 1966，含全部 201 个 test 文件），
 *  测试数只增不减；低于此值门禁失败。注：3b7edf2 曾设 2037 与其提交说明
 *  "全量 1911/1912 pass" 矛盾（可能计入了未提交 WIP 测试），已修正。 */
const MIN_TEST_COUNT = 1966;

/** 与 package.json 的 test 脚本保持同一 glob 模式（node --test 自带 glob 展开）。 */
const TEST_GLOB = "test/**/*.test.ts";

interface TestSummary {
  total: number;
  failed: number;
}

/** 解析 node --test 汇总行：spec/tap reporter 末尾均为 "# tests N" / "ℹ tests N"。 */
function parseSummary(output: string): TestSummary {
  const summary: TestSummary = { total: -1, failed: 0 };
  const summaryLine = /^(?:#|ℹ)\s+(tests|fail)\s+(\d+)\s*$/;
  for (const line of output.split(/\r?\n/)) {
    const match = summaryLine.exec(line);
    if (match === null) {
      continue;
    }
    if (match[1] === "tests") {
      summary.total = Number(match[2]);
    } else {
      summary.failed = Number(match[2]);
    }
  }
  return summary;
}

const minArg = process.argv.find((arg) => arg.startsWith("--min="));
const minTestCount = minArg !== undefined ? Number(minArg.slice("--min=".length)) : MIN_TEST_COUNT;

const run = spawnSync(process.execPath, ["--test", TEST_GLOB], {
  cwd: PKG_ROOT,
  encoding: "utf8",
});

const rawOutput = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const summary = parseSummary(rawOutput);
if (summary.total < 0) {
  console.error(
    `test count check FAILED: cannot parse "# tests N" from node --test output (exit ${String(run.status)})`,
  );
  console.error(rawOutput.split(/\r?\n/).slice(-10).join("\n"));
  process.exit(1);
}

console.log(
  `test count: ${summary.total} total, ${summary.failed} failed (baseline >= ${minTestCount}; 基线 2026-08-09，测试数只增不减)`,
);
if (summary.failed > 0 || run.status !== 0) {
  console.error(
    `test count check FAILED: node --test reported ${summary.failed} failed (exit ${String(run.status)})`,
  );
  const failureTail = rawOutput.split(/\r?\n/).slice(-80).join("\n");
  console.error(failureTail);
  process.exit(1);
}
if (summary.total < minTestCount) {
  console.error(
    `test count check FAILED: ${summary.total} tests < baseline ${minTestCount}（测试数只增不减，见 scripts/check-test-count.mts）`,
  );
  process.exit(1);
}
process.exit(0);
