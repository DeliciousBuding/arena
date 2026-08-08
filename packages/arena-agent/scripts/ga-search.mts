/**
 * ga-search — W52 GA 搜索器 runner（2026-08-09）
 *
 * 调度 GeneticAlgorithm 在 vs-arena spawn-profile 对局上搜索 MacroPolicy
 * 5 维基因的最优组合。每代：评估全种群（被测者 fitness）→ 锦标赛 + 交叉 +
 * 变异 + 精英保留 → 下一代。champion 用 holdout 独立种子复评防过拟合；
 * seed_pool 滚动让选择压力持续面对新地图。
 *
 * 用法（cd packages/arena-agent）：
 *   npx tsx scripts/ga-search.mts \
 *     [--pop 24] [--elites 2] [--gens 10] \
 *     [--seeds 1-4] [--holdout 5-6] [--seed-pool 1-12] [--rollover 3] \
 *     [--risk-lambda 0.5] [--prescreen 0.3] \
 *     [--workers 4] [--ticks 200] [--players 6] [--refill off|65|16|4|N] \
 *     [--seed 0] [--mut-sigma 0.12] [--crossover 0.8] [--tournament 3]
 *
 * 输出：每代 champion 基因 + best/avg fitness + holdout 曲线。
 */
import { performance } from "node:perf_hooks";
import {
  GA_MANIFEST_PATH,
  GA,
  DEFAULT_MACRO_GENOME,
  type MacroGenome,
  type SpawnProfileEvalSpec,
} from "../src/offline-learning/eval/ga.ts";

interface CliArgs {
  pop: number;
  elites: number;
  gens: number;
  seeds: readonly number[];
  holdout: readonly number[];
  seedPool: readonly number[];
  rollover: number;
  riskLambda: number;
  prescreen: number;
  workers: number;
  ticks: number;
  players: number;
  refillEveryTicks: number | null;
  seed: number;
  mutSigma: number;
  crossover: number;
  tournament: number;
}

function argValue(flag: string): string | undefined {
  const equals = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals !== undefined) return equals.slice(flag.length + 1);
  const index = process.argv.indexOf(flag);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return undefined;
}

function parseSeeds(raw: string | undefined, fallback: string): readonly number[] {
  const source = raw ?? fallback;
  const out: number[] = [];
  for (const part of source.split(",")) {
    const range = part.split("-").map(Number);
    if (range.length === 2) {
      for (let seed = range[0]!; seed <= range[1]!; seed += 1) out.push(seed);
    } else {
      out.push(range[0]!);
    }
  }
  return out;
}

const args: CliArgs = {
  pop: Number(argValue("--pop") ?? 24),
  elites: Number(argValue("--elites") ?? 2),
  gens: Number(argValue("--gens") ?? 10),
  seeds: parseSeeds(argValue("--seeds"), "1-4"),
  holdout: parseSeeds(argValue("--holdout"), "5-6"),
  seedPool: parseSeeds(argValue("--seed-pool"), "1-12"),
  rollover: Number(argValue("--rollover") ?? 3),
  riskLambda: Number(argValue("--risk-lambda") ?? 0.5),
  prescreen: Number(argValue("--prescreen") ?? 0),
  workers: Number(argValue("--workers") ?? 1),
  ticks: Number(argValue("--ticks") ?? 200),
  players: Number(argValue("--players") ?? 6),
  refillEveryTicks: (() => {
    const raw = argValue("--refill") ?? "off";
    return raw === "off" ? null : Number(raw);
  })(),
  seed: Number(argValue("--seed") ?? 0),
  mutSigma: Number(argValue("--mut-sigma") ?? 0.12),
  crossover: Number(argValue("--crossover") ?? 0.8),
  tournament: Number(argValue("--tournament") ?? 3),
};

if (args.seeds.length === 0) {
  console.error(`--seeds 解析为空（例：1-4 / 1,3,5）`);
  process.exit(1);
}
if (args.pop <= args.elites) {
  console.error(`--pop (${args.pop}) 必须大于 --elites (${args.elites})`);
  process.exit(1);
}

const evaluatorSpec: SpawnProfileEvalSpec = {
  kind: "spawn-profile",
  manifestPath: GA_MANIFEST_PATH,
  ticks: args.ticks,
  numPlayers: args.players,
  refillEveryTicks: args.refillEveryTicks,
  subjectPlannerConfig: { aggression: "aggressive", attackForce: 2 },
  opponentPlannerConfig: { aggression: "aggressive", attackForce: 2 },
};

const ga = new GA({
  popSize: args.pop,
  elites: args.elites,
  tournamentSize: args.tournament,
  mutSigma: args.mutSigma,
  crossoverRate: args.crossover,
  seed: args.seed,
  evalSeeds: args.seeds,
  holdoutSeeds: args.holdout,
  seedPool: args.seedPool,
  seedRollover: args.rollover,
  riskLambda: args.riskLambda,
  prescreen: args.prescreen,
  workers: args.workers,
  maxTicks: args.ticks,
  evaluatorSpec,
  initGenome: DEFAULT_MACRO_GENOME,
  progress: (done, total) => {
    process.stdout.write(`\r[eval] ${done}/${total}`);
  },
});

console.log(
  `ga-search：pop=${args.pop} elites=${args.elites} gens=${args.gens} ` +
    `seeds=[${args.seeds.join(",")}] holdout=[${args.holdout.join(",")}] ` +
    `seedPool=[${args.seedPool.join(",")}] rollover=${args.rollover} ` +
    `riskLambda=${args.riskLambda} prescreen=${args.prescreen} ` +
    `workers=${args.workers} ticks=${args.ticks} players=${args.players} ` +
    `refill=${args.refillEveryTicks ?? "off"} seed=${args.seed}`,
);
console.log("=".repeat(96));

ga.initPopulation();
const wallStart = performance.now();
const history: {
  generation: number;
  bestFitness: number;
  avgFitness: number;
  holdoutFitness: number | null;
  bestGenome: MacroGenome;
}[] = [];

for (let generation = 0; generation < args.gens; generation += 1) {
  process.stdout.write("\x1b[2K\r");
  const report = await ga.evaluate(generation, true);
  history.push({
    generation: report.generation,
    bestFitness: report.bestFitness,
    avgFitness: report.avgFitness,
    holdoutFitness: report.holdout?.fitness ?? null,
    bestGenome: report.bestGenome,
  });
  console.log(
    `gen ${String(generation).padStart(3)}: best=${report.bestFitness.toFixed(1)} ` +
      `avg=${report.avgFitness.toFixed(1)} ` +
      `holdout=${report.holdout?.fitness.toFixed(1) ?? "-"} ` +
      `champion=${JSON.stringify(report.bestGenome)}`,
  );
  if (generation < args.gens - 1) {
    await ga.nextGeneration();
  }
}

const wallElapsed = performance.now() - wallStart;
ga.close();

console.log("=".repeat(96));
const champion = history[history.length - 1] ?? null;
if (champion !== null) {
  console.log(`最终 champion（gen ${champion.generation}）：`);
  console.log(`  bestFitness = ${champion.bestFitness.toFixed(1)}`);
  console.log(`  holdout     = ${champion.holdoutFitness?.toFixed(1) ?? "n/a"}`);
  console.log(`  genome      = ${JSON.stringify(champion.bestGenome, null, 2)}`);
}
console.log("holdout 曲线（每代 champion 独立种子复评）：");
console.log(
  history
    .map(
      (entry) =>
        `g${entry.generation}:${entry.holdoutFitness?.toFixed(1) ?? "-"}`,
    )
    .join("  "),
);
console.log(`wall=${(wallElapsed / 1000).toFixed(2)}s`);
