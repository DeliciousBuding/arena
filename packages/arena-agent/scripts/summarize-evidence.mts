/**
 * M3（加分）: evidence-v1 汇总脚本——多份归档的横向对比表（版本 × 对手胜率矩阵）。
 *
 * 用法：npx tsx scripts/summarize-evidence.mts <目录|glob>
 *   - 目录：扫描其中所有 *.json（含 incompatible/ 子目录，标注来源）
 *   - glob：按模式匹配（node:fs globSync，相对当前工作目录）
 * 输出：Markdown 表格，行 = 归档（版本），列 = 参与者（对手）胜率 + Wilson 95% 区间。
 */
import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface SummaryRow {
  fileName: string;
  sourceDirectory: string;
  date: string;
  mode: string;
  rulesVersion: string;
  engineCommit: string;
  recommend: string;
  winRate: Record<string, number>;
  wilson95: Record<string, [number, number]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value)
    && Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value)
    && value.length === 2
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isWilsonMap(value: unknown): value is Record<string, [number, number]> {
  return isRecord(value) && Object.values(value).every(isNumberPair);
}

function parseArchiveFile(filePath: string, sourceDirectory: string): SummaryRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`警告：跳过无法解析的 ${basename(filePath)}：${(error as Error).message}`);
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const summary = parsed.summary;
  if (!isRecord(summary) || !isNumberMap(summary.winRate) || !isWilsonMap(summary.wilson95)) {
    console.warn(`警告：跳过缺少 summary.winRate/wilson95 的 ${basename(filePath)}`);
    return null;
  }
  const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
  return {
    fileName: basename(filePath),
    sourceDirectory,
    date: generatedAt.slice(0, 10) || "?",
    mode: typeof parsed.mode === "string" ? parsed.mode : "?",
    rulesVersion: typeof parsed.rulesVersion === "string" ? parsed.rulesVersion : "?",
    engineCommit: typeof parsed.engineCommit === "string" ? parsed.engineCommit.slice(0, 8) : "?",
    recommend: typeof parsed.recommend === "string" ? parsed.recommend : "?",
    winRate: summary.winRate,
    wilson95: summary.wilson95,
  };
}

function collectDirectory(directory: string, sourceDirectory: string, rows: SummaryRow[]): void {
  if (!existsSync(directory)) {
    return;
  }
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const row = parseArchiveFile(join(directory, entry), sourceDirectory);
    if (row !== null) {
      rows.push(row);
    }
  }
}

function collectRows(target: string): SummaryRow[] {
  const rows: SummaryRow[] = [];
  if (existsSync(target) && statSync(target).isDirectory()) {
    const root = resolve(target);
    collectDirectory(root, "docs/evidence", rows);
    collectDirectory(join(root, "incompatible"), "docs/evidence/incompatible", rows);
  } else {
    for (const matched of globSync(target)) {
      if (!matched.endsWith(".json")) {
        continue;
      }
      const row = parseArchiveFile(matched, dirname(matched));
      if (row !== null) {
        rows.push(row);
      }
    }
  }
  return rows;
}

function formatRate(row: SummaryRow, participantId: string): string {
  const rate = row.winRate[participantId];
  if (rate === undefined) {
    return "-";
  }
  const interval = row.wilson95[participantId];
  if (interval === undefined) {
    return rate.toFixed(3);
  }
  return `${rate.toFixed(3)} (${interval[0].toFixed(3)}-${interval[1].toFixed(3)})`;
}

function printTable(rows: SummaryRow[]): void {
  if (rows.length === 0) {
    console.log("未找到任何 evidence 归档。");
    return;
  }
  const participantIds = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row.winRate))),
  ).sort((a, b) => {
    const rank = (id: string): number => (id === "mine" ? 0 : id === "mine2" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const header = ["归档", "日期", "mode", "rulesVersion", "engine", "recommend", ...participantIds];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => {
      const cells = [
        row.fileName,
        row.date,
        row.mode,
        row.rulesVersion,
        row.engineCommit,
        row.recommend,
        ...participantIds.map((id) => formatRate(row, id)),
      ];
      return `| ${cells.join(" | ")} |`;
    }),
  ];
  console.log(lines.join("\n"));

  const modeCounts = new Map<string, number>();
  const recommendCounts = new Map<string, number>();
  for (const row of rows) {
    modeCounts.set(row.mode, (modeCounts.get(row.mode) ?? 0) + 1);
    recommendCounts.set(row.recommend, (recommendCounts.get(row.recommend) ?? 0) + 1);
  }
  const modeSummary = Array.from(modeCounts).map(([mode, count]) => `${mode}=${count}`).join(", ");
  const recommendSummary = Array.from(recommendCounts).map(([recommend, count]) => `${recommend}=${count}`).join(", ");
  console.log(`\n共 ${rows.length} 份归档；mode 分布：${modeSummary}；recommend 分布：${recommendSummary}`);
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    throw new Error("用法：npx tsx scripts/summarize-evidence.mts <目录|glob>");
  }
  printTable(collectRows(target));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
