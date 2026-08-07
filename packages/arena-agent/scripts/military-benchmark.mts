/**
 * 军事决策算法统一基准 v2（2026-08-08，军事层系统化）：
 * 复用 scripts/scenarios/*.json 现成场景，按 defensive / aggressive 两种
 * MacroPolicy 注入 p1，统一 KPI 提取，一键跑核心军事场景矩阵输出对比表。
 *
 * 用途：军事算法改进的回归基准（离线 sim，不碰生产）；先证据后部署。
 *
 * 统一 KPI（events 提取，targetId 匹配 core 实体 id——不是 playerId）：
 *  - p1CoreSurvived / p1CoreDestroyedAt：p1 Core 存活与拆毁 tick
 *  - p2CoreDestroyedAt：攻坚拆核 tick（null=未拆）
 *  - p1MilitarySurvivors：p1 军事存活（VANGUARD+RANGER）
 *  - p1CoreDamageEvents：p1 Core 受击次数（防御压力）
 *  - p1Harvests / p1Deposits：经济产出
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/military-benchmark.mts [场景名|all]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runEpisode, type EpisodeConfig } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SCENARIO_DIR = "scripts/scenarios";
const SEEDS = [1, 2, 3];
const TICKS = 240;

const DEFENSIVE_POLICY: MacroPolicy = { posture: "balanced", workerTarget: 8, militaryRatio: 0.2, focusRegion: null, attackPriority: null };
const AGGRESSIVE_POLICY: MacroPolicy = { posture: "aggressive", workerTarget: 8, militaryRatio: 0.5, focusRegion: null, attackPriority: "core" };

interface MilitaryKpi {
  readonly p1CoreSurvived: boolean;
  readonly p1CoreDestroyedAt: number | null;
  readonly p2CoreDestroyedAt: number | null;
  readonly p1MilitarySurvivors: number;
  readonly p1CoreDamageEvents: number;
  readonly p1Harvests: number;
  readonly p1Deposits: number;
}

function extractKpi(result: ReturnType<typeof runEpisode>, playerId: string, targetPlayerId: string): MilitaryKpi {
  const coreIdByPlayer = new Map<string, string>();
  for (const [id, p] of result.finalWorld.players) {
    if (p.core !== undefined && p.core !== null) coreIdByPlayer.set(id, p.core.id);
  }
  const coreId = coreIdByPlayer.get(playerId);
  const targetCoreId = coreIdByPlayer.get(targetPlayerId);
  const finalPlayer = result.finalWorld.players.get(playerId);
  const coreAlive = finalPlayer?.core !== undefined && finalPlayer.core !== null && finalPlayer.core.hp > 0;
  let p1CoreDestroyedAt: number | null = null;
  let p2CoreDestroyedAt: number | null = null;
  let p1CoreDamageEvents = 0;
  let harvests = 0;
  let deposits = 0;
  for (const record of result.records) {
    for (const ev of record.events) {
      if (ev.eventType === "CORE_DESTROYED" && ev.targetId === coreId) {
        if (p1CoreDestroyedAt === null) p1CoreDestroyedAt = ev.tick;
      } else if (ev.eventType === "CORE_DESTROYED" && ev.targetId === targetCoreId) {
        if (p2CoreDestroyedAt === null) p2CoreDestroyedAt = ev.tick;
      } else if (ev.eventType === "CORE_DAMAGED" && ev.targetId === coreId) {
        p1CoreDamageEvents += 1;
      } else if (ev.eventType === "HARVEST_SUCCEEDED" && ev.actorId?.startsWith("22222222")) {
        harvests += 1;
      } else if (ev.eventType === "DEPOSIT_SUCCEEDED" && ev.actorId?.startsWith("22222222")) {
        deposits += 1;
      }
    }
  }
  const military = [...(finalPlayer?.units ?? [])].filter((u) => u.unitType === "VANGUARD" || u.unitType === "RANGER").length;
  return {
    p1CoreSurvived: coreAlive,
    p1CoreDestroyedAt,
    p2CoreDestroyedAt,
    p1MilitarySurvivors: military,
    p1CoreDamageEvents,
    p1Harvests: harvests,
    p1Deposits: deposits,
  };
}

function runVariant(scenarioPath: string, policy: MacroPolicy, seed: number): MilitaryKpi {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  const config: EpisodeConfig = {
    scenario: { ...scenario, seed },
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [
      { id: "p1", planner: "deterministic", policy },
      { id: "p2", planner: "deterministic" },
    ],
  };
  const result = runEpisode(config);
  return extractKpi(result, "p1", "p2");
}

function avg(nums: number[]): string {
  return nums.length > 0 ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : "-";
}
function neverIf(v: (number | null)[]): string {
  const vs = v.filter((x): x is number => x !== null);
  return vs.length > 0 ? avg(vs) : "never";
}

async function main(): Promise<void> {
  const filter = process.argv[2] ?? "all";
  const files = readdirSync(SCENARIO_DIR)
    .filter((n) => n.endsWith(".json"))
    .filter((n) => filter === "all" || n.includes(filter))
    .sort();
  console.log("=== Military Decision Benchmark v2 (v0.14, " + TICKS + " ticks x " + SEEDS.length + " seeds) ===");
  console.log("");
  for (const file of files) {
    const path = join(SCENARIO_DIR, file);
    console.log("## " + file.replace(".json", ""));
    const rows: Array<{ arm: string; kpis: MilitaryKpi[] }> = [];
    for (const [arm, policy] of [["defensive", DEFENSIVE_POLICY], ["aggressive", AGGRESSIVE_POLICY]] as const) {
      const kpis: MilitaryKpi[] = [];
      for (const seed of SEEDS) {
        try {
          kpis.push(runVariant(path, policy, seed));
        } catch (error) {
          console.log("  [" + arm + "] seed " + seed + " failed: " + String(error).slice(0, 120));
        }
      }
      rows.push({ arm, kpis });
    }
    console.log("arm        | p1CoreSurv | p1拆毁tick | p2拆毁tick | p1军事存活 | p1受击 | harvest | deposit");
    console.log("-----------|------------|------------|------------|------------|--------|---------|---------");
    for (const { arm, kpis } of rows) {
      if (kpis.length === 0) continue;
      console.log(
        arm.padEnd(10) + " | " +
        (kpis.filter((k) => k.p1CoreSurvived).length + "/" + kpis.length).padEnd(10) + " | " +
        neverIf(kpis.map((k) => k.p1CoreDestroyedAt)).padEnd(10) + " | " +
        neverIf(kpis.map((k) => k.p2CoreDestroyedAt)).padEnd(10) + " | " +
        avg(kpis.map((k) => k.p1MilitarySurvivors)).padEnd(10) + " | " +
        avg(kpis.map((k) => k.p1CoreDamageEvents)).padEnd(6) + " | " +
        avg(kpis.map((k) => k.p1Harvests)).padEnd(7) + " | " +
        avg(kpis.map((k) => k.p1Deposits)),
      );
    }
    console.log("");
  }
}

await main();
