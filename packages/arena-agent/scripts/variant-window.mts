/**
 * 生产形态窗口评估 CLI（TS 化，替代 production-variant-window.py）：
 * 统计 t1/t2 最新 calibration run 上的变体触发窗口（敌情/威胁召回/清障/
 * move-failed），输出人类可读摘要与 JSON。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/variant-window.mts [--runtime <root>]
 * 默认 runtime 根 = 仓库根（runtime/ 目录），与校准数据落盘位置一致。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeVariantWindow } from "../src/sim/tools/variant-window.ts";

const runtimeRoot =
  process.argv.find((arg, index) => arg === "--runtime" && process.argv[index + 1] !== undefined)
    ? resolve(process.argv[process.argv.indexOf("--runtime") + 1])
    : resolve(import.meta.dirname, "..", "..", "..");

for (const tenant of ["t1", "t2"]) {
  const report = analyzeVariantWindow(runtimeRoot, tenant);
  const pct = (value: number): string => `${(100 * value).toFixed(2)}%`;
  const lines = [
    `${tenant}: ${report.caseCount} cases, ${report.ticks} ticks`,
    `  可见敌 UNIT tick 占比: ${pct(report.enemyVisibleRatio)}`,
    `  最近敌距 Core 分布（≤5/≤12/≤20/≤30/>30）: ` +
      `${report.minEnemyDistanceBuckets["5"]}/${report.minEnemyDistanceBuckets["12"]}/` +
      `${report.minEnemyDistanceBuckets["20"]}/${report.minEnemyDistanceBuckets["30"]}/` +
      `${report.minEnemyDistanceBuckets["31"]}`,
    `  [threat-recall 窗口] 敌距 Core ≤12 (ALERT): ${pct(report.alertWindowRatio)}`,
    `  [clear-path 窗口] 满载 worker 距敌 ≤2: ${pct(report.clearPathWindowRatio)}`,
    `  [move-failed 窗口] ${report.moveFailed.count}/${report.moveFailed.total} ` +
      `(${pct(report.moveFailed.ratio)})`,
  ];
  const text = lines.join("\n");
  console.log(text);
  writeFileSync(`variant-window-${tenant}.json`, JSON.stringify(report, null, 2) + "\n");
}
