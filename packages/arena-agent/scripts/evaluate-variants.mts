/**
 * 基准场景库统一评估（2026-08-07）：候选变体在标准场景矩阵上的 A/B。
 * 每个场景 × 每个变体 × seeds 1-3 跑 episode——KPI 矩阵（p1 Core 存活/
 * p2 被拆/拆毁 tick/资源），对照组 = 全关。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/evaluate-variants.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runEpisode } from "../src/sim/harness/episode.ts";
import type { EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";
import type { SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SCENARIO_DIR = "scripts/scenarios";
const SEEDS = [1, 2, 3];
const TICKS = 150;

/** 候选变体清单（SafetyPlanner config 开关；全部默认关闭）。 */
const VARIANTS: ReadonlyArray<{ readonly name: string; readonly config: Partial<SafetyPlannerConfig> }> = [
  { name: "baseline", config: {} },
  { name: "guardAxes", config: { guardAxes: true } },
  { name: "coreEvade", config: { coreEvade: true } },
  { name: "moveFailedAvoidance", config: { moveFailedAvoidance: true } },
  { name: "clearPath", config: { clearPath: true } },
  { name: "threatRecall", config: { threatRecall: true } },
  { name: "threatBreakout", config: { threatBreakout: true } },
  { name: "boundedRaid", config: { boundedRaid: true } },
  { name: "detachedSquad", config: { detachedSquadResponse: true } },
  { name: "strikeGroup", config: { strikeGroupReserve: true } },
  { name: "guardHealRotation", config: { guardHealRotation: true } },
  { name: "rangerMemoryShot", config: { rangerMemoryShot: true } },
  { name: "scoutEvade", config: { scoutEvade: true } },
];

interface Outcome {
  p1CoreAlive: boolean;
  p2CoreAlive: boolean;
  p2DestroyedAt: number;
  p1Resources: number;
}

function runScenario(
  scenarioPath: string,
  variant: (typeof VARIANTS)[number],
  seed: number,
): Outcome {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  // 场景 evaluation 元数据：p1 姿态（balanced=防御评估 / aggressive=攻击
  // 评估——攻击性候选如 strikeGroup 只在攻击场景有意义）。
  const evaluation = scenario.evaluation as { p1Posture?: string; p1AttackPriority?: string | null } | undefined;
  const p1Posture = evaluation?.p1Posture === "aggressive" ? "aggressive" : "balanced";
  const p1Priority = evaluation?.p1AttackPriority ?? null;
  const makePlanner = (tenant: EpisodeTenant): PlanProvider => {
    if (tenant.id !== "p1") return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG });
    return new SafetyPlanner({ ...DEFAULT_SAFETY_CONFIG, ...variant.config });
  };
  const result = runEpisode({
    scenario: { ...scenario, seed },
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    plannerFactory: makePlanner,
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: p1Posture, workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: p1Priority } },
      { id: "p2", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
    ],
  });
  let p1CoreAlive = true;
  let p2CoreAlive = true;
  let p2DestroyedAt = -1;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED") {
        const target = String(event.targetId ?? "");
        if (target.startsWith("1111")) p1CoreAlive = false;
        if (target.startsWith("4444")) { p2CoreAlive = false; p2DestroyedAt = record.tick; }
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1")!;
  return { p1CoreAlive, p2CoreAlive, p2DestroyedAt, p1Resources: p1.resources };
}

const scenarioFiles = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".json")).sort();
console.log(`基准场景矩阵（${TICKS} ticks × ${SEEDS.length} seeds × ${VARIANTS.length} 变体，场景 ${scenarioFiles.length} 个）`);
console.log("=".repeat(120));
const header = ["场景", ...VARIANTS.map((v) => v.name.padEnd(16))].join(" | ");
console.log(header);
console.log("-".repeat(120));
for (const file of scenarioFiles) {
  const path = join(SCENARIO_DIR, file);
  const name = file.replace(".json", "");
  const cells: string[] = [];
  for (const variant of VARIANTS) {
    const outcomes = SEEDS.map((seed) => runScenario(path, variant, seed));
    const p1Alive = outcomes.filter((o) => o.p1CoreAlive).length;
    const p2Down = outcomes.filter((o) => !o.p2CoreAlive).length;
    const avgTick = outcomes.filter((o) => o.p2DestroyedAt > 0).reduce((s, o) => s + o.p2DestroyedAt, 0) / Math.max(1, outcomes.filter((o) => o.p2DestroyedAt > 0).length);
    cells.push(`p1${p1Alive}/3 p2${p2Down}/3 t${avgTick.toFixed(0)}`.padEnd(16));
  }
  console.log([name.padEnd(16), ...cells].join(" | "));
}
console.log("图例: p1x/3 = p1 Core 存活数; p2x/3 = p2 被拆数; tN = 平均拆毁 tick（未拆=∞）");
