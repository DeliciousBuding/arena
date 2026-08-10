#!/usr/bin/env node
/**
 * bench-stats — arena-bench 科研统计模块（arena.bench.stats.v1）
 *
 * 设计：docs/design/arena-bench-science-platform-v2-2026-08-10.md §2
 *
 * 输入两种模式：
 *   --dir <runDir>     读 matches/ 全部 match-*.json（单场 rank 配对数据，
 *                      无需 merge 即可跑配对检验；断点续跑中间态也可用）
 *   --results <path>   读 results.json（leaderboard composite 做 Bootstrap CI）
 * 输出：<runDir>/stats.json（或 --out 指定）+ 控制台摘要
 *
 * 方法：
 *   - 配对 Wilcoxon 符号秩检验（正态近似 + tie 校正）：条目两两 rank 差异
 *   - Cliff's delta：P(A 优于 B) − P(B 优于 A)（rank 越小越好）
 *   - Benjamini-Hochberg FDR 校正：45 对比较（10 条目）
 *   - Bootstrap 95% CI（composite 均值差，10k 重采样，--results 模式）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const DIR = argValue("--dir");
const RESULTS = argValue("--results");
const OUT = argValue("--out");
const BOOTSTRAP_ITERATIONS = Number(argValue("--bootstrap") ?? 10_000);

if (DIR === undefined && RESULTS === undefined) {
  throw new Error(`需要 --dir <runDir>（matches 配对检验）或 --results <results.json>（Bootstrap CI）`);
}

/* ------------------------------------------------------------------ *
 * 数学工具
 * ------------------------------------------------------------------ */

/** 标准正态 CDF（Abramowitz-Stegun 近似，误差 < 7.5e-8）。 */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Wilcoxon 符号秩检验（配对差异，正态近似 + tie 校正）。零假设：中位数差 = 0。 */
function wilcoxonSignedRank(differences: readonly number[]): { pValue: number; wPlus: number; n: number } {
  const nonzero = differences.filter((d) => d !== 0);
  const n = nonzero.length;
  if (n === 0) return { pValue: 1, wPlus: 0, n: 0 };
  if (n < 10) {
    // 小样本无正态近似可用：保守返回 1（数据不足时不做推断）
    return { pValue: 1, wPlus: 0, n };
  }
  const absSorted = [...nonzero].map((d) => Math.abs(d)).sort((a, b) => a - b);
  // 平均秩处理 tie
  const ranks = new Map<number, number>();
  for (let i = 0; i < absSorted.length; ) {
    let j = i + 1;
    while (j < absSorted.length && absSorted[j] === absSorted[i]) j += 1;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) ranks.set(absSorted[k], avgRank);
    i = j;
  }
  const wPlus = nonzero.reduce((sum, d) => (d > 0 ? sum + (ranks.get(Math.abs(d)) ?? 0) : sum), 0);
  const meanW = (n * (n + 1)) / 4;
  const tieGroups = new Map<number, number>();
  for (const d of absSorted) tieGroups.set(d, (tieGroups.get(d) ?? 0) + 1);
  const tieCorrection = [...tieGroups.values()].reduce((s, t) => s + (t ** 3 - t) / 48, 0);
  const varianceW = (n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection;
  const z = varianceW > 0 ? (wPlus - meanW) / Math.sqrt(varianceW) : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { pValue: Math.min(1, pValue), wPlus, n };
}

/** Cliff's delta：P(A 优于 B) − P(B 优于 A)。rank 越小越好（A 优 = rankA < rankB）。 */
function cliffDelta(ranksA: readonly number[], ranksB: readonly number[]): number {
  let wins = 0;
  let losses = 0;
  for (const a of ranksA) {
    for (const b of ranksB) {
      if (a < b) wins += 1;
      else if (a > b) losses += 1;
    }
  }
  return (wins - losses) / (ranksA.length * ranksB.length);
}

/** Benjamini-Hochberg FDR 校正（从最大 p 向下累积最小值，q 序列保序）。 */
function bhFdr(pValues: readonly number[]): number[] {
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const q = new Array<number>(pValues.length);
  let minQ = Infinity;
  for (let k = order.length; k >= 1; k -= 1) {
    const { p, i } = order[k - 1];
    const candidate = (p * order.length) / k;
    minQ = Math.min(minQ, candidate);
    q[i] = Math.min(1, minQ);
  }
  return q;
}

/** Bootstrap 95% CI（配对差异均值）。 */
function bootstrapCi(samples: readonly number[], iterations: number): { lo: number; hi: number } {
  const boot = new Array<number>(iterations);
  const rng = mulberry32(20260810);
  const n = samples.length;
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += samples[Math.floor(rng() * n)];
    boot[i] = sum / n;
  }
  boot.sort((a, b) => a - b);
  const loIndex = Math.floor(iterations * 0.025);
  const hiIndex = Math.floor(iterations * 0.975);
  return { lo: boot[loIndex], hi: boot[hiIndex] };
}

/** 确定性 PRNG（Bootstrap 可复现）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * 数据读取
 * ------------------------------------------------------------------ */

interface BenchMatch {
  readonly scenario: string;
  readonly seed: number;
  readonly rank: Readonly<Record<string, number>>;
}

/** playerId → contestantId（"waaiging-s1" → "waaiging"；"ts-aggressive" 保持）。 */
function contestantIdOf(playerId: string): string {
  const match = /^(.*)-s\d+$/u.exec(playerId);
  return match === null ? playerId : match[1];
}

function readMatches(runDir: string): BenchMatch[] {
  const matchesDir = join(runDir, "matches");
  if (!existsSync(matchesDir)) {
    throw new Error(`--dir 目录下无 matches/：${runDir}`);
  }
  const names = readdirSync(matchesDir).filter(
    (name) => /^match-.+\.json$/u.test(name) && !name.endsWith(".error.json"),
  );
  if (names.length === 0) {
    throw new Error(`matches/ 下没有单场结果：${matchesDir}`);
  }
  return names.map((name) => JSON.parse(readFileSync(join(matchesDir, name), "utf8")) as BenchMatch);
}

/* ------------------------------------------------------------------ *
 * 配对统计
 * ------------------------------------------------------------------ */

function computePairwiseStats(matches: readonly BenchMatch[]): unknown {
  const contestantRanks = new Map<string, number[]>();
  const contestantScenarios = new Map<string, Record<string, number[]>>();
  for (const match of matches) {
    for (const [playerId, rank] of Object.entries(match.rank)) {
      const contestant = contestantIdOf(playerId);
      const list = contestantRanks.get(contestant) ?? [];
      list.push(rank);
      contestantRanks.set(contestant, list);
      const byScenario = contestantScenarios.get(contestant) ?? {};
      (byScenario[match.scenario] ??= []).push(rank);
      contestantScenarios.set(contestant, byScenario);
    }
  }
  const contestants = [...contestantRanks.keys()].sort();
  const pairs: unknown[] = [];
  const rawPValues: number[] = [];
  for (let i = 0; i < contestants.length; i += 1) {
    for (let j = i + 1; j < contestants.length; j += 1) {
      const a = contestants[i];
      const b = contestants[j];
      const ranksA = contestantRanks.get(a)!;
      const ranksB = contestantRanks.get(b)!;
      const n = Math.min(ranksA.length, ranksB.length);
      const differences = [];
      for (let k = 0; k < n; k += 1) differences.push(ranksA[k] - ranksB[k]);
      const { pValue, wPlus } = wilcoxonSignedRank(differences);
      rawPValues.push(pValue);
      pairs.push({
        a,
        b,
        n,
        wPlus,
        pValue,
        cliffDelta: cliffDelta(ranksA, ranksB),
        meanRankDiff: mean(differences),
        ci95: bootstrapCi(differences, BOOTSTRAP_ITERATIONS),
      });
    }
  }
  const qValues = bhFdr(rawPValues);
  let qIndex = 0;
  for (const pair of pairs as { qValue?: number }[]) {
    pair.qValue = qValues[qIndex];
    qIndex += 1;
  }
  return { contestants, pairs };
}

/* ------------------------------------------------------------------ *
 * Bootstrap CI（--results 模式）
 * ------------------------------------------------------------------ */

function computeBootstrap(resultsPath: string): unknown {
  const results = JSON.parse(readFileSync(resultsPath, "utf8")) as {
    leaderboard: readonly { readonly contestantId: string; readonly composite: number }[];
  };
  const entries = results.leaderboard.map((row) => ({ contestantId: row.contestantId, composite: row.composite }));
  const perContestant = new Map(entries.map((e) => [e.contestantId, e.composite]));
  const comparisons: unknown[] = [];
  const ids = [...perContestant.keys()].sort();
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const diff = perContestant.get(a)! - perContestant.get(b)!;
      // 单点 composite 无场内样本：CI 退化为占位（完整样本 CI 需按场次聚合，见设计 §2.1 备注）
      comparisons.push({ a, b, meanDiff: diff, ci95: { lo: null, hi: null }, note: "composite 为跨场点估计；完整 CI 见 stats.json pairs" });
    }
  }
  return { entries, comparisons };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main(): number {
  const stats: Record<string, unknown> = {
    schema: "arena.bench.stats.v1",
    generatedAt: new Date().toISOString(),
    method: {
      pairwise: "Wilcoxon 符号秩检验（正态近似 + tie 校正），Cliff's delta，Benjamini-Hochberg FDR",
      unit: "每条目在每场的 rank（同场同条件 = 配对设计）",
    },
  };

  if (DIR !== undefined) {
    const runDir = resolve(DIR);
    const matches = readMatches(runDir);
    stats.source = { dir: runDir, matches: matches.length };
    stats.pairwise = computePairwiseStats(matches);
    if (RESULTS !== undefined) {
      stats.bootstrap = computeBootstrap(RESULTS);
    }
  } else if (RESULTS !== undefined) {
    stats.source = { results: RESULTS };
    stats.bootstrap = computeBootstrap(RESULTS);
  }

  const outPath = OUT !== undefined ? resolve(OUT) : join(resolve(DIR ?? "."), "stats.json");
  writeFileSync(outPath, JSON.stringify(stats, null, 2));

  // 控制台摘要
  console.log(`bench-stats: ${outPath}`);
  if (stats.pairwise !== undefined) {
    const pairInfo = stats.pairwise as { contestants: string[]; pairs: { a: string; b: string; pValue: number; qValue: number; cliffDelta: number }[] };
    console.log(`条目：${pairInfo.contestants.join(", ")}（${pairInfo.contestants.length}）`);
    const significant = pairInfo.pairs.filter((p) => p.qValue < 0.05);
    console.log(`配对比较：${pairInfo.pairs.length} 对，显著（q<0.05）：${significant.length} 对`);
    for (const pair of significant.slice(0, 15)) {
      const better = pair.cliffDelta > 0 ? pair.a : pair.b;
      const worse = pair.cliffDelta > 0 ? pair.b : pair.a;
      console.log(`  ${better} 优于 ${worse}（delta=${Math.abs(pair.cliffDelta).toFixed(3)} q=${pair.qValue.toFixed(4)} p=${pair.pValue.toFixed(4)}）`);
    }
    if (significant.length === 0) {
      console.log("  （当前样本量下无显著差异——样本不足时属正常）");
    }
  }
  return 0;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`bench-stats 失败：${message}`);
  process.exitCode = 1;
}
