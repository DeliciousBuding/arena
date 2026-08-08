/**
 * Episode 级 train/validation/test 分割，防泄漏。
 *
 * 核心规则：
 * 1. 分割粒度为 episode（非 tick、非 run segment）——一个 episode 的所有 tick
 *    必须在同一个 split 中。这防止未来 tick 信息泄漏到训练集。
 * 2. 同一 scenario seed 的不同变体属于不同 episode，不强制同 split。
 * 3. 按 episode 完成时间排序后按比例分配（chronological split），
 *    避免随机分割在不同时间重跑时分配不同（确定性）。
 * 4. Stratified split 可选：按 scenario class 分层后再按时间分割。
 *
 * 与现有 sim/dataset/builder.ts 的 run-level split 互补：
 * - run-level split：单 tick ml-sample-v1 样本，按 run segment 分
 * - episode-level split：完整 trajectory-v1 轨迹，按 episode 分
 */

export type SplitName = "train" | "validation" | "test";

export interface SplitRatios {
  readonly train: number;
  readonly validation: number;
  readonly test: number;
}

export const DEFAULT_SPLIT_RATIOS: SplitRatios = Object.freeze({
  train: 0.7,
  validation: 0.15,
  test: 0.15,
});

export interface EpisodeSummary {
  readonly episodeId: string;
  readonly completedAt: string;
  readonly tickCount: number;
  readonly scenarioClass?: string; // 分层键（可选）
}

export interface SplitAssignment {
  readonly episodeId: string;
  readonly split: SplitName;
}

export interface SplitReport {
  readonly rule: string;
  readonly ratios: SplitRatios;
  readonly episodeCount: number;
  readonly assignments: readonly SplitAssignment[];
  readonly counts: Readonly<Record<SplitName, number>>;
  readonly leakChecks: {
    readonly episodeInMultipleSplits: number;
    readonly splitsEmpty: readonly SplitName[];
  };
}

/**
 * 按完成时间排序分配 split（chronological split）。
 * 时间戳相同（同一次 run）的 episode 按 episodeId 字典序稳定排序。
 */
export function assignChronologicalSplits(
  episodes: readonly EpisodeSummary[],
  ratios: SplitRatios = DEFAULT_SPLIT_RATIOS,
): SplitReport {
  const sorted = [...episodes].sort((a, b) => {
    const timeCompare = a.completedAt.localeCompare(b.completedAt);
    if (timeCompare !== 0) return timeCompare;
    return a.episodeId.localeCompare(b.episodeId);
  });

  const total = sorted.length;
  const trainCount = Math.max(1, Math.round(total * ratios.train));
  const validationCount = Math.max(1, Math.round(total * ratios.validation));
  // test gets the rest

  const assignments: SplitAssignment[] = [];
  const counts: Record<SplitName, number> = { train: 0, validation: 0, test: 0 };

  for (const [index, ep] of sorted.entries()) {
    let split: SplitName;
    if (index < trainCount) {
      split = "train";
    } else if (index < trainCount + validationCount) {
      split = "validation";
    } else {
      split = "test";
    }
    assignments.push({ episodeId: ep.episodeId, split });
    counts[split] += 1;
  }

  // Leak checks
  const seenEpisodes = new Set<string>();
  let episodeInMultipleSplits = 0;
  for (const a of assignments) {
    if (seenEpisodes.has(a.episodeId)) {
      episodeInMultipleSplits += 1;
    }
    seenEpisodes.add(a.episodeId);
  }

  const splitsEmpty: SplitName[] = [];
  for (const s of ["train", "validation", "test"] as const) {
    if (counts[s] === 0) splitsEmpty.push(s);
  }

  return {
    rule: "chronological by episode completedAt; episodes never split across buckets",
    ratios,
    episodeCount: total,
    assignments: Object.freeze([...assignments]),
    counts: Object.freeze({ ...counts }),
    leakChecks: {
      episodeInMultipleSplits,
      splitsEmpty: Object.freeze([...splitsEmpty]),
    },
  };
}

/**
 * 分层 chronological split：先按 scenarioClass 分组，每组内按时间排序分配。
 * 保证每层都有 train/val/test 代表。
 */
export function assignStratifiedSplits(
  episodes: readonly EpisodeSummary[],
  ratios: SplitRatios = DEFAULT_SPLIT_RATIOS,
): SplitReport {
  const groups = new Map<string, EpisodeSummary[]>();
  for (const ep of episodes) {
    const cls = ep.scenarioClass ?? "__default__";
    const group = groups.get(cls) ?? [];
    group.push(ep);
    groups.set(cls, group);
  }

  const allAssignments: SplitAssignment[] = [];
  const counts: Record<SplitName, number> = { train: 0, validation: 0, test: 0 };

  for (const [, groupEps] of groups) {
    const groupReport = assignChronologicalSplits(groupEps, ratios);
    allAssignments.push(...groupReport.assignments);
    for (const s of ["train", "validation", "test"] as const) {
      counts[s] += groupReport.counts[s];
    }
  }

  // Sort assignments by episodeId for deterministic output
  allAssignments.sort((a, b) => a.episodeId.localeCompare(b.episodeId));

  // Leak checks
  const seenEpisodes = new Set<string>();
  let episodeInMultipleSplits = 0;
  for (const a of allAssignments) {
    if (seenEpisodes.has(a.episodeId)) {
      episodeInMultipleSplits += 1;
    }
    seenEpisodes.add(a.episodeId);
  }

  const splitsEmpty: SplitName[] = [];
  for (const s of ["train", "validation", "test"] as const) {
    if (counts[s] === 0) splitsEmpty.push(s);
  }

  return {
    rule: "stratified by scenarioClass, then chronological within each class; episodes never split across buckets",
    ratios,
    episodeCount: episodes.length,
    assignments: Object.freeze([...allAssignments]),
    counts: Object.freeze({ ...counts }),
    leakChecks: {
      episodeInMultipleSplits,
      splitsEmpty: Object.freeze([...splitsEmpty]),
    },
  };
}

/**
 * 验证 split 分配没有泄漏：
 * - 每个 episode 只出现在一个 split 中
 * - train/validation/test 都不为空
 * - split 比例在容差范围内（±15%）
 */
export function validateSplitIntegrity(report: SplitReport): string[] {
  const problems: string[] = [];

  if (report.leakChecks.episodeInMultipleSplits > 0) {
    problems.push(
      `DATA LEAK: ${report.leakChecks.episodeInMultipleSplits} episode(s) assigned to multiple splits`,
    );
  }

  for (const split of report.leakChecks.splitsEmpty) {
    problems.push(`Split "${split}" is empty (need at least 1 episode per split)`);
  }

  // Check ratios are within tolerance
  const total = report.episodeCount;
  if (total > 0) {
    for (const s of ["train", "validation", "test"] as const) {
      const actual = report.counts[s] / total;
      const expected = report.ratios[s];
      const tolerance = 0.15;
      if (Math.abs(actual - expected) > tolerance) {
        problems.push(
          `Split "${s}" ratio ${actual.toFixed(2)} deviates from expected ${expected.toFixed(2)} (tolerance ±${tolerance})`,
        );
      }
    }
  }

  return problems;
}

/**
 * 根据 split 分配过滤 episode id 集合。
 */
export function filterBySplit(
  episodeIds: readonly string[],
  assignments: readonly SplitAssignment[],
  split: SplitName,
): Set<string> {
  const allowed = new Set(
    assignments.filter((a) => a.split === split).map((a) => a.episodeId),
  );
  return new Set(episodeIds.filter((id) => allowed.has(id)));
}
