/**
 * 经济健康诊断 CLI（2026-08-08，economy-diagnostics 模块消费方）：
 * 读 outcome.jsonl 最近窗口 → 停滞判定 + 归因（核心迁移占比/卸货失败/勘探扩散）。
 *
 * 输出与 scripts/check-economy-stall.sh 兼容（首行 STALL:<t> / OK:<t> /
 * INSUFFICIENT_DATA:<t>），可被 watchdog/门禁直接替换调用。
 *
 * 用法：tsx scripts/check-economy-diagnostics.mts <data-root> <tenant> [window-ticks=60]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeEconomyHealth, type EconomyOutcomeRow } from "../src/intel/economy-diagnostics.ts";

function loadOutcomeRows(path: string, maxRows: number): EconomyOutcomeRow[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const out: EconomyOutcomeRow[] = [];
  for (const line of lines.slice(-maxRows)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.tick !== "number") continue;
      out.push({
        tick: parsed.tick,
        coreResourcesBefore: asNumber(parsed.coreResourcesBefore),
        coreResourcesAfter: asNumber(parsed.coreResourcesAfter),
        coreResourceDelta: asNumber(parsed.coreResourceDelta),
        coreState: typeof parsed.coreState === "string" ? parsed.coreState : undefined,
        workersWithCargo: asNumber(parsed.workersWithCargo),
        workerMaxDistanceFromCore: asNumber(parsed.workerMaxDistanceFromCore),
        events: Array.isArray(parsed.events) ? parsed.events.map(String) : undefined,
      });
    } catch {
      // 容错坏行（不阻断诊断）
    }
  }
  return out;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function main(): void {
  const [dataRoot, tenant, windowRaw] = process.argv.slice(2);
  if (!dataRoot || !tenant) {
    console.error("用法：check-economy-diagnostics.mts <data-root> <tenant> [window-ticks=60]");
    process.exit(2);
  }
  const windowTicks = Number(windowRaw ?? 60);
  const outcomePath = join(dataRoot, "runtime", tenant, "telemetry", "outcome.jsonl");
  const rows = loadOutcomeRows(outcomePath, Math.max(windowTicks, 60));
  const report = analyzeEconomyHealth(rows, tenant, windowTicks);

  const head = report.verdict === "stall"
    ? `STALL:${tenant}`
    : report.verdict === "insufficient_data"
      ? `INSUFFICIENT_DATA:${tenant}`
      : `OK:${tenant}`;
  console.log(head);
  console.log(
    `window=${report.rows} ticks=${report.firstTick ?? "-"}..${report.lastTick ?? "-"} ` +
    `resDelta=${report.resDeltaSum} deposit=${report.depositSucceeded} depositFailed=${report.depositFailed} ` +
    `harvest=${report.harvestSucceeded} maxCargoW=${report.maxCargoWorkers} ` +
    `coreMoving=${Math.round(report.coreMovingRatio * 100)}% maxDist=${report.maxDistFirst ?? "-"}→${report.maxDistLast ?? "-"}(${report.maxDistTrend})`,
  );
  for (const cause of report.causes) {
    console.log(`cause: ${cause}`);
  }
}

main();
