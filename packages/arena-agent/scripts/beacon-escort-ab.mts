/**
 * beacon 护送取标 A/B（2026-08-08，军事负责人"信标提前规划"）：
 * 生产事实：全局信标被 jerkman（ELITE_AGGRESSOR、伤害榜#5）携带，距 t2
 * 核心 52 格——远征已取消，只在信标进入 24 格防区后机会取标。但信标进入
 * 防区时附近可能有敌方游荡单位（t2 实测 83 敌单位），单骑取标会被射爆。
 * 本实验量化"护送取标"的价值：
 *   - baseline   ：单骑 fetch（beaconEscort:false 对照组，生产旧行为）
 *   - escort2v   ：内置护送（beaconEscort:true 生产实现）——设计者 fetch +
 *                  最近另一 Vanguard 贴身影护
 *   - squad2v1r  ：内置护送 + Ranger 影护（guide spot-clear 思路）
 * 场景：我方 Core [0,0]、信标 GROUND [15,5]（Chebyshev 15 ≤24 可抢）、
 * 敌方游荡小队（2V+1R，自定义 GuardPlanner 会主动射击）在信标旁驻守。
 * KPI：取标成功（BEACON_PICKED_UP）、终局我方持标（CARRIED by p1）、
 *      载者/护送存活、我方资源、我方死亡数（SHOT_HIT/UNIT_DAMAGED 统计）。
 *
 * 用法：cd packages/arena-agent && npx tsx scripts/beacon-escort-ab.mts
 */
import { writeFileSync } from "node:fs";
import { runEpisode, type EpisodeConfig, type EpisodeTenant } from "../src/sim/harness/episode.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerInput } from "../src/strategies/safety-planner.ts";
import { canShoot } from "../src/strategies/safety-planner-helpers.ts";
import { chebyshev, stepToward } from "../src/domain/nav.ts";
import type { Plan, TickState } from "../src/domain/model.ts";
import type { PlanProvider } from "../src/runtime/decision-types.ts";
import type { MacroPolicy } from "../src/runtime/macro-policy.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const RESULT_FILE = "beacon-escort-result.txt";

const BEACON: [number, number] = [15, 5];
const GUARD_POS: [number, number][] = [[13, 4], [14, 6], [16, 5]]; // 2V + 1R

function scenario(seed: number) {
  const p1Vanguards = [
    { id: "22222222-2222-2222-2222-222222222211", owner: "p1", position: [4, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
    { id: "22222222-2222-2222-2222-222222222212", owner: "p1", position: [4, 1], hp: 4, unitType: "VANGUARD", cargo: 0 },
    { id: "22222222-2222-2222-2222-222222222213", owner: "p1", position: [4, 2], hp: 4, unitType: "VANGUARD", cargo: 0 },
    { id: "22222222-2222-2222-2222-222222222214", owner: "p1", position: [5, 0], hp: 4, unitType: "VANGUARD", cargo: 0 },
  ];
  const p1Rangers = [
    { id: "22222222-2222-2222-2222-222222222221", owner: "p1", position: [5, 1], hp: 2, unitType: "RANGER", cargo: 0 },
  ];
  const p1Workers = [
    { id: "22222222-2222-2222-2222-222222222201", owner: "p1", position: [1, 0], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "22222222-2222-2222-2222-222222222202", owner: "p1", position: [1, 1], hp: 2, unitType: "WORKER", cargo: 0 },
    { id: "22222222-2222-2222-2222-222222222203", owner: "p1", position: [2, 0], hp: 2, unitType: "WORKER", cargo: 0 },
  ];
  const p2Guard = GUARD_POS.map((p, i) => ({
    id: `44444444-4444-4444-4444-4444444444${String(i).padStart(2, "0")}`,
    owner: "p2",
    position: p,
    hp: i === 2 ? 2 : 4,
    unitType: i === 2 ? "RANGER" : "VANGUARD",
    cargo: 0,
  }));
  return {
    rulesVersion: "v0.14" as const,
    tick: 1,
    seed,
    players: [
      {
        id: "p1", username: "p1", resources: 30,
        core: { id: "11111111-1111-1111-1111-111111111111", position: [0, 0], hp: 5, shield: 5, state: "NORMAL" },
        units: [...p1Vanguards, ...p1Rangers, ...p1Workers],
      },
      {
        id: "p2", username: "guard", resources: 30,
        core: { id: "33333333-3333-3333-3333-333333333333", position: [60, 60], hp: 5, shield: 5, state: "NORMAL" },
        units: p2Guard,
      },
    ],
    terrain: { obstacles: [], resources: [[3, 0], [3, 1], [3, 2], [20, 0], [21, 0]] },
    beacon: { position: BEACON, status: "GROUND", carrierId: null },
  };
}

const POLICY: MacroPolicy = {
  posture: "aggressive",
  workerTarget: 8,
  militaryRatio: 0.4,
  focusRegion: null,
  attackPriority: null,
};

/** 敌方游荡小队守卫决策器：见到我方单位就射击/近战，否则原地待命。 */
class GuardPlanner implements PlanProvider {
  decide(input: { readonly state: TickState }): Plan {
    const { state } = input;
    const unitActions: Record<string, Plan["unitActions"][string]> = {};
    const intents: Record<string, string> = {};
    const obstacles = state.obstacleCells;
    for (const unit of [...state.vanguards, ...state.rangers]) {
      const target = state.visibleEnemies.find((e) => e.kind === "UNIT" && e.unitType !== "WORKER")
        ?? state.visibleEnemies.find((e) => e.kind === "UNIT");
      if (unit.unitType === "RANGER" && target !== undefined && canShoot(unit.position, target.position, obstacles)) {
        unitActions[unit.id] = { type: "SHOOT", targetId: target.id, expectedCell: target.position };
        intents[unit.id] = "guard_shoot";
      } else if (unit.unitType === "VANGUARD" && target !== undefined && chebyshev(unit.position, target.position) <= 1) {
        const dir = stepToward(unit.position, target.position, obstacles) ?? "LEFT";
        unitActions[unit.id] = { type: "SWEEP", direction: dir };
        intents[unit.id] = "guard_sweep";
      } else if (target !== undefined && chebyshev(unit.position, target.position) <= 4) {
        const dir = stepToward(unit.position, target.position, obstacles);
        unitActions[unit.id] = dir === null ? { type: "WAIT" } : { type: "MOVE", direction: dir };
        intents[unit.id] = "guard_chase";
      } else {
        unitActions[unit.id] = { type: "WAIT" };
        intents[unit.id] = "guard_hold";
      }
    }
    return { tick: state.tick, unitActions, coreAction: null, intents };
  }
}

type EscortMode = "none" | "vanguard" | "squad";

/** 护送包装器：base SafetyPlanner 决策后，若存在 beacon_fetch 设计者，
 *  另派最近 Vanguard（squad 模式再加最近 Ranger）贴身影护（保持 ≤2 格）。 */
class EscortWrapper implements PlanProvider {
  private readonly base: SafetyPlanner;
  private readonly mode: EscortMode;
  constructor(base: SafetyPlanner, mode: EscortMode) {
    this.base = base;
    this.mode = mode;
  }
  decide(input: SafetyPlannerInput): Plan {
    const plan = this.base.decide(input);
    if (this.mode === "none") return plan;
    const state = input.state;
    const designeeId = Object.entries(plan.intents)
      .find(([, intent]) => intent.endsWith("beacon_fetch"))?.[0];
    if (designeeId === undefined) return plan;
    const designee = [...state.vanguards, ...state.rangers].find((u) => u.id === designeeId);
    if (designee === undefined) return plan;
    const obstacles = state.obstacleCells;
    const others = [...state.vanguards]
      .filter((u) => u.id !== designeeId)
      .sort((a, b) => chebyshev(a.position, designee.position) - chebyshev(b.position, designee.position));
    const escorts = this.mode === "vanguard"
      ? others.slice(0, 1)
      : [...others.slice(0, 1), ...state.rangers.filter((r) => r.id !== designeeId).slice(0, 1)];
    const unitActions = { ...plan.unitActions };
    const intents = { ...plan.intents };
    for (const e of escorts) {
      if (chebyshev(e.position, designee.position) <= 2) {
        unitActions[e.id] = { type: "WAIT" };
      } else {
        const dir = stepToward(e.position, designee.position, obstacles);
        unitActions[e.id] = dir === null ? { type: "WAIT" } : { type: "MOVE", direction: dir };
      }
      intents[e.id] = "beacon_escort";
    }
    return { ...plan, unitActions, intents };
  }
}

const SEEDS = [1, 2, 3];
const TICKS = 300;

interface Kpis {
  pickups: number;
  carriedByUs: boolean;
  ourMilitaryAlive: number;
  ourResources: number;
  deposits: number;
  shotsAtUs: number;
  militaryDeaths: number;
  carrierDroppedOnDeath: number;
}

function runVariant(mode: EscortMode, seed: number): Kpis {
  const config: EpisodeConfig = {
    scenario: scenario(seed),
    rulesPath: MANIFEST_PATH,
    seed,
    ticks: TICKS,
    refill: { everyTicks: 65 },
    tenants: [
      { id: "p1", planner: "safety", policy: POLICY } as EpisodeTenant,
      { id: "p2", planner: "deterministic", policy: POLICY } as EpisodeTenant,
    ],
    plannerFactory: (tenant) => {
      if (tenant.id !== "p1") return new GuardPlanner();
      const base = new SafetyPlanner({
        ...DEFAULT_SAFETY_CONFIG,
        aggression: "aggressive",
        beaconGrab: true,
        beaconGrabMaxDist: 24,
        // baseline = 单骑（关内置护送）；escort/squad = 开内置护送
        beaconEscort: mode === "none" ? false : true,
      });
      // escort2v = 纯内置护送（不套 wrapper，测生产实现）；squad 臂额外加
      // Ranger 影护（近战保护 + 远程对射）
      return mode === "squad" ? new EscortWrapper(base, mode) : base;
    },
  };
  const result = runEpisode(config);
  const p1 = result.finalWorld.players.get("p1")!;
  const beacon = result.finalWorld.beacon;
  let pickups = 0;
  let deposits = 0;
  let shotsAtUs = 0;
  let carrierDroppedOnDeath = 0;
  const everSeenMilitary = new Set<string>();
  for (const record of result.records) {
    for (const event of record.events) {
      if (event.eventType === "BEACON_PICKED_UP") pickups += 1;
      else if (event.eventType === "DEPOSIT_SUCCEEDED") deposits += 1;
      else if (event.eventType === "SHOT_HIT" && String(event.targetId ?? "").startsWith("2222")) shotsAtUs += 1;
      else if (event.eventType === "BEACON_DROPPED_ON_DEATH") carrierDroppedOnDeath += 1;
    }
  }
  const carriedByUs = beacon !== null && beacon.status === "CARRIED" && beacon.carrierId !== null
    && String(beacon.carrierId).startsWith("2222");
  for (const record of result.records) {
    for (const unitId of Object.keys(record.plans.p1?.unitActions ?? {})) {
      everSeenMilitary.add(unitId);
    }
  }
  const aliveMilitary = new Set(p1.units.filter((u) => u.unitType === "VANGUARD" || u.unitType === "RANGER").map((u) => u.id));
  const militaryDeaths = [...everSeenMilitary].filter((id) => !aliveMilitary.has(id)).length;
  const military = p1.units.filter((u) => u.unitType === "VANGUARD" || u.unitType === "RANGER");
  return {
    pickups,
    carriedByUs,
    ourMilitaryAlive: military.length,
    ourResources: p1.resources,
    deposits,
    shotsAtUs,
    militaryDeaths,
    carrierDroppedOnDeath,
  };
}

const ARMS: ReadonlyArray<{ mode: EscortMode; label: string }> = [
  { mode: "none", label: "baseline(单骑)" },
  { mode: "vanguard", label: "escort2v(2V护送)" },
  { mode: "squad", label: "squad2v1r(2V1R小队)" },
];

const lines: string[] = [];
lines.push(`beacon 护送取标 A/B（${TICKS} ticks × ${SEEDS.length} seeds；敌方游荡小队 2V+1R 驻守信标 [${BEACON}]）`);
lines.push("=".repeat(96));
lines.push(`${"臂".padEnd(18)} | 取标成功 | 终局持标 | 军事存活 | 军事阵亡 | 载者阵亡掉标 | 资源 | deposits | 被射次数`);
for (const arm of ARMS) {
  const outs = SEEDS.map((seed) => runVariant(arm.mode, seed));
  const pickups = outs.reduce((s, o) => s + o.pickups, 0);
  const carried = outs.filter((o) => o.carriedByUs).length;
  const mil = outs.reduce((s, o) => s + o.ourMilitaryAlive, 0) / outs.length;
  const res = outs.reduce((s, o) => s + o.ourResources, 0) / outs.length;
  const dep = outs.reduce((s, o) => s + o.deposits, 0) / outs.length;
  const shots = outs.reduce((s, o) => s + o.shotsAtUs, 0) / outs.length;
  const deaths = outs.reduce((s2, o) => s2 + o.militaryDeaths, 0);
  const drops = outs.reduce((s2, o) => s2 + o.carrierDroppedOnDeath, 0);
  lines.push(
    `${arm.label.padEnd(18)} | ${String(pickups).padStart(4)}/3      | ${String(carried).padStart(3)}/3       | ${mil.toFixed(1).padStart(5)}      | ${String(deaths).padStart(6)}      | ${String(drops).padStart(6)}          | ${res.toFixed(0).padStart(4)} | ${dep.toFixed(1).padStart(7)} | ${shots.toFixed(0).padStart(6)}`,
  );
  for (let i = 0; i < outs.length; i += 1) {
    const o = outs[i];
    lines.push(`  seed ${SEEDS[i]}: pickup=${o.pickups} carried=${o.carriedByUs} military=${o.ourMilitaryAlive} deaths=${o.militaryDeaths} dropOnDeath=${o.carrierDroppedOnDeath} res=${o.ourResources} dep=${o.deposits} shots=${o.shotsAtUs}`);
  }
}
const output = lines.join("\n");
console.log(output);
writeFileSync(RESULT_FILE, output + "\n");
