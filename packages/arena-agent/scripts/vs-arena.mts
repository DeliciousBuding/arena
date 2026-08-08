/**
 * vs-arena — 通用对抗矩阵 runner（2026-08-08，平台化）
 *
 * 从对手注册中心（registry.ts）拉取任意对手（内置 Python 参考 / HTTP 端点），
 * 与"我方案略"多 seed 对打；支持多版本对比（--me path: 跨 worktree 加载历史
 * 版本，--me2 第二版本 1v1/混战），场景/refill/落盘全配置。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/vs-arena.mts \
 *     [--me aggressive|defensive|balanced|path:<arena-agent 根>] \
 *     [--me2 aggressive|path:<arena-agent 根>]   # 第二版本（版本对比/同场混战） \
 *     [--mode 1v1|ffa] \
 *     [--opponents farmer,core,waaiging,http://127.0.0.1:9000/decide] \
 *     [--seeds 1-8] [--ticks 200] \
 *     [--refill off|65|16|4|N]（默认 4=官方节奏） \
 *     [--scenario synthetic|survey:t1|survey:t1,t2,t3,t4] \
 *     [--record-dir <path>]
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { runFreeForAll, runMatch, type TournEntry } from "../src/sim/opponent/tournament.ts";
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
  const equals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals !== undefined) return equals.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const ME = argValue("--me") ?? "aggressive";
/** 第二版本（path: 或配置档）——版本对比（1v1）或多版本混战（ffa）的参与者。 */
const ME2 = argValue("--me2");
const MODE = argValue("--mode") ?? "1v1";
const OPPONENTS = (argValue("--opponents") ?? "farmer").split(",");
const TICKS = Number(argValue("--ticks") ?? 200);
const REFILL_RAW = argValue("--refill") ?? "4";
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

/** 我方一个版本条目的构造参数（id/描述 + 版本源）。 */
interface MineSpec {
  readonly id: string;
  readonly desc: string;
  /** path: 时加载该 arena-agent 根的实现，否则为配置档（aggressive/defensive/balanced）。 */
  readonly source: string;
}

/** 构造一个"我"的版本条目：path: 动态 import 跨 worktree 版本；否则当前代码库配置档。 */
async function mineEntry(spec: MineSpec): Promise<TournEntry> {
  const aggression = ME === "defensive" ? "defensive" : ME === "balanced" ? "balanced" : "aggressive";
  if (spec.source.startsWith("path:")) {
    const agentRoot = spec.source.slice("path:".length).replaceAll("\\", "/");
    const modUrl = pathToFileURL(
      join(agentRoot.replace(/\/+$/, ""), "src/strategies/safety-planner.ts"),
    ).href;
    let mod: { SafetyPlanner: unknown; DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig };
    try {
      mod = (await import(modUrl)) as {
        SafetyPlanner: new (config?: SafetyPlannerConfig) => { decide: unknown };
        DEFAULT_SAFETY_CONFIG?: SafetyPlannerConfig;
      };
    } catch (error) {
      console.error(`版本加载失败 ${modUrl}: ${String(error)}`);
      process.exit(1);
    }
    const base: SafetyPlannerConfig = {
      ...(mod.DEFAULT_SAFETY_CONFIG ?? DEFAULT_SAFETY_CONFIG),
    };
    if (aggression === "defensive") {
      base.aggression = "defensive";
      base.attackForce = 0;
    } else if (aggression === "balanced") {
      base.aggression = "balanced";
      base.attackForce = 1;
    } else {
      base.aggression = "aggressive";
      base.attackForce = 2;
    }
    const Pl = mod.SafetyPlanner as new (config?: SafetyPlannerConfig) => { decide: unknown };
    return { id: spec.id, desc: spec.desc, build: () => new Pl(base) };
  }
  const base: SafetyPlannerConfig = { ...DEFAULT_SAFETY_CONFIG };
  if (aggression === "defensive") {
    base.aggression = "defensive";
    base.attackForce = 0;
  } else if (aggression === "balanced") {
    base.aggression = "balanced";
    base.attackForce = 1;
  } else {
    base.aggression = "aggressive";
    base.attackForce = 2;
  }
  return {
    id: spec.id,
    desc: spec.desc,
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

const labelFor = (source: string): string =>
  source.startsWith("path:") ? `my safety @${source.slice("path:".length)}` : `my safety ${source}`;
const ME_DESC = labelFor(ME);
const oursPromise = mineEntry({ id: "mine", desc: ME_DESC, source: ME });
const ours2Promise = ME2 === undefined
  ? Promise.resolve(null)
  : mineEntry({ id: "mine2", desc: labelFor(ME2), source: ME2 });
const [ours, ours2] = await Promise.all([oursPromise, ours2Promise]);

const modeLabel = MODE === "ffa" ? "混战" : "vs";
console.log(
  `vs-arena：我方=${ours.desc}${ours2 !== null ? `；第二版本=${ours2.desc}` : ""} ${modeLabel} [${OPPONENTS.join(", ")}]` +
    `（${TICKS} ticks × seeds[${SEEDS_ARG}]，refill=${REFILL_RAW}，场景=${SCENARIO}）`,
);
console.log("=".repeat(96));

const wallStart = performance.now();

/** FFA 模式：我方（及可选第二版本）与全部对手同场混战，按参与方统计胜场。 */
if (MODE === "ffa") {
  const specs = OPPONENTS.map((name) => resolveOpponent(name));
  const participants: TournEntry[] = [ours, ...(ours2 !== null ? [ours2] : [])];
  const wins = new Map<string, number>(participants.map((p) => [p.id, 0]));
  const finals = new Map<string, number[]>([
    ...specs.map((spec) => [spec.name, []] as [string, number[]]),
    ...participants.map((p) => [p.id, []] as [string, number[]]),
  ]);
  for (const seed of SEEDS) {
    const entries = [...participants, ...specs.map((spec) => opponentEntry(spec, seed))];
    const recordTo =
      RECORD_DIR === undefined ? undefined : join(RECORD_DIR, `ffa-s${seed}.jsonl`);
    if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
    const result = runFreeForAll(entries, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: REFILL_EVERY_TICKS,
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner !== null) {
      const winnerKey = specs.find((s) => result.winner === `${s.name}-s${seed}`)?.name;
      if (result.winner === "mine" || result.winner === "mine2" || winnerKey !== undefined) {
        wins.set(result.winner === "mine" || result.winner === "mine2" ? result.winner : winnerKey!, (wins.get(result.winner === "mine" || result.winner === "mine2" ? result.winner : winnerKey!) ?? 0) + 1);
      }
    }
    for (const [key, values] of finals) {
      const playerId = key.startsWith("mine") ? key : `${key}-s${seed}`;
      values.push(result.finalResources[playerId] ?? 0);
    }
  }
  const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  for (const spec of specs) {
    const rate = ((wins.get(spec.name) ?? 0) / SEEDS.length) * 100;
    console.log(
      `混战 ${spec.desc.padEnd(30)} 胜率=${rate.toFixed(0).padStart(3)}% | 均资源=${mean(finals.get(spec.name) ?? []).padStart(5)}`,
    );
  }
  for (const p of participants) {
    const rate = ((wins.get(p.id) ?? 0) / SEEDS.length) * 100;
    console.log(`混战 ${p.desc.padEnd(30)} 胜率=${rate.toFixed(0).padStart(3)}% | 均资源=${mean(finals.get(p.id) ?? []).padStart(5)}`);
  }
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log("-".repeat(96));
  console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length)).toFixed(1)}ms/tick/场）`);
} else if (ours2 !== null) {
  // 版本对比：我（mine）vs 第二版本（mine2），每 seed 1v1
  const wins = { mine: 0, mine2: 0 };
  const res = { mine: [] as number[], mine2: [] as number[] };
  for (const seed of SEEDS) {
    const recordTo =
      RECORD_DIR === undefined ? undefined : join(RECORD_DIR, `v1v2-s${seed}.jsonl`);
    if (RECORD_DIR !== undefined) mkdirSync(RECORD_DIR, { recursive: true });
    const result = runMatch(ours, ours2, seed, TICKS, MANIFEST_PATH, {
      validatePlans: false,
      refillEveryTicks: REFILL_EVERY_TICKS,
      ...(recordTo === undefined ? {} : { recordTo }),
    });
    if (result.winner === "mine") wins.mine += 1;
    else if (result.winner === "mine2") wins.mine2 += 1;
    res.mine.push(result.finalResources["mine"]);
    res.mine2.push(result.finalResources["mine2"]);
  }
  const mean = (values: number[]): string => (values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
  console.log(`版本对比 ${ours.desc.padEnd(34)} 胜率=${((wins.mine / SEEDS.length) * 100).toFixed(0).padStart(3)}% | 均资源=${mean(res.mine).padStart(5)}`);
  console.log(`版本对比 ${ours2.desc.padEnd(34)} 胜率=${((wins.mine2 / SEEDS.length) * 100).toFixed(0).padStart(3)}% | 均资源=${mean(res.mine2).padStart(5)}`);
  const wallSec = (performance.now() - wallStart) / 1000;
  console.log("-".repeat(96));
  console.log(`总耗时 ${wallSec.toFixed(1)}s（${((wallSec * 1000) / (TICKS * SEEDS.length)).toFixed(1)}ms/tick/局）`);
} else {
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
}
