/**
 * Synthetic 对打数据管道（2026-08-07）：模拟器对打 episode → 官方格式
 * calibration case（含 opponentPlans=complete——model-ready 资格）。
 * 每 tick 为每个 tenant 生成一个 case（before/after 经 projectPlayerState
 * 投影为官方 PlayerState），manifest 严格格式（sha256 全链路）。
 * 2026-08-07 泛化：租户列表由 scenario players 推导（支持 N>2 世界）；
 * N=2 世界用 opponentPlan 字段（向后兼容），N>2 世界用 opponents 字段
 * （每名对手 plan + unitIds 归属——投影不携带敌方单位 owner 身份）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/synthetic-case-gen.mts <scenario> <outDir> [ticks] [p2Posture] [p1MilitaryRatio] [p1AccumulateThreshold] [p1WorkerTarget] [p1AttackForce]
 * 例：npx tsx scripts/synthetic-case-gen.mts scripts/scenarios/three-way.json D:/x/syn-run3 120 harvest 0 0 4 0
 * p2Posture 可选（默认 aggressive）——非首位玩家策略变体（balanced/harvest）；
 * p1MilitaryRatio 可选（默认 0）——首位玩家军事产兵比例（>0 可产生完整
 * 战斗演化——补充兵力、推进拆家）；
 * p1AccumulateThreshold 可选（默认 0）——爆兵积累阈值（达标后持续产兵推进）；
 * p1WorkerTarget 可选（默认 4）——首位玩家 worker 目标（>初始数可激活采集经济）；
 * p1AttackForce 可选（默认 0）——爆兵蓄势门槛（军事规模达标再前压）。
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
const P1_ATTACK_FORCE = Number(process.argv[9] ?? 0);
const RULES_PATH = "src/sim/contracts/rules-v0.14.json";
const RUNTIME_GOLDEN_SCHEMA = "runtime-golden-dataset-v1";

const scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"));
const playerIds: string[] = (scenario.players ?? []).map(
  (player: { id: string }) => player.id,
);
if (playerIds.length < 2) {
  throw new Error(`scenario must have >=2 players, got ${playerIds.join(",")}`);
}
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

const [firstPlayerId, ...otherPlayerIds] = playerIds;
const tenants = [
  {
    id: firstPlayerId,
    planner: "safety" as const,
    policy: { posture: "aggressive", workerTarget: P1_WORKER_TARGET, militaryRatio: P1_MILITARY_RATIO, focusRegion: null, attackPriority: "core" },
    plannerConfig: {
      ...(P1_ACCUMULATE_THRESHOLD > 0 ? { accumulateThreshold: P1_ACCUMULATE_THRESHOLD } : {}),
      ...(P1_ATTACK_FORCE > 0 ? { attackForce: P1_ATTACK_FORCE } : {}),
    },
  },
  ...otherPlayerIds.map((id) => ({
    id,
    planner: "safety" as const,
    policy: { posture: P2_POSTURE, workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: P2_POSTURE === "aggressive" ? "core" : "balanced" },
  })),
];

const result = runEpisode({
  scenario: { ...scenario, seed },
  rulesPath: RULES_PATH,
  seed,
  ticks: TICKS,
  tenants,
  onTickRecorded: ({ tick, before, after, plans, events }) => {
    for (const tenantId of playerIds) {
      const fileName = `${String(tick).padStart(10, "0")}-${tenantId}.json`;
      const beforeState = projectPlayerState(before, tenantId, rules);
      const afterState = projectPlayerState(
        after,
        tenantId,
        rules,
        privateEventsForPlayer(before, after, tenantId, events),
      );
      const plan = plans[tenantId];
      const otherIds = playerIds.filter((id) => id !== tenantId);
      const opponentPlans = otherIds.map((opponentId) => ({
        tenantId: opponentId,
        plan: plans[opponentId],
      }));
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
        // N=2 向后兼容 opponentPlan；N>2 用 opponents（显式归属）
        ...(opponentPlans.length === 1
          ? { opponentPlan: opponentPlans[0].plan }
          : {
              opponents: opponentPlans.map((entry) => {
                const opponentPlayer = before.players.get(entry.tenantId);
                return {
                  tenantId: entry.tenantId,
                  plan: entry.plan,
                  unitIds: (opponentPlayer?.units ?? []).map((unit) => unit.id),
                  ...(opponentPlayer?.core === null || opponentPlayer?.core === undefined
                    ? {}
                    : { coreId: opponentPlayer.core.id }),
                };
              }),
            }),
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

for (const tenantId of playerIds) {
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

console.log(
  `synthetic cases: ${caseFiles.length} (${TICKS} ticks × ${playerIds.length} tenants) → ${OUT_DIR}`,
);
console.log(
  `manifests: ${playerIds.map((id) => `manifest-${id}.json`).join(" / ")}（opponentPlans=complete——model-ready 资格）`,
);
console.log(`dataset 构建：npx tsx src/cli/run-sim.ts dataset --manifest <outDir>/manifest-<tenant>.json --dataset-id <id>`);
