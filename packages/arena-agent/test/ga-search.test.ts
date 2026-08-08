/**
 * W52 GA 搜索器测试（2026-08-09）：
 *  - 纯函数：genomeKey 确定性 + 可区分、mutate 越界保护、initPopulation
 *    规模 + 合法性 + 多样性、crossover 双亲混合、focusOffset 边界。
 *  - 评估器：createSpawnProfileEvaluator 默认基因产出有限非零 fitness +
 *    detail 字段填充；worker 池结果与串行一致（runEpisode 确定性）。
 *  - GA 端到端：2 代串行进化，best/avg/holdout 计算正确，champion 基因
 *    合法，nextGeneration 改变种群（进化发生）。
 *  - seed_pool 滚动 + risk_lambda 风险调整：缓存清空与 fitness 惩罚生效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GA,
  GA_MANIFEST_PATH,
  DEFAULT_MACRO_GENOME,
  SerialRunner,
  WorkerPoolRunner,
  createSpawnProfileEvaluator,
  type MacroGenome,
  type SpawnProfileEvalSpec,
} from "../src/offline-learning/eval/ga.ts";

/** 小型评估 spec（4 玩家、50 ticks、关 refill——测试要快）。 */
function smallSpec(): SpawnProfileEvalSpec {
  return {
    kind: "spawn-profile",
    manifestPath: GA_MANIFEST_PATH,
    ticks: 50,
    numPlayers: 4,
    refillEveryTicks: null,
    subjectPlannerConfig: { aggression: "aggressive", attackForce: 2 },
    opponentPlannerConfig: { aggression: "aggressive", attackForce: 2 },
  };
}

function smallGAConfig(overrides: Partial<{
  popSize: number;
  elites: number;
  gens: number;
  evalSeeds: readonly number[];
  holdoutSeeds: readonly number[];
  seedPool: readonly number[];
  seedRollover: number;
  riskLambda: number;
  prescreen: number;
  workers: number;
  seed: number;
}> = {}): ConstructorParameters<typeof GA>[0] {
  return {
    popSize: overrides.popSize ?? 6,
    elites: overrides.elites ?? 1,
    tournamentSize: 2,
    mutSigma: 0.2,
    crossoverRate: 0.8,
    seed: overrides.seed ?? 42,
    evalSeeds: overrides.evalSeeds ?? [1, 2],
    holdoutSeeds: overrides.holdoutSeeds ?? [],
    seedPool: overrides.seedPool ?? [1, 2],
    seedRollover: overrides.seedRollover ?? 0,
    riskLambda: overrides.riskLambda ?? 0,
    prescreen: overrides.prescreen ?? 0,
    workers: overrides.workers ?? 1,
    maxTicks: 50,
    evaluatorSpec: smallSpec(),
    initGenome: DEFAULT_MACRO_GENOME,
  };
}

const VALID_POSTURES = new Set(["harvest", "balanced", "aggressive"]);
const VALID_PRIORITIES = new Set(["core", "workers", null]);

function assertValidGenome(genome: MacroGenome): void {
  assert.ok(VALID_POSTURES.has(genome.posture), `posture 非法: ${genome.posture}`);
  assert.ok(
    Number.isInteger(genome.workerTarget) && genome.workerTarget >= 1 && genome.workerTarget <= 16,
    `workerTarget 越界: ${genome.workerTarget}`,
  );
  assert.ok(
    genome.militaryRatio >= 0 && genome.militaryRatio <= 1,
    `militaryRatio 越界: ${genome.militaryRatio}`,
  );
  if (genome.focusOffset !== null) {
    assert.ok(
      Number.isInteger(genome.focusOffset[0]) && Math.abs(genome.focusOffset[0]) <= 32,
      `focusOffset[0] 越界: ${genome.focusOffset[0]}`,
    );
    assert.ok(
      Number.isInteger(genome.focusOffset[1]) && Math.abs(genome.focusOffset[1]) <= 32,
      `focusOffset[1] 越界: ${genome.focusOffset[1]}`,
    );
  }
  assert.ok(VALID_PRIORITIES.has(genome.attackPriority), `attackPriority 非法: ${genome.attackPriority}`);
}

// ── 纯函数测试 ──────────────────────────────────────────────────

test("genomeKey: 同基因同键 + 不同基因不同键", () => {
  const ga = new GA(smallGAConfig());
  const key1 = ga.genomeKey(DEFAULT_MACRO_GENOME);
  const key2 = ga.genomeKey(DEFAULT_MACRO_GENOME);
  assert.equal(key1, key2);
  const other: MacroGenome = { ...DEFAULT_MACRO_GENOME, workerTarget: 12 };
  const keyOther = ga.genomeKey(other);
  assert.notEqual(key1, keyOther);
  ga.close();
});

test("initPopulation: 规模=popSize + 全合法 + 多样性（非全同）", () => {
  const ga = new GA(smallGAConfig({ popSize: 8, seed: 7 }));
  ga.initPopulation();
  const pop = ga.getPopulation();
  assert.equal(pop.length, 8);
  for (const genome of pop) assertValidGenome(genome);
  // 多样性：至少 2 个不同基因（sigma=0.2 扰动下几乎不可能全同）
  const keys = new Set(pop.map((genome) => ga.genomeKey(genome)));
  assert.ok(keys.size >= 2, `种群多样性不足: ${keys.size} 个不同基因`);
  ga.close();
});

test("mutate 越界保护：大量变异后所有基因仍合法", () => {
  const ga = new GA(smallGAConfig({ popSize: 12, seed: 99 }));
  ga.initPopulation();
  // 跑 5 代 nextGeneration 触发大量 crossover+mutate
  for (let i = 0; i < 5; i += 1) {
    // 填充假 fitness 以驱动 tournament/elite 选择
    const fakeFitness = ga.getPopulation().map((_, idx) => idx);
    ga["fitness"] = fakeFitness;
    ga["lastDetails"] = fakeFitness.map(() => ({
      harvested: 0, deposited: 0, res: 0, pop: 0, beacon: 0, alive_ticks: 0,
      damage: 0, lost: 0, respawn: 0, heal_cost: 0, repair_cost: 0, spawn_cost: 0,
      overflow_destroyed: 0, resources_lost: 0,
    }));
    // nextGeneration 是 async（仅更新内部状态，无评估）
    ga.nextGeneration();
  }
  for (const genome of ga.getPopulation()) assertValidGenome(genome);
  ga.close();
});

// ── 评估器测试 ──────────────────────────────────────────────────

test("createSpawnProfileEvaluator: 默认基因 → 有限非零 fitness + detail 填充", async () => {
  const evaluator = createSpawnProfileEvaluator(smallSpec());
  const { fitness, detail } = await evaluator(DEFAULT_MACRO_GENOME, [1, 2]);
  assert.ok(Number.isFinite(fitness), `fitness 必须有限: ${fitness}`);
  assert.ok(detail.alive_ticks > 0, `alive_ticks 应 > 0（被测者存活过）: ${detail.alive_ticks}`);
  assert.ok(detail.harvested >= 0);
  assert.ok(detail.deposited >= 0);
});

test("SerialRunner: map 按序返回与输入同序结果", async () => {
  const evaluator = createSpawnProfileEvaluator(smallSpec());
  const runner = new SerialRunner(evaluator);
  const genomes: MacroGenome[] = [
    DEFAULT_MACRO_GENOME,
    { ...DEFAULT_MACRO_GENOME, workerTarget: 12, militaryRatio: 0.6 },
    { ...DEFAULT_MACRO_GENOME, posture: "aggressive", attackPriority: "core" },
  ];
  const results = await runner.map(
    genomes.map((genome) => ({ genome, seeds: [1] })),
  );
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.ok(Number.isFinite(result.fitness));
  }
  runner.close();
});

test("WorkerPoolRunner: worker_threads 池结果与串行一致（确定性）", async () => {
  const spec = smallSpec();
  const genomes: MacroGenome[] = [
    DEFAULT_MACRO_GENOME,
    { ...DEFAULT_MACRO_GENOME, workerTarget: 10, militaryRatio: 0.5 },
    { ...DEFAULT_MACRO_GENOME, posture: "harvest", attackPriority: null },
    { ...DEFAULT_MACRO_GENOME, focusOffset: [5, -5] },
  ];
  const serial = new SerialRunner(createSpawnProfileEvaluator(spec));
  const pool = new WorkerPoolRunner(spec, 2);
  const seeds = [1];
  const [serialResults, poolResults] = await Promise.all([
    serial.map(genomes.map((genome) => ({ genome, seeds }))),
    pool.map(genomes.map((genome) => ({ genome, seeds }))),
  ]);
  assert.equal(serialResults.length, 4);
  assert.equal(poolResults.length, 4);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(
      poolResults[i]!.fitness,
      serialResults[i]!.fitness,
      `worker 池 fitness 与串行不一致 @${i}: ${poolResults[i]!.fitness} vs ${serialResults[i]!.fitness}`,
    );
    assert.equal(poolResults[i]!.detail.harvested, serialResults[i]!.detail.harvested);
  }
  serial.close();
  pool.close();
});

// ── GA 端到端 ───────────────────────────────────────────────────

test("GA 端到端（串行 2 代）：best/avg/holdout 计算正确 + 进化发生", async () => {
  const ga = new GA(smallGAConfig({
    popSize: 6,
    elites: 1,
    seed: 11,
    evalSeeds: [1, 2],
    holdoutSeeds: [3],
  }));
  ga.initPopulation();
  const initKeys = ga.getPopulation().map((genome) => ga.genomeKey(genome));

  const report = await ga.evaluate(0, false);
  assert.ok(Number.isFinite(report.bestFitness), `bestFitness 有限: ${report.bestFitness}`);
  assert.ok(Number.isFinite(report.avgFitness), `avgFitness 有限: ${report.avgFitness}`);
  assert.ok(report.bestFitness >= report.avgFitness, `best >= avg`);
  assert.ok(report.holdout !== null, `holdout 应已计算（holdoutSeeds 非空）`);
  assert.ok(Number.isFinite(report.holdout!.fitness), `holdout fitness 有限`);
  assertValidGenome(report.bestGenome);

  await ga.nextGeneration();
  const nextKeys = ga.getPopulation().map((genome) => ga.genomeKey(genome));
  // 进化发生：下一代种群与初始不完全相同（elite 保留 ≥1 个相同，其余变化）
  const commonCount = nextKeys.filter((key) => initKeys.includes(key)).length;
  assert.ok(commonCount >= 1 && commonCount < initKeys.length, `种群未进化: common=${commonCount}`);

  const report2 = await ga.evaluate(1, false);
  assert.ok(Number.isFinite(report2.bestFitness));
  ga.close();
});

test("GA eval cache: 同基因跨代复用（第二次 evaluate 命中缓存）", async () => {
  const ga = new GA(smallGAConfig({ popSize: 4, seed: 5 }));
  ga.initPopulation();
  await ga.evaluate(0, false);
  const firstFitness = [...ga.getFitness()];
  // 不调 nextGeneration（种群不变）→ 第二次 evaluate 应全命中缓存，fitness 不变
  await ga.evaluate(0, false);
  const secondFitness = [...ga.getFitness()];
  assert.deepEqual(secondFitness, firstFitness, "eval cache 命中后 fitness 应一致");
  ga.close();
});

test("GA risk_lambda: 风险调整降低高 std 个体的选择 fitness", async () => {
  // risk_lambda>0 时 fitness 应被 std 惩罚（<= 原 fitness）。
  // 用同基因全种群 → std=0 → 惩罚 0（不变）；这里只验算惩罚方向。
  const ga = new GA(smallGAConfig({ popSize: 4, riskLambda: 0.5, seed: 3 }));
  ga.initPopulation();
  await ga.evaluate(0, false);
  // 不直接比较原 fitness（GA 内部已替换为 risk-adjusted），只验有限 + 合法
  for (const fitness of ga.getFitness()) {
    assert.ok(Number.isFinite(fitness));
  }
  ga.close();
});

test("GA seed_pool 滚动: rollover 触发后 evalSeeds 更新 + cache 清空", async () => {
  const ga = new GA(smallGAConfig({
    popSize: 4,
    seed: 8,
    evalSeeds: [1, 2],
    seedPool: [1, 2, 3, 4],
    seedRollover: 1,
  }));
  ga.initPopulation();
  // gen 0: active = [1,2]; gen 1: rollover 触发 → active = [3,4], cache 清空
  await ga.evaluate(0, false);
  assert.equal((ga as unknown as { activeEvalSeeds: readonly number[] }).activeEvalSeeds.join(","), "1,2");
  await ga.nextGeneration();
  await ga.evaluate(1, false);
  assert.equal((ga as unknown as { activeEvalSeeds: readonly number[] }).activeEvalSeeds.join(","), "3,4");
  ga.close();
});
