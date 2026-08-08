/**
 * 迁移 KPI 遥测报告（migration-system-v1 §8，评审 P1 定稿）。
 *
 * 落盘 `data/runtime/migration/<tenant>-report.jsonl`（JSONL，append）。
 * 验收口径：
 * - `coreReceptiveRatio`（节奏指标，非"经济在线率"）；
 * - 经济真值用 grossDeposit（验收用 grossDeposit>0，不用 res 净增长≥1）；
 * - ETA 同时报 ideal（模型）与 observed（近 N 格实测外推）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MigrationReportRecord {
  readonly schema: "migration-report-v1";
  readonly tick: number;
  readonly tenant: string;
  readonly operationId: string | null;
  readonly phase: string;
  readonly burstCells: number | null;
  readonly settleTicks: number | null;
  readonly coreReceptiveRatio: number | null;
  /** 本窗口实际卸货量（grossDeposit>0 = 经济在线验收口径）。 */
  readonly grossDeposit: number | null;
  /** 本窗口资源采集量。 */
  readonly harvest: number | null;
  /** net = grossIncome - spawn/heal/repair spend（真值分析用，不作验收）。 */
  readonly net: number | null;
  readonly cellsRemaining: number | null;
  readonly idealEtaTicks: number | null;
  readonly observedEtaTicks: number | null;
  readonly observedCellsPerTick: number | null;
  readonly reasons: readonly string[];
  readonly updatedAt: string;
}

/** 标准报告文件路径：<dataRoot>/runtime/migration/<tenant>-report.jsonl */
export function migrationReportPath(dataRoot: string, tenant: string): string {
  return join(dataRoot, "runtime", "migration", `${tenant}-report.jsonl`);
}

/** 追加一条报告（幂等；目录自动创建；IO 失败向上抛由调用方兜底）。 */
export function appendMigrationReport(filePath: string, record: MigrationReportRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}
