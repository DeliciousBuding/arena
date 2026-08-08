/**
 * vs-arena — 通用对抗矩阵 runner（2026-08-08，平台化）
 *
 * 从对手注册中心（registry.ts）拉取任意对手（内置 Python 参考 / HTTP 端点），
 * 与"我方案略"多 seed 对打，支持场景/refill/落盘全配置。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/vs-arena.mts \
 *     [--me aggressive] \
 *     [--opponents farmer,core,http://127.0.0.1:9000/decide] \
 *     [--seeds 1-8] [--ticks 200] \
 *     [--refill off|65|16|4|N] \
 *     [--scenario synthetic|survey:t1|survey:t1,t2,t3,t4] \
 *     [--record-dir <path>]
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
import { COORDINATION_ROOT, opponentEntry, resolveOpponent } from "../src/sim/opponent/registry.ts";
import {
  inWindow,
  makeSurveyScenario,
  pickWindow,
  readSurvey,
  WINDOW_SIZE,
} from "../src/sim/opponent/survey-scenario.ts";
import { DEFAULT_SAFETY_CONFIG, SafetyPlanner, type SafetyPlannerConfig } from "../src/strategies/safety-planner.ts";

const MANIFEST_PATH = "src/sim/contracts/rules-v0.14.json";
const SURVEY_DIR = join(COORDINATION_ROOT, "data", "runtime", "survey");

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  return hit?.slice(flag.length + 1);
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const ME = argValue("--me") ?? "aggressive";
const OPPONENTS = (argValue("--opponents") ?? "farmer").split(",");
const TICKS = Number(argValue("--ticks") ?? 200);
const REFILL_RAW = argValue("--refill") ?? "65";
const REFILL_EVERY_TICKS: number | null =
  REFILL_RAW === "off" ? null : Number(REFILL_RAW);
const SCENARIO = argValue("--scenario") ?? "synthetic";
const RECORD_DIR = argValue("--record-dir");
const TIME_WINDOW_TICKS = Number(argValue("--window-ticks") ?? 5000);
const KEEP_HARVESTED = hasFlag("--keep-harvested");
const SEEDS_ARG = argValue("--seeds") ?? "1-8";
const SEEDS: number[] = (() => {
  const out: number[] = [];
  for (const part of SEEDS_ARG.split(",")) {
    const range = part.split("-").map(Number);
    if (range.length === 2) {
      for (let seed = range[0]; seed <= range[1]; seed += 1) out.push(seed);
    } else {
      out.push(range[0]);
    }
  }
  return out;
})();

/** 我方策略：aggressive（默认）/ defensive / balanced。 */
function oursEntry(): TournEntry {
  const base: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
  if (ME === "defensive") {
    base.aggression = "defensive";
    base.attackForce = 0;
  } else if (ME === "balanced") {
    base.aggression = "balanced";
    base.attackForce = 1;
  } else {
    base.aggression = "aggressive";
    base.attackForce = 2;
  }
  return {
    id: "mine",
    desc: `my safety ${ME}`,
    build: () => new SafetyPlanner(base),
  };
}

/** 场景来源：synthetic（合成布局）/ survey:t1,t2,...（真实测绘战区）。 */
function scenarioFor(seed: number, opponentId: string): unknown {
  if (!SCENARIO.startsWith("survey:")) return undefined;
  const tenants = SCENARIO.slice("survey:".length).split(",");
  const tenant = tenants[seed % tenants.length];
  const snapshot = readSurvey(join(SURVEY_DIR, `${tenant}.db`), tenant, TIME_WINDOW_TICKS, KEEP_HARVESTED);
  const window = pickWindow(snapshot.resources);
  const resourcesIn = snapshot.resources.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  const obstaclesIn = snapshot.obstacles.filter((c) => inWindow(window.x0, window.y0, c.x, c.y));
  return makeSurveyScenario(window, resourcesIn, obstaclesIn, seed, opponentId);
}

const ours = oursEntry();
console.log(
  `vs-arena：我方=${ours.desc} vs [${OPPONENTS.join(", ")}]` +
    `（${TICKS} ticks × seeds[${SEEDS_ARG}]，refill=${REFILL_RAW}，场景=${SCENARIO}）`,
);
console.log("=".repeat(96));

const wallStart = performance.now();
for (const opponentName of OPPONENTS) {
  const spec = resolveOpponent(opponentName);
  const wins = { n: 0 };
  const opponentWins = { n: 0 };
  const myResources: number[] = [];
  const opponentResources: number[] = [];
  for (const seed of SEEDS) {
    const opponent = opponentEntry(spec, seed);
    const recordTo =
      RECORD_DIR === undefined ? undefined : join(RECORD_DIR, `${spec.name}-s${seed}.jsonl`);
    if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
    const result = runMatch(ours, opponent, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: REFILL_EVERY_TICKS,
      scenario: scenarioFor(seed, opponent.id),
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner === ours.id) wins.n += 1;
    else if (result.winner === opponent.id) opponentWins.n += 1;
    myResources.push(result.finalResources[ours.id]);
    opponentResources.push(result.finalResources[opponent.id]);
  }
  const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  console.log(
    `vs ${spec.desc.padEnd(34)} 我胜率=${((wins.n / SEEDS.length) * 100).toFixed(0).padStart(3)}%` +
      `  对手=${((opponentWins.n / SEEDS.length) * 100).toFixed(0).padStart(3)}%` +
      ` | 我均资源=${mean(myResources).padStart(5)}  对手均资源=${mean(opponentResources).padStart(5)}`,
  );
}
const wallSec = (performance.now() - wallStart) / 1000;
console.log("-".repeat(96));
console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length * OPPONENTS.length)).toFixed(1)}ms/tick/局）`);
