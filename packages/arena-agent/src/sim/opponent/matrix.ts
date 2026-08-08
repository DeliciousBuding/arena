/**
 * 交叉矩阵 runner（M2，strategy-versioning-v1 §8）：
 *  版本 × 对手 全组合各跑 N seeds 1v1（复用 runMatch），每个组合输出
 *  胜率 + Wilson 95% CI + 均资源。版本与对手都收敛到 TournEntry（统一协议），
 *  纯逻辑可单测（vs-arena.mts 只做参数解析/展示/落盘）。
 */
import { runMatch, type MatchResult, type TournEntry } from "./tournament.ts";
import { mean, wilson95 } from "./stats.ts";

/** 我方一个版本（id/desc + 版本源元数据，供 evidence participants 用）。 */
export interface MatrixVersion {
  readonly entry: TournEntry;
  readonly kind: "config" | "git-tag" | "worktree-path";
  /** 原始来源串：注册表名 / path:<根> / 配置档名。 */
  readonly source: string;
}

/** 对手（每 seed 独立构造条目：id 约定 <name>-s<seed>）。 */
export interface MatrixOpponent {
  readonly name: string;
  readonly desc: string;
  readonly kind: "reference-python" | "http";
  readonly source: string;
  entry(seed: number): TournEntry;
}

/** 单场 1v1 结果 + 其 seed（MatchResult 不带 seed，统计需配对）。 */
export interface SeededMatchResult {
  readonly seed: number;
  readonly result: MatchResult;
}

/** 一个"版本 × 对手"组合的完整统计。 */
export interface MatrixComboResult {
  readonly version: MatrixVersion;
  readonly opponent: MatrixOpponent;
  readonly seeds: readonly number[];
  readonly matches: readonly SeededMatchResult[];
  readonly versionWins: number;
  readonly opponentWins: number;
  readonly draws: number;
  readonly versionWinRate: number;
  readonly opponentWinRate: number;
  readonly versionWilson95: [number, number];
  readonly opponentWilson95: [number, number];
  readonly versionMeanResources: number;
  readonly opponentMeanResources: number;
}

export interface MatrixOptions {
  readonly ticks: number;
  readonly rulesPath: string;
  readonly validatePlans?: boolean;
  /** undefined=4（官方节奏）；null=关闭；N=每 N tick。透传 runMatch。 */
  readonly refillEveryTicks?: number | null;
  /** 自定义场景（survey 窗口等），透传 runMatch；缺省合成布局。 */
  readonly scenarioFor?: (seed: number, opponentId: string) => unknown;
  /** 对局 JSONL 落盘目录（recorder.ts，与 evidence 并存）。 */
  readonly recordDir?: string;
}

/** 对手在某 seed 对局中的参赛 id（<name>-s<seed>，与 opponent.entry 约定一致）。 */
function opponentPlayerId(opponent: MatrixOpponent, seed: number): string {
  return `${opponent.name}-s${seed}`;
}

/** 跑全部版本 × 对手组合（每组合 N seeds 1v1）。 */
export function runMatrix(
  versions: readonly MatrixVersion[],
  opponents: readonly MatrixOpponent[],
  seeds: readonly number[],
  opts: MatrixOptions,
): MatrixComboResult[] {
  const results: MatrixComboResult[] = [];
  for (const version of versions) {
    for (const opponent of opponents) {
      const matches: SeededMatchResult[] = [];
      for (const seed of seeds) {
        const opponentEntry = opponent.entry(seed);
        const recordTo =
          opts.recordDir === undefined
            ? undefined
            : `${opts.recordDir}/${version.entry.id}-vs-${opponent.name}-s${seed}.jsonl`;
        matches.push({
          seed,
          result: runMatch(version.entry, opponentEntry, seed, opts.ticks, opts.rulesPath, {
            validatePlans: opts.validatePlans ?? false,
            refillEveryTicks: opts.refillEveryTicks,
            scenario: opts.scenarioFor?.(seed, opponentEntry.id),
            ...(recordTo === undefined ? {} : { recordTo }),
          }),
        });
      }
      const versionWins = matches.filter((m) => m.result.winner === version.entry.id).length;
      const opponentWins = matches.filter(
        (m) => m.result.winner === opponentPlayerId(opponent, m.seed),
      ).length;
      results.push({
        version,
        opponent,
        seeds,
        matches,
        versionWins,
        opponentWins,
        draws: matches.length - versionWins - opponentWins,
        versionWinRate: versionWins / matches.length,
        opponentWinRate: opponentWins / matches.length,
        versionWilson95: wilson95(versionWins, matches.length),
        opponentWilson95: wilson95(opponentWins, matches.length),
        versionMeanResources: mean(
          matches.map((m) => m.result.finalResources[version.entry.id] ?? 0),
        ),
        opponentMeanResources: mean(
          matches.map((m) => m.result.finalResources[opponentPlayerId(opponent, m.seed)] ?? 0),
        ),
      });
    }
  }
  return results;
}
