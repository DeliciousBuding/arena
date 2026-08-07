/**
 * strike-core-v1 攻坚 A/B v2（2026-08-07 用户导向"赶紧打掉"离线验证，修正 v1 问题）：
 * - 事件名修正：SHOT_HIT/SHOT_MISSED = 射击，SWEEP_RESOLVED = 清扫（v1 用了不存在的名字导致 0/0）；
 * - 对照修正：v1 的"对照"policy=aggressive 导致 effectiveAggression 覆盖 config 也变 aggressive
 *   （aggressionOf(policy) 优先于 config.aggression）——所以对照组其实也在打。现在三臂：
 *     defensive     = 当前生产 t1 行为（balanced policy + 无变体，军事不主动前压）
 *     aggressive    = 仅 aggressive policy（LLM 选 aggressive 但无 strike 旋钮）
 *     strike-core-v1= aggressive policy + 完整攻坚变体（attackForce/boundedRaid/rangerMemoryShot/
 *                     strikeGroupReserve + accumulateThreshold/vanguardRatio）
 * - KPI：p1 Core 存活 / p2 Core 被拆数 + 平均拆毁 tick / p1 资源 / p1 射击与清扫事件数。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/strike-core-experiment.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SCENARIO_DIR = "scripts/scenarios";
const SCENARIOS = [
  "strike-defense-2-ranger.json",
  "strike-defense-6.json",
  "threat-defense-raid.json",
  "ranged-siege.json",
  "worker-hunt.json",
];
const SEEDS = [1, 2, 3];
const TICKS = 300;
const RESULT_FILE = "strike-core-result.txt";

const STRIKE_CONFIG = {
  aggression: "aggressive" as const,
  attackForce: 6,
  boundedRaid: true,
  rangerMemoryShot: true,
  strikeGroupReserve: true,
  accumulateThreshold: 30,
  vanguardRatio: 0.5,
};

const DEFENSIVE_POLICY: MacroPolicy = {
  posture: "balanced",
  workerTarget: 8,
  militaryRatio: 0.2,
  focusRegion: null,
  attackPriority: null,
};

const AGGRESSIVE_POLICY: MacroPolicy = {
  posture: "aggressive",
  workerTarget: 8,
  militaryRatio: 0.5,
  focusRegion: null,
  attackPriority: "core",
};

type Arm = "defensive" | "aggressive" | "strike";

interface Outcome {
  readonly p1CoreAlive: boolean;
  readonly p2CoreAlive: boolean;
  readonly p2DestroyedAt: number;
  readonly p1Resources: number;
  readonly p1Shots: number;
  readonly p1Sweeps: number;
}

function runScenario(scenarioPath: string, arm: Arm, seed: number): Outcome {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
  const p1Tenant: EpisodeTenant = {
    id: "p1",
    planner: "deterministic",
    policy: arm === "defensive" ? DEFENSIVE_POLICY : AGGRESSIVE_POLICY,
    plannerConfig: arm === "strike" ? STRIKE_CONFIG : {},
  };
  const p2Tenant: EpisodeTenant = {
    id: "p2",
    planner: "deterministic",
    policy: DEFENSIVE_POLICY,
  };
  const result = runEpisode({
    scenario: { ...scenario, seed },
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    tenants: [p1Tenant, p2Tenant],
  });
  let p1CoreAlive = true;
  let p2CoreAlive = true;
  let p2DestroyedAt = -1;
  let p1Shots = 0;
  let p1Sweeps = 0;
  for (const record of result.records) {
    for (const event of record.events) {
      const target = String(event.targetId ?? "");
      const actor = String(event.actorId ?? "");
      if (event.eventType === "CORE_DESTROYED") {
        if (target.startsWith("1111")) p1CoreAlive = false;
        if (target.startsWith("4444")) { p2CoreAlive = false; p2DestroyedAt = record.tick; }
      }
      if (actor.startsWith("2222")) {
        if (event.eventType === "SHOT_HIT" || event.eventType === "SHOT_MISSED") p1Shots += 1;
        if (event.eventType === "SWEEP_RESOLVED") p1Sweeps += 1;
      }
    }
  }
  const p1 = result.finalWorld.players.get("p1");
  return {
    p1CoreAlive,
    p2CoreAlive,
    p2DestroyedAt,
    p1Resources: p1?.resources ?? -1,
    p1Shots,
    p1Sweeps,
  };
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
}

async function main(): Promise<void> {
  const lines: string[] = [];
  lines.push(`=== strike-core-v1 攻坚 A/B v2（${TICKS} ticks × ${SEEDS.length} seeds；p2 恒 defensive deterministic）===`);
  lines.push("场景                  | 臂        | p1活 p2拆 t拆 | p1资源 | 射击 | 清扫");
  for (const file of SCENARIOS) {
    const path = join(SCENARIO_DIR, file);
    const name = file.replace(".json", "");
    for (const arm of ["defensive", "aggressive", "strike"] as Arm[]) {
      const outs = SEEDS.map((seed) => runScenario(path, arm, seed));
      const destroyed = outs.filter((o) => !o.p2CoreAlive);
      const fmt = `${outs.filter((o) => o.p1CoreAlive).length}/3 ${destroyed.length}/3 t${mean(destroyed.map((o) => o.p2DestroyedAt)).toFixed(0)}`;
      lines.push(
        `${name.padEnd(22)} | ${arm.padEnd(11)} | ${fmt.padEnd(13)} | ${String(mean(outs.map((o) => o.p1Resources)).toFixed(0)).padStart(6)} | ${String(mean(outs.map((o) => o.p1Shots)).toFixed(0)).padStart(5)} | ${String(mean(outs.map((o) => o.p1Sweeps)).toFixed(0)).padStart(5)}`,
      );
    }
  }
  lines.push("", "图例: p1活 x/3 = p1 Core 存活数; p2拆 x/3 = p2 Core 被拆数; tN = 平均拆毁 tick（无拆=∞）; 射击/清扫 = p1 进攻动作事件数");
  writeFileSync(RESULT_FILE, lines.join("\n") + "\n", "utf-8");
  console.log(lines.join("\n"));
}

void main().catch((error) => {
  console.error(`strike-core 实验失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
