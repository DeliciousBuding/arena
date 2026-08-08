/**
 * 长征目标评分（migration-long-march-v1 §4-A，M7，2026-08-09）。
 *
 * 目的地决策不拍脑袋：候选目标按 资源富集 / 安全 / 会合约束 评分，
 * 资源格/障碍/测绘未知带惩罚。设计红线：富集点是测绘数据（t2 带
 * x -100~0 实证 576 矿格）而非地图原点；目标可被 REPLAN 更新。
 *
 * 纯函数；conductor PLAN 阶段调用（重评估 §4-F 同源）。
 */

import type { MigrationPosition } from "./plan.ts";

export interface TargetSurveyInput {
  /** 新鲜资源目击（lastSeenTick 距今 ≤ freshWindow 视为新鲜）。 */
  readonly resources: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
  /** 活跃敌核目击（lastSeenTick 距今 ≤ activeWindow 视为活跃）。 */
  readonly enemyCores: readonly { readonly x: number; readonly y: number; readonly lastSeenTick: number }[];
  readonly obstacleCells?: readonly (readonly [number, number])[];
  /** 已知资源格（历史 seen_count>0，辅助评分；可空）。 */
  readonly knownResourceCells?: readonly (readonly [number, number])[];
  /**
   * W60（direction-commitment-v1，竞品 "core 方向承诺迟滞" 对照）：上一轮
   * PLAN/REPLAN 选定的迁移目标（方向承诺锚点）。提供时，候选目标若落在
   * `commitmentBand` Chebyshev 半径内（=方向未变），加 `commitmentBonus`
   * 分——防止每 tick REPLAN 因微小资源波动就换方向（迁移换向有实际成本：
   * 重新探路/集结/清路）。null/undefined = 无承诺（零回归）。
   */
  readonly lastTarget?: Readonly<{ readonly x: number; readonly y: number }> | null;
}

export interface TargetScoreConfig {
  /** 评分资源半径（Chebyshev）。 */
  readonly radius: number;
  /** 目标带新鲜矿下限（低于 → 惩罚/拒绝）。 */
  readonly minFreshResources: number;
  /** 活跃敌核硬门槛半径。 */
  readonly enemySafeRadius: number;
  /** 测绘未知带惩罚系数（0-1：候选带测绘覆盖越少惩罚越重）。 */
  readonly unknownPenalty: number;
  /**
   * W60（direction-commitment-v1）：方向承诺迟滞带（Chebyshev 半径）。
   * 候选距 `survey.lastTarget` ≤ 此值视为"方向未变" → 加 `commitmentBonus`。
   * undefined = 不启用方向承诺（零回归）。
   */
  readonly commitmentBand?: number;
  /**
   * W60：方向承诺加分（落 commitmentBand 内的候选获得此分）。与
   * `commitmentBand` 成对启用；任一 undefined = 零回归。
   */
  readonly commitmentBonus?: number;
}

export const DEFAULT_TARGET_SCORE_CONFIG: TargetScoreConfig = {
  radius: 30,
  minFreshResources: 12,
  enemySafeRadius: 30,
  unknownPenalty: 0.5,
};

export interface TargetScore {
  readonly candidate: MigrationPosition;
  /** 总分（资源分 - 安全惩罚 - 未知惩罚 + 方向承诺；越高越好）。 */
  readonly score: number;
  readonly freshResources: number;
  readonly activeEnemyCores: number;
  readonly knownResources: number;
  /** 测绘覆盖（半径内已知矿格/半径内总格数 的代理：knownResources 数）。 */
  readonly coverage: number;
  /** W60：是否命中方向承诺带（true = 候选与 lastTarget 同向，已加成）。 */
  readonly directionCommitted: boolean;
  readonly reasons: readonly string[];
}

const chebyshev = (first: MigrationPosition, second: MigrationPosition): number =>
  Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));

/**
 * 单候选评分：
 * - 资源分：半径内新鲜资源数（refill-aware，新鲜窗口内为准）；
 * - 安全：半径内活跃敌核 > 0 → 硬性扣分（不可选）；
 * - 未知惩罚：半径内已知矿格过少（测绘盲区）→ 扣分（需探路前置）。
 * 返回 reasons 供遥测审计。
 */
export function scoreTarget(
  candidate: MigrationPosition,
  survey: TargetSurveyInput,
  config: TargetScoreConfig,
  tick: number,
): TargetScore {
  const reasons: string[] = [];
  let freshResources = 0;
  let activeEnemyCores = 0;
  let knownResources = 0;

  for (const resource of survey.resources) {
    if (chebyshev(candidate, resource) > config.radius) continue;
    if (tick - resource.lastSeenTick <= 8) freshResources += 1; // fresh 窗口与走廊审计同源
    knownResources += 1;
  }
  for (const enemy of survey.enemyCores) {
    if (chebyshev(candidate, enemy) > config.enemySafeRadius) continue;
    if (tick - enemy.lastSeenTick <= 8) activeEnemyCores += 1;
  }
  for (const cell of survey.knownResourceCells ?? []) {
    if (chebyshev(candidate, { x: cell[0], y: cell[1] }) <= config.radius) knownResources += 1;
  }

  let score = freshResources;
  if (activeEnemyCores > 0) {
    score -= activeEnemyCores * 5;
    reasons.push(`半径 ${config.enemySafeRadius} 内活跃敌核 ${activeEnemyCores}（硬扣分）`);
  }
  // 测绘盲区惩罚：半径内已知矿格过少 → 目标不确定（需探路前置）。
  const coverageFloor = Math.max(4, config.minFreshResources / 2);
  if (knownResources < coverageFloor) {
    const penalty = Math.round((coverageFloor - knownResources) * config.unknownPenalty);
    score -= penalty;
    reasons.push(`测绘覆盖不足（已知矿 ${knownResources} < ${coverageFloor}）→ 未知惩罚 -${penalty}`);
  }
  if (freshResources < config.minFreshResources) {
    reasons.push(`新鲜矿 ${freshResources} < 下限 ${config.minFreshResources}（富集假设弱）`);
  }

  // W60 方向承诺迟滞（direction-commitment-v1）：候选落在 lastTarget 的
  // commitmentBand 内 = 方向未变 → 加 commitmentBonus 分。防每 tick REPLAN
  // 因微小资源波动换方向（换向成本：重新探路/集结/清路）。band/bonus 任一
  // 未设或 lastTarget 缺省 → 不加成（零回归）。
  let directionCommitted = false;
  const lastTarget = survey.lastTarget;
  const band = config.commitmentBand;
  const bonus = config.commitmentBonus;
  if (lastTarget !== undefined && lastTarget !== null && band !== undefined && bonus !== undefined) {
    const deviation = chebyshev(candidate, { x: lastTarget.x, y: lastTarget.y });
    if (deviation <= band) {
      score += bonus;
      directionCommitted = true;
      reasons.push(`方向承诺命中（距 lastTarget ${deviation} ≤ 迟滞带 ${band}）→ +${bonus}`);
    }
  }

  return {
    candidate,
    score,
    freshResources,
    activeEnemyCores,
    knownResources,
    coverage: knownResources,
    directionCommitted,
    reasons,
  };
}

/**
 * 候选选择：评分最高且无硬性拒绝（活跃敌核 = 0 且新鲜矿 ≥ 下限）的候选。
 * 无候选通过 → null（调用方 ABORT/换候选集）。
 * 首选注入：t2 旁已审安全格（core-rejoin-v1 决策点 2）作为候选集首位。
 */
export function selectTarget(
  candidates: readonly MigrationPosition[],
  survey: TargetSurveyInput,
  config: TargetScoreConfig,
  tick: number,
): { readonly target: MigrationPosition; readonly score: TargetScore } | null {
  let best: { readonly target: MigrationPosition; readonly score: TargetScore } | null = null;
  for (const candidate of candidates) {
    const score = scoreTarget(candidate, survey, config, tick);
    if (score.activeEnemyCores > 0) continue; // 硬门槛：活跃敌核 = 0
    if (score.freshResources < config.minFreshResources) continue; // 硬门槛：富集下限
    if (best === null || score.score > best.score.score) {
      best = { target: candidate, score };
    }
  }
  return best;
}
