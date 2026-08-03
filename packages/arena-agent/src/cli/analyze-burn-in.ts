import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";

import {
  buildBurnInReport,
  DEFAULT_BURN_IN_THRESHOLDS,
  type BurnInThresholds,
} from "../analysis/burn-in-report.ts";
import type {
  DecisionTraceRecord,
  OutcomeTraceRecord,
  RuntimeTraceRecord,
} from "../telemetry/decision-trace.ts";

interface JsonRecord {
  readonly processRunId?: unknown;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string", short: "t" },
      run: { type: "string", short: "r" },
      runtime: { type: "string" },
      "live-ticks": { type: "string" },
      "startup-sync-ticks": { type: "string" },
      "outcome-drain-ticks": { type: "string" },
      "max-failed-rate": { type: "string" },
      "max-wait-ratio": { type: "string" },
      "max-p95-ms": { type: "string" },
      "no-economy-gate": { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  if (values.tenant === undefined || values.run === undefined) {
    console.error(
      "用法：analyze-burn-in --tenant=t1 --run=<processRunId> " +
        "[--live-ticks=100] [--startup-sync-ticks=1] [--json]",
    );
    process.exitCode = 2;
    return;
  }

  const runtimeBase = resolveRuntimeBase(values.runtime ?? "runtime");
  const telemetryDir = join(runtimeBase, values.tenant, "telemetry");
  const runtime = readRunRecords<RuntimeTraceRecord>(join(telemetryDir, "runtime.jsonl"), values.run);
  const decisions = readRunRecords<DecisionTraceRecord>(join(telemetryDir, "decision.jsonl"), values.run);
  const outcomes = readRunRecords<OutcomeTraceRecord>(join(telemetryDir, "outcome.jsonl"), values.run);
  if (runtime.length === 0 || decisions.length === 0) {
    throw new Error(`run ${values.run} 没有完整 runtime/decision telemetry（${telemetryDir}）`);
  }

  const thresholds: BurnInThresholds = {
    expectedLiveTicks: parseInteger(values["live-ticks"], DEFAULT_BURN_IN_THRESHOLDS.expectedLiveTicks, "--live-ticks", 1),
    expectedStartupSyncTicks: parseInteger(
      values["startup-sync-ticks"],
      DEFAULT_BURN_IN_THRESHOLDS.expectedStartupSyncTicks,
      "--startup-sync-ticks",
      0,
    ),
    expectedOutcomeDrainTicks: parseInteger(
      values["outcome-drain-ticks"],
      DEFAULT_BURN_IN_THRESHOLDS.expectedOutcomeDrainTicks,
      "--outcome-drain-ticks",
      0,
    ),
    maxFailedActionRate: parseNumber(
      values["max-failed-rate"],
      DEFAULT_BURN_IN_THRESHOLDS.maxFailedActionRate,
      "--max-failed-rate",
    ),
    maxWaitRatio: parseNumber(
      values["max-wait-ratio"],
      DEFAULT_BURN_IN_THRESHOLDS.maxWaitRatio,
      "--max-wait-ratio",
    ),
    maxSelectionP95Ms: parseNumber(
      values["max-p95-ms"],
      DEFAULT_BURN_IN_THRESHOLDS.maxSelectionP95Ms,
      "--max-p95-ms",
    ),
    requirePositiveEconomy: values["no-economy-gate"] !== true,
  };
  const report = buildBurnInReport(values.run, runtime, decisions, outcomes, thresholds);

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exitCode = report.passed ? 0 : 1;
}

function resolveRuntimeBase(value: string): string {
  return isAbsolute(value) ? value : join(process.cwd(), value);
}

function readRunRecords<T extends JsonRecord>(path: string, processRunId: string): T[] {
  if (!existsSync(path)) throw new Error(`telemetry 文件不存在：${path}`);
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${path}:${index + 1} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })
    .filter((record) => record.processRunId === processRunId);
}

function parseInteger(raw: string | undefined, fallback: number, name: string, minimum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} 必须是 >= ${minimum} 的整数，实际=${raw}`);
  }
  return value;
}

function parseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负有限数，实际=${raw}`);
  }
  return value;
}

function printHuman(report: ReturnType<typeof buildBurnInReport>): void {
  console.log(`Burn-in ${report.passed ? "PASS" : "FAIL"} — ${report.processRunId}`);
  console.log(
    `ticks=${report.observedTicks} live=${report.liveAttempts} accepted=${report.accepted} rejected=${report.rejected} ` +
      `sync=${report.startupSyncTicks} drain=${report.outcomeDrainTicks} ` +
      `outcomes=${report.outcomeRecords} repair=${report.repairTotal}`,
  );
  console.log(
    `economy: harvest=${report.harvestActions} deposit=${report.depositActions} ` +
      `coreDelta=${report.coreResourceDelta} visibleMax=${report.maxVisibleResourceCells}`,
  );
  console.log(
    `execution: failed=${report.failedEventCount} failedRate=${report.failedActionRate} ` +
      `waitRatio=${report.waitRatio} p95=${report.selectionP95Ms}ms`,
  );
  console.log(
    `exploration: meanUniqueWorkerCells=${report.meanUniqueWorkerCells} ` +
      `maxDistance=${report.maxWorkerDistanceFromCore}`,
  );
  for (const item of report.gates) {
    console.log(`[${item.pass ? "PASS" : "FAIL"}] ${item.name}: ${String(item.actual)} (${item.expected})`);
  }
}

try {
  main();
} catch (error) {
  console.error(`analyze-burn-in 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
