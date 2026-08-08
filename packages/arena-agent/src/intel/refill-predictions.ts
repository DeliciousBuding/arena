/** 矿刷新预测（2026-08-08，worker-mission-v1 Phase 2，G3 数据管道）：
 *  agent 侧直接从 survey-db 的 resource_seen_history 计算逐矿 dueInTicks——
 *  与 command-center lib/mine-patterns.ts 同算法（窗口切分 → avgGap → 预测），
 *  纯函数移植（agent 不依赖 command-center 包）。分配层消费：
 *  - dueInTicks ≤ refillLookahead（即将刷新）→ 值层加成，worker 提前占位；
 *  - dueInTicks < −deadMineOverdueTicks（疑似永久采空）→ 死矿剔除，不派 worker
 *    （t1 实证：14 worker 循环近核死种子、cargo=0 冻结）。
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openSurveyDb } from "./survey-db.ts";

/** 连续 tick 间隔 ≤ 该值视为同一出现窗口（矿可见跨 tick 抖动容忍，与
 *  command-center mine-patterns REFILL_GAP_TICKS 一致）。 */
const REFILL_GAP_TICKS = 5;

/** 出现窗口 ≥2 才可预测（与 mine-patterns 一致）。 */
const MIN_WINDOWS = 2;

export interface SeenRow {
  readonly cell: string;
  readonly tick: number;
}

/** 逐矿刷新预测（cell → 预测语义；仅含可预测格）。 */
export interface RefillPrediction {
  readonly cell: string;
  readonly windows: number;
  readonly avgGapTicks: number;
  readonly lastWindowStartTick: number;
  readonly predictedNextTick: number;
  readonly dueInTicks: number;
}

/** 窗口切分 + 周期估计（纯函数，mine-patterns 同算法移植）。
 *  行按 tick 升序输入；输出 Map<cell, RefillPrediction>，确定性排序。 */
export function computeRefillPredictions(
  rows: readonly SeenRow[],
  currentTick: number,
): ReadonlyMap<string, RefillPrediction> {
  const byCell = new Map<string, number[]>();
  for (const row of rows) {
    const ticks = byCell.get(row.cell) ?? [];
    ticks.push(row.tick);
    byCell.set(row.cell, ticks);
  }
  const predictions = new Map<string, RefillPrediction>();
  for (const [cell, ticks] of byCell) {
    ticks.sort((a, b) => a - b);
    const windowStarts: number[] = [];
    let prevStart: number | null = null;
    let prevEnd: number | null = null;
    for (const tick of ticks) {
      if (prevEnd === null || tick - prevEnd > REFILL_GAP_TICKS) {
        windowStarts.push(tick);
        prevStart = tick;
      }
      prevEnd = tick;
    }
    if (windowStarts.length < MIN_WINDOWS) continue;
    const gaps: number[] = [];
    for (let index = 1; index < windowStarts.length; index += 1) {
      gaps.push(windowStarts[index]! - windowStarts[index - 1]!);
    }
    const avgGapTicks = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const lastWindowStartTick = windowStarts[windowStarts.length - 1]!;
    const predictedNextTick = lastWindowStartTick + avgGapTicks;
    predictions.set(cell, {
      cell,
      windows: windowStarts.length,
      avgGapTicks,
      lastWindowStartTick,
      predictedNextTick,
      dueInTicks: predictedNextTick - currentTick,
    });
  }
  return predictions;
}

/** 从 per-tenant survey db 加载 seen 历史并计算预测（只读）。
 *  db 缺失/无历史 = 空 Map（零回归——无预测时分配走既有行为）。 */
export function loadRefillPredictions(
  dataRoot: string,
  tenant: string,
  currentTick: number,
): ReadonlyMap<string, RefillPrediction> {
  let db: DatabaseSync;
  try {
    db = openSurveyDb(dataRoot, tenant, false);
  } catch {
    return new Map();
  }
  try {
    const rows = db
      .prepare("SELECT cell, tick FROM resource_seen_history ORDER BY tick ASC")
      .all() as unknown as SeenRow[];
    return computeRefillPredictions(rows, currentTick);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}

/** survey db 路径（openSurveyDb 同构；供诊断/测试）。 */
export function surveyDbPath(dataRoot: string, tenant: string): string {
  return join(dataRoot, "runtime", "survey", `${tenant}.db`);
}

export { MIN_WINDOWS, REFILL_GAP_TICKS };
