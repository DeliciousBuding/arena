/**
 * Synthetic 对打数据管道（2026-08-07）：模拟器对打 episode → 官方格式
 * calibration case（含 opponentPlans=complete——model-ready 资格）。
 * 每 tick 为每个 tenant 生成一个 case（before/after 经 projectPlayerState
 * 投影为官方 PlayerState），manifest 严格格式（sha256 全链路）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/synthetic-case-gen.mts <scenario> <outDir> [ticks] [p2Posture] [p1MilitaryRatio] [p1AccumulateThreshold] [p1WorkerTarget]
 * 例：npx tsx scripts/synthetic-case-gen.mts scripts/scenarios/strike-group-exchange.json D:/x/syn-run 300 harvest 0 12 6
 * p2Posture 可选（默认 aggressive）——对手策略变体（balanced/harvest）；
 * p1MilitaryRatio 可选（默认 0）——我方军事产兵比例（>0 可产生完整
 * 战斗演化——补充兵力、推进拆家）；p1AccumulateThreshold 可选（默认
 * 0）——爆兵积累阈值（达标后持续产兵推进——终局拆家数据）；
 * p1WorkerTarget 可选（默认 4）——worker 目标（>初始数可激活采集经济）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runEpisode } from "../src/sim/harness/episode.ts";
import { projectPlayerState } from "../src/sim/visibility/visibility.ts";
import { privateEventsForPlayer } from "../src/sim/visibility/private-events.ts";
import { loadRulesManifest } from "../src/sim/contracts/rules-manifest.ts";
import { readGitSha } from "../src/app/run-manifest.ts";
import { sha256Canonical } from "../src/domain/integrity.ts";
import { parseCalibrationCase, type CalibrationCaseV1 } from "../src/sim/calibration/schema.ts";

const SCENARIO_PATH = process.argv[2];
const OUT_DIR = resolve(process.argv[3]);
const TICKS = Number(process.argv[4] ?? 60);
const P2_POSTURE = (process.argv[5] ?? "aggressive") as "aggressive" | "balanced" | "harvest";
const P1_MILITARY_RATIO = Number(process.argv[6] ?? 0);
const P1_ACCUMULATE_THRESHOLD = Number(process.argv[7] ?? 0);
const P1_WORKER_TARGET = Number(process.argv[8] ?? 4);
const RULES_PATH = "src/sim/contracts/rules-v0.14.json";
const RUNTIME_GOLDEN_SCHEMA = "runtime-golden-dataset-v1";

const scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"));
const rules = loadRulesManifest(RULES_PATH);
const seed = scenario.seed ?? 1;
const caseDir = join(OUT_DIR, "cases");
mkdirSync(caseDir, { recursive: true });

interface CaseEntry {
  caseId: string;
  tick: number;
  file: string;
  caseSha256: string;
  beforeSha256: string;
  planSha256: string;
  afterSha256: string;
  receipt: Record<string, unknown>;
}

const entriesByTenant = new Map<string, CaseEntry[]>();
const caseFiles: string[] = [];

const result = runEpisode({
  scenario: { ...scenario, seed },
  rulesPath: RULES_PATH,
  seed,
  ticks: TICKS,
  tenants: [
    {
      id: "p1",
      planner: "safety",
      policy: { posture: "aggressive", workerTarget: P1_WORKER_TARGET, militaryRatio: P1_MILITARY_RATIO, focusRegion: null, attackPriority: "core" },
      plannerConfig: {
        ...(P1_ACCUMULATE_THRESHOLD > 0 ? { accumulateThreshold: P1_ACCUMULATE_THRESHOLD } : {}),
      },
    },
    { id: "p2", planner: "safety", policy: { posture: P2_POSTURE, workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: P2_POSTURE === "aggressive" ? "core" : "balanced" } },
  ],
  onTickRecorded: ({ tick, before, after, plans, events }) => {
    for (const tenantId of ["p1", "p2"] as const) {
      const fileName = `${String(tick).padStart(10, "0")}-${tenantId}.json`;
      const beforeState = projectPlayerState(before, tenantId, rules);
      const afterState = projectPlayerState(
        after,
        tenantId,
        rules,
        privateEventsForPlayer(before, after, tenantId, events),
      );
      const plan = plans[tenantId];
      const opponentTenantId = tenantId === "p1" ? "p2" : "p1";
      const opponentPlan = plans[opponentTenantId];
      const caseObj: CalibrationCaseV1 = {
        schema: "sim-calibration-case-v1",
        caseId: `synthetic:${tenantId}:${tick}`,
        tenantId,
        rulesVersion: "v0.14",
        seed,
        metadata: {
          source: "fixture",
          opponentPlans: "complete",
          recordedAt: null,
          sourceCommit: null,
          runId: null,
        },
        before: { tick, state: beforeState },
        plan,
        opponentPlan,
        after: { tick: tick + 1, state: afterState },
      };
      // parse 规范化后写入/哈希（builder 的 integrity 校验用 parse 后形态）
      const normalized = parseCalibrationCase(caseObj);
      const filePath = join(caseDir, fileName);
      writeFileSync(filePath, JSON.stringify(normalized), "utf-8");
      caseFiles.push(fileName);
      const entry: CaseEntry = {
        caseId: normalized.caseId,
        tick,
        file: `cases/${fileName}`,
        caseSha256: sha256Canonical(normalized),
        beforeSha256: sha256Canonical(normalized.before),
        planSha256: sha256Canonical(normalized.plan),
        afterSha256: sha256Canonical(normalized.after),
        receipt: {},
      };
      const list = entriesByTenant.get(tenantId) ?? [];
      list.push(entry);
      entriesByTenant.set(tenantId, list);
    }
  },
});

// manifest（每 tenant 一个——dataset 构建按 tenant 消费）
const gitSha = readGitSha(resolve(".")) || "unknown";
const configHash = `sha256:${sha256Canonical(scenario)}`;
const now = new Date().toISOString();

for (const tenantId of ["p1", "p2"] as const) {
  const entries = entriesByTenant.get(tenantId) ?? [];
  const manifest = {
    schema: RUNTIME_GOLDEN_SCHEMA,
    datasetId: `synthetic-${scenario.name ?? "match"}-${tenantId}-${new Date().toISOString().slice(0, 10)}`,
    tenantId,
    rulesVersion: "v0.14",
    sourceCommit: gitSha,
    configHash,
    startedAt: now,
    completedAt: now,
    caseCount: entries.length,
    skippedRejected: 0,
    droppedPending: 0,
    errorCount: 0,
    cases: entries,
    errors: [],
  };
  writeFileSync(join(OUT_DIR, `manifest-${tenantId}.json`), JSON.stringify(manifest, null, 2), "utf-8");
}

console.log(`synthetic cases: ${caseFiles.length} (${TICKS} ticks × 2 tenants) → ${OUT_DIR}`);
console.log(`manifests: manifest-p1.json / manifest-p2.json（opponentPlans=complete——model-ready 资格）`);
console.log(`dataset 构建：npx tsx src/cli/run-sim.ts dataset --manifest <outDir>/manifest-p1.json --dataset-id <id>`);
