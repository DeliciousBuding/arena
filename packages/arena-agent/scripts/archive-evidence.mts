/**
 * M3: evidence-v1 归档脚本（模拟器对抗平台）
 *
 * 读取 --record-dir 的 manifest.json + summary.json，按 docs/design/evidence-v1.md
 * 契约校验 schema，合并为单文件归档到 docs/evidence/<YYYY-MM-DD>-<mode>-<commit8>.json，
 * 并追加一行到 docs/progress/LOG.md。
 *
 * 用法：npx tsx scripts/archive-evidence.mts <record-dir> [--doc-root <path>]
 *   --doc-root 可选，覆盖文档根（默认向上找含 docs/progress/LOG.md 的协调根），
 *   测试/冒烟用。
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 协调根 = 从本文件向上找第一个含 docs/progress/LOG.md 的目录（与 registry 同逻辑）。 */
function findDocRoot(from: string): string {
  let dir = from;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "docs", "progress", "LOG.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("doc root (docs/progress/LOG.md) not found");
}

const REPOSITORY_ROOT = findDocRoot(resolve(import.meta.dirname, ".."));
const SUPPORTED_MODES = ["matrix", "version-compare", "ffa"] as const;
type Mode = (typeof SUPPORTED_MODES)[number];
type Recommend = "promote" | "reject" | "hold" | "record";

interface EvidenceParticipant {
  id: string;
  desc: string;
  kind: string;
  source: string;
}

interface EvidenceRound {
  seed: number;
  winner: string | null;
  finalResources: Record<string, number>;
  finalPopulation: Record<string, number>;
  coreAlive: Record<string, boolean>;
}

interface EvidenceManifest {
  schema: string;
  generatedAt: string;
  rulesVersion: string;
  engineCommit: string;
  mode: Mode;
  refillEveryTicks: number;
  scenario: string;
  ticks: number;
  seeds: number[];
  participants: EvidenceParticipant[];
  rounds: EvidenceRound[];
}

interface EvidenceSummary {
  wins: Record<string, number>;
  winRate: Record<string, number>;
  wilson95: Record<string, [number, number]>;
  meanResources: Record<string, number>;
  underpowered?: boolean;
}

interface EvidenceRecord extends EvidenceManifest {
  summary: EvidenceSummary;
  recommend: Recommend;
}

export interface ArchiveResult {
  recordDir: string;
  fileName: string;
  archivePath: string;
  recommend: Recommend;
  comparable: boolean;
  logPath: string;
  logEntry: string;
  logSectionCreated: boolean;
}

export class EvidenceSchemaError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`evidence-v1 schema 校验失败：\n- ${issues.join("\n- ")}`);
    this.name = "EvidenceSchemaError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// schema 校验（evidence-v1.md：必填字段齐全、类型正确，缺失报错列出字段）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value)
    && Object.values(value).every(isFiniteNumber)
  );
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value)
    && value.length === 2
    && isFiniteNumber(value[0])
    && isFiniteNumber(value[1])
    && value[0] <= value[1]
  );
}

function isWilsonMap(value: unknown): value is Record<string, [number, number]> {
  return isRecord(value) && Object.values(value).every(isNumberPair);
}

function isBooleanMap(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "boolean");
}

function validateParticipant(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("participants 元素应为对象（{ id, desc, kind, source }）");
    return;
  }
  if (!isNonEmptyString(value.id)) {
    issues.push("participants 元素缺少非空字符串 id");
  }
  for (const field of ["desc", "kind", "source"] as const) {
    if (typeof value[field] !== "string") {
      issues.push(`participants[${String(value.id)}].${field} 应为字符串`);
    }
  }
}

function validateRound(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("rounds 元素应为对象（{ seed, winner, finalResources, finalPopulation, coreAlive }）");
    return;
  }
  if (!isFiniteNumber(value.seed)) {
    issues.push("rounds 元素缺少数字 seed");
  }
  if (!(typeof value.winner === "string" || value.winner === null)) {
    issues.push("rounds 元素 winner 应为字符串或 null");
  }
  if (!isNumberMap(value.finalResources)) {
    issues.push("rounds 元素 finalResources 应为 { id: number }");
  }
  if (!isNumberMap(value.finalPopulation)) {
    issues.push("rounds 元素 finalPopulation 应为 { id: number }");
  }
  if (!isBooleanMap(value.coreAlive)) {
    issues.push("rounds 元素 coreAlive 应为 { id: boolean }");
  }
}

function validateManifest(value: unknown, issues: string[]): asserts value is EvidenceManifest {
  if (!isRecord(value)) {
    issues.push("manifest 应为 JSON 对象");
    return;
  }
  if (value.schema !== "arena-ts/evidence/v1") {
    issues.push(`schema 应为 "arena-ts/evidence/v1"，实际 ${JSON.stringify(value.schema)}`);
  }
  if (!isNonEmptyString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt))) {
    issues.push("generatedAt 应为可解析的 ISO 时间字符串");
  }
  if (!isNonEmptyString(value.rulesVersion)) {
    issues.push("rulesVersion 应为非空字符串");
  }
  if (!isNonEmptyString(value.engineCommit) || !/^[0-9a-f]{7,40}$/i.test(value.engineCommit)) {
    issues.push("engineCommit 应为 git sha（7-40 位十六进制），实际 " + JSON.stringify(value.engineCommit));
  }
  if (!SUPPORTED_MODES.includes(value.mode as Mode)) {
    issues.push(`mode 应为 ${SUPPORTED_MODES.join(" | ")} 之一，实际 ${JSON.stringify(value.mode)}`);
  }
  if (!isPositiveInteger(value.refillEveryTicks)) {
    issues.push("refillEveryTicks 应为正整数");
  }
  if (!isNonEmptyString(value.scenario)) {
    issues.push("scenario 应为非空字符串");
  }
  if (!isPositiveInteger(value.ticks)) {
    issues.push("ticks 应为正整数");
  }
  if (
    !Array.isArray(value.seeds)
    || value.seeds.length === 0
    || !value.seeds.every(isPositiveInteger)
  ) {
    issues.push("seeds 应为非空正整数数组");
  }
  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    issues.push("participants 应为非空数组");
  } else {
    for (const participant of value.participants) {
      validateParticipant(participant, issues);
    }
  }
  if (!Array.isArray(value.rounds)) {
    issues.push("rounds 应为数组");
  } else {
    for (const round of value.rounds) {
      validateRound(round, issues);
    }
  }
}

function validateSummary(value: unknown, issues: string[]): asserts value is EvidenceSummary {
  if (!isRecord(value)) {
    issues.push("summary 应为 JSON 对象");
    return;
  }
  if (!isNumberMap(value.wins)) {
    issues.push("summary.wins 应为 { participantId: number }");
  }
  if (!isNumberMap(value.winRate)) {
    issues.push("summary.winRate 应为 { participantId: number }");
  }
  if (!isWilsonMap(value.wilson95)) {
    issues.push("summary.wilson95 应为 { participantId: [low, high] }");
  }
  if (!isNumberMap(value.meanResources)) {
    issues.push("summary.meanResources 应为 { participantId: number }");
  }
  if (value.underpowered !== undefined && typeof value.underpowered !== "boolean") {
    issues.push("summary.underpowered 应为布尔值（可选）");
  }
}

/**
 * 读取 record-dir 的 manifest.json + summary.json 并校验 evidence-v1 schema。
 * 校验失败抛 EvidenceSchemaError，错误信息列出全部缺失/类型错误字段。
 */
export async function loadAndValidateRecordDir(
  recordDir: string,
): Promise<{ manifest: EvidenceManifest; summary: EvidenceSummary }> {
  const issues: string[] = [];
  const manifestPath = join(recordDir, "manifest.json");
  const summaryPath = join(recordDir, "summary.json");

  let manifestValue: unknown = null;
  let summaryValue: unknown = null;
  if (!existsSync(manifestPath)) {
    issues.push("manifest.json 缺失");
  } else {
    try {
      manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      issues.push(`manifest.json 无法解析为 JSON：${(error as Error).message}`);
    }
  }
  if (!existsSync(summaryPath)) {
    issues.push("summary.json 缺失");
  } else {
    try {
      summaryValue = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch (error) {
      issues.push(`summary.json 无法解析为 JSON：${(error as Error).message}`);
    }
  }

  validateManifest(manifestValue, issues);
  validateSummary(summaryValue, issues);

  const manifest = manifestValue as EvidenceManifest | null;
  const summary = summaryValue as EvidenceSummary | null;

  if (manifest && summary) {
    if (manifest.mode === "version-compare") {
      const participantIds = manifest.participants.map((participant) => participant.id);
      for (const requiredId of ["mine", "mine2"]) {
        if (!participantIds.includes(requiredId)) {
          issues.push(`version-compare 要求 participants 包含 "${requiredId}"`);
        }
        if (!(requiredId in summary.winRate)) {
          issues.push(`version-compare 要求 summary.winRate 包含 "${requiredId}"`);
        }
        if (!(requiredId in summary.wilson95)) {
          issues.push(`version-compare 要求 summary.wilson95 包含 "${requiredId}"`);
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new EvidenceSchemaError(issues);
  }
  return { manifest: manifestValue as EvidenceManifest, summary: summaryValue as EvidenceSummary };
}

// ---------------------------------------------------------------------------
// recommend 判定（evidence-v1.md §统计约定）
// ---------------------------------------------------------------------------

export function computeRecommend(manifest: EvidenceManifest, summary: EvidenceSummary): Recommend {
  if (manifest.mode !== "version-compare") {
    return "record";
  }
  // 最低样本量门禁：seeds < 12（或 summary 显式标 underpowered）一律 hold，不论数字
  if (manifest.seeds.length < 12 || summary.underpowered === true) {
    return "hold";
  }
  const mineRate = summary.winRate.mine;
  const mineLower = summary.wilson95.mine[0];
  if (mineRate >= 0.5 && mineLower > 0.35) {
    return "promote";
  }
  const mine2Rate = summary.winRate.mine2;
  const mine2Lower = summary.wilson95.mine2[0];
  if (mine2Rate >= 0.5 && mine2Lower > 0.35) {
    return "reject";
  }
  // 有样本量但双方均无显著优势：维持现状
  return "hold";
}

// ---------------------------------------------------------------------------
// 归档 + LOG 追加
// ---------------------------------------------------------------------------

function formatWinRateSummary(summary: EvidenceSummary, mode: Mode): string {
  const ids = mode === "version-compare"
    ? ["mine", "mine2"]
    : Object.keys(summary.winRate).sort();
  return ids
    .map((id) => {
      const rate = summary.winRate[id];
      return rate === undefined ? `${id}=?` : `${id}=${Number(rate.toFixed(3))}`;
    })
    .join(" ");
}

function archiveDate(generatedAt: string): string {
  return new Date(generatedAt).toISOString().slice(0, 10);
}

function archiveFileName(manifest: EvidenceManifest): string {
  return `${archiveDate(manifest.generatedAt)}-${manifest.mode}-${manifest.engineCommit.slice(0, 8)}.json`;
}

function comparableWindowKey(manifest: EvidenceManifest): string {
  return `${manifest.rulesVersion}|${manifest.engineCommit.slice(0, 8)}`;
}

/** 扫描 docs/evidence/ 顶层已有归档的可比窗口（rulesVersion + engineCommit 前 8 位）。 */
async function collectExistingWindows(evidenceRoot: string): Promise<Set<string>> {
  const windows = new Set<string>();
  if (!existsSync(evidenceRoot)) {
    return windows;
  }
  for (const entry of await readdir(evidenceRoot)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const existing = JSON.parse(await readFile(join(evidenceRoot, entry), "utf8")) as Record<string, unknown>;
      if (isNonEmptyString(existing.rulesVersion) && isNonEmptyString(existing.engineCommit)) {
        windows.add(`${existing.rulesVersion}|${existing.engineCommit.slice(0, 8)}`);
      }
    } catch (error) {
      console.warn(`警告：跳过无法解析的既有归档 ${entry}：${(error as Error).message}`);
    }
  }
  return windows;
}

/** 追加一行到 docs/progress/LOG.md（已有当日日期段则直接加条目，否则新建日期段）。 */
async function appendLogEntry(
  logPath: string,
  entry: string,
  sectionDate: string,
): Promise<{ createdSection: boolean }> {
  const sectionHeader = `## ${sectionDate}`;
  const logDirectory = dirname(logPath);
  let content: string;
  let createdSection = false;

  if (!existsSync(logPath)) {
    content = `# 模拟器平台证据日志（LOG）\n\n${sectionHeader}\n\n${entry}\n`;
    createdSection = true;
  } else {
    const existing = await readFile(logPath, "utf8");
    const headingLines = existing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("## "));
    const lastHeading = headingLines.at(-1);
    if (lastHeading === sectionHeader) {
      // 尾部已是当日日期段：直接追加条目，不带日期头
      content = existing.endsWith("\n") ? existing + `${entry}\n` : existing + `\n${entry}\n`;
    } else {
      content = `${existing.replace(/\s+$/, "")}\n\n${sectionHeader}\n\n${entry}\n`;
      createdSection = true;
    }
  }

  await mkdir(logDirectory, { recursive: true });
  await writeFile(logPath, content);
  return { createdSection };
}

export interface ArchiveOptions {
  evidenceRoot: string;
  logPath: string;
}

/**
 * 校验 record-dir → 归档到 docs/evidence/（可比窗口不一致时进 incompatible/）→ 追加 LOG。
 * 所有路径显式传入，便于测试注入临时目录。
 */
export async function archiveEvidence(
  recordDir: string,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  const { manifest, summary } = await loadAndValidateRecordDir(recordDir);
  const recommend = computeRecommend(manifest, summary);
  const fileName = archiveFileName(manifest);
  const evidenceRoot = options.evidenceRoot;
  const logPath = options.logPath;

  const existingWindows = await collectExistingWindows(evidenceRoot);
  const comparable = existingWindows.size === 0 || existingWindows.has(comparableWindowKey(manifest));
  const targetDirectory = comparable ? evidenceRoot : join(evidenceRoot, "incompatible");
  const archivePath = join(targetDirectory, fileName);
  if (existsSync(archivePath)) {
    throw new Error(`归档已存在，拒绝覆盖：${archivePath}`);
  }

  const record: EvidenceRecord = { ...manifest, summary, recommend };
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(archivePath, JSON.stringify(record, null, 2) + "\n");

  const winRateSummary = formatWinRateSummary(summary, manifest.mode);
  const logEntry = `- evidence: ${fileName} ${manifest.mode} ${winRateSummary} recommend=${recommend}`;
  const { createdSection } = await appendLogEntry(logPath, logEntry, archiveDate(manifest.generatedAt));

  return {
    recordDir,
    fileName,
    archivePath,
    recommend,
    comparable,
    logPath,
    logEntry,
    logSectionCreated: createdSection,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv: string[]): { recordDir: string; docRoot: string } {
  const args = [...argv];
  const docRootIndex = args.indexOf("--doc-root");
  let docRoot = REPOSITORY_ROOT;
  if (docRootIndex >= 0) {
    const value = args[docRootIndex + 1];
    if (!value) {
      throw new Error("--doc-root 缺少路径参数");
    }
    docRoot = resolve(value);
    args.splice(docRootIndex, 2);
  }
  if (args.length !== 1) {
    throw new Error("用法：npx tsx scripts/archive-evidence.mts <record-dir> [--doc-root <path>]");
  }
  return { recordDir: resolve(args[0]), docRoot };
}

async function main(): Promise<void> {
  const { recordDir, docRoot } = parseCliArgs(process.argv.slice(2));
  const evidenceRoot = join(docRoot, "docs", "evidence");
  const logPath = join(docRoot, "docs", "progress", "LOG.md");

  const result = await archiveEvidence(recordDir, { evidenceRoot, logPath });
  const relativeArchivePath = resolve(result.archivePath).replace(process.cwd(), ".");
  const relativeLogPath = resolve(result.logPath).replace(process.cwd(), ".");
  console.log(`归档: ${relativeArchivePath} (recommend=${result.recommend}, ${result.comparable ? "可比窗口一致" : "可比窗口不一致，分桶 incompatible/"})`);
  console.log(`LOG: ${relativeLogPath} ← ${result.logEntry}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
