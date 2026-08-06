/**
 * 对手分兵场景 A/B（2026-08-07）：模拟器对手丰富度——对手（p2）启用
 * strikeGroupReserve（拆家留守卫——官方 _strike_group_ids 分兵语义）。
 * 评估我方 strikeGroupReserve 在"对手分兵偷袭"场景的价值：
 * - 我方 off（3v 全压）：p2 1v 偷袭 p1（家空）→ 拆 p1；
 * - 我方 on（2v 拆 + 1v 守）：守卫拦 p2 偷袭（1v1 互砍）→ 拆家仍成。
 * KPI：p1/p2 Core 存活、拆毁 tick。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/opponent-strike-group-experiment.mts
 */
import { readFileSync } from "node:fs";
import { runEpisode, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import { SafetyPlanner } from "../src/strategies/safety-planner.ts";
import { DEFAULT_SAFETY_CONFIG } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SEEDS = [1, 2, 3];
const TICKS = 150;

function runVariant(myReserve: boolean, seed: number): { p1Alive: boolean; p2Alive: boolean; p2DownAt: number; p1DownAt: number } {
  const scenario = JSON.parse(readFileSync("scripts/scenarios/strike-group-exchange.json", "utf-8"));
  const makePlanner = (tenant: EpisodeTenant): PlanProvider => {
    const base = { ...DEFAULT_SAFETY_CONFIG, aggression: "aggressive" as const };
    if (tenant.id === "p1") {
      return new SafetyPlanner({ ...base, strikeGroupReserve: myReserve });
    }
    // 对手分兵：p2 启用 strikeGroupReserve（拆家留守卫——偷袭者）
    return new SafetyPlanner({ ...base, strikeGroupReserve: true });
  };
  const result = runEpisode({
    scenario: { ...scenario, seed },
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    plannerFactory: makePlanner,
    tenants: [
      { id: "p1", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
      { id: "p2", planner: "safety", policy: { posture: "aggressive", workerTarget: 4, militaryRatio: 0, focusRegion: null, attackPriority: "core" } },
    ],
  });
  let p1Alive = true;
  let p2Alive = true;
  let p2DownAt = -1;
  let p1DownAt = -1;
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "CORE_DESTROYED") {
        const target = String(event.targetId ?? "");
        if (target.startsWith("1111")) { p1Alive = false; p1DownAt = record.tick; }
        if (target.startsWith("4444")) { p2Alive = false; p2DownAt = record.tick; }
      }
    }
  }
  return { p1Alive, p2Alive, p2DownAt, p1DownAt };
}

console.log(`对手分兵 A/B（${TICKS} ticks × ${SEEDS.length} seeds——p2 拆家留守卫（分兵偷袭））`);
console.log("=".repeat(80));
console.log(`我方全压（strikeGroup off——家空防）`);
const control = SEEDS.map((seed) => runVariant(false, seed));
const c1 = control.filter((o) => o.p1Alive).length;
const c2 = control.filter((o) => !o.p2Alive).length;
for (const [i, o] of control.entries()) console.log(`  seed ${i + 1}: p1=${o.p1Alive ? "活" : "毁@" + o.p1DownAt} p2=${o.p2Alive ? "活" : "毁@" + o.p2DownAt}`);
console.log(`  p1 存活=${c1}/3 | p2 被拆=${c2}/3`);
console.log(`我方守卫预留（strikeGroup on——1 Vanguard 守家）`);
const variant = SEEDS.map((seed) => runVariant(true, seed));
const v1 = variant.filter((o) => o.p1Alive).length;
const v2 = variant.filter((o) => !o.p2Alive).length;
for (const [i, o] of variant.entries()) console.log(`  seed ${i + 1}: p1=${o.p1Alive ? "活" : "毁@" + o.p1DownAt} p2=${o.p2Alive ? "活" : "毁@" + o.p2DownAt}`);
console.log(`  p1 存活=${v1}/3 | p2 被拆=${v2}/3`);
