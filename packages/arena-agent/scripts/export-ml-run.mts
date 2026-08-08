/**
 * M1b merged real-sample export CLI.
 *
 * Usage:
 *   node scripts/export-ml-run.mts <buildId> [--data-root <root>] [--dataset <id>]...
 *     [--require-decision-join] [--force]
 *
 * Output: <dataRoot>/runs/ml/<buildId>/{features-all.jsonl, train.jsonl,
 * validation.jsonl, test.jsonl, feature-quality.json, split-report.json,
 * manifest.json}.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { exportRealSamples } from "../src/offline-learning/export/real-sample-export.ts";

const args = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string[]>();
let current: string | null = null;
for (const arg of args) {
  if (arg.startsWith("--")) {
    current = arg;
    flags.set(arg, []);
  } else if (current !== null) {
    flags.get(current)!.push(arg);
  } else {
    positional.push(arg);
  }
}

const buildId = positional[0];
if (!buildId) {
  console.error("usage: node scripts/export-ml-run.mts <buildId> [--data-root <root>] [--dataset <id>]... [--force]");
  process.exitCode = 1;
} else {
  const dataRoot = flags.get("--data-root")?.[0]
    ?? process.env.ARENA_DATA_ROOT
    ?? resolve(import.meta.dirname, "..", "..", "..", "..", "data");
  if (!existsSync(dataRoot)) {
    console.error(`data root not found: ${dataRoot}`);
    process.exitCode = 1;
  } else {
    const result = exportRealSamples({
      dataRoot,
      buildId,
      datasetIds: flags.get("--dataset"),
      requireDecisionJoin: flags.has("--require-decision-join"),
      force: flags.has("--force"),
    });
    const counts = result.split.counts;
    console.log(
      `export-ml ${buildId}: total=${result.totalSamples} eligible=${result.eligibleSamples} ` +
        `failed=${result.failedSamples} dim=${result.quality.dimension} ` +
        `active=${result.quality.entries.filter((entry) => entry.active).length} ` +
        `constant=${result.quality.constantFeatures.length} ` +
        `nearConstant=${result.quality.nearConstantFeatures.length} ` +
        `splits=train:${counts.train.eligible}/val:${counts.validation.eligible}/` +
        `test:${counts.test.eligible} ` +
        `out=${result.buildDir}`,
    );
  }
}
